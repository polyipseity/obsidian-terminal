/**
 * Program Status Protocol (OSC 7501).
 *
 * Pure functions and one small store. No DOM, no xterm, no Obsidian: the
 * addon that feeds it is `ProgramStatusAddon` in `emulator-addons.ts`.
 * Written against revision 0.4 (2026-10-10) of
 * https://www.superlogical.com/rex/docs/build/program-status
 *
 * `parseProgramStatus` takes what xterm hands an OSC handler (the text after
 * "7501;") and returns a query, a report, a clear, or "ignored" with a reason.
 * It never throws and never returns a partly applied report: every check runs
 * before anything is returned.
 */

/** What a record says its program is doing. `clear` is not a state. */
export type State = "idle" | "working" | "done" | "blocked" | "error";
/** What a `blocked` program is waiting for. */
export type Kind = "permission" | "question" | "auth";

/** Hard caps from the spec's Limits section, in bytes unless named otherwise. */
export interface Limits {
  readonly payloadBytes: number;
  readonly keyBytes: number;
  readonly msgEncodedBytes: number;
  readonly msgDecodedBytes: number;
  readonly titleEncodedBytes: number;
  readonly titleDecodedBytes: number;
  readonly appBytes: number;
  readonly idBytes: number;
  readonly idDepth: number;
  readonly records: number;
}

/**
 * The spec caps the whole sequence at 4096 bytes, "OSC through ST". A handler
 * only sees the payload, so the introducer "ESC ] 7501 ;" (7 bytes) and the
 * longer terminator "ESC \" (2 bytes) are subtracted. Terminals may choose
 * lower limits, so assuming the longer terminator is allowed.
 */
export const LIMITS: Limits = Object.freeze({
  payloadBytes: 4096 - 7 - 2,
  keyBytes: 16,
  msgEncodedBytes: 2732,
  msgDecodedBytes: 2048,
  titleEncodedBytes: 256,
  titleDecodedBytes: 192,
  appBytes: 32,
  idBytes: 128,
  idDepth: 8,
  records: 256,
});

/** Fixed reply to `OSC 7501 ; ? ST`. Holds nothing taken from any report. */
export const DETECTION_REPLY = "\u001b]7501;?\u001b\\";

/** Why a payload changed nothing. */
export type IgnoreReason =
  | "sequence-too-long"
  | "key-too-long"
  | "no-state"
  | "unknown-state"
  | "bad-id"
  | "id-too-long"
  | "id-too-deep"
  | "app-too-long"
  | "text-too-long"
  | "bad-base64"
  | "bad-utf8"
  | "control-character";

/** One stored record: exactly the keys of the last report that used its id. */
export interface ProgramStatusRecord {
  readonly state: State;
  /** `null` addresses the root record. */
  readonly id: string | null;
  /** Only ever set together with `blocked`. */
  readonly kind: Kind | null;
  /** 0 to 100, only with `working` or `blocked`. `null` means indeterminate. */
  readonly progress: number | null;
  /** The record's own `app`. Inheritance from a parent is the store's job. */
  readonly app: string | null;
  readonly title: string | null;
  readonly msg: string | null;
}

/** The detection query, `OSC 7501 ; ? ST`. */
export interface QueryResult {
  readonly type: "query";
}
/** A valid report, to replace the record with the same id. */
export interface ReportResult {
  readonly type: "report";
  readonly record: ProgramStatusRecord;
}
/** `state=clear`: remove the addressed record and every record beneath it. */
export interface ClearResult {
  readonly type: "clear";
  /** `null` removes every record on the terminal. */
  readonly id: string | null;
}
/** A payload that must change nothing. */
export interface IgnoredResult {
  readonly type: "ignored";
  readonly reason: IgnoreReason;
}
/** Everything `parseProgramStatus` can return. */
export type ParseResult =
  QueryResult | ReportResult | ClearResult | IgnoredResult;

const STATES: ReadonlySet<string> = new Set<State>([
    "idle",
    "working",
    "done",
    "blocked",
    "error",
  ]),
  KINDS: ReadonlySet<string> = new Set<Kind>([
    "permission",
    "question",
    "auth",
  ]),
  KEY = /^[a-z]+$/u,
  VALUE = /^[A-Za-z0-9_.,+/=-]*$/u,
  SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/u,
  APP = /^[A-Za-z0-9_.+-]{1,32}$/u,
  PROGRESS = /^[0-9]{1,3}$/u,
  BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u,
  // General category Cc is exactly U+0000 to U+001F and U+007F to U+009F.
  CONTROL = /\p{Cc}/u,
  encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });

function isState(value: string): value is State {
  return STATES.has(value);
}

function isKind(value: string): value is Kind {
  return KINDS.has(value);
}

function ignored(reason: IgnoreReason): IgnoredResult {
  return { reason, type: "ignored" };
}

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** Standard base64 with optional padding. `null` when it does not decode. */
function decodeBase64(value: string): Uint8Array | null {
  if (!BASE64.test(value)) {
    return null;
  }
  const body = value.replace(/[=]+$/u, ""),
    padded = body.length !== value.length;
  if (body.length % 4 === 1 || (padded && value.length % 4 !== 0)) {
    return null;
  }
  const binary = atob(body),
    bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

interface TextValue {
  readonly ok: true;
  readonly text: string | null;
}

function decodeText(
  value: string | undefined,
  encodedLimit: number,
  decodedLimit: number,
): IgnoredResult | TextValue {
  if (value === undefined || value === "") {
    return { ok: true, text: null };
  }
  // Values passed VALUE, so they are ASCII and length equals bytes. The spec
  // asks for the encoded size to be checked before decoding.
  if (value.length > encodedLimit) {
    return ignored("text-too-long");
  }
  const bytes = decodeBase64(value);
  if (bytes === null) {
    return ignored("bad-base64");
  }
  if (bytes.length > decodedLimit) {
    return ignored("text-too-long");
  }
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return ignored("bad-utf8");
  }
  if (CONTROL.test(text)) {
    return ignored("control-character");
  }
  return { ok: true, text: text === "" ? null : text };
}

interface IdValue {
  readonly ok: true;
  readonly id: string | null;
}

function readId(value: string | undefined): IdValue | IgnoredResult {
  if (value === undefined) {
    return { id: null, ok: true };
  }
  if (value.length > LIMITS.idBytes) {
    return ignored("id-too-long");
  }
  const segments = value.split("/");
  if (segments.length > LIMITS.idDepth) {
    return ignored("id-too-deep");
  }
  // A malformed id must not fall back to the root record.
  if (!segments.every((segment) => SEGMENT.test(segment))) {
    return ignored("bad-id");
  }
  return { id: value, ok: true };
}

/**
 * Reads the payload of one OSC 7501 sequence (the text after `7501;`).
 *
 * @param payload the text xterm hands the OSC handler
 * @returns a query, a report, a clear, or "ignored" with the reason
 */
export function parseProgramStatus(payload: string): ParseResult {
  // Length in UTF-16 units never exceeds length in bytes, so this rejects an
  // oversized payload without reading it. xterm buffers up to 10,000,000
  // characters before a handler runs; this is where that stops.
  if (
    payload.length > LIMITS.payloadBytes ||
    byteLength(payload) > LIMITS.payloadBytes
  ) {
    return ignored("sequence-too-long");
  }
  if (payload.trim() === "?") {
    return { type: "query" };
  }

  const pairs = new Map<string, string>();
  for (const piece of payload.split(":")) {
    const separator = piece.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = piece.slice(0, separator).trim(),
      value = piece.slice(separator + 1).trim();
    if (byteLength(key) > LIMITS.keyBytes) {
      return ignored("key-too-long");
    }
    // A malformed pair is skipped; the rest of the report still counts.
    if (!KEY.test(key)) {
      continue;
    }
    if (!VALUE.test(value)) {
      // The one exception. Skipping an unreadable `id` would turn the report
      // into one for the root record, and `state=clear:id=a b` into "clear
      // everything". The spec's id rule says a report whose id does not match
      // the grammar is ignored, so that rule wins over pair skipping.
      if (key === "id") {
        return ignored("bad-id");
      }
      continue;
    }
    pairs.set(key, value);
  }

  const state = pairs.get("state");
  if (state === undefined) {
    return ignored("no-state");
  }
  const id = readId(pairs.get("id"));
  if (!("ok" in id)) {
    return id;
  }
  if (state === "clear") {
    return { id: id.id, type: "clear" };
  }
  if (!isState(state)) {
    return ignored("unknown-state");
  }

  // The spec lists `app` both as a 32-byte limit (break it and the report is
  // discarded) and as a grammar whose misses count as absent. Length is read
  // as the limit, the character set as the grammar.
  const app = pairs.get("app");
  if (app !== undefined && app.length > LIMITS.appBytes) {
    return ignored("app-too-long");
  }
  const title = decodeText(
    pairs.get("title"),
    LIMITS.titleEncodedBytes,
    LIMITS.titleDecodedBytes,
  );
  if (!("ok" in title)) {
    return title;
  }
  const msg = decodeText(
    pairs.get("msg"),
    LIMITS.msgEncodedBytes,
    LIMITS.msgDecodedBytes,
  );
  if (!("ok" in msg)) {
    return msg;
  }

  const kind = pairs.get("kind"),
    progress = pairs.get("progress"),
    busy = state === "working" || state === "blocked",
    percent =
      busy && progress !== undefined && PROGRESS.test(progress)
        ? Number(progress)
        : null;
  return {
    record: {
      app: app !== undefined && APP.test(app) ? app : null,
      id: id.id,
      kind:
        state === "blocked" && kind !== undefined && isKind(kind) ? kind : null,
      msg: msg.text,
      progress: percent !== null && percent <= 100 ? percent : null,
      state,
      title: title.text,
    },
    type: "report",
  };
}

/**
 * Makes program-supplied text safe to show outside the terminal grid: removes
 * direction overrides and other invisible format characters, flattens line
 * separators, and shortens. The result is for `textContent` or a tooltip
 * string, never for markup.
 */
export function displayText(text: string, maxCodePoints = 200): string {
  const cleaned = text
      // Zero-width joiner and non-joiner stay: emoji and several scripts
      // need them, and neither changes direction.
      .replace(/(?![\u200c\u200d])\p{Cf}/gu, "")
      .replace(/[\u2028\u2029]/gu, " ")
      .trim(),
    points = Array.from(cleaned);
  return points.length > maxCodePoints
    ? `${points.slice(0, maxCodePoints - 1).join("")}\u2026`
    : cleaned;
}

const URGENCY: readonly State[] = Object.freeze([
  "blocked",
  "error",
  "working",
  "done",
  "idle",
]);
const ROOT = "";

/** One terminal's records. Bounded: never holds more than `LIMITS.records`. */
export class ProgramStatusStore {
  // Map order is update order, oldest first, which is the eviction order.
  readonly #records = new Map<string, ProgramStatusRecord>();

  /** How many records are held. */
  public get size(): number {
    return this.#records.size;
  }

  /** Applies a parse result. Returns whether anything stored changed. */
  public apply(result: ParseResult): boolean {
    if (result.type === "clear") {
      return this.#clear(result.id);
    }
    if (result.type !== "report") {
      return false;
    }
    const key = result.record.id ?? ROOT;
    this.#records.delete(key);
    if (this.#records.size >= LIMITS.records) {
      for (const oldest of this.#records.keys()) {
        this.#records.delete(oldest);
        break;
      }
    }
    this.#records.set(key, result.record);
    return true;
  }

  /**
   * The process exited or a new shell prompt began (OSC 133 `A`). `working`
   * and `blocked` must go; `idle` may, and does here. `done` and `error`
   * stay, also after the user has seen them: the tab goes on showing them
   * (a finished program as seen) until the next report or a reset.
   */
  public dropTransient(): boolean {
    return this.#deleteWhere(
      (record) => record.state !== "done" && record.state !== "error",
    );
  }

  /** Full reset (`RIS`). A soft reset must not call this. */
  public reset(): boolean {
    const had = this.#records.size > 0;
    this.#records.clear();
    return had;
  }

  /** The record a single tab indicator should show, or `null` for none. */
  public mostUrgent(): ProgramStatusRecord | null {
    let best: ProgramStatusRecord | null = null;
    for (const record of this.#records.values()) {
      // `<=` lets a later update win a tie, since iteration is oldest first.
      if (
        best === null ||
        URGENCY.indexOf(record.state) <= URGENCY.indexOf(best.state)
      ) {
        best = record;
      }
    }
    return best;
  }

  /** A record's `app`, taken from its nearest ancestor when it has none. */
  public appOf(record: ProgramStatusRecord): string | null {
    if (record.app !== null) {
      return record.app;
    }
    let path = record.id;
    while (path !== null) {
      const slash = path.lastIndexOf("/");
      path = slash === -1 ? null : path.slice(0, slash);
      const parent = this.#records.get(path ?? ROOT);
      if (parent && parent.app !== null) {
        return parent.app;
      }
    }
    return null;
  }

  #clear(id: string | null): boolean {
    if (id === null) {
      return this.reset();
    }
    const prefix = `${id}/`;
    let changed = false;
    for (const key of [...this.#records.keys()]) {
      if (key === id || key.startsWith(prefix)) {
        this.#records.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  #deleteWhere(predicate: (record: ProgramStatusRecord) => boolean): boolean {
    let changed = false;
    for (const [key, record] of [...this.#records]) {
      if (predicate(record)) {
        this.#records.delete(key);
        changed = true;
      }
    }
    return changed;
  }
}
