/**
 * Unit tests for `src/terminal/program-status.ts` (OSC 7501).
 *
 * The cases map onto the Syntax, Keys, Security and Limits sections of the
 * protocol's specification (revision 0.4).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DETECTION_REPLY,
  LIMITS,
  ProgramStatusStore,
  displayText,
  parseProgramStatus,
  type ParseResult,
  type ProgramStatusRecord,
} from "../../../src/terminal/program-status.js";

const b64 = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64");
const b64Bytes = (bytes: readonly number[]): string =>
  Buffer.from(Uint8Array.from(bytes)).toString("base64");

function report(payload: string): ProgramStatusRecord {
  const result = parseProgramStatus(payload);
  if (result.type !== "report") {
    throw new Error(`expected a report for ${payload}, got ${result.type}`);
  }
  return result.record;
}

function reason(payload: string): string {
  const result = parseProgramStatus(payload);
  if (result.type !== "ignored") {
    throw new Error(
      `expected ${payload.slice(0, 60)} to be ignored, got ${result.type}`,
    );
  }
  return result.reason;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the spec's own examples", () => {
  it("reads the Terraform approval report", () => {
    expect(
      report(
        "state=blocked:kind=permission:app=terraform:msg=QXBwbHkgMyB0byBhZGQsIDEgdG8gY2hhbmdlLCAwIHRvIGRlc3Ryb3k/",
      ),
    ).toStrictEqual({
      app: "terraform",
      id: null,
      kind: "permission",
      msg: "Apply 3 to add, 1 to change, 0 to destroy?",
      progress: null,
      state: "blocked",
      title: null,
    });
  });

  it("reads a child record with title, progress and message", () => {
    expect(
      report(
        "state=working:id=us-east:title=VVMgRWFzdA==:progress=40:msg=UHVzaGluZyBpbWFnZQ==",
      ),
    ).toStrictEqual({
      app: null,
      id: "us-east",
      kind: null,
      msg: "Pushing image",
      progress: 40,
      state: "working",
      title: "US East",
    });
  });

  it("reads clear with and without an id", () => {
    expect(parseProgramStatus("state=clear:id=us-east")).toStrictEqual({
      id: "us-east",
      type: "clear",
    });
    expect(parseProgramStatus("state=clear")).toStrictEqual({
      id: null,
      type: "clear",
    });
  });

  it("answers the detection query and nothing else", () => {
    expect(parseProgramStatus("?")).toStrictEqual({ type: "query" });
    expect(DETECTION_REPLY).toBe("\x1b]7501;?\x1b\\");
    expect(parseProgramStatus("??").type).toBe("ignored");
  });
});

describe("syntax rules", () => {
  it("removes whitespace around keys and values", () => {
    expect(report(" state = working : app = brew ").app).toBe("brew");
  });

  it("skips a malformed pair and still applies the rest", () => {
    expect(report("state=working:garbage:=x:app=cargo").app).toBe("cargo");
    expect(report("state=working:app=has space:progress=7").app).toBeNull();
    expect(report("state=working:app=has space:progress=7").progress).toBe(7);
    expect(report("state=working:Kind=auth:kéy=1:app=x").app).toBe("x");
  });

  it("ignores unknown keys", () => {
    expect(report("state=done:future=1:colour=red").state).toBe("done");
  });

  it("lets the last value of a repeated key win", () => {
    expect(report("state=idle:state=working:app=a:app=b").state).toBe(
      "working",
    );
    expect(report("state=idle:state=working:app=a:app=b").app).toBe("b");
  });

  it("accepts base64 with and without padding", () => {
    expect(report("state=done:msg=SGVhbHRoeQ==").msg).toBe("Healthy");
    expect(report("state=done:msg=SGVhbHRoeQ").msg).toBe("Healthy");
  });

  it("keeps kind and progress only where the spec allows them", () => {
    expect(report("state=working:kind=auth").kind).toBeNull();
    expect(report("state=blocked:kind=auth").kind).toBe("auth");
    expect(report("state=blocked:kind=bribe").kind).toBeNull();
    expect(report("state=done:progress=50").progress).toBeNull();
    expect(report("state=blocked:progress=100").progress).toBe(100);
    for (const bad of ["101", "-1", "1.5", "", "1e1", "0x10", "9999"]) {
      expect(report(`state=working:progress=${bad}`).progress, bad).toBeNull();
    }
  });

  it("treats an app outside the character set as absent", () => {
    expect(report("state=working:app=a,b").app).toBeNull();
    expect(report("state=working:app=claude-code").app).toBe("claude-code");
  });
});

describe("reports that change nothing", () => {
  it("ignores a missing or unknown state", () => {
    expect(reason("app=brew")).toBe("no-state");
    expect(reason("")).toBe("no-state");
    expect(reason("state=thinking")).toBe("unknown-state");
    expect(reason("state=WORKING")).toBe("unknown-state");
  });

  it("ignores a malformed id, and never falls back to the root record", () => {
    for (const id of ["", "/", "a//b", "a/", "/a", "a b", "a,b", "a=b"]) {
      expect(reason(`state=working:id=${id}`), JSON.stringify(id)).toBe(
        "bad-id",
      );
      expect(reason(`state=clear:id=${id}`), JSON.stringify(id)).toBe("bad-id");
    }
    expect(reason(`state=working:id=${"s".repeat(33)}`)).toBe("bad-id");
    expect(reason(`state=working:id=${Array(9).fill("a").join("/")}`)).toBe(
      "id-too-deep",
    );
    expect(
      reason(`state=working:id=${Array(5).fill("s".repeat(32)).join("/")}`),
    ).toBe("id-too-long");
    expect(report(`state=working:id=${Array(8).fill("a").join("/")}`).id).toBe(
      "a/a/a/a/a/a/a/a",
    );
  });

  it("discards the whole report on invalid base64", () => {
    for (const bad of ["a", "ab.c", "QQ=", "Q=Q=", "====", "SGVsbG8_"]) {
      expect(reason(`state=working:app=brew:msg=${bad}`), bad).toBe(
        "bad-base64",
      );
    }
    expect(reason("state=working:title=a")).toBe("bad-base64");
  });

  it("discards a clear on what discards any other report", () => {
    expect(reason("state=clear:msg=A")).toBe("bad-base64");
    expect(reason(`state=clear:app=${"a".repeat(33)}`)).toBe("app-too-long");
    expect(reason(`state=clear:id=build:title=${b64("a\nb")}`)).toBe(
      "control-character",
    );
    // An unknown state is still what is said first of a report that has one.
    expect(reason("state=thinking:msg=A")).toBe("unknown-state");
  });

  it("discards the whole report on control characters in decoded text", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["newline", "line one\nline two"],
      ["tab", "a\tb"],
      ["escape", "\x1b[31mred"],
      ["nul", "a\u0000b"],
      ["unit separator", "a\u001fb"],
      ["del", "a\u007fb"],
      ["c1 first", "a\u0080b"],
      ["c1 next line", "a\u0085b"],
      ["c1 csi", "a\u009bb"],
      ["c1 last", "a\u009fb"],
    ];
    for (const [name, text] of cases) {
      expect(reason(`state=working:msg=${b64(text)}`), name).toBe(
        "control-character",
      );
      expect(reason(`state=working:title=${b64(text)}`), name).toBe(
        "control-character",
      );
    }
    // The neighbours of both control ranges are ordinary text.
    expect(report(`state=working:msg=${b64("a b~ c")}`).msg).toBe("a b~ c");
  });

  it("discards the whole report on bytes that are not UTF-8", () => {
    expect(reason(`state=working:msg=${b64Bytes([0xff, 0xfe])}`)).toBe(
      "bad-utf8",
    );
    expect(reason(`state=working:msg=${b64Bytes([0xc3])}`)).toBe("bad-utf8");
    expect(reason(`state=working:msg=${b64Bytes([0xed, 0xa0, 0x80])}`)).toBe(
      "bad-utf8",
    );
  });

  it("enforces every size limit in the spec", () => {
    expect(reason(`state=working:${"k".repeat(17)}=1`)).toBe("key-too-long");
    expect(report(`state=working:${"k".repeat(16)}=1`).state).toBe("working");
    expect(reason(`state=working:app=${"a".repeat(33)}`)).toBe("app-too-long");
    expect(report(`state=working:app=${"a".repeat(32)}`).app).toBe(
      "a".repeat(32),
    );

    // 2048 bytes is the largest message; 2049 bytes still fits the encoded cap.
    expect(
      report(`state=working:msg=${b64("m".repeat(2048))}`).msg,
    ).toHaveLength(2048);
    expect(b64("m".repeat(2049))).toHaveLength(LIMITS.msgEncodedBytes);
    expect(reason(`state=working:msg=${b64("m".repeat(2049))}`)).toBe(
      "text-too-long",
    );
    expect(reason(`state=working:msg=${"A".repeat(2733)}`)).toBe(
      "text-too-long",
    );

    expect(
      report(`state=working:title=${b64("t".repeat(192))}`).title,
    ).toHaveLength(192);
    expect(reason(`state=working:title=${b64("t".repeat(193))}`)).toBe(
      "text-too-long",
    );

    const filler = `state=working:${"x=".padEnd(LIMITS.payloadBytes - "state=working:".length, "y")}`;
    expect(filler).toHaveLength(LIMITS.payloadBytes);
    expect(report(filler).state).toBe("working");
    expect(reason(`${filler}y`)).toBe("sequence-too-long");
    // Counted in bytes, not characters.
    expect(
      reason(`state=working:x=${"é".repeat(LIMITS.payloadBytes / 2)}`),
    ).toBe("sequence-too-long");
  });

  it("rejects a 10,000,000 character payload without reading it", () => {
    const hostile = `state=working:msg=${"A".repeat(10_000_000)}`;
    // The spike bounded this by wall time (5 ms). Counting the scans is the
    // same claim without a clock: the length comparison must answer alone.
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    expect(reason(hostile)).toBe("sequence-too-long");
    expect(encode).not.toHaveBeenCalled();
  });
});

describe("untrusted text", () => {
  it("returns markup as literal text for the caller to set as text", () => {
    const html = '<img src=x onerror="alert(1)"> **bold** [x](javascript:1)';
    expect(report(`state=blocked:msg=${b64(html)}`).msg).toBe(html);
  });

  it("disarms direction overrides and invisible characters for display", () => {
    expect(displayText("safe‮gnp.exe")).toBe("safegnp.exe");
    expect(displayText("a⁦b⁩c​d﻿e؜f")).toBe("abcdef");
    expect(displayText("line break")).toBe("line break");
    // Joiners survive, so a family emoji stays one glyph.
    expect(displayText("\u{1f468}‍\u{1f469}‍\u{1f467}")).toBe(
      "\u{1f468}‍\u{1f469}‍\u{1f467}",
    );
  });

  it("shortens by code point, not by UTF-16 unit", () => {
    const shortened = displayText("\u{1f600}".repeat(50), 10);
    expect(Array.from(shortened)).toHaveLength(10);
    expect(shortened.endsWith("…")).toBe(true);
  });
});

describe("hostile input never escapes the rules", () => {
  it("survives 50,000 generated payloads", () => {
    // Deterministic generator, so a failure can be replayed.
    let seed = 0x7501;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (items: readonly string[]): string =>
      items[Math.floor(random() * items.length)] ?? "";
    const fragments = [
      "state=working",
      "state=blocked",
      "state=done",
      "state=error",
      "state=idle",
      "state=clear",
      "state=",
      "id=a/b",
      "id=",
      "id=/",
      "kind=auth",
      "kind=x",
      "progress=50",
      "progress=500",
      "app=cargo",
      "app=",
      `msg=${b64("hello")}`,
      `msg=${b64("a\nb")}`,
      "msg=!",
      "title=QQ",
      `title=${b64("‮")}`,
      ":",
      "=",
      "?",
      " ",
      "\u0000",
      "\u001b",
      "é",
      "\u{1f600}",
      "/",
      "A",
      "z",
      "9",
      "+",
      ",",
      ".",
      "-",
      "_",
      "\n",
      "%",
      "<b>",
    ];
    // A plain check instead of 350,000 `expect` calls keeps this fast.
    const violations: string[] = [];
    const check = (holds: boolean, rule: string, payload: string): void => {
      if (!holds) {
        violations.push(`${rule}: ${JSON.stringify(payload)}`);
      }
    };
    const tally: Record<string, number> = {};
    for (let round = 0; round < 50_000; round++) {
      const pieces = Array.from({ length: 1 + Math.floor(random() * 8) }, () =>
        pick(fragments),
      );
      const payload = pieces.join(random() < 0.7 ? ":" : "");
      let result: ParseResult;
      try {
        result = parseProgramStatus(payload);
      } catch (error) {
        throw new Error(
          `threw on ${JSON.stringify(payload)}: ${String(error)}`,
          { cause: error },
        );
      }
      tally[result.type] = (tally[result.type] ?? 0) + 1;
      if (result.type !== "report") {
        continue;
      }
      const { record } = result;
      check(
        ["idle", "working", "done", "blocked", "error"].includes(record.state),
        "state",
        payload,
      );
      check(
        record.id === null ||
          /^[A-Za-z0-9_.+-]{1,32}(\/[A-Za-z0-9_.+-]{1,32}){0,7}$/u.test(
            record.id,
          ),
        "id",
        payload,
      );
      check(
        record.kind === null || record.state === "blocked",
        "kind",
        payload,
      );
      check(
        record.progress === null ||
          (Number.isInteger(record.progress) &&
            record.progress >= 0 &&
            record.progress <= 100),
        "progress range",
        payload,
      );
      check(
        record.progress === null ||
          record.state === "working" ||
          record.state === "blocked",
        "progress state",
        payload,
      );
      check(
        record.app === null || /^[A-Za-z0-9_.+-]{1,32}$/u.test(record.app),
        "app",
        payload,
      );
      for (const text of [record.msg, record.title]) {
        check(
          text === null ||
            !Array.from(text).some((character) => {
              const point = character.codePointAt(0) ?? 0;
              return point <= 0x1f || (point >= 0x7f && point <= 0x9f);
            }),
          "control character",
          payload,
        );
      }
    }
    expect(violations).toStrictEqual([]);
    // The generator must reach every outcome, or the test proves nothing.
    for (const type of ["report", "clear", "query", "ignored"]) {
      expect(
        tally[type] ?? 0,
        `too few "${type}" results: ${JSON.stringify(tally)}`,
      ).toBeGreaterThan(100);
    }
  });
});

describe("the per-terminal store", () => {
  const apply = (store: ProgramStatusStore, payload: string): boolean =>
    store.apply(parseProgramStatus(payload));

  it("replaces a record completely on every report", () => {
    const store = new ProgramStatusStore();
    apply(
      store,
      `state=blocked:kind=auth:app=brew:msg=${b64("Password required")}`,
    );
    apply(store, "state=working");
    expect(store.mostUrgent()).toStrictEqual({
      app: null,
      id: null,
      kind: null,
      msg: null,
      progress: null,
      state: "working",
      title: null,
    });
  });

  it("changes nothing when a report is ignored", () => {
    const store = new ProgramStatusStore();
    apply(store, "state=working:app=brew");
    expect(apply(store, `state=done:msg=${b64("a\nb")}`)).toBe(false);
    expect(apply(store, "state=clear:id=//")).toBe(false);
    expect(apply(store, "?")).toBe(false);
    expect(store.mostUrgent()?.state).toBe("working");
    expect(store.size).toBe(1);
  });

  it("keeps every record when a clear is discarded", () => {
    const store = new ProgramStatusStore();
    apply(store, "state=working:app=brew");
    apply(store, "state=done:id=build");
    // Base64 that does not decode, and an app of 33 bytes.
    expect(apply(store, "state=clear:msg=A")).toBe(false);
    expect(apply(store, `state=clear:app=${"a".repeat(33)}`)).toBe(false);
    expect(apply(store, "state=clear:id=build:msg=A")).toBe(false);
    expect(store.size).toBe(2);
  });

  it("clears a record and everything beneath it, and only that", () => {
    const store = new ProgramStatusStore();
    for (const id of [
      "build",
      "build/test",
      "build/test/unit",
      "builder",
      "deploy",
    ]) {
      apply(store, `state=working:id=${id}`);
    }
    expect(apply(store, "state=clear:id=build")).toBe(true);
    expect(store.size).toBe(2);
    expect(apply(store, "state=clear")).toBe(true);
    expect(store.size).toBe(0);
  });

  it("shows the most urgent record: blocked, error, working, done, idle", () => {
    const store = new ProgramStatusStore();
    apply(store, "state=idle");
    expect(store.mostUrgent()?.state).toBe("idle");
    apply(store, "state=done:id=a");
    expect(store.mostUrgent()?.state).toBe("done");
    apply(store, "state=working:id=b");
    expect(store.mostUrgent()?.state).toBe("working");
    apply(store, "state=error:id=c");
    expect(store.mostUrgent()?.state).toBe("error");
    apply(store, "state=blocked:id=d");
    expect(store.mostUrgent()?.id).toBe("d");
  });

  it("drops working and blocked at process exit or the next prompt, keeps done and error", () => {
    const store = new ProgramStatusStore();
    apply(store, "state=working");
    apply(store, "state=blocked:id=a");
    apply(store, "state=done:id=b");
    apply(store, "state=error:id=c");
    expect(store.dropTransient()).toBe(true);
    expect(store.size).toBe(2);
    expect(store.mostUrgent()?.state).toBe("error");
    // Nothing takes them away but the program itself, or a reset.
    expect(store.dropTransient()).toBe(false);
    expect(store.size).toBe(2);
  });

  it("takes app from the nearest ancestor that has one", () => {
    const store = new ProgramStatusStore();
    apply(store, "state=working:app=deploy");
    apply(store, "state=working:id=eu/west");
    expect(store.appOf(report("state=working:id=eu/west"))).toBe("deploy");
    apply(store, "state=working:id=eu:app=regional");
    expect(store.appOf(report("state=working:id=eu/west"))).toBe("regional");
    expect(store.appOf(report("state=working:id=eu/west:app=own"))).toBe("own");
  });

  it("never holds more than the cap, evicting the least recently updated", () => {
    const store = new ProgramStatusStore();
    for (let index = 0; index < 10_000; index++) {
      apply(store, `state=working:id=r${String(index)}`);
      if (index === 300) {
        apply(store, "state=blocked:id=r100");
      }
    }
    expect(store.size).toBe(LIMITS.records);
    // r100 was refreshed once, long ago, so it is gone too.
    expect(store.mostUrgent()?.state).toBe("working");
    const refreshed = new ProgramStatusStore();
    for (let index = 0; index < LIMITS.records; index++) {
      apply(refreshed, `state=working:id=r${String(index)}`);
    }
    apply(refreshed, "state=blocked:id=r0");
    apply(refreshed, "state=working:id=new");
    expect(refreshed.size).toBe(LIMITS.records);
    // An updated record is not the eviction victim.
    expect(refreshed.mostUrgent()?.id).toBe("r0");
  });
});

describe("cost of a report", () => {
  it("parses and stores a typical report in well under a millisecond", () => {
    const payloads = [
      `state=working:app=claude-code:progress=40:msg=${b64("Reading src/terminal/view.ts")}`,
      `state=blocked:kind=permission:app=claude-code:msg=${b64("Run bun run test?")}`,
      `state=done:app=claude-code:msg=${b64("Finished")}`,
      `state=working:id=agents/reviewer:title=${b64("Reviewer")}:msg=${b64("Checking the diff")}`,
    ];
    const store = new ProgramStatusStore();
    const rounds = 200_000;
    for (let warm = 0; warm < 20_000; warm++) {
      store.apply(parseProgramStatus(payloads[warm % payloads.length] ?? ""));
    }
    const started = performance.now();
    for (let round = 0; round < rounds; round++) {
      store.apply(parseProgramStatus(payloads[round % payloads.length] ?? ""));
    }
    const microseconds = ((performance.now() - started) * 1000) / rounds;
    // Measured at about 1.6; the bound leaves room for a loaded machine.
    expect(microseconds).toBeLessThan(100);
  });
});
