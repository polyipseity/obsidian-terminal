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
from collections.abc import Callable, Collection, Mapping, Sequence
from contextlib import closing
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType
from typing import Any, NamedTuple
from unittest.mock import Mock, call

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


def test_resume_failure_terminates_the_assigned_child() -> None:
    """A failed primary-thread resume must terminate the assigned child."""
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


@pytest.mark.parametrize("character", ("x", "字"), ids=("ascii", "multibyte"))
@pytest.mark.parametrize("size", (65535, 65536, 65537))
@pytest.mark.parametrize("terminated", (False, True), ids=("fragment", "line"))
def test_decoder_enforces_the_utf8_byte_boundary(
    monkeypatch: pytest.MonkeyPatch, character: str, size: int, terminated: bool
) -> None:
    """Accept exactly 65536 bytes before the newline, even across UTF-8 chunks."""
    overhead = len(_MODULE.encode_message({"op": "authenticate", "token": ""})) - 1
    available = size - overhead
    width = len(character.encode("utf-8"))
    token = character * (available // width) + "x" * (available % width)
    message = {"op": "authenticate", "token": token}
    payload = _MODULE.encode_message(message)
    assert len(payload) == size + 1
    diagnostics = Mock()
    monkeypatch.setattr(_MODULE, "diagnose", diagnostics)
    decoder = _MODULE.NdjsonDecoder()
    # Leave the first multibyte character incomplete in the initial read.
    split = payload.index(token[:1].encode("utf-8")) + 1
    assert decoder.feed(payload[:split]) == []
    received = decoder.feed(payload[split:] if terminated else payload[split:-1])
    expected = [message] if size <= 65536 else []
    if terminated:
        assert received == expected
    else:
        assert received == []
        assert decoder.feed(b"\n") == expected
    assert diagnostics.call_count == (1 if size > 65536 else 0)
    assert decoder.feed(b'{"op":"kill"}\n') == [{"op": "kill"}]


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
    assert parsed.console_host is None


def test_parse_arguments_reads_the_deferred_console_host_hint() -> None:
    """A spare may be told to look for Windows Terminal while it waits."""
    parsed = _MODULE.parse_arguments(
        ["--defer-session", "\\\\.\\pipe\\x", "--console-host", "auto"]
    )
    assert parsed == _MODULE.DeferredArguments("\\\\.\\pipe\\x", "auto")


@pytest.mark.parametrize(
    "arguments",
    (
        ["--defer-session"],
        ["--defer-session", "not-a-pipe"],
        ["--defer-session", "\\\\.\\pipe\\x", "extra"],
        ["--defer-session", "\\\\.\\pipe\\x", "--console-host"],
        ["--defer-session", "\\\\.\\pipe\\x", "--console-host", "AUTO"],
        ["--defer-session", "\\\\.\\pipe\\x", "--cwd", "auto"],
        ["--defer-session", "\\\\.\\pipe\\x", "--console-host", "auto", "x"],
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


def test_resolve_executable_searches_the_given_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bare name resolves through the child's PATH; others pass through."""
    monkeypatch.delenv("NoDefaultCurrentDirectoryInExePath", raising=False)
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


def _write_wide_string(buffer: ctypes.Array[ctypes.c_wchar], value: str) -> int:
    """Fill a Win32 output buffer and return its character count."""
    buffer.value = value
    return len(value)


@pytest.mark.parametrize("search_cwd", (False, True))
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
    search_cwd: bool,
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
    monkeypatch.setattr(
        _MODULE,
        "_NeedCurrentDirectoryForExePathW",
        Mock(return_value=search_cwd),
        raising=False,
    )
    for binding, value in (
        ("_GetModuleFileNameW", r"C:\Python\python.exe"),
        ("_GetSystemDirectoryW", r"C:\Windows\System32"),
        ("_GetWindowsDirectoryW", r"C:\Windows"),
    ):
        monkeypatch.setattr(
            _MODULE,
            binding,
            Mock(
                side_effect=lambda *args, value=value: _write_wide_string(
                    args[-2], value
                )
            ),
            raising=False,
        )

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
    """The current directory wins when Windows permits implicit cwd lookup."""
    monkeypatch.delenv("NoDefaultCurrentDirectoryInExePath", raising=False)
    _touch(tmp_path / "cwd", "tool.exe")
    _touch(tmp_path / "bin", "tool.exe")
    monkeypatch.chdir(tmp_path / "cwd")
    assert _MODULE.resolve_executable("tool", str(tmp_path / "bin")) == (
        os.path.join(os.curdir, "tool.exe")
    )


@pytest.fixture
def current_directory_opt_out(monkeypatch: pytest.MonkeyPatch) -> None:
    """Use the real policy on Windows, substituting its result elsewhere."""
    monkeypatch.setenv("NoDefaultCurrentDirectoryInExePath", "1")
    if sys.platform != "win32":
        monkeypatch.setattr(
            _MODULE, "sys", Mock(wraps=sys, platform="win32", maxsize=sys.maxsize)
        )
        monkeypatch.setattr(
            _MODULE,
            "_NeedCurrentDirectoryForExePathW",
            Mock(return_value=False),
            raising=False,
        )


@pytest.mark.usefixtures("current_directory_opt_out")
@pytest.mark.parametrize(
    "ignored_entry",
    (
        "",
        '"',
        '""',
        f'"trusted{os.pathsep}.{os.pathsep}tools"',
        f'trusted"quoted{os.pathsep}.{os.pathsep}tools"suffix',
    ),
)
@pytest.mark.parametrize("suffix", ("", ".com", ".exe"))
def test_resolve_executable_honors_current_directory_opt_out(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    suffix: str,
    ignored_entry: str,
) -> None:
    """A planted bare name cannot shadow the same native program on PATH."""
    _touch(tmp_path / "cwd", "tool.com", "tool.exe")
    _touch(tmp_path / "bin", "tool.com", "tool.exe")
    monkeypatch.chdir(tmp_path / "cwd")
    path = os.pathsep.join((ignored_entry, str(tmp_path / "bin")))
    assert _MODULE.resolve_executable("tool" + suffix, path) == (
        str(tmp_path / "bin" / ("tool" + (suffix or ".com")))
    )


@pytest.mark.usefixtures("current_directory_opt_out")
def test_resolve_executable_opt_out_preserves_explicit_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Explicit paths work, and an explicit cwd PATH entry keeps its position."""
    _touch(tmp_path / "cwd", "tool.exe")
    _touch(tmp_path / "bin", "tool.exe")
    monkeypatch.chdir(tmp_path / "cwd")
    explicit = os.path.join(os.curdir, "tool.exe")
    path = str(tmp_path / "bin")
    assert _MODULE.resolve_executable(explicit, path) == explicit
    assert _MODULE.resolve_executable("tool", os.pathsep.join((path, os.curdir))) == (
        str(tmp_path / "bin" / "tool.exe")
    )
    assert _MODULE.resolve_executable("tool", os.pathsep.join((os.curdir, path))) == (
        explicit
    )


@pytest.mark.parametrize(
    "location, path",
    (
        ("cwd", ""),
        ("cwd", '"'),
        ("cwd", '""'),
        ("cwd", f'"trusted{os.pathsep}.{os.pathsep}tools"'),
        ("cwd", f'trusted"quoted{os.pathsep}.{os.pathsep}tools"suffix'),
        ("application", ""),
        ("system", ""),
        ("legacy", ""),
        ("windows", ""),
    ),
)
def test_resolve_executable_current_directory_opt_out_constrains_system_search(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, location: str, path: str
) -> None:
    """A fallback preserves system lookup but cannot restore implicit cwd search."""
    directories = {
        "cwd": tmp_path / "cwd",
        "application": tmp_path / ("Python" + os.pathsep + "tools"),
        "system": tmp_path / "Windows" / "System32",
        "legacy": tmp_path / "Windows" / "System",
        "windows": tmp_path / "Windows",
    }
    for directory in directories.values():
        directory.mkdir(parents=True, exist_ok=True)
    program = "obsidian-terminal-cwd-probe.exe"
    _touch(directories[location], program)
    monkeypatch.chdir(directories["cwd"])
    monkeypatch.setattr(
        _MODULE, "sys", Mock(wraps=sys, platform="win32", maxsize=2**63 - 1)
    )
    monkeypatch.setattr(
        _MODULE,
        "_NeedCurrentDirectoryForExePathW",
        Mock(return_value=False),
        raising=False,
    )
    for binding, value in (
        ("_GetModuleFileNameW", directories["application"] / "python.exe"),
        ("_GetSystemDirectoryW", directories["system"]),
        ("_GetWindowsDirectoryW", directories["windows"]),
    ):
        monkeypatch.setattr(
            _MODULE,
            binding,
            Mock(
                side_effect=lambda *args, value=value: _write_wide_string(
                    args[-2], str(value)
                )
            ),
            raising=False,
        )

    def search(
        path: str | None,
        name: str,
        _extension: object,
        _size: int,
        buffer: ctypes.Array[ctypes.c_wchar],
        _part: object,
    ) -> int:
        """Emulate SearchPathW; a NULL path performs the unsafe default search."""
        entries = path.split(os.pathsep) if path is not None else directories.values()
        for entry in entries:
            candidate = Path(entry) / name
            if candidate.is_file():
                return _write_wide_string(buffer, str(candidate.resolve()))
        return 0

    monkeypatch.setattr(
        _MODULE, "_SearchPathW", Mock(side_effect=search), raising=False
    )
    if location == "cwd":
        with pytest.raises(_MODULE.ChildStartError) as caught:
            _MODULE.resolve_executable(program, path)
        assert caught.value.exit_code == 9009
    else:
        assert _MODULE.resolve_executable(program, path) == str(
            directories[location] / program
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
        {"op": "start", "columns": 120, "rows": 30, "command": [""]},
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
            "env": {"": ""},
        },
        {
            "op": "start",
            "columns": 120,
            "rows": 30,
            "command": ["cmd"],
            "env": {"a": 1},
        },
        {
            "op": "start",
            "columns": 120,
            "rows": 30,
            "command": ["cmd"],
            "consoleHost": 5,
        },
        {
            "op": "start",
            "columns": 120,
            "rows": 30,
            "command": ["cmd"],
            "consoleHost": ["auto"],
        },
        # ``auto`` is the only console host spec.
        {
            "op": "start",
            "columns": 120,
            "rows": 30,
            "command": ["cmd"],
            "consoleHost": "",
        },
        {
            "op": "start",
            "columns": 120,
            "rows": 30,
            "command": ["cmd"],
            "consoleHost": "C:\\wt\\OpenConsole.exe",
        },
        {
            "op": "start",
            "columns": 120,
            "rows": 30,
            "command": ["cmd"],
            "consoleHost": "AUTO",
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


@pytest.mark.parametrize("cwd_first", (True, False))
def test_parse_arguments_reads_both_options_in_either_order(cwd_first: bool) -> None:
    """``--cwd`` and ``--console-host`` may come in any order before ``--``."""
    cwd = ["--cwd", "C:\\vault"]
    console_host = ["--console-host", "auto"]
    options = cwd + console_host if cwd_first else console_host + cwd
    parsed = _MODULE.parse_arguments(
        ["120", "30", "\\\\.\\pipe\\p", *options, "--", "cmd", "/c", "x"]
    )
    assert parsed.cwd == "C:\\vault"
    assert parsed.console_host == "auto"
    assert parsed.command == ("cmd", "/c", "x")


def test_parse_arguments_reads_the_auto_console_host() -> None:
    """``--console-host auto`` asks for Windows Terminal's console host."""
    parsed = _MODULE.parse_arguments(
        ["120", "30", "\\\\.\\pipe\\p", "--console-host", "auto", "--", "cmd"]
    )
    assert parsed.console_host == "auto"
    assert parsed.cwd is None


@pytest.mark.parametrize(
    "value",
    ("C:\\Tools\\OpenConsole.exe", "relative\\OpenConsole.exe", "--cwd", "", "AUTO"),
)
def test_parse_arguments_refuses_any_other_console_host(value: str) -> None:
    """``auto`` is the only console host spec."""
    with pytest.raises(ValueError, match="--console-host takes only auto"):
        _MODULE.parse_arguments(
            ["120", "30", "\\\\.\\pipe\\p", "--console-host", value, "--", "cmd"]
        )


def test_parse_arguments_leaves_a_console_host_flag_after_the_separator() -> None:
    """After ``--``, ``--console-host`` is an argument of the child."""
    parsed = _MODULE.parse_arguments(
        ["80", "24", "\\\\.\\pipe\\p", "--", "app.exe", "--console-host", "auto"]
    )
    assert parsed.console_host is None
    assert parsed.command == ("app.exe", "--console-host", "auto")


@pytest.mark.parametrize(
    ("fields", "expected"),
    (
        ({}, None),
        ({"consoleHost": None}, None),
        ({"consoleHost": "auto"}, "auto"),
    ),
)
def test_parse_start_reads_the_console_host_spec(
    fields: dict[str, Any], expected: str | None
) -> None:
    """Absent and ``null`` mean the built-in console host; ``""`` is refused.

    The plugin sends no key while the setting is off; a literal ``null`` still
    means the same.
    """
    start = _MODULE._parse_start(
        {"op": "start", "columns": 80, "rows": 24, "command": ["cmd"], **fields},
        "\\\\.\\pipe\\p",
    )
    assert start is not None
    assert start.arguments.console_host == expected


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
        # Envelope errors take precedence over a missing/empty executable.
        ["0", "30", "\\\\.\\pipe\\p", "--", ""],
        ["120", "99999", "\\\\.\\pipe\\p", "--"],
        ["invalid", "30", "\\\\.\\pipe\\p", "--", ""],
        ["120", "30", "C:\\not-a-pipe", "--", ""],
        ["120", "30", "\\\\.\\pipe\\p", "--cwd", "--", ""],
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
        # ``--console-host`` follows the same rules as ``--cwd``.
        ["120", "30", "\\\\.\\pipe\\p", "--console-host", "--", "cmd"],
        [
            "120",
            "30",
            "\\\\.\\pipe\\p",
            "--console-host",
            "auto",
            "--console-host",
            "C:\\wt\\OpenConsole.exe",
            "--",
            "cmd",
        ],
        [
            "120",
            "30",
            "\\\\.\\pipe\\p",
            "--cwd",
            "C:\\a",
            "--console-host",
            "--",
            "cmd",
        ],
        [
            "120",
            "30",
            "\\\\.\\pipe\\p",
            "--console-host",
            "auto",
            "extra",
            "--",
            "cmd",
        ],
        ["120", "30", "\\\\.\\pipe\\p", "--conpty-dir", "C:\\a", "--", "cmd"],
    ),
)
def test_parse_arguments_rejects_a_malformed_command_line(
    arguments: Sequence[str],
) -> None:
    """Every contract violation must be refused rather than guessed at."""
    with pytest.raises(ValueError):
        _MODULE.parse_arguments(arguments)


@pytest.mark.parametrize("command", ((), ("",), ("", "/c", "echo ignored")))
def test_parse_arguments_classifies_empty_executable_as_profile_fault(
    command: Sequence[str],
) -> None:
    """A valid host envelope with no executable must not condemn the runtime."""
    with pytest.raises(_MODULE.ChildStartError, match="executable") as caught:
        _MODULE.parse_arguments(["80", "24", "\\\\.\\pipe\\p", "--", *command])
    assert caught.value.exit_code == 251


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize(
    ("arguments", "token", "expected"),
    (
        (["80", "24", "\\\\.\\pipe\\p", "--", ""], "token", 251),
        (["80", "24", "\\\\.\\pipe\\p", "--"], "token", 251),
        (["0", "24", "\\\\.\\pipe\\p", "--", ""], "token", 250),
        (["80", "32768", "\\\\.\\pipe\\p", "--", ""], "token", 250),
        (["80", "24", "not-a-pipe", "--", ""], "token", 250),
        (["80", "24", "\\\\.\\pipe\\p", "--cwd", "--", ""], "token", 250),
        (["80", "24", "\\\\.\\pipe\\p", ""], "token", 250),
        (["80", "24", "\\\\.\\pipe\\p", "--", "cmd"], None, 250),
        (["80", "24", "\\\\.\\pipe\\p", "--", ""], None, 250),
        (["80", "24", "\\\\.\\pipe\\p", "--"], "", 250),
    ),
)
def test_main_classifies_profile_and_host_argument_errors(
    arguments: Sequence[str], token: str | None, expected: int
) -> None:
    """Rejected launches exit promptly with the profile or host fault code."""
    environment = dict(os.environ)
    environment.pop(_MODULE.TOKEN_ENVIRONMENT_VARIABLE, None)
    if token is not None:
        environment[_MODULE.TOKEN_ENVIRONMENT_VARIABLE] = token
    result = subprocess.run(
        [sys.executable, str(_module_path()), *arguments],
        input=b"",
        capture_output=True,
        env=environment,
        timeout=_HOST_TIMEOUT,
        check=False,
    )
    assert result.returncode == expected, result.stderr
    assert result.stdout == b""
    assert b"win32_conpty:" in result.stderr
    assert b"Traceback" not in result.stderr


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
    assert error.win32_error == 0


def test_child_start_error_carries_the_win32_error() -> None:
    """A failed ``CreateProcessW`` keeps its Win32 error beside the exit code."""
    error = _MODULE.ChildStartError("[WinError 740] elevation", 251, 740)
    assert (error.exit_code, error.win32_error) == (251, 740)


# ---------------------------------------------------------------------------
# Console host selection
# ---------------------------------------------------------------------------


"""Folder Windows installs package programs under."""
_WINDOWS_APPS = "C:\\Program Files\\WindowsApps"


def _terminal_package(
    version: str = "1.24.12741.0", architecture: str = "x64", preview: bool = False
) -> tuple[str, str]:
    """Return a Windows Terminal ``(package full name, root folder)`` pair."""
    product = "WindowsTerminalPreview" if preview else "WindowsTerminal"
    name = f"Microsoft.{product}_{version}_{architecture}__8wekyb3d8bbwe"
    return name, ntpath.join(_WINDOWS_APPS, name)


def _console_host_of(package: tuple[str, str]) -> str:
    """Return the ``OpenConsole.exe`` path inside a package root folder."""
    return ntpath.join(package[1], "OpenConsole.exe")


def _pick(
    packages: Sequence[tuple[str, str]],
    native_architecture: str | None = None,
    missing: Collection[str] = (),
) -> Any:
    """Pick among packages whose ``OpenConsole.exe`` exists unless ``missing``."""
    files = {_console_host_of(package) for package in packages} - set(missing)
    return _MODULE.pick_windows_terminal(
        packages, lambda path: path in files, native_architecture
    )


def test_pick_windows_terminal_prefers_stable_over_a_newer_preview() -> None:
    """A Preview only wins when no stable Windows Terminal qualifies."""
    stable = _terminal_package("1.23.10000.0")
    preview = _terminal_package("1.25.1.0", preview=True)
    assert _pick([preview, stable]) == _MODULE.WindowsTerminal(
        stable[0], _console_host_of(stable)
    )
    assert _pick([preview]) == _MODULE.WindowsTerminal(
        preview[0], _console_host_of(preview)
    )


def test_pick_windows_terminal_compares_versions_numerically() -> None:
    """``1.100`` is newer than ``1.24``, though it sorts lower as text."""
    packages = [
        _terminal_package("1.24.9999.0"),
        _terminal_package("1.100.1.0"),
        _terminal_package("1.22.0.0"),
    ]
    assert _pick(packages).package == packages[1][0]


def test_pick_windows_terminal_requires_version_1_22() -> None:
    """Older releases still drop OSC input, so they never qualify."""
    assert _pick([_terminal_package("1.21.3231.0")]) is None
    oldest = _terminal_package("1.22.0.0")
    assert _pick([_terminal_package("1.21.9999.9"), oldest]).package == oldest[0]


@pytest.mark.parametrize(
    ("native", "expected"),
    (("arm64", "arm64"), ("x64", "x64"), (None, "x64"), ("x86", "x64")),
)
def test_pick_windows_terminal_prefers_the_native_architecture(
    native: str | None, expected: str
) -> None:
    """Among equal versions the native build wins; any build still qualifies."""
    packages = [
        _terminal_package(architecture="x64"),
        _terminal_package(architecture="arm64"),
    ]
    assert (
        _pick(packages, native).package == _terminal_package(architecture=expected)[0]
    )


def test_pick_windows_terminal_takes_a_foreign_architecture_when_alone() -> None:
    """An emulated or native mismatch still starts: ARM64 runs x64 and back."""
    package = _terminal_package(architecture="arm64")
    assert _pick([package], "x64").package == package[0]


def test_pick_windows_terminal_skips_a_package_without_openconsole() -> None:
    """A newer package missing ``OpenConsole.exe`` yields to an older one."""
    newer = _terminal_package("1.24.1.0")
    older = _terminal_package("1.23.1.0")
    assert (
        _pick([newer, older], missing={_console_host_of(newer)}).package == (older[0])
    )
    assert _pick([newer], missing={_console_host_of(newer)}) is None


@pytest.mark.parametrize(
    "package",
    (
        ("Microsoft.WindowsTerminal_1.24_x64__8wekyb3d8bbwe", _WINDOWS_APPS + "\\a"),
        ("Microsoft.WindowsTerminal_1.24.1.0_x64__otherpublisher", _WINDOWS_APPS),
        ("Microsoft.WindowsTerminalCanary_1.24.1.0_x64__8wekyb3d8bbwe", "C:\\a"),
        ("Microsoft.WindowsNotepad_11.2.0.0_x64__8wekyb3d8bbwe", "C:\\a"),
        ("Microsoft.WindowsTerminal_1.24.1.0_x64__8wekyb3d8bbwe.bak", "C:\\a"),
        ("Microsoft.WindowsTerminal_1.24.1.0_x64__8wekyb3d8bbwe", "relative"),
        ("Microsoft.WindowsTerminal_1.24.1.0_x64__8wekyb3d8bbwe", ""),
    ),
    ids=(
        "short-version",
        "publisher",
        "canary",
        "other-app",
        "suffix",
        "relative-root",
        "empty-root",
    ),
)
def test_pick_windows_terminal_ignores_malformed_packages(
    package: tuple[str, str],
) -> None:
    """Only well-formed Windows Terminal names with an absolute root qualify."""
    assert _pick([package]) is None


@pytest.mark.parametrize(
    ("path", "expected"),
    (
        (_WINDOWS_APPS + "\\Pkg\\OpenConsole.exe", True),
        ("c:\\program files\\windowsapps\\pkg\\OpenConsole.exe", True),
        ("C:/Program Files/WindowsApps/Pkg/OpenConsole.exe", True),
        ("C:\\WindowsAppsBackup\\OpenConsole.exe", False),
        ("C:\\Tools\\OpenConsole.exe", False),
    ),
)
def test_in_windows_apps_matches_a_whole_path_segment(
    path: str, expected: bool
) -> None:
    """Any ``WindowsApps`` segment, in any case or separator, needs a copy."""
    assert _MODULE._in_windows_apps(path) is expected


class _PlanCalls(NamedTuple):
    """The seams one ``_plan_console_host`` call used."""

    host: Any
    find: Mock
    copy: Mock


def _plan(
    spec: str | None,
    found: Any = None,
    copy: Mock | None = None,
) -> _PlanCalls:
    """Plan a console host with a fake Windows Terminal lookup and copy."""
    find = found if isinstance(found, Mock) else Mock(return_value=found)
    copier = copy if copy is not None else Mock(return_value="C:\\copy\\x.exe")
    host = _MODULE._plan_console_host(spec, find, copier)
    return _PlanCalls(host, find, copier)


def test_plan_console_host_without_a_spec_uses_the_built_in_host() -> None:
    """No spec means no lookup, no copy, and no fallback to report."""
    calls = _plan(None)
    assert calls.host.report() == {
        "engine": "conhost",
        "path": None,
        "fallback": None,
        "detail": None,
    }
    calls.find.assert_not_called()
    calls.copy.assert_not_called()


def test_plan_console_host_auto_copies_windows_terminal_out_of_windows_apps() -> None:
    """Windows refuses to start a package's program for anyone else."""
    package = _terminal_package()
    found = _MODULE.WindowsTerminal(package[0], _console_host_of(package))
    calls = _plan("auto", found, copy=Mock(return_value="C:\\copy\\OpenConsole.exe"))
    calls.copy.assert_called_once_with(_console_host_of(package), package[0])
    assert calls.host.report() == {
        "engine": "openconsole",
        "path": "C:\\copy\\OpenConsole.exe",
        "fallback": None,
        "detail": None,
    }


def test_plan_console_host_auto_runs_a_console_host_outside_windows_apps() -> None:
    """A Windows Terminal installed elsewhere runs in place."""
    found = _MODULE.WindowsTerminal("pkg", "D:\\Terminal\\OpenConsole.exe")
    calls = _plan("auto", found)
    calls.copy.assert_not_called()
    assert calls.host.engine == "openconsole"
    assert calls.host.path == "D:\\Terminal\\OpenConsole.exe"


def test_plan_console_host_auto_reports_a_missing_windows_terminal() -> None:
    """``auto`` without Windows Terminal 1.22 falls back with ``not-found``."""
    calls = _plan("auto")
    assert calls.host.engine == "conhost"
    assert calls.host.path is None
    assert calls.host.fallback == "not-found"
    assert "1.22" in calls.host.detail


def test_plan_console_host_auto_reports_a_failed_lookup() -> None:
    """A lookup error is a missing Windows Terminal, with its text as detail."""
    calls = _plan("auto", Mock(side_effect=PermissionError("access denied")))
    assert (calls.host.fallback, calls.host.detail) == ("not-found", "access denied")


def test_plan_console_host_reports_a_failed_copy() -> None:
    """A copy error is a failed start, with the error text as detail."""
    package = _terminal_package()
    found = _MODULE.WindowsTerminal(package[0], _console_host_of(package))
    calls = _plan("auto", found, copy=Mock(side_effect=OSError("disk full")))
    assert calls.host.report() == {
        "engine": "conhost",
        "path": None,
        "fallback": "start-failed",
        "detail": "disk full",
    }


def test_plan_console_host_ahead_reuses_an_existing_copy() -> None:
    """A waiting host plans what ``start`` would plan with the same copy."""
    package = _terminal_package()
    found = _MODULE.WindowsTerminal(package[0], _console_host_of(package))
    copy = "C:\\copy\\OpenConsole.exe"
    find_copy = Mock(return_value=copy)

    host = _MODULE._plan_console_host_ahead(Mock(return_value=found), find_copy)

    find_copy.assert_called_once_with(_console_host_of(package), package[0])
    assert host == _plan("auto", found, copy=Mock(return_value=copy)).host


def test_plan_console_host_ahead_leaves_a_missing_copy_to_start() -> None:
    """Without a copy there is no plan: only ``start`` may make the copy."""
    package = _terminal_package()
    found = _MODULE.WindowsTerminal(package[0], _console_host_of(package))
    assert (
        _MODULE._plan_console_host_ahead(
            Mock(return_value=found), Mock(return_value=None)
        )
        is None
    )


def test_plan_console_host_ahead_runs_a_console_host_outside_windows_apps() -> None:
    """A Windows Terminal installed elsewhere needs no copy to plan ahead."""
    found = _MODULE.WindowsTerminal("pkg", "D:\\Terminal\\OpenConsole.exe")
    find_copy = Mock(return_value=None)

    host = _MODULE._plan_console_host_ahead(Mock(return_value=found), find_copy)

    find_copy.assert_not_called()
    assert (host.engine, host.path) == ("openconsole", "D:\\Terminal\\OpenConsole.exe")


def test_plan_console_host_ahead_reports_a_missing_windows_terminal() -> None:
    """The fallback is planned ahead too, as ``start`` would report it."""
    host = _MODULE._plan_console_host_ahead(Mock(return_value=None), Mock())
    assert host == _plan("auto").host
    assert host.fallback == "not-found"


"""A plan for a copy of Windows Terminal's console host."""
_COPY_PLAN = _MODULE._ConsoleHost("openconsole", "C:\\copy\\OpenConsole.exe")


def test_console_host_for_start_reuses_a_plan_whose_copy_exists() -> None:
    """An ``auto`` start runs the copy a prewarmed host found while it waited."""
    is_file = Mock(return_value=True)
    plan = Mock(side_effect=AssertionError("the start planned again"))

    host = _MODULE._console_host_for_start("auto", _COPY_PLAN, is_file, plan)

    assert host is _COPY_PLAN
    is_file.assert_called_once_with("C:\\copy\\OpenConsole.exe")


def test_console_host_for_start_plans_again_when_the_copy_is_gone() -> None:
    """A copy removed since the plan was made is planned, and copied, again."""
    fresh = _MODULE._ConsoleHost("openconsole", "C:\\copy2\\OpenConsole.exe")
    plan = Mock(return_value=fresh)

    host = _MODULE._console_host_for_start(
        "auto", _COPY_PLAN, Mock(return_value=False), plan
    )

    assert host is fresh
    plan.assert_called_once_with("auto")


def test_console_host_for_start_never_reuses_a_fallback() -> None:
    """Windows Terminal may have been installed since ``not-found`` was planned."""
    planned = _MODULE._fall_back("not-found", "no Windows Terminal 1.22 or newer")
    is_file = Mock(side_effect=AssertionError("a fallback has no file"))
    plan = Mock(return_value=_COPY_PLAN)

    host = _MODULE._console_host_for_start("auto", planned, is_file, plan)

    assert host is _COPY_PLAN
    plan.assert_called_once_with("auto")


@pytest.mark.parametrize("planned", (None, _COPY_PLAN), ids=("unplanned", "planned"))
def test_console_host_for_start_plans_a_start_without_a_spec(planned: Any) -> None:
    """A start for the built-in host ignores any plan; one without a plan plans."""
    built_in = _MODULE._ConsoleHost()
    plan = Mock(return_value=built_in)

    host = _MODULE._console_host_for_start(None, planned, Mock(return_value=True), plan)

    assert host is built_in
    plan.assert_called_once_with(None)


def _copy_tree(root: Path) -> dict[str, bytes]:
    """Return every file under ``root`` by relative POSIX path, with content."""
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


def test_existing_console_host_copy_writes_nothing_without_a_copy(
    tmp_path: Path,
) -> None:
    """Looking for a copy that does not exist creates no file or folder."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"

    assert _MODULE._existing_console_host_copy(str(source), "Pkg_1", str(root)) is None
    assert not root.exists()


@pytest.mark.parametrize(
    ("content", "found"),
    ((b"console-host-v1", True), (b"console-host-v0", False), (b"old", False)),
    ids=("identical", "same-size", "other-size"),
)
def test_existing_console_host_copy_takes_only_an_identical_copy(
    tmp_path: Path, content: bytes, found: bool
) -> None:
    """A copy differing in size or SHA-256 is no copy; it stays as it is."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"
    target = root / "Pkg_1" / "OpenConsole.exe"
    target.parent.mkdir(parents=True)
    target.write_bytes(content)

    copy = _MODULE._existing_console_host_copy(str(source), "Pkg_1", str(root))

    assert copy == (str(target) if found else None)
    assert _copy_tree(root) == {"Pkg_1/OpenConsole.exe": content}


def test_copy_console_host_creates_a_missing_copy(tmp_path: Path) -> None:
    """The first run copies the source and leaves no temporary file."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"

    target = _MODULE._copy_console_host(str(source), "Pkg_1", str(root))

    assert target == str(root / "Pkg_1" / "OpenConsole.exe")
    assert _copy_tree(root) == {"Pkg_1/OpenConsole.exe": b"console-host-v1"}


"""Package full name of the Windows Terminal whose console host is copied."""
_CURRENT = _terminal_package("1.24.12741.0")[0]
"""Package full name of an older Windows Terminal copy."""
_OLDER = _terminal_package("1.23.10000.0")[0]
"""Package full name of a Windows Terminal Preview copy."""
_OLDER_PREVIEW = _terminal_package("1.24.1.0", architecture="arm64", preview=True)[0]


def test_copy_console_host_reuses_an_identical_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An up-to-date copy is not rewritten, and older versions still go.

    A copy that ran in another terminal at the last cleanup goes now.
    """
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"
    _touch(root, "unrelated")
    (root / "Pkg_0").mkdir()
    (root / _OLDER).mkdir()
    (root / _OLDER / "OpenConsole.exe").write_bytes(b"older")
    (root / _CURRENT).mkdir()
    (root / _CURRENT / "OpenConsole.exe").write_bytes(b"console-host-v1")
    copy = Mock(side_effect=AssertionError("an identical copy was rewritten"))
    monkeypatch.setattr(_MODULE.shutil, "copyfile", copy)

    target = _MODULE._copy_console_host(str(source), _CURRENT, str(root))

    assert target == str(root / _CURRENT / "OpenConsole.exe")
    assert sorted(os.listdir(root)) == sorted(("Pkg_0", _CURRENT, "unrelated"))
    copy.assert_not_called()


@pytest.mark.parametrize(
    "stale", (b"console-host-v0", b"old"), ids=("same-size", "other-size")
)
def test_copy_console_host_replaces_a_stale_copy(tmp_path: Path, stale: bytes) -> None:
    """A copy differing in size or SHA-256 is replaced; old versions go."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"
    (root / _CURRENT).mkdir(parents=True)
    (root / _CURRENT / "OpenConsole.exe").write_bytes(stale)
    (root / _OLDER).mkdir()
    (root / _OLDER / "OpenConsole.exe").write_bytes(b"older")

    target = _MODULE._copy_console_host(str(source), _CURRENT, str(root))

    assert target == str(root / _CURRENT / "OpenConsole.exe")
    assert _copy_tree(root) == {f"{_CURRENT}/OpenConsole.exe": b"console-host-v1"}


def test_copy_console_host_prunes_only_package_folders(tmp_path: Path) -> None:
    """Only real folders named like Windows Terminal packages are removed.

    Anything else under the copies folder is not this plugin's to remove: other
    names, files named like a package, and links to folders elsewhere.
    """
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"
    kept_folders = ("Pkg_0", "notes", _OLDER + ".bak", "Microsoft.WindowsNotepad")
    for name in (_OLDER, _OLDER_PREVIEW, *kept_folders):
        (root / name).mkdir(parents=True)
        (root / name / "OpenConsole.exe").write_bytes(b"older")
    package_file = _terminal_package("1.21.1.0")[0]
    _touch(root, "unrelated", package_file)
    linked = root / _terminal_package("1.22.1.0")[0]
    linked.mkdir()

    target = _MODULE._copy_console_host(
        str(source),
        _CURRENT,
        str(root),
        is_reparse_point=lambda path: path == str(linked),
    )

    assert target == str(root / _CURRENT / "OpenConsole.exe")
    assert sorted(os.listdir(root)) == sorted(
        (_CURRENT, *kept_folders, "unrelated", package_file, linked.name)
    )


@pytest.mark.parametrize("linked", ("root", "parent"))
def test_copy_console_host_prunes_nothing_through_a_link(
    tmp_path: Path, linked: str
) -> None:
    """A copies folder, or a parent, that is a junction or link leads anywhere."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "obsidian-terminal" / "copies"
    (root / _OLDER).mkdir(parents=True)
    (root / _CURRENT).mkdir()
    (root / _CURRENT / "OpenConsole.exe.4242.tmp").write_bytes(b"partial")
    reparse_point = str(root if linked == "root" else root.parent)

    target = _MODULE._copy_console_host(
        str(source),
        _CURRENT,
        str(root),
        is_reparse_point=lambda path: path == reparse_point,
    )

    assert Path(target).read_bytes() == b"console-host-v1"
    assert sorted(os.listdir(root)) == sorted((_OLDER, _CURRENT))
    assert sorted(os.listdir(root / _CURRENT)) == [
        "OpenConsole.exe",
        "OpenConsole.exe.4242.tmp",
    ]


def test_copy_console_host_prunes_nothing_through_a_symbolic_link(
    tmp_path: Path,
) -> None:
    """The default check sees a symbolic link, here as the copies folder."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / _OLDER).mkdir(parents=True)
    root = tmp_path / "copies"
    try:
        root.symlink_to(elsewhere, target_is_directory=True)
    except OSError as error:
        reason = f"symbolic links are unavailable: {error}"
        pytest.skip(reason)  # ty: ignore[too-many-positional-arguments]

    _MODULE._copy_console_host(str(source), _CURRENT, str(root))

    assert sorted(os.listdir(elsewhere)) == sorted((_OLDER, _CURRENT))


def test_is_reparse_point_sees_links_and_unreadable_paths(tmp_path: Path) -> None:
    """A folder is none; a symbolic link and a missing path count as one."""
    folder = tmp_path / "folder"
    folder.mkdir()
    assert _MODULE._is_reparse_point(str(folder)) is False
    assert _MODULE._is_reparse_point(str(tmp_path / "missing")) is True
    link = tmp_path / "link"
    try:
        link.symlink_to(folder, target_is_directory=True)
    except OSError as error:
        reason = f"symbolic links are unavailable: {error}"
        pytest.skip(reason)  # ty: ignore[too-many-positional-arguments]
    assert _MODULE._is_reparse_point(str(link)) is True


def test_copy_console_host_removes_stale_temporary_files(tmp_path: Path) -> None:
    """Temporary copies another host left behind go; nothing else does."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"
    folder = root / _CURRENT
    folder.mkdir(parents=True)
    _touch(
        folder,
        "OpenConsole.exe.4242.tmp",
        "OpenConsole.exe.7.tmp",
        "OpenConsole.exe.abc.tmp",
        "OpenConsole.exe.4242.tmp.bak",
        "OpenConsole.exe.tmp",
        "notes.txt",
    )

    _MODULE._copy_console_host(str(source), _CURRENT, str(root))

    assert sorted(os.listdir(folder)) == sorted(
        (
            "OpenConsole.exe",
            "OpenConsole.exe.abc.tmp",
            "OpenConsole.exe.4242.tmp.bak",
            "OpenConsole.exe.tmp",
            "notes.txt",
        )
    )


def test_copy_console_host_raises_when_the_source_cannot_be_read(
    tmp_path: Path,
) -> None:
    """A copy error reaches the caller and leaves no temporary file behind."""
    root = tmp_path / "copies"
    with pytest.raises(OSError):
        _MODULE._copy_console_host(str(tmp_path / "missing.exe"), "Pkg", str(root))
    assert _copy_tree(root) == {}


def test_copy_console_host_uses_a_running_copy_with_the_same_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Another host may put the same version in place and start it first."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"
    target = root / "Pkg_1" / "OpenConsole.exe"
    (root / "Pkg_0").mkdir(parents=True)

    def replace_while_running(_source: str, _target: str) -> None:
        """Lose the race: the other host's identical copy is now in use."""
        target.write_bytes(b"console-host-v1")
        raise PermissionError(13, "the copy is in use")

    replace = Mock(side_effect=replace_while_running)
    monkeypatch.setattr(_MODULE.os, "replace", replace)

    assert _MODULE._copy_console_host(str(source), "Pkg_1", str(root)) == str(target)
    assert _copy_tree(root) == {"Pkg_1/OpenConsole.exe": b"console-host-v1"}
    replace.assert_called_once()


def test_copy_console_host_raises_when_a_stale_copy_is_in_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A running copy of another version cannot stand in for the source."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"
    (root / "Pkg_1").mkdir(parents=True)
    (root / "Pkg_1" / "OpenConsole.exe").write_bytes(b"console-host-v0")
    replace = Mock(side_effect=PermissionError(13, "in use"))
    monkeypatch.setattr(_MODULE.os, "replace", replace)
    monkeypatch.setattr(_MODULE.time, "sleep", Mock())

    with pytest.raises(PermissionError):
        _MODULE._copy_console_host(str(source), "Pkg_1", str(root))
    assert _copy_tree(root) == {"Pkg_1/OpenConsole.exe": b"console-host-v0"}
    assert replace.call_count == 2


def test_copy_console_host_retries_a_replace_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Antivirus may hold a file just written; 100 ms later it lets go."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"
    real_replace = os.replace

    def replace_after_a_scan(temporary: str, target: str) -> None:
        """Fail the first attempt only, as a scanner holding the file would."""
        if replace.call_count == 1:
            raise PermissionError(13, "held by a scanner")
        real_replace(temporary, target)

    replace = Mock(side_effect=replace_after_a_scan)
    sleep = Mock()
    monkeypatch.setattr(_MODULE.os, "replace", replace)
    monkeypatch.setattr(_MODULE.time, "sleep", sleep)

    target = _MODULE._copy_console_host(str(source), "Pkg_1", str(root))

    assert target == str(root / "Pkg_1" / "OpenConsole.exe")
    assert _copy_tree(root) == {"Pkg_1/OpenConsole.exe": b"console-host-v1"}
    assert replace.call_count == 2
    sleep.assert_called_once_with(0.1)


def test_copy_console_host_removes_old_copies_best_effort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An old copy still running in another terminal must not fail the copy."""
    source = tmp_path / "source.exe"
    source.write_bytes(b"console-host-v1")
    root = tmp_path / "copies"
    (root / _OLDER).mkdir(parents=True)
    remove = Mock()
    monkeypatch.setattr(_MODULE.shutil, "rmtree", remove)

    target = _MODULE._copy_console_host(str(source), _CURRENT, str(root))

    assert Path(target).read_bytes() == b"console-host-v1"
    remove.assert_called_once_with(str(root / _OLDER), ignore_errors=True)


"""The local application data folder Windows reports."""
_LOCAL_APP_DATA = "C:\\Users\\u\\AppData\\Local"


def test_local_app_data_asks_windows_first() -> None:
    """The known folder wins over ``LOCALAPPDATA``, which a profile may change."""
    folder = _MODULE._local_app_data(
        Mock(return_value=_LOCAL_APP_DATA), {"LOCALAPPDATA": "D:\\elsewhere"}
    )
    assert folder == _LOCAL_APP_DATA


@pytest.mark.parametrize(
    "local", (_LOCAL_APP_DATA, "\\\\server\\share\\u\\AppData\\Local")
)
def test_local_app_data_takes_an_absolute_variable_when_windows_fails(
    local: str,
) -> None:
    """Without the known folder, an absolute ``LOCALAPPDATA`` serves."""
    folder = _MODULE._local_app_data(
        Mock(side_effect=OSError("SHGetKnownFolderPath failed")),
        {"LOCALAPPDATA": local},
    )
    assert folder == local


@pytest.mark.parametrize(
    "environment",
    (
        {"LOCALAPPDATA": "data"},
        {"LOCALAPPDATA": "C:data"},
        {"LOCALAPPDATA": "\\Users\\u\\AppData\\Local"},
        {"LOCALAPPDATA": ""},
        {},
    ),
    ids=("relative", "drive-relative", "rooted", "empty", "unset"),
)
def test_local_app_data_refuses_a_relative_variable(
    environment: dict[str, str],
) -> None:
    """A cold host runs in the vault: ``data`` there would be the vault's.

    ``OSError`` makes planning fall back to the built-in console host.
    """
    with pytest.raises(OSError):
        _MODULE._local_app_data(
            Mock(side_effect=OSError("SHGetKnownFolderPath failed")), environment
        )


def test_local_app_data_ignores_a_relative_known_folder() -> None:
    """A known folder that is not absolute counts as no answer."""
    folder = _MODULE._local_app_data(
        Mock(return_value="AppData"), {"LOCALAPPDATA": _LOCAL_APP_DATA}
    )
    assert folder == _LOCAL_APP_DATA


def _fake_pseudoconsole(handle: int) -> Any:
    """Return a pseudoconsole whose functions record their calls."""
    return _MODULE._PseudoConsole(handle, Mock(return_value=0), Mock())


def test_open_pseudoconsole_uses_the_built_in_host_when_none_is_planned() -> None:
    """A conhost plan keeps its report and never launches OpenConsole."""
    plan = _MODULE._fall_back("not-found", "no Windows Terminal")
    launch = Mock(side_effect=AssertionError("OpenConsole was launched"))
    built_in = _fake_pseudoconsole(7)
    host, pseudoconsole = _MODULE._open_pseudoconsole(
        plan, launch, Mock(return_value=built_in)
    )
    assert host == plan
    assert pseudoconsole is built_in


def test_open_pseudoconsole_keeps_the_handle_of_the_launched_host() -> None:
    """A launched OpenConsole owns the handle; the built-in host stays unused."""
    plan = _MODULE._ConsoleHost("openconsole", "C:\\copy\\OpenConsole.exe")
    launched = _fake_pseudoconsole(9)
    launch = Mock(return_value=launched)
    built_in = Mock(side_effect=AssertionError("the built-in host was used"))
    host, pseudoconsole = _MODULE._open_pseudoconsole(plan, launch, built_in)
    launch.assert_called_once_with("C:\\copy\\OpenConsole.exe")
    assert host.report() == {
        "engine": "openconsole",
        "path": "C:\\copy\\OpenConsole.exe",
        "fallback": None,
        "detail": None,
    }
    assert pseudoconsole is launched


@pytest.mark.parametrize(
    ("error", "fallback"),
    (
        (OSError("[WinError 5] Access is denied"), "start-failed"),
        (OSError("NtOpenFile(\\Reference) failed: 0xC0000022"), "start-failed"),
        (
            _MODULE._ConsoleHostUnsupported("ntdll does not export NtOpenFile"),
            "unsupported-os",
        ),
    ),
    ids=("create-process", "nt-status", "unsupported"),
)
def test_open_pseudoconsole_falls_back_after_a_failed_launch(
    error: OSError, fallback: str
) -> None:
    """A failed launch reports why and hands the pipes to the built-in host."""
    plan = _MODULE._ConsoleHost("openconsole", "C:\\copy\\OpenConsole.exe")
    built_in = _fake_pseudoconsole(11)
    create = Mock(return_value=built_in)
    host, pseudoconsole = _MODULE._open_pseudoconsole(
        plan, Mock(side_effect=error), create
    )
    create.assert_called_once_with()
    assert host.report() == {
        "engine": "conhost",
        "path": None,
        "fallback": fallback,
        "detail": str(error),
    }
    assert pseudoconsole is built_in


def test_open_pseudoconsole_raises_when_the_built_in_host_fails() -> None:
    """No console host at all is a host error, as before."""
    plan = _MODULE._ConsoleHost("openconsole", "C:\\copy\\OpenConsole.exe")
    with pytest.raises(OSError, match="CreatePseudoConsole"):
        _MODULE._open_pseudoconsole(
            plan,
            Mock(side_effect=OSError("launch failed")),
            Mock(side_effect=OSError("CreatePseudoConsole failed: 0x80070057")),
        )


def test_built_in_pseudoconsole_never_reports_an_exit() -> None:
    """Only a launched ``OpenConsole.exe`` can exit before the shell starts."""
    assert _fake_pseudoconsole(7).exited(1000) is None


class _ChildStart(NamedTuple):
    """The seams of one ``_create_child_or_fall_back`` call, in one recorder."""

    events: Mock
    openconsole: Any
    built_in: Any


def _child_start(exit_code: int | None, children: Sequence[Any]) -> _ChildStart:
    """Prepare an OpenConsole whose exit reports ``exit_code``.

    ``children`` are the results, or errors, of the successive child starts.
    Every seam records into ``events``, so a test can check their order.
    """
    events = Mock()
    events.create_child.side_effect = list(children)
    events.exited.return_value = exit_code
    events.create_built_in.return_value = _MODULE._PseudoConsole(
        11, events.built_in_resize, events.built_in_close
    )
    openconsole = _MODULE._PseudoConsole(9, events.resize, events.close, events.exited)
    return _ChildStart(events, openconsole, events.create_built_in.return_value)


def _create_child_on_openconsole(start: _ChildStart) -> tuple[Any, Any]:
    """Create the child on the prepared OpenConsole plan."""
    return _MODULE._create_child_or_fall_back(
        _MODULE._ConsoleHost("openconsole", "C:\\copy\\OpenConsole.exe"),
        start.openconsole,
        start.events.create_child,
        start.events.discard_child,
        start.events.create_built_in,
    )


def test_create_child_keeps_a_running_openconsole() -> None:
    """A check without waiting finds OpenConsole alive; nothing else happens."""
    start = _child_start(None, [(101, 102, 4242)])

    host, child = _create_child_on_openconsole(start)

    assert child == (101, 102, 4242)
    assert host.report() == {
        "engine": "openconsole",
        "path": "C:\\copy\\OpenConsole.exe",
        "fallback": None,
        "detail": None,
    }
    assert start.events.mock_calls == [call.create_child(9), call.exited(0)]


def test_create_child_on_the_built_in_host_never_checks_for_an_exit() -> None:
    """The built-in console host is the fallback itself."""
    start = _child_start(None, [(101, 102, 4242)])

    host, child = _MODULE._create_child_or_fall_back(
        _MODULE._ConsoleHost(),
        start.built_in,
        start.events.create_child,
        start.events.discard_child,
        start.events.create_built_in,
    )

    assert (host, child) == (_MODULE._ConsoleHost(), (101, 102, 4242))
    assert start.events.mock_calls == [call.create_child(11)]


def test_create_child_falls_back_after_a_failed_start_when_openconsole_exited() -> None:
    """OpenConsole died while loading: the built-in host runs the shell instead.

    Only once OpenConsole has exited, and its handles are closed, does the
    built-in host get the pipe ends.
    """
    start = _child_start(
        0xC0000135, [_MODULE.ChildStartError("broken", 251), (101, 102, 4242)]
    )

    host, child = _create_child_on_openconsole(start)

    assert child == (101, 102, 4242)
    assert start.events.mock_calls == [
        call.create_child(9),
        call.exited(1000),
        call.close(),
        call.create_built_in(),
        call.create_child(11),
    ]
    assert (host.engine, host.path, host.fallback) == ("conhost", None, "exited")
    assert "3221225781" in host.detail
    assert "0xC0000135" in host.detail


def test_create_child_raises_unchanged_while_openconsole_runs() -> None:
    """A start that fails beside a live OpenConsole is the profile's fault."""
    error = _MODULE.ChildStartError("access denied", 251)
    start = _child_start(None, [error])

    with pytest.raises(_MODULE.ChildStartError) as raised:
        _create_child_on_openconsole(start)

    assert raised.value is error
    assert start.events.mock_calls == [call.create_child(9), call.exited(1000)]


@pytest.mark.parametrize(
    ("win32_error", "exit_code"),
    ((2, 9009), (3, 9009), (123, 251), (193, 251), (216, 251), (740, 251)),
    ids=(
        "file-not-found",
        "path-not-found",
        "invalid-name",
        "bad-exe-format",
        "machine-type-mismatch",
        "elevation-required",
    ),
)
def test_create_child_raises_a_profile_error_without_waiting(
    win32_error: int, exit_code: int
) -> None:
    """No console host causes these errors, so OpenConsole gets no moment to exit."""
    error = _MODULE.ChildStartError("profile", exit_code, win32_error)
    start = _child_start(0xC0000135, [error])

    with pytest.raises(_MODULE.ChildStartError) as raised:
        _create_child_on_openconsole(start)

    assert raised.value is error
    assert start.events.mock_calls == [call.create_child(9)]


def test_create_child_waits_for_openconsole_after_any_other_win32_error() -> None:
    """Any other Win32 error may come from a dying OpenConsole, so it still waits."""
    start = _child_start(
        0xC0000135, [_MODULE.ChildStartError("broken", 251, 6), (101, 102, 4242)]
    )

    host, child = _create_child_on_openconsole(start)

    assert child == (101, 102, 4242)
    assert start.events.mock_calls[:2] == [call.create_child(9), call.exited(1000)]
    assert host.fallback == "exited"


def test_create_child_falls_back_when_openconsole_exited_before_the_resume() -> None:
    """The child exists but would die once resumed; it is ended unrun instead."""
    start = _child_start(1, [(201, 202, 1111), (301, 302, 2222)])

    host, child = _create_child_on_openconsole(start)

    assert child == (301, 302, 2222)
    assert start.events.mock_calls == [
        call.create_child(9),
        call.exited(0),
        call.discard_child((201, 202, 1111)),
        call.close(),
        call.create_built_in(),
        call.create_child(11),
    ]
    assert host.fallback == "exited"
    assert "code 1 " in host.detail


@pytest.mark.parametrize(
    "children",
    (
        [OSError("first"), _MODULE.ChildStartError("again", 9009)],
        [(201, 202, 1111), _MODULE.ChildStartError("again", 9009)],
    ),
    ids=("failed-start", "created-child"),
)
def test_create_child_raises_when_the_retry_fails(children: list[Any]) -> None:
    """The one retry on the built-in host fails as any start does; no third try."""
    start = _child_start(3, children)

    with pytest.raises(_MODULE.ChildStartError) as raised:
        _create_child_on_openconsole(start)

    assert raised.value is children[1]
    assert start.events.create_child.call_count == 2
    start.events.close.assert_called_once_with()
    start.events.create_built_in.assert_called_once_with()


def _check_before_hello(start: _ChildStart, host: Any, pseudoconsole: Any) -> Any:
    """Check the prepared console host before ``hello`` names child 1111."""
    return _MODULE._child_before_hello(
        host,
        pseudoconsole,
        (201, 202, 1111),
        start.events.create_child,
        start.events.discard_child,
        start.events.create_built_in,
        start.events.adopt_child,
    )


def test_child_before_hello_falls_back_once_openconsole_exited() -> None:
    """OpenConsole died after the child's start: a new child takes the built-in host.

    ``hello`` will name the new child, which joins the job before it runs.
    """
    start = _child_start(5, [(301, 302, 2222)])

    host = _check_before_hello(start, _COPY_PLAN, start.openconsole)

    assert start.events.mock_calls == [
        call.exited(0),
        call.discard_child((201, 202, 1111)),
        call.close(),
        call.create_built_in(),
        call.create_child(11),
        call.adopt_child((301, 302, 2222)),
    ]
    assert (host.engine, host.path, host.fallback) == ("conhost", None, "exited")
    assert "code 5 " in host.detail


def test_child_before_hello_keeps_the_child_of_a_running_openconsole() -> None:
    """A check without waiting finds OpenConsole alive; nothing else happens."""
    start = _child_start(None, [])

    host = _check_before_hello(start, _COPY_PLAN, start.openconsole)

    assert host is _COPY_PLAN
    assert start.events.mock_calls == [call.exited(0)]


def test_child_before_hello_never_checks_the_built_in_host() -> None:
    """After an earlier fallback, or without OpenConsole, the child stays as is."""
    start = _child_start(3, [])
    plan = _MODULE._fall_back("exited", "OpenConsole.exe exited")

    host = _check_before_hello(start, plan, start.built_in)

    assert host is plan
    assert start.events.mock_calls == []


def test_child_before_hello_raises_when_the_new_child_cannot_start() -> None:
    """The one retry fails as any start does; nothing joins the job."""
    error = _MODULE.ChildStartError("again", 9009)
    start = _child_start(3, [error])

    with pytest.raises(_MODULE.ChildStartError) as raised:
        _check_before_hello(start, _COPY_PLAN, start.openconsole)

    assert raised.value is error
    start.events.discard_child.assert_called_once_with((201, 202, 1111))
    start.events.adopt_child.assert_not_called()


@pytest.mark.parametrize("exit_code", (1, None), ids=("exited", "running"))
def test_resume_named_child_resumes_whether_or_not_openconsole_exited(
    exit_code: int | None,
) -> None:
    """``hello`` has named the child, so a dead OpenConsole no longer replaces it.

    The shell then fails on its own, with an exit code the plugin reports.
    """
    start = _child_start(exit_code, [])

    _MODULE._resume_named_child(_COPY_PLAN, start.openconsole, start.events.resume)

    assert start.events.mock_calls == [call.exited(0), call.resume()]


def test_resume_named_child_on_the_built_in_host_only_resumes() -> None:
    """The built-in console host never exits early, so nothing is checked."""
    start = _child_start(1, [])

    _MODULE._resume_named_child(
        _MODULE._ConsoleHost(), start.built_in, start.events.resume
    )

    assert start.events.mock_calls == [call.resume()]


def test_console_host_command_line_matches_conpty_dll() -> None:
    """The quoted path, size, and lowercase-hex handles of ``winconpty.cpp``."""
    path = "C:\\Program Files\\Terminal\\OpenConsole.exe"
    command_line = _MODULE._console_host_command_line(path, 120, 30, 0x1A4, 0x2BC)
    assert command_line == (
        '"C:\\Program Files\\Terminal\\OpenConsole.exe" --headless '
        "--width 120 --height 30 --signal 0x1a4 --server 0x2bc"
    )
    assert _split_command_line(command_line)[0] == path


def test_resize_signal_is_three_little_endian_shorts() -> None:
    """``PTY_SIGNAL_RESIZE_WINDOW`` (8), then the columns and the rows."""
    assert _MODULE._resize_signal(120, 30) == b"\x08\x00\x78\x00\x1e\x00"
    assert _MODULE._resize_signal(32767, 1) == b"\x08\x00\xff\x7f\x01\x00"


@pytest.mark.parametrize(
    ("error", "expected"), ((5, 0x80070005), (109, 0x8007006D), (0, 0x80004005))
)
def test_hresult_from_win32_is_a_negative_hresult(error: int, expected: int) -> None:
    """A failed resize write reports a failing ``HRESULT``, as ``conpty.dll`` does."""
    result = _MODULE._hresult_from_win32(error)
    assert result < 0
    assert result & 0xFFFFFFFF == expected


def test_ready_event_reports_the_built_in_console_host_by_default() -> None:
    """Without a requested console host, ``ready`` carries an all-null report."""
    event = _MODULE._ready_event(42, _MODULE._ConsoleHost())
    assert event == {
        "event": "ready",
        "attestation": _MODULE.READY_ATTESTATION,
        "hostPid": os.getpid(),
        "childPid": 42,
        "createPseudoConsole": True,
        "controlChannelAuthenticated": True,
        "jobObjectAssigned": True,
        "consoleHost": {
            "engine": "conhost",
            "path": None,
            "fallback": None,
            "detail": None,
        },
    }


def test_ready_event_carries_a_fallback_report() -> None:
    """The fallback code and detail reach the plugin unchanged."""
    host = _MODULE._fall_back("start-failed", "[WinError 5] Access is denied")
    assert _MODULE._ready_event(1, host)["consoleHost"] == {
        "engine": "conhost",
        "path": None,
        "fallback": "start-failed",
        "detail": "[WinError 5] Access is denied",
    }


# ---------------------------------------------------------------------------
# Windows acceptance test
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize(
    "invalid_fields",
    ({"env": {"": ""}}, {"env": {"A=B": "1"}}, {"command": [""]}),
    ids=("empty-env-key", "equals-env-key", "empty-executable"),
)
def test_deferred_host_rejects_malformed_start(
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
    invalid_fields: dict[str, object],
) -> None:
    """A rejected start closes the channel without another read or a child."""
    message = {
        "op": "start",
        "columns": 80,
        "rows": 24,
        "command": ["cmd.exe"],
        **invalid_fields,
    }
    reader = Mock(spec=io.BytesIO)
    reader.read.side_effect = [
        _MODULE.encode_message({"op": "authenticate", "token": "token"}),
        _MODULE.encode_message(message),
        AssertionError("host waited for another message after malformed start"),
    ]
    writer = Mock(wraps=io.BytesIO())
    monkeypatch.setattr(
        _MODULE,
        "_connect_control",
        Mock(return_value=_MODULE._ControlFiles(reader, writer)),
    )
    create_child = Mock(side_effect=AssertionError("host created a child"))
    monkeypatch.setattr(_MODULE, "_create_child", create_child)
    host = _MODULE._ConPtyHost(None, "token", pipe_name="pipe")

    assert host.run_deferred() == 251

    create_child.assert_not_called()
    assert reader.read.call_count == 2
    reader.close.assert_called_once_with()
    writer.close.assert_called_once_with()
    writer.write.assert_called_once_with(
        _MODULE.encode_message(
            {"event": "idle", "token": "token", "hostPid": os.getpid()}
        )
    )
    output = capfd.readouterr()
    assert output.out == ""
    assert "malformed start" in output.err


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("operation", (b'{"op":"kill"}\n', b""), ids=("kill", "eof"))
def test_deferred_host_shuts_down_quietly_while_idle(
    monkeypatch: pytest.MonkeyPatch,
    capfd: pytest.CaptureFixture[str],
    operation: bytes,
) -> None:
    """Idle kill and pipe EOF close the channel without launching a child."""
    reader = Mock(spec=io.BytesIO)
    reader.read.side_effect = [
        _MODULE.encode_message({"op": "authenticate", "token": "token"}),
        operation,
        AssertionError("host waited for another message after shutdown"),
    ]
    writer = Mock(wraps=io.BytesIO())
    monkeypatch.setattr(
        _MODULE,
        "_connect_control",
        Mock(return_value=_MODULE._ControlFiles(reader, writer)),
    )
    create_child = Mock(side_effect=AssertionError("host created a child"))
    monkeypatch.setattr(_MODULE, "_create_child", create_child)
    host = _MODULE._ConPtyHost(None, "token", pipe_name="pipe")

    assert host.run_deferred() == 0

    create_child.assert_not_called()
    reader.close.assert_called_once_with()
    writer.close.assert_called_once_with()
    writer.write.assert_called_once_with(
        _MODULE.encode_message(
            {"event": "idle", "token": "token", "hostPid": os.getpid()}
        )
    )
    assert capfd.readouterr() == ("", "")


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("reader_stops", (True, False))
def test_session_reports_exit_only_after_control_reader_stops(
    monkeypatch: pytest.MonkeyPatch, reader_stops: bool
) -> None:
    """A stuck reader cannot block the exit write or prevent channel closure."""
    host = _MODULE._ConPtyHost(_MODULE.HostArguments(80, 24, "pipe", ("cmd",)), "token")
    stop = Mock(side_effect=None if reader_stops else OSError("cancel timed out"))
    send = Mock()
    close = Mock()
    monkeypatch.setattr(host, "_start", Mock())
    monkeypatch.setattr(host, "_supervise", Mock(return_value=42))
    monkeypatch.setattr(host, "_finish", Mock())
    monkeypatch.setattr(host, "_stop_control_reader", stop)
    monkeypatch.setattr(host, "_send", send)
    monkeypatch.setattr(host, "_close_control", close)

    assert host._run_session() == 42
    stop.assert_called_once_with()
    close.assert_called_once_with()
    if reader_stops:
        send.assert_called_once_with({"event": "exit", "code": 42})
    else:
        send.assert_not_called()


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_start_rejects_missing_cwd_before_creating_pipes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unavailable cwd fails as a shell error without allocating pipes."""
    arguments = _MODULE.HostArguments(80, 24, "pipe", ("cmd",), "missing")
    host = _MODULE._ConPtyHost(arguments, "token")
    create_pipe = Mock(side_effect=AssertionError("pipe should not be created"))
    monkeypatch.setattr(_MODULE.os, "chdir", Mock(side_effect=FileNotFoundError()))
    monkeypatch.setattr(_MODULE, "_create_pipe", create_pipe)

    with pytest.raises(_MODULE.ChildStartError) as error:
        host._start()

    assert error.value.exit_code == _MODULE._EXIT_SHELL_START_FAILED
    create_pipe.assert_not_called()


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_start_closes_first_pipe_pair_when_second_pipe_creation_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The first pipe pair is released if creating the output pair fails."""
    host = _MODULE._ConPtyHost(_MODULE.HostArguments(80, 24, "pipe", ("cmd",)), "token")
    create_pipe = Mock(side_effect=[(101, 102), OSError("second pipe failed")])
    close = Mock()
    monkeypatch.setattr(_MODULE, "_create_pipe", create_pipe)
    monkeypatch.setattr(_MODULE, "_close", close)

    with pytest.raises(OSError, match="second pipe failed"):
        host._start()

    assert close.call_args_list == [((101,),), ((102,),)]


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

"""Seconds an expected survivor gets to be ended after the others exit."""
_SURVIVOR_GRACE = 2.0


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

    def survivors(self, timeout: float, expected: Collection[int] = ()) -> list[int]:
        """Return the pinned PIDs still running once ``timeout`` seconds pass.

        PIDs in ``expected`` are meant to outlive the others, so waiting on them
        would always use up the whole ``timeout``. They are checked last, once
        every other pinned process has exited, after a short grace period
        instead.
        """
        wait = _kernel32().WaitForSingleObject
        wait.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        wait.restype = ctypes.c_uint32

        def running(handle: int, until: float) -> bool:
            """Wait until ``until`` for the process; report whether it still runs."""
            # ``WAIT_OBJECT_0``: the process handle is signalled once it exits.
            return wait(handle, int(max(until - time.monotonic(), 0.0) * 1000)) != 0

        deadline = time.monotonic() + timeout
        alive = {
            pid
            for pid, handle in self._handles.items()
            if pid not in expected and running(handle, deadline)
        }
        # Anything that would end an expected survivor ends the other processes
        # first, so a short grace after they exit is enough to see it.
        grace = min(deadline, time.monotonic() + _SURVIVOR_GRACE)
        alive.update(
            pid
            for pid, handle in self._handles.items()
            if pid in expected and running(handle, grace)
        )
        return [pid for pid in self._handles if pid in alive]


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
    console_host: str | None = None,
    console_host_ahead: str | None = None,
    start_fields: Mapping[str, Any] | None = None,
    host_script: Path | None = None,
) -> _HostResult:
    """Run the ConPTY host once against a real control pipe and child.

    ``deferred`` boots the host with ``--defer-session``, plus
    ``--console-host`` with ``console_host_ahead`` when given, and delivers
    the command, size, ``child_environment``, ``child_cwd``, and
    ``console_host`` in a ``start`` op, followed by ``start_fields``; an
    immediate host inherits ``child_environment`` and receives ``child_cwd``
    and ``console_host`` as its ``--cwd`` and ``--console-host`` arguments.
    ``host_script`` runs in place of the host module, with the same arguments.
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
        if console_host is not None:
            # The plugin sends no key for the built-in host.
            start["consoleHost"] = console_host
        if child_environment is not None:
            start["env"] = dict(child_environment)
        if child_cwd is not None:
            start["cwd"] = child_cwd
        start.update(start_fields or {})
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
        arguments = [
            interpreter,
            str(_module_path() if host_script is None else host_script),
        ]
        if deferred:
            arguments.extend(["--defer-session", pipe_name])
            if console_host_ahead is not None:
                arguments.extend(["--console-host", console_host_ahead])
        else:
            arguments.extend([str(columns), str(rows), pipe_name])
            if child_cwd is not None:
                arguments.extend(["--cwd", child_cwd])
            if console_host is not None:
                arguments.extend(["--console-host", console_host])
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


def _spawn_grandchild(
    ready_file: Path, exit_gate: Path, detached: bool = False
) -> list[str]:
    """Publish the grandchild's PID and console attachment; gate shell exit."""
    grandchild_code = (
        "import ctypes, json, os, sys, time\n"
        "kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)\n"
        "process_list = kernel32.GetConsoleProcessList\n"
        "process_list.argtypes = (ctypes.POINTER(ctypes.c_uint32), ctypes.c_uint32)\n"
        "process_list.restype = ctypes.c_uint32\n"
        "pids = (ctypes.c_uint32 * 1)()\n"
        "count = process_list(pids, len(pids))\n"
        "if count > len(pids):\n"
        "    pids = (ctypes.c_uint32 * count)()\n"
        "    count = process_list(pids, len(pids))\n"
        "assert count <= len(pids)\n"
        "shell_pid = int(sys.argv[1])\n"
        "record = {'pid': os.getpid(), 'shellPid': shell_pid, "
        "'sharesConsole': shell_pid in pids[:count]}\n"
        f"path = {str(ready_file)!r}\n"
        "with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump(record, stream)\n"
        "os.replace(path + '.tmp', path)\n"
        "time.sleep(120)\n"
    )
    code = (
        "import os, subprocess, sys, time\n"
        "grandchild = subprocess.Popen(\n"
        f"    [sys.executable, '-c', {grandchild_code!r}, str(os.getpid())],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        f"    creationflags={'subprocess.DETACHED_PROCESS' if detached else 0},\n"
        ")\n"
        "deadline = time.monotonic() + 120\n"
        f"while not os.path.exists({str(exit_gate)!r}):\n"
        "    assert time.monotonic() < deadline, 'shell exit gate was not released'\n"
        "    time.sleep(0.05)\n"
        "sys.exit(42)\n"
    )
    # A venv redirector would add an unassigned interpreter between the shell
    # PID reported by the host and the process that actually runs this probe.
    return [getattr(sys, "_base_executable", sys.executable), "-c", code]


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
    assert ready["consoleHost"] == {
        "engine": "conhost",
        "path": None,
        "fallback": None,
        "detail": None,
    }
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
@pytest.mark.parametrize(
    "deferred, host_only, key, value, suffix",
    (
        (False, False, "NoDefaultCurrentDirectoryInExePath", "", ""),
        (False, False, "nodefaultcurrentdirectoryinexepath", "1", ".exe"),
        (True, False, "nodefaultcurrentdirectoryinexepath", "", ".com"),
        (True, False, "NODEFAULTCURRENTDIRECTORYINEXEPATH", "1", ""),
        (True, True, "NoDefaultCurrentDirectoryInExePath", "", ".exe"),
        (True, True, "nodefaultcurrentdirectoryinexepath", "1", ".com"),
    ),
    ids=(
        "immediate-empty",
        "immediate-set",
        "child-empty",
        "child-set",
        "host-empty",
        "host-set",
    ),
)
def test_session_honors_current_directory_opt_out(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    deferred: bool,
    host_only: bool,
    key: str,
    value: str,
    suffix: str,
) -> None:
    """Host or child opt-out presence protects both session startup modes."""
    monkeypatch.delenv("NoDefaultCurrentDirectoryInExePath", raising=False)
    cwd, path = tmp_path / "cwd", tmp_path / "bin"
    cwd.mkdir()
    path.mkdir()
    name = "obsidian-terminal-current-directory-probe"
    native_cmd = Path(os.environ["SystemRoot"]) / "System32" / "cmd.exe"
    for directory in (cwd, path):
        for extension in (".com", ".exe"):
            shutil.copyfile(native_cmd, directory / (name + extension))
    environment = {
        key: value for key, value in os.environ.items() if key.upper() != "PATH"
    }
    environment["Path"] = str(path)
    if host_only:
        # Omit the policy from the child block: it must not clear the host's.
        monkeypatch.setenv(key, value)
    else:
        environment[key] = value
    marker = cwd / "selected-shell.txt"
    command = [name + suffix, "/d", "/c", "echo %CMDCMDLINE% > selected-shell.txt"]
    allowed = _run_host(
        command,
        deferred=deferred,
        child_environment=environment,
        child_cwd=str(cwd),
    )
    assert allowed.code == 0, allowed
    assert os.path.normcase(
        str(path / (name + (suffix or ".com")))
    ) in os.path.normcase(marker.read_text())
    marker.unlink()

    environment["Path"] = ""
    missing = _run_host(
        command,
        deferred=deferred,
        child_environment=environment,
        child_cwd=str(cwd),
    )
    assert missing.code == 9009, missing
    assert "hello" not in [message["event"] for message in missing.messages], missing
    assert not marker.exists(), missing

    explicit = _run_host(
        [os.path.join(os.curdir, name + ".exe"), *command[1:]],
        deferred=deferred,
        child_environment=environment,
        child_cwd=str(cwd),
    )
    assert explicit.code == 0, explicit
    assert marker.exists(), explicit

    # The restricted fallback must still find native system programs before
    # batch launchers, even with an empty PATH and a cwd shadow.
    (cwd / "cmd.cmd").write_text("@echo batch-shadow-ran\r\n", encoding="utf-8")
    system = _run_host(
        ["cmd", "/d", "/c", "echo system-search-ran"],
        deferred=deferred,
        child_environment=environment,
        child_cwd=str(cwd),
    )
    assert system.code == 0, system
    assert "system-search-ran" in system.text, system
    assert "batch-shadow-ran" not in system.text, system


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
@pytest.mark.parametrize("shutdown", ("natural-exit", "kill", "host-death"))
@pytest.mark.parametrize("detached", (False, True), ids=("attached", "detached"))
def test_descendant_lifetime_follows_console_attachment(
    tmp_path: Path, shutdown: str, detached: bool
) -> None:
    """The shell and console clients end; a detached grandchild survives."""
    ready_file = tmp_path / "grandchild.json"
    exit_gate = tmp_path / "shell-exit"
    grandchild_pids: list[int] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_shutdown(ready: Mapping[str, object]) -> None:
            """Pin live processes before releasing the selected shutdown path."""
            assert isinstance(ready["childPid"], int)
            watch.pin(ready["childPid"])
            record: object = json.loads(_read_when_published(ready_file, 30.0))
            assert isinstance(record, dict), record
            grandchild_pid = record.get("pid")
            assert isinstance(grandchild_pid, int), record
            watch.pin(grandchild_pid)
            grandchild_pids.append(grandchild_pid)
            assert record.get("shellPid") == ready["childPid"], record
            assert record.get("sharesConsole") is (not detached), record
            assert watch.survivors(0.0) == [ready["childPid"], grandchild_pid]
            if shutdown == "natural-exit":
                exit_gate.touch()
            elif shutdown == "host-death":
                # Target the interpreter owning the job, even behind a venv
                # redirector. On Windows SIGTERM calls TerminateProcess.
                assert isinstance(ready["hostPid"], int)
                os.kill(ready["hostPid"], signal.SIGTERM)

        result = _run_host(
            _spawn_grandchild(ready_file, exit_gate, detached=detached),
            close_stdin=False,
            replies=({"op": "kill"},) if shutdown == "kill" else (),
            ready_probe=pin_before_shutdown,
            timeout=60.0,
        )
        # A startup failure must not pass the host-death case with no handles.
        assert len(grandchild_pids) == 1, result
        if shutdown == "host-death":
            assert "exit" not in [message["event"] for message in result.messages]
        else:
            assert result.messages[-1] == {"event": "exit", "code": result.code}
            if shutdown == "natural-exit":
                assert result.code == 42, result
        # Assert through pinned handles before closing the watch kills survivors.
        survivors = grandchild_pids if detached else []
        assert watch.survivors(15.0, expected=survivors) == survivors


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
    """A missing child executable makes the host exit with 9009, the code cmd.exe uses under ConHost."""
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


def _report_vt_input() -> list[str]:
    """Read raw UTF-8 VT input through a CR delimiter and report every byte."""
    code = (
        "import ctypes, msvcrt, os\n"
        "from ctypes import wintypes\n"
        'kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)\n'
        "kernel32.SetConsoleMode.argtypes = (wintypes.HANDLE, wintypes.DWORD)\n"
        "kernel32.SetConsoleMode.restype = wintypes.BOOL\n"
        "kernel32.SetConsoleCP.argtypes = (wintypes.UINT,)\n"
        "kernel32.SetConsoleCP.restype = wintypes.BOOL\n"
        "handle = msvcrt.get_osfhandle(0)\n"
        # ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_EXTENDED_FLAGS: no line,
        # echo, processed input, or Quick Edit modes.
        "if not kernel32.SetConsoleMode(handle, 0x0200 | 0x0080):\n"
        "    raise ctypes.WinError(ctypes.get_last_error())\n"
        "if not kernel32.SetConsoleCP(65001):\n"
        "    raise ctypes.WinError(ctypes.get_last_error())\n"
        "msvcrt.setmode(0, os.O_BINARY)\n"
        "print('VT_INPUT_READY', flush=True)\n"
        "data = bytearray()\n"
        "while True:\n"
        "    chunk = os.read(0, 1)\n"
        "    if chunk == b'\\r':\n"
        "        break\n"
        "    if not chunk:\n"
        "        raise EOFError('VT input ended before the delimiter')\n"
        "    data.extend(chunk)\n"
        "print('VT_INPUT_HEX=' + data.hex() + ';', flush=True)\n"
    )
    return [sys.executable, "-c", code]


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize(
    ("records", "expected_hex"),
    (
        (b"\x1b[69;18;0;1;10;1_\x1b[69;18;0;0;10;1_", "1b05"),
        (b"\x1b[81;16;64;1;9;1_\x1b[81;16;64;0;9;1_", "40"),
    ),
    ids=("ctrl-alt-e", "altgr-q"),
)
def test_win32_input_ctrl_alt_and_altgr_reach_vt_child(
    records: bytes, expected_hex: str
) -> None:
    """Conhost converts chords and preserves AltGr, without stray keyup bytes."""
    # These down/up records match the portable Win32InputMode encoder tests.
    # Read through a neutral Enter so extra characters cannot be truncated.
    result = _run_host(
        _report_vt_input(),
        stdin=records + b"\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_",
        stdout_ready=b"VT_INPUT_READY",
        close_stdin=False,
        wait_for_ready_before_stdin=True,
    )
    assert result.code == 0, result
    assert f"VT_INPUT_HEX={expected_hex};" in result.text, result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_win32_input_composed_character_reaches_vt_child() -> None:
    """The Alt+Numpad synthetic pair yields exactly one UTF-8 é, without digits."""
    # Match the addon's Alt+0233 records with NumLock on, then read through
    # Enter so duplicate characters or digit input cannot go unnoticed.
    result = _run_host(
        _report_vt_input(),
        stdin=(
            b"\x1b[18;56;0;1;34;1_\x1b[18;56;0;0;32;1_"
            b"\x1b[0;0;233;1;32;1_\x1b[0;0;233;0;32;1_"
            b"\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_"
        ),
        stdout_ready=b"VT_INPUT_READY",
        close_stdin=False,
        wait_for_ready_before_stdin=True,
    )
    assert result.code == 0, result
    assert "VT_INPUT_HEX=c3a9;" in result.text, result


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


def _ready_report(result: _HostResult) -> dict[str, Any]:
    """Return the ``consoleHost`` report of a run's ``ready`` event."""
    ready = next(
        (message for message in result.messages if message.get("event") == "ready"),
        None,
    )
    assert ready is not None, result
    report = ready.get("consoleHost")
    assert isinstance(report, dict), result
    return report


def _installed_windows_terminal() -> Any:
    """Return the Windows Terminal ``auto`` picks, or skip without one.

    On GitHub Actions the test fails instead: the ``windows-2025`` runner has
    Windows Terminal 1.23, so a skip there would hide a broken lookup. ty
    reads ``pytest.skip`` as taking no arguments, hence the ignore.
    """
    try:
        found = _MODULE._find_windows_terminal()
    except OSError as error:
        reason = f"the installed packages cannot be listed: {error}"
    else:
        if found is not None:
            return found
        reason = "Windows Terminal 1.22 or newer is not installed"
    if os.environ.get("GITHUB_ACTIONS") == "true":
        raise AssertionError(reason)
    pytest.skip(reason)  # ty: ignore[too-many-positional-arguments]


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize(
    ("deferred", "ahead"),
    ((False, None), (True, None), (True, "auto")),
    ids=("cold", "prewarmed", "prewarmed-planned-ahead"),
)
def test_session_runs_on_the_windows_terminal_console_host(
    deferred: bool, ahead: str | None
) -> None:
    """``auto`` starts Windows Terminal's OpenConsole, and the child runs on it.

    Windows refuses to start a program inside ``WindowsApps`` for anyone but
    its package, so an installed Windows Terminal runs from a local copy. A
    spare without the hint finds it only when ``start`` asks.
    """
    found = _installed_windows_terminal()
    result = _run_host(
        ["cmd", "/c", "echo hello-openconsole"],
        deferred=deferred,
        console_host_ahead=ahead,
        # OpenConsole ends its session when its input pipe breaks, so stdin
        # stays open until the child exits, as it does under the plugin.
        close_stdin=False,
        console_host="auto",
    )
    assert result.code == 0, result
    assert "hello-openconsole" in result.text, result
    report = _ready_report(result)
    assert report["engine"] == "openconsole", result
    assert (report["fallback"], report["detail"]) == (None, None), result
    path = report["path"]
    assert isinstance(path, str), result
    assert ntpath.basename(path).lower() == "openconsole.exe", result
    assert Path(path).is_file(), result
    if _MODULE._in_windows_apps(found.console_host):
        assert not _MODULE._in_windows_apps(path), result
        assert path.lower().startswith(os.environ["LOCALAPPDATA"].lower()), result
    assert result.messages[-1] == {"event": "exit", "code": 0}
    # Closing the handles must make OpenConsole exit and end the output pipe.
    assert b"output drain timed out" not in result.stderr, result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize(
    "start_fields", ({}, {"consoleHost": None}), ids=("omitted", "null")
)
def test_deferred_session_on_the_built_in_host_ignores_the_plan_ahead(
    start_fields: dict[str, Any],
) -> None:
    """A spare planned Windows Terminal's host while idle; the start still wins.

    The plugin's setting may change after the spare booted with the hint. The
    start then has no ``consoleHost``; a literal ``null`` means the same.
    """
    found = _installed_windows_terminal()
    if _MODULE._in_windows_apps(found.console_host):
        # A spare plans ahead only with an existing copy; make sure one exists.
        _MODULE._copy_from_windows_apps(found.console_host, found.package)
    # The spare runs this same lookup while it waits, so it holds this plan.
    planned = _MODULE._plan_console_host_ahead(
        _MODULE._find_windows_terminal, _MODULE._copied_from_windows_apps
    )
    assert planned is not None, planned
    assert planned.engine == "openconsole", planned
    result = _run_host(
        ["cmd", "/c", "echo hello-conhost"],
        deferred=True,
        close_stdin=False,
        console_host=None,
        console_host_ahead="auto",
        start_fields=start_fields,
    )
    assert result.code == 0, result
    assert "hello-conhost" in result.text, result
    assert _ready_report(result) == {
        "engine": "conhost",
        "path": None,
        "fallback": None,
        "detail": None,
    }, result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_resize_reaches_the_child_on_the_windows_terminal_console_host() -> None:
    """The signal-pipe resize packet resizes OpenConsole and is acknowledged."""
    _installed_windows_terminal()
    result = _run_host(
        _report_size(2.0),
        columns=120,
        rows=30,
        replies=({"op": "resize", "columns": 90, "rows": 20, "seq": 3},),
        close_stdin=False,
        console_host="auto",
    )
    assert result.code == 0, result
    assert _ready_report(result)["engine"] == "openconsole", result
    assert "SIZE 90 20" in result.text, result
    assert {
        "event": "resized",
        "columns": 90,
        "rows": 20,
        "seq": 3,
    } in result.messages, result
    assert b"output drain timed out" not in result.stderr, result


"""An ``OSC 7501`` query, as a program's terminal would answer it, typed in."""
_OSC_7501 = b"\x1b]7501;?\x1b\\"


def _report_osc_input() -> list[str]:
    """Return a child that tells whether ``OSC 7501`` reached its input.

    It reads ``CONIN$`` raw in VT input mode, without line input, echo, or
    processed input, for at most 10 seconds after it prints that it reads.
    """
    code = (
        "import ctypes, os, threading\n"
        "from ctypes import wintypes\n"
        'kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)\n'
        "kernel32.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, "
        "wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, "
        "wintypes.HANDLE)\n"
        "kernel32.CreateFileW.restype = wintypes.HANDLE\n"
        "kernel32.SetConsoleMode.argtypes = (wintypes.HANDLE, wintypes.DWORD)\n"
        "kernel32.SetConsoleMode.restype = wintypes.BOOL\n"
        "kernel32.SetConsoleCP.argtypes = (wintypes.UINT,)\n"
        "kernel32.SetConsoleCP.restype = wintypes.BOOL\n"
        "kernel32.ReadFile.argtypes = (wintypes.HANDLE, ctypes.c_void_p, "
        "wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p)\n"
        "kernel32.ReadFile.restype = wintypes.BOOL\n"
        # GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
        # OPEN_EXISTING.
        'handle = kernel32.CreateFileW("CONIN$", 0xC0000000, 3, None, 3, 0, None)\n'
        "if not handle or handle == ctypes.c_void_p(-1).value:\n"
        "    raise ctypes.WinError(ctypes.get_last_error())\n"
        # ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_EXTENDED_FLAGS: no line,
        # echo, processed input, or Quick Edit modes.
        "if not kernel32.SetConsoleMode(handle, 0x0200 | 0x0080):\n"
        "    raise ctypes.WinError(ctypes.get_last_error())\n"
        "if not kernel32.SetConsoleCP(65001):\n"
        "    raise ctypes.WinError(ctypes.get_last_error())\n"
        f"expected = {_OSC_7501!r}\n"
        "data = bytearray()\n"
        "seen = threading.Event()\n"
        "def read():\n"
        "    buffer = ctypes.create_string_buffer(256)\n"
        "    count = wintypes.DWORD(0)\n"
        "    while kernel32.ReadFile(handle, buffer, len(buffer), "
        "ctypes.byref(count), None) and count.value:\n"
        "        data.extend(buffer.raw[: count.value])\n"
        "        if expected in data:\n"
        "            seen.set()\n"
        "            return\n"
        "threading.Thread(target=read, daemon=True).start()\n"
        "print('OSC7501-READING', flush=True)\n"
        "seen.wait(10)\n"
        "print('OSC7501-SEEN' if seen.is_set() else "
        "'OSC7501-MISSING=' + bytes(data).hex() + ';', flush=True)\n"
        # The reader may still block in ReadFile.
        "os._exit(0)\n"
    )
    return [sys.executable, "-c", code]


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize(
    ("deferred", "ahead"),
    ((False, None), (True, None), (True, "auto")),
    ids=("cold", "prewarmed", "prewarmed-planned-ahead"),
)
def test_osc_input_reaches_the_child_on_the_windows_terminal_console_host(
    deferred: bool, ahead: str | None
) -> None:
    """OpenConsole hands an OSC sequence in the input to the program.

    This is what ``auto`` is for. The console host built into Windows differs
    across Windows builds here, so it is not tested.
    """
    _installed_windows_terminal()
    result = _run_host(
        _report_osc_input(),
        stdin=_OSC_7501,
        stdout_ready=b"OSC7501-READING",
        close_stdin=False,
        wait_for_ready_before_stdin=True,
        deferred=deferred,
        console_host_ahead=ahead,
        console_host="auto",
    )
    assert result.code == 0, result
    assert _ready_report(result)["engine"] == "openconsole", result
    assert "OSC7501-SEEN" in result.text, result


def _stub_console_host_script(directory: Path, console_host: Path) -> Path:
    """Write a host script that runs ``console_host`` for ``auto``.

    The script runs the host module with the same arguments. Only ``auto``
    finds ``console_host`` as Windows Terminal's console host, and the host
    waits for a launched one to exit, so a stub that exits at once is gone
    before the shell starts however fast the host is.
    """
    script = directory / "stub_console_host.py"
    script.write_text(
        "from importlib.util import module_from_spec, spec_from_file_location\n"
        f"spec = spec_from_file_location('win32_conpty', {str(_module_path())!r})\n"
        "module = module_from_spec(spec)\n"
        "spec.loader.exec_module(module)\n"
        "module._find_windows_terminal = lambda: module.WindowsTerminal(\n"
        f"    'stub', {str(console_host)!r}\n"
        ")\n"
        "launch = module._launch_console_host\n"
        "def launch_and_wait(*arguments):\n"
        "    pseudoconsole = launch(*arguments)\n"
        "    pseudoconsole.exited(10000)\n"
        "    return pseudoconsole\n"
        "module._launch_console_host = launch_and_wait\n"
        "module.main()\n",
        encoding="utf-8",
    )
    return script


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("deferred", (False, True))
@pytest.mark.parametrize(
    ("stub", "fallback"),
    (("hostname", "exited"), ("text", "start-failed")),
    ids=("exits-at-once", "not-a-program"),
)
def test_session_falls_back_from_a_broken_console_host(
    tmp_path: Path, stub: str, fallback: str, deferred: bool
) -> None:
    """A console host that exits at once, or cannot start, hands over quietly.

    ``hostname.exe`` prints an error for the console host's arguments and
    exits. The built-in console host then runs the shell, ``ready`` says why,
    and nothing reaches stderr, which the plugin shows as an error.
    """
    console_host = tmp_path / "OpenConsole.exe"
    if stub == "hostname":
        system = os.path.join(os.environ["SystemRoot"], "System32")
        shutil.copyfile(os.path.join(system, "hostname.exe"), console_host)
    else:
        console_host.write_text("not a program\n", encoding="utf-8")
    result = _run_host(
        ["cmd", "/c", "echo hello-after-fallback"],
        close_stdin=False,
        deferred=deferred,
        console_host="auto",
        host_script=_stub_console_host_script(tmp_path, console_host),
    )
    assert result.code == 0, result
    assert "hello-after-fallback" in result.text, result
    report = _ready_report(result)
    assert (report["engine"], report["path"], report["fallback"]) == (
        "conhost",
        None,
        fallback,
    ), result
    assert isinstance(report["detail"], str), result
    assert result.stderr == b"", result
    assert result.messages[-1] == {"event": "exit", "code": 0}


def _console_host_dies_before_hello_script(directory: Path) -> Path:
    """Write a host script whose OpenConsole ends just before ``hello``.

    The script runs the host module with the same arguments. It keeps the
    process of the OpenConsole it launches, and right before the last check
    ahead of ``hello`` terminates it with exit code 7 and waits until it is
    gone, so every earlier check finds OpenConsole running.
    """
    script = directory / "console_host_dies_before_hello.py"
    script.write_text(
        "from importlib.util import module_from_spec, spec_from_file_location\n"
        f"spec = spec_from_file_location('win32_conpty', {str(_module_path())!r})\n"
        "module = module_from_spec(spec)\n"
        "spec.loader.exec_module(module)\n"
        "processes = []\n"
        "start = module._start_console_host\n"
        "def start_and_keep(*arguments):\n"
        "    process = start(*arguments)\n"
        "    processes.append(process)\n"
        "    return process\n"
        "module._start_console_host = start_and_keep\n"
        "check = module._child_before_hello\n"
        "def end_then_check(*arguments):\n"
        "    if processes:\n"
        "        module._TerminateProcess(processes[-1], 7)\n"
        "        module._WaitForSingleObject(processes[-1], 10000)\n"
        "    return check(*arguments)\n"
        "module._child_before_hello = end_then_check\n"
        "module.main()\n",
        encoding="utf-8",
    )
    return script


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("deferred", (False, True), ids=("cold", "prewarmed"))
def test_session_falls_back_when_openconsole_dies_before_hello(
    tmp_path: Path, deferred: bool
) -> None:
    """OpenConsole ending after the shell's start, before ``hello``, hands over.

    The suspended shell never ran, so the built-in console host runs a new
    one, ``hello`` and ``ready`` both name it, and nothing reaches stderr.
    """
    _installed_windows_terminal()
    result = _run_host(
        ["cmd", "/c", "echo hello-after-fallback"],
        close_stdin=False,
        deferred=deferred,
        console_host="auto",
        host_script=_console_host_dies_before_hello_script(tmp_path),
    )
    assert result.code == 0, result
    assert "hello-after-fallback" in result.text, result
    report = _ready_report(result)
    assert (report["engine"], report["path"], report["fallback"]) == (
        "conhost",
        None,
        "exited",
    ), result
    detail = report["detail"]
    assert isinstance(detail, str), result
    # The exit code the script gave OpenConsole: this fallback is its doing.
    assert "0x00000007" in detail, result
    events = {message.get("event"): message for message in result.messages}
    assert events["hello"]["childPid"] == events["ready"]["childPid"], result
    assert result.stderr == b"", result
    assert result.messages[-1] == {"event": "exit", "code": 0}


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_windows_terminal_packages_name_installed_folders() -> None:
    """Windows' package API lists each Windows Terminal package with its folder."""
    _installed_windows_terminal()
    packages = _MODULE._windows_terminal_packages()
    assert packages
    for name, root in packages:
        assert _MODULE._WINDOWS_TERMINAL_PACKAGE.fullmatch(name), name
        assert os.path.isdir(root), root
        assert name.lower() in root.lower(), (name, root)
