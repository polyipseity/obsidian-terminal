"""Tests for ``src/terminal/win32_conpty.py``.

The pure protocol helpers are exercised everywhere.  The end-to-end acceptance
tests drive a real pseudoconsole and therefore run on Windows only; elsewhere
they are reported as skipped, which is the expected result.

The acceptance tests start the host by file path rather than with ``python -c``
because the source is larger than the 32767-character Windows command line.
Both forms deliver the same ``sys.argv[1:]``, so the contract under test is
identical either way.
"""

from __future__ import annotations

import ctypes
import io
import json
import ntpath
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from contextlib import closing
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from typing import Any, NamedTuple
from unittest.mock import Mock

import pytest

"""Public API of this test module (empty)."""
__all__ = ()

"""Reason reported when a Windows-only test is skipped."""
_WINDOWS_ONLY = "the ConPTY host runs on Windows only"

"""Seconds a spawned host may take before a test gives up on it."""
_HOST_TIMEOUT = 30.0


def _module_path() -> Path:
    """Return the filesystem path to the target source module."""
    return Path(__file__).parents[3] / "src/terminal/win32_conpty.py"


def _load_module() -> ModuleType:
    """Load the target module from source for deterministic assertions."""
    path = _module_path()
    spec = spec_from_file_location("tests_win32_conpty_module", path)
    if spec is None or spec.loader is None:
        raise AssertionError(path)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


"""The module under test, loaded once per test session."""
_MODULE = _load_module()


def _split_command_line(command_line: str) -> list[str]:
    """Split a command line with the C runtime's ``argv`` rules.

    This inverse of ``quote_argument`` lets the quoting be proved by round
    trip instead of by matching one hand-written string per case.
    """
    arguments: list[str] = []
    current: list[str] = []
    backslashes = 0
    quoted = False
    started = False
    for character in command_line:
        if character == "\\":
            backslashes += 1
            started = True
            continue
        if character == '"':
            current.append("\\" * (backslashes // 2))
            if backslashes % 2 == 1:
                current.append('"')
            else:
                quoted = not quoted
            backslashes = 0
            started = True
            continue
        current.append("\\" * backslashes)
        backslashes = 0
        if character in " \t" and not quoted:
            if started:
                arguments.append("".join(current))
                current = []
                started = False
            continue
        current.append(character)
        started = True
    current.append("\\" * backslashes)
    if started:
        arguments.append("".join(current))
    return arguments


# ---------------------------------------------------------------------------
# Module surface
# ---------------------------------------------------------------------------


def test_job_assignment_failure_terminates_without_resuming() -> None:
    """A child must never execute after Job Object assignment fails."""
    calls: list[str] = []
    with pytest.raises(OSError, match="AssignProcessToJobObject"):
        _MODULE.assign_suspended_child(
            lambda: False,
            lambda: calls.append("terminate"),
        )
    assert calls == ["terminate"]


def test_resume_failure_terminates_the_assigned_tree() -> None:
    """A failed primary-thread resume must close the contained process tree."""
    calls: list[str] = []
    with pytest.raises(OSError, match="ResumeThread"):
        _MODULE.resume_assigned_child(
            lambda: 0xFFFFFFFF,
            lambda: calls.append("terminate"),
        )
    assert calls == ["terminate"]


def test_pseudoconsole_attribute_passes_the_direct_ctypes_handle_value() -> None:
    """UpdateProcThreadAttribute receives HPCON, not an address of its storage."""
    update = Mock(return_value=True)
    pseudoconsole = 0x1234_5678
    storage = ctypes.c_void_p(pseudoconsole)
    assert _MODULE._update_pseudoconsole_attribute(
        update, ctypes.c_void_p(0x8765_4321), pseudoconsole
    )
    arguments = update.call_args.args
    value = arguments[3]
    assert isinstance(value, ctypes.c_void_p)
    assert value.value == pseudoconsole
    assert value.value != ctypes.addressof(storage)
    assert arguments[4] == ctypes.sizeof(ctypes.c_void_p)


def test_cancelled_control_reader_joins_before_required_exit_write() -> None:
    """Shutdown joins a real blocked reader before writing required exit."""
    read_descriptor, unblock_descriptor = os.pipe()
    reader = os.fdopen(read_descriptor, "rb", buffering=0)
    writer = io.BytesIO()
    control = _MODULE._ControlFiles(reader, writer)
    started = threading.Event()
    released = threading.Event()

    def block_on_read() -> None:
        """Hold the reader in a real blocking operating-system read."""
        started.set()
        reader.read(1)

    def cancel() -> None:
        """Release the real blocked read once, like synchronous cancellation."""
        if not released.is_set():
            os.close(unblock_descriptor)
            released.set()

    thread = threading.Thread(target=block_on_read, daemon=True)
    thread.start()
    try:
        assert started.wait(1.0)
        assert thread.is_alive()
        _MODULE._cancel_and_join_reader(thread, cancel, 1.0, 0.01)
        assert not thread.is_alive()
        _MODULE._write_control_message(control, {"event": "exit", "code": 0})
        assert writer.getvalue() == b'{"event":"exit","code":0}\n'
    finally:
        cancel()
        thread.join(1.0)
        reader.close()
    assert not thread.is_alive()


def test_output_pump_forwards_every_chunk_until_the_source_ends() -> None:
    """The pump copies each chunk in order and stops at the empty read."""
    chunks = [b"one", b"two", b""]
    written: list[bytes] = []

    def write(chunk: Any) -> bool:
        """Record one forwarded chunk."""
        written.append(bytes(chunk))
        return True

    _MODULE.pump_output(lambda: chunks.pop(0), write)
    assert written == [b"one", b"two"]
    assert chunks == []


def test_output_pump_keeps_draining_after_stdout_fails() -> None:
    """A dead stdout must not leave pseudoconsole output unread.

    ``ClosePseudoConsole`` waits for conhost to flush into the output pipe; a
    pump that returned on the failed write left that pipe full, so the close,
    and the host's non-daemon main thread, hung forever after a plugin crash.
    """
    chunks = [b"one", b"two", b"three", b""]
    write = Mock(return_value=False)
    _MODULE.pump_output(lambda: chunks.pop(0), write)
    assert chunks == []
    write.assert_called_once_with(b"one")


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has an implementation")
def test_main_is_not_implemented_off_windows() -> None:
    """The fallback ``main`` should refuse to run on other platforms."""
    with pytest.raises(NotImplementedError):
        _MODULE.main()


# ---------------------------------------------------------------------------
# Command-line quoting
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("argument", "expected"),
    (
        ("plain", "plain"),
        ("", '""'),
        ("with space", '"with space"'),
        ("with\ttab", '"with\ttab"'),
        ("C:\\dir\\file", "C:\\dir\\file"),
        ('say "hi"', '"say \\"hi\\""'),
        ("C:\\dir with space\\", '"C:\\dir with space\\\\"'),
        ('a\\"b', '"a\\\\\\"b"'),
    ),
)
def test_quote_argument_matches_the_canonical_rules(
    argument: str, expected: str
) -> None:
    """Quoting should follow the documented backslash and quote rules."""
    assert _MODULE.quote_argument(argument) == expected


@pytest.mark.parametrize(
    "command",
    (
        ("app.exe",),
        ("C:\\Program Files\\app.exe", "--flag", "value"),
        ("app.exe", "", "plain"),
        ("app.exe", 'say "hi"', "trailing\\\\", 'a\\\\"b'),
        ("app.exe", "C:\\path with space\\", "tab\there"),
    ),
)
def test_build_command_line_round_trips_through_the_argv_parser(
    command: Sequence[str],
) -> None:
    """Every quoted command line must parse back into the original argv."""
    assert _split_command_line(_MODULE.build_command_line(command)) == list(command)


def test_build_command_line_rejects_an_empty_executable() -> None:
    """A command line without an executable is a programming error."""
    with pytest.raises(ValueError):
        _MODULE.build_command_line(())
    with pytest.raises(ValueError):
        _MODULE.build_command_line(("", "argument"))


@pytest.mark.parametrize("command", (("app\x00.exe",), ("app.exe", "a\x00b")))
def test_build_command_line_rejects_a_nul_character(command: Sequence[str]) -> None:
    """A NUL would end the ``CreateProcessW`` command line early, unnoticed."""
    with pytest.raises(ValueError, match="NUL"):
        _MODULE.build_command_line(command)


# ---------------------------------------------------------------------------
# NDJSON control framing
# ---------------------------------------------------------------------------


def test_encode_message_produces_one_utf8_line() -> None:
    """A control message must occupy exactly one newline-terminated line."""
    payload = _MODULE.encode_message({"event": "hello", "token": "tok", "pid": 7})
    assert payload.endswith(b"\n")
    assert payload.count(b"\n") == 1
    assert _MODULE.decode_message(payload.decode("utf-8")) == {
        "event": "hello",
        "token": "tok",
        "pid": 7,
    }


def test_encode_message_keeps_non_ascii_text_intact() -> None:
    """Non-ASCII values survive the UTF-8 encoding without escaping."""
    payload = _MODULE.encode_message({"event": "hello", "token": "日本語"})
    assert "日本語".encode() in payload


@pytest.mark.parametrize(
    "line", ("", "   ", "not json", "[1, 2]", '"text"', "123", "null")
)
def test_decode_message_rejects_anything_but_an_object(line: str) -> None:
    """Only a JSON object is a control message."""
    assert _MODULE.decode_message(line) is None


def test_decoder_reassembles_messages_split_across_chunks() -> None:
    """A message split across reads must still be delivered exactly once."""
    decoder = _MODULE.NdjsonDecoder()
    assert decoder.feed(b'{"op":"res') == []
    assert decoder.feed(b'ize","columns":10,"rows":5}\n{"op":') == [
        {"op": "resize", "columns": 10, "rows": 5}
    ]
    assert decoder.feed(b'"kill"}\n') == [{"op": "kill"}]


def test_decoder_skips_blank_and_malformed_lines() -> None:
    """Unparsable lines are dropped without losing the valid ones around them."""
    decoder = _MODULE.NdjsonDecoder()
    assert decoder.feed(b'\n\nnot json\n[1]\n{"op":"kill"}\n') == [{"op": "kill"}]


@pytest.mark.parametrize("terminator", (b"", b"\n"), ids=("unterminated", "terminated"))
def test_decoder_drops_and_diagnoses_an_oversized_line(
    monkeypatch: pytest.MonkeyPatch, terminator: bytes
) -> None:
    """A line over the cap is dropped, terminated or not, and never silently.

    An unterminated one is malformed rather than partial, so it must not grow
    the buffer either.
    """
    diagnostics: list[str] = []
    monkeypatch.setattr(_MODULE, "diagnose", diagnostics.append)
    decoder = _MODULE.NdjsonDecoder()
    assert decoder.feed(b"x" * (64 * 1024 + 10) + terminator) == []
    assert len(diagnostics) == 1
    assert "size cap" in diagnostics[0]
    assert decoder.feed(b'{"op":"kill"}\n') == [{"op": "kill"}]
    assert len(diagnostics) == 1


class _ScriptedReader:
    """Return each scripted chunk once, then signal end-of-stream."""

    def __init__(self, chunks: list[bytes]) -> None:
        """Copy the scripted chunks so the test can reuse its literal."""
        self._chunks = list(chunks)

    def read(self, size: int) -> bytes:
        """Pop the next scripted chunk regardless of the requested size."""
        del size
        return self._chunks.pop(0) if self._chunks else b""


def test_control_reader_delivers_an_op_coalesced_with_authenticate() -> None:
    """A start op in the same chunk as the authenticate response survives.

    Each handshake phase previously decoded with its own ``NdjsonDecoder``,
    so bytes consumed while authenticating never reached ``_await_start``:
    the plugin writes ``authenticate`` and ``start`` back to back, and one
    coalesced pipe read dropped the session start on the floor.
    """
    messages = _MODULE.ControlMessageReader(
        _ScriptedReader([b'{"op":"authenticate","token":"t"}\n{"op":"start"}\n'])
    )
    assert messages.next_message() == {"op": "authenticate", "token": "t"}
    assert messages.next_message() == {"op": "start"}
    assert messages.next_message() is None


def test_control_reader_carries_a_partial_line_across_reads() -> None:
    """A message straddling two reads is delivered whole to the next phase."""
    messages = _MODULE.ControlMessageReader(
        _ScriptedReader([b'{"op":"authenticate","token":"t"}\n{"op":"ki', b'll"}\n'])
    )
    assert messages.next_message() == {"op": "authenticate", "token": "t"}
    assert messages.next_message() == {"op": "kill"}
    assert messages.next_message() is None


# ---------------------------------------------------------------------------
# Control-message and command-line parsing
# ---------------------------------------------------------------------------


def test_parse_arguments_accepts_the_deferred_form() -> None:
    """``--defer-session`` yields the deferred arguments with the pipe name."""
    parsed = _MODULE.parse_arguments(
        ["--defer-session", "\\\\.\\pipe\\obsidian-terminal-conpty-x"]
    )
    assert isinstance(parsed, _MODULE.DeferredArguments)
    assert parsed.pipe_name == "\\\\.\\pipe\\obsidian-terminal-conpty-x"


@pytest.mark.parametrize(
    "arguments",
    (
        ["--defer-session"],
        ["--defer-session", "not-a-pipe"],
        ["--defer-session", "\\\\.\\pipe\\x", "extra"],
    ),
)
def test_parse_arguments_rejects_malformed_deferred_forms(
    arguments: list[str],
) -> None:
    """A malformed deferred command line must fail fast."""
    with pytest.raises(ValueError):
        _MODULE.parse_arguments(arguments)


def test_environment_block_is_sorted_and_double_terminated() -> None:
    """The CreateProcessW block sorts case-insensitively and ends in NULs."""
    block = _MODULE._build_environment_block({"b": "2", "A": "1", "Path": "C:\\bin"})
    assert block == "A=1\x00b=2\x00Path=C:\\bin\x00\x00"


def test_parse_start_accepts_a_valid_operation() -> None:
    """A valid start op yields arguments, environment, and cwd."""
    start = _MODULE._parse_start(
        {
            "op": "start",
            "columns": 120,
            "rows": 30,
            "cwd": "C:\\work",
            "env": {"A": "1"},
            "command": ["cmd.exe", "/c", "echo hi"],
        },
        "\\\\.\\pipe\\p",
    )
    assert start is not None
    assert start.arguments == _MODULE.HostArguments(
        columns=120,
        rows=30,
        pipe_name="\\\\.\\pipe\\p",
        command=("cmd.exe", "/c", "echo hi"),
        cwd="C:\\work",
    )
    assert start.environment == {"A": "1"}


@pytest.mark.parametrize(
    "name", ("OBSIDIAN_TERMINAL_CONPTY_TOKEN", "obsidian_terminal_conpty_Token")
)
def test_parse_start_strips_the_control_token_from_the_environment(name: str) -> None:
    """Windows matches variable names without case; so must the removal."""
    start = _MODULE._parse_start(
        {
            "op": "start",
            "columns": 120,
            "rows": 30,
            "env": {"A": "1", name: "secret"},
            "command": ["cmd.exe"],
        },
        "\\\\.\\pipe\\p",
    )
    assert start is not None
    assert start.environment == {"A": "1"}


def test_environment_path_matches_case_insensitively() -> None:
    """Windows environments spell the variable ``Path``; the lookup must not care."""
    assert _MODULE.environment_path({"Path": "C:\\bin"}) == "C:\\bin"
    assert _MODULE.environment_path({"HOME": "x"}) is None
    assert _MODULE.environment_path(None) is None


def _touch(directory: Path, *names: str) -> None:
    """Create empty files named ``names`` inside a new or existing directory."""
    directory.mkdir(exist_ok=True)
    for name in names:
        (directory / name).write_text("", encoding="utf-8")


def test_resolve_executable_searches_the_given_path(tmp_path: Path) -> None:
    """A bare name resolves through the child's PATH; others pass through."""
    _touch(tmp_path / "bin", "tool.exe")
    program = str(tmp_path / "bin" / "tool.exe")
    path = os.pathsep.join(("", str(tmp_path / "missing"), str(tmp_path / "bin")))
    assert _MODULE.resolve_executable("tool", path) == program
    assert _MODULE.resolve_executable("tool.exe", path) == program
    assert _MODULE.resolve_executable("definitely-missing-tool", path) == (
        "definitely-missing-tool"
    )
    assert _MODULE.resolve_executable(program, None) == program


def test_resolve_executable_unwraps_a_quoted_path_entry(tmp_path: Path) -> None:
    """A quoted PATH entry keeps its place in the search, as it does in libuv."""
    _touch(tmp_path / "preferred", "tool.exe")
    _touch(tmp_path / "fallback", "tool.exe")
    path = os.pathsep.join(
        (f'"{tmp_path / "preferred"}"', '"', str(tmp_path / "fallback"))
    )
    assert _MODULE.resolve_executable("tool", path) == str(
        tmp_path / "preferred" / "tool.exe"
    )


@pytest.mark.parametrize(
    "bits, sysnative", ((32, True), (32, False), (64, False), (64, True))
)
@pytest.mark.parametrize(
    "program, path, relative",
    (
        (r"C:\Windows\System32\wsl.exe", "", "wsl.exe"),
        ("wsl", r'"C:\Windows\System32"', "wsl.exe"),
        ("wsl", "", "wsl.exe"),
        (
            r"c:/WINDOWS/system32/WindowsPowerShell/v1.0/powershell.exe",
            "",
            r"WindowsPowerShell\v1.0\powershell.exe",
        ),
        (r"C:\Windows\SysWOW64\cmd.exe", "", r"C:\Windows\SysWOW64\cmd.exe"),
        (r"C:\Windows\System32tools\cmd.exe", "", r"C:\Windows\System32tools\cmd.exe"),
        (r"D:\Windows\System32\cmd.exe", "", r"D:\Windows\System32\cmd.exe"),
    ),
)
def test_resolve_executable_uses_native_system_programs_from_wow64(
    monkeypatch: pytest.MonkeyPatch,
    bits: int,
    sysnative: bool,
    program: str,
    path: str,
    relative: str,
) -> None:
    """A 32-bit host must find and launch native System32 programs via Sysnative."""
    native = r"C:\Windows\Sysnative"
    system = native if bits == 32 and sysnative else r"C:\Windows\System32"
    expected = ntpath.join(system, relative)
    windows_path = Mock(wraps=ntpath)
    windows_path.isdir.side_effect = lambda value: sysnative and value == native
    windows_path.isfile.side_effect = lambda value: (
        ntpath.normcase(value) == (ntpath.normcase(expected))
    )
    monkeypatch.setattr(
        _MODULE,
        "os",
        Mock(
            wraps=os,
            path=windows_path,
            pathsep=";",
            curdir=".",
            sep="\\",
            environ={"SystemRoot": r"C:\Windows"},
        ),
    )
    monkeypatch.setattr(
        _MODULE, "sys", Mock(wraps=sys, platform="win32", maxsize=2 ** (bits - 1) - 1)
    )
    monkeypatch.setattr(_MODULE, "_SearchPathW", Mock(return_value=0), raising=False)

    resolved = _MODULE.resolve_executable(program, path)
    assert ntpath.normcase(resolved) == ntpath.normcase(expected)
    assert _split_command_line(_MODULE.build_command_line((resolved, "--help"))) == [
        resolved,
        "--help",
    ]


def test_resolve_executable_prefers_native_programs_to_batch_launchers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A script named like the shell must not shadow an available native one.

    ``shutil.which`` tried every ``PATHEXT`` extension, so a ``pwsh.bat`` in a
    synced vault or early on PATH ran in place of ``pwsh.exe``.
    """
    monkeypatch.setenv("PATHEXT", ".BAT;.CMD;.COM;.EXE")
    _touch(tmp_path / "planted", "pwsh.bat", "pwsh.cmd", "pwsh")
    _touch(tmp_path / "real", "pwsh.exe")
    planted, real = str(tmp_path / "planted"), str(tmp_path / "real")
    assert _MODULE.resolve_executable("pwsh", os.pathsep.join((planted, real))) == (
        str(tmp_path / "real" / "pwsh.exe")
    )
    # An explicit extension is the user's own choice and is searched as given.
    assert _MODULE.resolve_executable("pwsh.bat", planted) == (
        str(tmp_path / "planted" / "pwsh.bat")
    )


@pytest.mark.parametrize("extension", (".bat", ".cmd"))
@pytest.mark.parametrize("qualified", (False, True))
def test_resolve_executable_falls_back_to_batch_launchers(
    tmp_path: Path, extension: str, qualified: bool
) -> None:
    """Existing profiles may omit the suffix of a batch launcher on PATH."""
    name = "obsidian-terminal-launcher-probe"
    _touch(tmp_path, name + extension)
    program = str(tmp_path / name) if qualified else name
    assert _MODULE.resolve_executable(program, str(tmp_path)) == str(
        tmp_path / (name + extension)
    )


def test_resolve_executable_tries_com_before_exe_in_each_directory(
    tmp_path: Path,
) -> None:
    """The extension order holds per directory, and directory order wins."""
    _touch(tmp_path / "first", "tool.exe")
    _touch(tmp_path / "second", "tool.com", "tool.exe")
    first, second = str(tmp_path / "first"), str(tmp_path / "second")
    assert _MODULE.resolve_executable("tool", os.pathsep.join((first, second))) == (
        str(tmp_path / "first" / "tool.exe")
    )
    assert _MODULE.resolve_executable("tool", second) == (
        str(tmp_path / "second" / "tool.com")
    )


def test_resolve_executable_appends_to_a_name_that_has_an_extension(
    tmp_path: Path,
) -> None:
    """``python3.12`` names ``python3.12.exe``: the exact name goes first only."""
    _touch(tmp_path, "python3.12.exe")
    assert _MODULE.resolve_executable("python3.12", str(tmp_path)) == (
        str(tmp_path / "python3.12.exe")
    )
    _touch(tmp_path, "python3.12")
    assert _MODULE.resolve_executable("python3.12", str(tmp_path)) == (
        str(tmp_path / "python3.12")
    )


def test_resolve_executable_searches_the_current_directory_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``CreateProcessW`` searches the parent's directory before PATH."""
    _touch(tmp_path / "cwd", "tool.exe")
    _touch(tmp_path / "bin", "tool.exe")
    monkeypatch.chdir(tmp_path / "cwd")
    assert _MODULE.resolve_executable("tool", str(tmp_path / "bin")) == (
        os.path.join(os.curdir, "tool.exe")
    )


def test_resolve_executable_defaults_to_the_host_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An immediate session has no child block, so the host's PATH is searched."""
    _touch(tmp_path, "tool.exe")
    monkeypatch.setenv("PATH", str(tmp_path))
    assert _MODULE.resolve_executable("tool", None) == str(tmp_path / "tool.exe")


@pytest.mark.parametrize(
    "message",
    (
        {"op": "resize", "columns": 120, "rows": 30, "command": ["cmd.exe"]},
        {"op": "start", "columns": 0, "rows": 30, "command": ["cmd.exe"]},
        {"op": "start", "columns": 120, "rows": 30, "command": []},
        {"op": "start", "columns": 120, "rows": 30, "command": ["cmd", 3]},
        {"op": "start", "columns": 120, "rows": 30, "command": ["cmd"], "cwd": 5},
        {
            "op": "start",
            "columns": 120,
            "rows": 30,
            "command": ["cmd"],
            "env": {"a=b": "1"},
        },
        {
            "op": "start",
            "columns": 120,
            "rows": 30,
            "command": ["cmd"],
            "env": {"a": 1},
        },
    ),
)
def test_parse_start_rejects_malformed_operations(message: dict[str, Any]) -> None:
    """Every malformed start op must be refused."""
    assert _MODULE._parse_start(message, "\\\\.\\pipe\\p") is None


def test_parse_ack_sequence_accepts_only_positive_integers() -> None:
    """The ack sequence must be a positive non-boolean integer."""
    assert _MODULE._parse_ack_sequence({"seq": 3}) == 3
    assert _MODULE._parse_ack_sequence({}) is None
    assert _MODULE._parse_ack_sequence({"seq": 0}) is None
    assert _MODULE._parse_ack_sequence({"seq": True}) is None
    assert _MODULE._parse_ack_sequence({"seq": "3"}) is None
    assert _MODULE._parse_ack_sequence({"seq": 2.0}) is None


def test_parse_resize_accepts_a_valid_operation() -> None:
    """A well-formed resize op yields its columns and rows."""
    assert _MODULE.parse_resize({"op": "resize", "columns": 100, "rows": 40}) == (
        100,
        40,
    )


@pytest.mark.parametrize(
    "message",
    (
        {"op": "resize"},
        {"columns": 10},
        {"columns": 0, "rows": 5},
        {"columns": 10, "rows": 0},
        {"columns": 32768, "rows": 5},
        {"columns": "10", "rows": "5"},
        {"columns": 10.5, "rows": 5},
        {"columns": True, "rows": 5},
        {"columns": None, "rows": None},
    ),
)
def test_parse_resize_rejects_invalid_dimensions(message: dict[str, Any]) -> None:
    """Anything but an in-range integer pair is refused."""
    assert _MODULE.parse_resize(message) is None


def test_parse_arguments_reads_the_frozen_host_contract() -> None:
    """The host command line splits into size, pipe name, and child command."""
    parsed = _MODULE.parse_arguments(
        ["120", "30", "\\\\.\\pipe\\obsidian-terminal-conpty-1", "--", "cmd", "/c", "x"]
    )
    assert parsed.columns == 120
    assert parsed.rows == 30
    assert parsed.pipe_name == "\\\\.\\pipe\\obsidian-terminal-conpty-1"
    assert parsed.command == ("cmd", "/c", "x")
    assert parsed.cwd is None


@pytest.mark.parametrize("cwd", ("C:\\vault\\notes", "relative dir", "--cwd", ""))
def test_parse_arguments_reads_the_working_directory_verbatim(cwd: str) -> None:
    """``--cwd`` takes any next value; the session start judges the directory.

    An empty value is accepted like the deferred ``start`` op accepts it, so
    both forms fail it the same way: as a shell-start failure, not a host one.
    """
    parsed = _MODULE.parse_arguments(
        ["120", "30", "\\\\.\\pipe\\p", "--cwd", cwd, "--", "cmd", "/c", "x"]
    )
    assert parsed.cwd == cwd
    assert parsed.command == ("cmd", "/c", "x")


def test_parse_arguments_leaves_a_working_directory_flag_after_the_separator() -> None:
    """After ``--`` everything is the child command, ``--cwd`` included."""
    parsed = _MODULE.parse_arguments(
        ["80", "24", "\\\\.\\pipe\\p", "--", "app.exe", "--cwd", "C:\\elsewhere"]
    )
    assert parsed.cwd is None
    assert parsed.command == ("app.exe", "--cwd", "C:\\elsewhere")


def test_parse_arguments_keeps_a_child_argument_that_looks_like_a_separator() -> None:
    """Only the first ``--`` separates host options from the child command."""
    parsed = _MODULE.parse_arguments(
        ["80", "24", "\\\\.\\pipe\\p", "--", "app.exe", "--", "-x"]
    )
    assert parsed.command == ("app.exe", "--", "-x")


@pytest.mark.parametrize(
    "arguments",
    (
        [],
        ["120", "30", "\\\\.\\pipe\\p"],
        ["120", "\\\\.\\pipe\\p", "--", "cmd"],
        ["120", "30", "extra", "\\\\.\\pipe\\p", "--", "cmd"],
        ["120", "30", "C:\\not-a-pipe", "--", "cmd"],
        ["0", "30", "\\\\.\\pipe\\p", "--", "cmd"],
        ["120", "99999", "\\\\.\\pipe\\p", "--", "cmd"],
        ["120", "30", "\\\\.\\pipe\\p", "--"],
        ["120", "30", "\\\\.\\pipe\\p", "--", ""],
        # ``--cwd`` without a value: the separator is never taken as one.
        ["120", "30", "\\\\.\\pipe\\p", "--cwd", "--", "cmd"],
        [
            "120",
            "30",
            "\\\\.\\pipe\\p",
            "--cwd",
            "C:\\a",
            "--cwd",
            "C:\\b",
            "--",
            "cmd",
        ],
        ["120", "30", "\\\\.\\pipe\\p", "--dir", "C:\\a", "--", "cmd"],
        ["--cwd", "C:\\a", "120", "30", "\\\\.\\pipe\\p", "--", "cmd"],
        ["120", "30", "--cwd", "C:\\a", "\\\\.\\pipe\\p", "--", "cmd"],
    ),
)
def test_parse_arguments_rejects_a_malformed_command_line(
    arguments: Sequence[str],
) -> None:
    """Every contract violation must be refused rather than guessed at."""
    with pytest.raises(ValueError):
        _MODULE.parse_arguments(arguments)


# ---------------------------------------------------------------------------
# Exit-code translation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("code", "expected"),
    (
        (0, 0),
        (1, 1),
        (42, 42),
        (255, 255),
        (9009, 9009),
        (0xC0000142, -1073741502),
        (0xFFFFFFFF, -1),
    ),
)
def test_to_exit_status_keeps_the_windows_exit_code(code: int, expected: int) -> None:
    """Codes above ``INT_MAX`` become their signed equivalent for ``sys.exit``."""
    assert _MODULE.to_exit_status(code) == expected
    assert _MODULE.to_exit_status(code) & 0xFFFFFFFF == code


@pytest.mark.parametrize(
    ("error", "expected"), ((2, 9009), (3, 9009), (5, 251), (267, 251), (0, 251))
)
def test_spawn_exit_code_distinguishes_missing_from_refused(
    error: int, expected: int
) -> None:
    """Missing reuses the legacy backend's 9009; any other refusal is 251."""
    assert _MODULE.spawn_exit_code(error) == expected


def test_child_start_error_carries_the_exit_code() -> None:
    """The host reports the carried code; ``winerror`` exists only on Windows."""
    error = _MODULE.ChildStartError("refused", 251)
    assert isinstance(error, OSError)
    assert error.exit_code == 251


# ---------------------------------------------------------------------------
# Windows acceptance test
# ---------------------------------------------------------------------------


class _HostResult(NamedTuple):
    """What one supervised ConPTY host run produced."""

    stdout: bytes
    stderr: bytes
    code: int
    messages: tuple[dict[str, Any], ...]
    pid: int

    @property
    def text(self) -> str:
        """Return the terminal output decoded for substring assertions."""
        return self.stdout.decode("utf-8", "replace")


def _kernel32() -> Any:
    """Return the ``kernel32`` binding used by the test control server."""
    if sys.platform != "win32":
        raise NotImplementedError(sys.platform)
    return ctypes.WinDLL(  # ty: ignore[possibly-missing-attribute]
        "kernel32", use_last_error=True
    )


def _win32_error() -> int:
    """Return the calling thread's last Win32 error code."""
    return ctypes.get_last_error()  # ty: ignore[possibly-missing-attribute]


"""``SYNCHRONIZE | PROCESS_TERMINATE``: wait on a process, and clean it up."""
_PROCESS_WATCH_ACCESS = 0x00100000 | 0x0001


class _ProcessWatch:
    """Pin running processes so a test can prove that they later exited.

    An open handle keeps the process object alive, so a recycled PID can make
    neither an exited process look alive nor a live one look exited.
    """

    def __init__(self) -> None:
        """Start with nothing pinned."""
        self._handles: dict[int, int] = {}

    def close(self) -> None:
        """Terminate every process that outlived the test, then unpin them all."""
        kernel32 = _kernel32()
        terminate = kernel32.TerminateProcess
        terminate.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        terminate.restype = ctypes.c_int32
        close = kernel32.CloseHandle
        close.argtypes = (ctypes.c_void_p,)
        close.restype = ctypes.c_int32
        for handle in self._handles.values():
            # Fails harmlessly on a process that has already exited.
            terminate(handle, 1)
            close(handle)
        self._handles.clear()

    def pin(self, pid: int) -> None:
        """Open process ``pid``, which must still exist."""
        open_process = _kernel32().OpenProcess
        open_process.argtypes = (ctypes.c_uint32, ctypes.c_int32, ctypes.c_uint32)
        open_process.restype = ctypes.c_void_p
        handle = open_process(_PROCESS_WATCH_ACCESS, False, pid)
        if not handle:
            raise ctypes.WinError(  # ty: ignore[possibly-missing-attribute]
                _win32_error()
            )
        self._handles[pid] = int(handle)

    def survivors(self, timeout: float) -> list[int]:
        """Return the pinned PIDs still running once ``timeout`` seconds pass."""
        wait = _kernel32().WaitForSingleObject
        wait.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        wait.restype = ctypes.c_uint32
        deadline = time.monotonic() + timeout
        return [
            pid
            for pid, handle in self._handles.items()
            # ``WAIT_OBJECT_0``: the process handle is signalled once it exits.
            if wait(handle, int(max(deadline - time.monotonic(), 0.0) * 1000)) != 0
        ]


def _read_when_published(path: Path, timeout: float) -> str:
    """Poll for a file another process publishes atomically; return its text."""
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() >= deadline:
            raise AssertionError(f"{path} was not published within {timeout:.0f}s")
        time.sleep(0.05)
    return path.read_text(encoding="utf-8")


def _create_control_server(pipe_name: str) -> int:
    """Create the single-instance named pipe the host is expected to join."""
    if sys.platform != "win32":
        raise NotImplementedError(sys.platform)
    kernel32 = _kernel32()
    create = kernel32.CreateNamedPipeW
    create.argtypes = (
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
    )
    create.restype = ctypes.c_void_p
    handle = create(pipe_name, 0x00000003, 0x00000000, 1, 65536, 65536, 0, None)
    if not handle or handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(_win32_error())  # ty: ignore[possibly-missing-attribute]
    return int(handle)


class _ControlServer:
    """Serve the host control channel and record everything it announces."""

    def __init__(
        self,
        pipe_name: str,
        token: str,
        replies: Sequence[dict[str, Any]],
        authentication_token: str | None = None,
        ready_probe: Callable[[Mapping[str, Any]], None] | None = None,
        start: Mapping[str, Any] | None = None,
        hello_probe: Callable[[Mapping[str, Any]], None] | None = None,
    ) -> None:
        """Create the pipe instance and prepare the post-hello replies.

        ``start`` switches the server to the deferred protocol: it answers the
        host's ``idle`` with ``authenticate`` and then sends that ``start`` op.
        ``hello_probe`` runs while the child is still suspended, before any
        answer to ``hello``; ``ready_probe`` runs before the replies are sent.
        """
        self.authentication_token = (
            token if authentication_token is None else authentication_token
        )
        self.start_operation = dict(start) if start is not None else None
        self.handle = _create_control_server(pipe_name)
        self.hello_probe = hello_probe
        self.messages: list[dict[str, Any]] = []
        self.probe_error: Exception | None = None
        self.ready = threading.Event()
        self.ready_probe = ready_probe
        self.replies = tuple(replies)
        self.token = token
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._closed = False

    def start(self) -> None:
        """Begin accepting the host in the background."""
        self._thread.start()

    def join(self, timeout: float) -> None:
        """Wait for the server loop to finish."""
        self._thread.join(timeout)

    def close(self) -> None:
        """Cancel any unconnected accept, join it, then release the pipe."""
        if self._closed:
            return
        kernel32 = _kernel32()
        if self._thread.is_alive():
            _MODULE._cancel_and_join_reader(
                self._thread,
                self._cancel_pending_call,
                1.0,
                0.05,
            )
        kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)
        kernel32.CloseHandle.restype = ctypes.c_int32
        kernel32.CloseHandle(self.handle)
        self._closed = True

    def _cancel_pending_call(self) -> None:
        """Cancel synchronous ConnectNamedPipe or ReadFile on the server thread."""
        native_id = self._thread.native_id
        if native_id is None:
            raise OSError("the control server has no native thread id")
        kernel32 = _kernel32()
        open_thread = kernel32.OpenThread
        open_thread.argtypes = (ctypes.c_uint32, ctypes.c_int32, ctypes.c_uint32)
        open_thread.restype = ctypes.c_void_p
        cancel = kernel32.CancelSynchronousIo
        cancel.argtypes = (ctypes.c_void_p,)
        cancel.restype = ctypes.c_int32
        close = kernel32.CloseHandle
        close.argtypes = (ctypes.c_void_p,)
        close.restype = ctypes.c_int32
        thread_handle = open_thread(0x0001, False, native_id)
        if not thread_handle:
            if not self._thread.is_alive():
                return
            raise ctypes.WinError(_win32_error())  # ty: ignore[possibly-missing-attribute]
        try:
            if (
                not cancel(thread_handle)
                and _win32_error() != 1168
                and self._thread.is_alive()
            ):
                raise ctypes.WinError(  # ty: ignore[possibly-missing-attribute]
                    _win32_error()
                )
        finally:
            close(thread_handle)

    def _run(self) -> None:
        """Accept the host, answer its hello, then drain until it leaves."""
        kernel32 = _kernel32()
        connect = kernel32.ConnectNamedPipe
        connect.argtypes = (ctypes.c_void_p, ctypes.c_void_p)
        connect.restype = ctypes.c_int32
        # ``ERROR_PIPE_CONNECTED`` means the client arrived first, not a failure.
        if not connect(self.handle, None) and _win32_error() != 535:
            return
        decoder = _MODULE.NdjsonDecoder()
        authenticated = False
        answered = False
        while True:
            data = self._read()
            if not data:
                return
            for message in decoder.feed(data):
                self.messages.append(message)
                event = message.get("event")
                if event == "hello":
                    self._probe(self.hello_probe, message)
                if not authenticated and event == (
                    "idle" if self.start_operation is not None else "hello"
                ):
                    authenticated = True
                    if message.get("token") != self.token:
                        return
                    self._write(
                        _MODULE.encode_message(
                            {
                                "op": "authenticate",
                                "token": self.authentication_token,
                            }
                        )
                    )
                    if self.start_operation is not None:
                        self._write(_MODULE.encode_message(self.start_operation))
                elif not answered and event == "ready":
                    answered = True
                    self.ready.set()
                    self._probe(self.ready_probe, message)
                    for reply in self.replies:
                        self._write(_MODULE.encode_message(reply))

    def _probe(
        self,
        probe: Callable[[Mapping[str, Any]], None] | None,
        message: Mapping[str, Any],
    ) -> None:
        """Run one test probe on the server thread; keep its failure for later."""
        if probe is None:
            return
        try:
            probe(message)
        except (AssertionError, OSError) as error:
            self.probe_error = error

    def _read(self) -> bytes:
        """Read one chunk from the connected host, or ``b""`` at end of file."""
        kernel32 = _kernel32()
        read = kernel32.ReadFile
        read.argtypes = (
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.c_void_p,
        )
        read.restype = ctypes.c_int32
        buffer = ctypes.create_string_buffer(65536)
        count = ctypes.c_uint32(0)
        if not read(self.handle, buffer, 65536, ctypes.byref(count), None):
            return b""
        return buffer.raw[: count.value]

    def _write(self, payload: bytes) -> None:
        """Write one control message to the connected host."""
        kernel32 = _kernel32()
        write = kernel32.WriteFile
        write.argtypes = (
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(ctypes.c_uint32),
            ctypes.c_void_p,
        )
        write.restype = ctypes.c_int32
        count = ctypes.c_uint32(0)
        write(self.handle, payload, len(payload), ctypes.byref(count), None)


def _run_host(
    command: Sequence[str],
    columns: int = 120,
    rows: int = 30,
    stdin: bytes = b"",
    stdin_chunks: Sequence[bytes] | None = None,
    stdin_interval: float = 0.0,
    stdout_ready: bytes | None = None,
    close_stdin: bool = True,
    replies: Sequence[dict[str, Any]] = (),
    authentication_token: str | None = None,
    ready_probe: Callable[[Mapping[str, Any]], None] | None = None,
    wait_for_ready_before_stdin: bool = False,
    timeout: float = _HOST_TIMEOUT,
    deferred: bool = False,
    child_environment: Mapping[str, str] | None = None,
    child_cwd: str | None = None,
    hello_probe: Callable[[Mapping[str, Any]], None] | None = None,
    interpreter: str = sys.executable,
) -> _HostResult:
    """Run the ConPTY host once against a real control pipe and child.

    ``deferred`` boots the host with ``--defer-session`` and delivers the
    command, size, ``child_environment``, and ``child_cwd`` in a ``start`` op;
    an immediate host inherits ``child_environment`` and receives ``child_cwd``
    as its ``--cwd`` argument.
    """
    pipe_name = "\\\\.\\pipe\\obsidian-terminal-conpty-test-" + uuid.uuid4().hex
    token = uuid.uuid4().hex
    start: dict[str, Any] | None = None
    if deferred:
        start = {
            "op": "start",
            "columns": columns,
            "rows": rows,
            "command": list(command),
        }
        if child_environment is not None:
            start["env"] = dict(child_environment)
        if child_cwd is not None:
            start["cwd"] = child_cwd
    server = _ControlServer(
        pipe_name,
        token,
        replies,
        authentication_token=authentication_token,
        ready_probe=ready_probe,
        start=start,
        hello_probe=hello_probe,
    )
    try:
        server.start()
        environment = dict(
            os.environ if deferred or child_environment is None else child_environment
        )
        environment[_MODULE.TOKEN_ENVIRONMENT_VARIABLE] = token
        arguments = [interpreter, str(_module_path())]
        if deferred:
            arguments.extend(["--defer-session", pipe_name])
        else:
            arguments.extend([str(columns), str(rows), pipe_name])
            if child_cwd is not None:
                arguments.extend(["--cwd", child_cwd])
            arguments.append("--")
            arguments.extend(command)
        process = subprocess.Popen(
            arguments,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
        )
        output: list[bytes] = []
        errors: list[bytes] = []
        stdout_ready_event = threading.Event()
        readers = (
            threading.Thread(
                target=lambda: output.append(
                    _drain(process.stdout, stdout_ready, stdout_ready_event)
                )
            ),
            threading.Thread(target=lambda: errors.append(_drain(process.stderr))),
        )
        for reader in readers:
            reader.daemon = True
            reader.start()
        code: int | None = None
        timeout_error: subprocess.TimeoutExpired | None = None
        try:
            if stdin and stdin_chunks is not None:
                raise AssertionError("stdin and stdin_chunks are mutually exclusive")
            if wait_for_ready_before_stdin and not server.ready.wait(
                min(timeout, 10.0)
            ):
                raise AssertionError("ConPTY host did not become ready for input")
            if stdout_ready is not None and not stdout_ready_event.wait(
                min(timeout, 10.0)
            ):
                raise AssertionError("ConPTY child did not become ready for input")
            chunks = (
                stdin_chunks
                if stdin_chunks is not None
                else ((stdin,) if stdin else ())
            )
            if process.stdin is not None:
                for index, chunk in enumerate(chunks):
                    process.stdin.write(chunk)
                    process.stdin.flush()
                    if stdin_interval > 0 and index + 1 < len(chunks):
                        time.sleep(stdin_interval)
            if close_stdin and process.stdin is not None:
                process.stdin.close()
            try:
                code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired as error:
                timeout_error = error
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=10.0)
            if process.stdin is not None and not process.stdin.closed:
                process.stdin.close()
        for reader in readers:
            reader.join(10.0)
        server.join(1.0)
        server.close()
        stderr = b"".join(errors)
        if timeout_error is not None:
            raise AssertionError(
                f"ConPTY host timed out after {timeout:.2f}s; "
                f"command={list(command)!r}; "
                f"stderr={stderr.decode('utf-8', 'replace')!r}; "
                f"messages={server.messages!r}"
            ) from timeout_error
        if code is None:
            raise AssertionError("ConPTY host exited without a process status")
        result = _HostResult(
            b"".join(output),
            stderr,
            code,
            tuple(server.messages),
            process.pid,
        )
        if server.probe_error is not None:
            raise server.probe_error
        return result
    finally:
        server.close()


def _drain(
    stream: Any,
    marker: bytes | None = None,
    marker_event: threading.Event | None = None,
) -> bytes:
    """Read one child stream, and optionally signal after a marker appears."""
    if stream is None:
        return b""
    chunks: list[bytes] = []
    try:
        while True:
            chunk = bytes(stream.read1(4096))
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
            if (
                marker is not None
                and marker_event is not None
                and marker in b"".join(chunks)
            ):
                marker_event.set()
    except OSError:
        return b"".join(chunks)


def _report_size(delay: float) -> list[str]:
    """Return a child command that prints its console size after ``delay``."""
    return [
        sys.executable,
        "-c",
        (
            f"import os, sys, time; time.sleep({delay}); "
            "size = os.get_terminal_size(); "
            "sys.stdout.write('SIZE {} {}'.format(size.columns, size.lines)); "
            "sys.stdout.flush()"
        ),
    ]


def _report_console_handles(delay: float) -> list[str]:
    """Return a child probe for CRT, standard-handle, and console API state."""
    code = (
        "import ctypes, json, msvcrt, os, time\n"
        "from ctypes import wintypes\n"
        "class COORD(ctypes.Structure):\n"
        '    _fields_ = (("X", ctypes.c_short), ("Y", ctypes.c_short))\n'
        "class RECT(ctypes.Structure):\n"
        '    _fields_ = (("Left", ctypes.c_short), ("Top", ctypes.c_short), '
        '("Right", ctypes.c_short), ("Bottom", ctypes.c_short))\n'
        "class CSBI(ctypes.Structure):\n"
        '    _fields_ = (("dwSize", COORD), ("dwCursorPosition", COORD), '
        '("wAttributes", wintypes.WORD), ("srWindow", RECT), '
        '("dwMaximumWindowSize", COORD))\n'
        'kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)\n'
        "kernel32.GetStdHandle.argtypes = (wintypes.DWORD,)\n"
        "kernel32.GetStdHandle.restype = wintypes.HANDLE\n"
        "kernel32.GetFileType.argtypes = (wintypes.HANDLE,)\n"
        "kernel32.GetFileType.restype = wintypes.DWORD\n"
        "kernel32.GetConsoleMode.argtypes = "
        "(wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))\n"
        "kernel32.GetConsoleMode.restype = wintypes.BOOL\n"
        "kernel32.GetConsoleScreenBufferInfo.argtypes = "
        "(wintypes.HANDLE, ctypes.POINTER(CSBI))\n"
        "kernel32.GetConsoleScreenBufferInfo.restype = wintypes.BOOL\n"
        f"time.sleep({delay})\n"
        "records = []\n"
        "for descriptor, standard_id in ((0, -10), (1, -11), (2, -12)):\n"
        "    standard = kernel32.GetStdHandle(ctypes.c_uint32(standard_id).value)\n"
        "    standard_value = 0 if standard is None else int(standard)\n"
        "    crt_value = int(msvcrt.get_osfhandle(descriptor))\n"
        "    mode = wintypes.DWORD(0)\n"
        "    ctypes.set_last_error(0)\n"
        "    mode_ok = bool(kernel32.GetConsoleMode(standard, ctypes.byref(mode)))\n"
        "    mode_error = ctypes.get_last_error()\n"
        "    info = CSBI()\n"
        "    ctypes.set_last_error(0)\n"
        "    info_ok = bool(kernel32.GetConsoleScreenBufferInfo(standard, "
        "ctypes.byref(info)))\n"
        "    info_error = ctypes.get_last_error()\n"
        "    try:\n"
        "        size = list(os.get_terminal_size(descriptor))\n"
        "        size_error = 0\n"
        "    except OSError as error:\n"
        "        size = None\n"
        '        size_error = getattr(error, "winerror", None) or error.errno\n'
        '    records.append({"fd": descriptor, "std": standard_value, '
        '"crt": crt_value, "fileType": int(kernel32.GetFileType(standard)), '
        '"mode": mode_ok, "modeError": mode_error, "csbi": info_ok, '
        '"csbiError": info_error, "size": size, '
        '"sizeError": size_error})\n'
        'print("CONPTY_HANDLE_PROBE=" + json.dumps(records, '
        'separators=(",", ":")), flush=True)\n'
    )
    return [sys.executable, "-c", code]


def _spawn_grandchild(pid_file: Path, detached: bool = False) -> list[str]:
    """Return a child command that publishes its grandchild's PID, then idles.

    A ``detached`` grandchild has no console, so the pseudoconsole closing
    cannot end it; only the Job Object can.
    """
    code = (
        "import os, subprocess, sys, time\n"
        "grandchild = subprocess.Popen(\n"
        "    [sys.executable, '-c', 'import time; time.sleep(120)'],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        f"    creationflags={'subprocess.DETACHED_PROCESS' if detached else 0},\n"
        ")\n"
        f"path = {str(pid_file)!r}\n"
        "with open(path + '.tmp', 'w') as stream:\n"
        "    stream.write(str(grandchild.pid))\n"
        "os.replace(path + '.tmp', path)\n"
        "time.sleep(120)\n"
    )
    return [sys.executable, "-c", code]


def _create_marker(marker: Path) -> list[str]:
    """Return a child command whose only effect is to create ``marker``."""
    return [sys.executable, "-c", f"open({str(marker)!r}, 'w').close()"]


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_host_announces_itself_and_reports_its_exit() -> None:
    """The host sends hello, authenticated readiness, then its exit."""
    result = _run_host(["cmd", "/c", "echo hello-conpty"])
    assert result.messages, result.stderr
    hello = result.messages[0]
    assert hello["event"] == "hello"
    assert isinstance(hello["hostPid"], int)
    assert hello["hostPid"] > 0
    assert isinstance(hello["childPid"], int)
    assert hello["childPid"] > 0
    ready = result.messages[1]
    assert ready["event"] == "ready"
    assert ready["createPseudoConsole"] is True
    assert ready["controlChannelAuthenticated"] is True
    assert ready["jobObjectAssigned"] is True
    assert ready["hostPid"] == hello["hostPid"]
    assert ready["childPid"] == hello["childPid"]
    assert result.messages[-1] == {"event": "exit", "code": result.code}


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_host_started_with_the_base_interpreter_reports_the_spawned_pid(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """``hostPid`` is the PID the plugin spawned when no redirector intervenes.

    A venv's ``Scripts\\python.exe`` runs the base interpreter as a child
    process, so a host started through it reports a PID its parent never saw.
    The plugin therefore spawns ``sys._base_executable``.
    """
    base = getattr(sys, "_base_executable", sys.executable)
    with capsys.disabled():
        # Recorded, not asserted: tells whether this runner uses a redirector.
        print(
            f"\nsys.executable={sys.executable!r} sys._base_executable={base!r} "
            f"differ={os.path.normcase(sys.executable) != os.path.normcase(base)}"
        )
    result = _run_host(["cmd", "/c", "echo base-interpreter"], interpreter=base)
    assert result.code == 0, result
    assert result.messages[0]["hostPid"] == result.pid, result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_deferred_host_runs_the_session_from_a_start_operation() -> None:
    """The warm path: idle, authenticate, start, then hello, ready, and exit."""
    result = _run_host(["cmd", "/c", "echo hello-deferred"], deferred=True)
    events = [message["event"] for message in result.messages]
    assert events == ["idle", "hello", "ready", "exit"], result.stderr
    idle, hello, ready = result.messages[:3]
    assert idle["hostPid"] == hello["hostPid"] == ready["hostPid"]
    assert ready["controlChannelAuthenticated"] is True
    assert result.messages[-1] == {"event": "exit", "code": result.code}
    assert result.code == 0, result.stderr
    assert "hello-deferred" in result.text


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("deferred", (False, True))
@pytest.mark.parametrize("extension", (".bat", ".cmd"))
@pytest.mark.parametrize("bare", (False, True))
def test_session_resolves_batch_launchers_through_the_child_path(
    tmp_path: Path, deferred: bool, extension: str, bare: bool
) -> None:
    """A bare name found only on the child's PATH starts, as it does cold.

    The host's own PATH does not contain ``tmp_path``, so ``CreateProcessW``
    alone would report 9009; the host must resolve through the child block.
    """
    script = tmp_path / ("obsidian-terminal-path-probe" + extension)
    script.write_text("@echo path-probe-ran\r\n", encoding="utf-8")
    environment = {
        key: value for key, value in os.environ.items() if key.upper() != "PATH"
    }
    environment["PATH"] = str(tmp_path) + os.pathsep + os.environ.get("PATH", "")
    result = _run_host(
        [script.stem if bare else script.name],
        deferred=deferred,
        child_environment=environment,
    )
    assert result.code == 0, result.stderr
    assert "path-probe-ran" in result.text


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("deferred", (False, True))
@pytest.mark.parametrize("empty_path", (False, True))
def test_session_does_not_search_the_host_path_after_a_profile_path_miss(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    deferred: bool,
    empty_path: bool,
) -> None:
    """Cold and warm sessions honor PATH restrictions and retain system lookup."""
    host_bin = tmp_path / "host-bin"
    host_bin.mkdir()
    program = host_bin / "obsidian-terminal-host-path-probe.exe"
    shutil.copyfile(Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe", program)
    monkeypatch.setenv("PATH", str(host_bin))
    command = [program.stem, "/d", "/c", "echo host-path-probe-ran"]

    # Prove the uniquely named executable is valid and on the host's PATH.
    available = _run_host(command, deferred=deferred)
    assert available.code == 0, available
    assert "host-path-probe-ran" in available.text, available

    profile_bin = tmp_path / "profile-bin"
    profile_bin.mkdir()
    environment = {
        key: value for key, value in os.environ.items() if key.upper() != "PATH"
    }
    environment["Path"] = "" if empty_path else str(profile_bin)
    missing = _run_host(command, deferred=deferred, child_environment=environment)
    assert missing.code == 9009, missing
    assert "host-path-probe-ran" not in missing.text, missing

    (profile_bin / "cmd.cmd").write_text("@echo batch-shadow-ran\r\n", encoding="utf-8")
    system = _run_host(
        ["cmd", "/d", "/c", "echo system-path-probe-ran"],
        deferred=deferred,
        child_environment=environment,
        child_cwd=str(profile_bin),
    )
    assert system.code == 0, system
    assert "system-path-probe-ran" in system.text, system
    assert "batch-shadow-ran" not in system.text, system


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_host_fails_closed_on_bad_control_authentication(tmp_path: Path) -> None:
    """A bad plugin response must stop the suspended, Job-contained child.

    No output pump exists on this path, so an empty stdout proves nothing: the
    child itself must be gone, and must never have run.
    """
    marker = tmp_path / "child-ran"
    with closing(_ProcessWatch()) as watch:
        result = _run_host(
            _create_marker(marker),
            authentication_token="wrong-token",
            hello_probe=lambda hello: watch.pin(hello["childPid"]),
        )
        assert result.code == 250
        assert [message["event"] for message in result.messages] == ["hello"]
        assert "control authentication failed" in result.stderr.decode(
            "utf-8", errors="replace"
        )
        assert watch.survivors(15.0) == []
    assert not marker.exists()


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_host_forwards_child_output_to_stdout() -> None:
    """Child output must reach the host stdout data plane."""
    result = _run_host(["cmd", "/c", "echo hello-conpty"])
    assert result.code == 0
    assert "hello-conpty" in result.text


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_host_forwards_output_while_host_stdin_remains_open() -> None:
    """The output probe isolates ConPTY output from host-stdin half-close."""
    result = _run_host(
        ["cmd", "/c", "echo hello-conpty-open-stdin"],
        close_stdin=False,
    )
    assert result.code == 0
    assert "hello-conpty-open-stdin" in result.text


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("expected", (0, 1, 42, 259))
def test_host_exit_code_mirrors_the_child(expected: int) -> None:
    """The plugin reads real exit codes straight off the host process.

    ``259`` is ``STILL_ACTIVE``: a shell may exit with it, and the host must
    not mistake that for a child it had to terminate.
    """
    result = _run_host(["cmd", "/c", f"exit {expected}"])
    assert result.code == expected
    assert result.messages[-1] == {"event": "exit", "code": expected}


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_child_starts_at_the_size_given_on_the_command_line() -> None:
    """The spawn size removes the near 1x1 first frame the plugin used to show."""
    result = _run_host(_report_size(0.5), columns=100, rows=40)
    assert result.code == 0, result
    assert "SIZE 100 40" in result.text, result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_child_standard_handles_expose_the_conpty_console_size() -> None:
    """The client probe reports exact standard-handle and console API state."""
    result = _run_host(_report_console_handles(0.5), columns=100, rows=40)
    marker = "CONPTY_HANDLE_PROBE="
    start = result.text.find(marker)
    assert result.code == 0, result
    assert start >= 0, result
    records, _ = json.JSONDecoder().raw_decode(result.text[start + len(marker) :])
    assert isinstance(records, list), result
    stdout = next(
        (record for record in records if record.get("fd") == 1),
        None,
    )
    assert stdout is not None, result
    assert stdout.get("csbi") is True, result
    assert stdout.get("size") == [100, 40], result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_resize_operation_reaches_the_child() -> None:
    """A control ``resize`` must change the size the child observes."""
    result = _run_host(
        _report_size(2.0),
        columns=120,
        rows=30,
        replies=({"op": "resize", "columns": 90, "rows": 20},),
        close_stdin=False,
    )
    assert result.code == 0, result
    assert "SIZE 90 20" in result.text, result
    # Only a sequenced resize asks for an acknowledgement.
    assert "resized" not in [message["event"] for message in result.messages]


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_sequenced_resize_operation_is_acknowledged() -> None:
    """A ``resize`` carrying ``seq`` is answered by ``resized`` with that ``seq``."""
    result = _run_host(
        _report_size(2.0),
        columns=120,
        rows=30,
        replies=({"op": "resize", "columns": 90, "rows": 20, "seq": 7},),
        close_stdin=False,
    )
    assert result.code == 0, result
    assert {
        "event": "resized",
        "columns": 90,
        "rows": 20,
        "seq": 7,
    } in result.messages, result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_host_passes_wide_characters_through_unchanged() -> None:
    """CJK output must survive the pseudoconsole as UTF-8."""
    result = _run_host(
        [
            sys.executable,
            "-c",
            (
                "import sys; sys.stdout.buffer.write('日本語'.encode('utf-8')); "
                "sys.stdout.buffer.flush()"
            ),
        ]
    )
    assert result.code == 0
    assert "日本語" in result.text


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("coalesced", (False, True))
def test_host_preserves_edited_utf8_input_through_enter(coalesced: bool) -> None:
    """Printable, Backspace, Enter, and UTF-8 input reach the exact child line.

    ``coalesced`` sends the sequence in one relay read instead of keystroke by
    keystroke: neither may change the bytes the child sees.
    """
    typed = "edit-\u00e9X\x7f\u4e2d\r"
    expected_hex = "edit-\u00e9\u4e2d".encode().hex()
    child = (
        "import sys; "
        "sys.stdout.write('CHILD_INPUT_READY\\r\\n'); "
        "sys.stdout.flush(); "
        "data = sys.stdin.buffer.readline().rstrip(b'\\r\\n'); "
        "sys.stdout.write('INPUT_HEX=' + data.hex()); "
        "sys.stdout.flush()"
    )
    keystrokes: dict[str, Any] = (
        {"stdin": typed.encode()}
        if coalesced
        else {
            "stdin_chunks": tuple(c.encode() for c in typed[:-1]) + (b"\r",),
            "stdin_interval": 0.01,
        }
    )
    result = _run_host(
        [sys.executable, "-c", child],
        stdout_ready=b"CHILD_INPUT_READY",
        close_stdin=False,
        wait_for_ready_before_stdin=True,
        **keystrokes,
    )
    assert result.code == 0, result
    assert "INPUT_HEX=" + expected_hex in result.text, result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_ctrl_c_byte_reaches_the_child() -> None:
    """A ``0x03`` byte on stdin must interrupt the child, not just close stdin.

    The byte is sent only once the child has attached to the console: a
    Ctrl+C that conhost translates before then has no process to signal.
    """
    started = time.monotonic()
    result = _run_host(
        [
            sys.executable,
            "-c",
            (
                "import sys, time; sys.stdout.write('CHILD_READY'); "
                "sys.stdout.flush(); time.sleep(30)"
            ),
        ],
        stdin=b"\x03",
        stdout_ready=b"CHILD_READY",
        close_stdin=False,
        timeout=25.0,
    )
    assert time.monotonic() - started < 25.0
    assert result.code != 0


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_kill_operation_terminates_the_child_tree(tmp_path: Path) -> None:
    """A control ``kill`` must end the child and the grandchild it started."""
    pid_file = tmp_path / "grandchild.pid"
    with closing(_ProcessWatch()) as watch:

        def pin_tree(ready: Mapping[str, Any]) -> None:
            """Pin both processes; the server sends ``kill`` only afterwards."""
            watch.pin(ready["childPid"])
            watch.pin(int(_read_when_published(pid_file, 30.0)))

        # The tree idles for two minutes, so only ``kill`` beats the timeout.
        result = _run_host(
            _spawn_grandchild(pid_file),
            close_stdin=False,
            replies=({"op": "kill"},),
            ready_probe=pin_tree,
            timeout=60.0,
        )
        assert result.code == 1
        assert watch.survivors(15.0) == []


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_host_death_takes_the_child_tree_with_it(tmp_path: Path) -> None:
    """Killing the host closes its Job Object, which must kill the whole tree.

    This is what an Obsidian crash relies on. The grandchild has no console,
    so the dying pseudoconsole cannot end it: only ``KILL_ON_JOB_CLOSE`` can.
    """
    pid_file = tmp_path / "grandchild.pid"
    with closing(_ProcessWatch()) as watch:

        def kill_host(ready: Mapping[str, Any]) -> None:
            """Pin the tree, then end the host with no chance to clean up."""
            watch.pin(ready["childPid"])
            watch.pin(int(_read_when_published(pid_file, 30.0)))
            # ``hostPid`` names the interpreter holding the Job Object even
            # when ``sys.executable`` is a venv redirector in front of it.
            os.kill(ready["hostPid"], signal.SIGTERM)

        result = _run_host(
            _spawn_grandchild(pid_file, detached=True),
            close_stdin=False,
            ready_probe=kill_host,
            timeout=60.0,
        )
        assert "exit" not in [message["event"] for message in result.messages]
        assert watch.survivors(15.0) == []


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_stdin_end_of_file_shuts_the_session_down() -> None:
    """Closing host stdin stands in for the pane closing."""
    result = _run_host(
        [sys.executable, "-c", "import time; time.sleep(30)"], timeout=25.0
    )
    assert result.code == 1


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_control_token_is_not_inherited_by_the_child() -> None:
    """The child shell must never see the control token in its environment."""
    result = _run_host(
        [
            sys.executable,
            "-c",
            (
                "import os, sys; sys.stdout.write('TOKEN=' + "
                "os.environ.get('OBSIDIAN_TERMINAL_CONPTY_TOKEN', 'absent'))"
            ),
        ]
    )
    assert result.code == 0
    assert "TOKEN=absent" in result.text


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_missing_executable_exits_with_the_shared_not_found_code() -> None:
    """A missing child executable reports 9009 for both Windows backends."""
    result = _run_host(["obsidian-terminal-no-such-executable.exe"], timeout=10.0)
    assert result.code == 9009, result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("deferred", (False, True))
@pytest.mark.parametrize("relative", (False, True))
def test_session_starts_the_child_in_its_working_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, deferred: bool, relative: bool
) -> None:
    """Both session paths resolve a relative working directory only once."""
    directory = tmp_path / "workspace"
    directory.mkdir()
    monkeypatch.chdir(tmp_path)
    result = _run_host(
        [sys.executable, "-c", "open('ran-here', 'w').close()"],
        deferred=deferred,
        child_cwd=directory.name if relative else str(directory),
    )
    assert result.code == 0, result
    assert (directory / "ran-here").exists(), result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("deferred", (False, True))
def test_missing_working_directory_is_a_shell_start_failure(
    tmp_path: Path, deferred: bool
) -> None:
    """A deleted profile directory exits 251 on both paths, with no child.

    The plugin used to hand the directory to the host's own spawn, which
    failed before any host existed and read as a broken ConPTY runtime.
    """
    marker = tmp_path / "child-ran"
    result = _run_host(
        _create_marker(marker),
        deferred=deferred,
        child_cwd=str(tmp_path / "deleted"),
    )
    assert result.code == 251, result
    # ``hello`` announces a created child, so its absence means none was.
    assert "hello" not in [message["event"] for message in result.messages], result
    assert not marker.exists()


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize(
    ("command", "cwd"),
    (
        (["cmd", "/c", "echo a\x00b"], None),
        (["cmd", "/c", "echo cwd"], "C:\\a\x00b"),
    ),
    ids=("command", "cwd"),
)
def test_nul_in_a_start_operation_is_a_shell_start_failure(
    command: Sequence[str], cwd: str | None
) -> None:
    """A NUL from the profile exits 251 instead of a traceback or a cut command."""
    result = _run_host(command, deferred=True, child_cwd=cwd)
    assert result.code == 251, result
    assert "hello" not in [message["event"] for message in result.messages], result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_deferred_start_environment_reaches_the_child_without_the_token() -> None:
    """The child sees the ``start`` op's environment, minus the control token."""
    environment = dict(os.environ)
    environment["OBSIDIAN_TERMINAL_TEST_VALUE"] = "from-start-op"
    environment[_MODULE.TOKEN_ENVIRONMENT_VARIABLE.lower()] = "leaked"
    result = _run_host(
        [
            sys.executable,
            "-c",
            (
                "import os, sys; sys.stdout.write('VALUE={} TOKEN={}'.format("
                "os.environ.get('OBSIDIAN_TERMINAL_TEST_VALUE', 'absent'), "
                "os.environ.get('OBSIDIAN_TERMINAL_CONPTY_TOKEN', 'absent')))"
            ),
        ],
        deferred=True,
        child_environment=environment,
    )
    assert result.code == 0, result
    assert "VALUE=from-start-op TOKEN=absent" in result.text, result
