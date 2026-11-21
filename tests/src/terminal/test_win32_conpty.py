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
import struct
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
# Session-end sweep: the platform-free decisions
# ---------------------------------------------------------------------------


def _record(
    pid: int, parent_pid: int | None, subsystem: str, created: int | None = None
) -> Any:
    """Build one descendant record; ``created`` defaults to the PID's order."""
    return _MODULE.DescendantRecord(
        pid, parent_pid, pid if created is None else created, subsystem
    )


def _consoles(*pids: int) -> Callable[[Sequence[int]], Mapping[int, str]]:
    """Return a console check that gives exactly ``pids`` a console of their own.

    Every other process asked about has no console at all.
    """
    return lambda asked: {pid: "own" if pid in pids else "none" for pid in asked}


def test_sweep_ends_console_programs_without_a_live_gui_ancestor() -> None:
    """A console program ends unless a running GUI program is above it."""
    records = [
        # The shell: its parent is not a record.
        _record(10, 1, "console"),
        # A hidden-console helper the shell started.
        _record(20, 10, "console"),
        # An editor started from the shell, with a console child and a grandchild.
        _record(30, 10, "gui"),
        _record(40, 30, "console"),
        _record(50, 40, "console"),
        # An orphan: its launcher has exited.
        _record(60, 999, "console"),
    ]
    ended = _MODULE.select_descendants_to_end(records, _consoles(10, 20, 40, 50, 60))
    assert ended == [10, 20, 60]


def test_sweep_does_not_follow_a_reused_parent_pid() -> None:
    """A parent created after its child is a recycled PID, not an ancestor."""
    records = [_record(30, 1, "gui", created=5), _record(20, 30, "console", created=2)]
    assert _MODULE.select_descendants_to_end(records, _consoles(20)) == [20]


def test_sweep_keeps_gui_unknown_and_console_less_programs() -> None:
    """GUI images, unreadable images, detached programs and unanswered PIDs stay.

    So does a program attached to the session's pseudoconsole: its console
    host closes it with the pseudoconsole.
    """
    records = [
        _record(10, 1, "unknown"),
        _record(20, 1, "gui"),
        _record(30, 1, "console"),
        _record(40, 1, "console"),
        _record(50, 1, "console"),
    ]
    # 30 has no console, 50 is attached to the pseudoconsole; the check says
    # nothing about 40.
    answers = {30: "none", 50: "attached"}
    assert _MODULE.select_descendants_to_end(records, lambda _pids: answers) == []


def test_sweep_leaves_attached_programs_to_the_console_host() -> None:
    """A program attached to the pseudoconsole is not swept, nor does it shelter.

    The console host closes it with the pseudoconsole and gives it the usual
    time to answer. What it left in a hidden console of its own is the leak
    the sweep exists for, so that still ends.
    """
    records = [
        # The shell, attached to the pseudoconsole.
        _record(10, 1, "console"),
        # An agent CLI running in the terminal, attached as well.
        _record(20, 10, "console"),
        # A helper the agent left in a hidden console of its own.
        _record(30, 20, "console"),
    ]
    answers = {10: "attached", 20: "attached", 30: "own"}
    assert _MODULE.select_descendants_to_end(records, lambda _pids: answers) == [30]


def test_sweep_asks_the_console_check_about_console_images_only() -> None:
    """Every console image is asked about once, GUI and unreadable ones never.

    A console image under a GUI program is asked about as well: its answer
    decides whether it shelters what runs under it.
    """
    asked: list[list[int]] = []

    def probe(pids: Sequence[int]) -> Mapping[int, str]:
        """Record the question and give every process a console of its own."""
        asked.append(list(pids))
        return {pid: "own" for pid in pids}

    records = [
        _record(10, 1, "console"),
        _record(20, 1, "gui"),
        _record(30, 20, "console"),
        _record(40, 1, "unknown"),
    ]
    assert _MODULE.select_descendants_to_end(records, probe) == [10]
    assert asked == [[10, 30]]
    probe_mock = Mock()
    assert _MODULE.select_descendants_to_end([_record(20, 1, "gui")], probe_mock) == []
    probe_mock.assert_not_called()


def test_sweep_survives_a_parent_cycle() -> None:
    """Two records naming each other as parent are both ended, once."""
    records = [_record(10, 20, "console"), _record(20, 10, "console")]
    assert _MODULE.select_descendants_to_end(records, _consoles(10, 20)) == [10, 20]


def test_sweep_counts_a_parent_from_the_same_clock_tick_as_an_ancestor() -> None:
    """A GUI parent created in the same clock tick as its console child covers it.

    Creation times are only as fine as the system clock, so a GUI program and
    a console program it starts at once can share one. Only a parent created
    after its child is a recycled PID.
    """
    records = [_record(30, 1, "gui", created=7), _record(40, 30, "console", created=7)]
    assert _MODULE.select_descendants_to_end(records, _consoles(40)) == []


def test_sweep_ends_only_candidates_the_console_check_confirms() -> None:
    """An answer about a process that is no candidate ends nothing.

    A probe that also reports a console for a GUI program, or for a console
    program under one, must not get either of them ended.
    """
    records = [
        _record(10, 1, "console"),
        _record(20, 1, "gui"),
        _record(30, 20, "console"),
    ]
    answers = {10: "own", 20: "own", 30: "own"}
    assert _MODULE.select_descendants_to_end(records, lambda _pids: answers) == [10]


def test_sweep_keeps_a_program_whose_parent_is_not_known_yet() -> None:
    """A process listed without a parent this round is kept until the next.

    The job lists a process that the snapshot does not show only when it is
    too new to judge or already gone; neither is an orphan to end.
    """
    records = [_record(10, 1, "console"), _record(20, None, "console")]
    assert _MODULE.select_descendants_to_end(records, _consoles(10, 20)) == [10]


def test_sweep_keeps_what_a_console_less_program_runs() -> None:
    """A detached program keeps the console programs it runs itself.

    Detached programs stay because daemons that serve other applications must
    go on working. A daemon whose workers end with the session does not: the
    worker in a hidden console under it stays as well.
    """
    records = [
        # The shell.
        _record(10, 1, "console"),
        # A daemon it started detached, without a console.
        _record(20, 10, "console"),
        # The daemon's worker, in a hidden console of its own.
        _record(30, 20, "console"),
    ]
    assert _MODULE.select_descendants_to_end(records, _consoles(10, 30)) == [10]


def test_sweep_keeps_a_program_with_a_window_and_what_runs_under_it() -> None:
    """A console program that shows a window of its own stays, with its helpers.

    A Tk or Qt app run as ``start python app.py`` is a console image in a
    console of its own that shows a window: it keeps running like a GUI
    program, and so does what it runs. So does the console program it runs
    under, here one judged to have a console of its own, as every program is
    while the pseudoconsole's host is unknown.
    """
    records = [
        # The shell.
        _record(10, 1, "console"),
        # A console image showing a window, in a console of its own.
        _record(20, 10, "console"),
        # A hidden-console helper it runs.
        _record(30, 20, "console"),
        # A hidden-console helper the shell left behind.
        _record(40, 10, "console"),
    ]
    ended = _MODULE.select_descendants_to_end(
        records, _consoles(10, 20, 30, 40), windowed={20}
    )
    assert ended == [40]


def test_sweep_keeps_the_launcher_of_a_program_that_shows_a_window() -> None:
    """``start python app.py`` through a launcher keeps the Tk app running.

    A venv's ``python.exe``, ``py.exe``, the install manager's ``python``
    alias and pip's and uv's entry-point executables are console programs
    that run the real interpreter under them and wait for it, holding it in
    a job that kills it when the launcher ends
    (``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``). The launcher is the first
    program in the new console, so the console window names the launcher;
    the Tk window names the interpreter. Ending the launcher ends the app.
    """
    records = [
        # The shell, attached to the pseudoconsole.
        _record(10, 1, "console"),
        # The launcher, first program in a console window of its own.
        _record(20, 10, "console"),
        # The interpreter it waits for, in the same console, showing a Tk window.
        _record(30, 20, "console"),
    ]
    answers = {10: "attached", 20: "own", 30: "own"}
    windowed = _MODULE.windowed_programs(
        [(20, "ConsoleWindowClass"), (30, "TkTopLevel")]
    )
    ended = _MODULE.select_descendants_to_end(
        records, lambda _pids: answers, windowed=windowed
    )
    assert ended == []


def test_windowed_programs_leave_out_console_windows() -> None:
    """A console window is nobody's own window; a window of any other class counts.

    Windows names the program in a classic console window, not the console
    host, as the window's owner, so ``start cmd`` or a minimized ``ping``
    would pass for a program that shows a window and outlive the session. The
    session's own console window names the shell once a program in the
    terminal shows it. A Tk app run as ``start python app.py`` has a console
    window too and counts through the window of its own, as a console program
    showing a message box does.
    """
    windows = [
        # The session's own console window, shown by a program in the terminal.
        (10, "PseudoConsoleWindow"),
        # ping, in a minimized console window of its own.
        (20, "ConsoleWindowClass"),
        # A Tk app run as ``start python app.py``: its console window and its own.
        (30, "ConsoleWindowClass"),
        (30, "TkTopLevel"),
        # A console program showing a message box.
        (40, "#32770"),
    ]
    assert _MODULE.windowed_programs(windows) == {30, 40}


def test_windowed_programs_count_a_window_whose_class_cannot_be_read() -> None:
    """A window whose class could not be read counts as the program's own.

    Keeping a program that may show a window is the safe failure; ending one
    that does is not.
    """
    assert _MODULE.windowed_programs([(20, None)]) == {20}


def test_sweep_ends_a_console_program_in_a_console_window_of_its_own() -> None:
    """``start cmd`` from the terminal closes with it; a Tk app beside it stays.

    Both run in a console of their own and both are named as the owner of
    their console window. Only the Tk app shows a window of its own, so it
    keeps running with its helper, while the ``cmd`` ends like a hidden one.
    """
    records = [
        # The shell, attached to the pseudoconsole.
        _record(10, 1, "console"),
        # cmd, run as ``start cmd``, in a console window of its own.
        _record(20, 10, "console"),
        # A Tk app run as ``start python app.py``, and a hidden helper it runs.
        _record(30, 10, "console"),
        _record(40, 30, "console"),
    ]
    answers = {10: "attached", 20: "own", 30: "own", 40: "own"}
    windowed = _MODULE.windowed_programs(
        [(20, "ConsoleWindowClass"), (30, "ConsoleWindowClass"), (30, "TkTopLevel")]
    )
    ended = _MODULE.select_descendants_to_end(
        records, lambda _pids: answers, windowed=windowed
    )
    assert ended == [20]


def test_sweep_ends_the_helpers_of_a_shell_whose_console_window_is_shown() -> None:
    """A program that shows the session's console window must not stop the sweep.

    ``GetConsoleWindow`` gives every program in the terminal the
    pseudoconsole's hidden window, and the console host names the shell, its
    first program, as that window's owner; this host sets no owner window for
    it. Once a program shows it (``powershell -WindowStyle Normal`` does), it
    is a visible, unowned top-level window that names the shell. Counted as
    the shell's own window, the shell would shelter every helper under it and
    the session end nothing.
    """
    records = [
        # The shell, attached to the pseudoconsole.
        _record(10, 1, "console"),
        # A hidden-console helper the shell left behind.
        _record(20, 10, "console"),
    ]
    answers = {10: "attached", 20: "own"}
    windowed = _MODULE.windowed_programs([(10, "PseudoConsoleWindow")])
    ended = _MODULE.select_descendants_to_end(
        records, lambda _pids: answers, windowed=windowed
    )
    assert ended == [20]


def test_sweep_keeps_a_program_too_new_to_judge_and_reports_it() -> None:
    """A program that has not connected to a console yet is kept and reported.

    The shell started it a moment ago; a later survey can judge it.
    """
    records = [_record(10, 1, "console"), _record(20, 10, "console")]
    undecided: set[int] = set()
    answers = {10: "attached", 20: "young"}
    ended = _MODULE.select_descendants_to_end(
        records, lambda _pids: answers, undecided=undecided
    )
    assert ended == []
    assert undecided == {20}


def test_sweep_waits_only_for_a_new_program_it_could_end() -> None:
    """A new program that would be kept once judged is not reported.

    An editor started from the shell may start short console helpers all the
    time. The last sweep must not wait for one: it runs under a program that
    keeps running, so it is kept whatever its console turns out to be.
    """
    records = [
        # The shell, attached to the pseudoconsole, and a helper it started.
        _record(10, 1, "console"),
        _record(20, 10, "console"),
        # An editor started from the shell, and a helper it started.
        _record(30, 10, "gui"),
        _record(40, 30, "console"),
        # A daemon started detached, and a worker it started.
        _record(50, 10, "console"),
        _record(60, 50, "console"),
        # A console program that shows a window of its own.
        _record(70, 10, "console"),
    ]
    undecided: set[int] = set()
    answers = {
        10: "attached",
        20: "young",
        40: "young",
        50: "none",
        60: "young",
        70: "young",
    }
    ended = _MODULE.select_descendants_to_end(
        records, lambda _pids: answers, windowed={70}, undecided=undecided
    )
    assert ended == []
    assert undecided == {20}


@pytest.mark.parametrize(
    ("image", "host"),
    [
        ("C:\\Windows\\System32\\conhost.exe", 70),
        ("C:\\WINDOWS\\system32\\CONHOST.EXE", 70),
        ("C:\\Program Files\\WindowsApps\\Terminal\\OpenConsole.exe", 70),
        ("C:/Windows/System32/conhost.exe", 70),
        ("C:\\Windows\\System32\\cmd.exe", 0),
        ("C:\\Python\\python.exe", 0),
        ("C:\\Tools\\notconhost.exe", 0),
        ("C:\\conhost.exe\\python.exe", 0),
        ("", 0),
        (None, 0),
    ],
)
def test_verified_console_host_takes_only_a_console_host(
    image: str | None, host: int
) -> None:
    """The pseudoconsole's host counts only when its image is a console host.

    Anything else, or an image that cannot be read, leaves the host unknown,
    so that no program attached to the pseudoconsole is swept before the
    drain.
    """
    assert _MODULE.verified_console_host(70, image) == host


def _pe_header(magic: int, subsystem: int, signature_offset: int = 0x80) -> bytes:
    """Build the start of a PE image with the given optional-header fields."""
    header = bytearray(signature_offset + 24 + 70)
    header[:2] = b"MZ"
    struct.pack_into("<I", header, 0x3C, signature_offset)
    header[signature_offset : signature_offset + 4] = b"PE\0\0"
    struct.pack_into("<H", header, signature_offset + 24, magic)
    struct.pack_into("<H", header, signature_offset + 24 + 68, subsystem)
    return bytes(header)


@pytest.mark.parametrize(
    ("magic", "subsystem", "expected"),
    (
        (0x10B, 2, "gui"),
        (0x10B, 3, "console"),
        (0x20B, 2, "gui"),
        (0x20B, 3, "console"),
        (0x20B, 9, "unknown"),
        (0x107, 2, "unknown"),
    ),
)
def test_image_subsystem_reads_pe32_and_pe32_plus_headers(
    magic: int, subsystem: int, expected: str
) -> None:
    """``Subsystem`` is read at the same offset for both optional-header kinds."""
    assert _MODULE.image_subsystem(_pe_header(magic, subsystem)) == expected
    assert _MODULE.image_subsystem(_pe_header(magic, subsystem, 0x100)) == expected


def test_image_subsystem_rejects_images_it_cannot_read() -> None:
    """Anything that is not a whole PE header is unknown, never a console image."""
    assert _MODULE.image_subsystem(b"") == "unknown"
    assert _MODULE.image_subsystem(b"#!/bin/sh\n" + bytes(0x100)) == "unknown"
    assert _MODULE.image_subsystem(_pe_header(0x10B, 3)[:0x90]) == "unknown"
    wrong_signature = bytearray(_pe_header(0x10B, 3))
    wrong_signature[0x80:0x84] = b"PX\0\0"
    assert _MODULE.image_subsystem(bytes(wrong_signature)) == "unknown"
    far_signature = bytearray(_pe_header(0x10B, 3))
    struct.pack_into("<I", far_signature, 0x3C, 1 << 24)
    assert _MODULE.image_subsystem(bytes(far_signature)) == "unknown"


def test_image_subsystem_needs_the_whole_subsystem_field() -> None:
    """A header ending right after ``Subsystem`` is read; one byte less is unknown."""
    for magic in (0x10B, 0x20B):
        header = _pe_header(magic, 3)
        assert len(header) == 0x80 + 24 + 70
        assert _MODULE.image_subsystem(header) == "console"
        assert _MODULE.image_subsystem(header[:-1]) == "unknown"


def test_read_image_header_reads_through_the_subsystem_field(tmp_path: Path) -> None:
    """The reader stops after ``Subsystem`` and goes through the native path."""
    image = tmp_path / "program.exe"
    image.write_bytes(_pe_header(0x20B, 3, 0x100) + bytes(4096))
    native_calls: list[str] = []

    def native(path: str) -> str:
        """Record the path asked for and answer with the image file."""
        native_calls.append(path)
        return str(image)

    header = _MODULE.read_image_header(r"C:\Windows\System32\program.exe", native)
    assert native_calls == [r"C:\Windows\System32\program.exe"]
    assert len(header) == 0x100 + 24 + 70
    assert _MODULE.image_subsystem(header) == "console"
    assert _MODULE.read_image_header(str(tmp_path / "missing.exe"), native=str) == b""
    short = tmp_path / "short.exe"
    short.write_bytes(b"MZ")
    assert _MODULE.image_subsystem(_MODULE.read_image_header(str(short), str)) == (
        "unknown"
    )


def test_job_process_ids_grows_the_buffer_until_the_list_is_complete() -> None:
    """A list cut short by the buffer is read again with room for every PID."""
    capacities: list[int] = []
    pids = [11, 12, 13, 14, 15]

    def query(capacity: int) -> tuple[int, Sequence[int]]:
        """Report five processes and list as many as fit."""
        capacities.append(capacity)
        return len(pids), pids[:capacity]

    assert _MODULE.job_process_ids(query, capacity=2) == pids
    assert capacities[0] == 2
    assert len(capacities) == 2
    assert capacities[1] >= len(pids)


def test_job_process_ids_accepts_a_list_that_keeps_growing() -> None:
    """Processes arriving faster than the list is read end the retries."""

    def query(capacity: int) -> tuple[int, Sequence[int]]:
        """Always report one process more than the buffer holds."""
        return capacity + 1, list(range(capacity))

    listed = _MODULE.job_process_ids(query, capacity=1, attempts=4)
    assert listed == list(range(8))


def test_wait_each_waits_on_every_handle_within_one_deadline() -> None:
    """More handles than ``WaitForMultipleObjects`` takes share one deadline."""
    waited: list[tuple[int, int]] = []
    now = [0.0]

    def exited(handle: int, milliseconds: int) -> bool:
        """Record the wait; even handles exit, odd ones run on."""
        waited.append((handle, milliseconds))
        now[0] += 0.4
        return handle % 2 == 0

    handles = list(range(1, 66))
    running = _MODULE.wait_each(handles, 1.0, exited, clock=lambda: now[0])
    assert [handle for handle, _ in waited] == handles
    assert running == [handle for handle in handles if handle % 2 == 1]
    assert [milliseconds for _, milliseconds in waited[:4]] == [1000, 600, 200, 0]
    assert all(milliseconds == 0 for _, milliseconds in waited[3:])


def test_sweep_descendants_repeats_while_a_round_ended_something() -> None:
    """A program respawned during the first round is caught by the next."""
    rounds = [[20], [21], []]
    ended: list[list[int]] = []

    def end(pids: Sequence[int], _deadline: float) -> Sequence[int]:
        """Record the round and report that everything ended."""
        ended.append(list(pids))
        return []

    left = _MODULE.sweep_descendants(
        lambda: rounds.pop(0), end, clock=lambda: 0.0, deadline=10.0, rounds=3
    )
    assert left == []
    assert ended == [[20], [21]]
    assert rounds == []


def test_sweep_descendants_stops_at_the_deadline_and_the_round_limit() -> None:
    """A supervisor that respawns forever is cut off by time or by rounds."""
    now = [0.0]
    surveys = [0]

    def survey() -> Sequence[int]:
        """Always find the respawned program."""
        surveys[0] += 1
        return [7]

    def end(_pids: Sequence[int], _deadline: float) -> Sequence[int]:
        """Take 0.6 s to end it."""
        now[0] += 0.6
        return []

    assert _MODULE.sweep_descendants(survey, end, lambda: now[0], 1.5, rounds=10) == []
    assert surveys[0] == 3
    surveys[0] = 0
    now[0] = 0.0
    assert _MODULE.sweep_descendants(survey, end, lambda: now[0], 10.0, rounds=2) == []
    assert surveys[0] == 2


def test_sweep_descendants_reports_what_refused_to_end() -> None:
    """A process still running at the deadline ends the sweep and is reported."""
    surveys = [0]

    def survey() -> Sequence[int]:
        """Find two programs."""
        surveys[0] += 1
        return [7, 8]

    left = _MODULE.sweep_descendants(
        survey, lambda _pids, _deadline: [8], lambda: 0.0, 10.0, rounds=3
    )
    assert left == [8]
    assert surveys[0] == 1


def test_sweep_descendants_waits_for_a_process_too_new_to_judge() -> None:
    """A survey that could not judge a new process yet is repeated until it can.

    A program the shell started just before the session ended has not yet
    connected to its console; the sweep must not end before it is judged.
    """
    now = [0.0]
    surveys = [0]
    young: set[int] = set()
    ended: list[list[int]] = []
    slept: list[float] = []

    def survey() -> Sequence[int]:
        """Leave process 30 undecided twice, then select it once."""
        surveys[0] += 1
        young.clear()
        if surveys[0] < 3:
            young.add(30)
            return []
        return [30] if surveys[0] == 3 else []

    def end(pids: Sequence[int], _deadline: float) -> Sequence[int]:
        """Record the round and report that everything ended."""
        ended.append(list(pids))
        return []

    def sleep(seconds: float) -> None:
        """Let the time pass at once."""
        slept.append(seconds)
        now[0] += seconds

    left = _MODULE.sweep_descendants(
        survey,
        end,
        lambda: now[0],
        1.0,
        undecided=lambda: bool(young),
        sleep=sleep,
    )
    assert left == []
    assert ended == [[30]]
    assert surveys[0] == 4
    assert slept == [_MODULE._SWEEP_RETRY] * 2


def test_sweep_descendants_keeps_a_process_too_new_to_judge_at_the_deadline() -> None:
    """A process that never becomes judgeable holds the sweep until the deadline."""
    now = [0.0]
    surveys = [0]
    slept: list[float] = []

    def survey() -> Sequence[int]:
        """Never select anything."""
        surveys[0] += 1
        return []

    def end(pids: Sequence[int], _deadline: float) -> Sequence[int]:
        """Fail: nothing was selected."""
        raise AssertionError(pids)

    def sleep(seconds: float) -> None:
        """Let the time pass at once."""
        slept.append(seconds)
        now[0] += seconds

    left = _MODULE.sweep_descendants(
        survey,
        end,
        lambda: now[0],
        0.125,
        undecided=lambda: True,
        sleep=sleep,
    )
    assert left == []
    assert surveys[0] == 3
    assert slept == pytest.approx([0.05, 0.05, 0.025])
    assert now[0] == pytest.approx(0.125)


# ---------------------------------------------------------------------------
# Session-end sweep: the desktop survey, through stand-in user32 functions
# ---------------------------------------------------------------------------


class _Library:
    """Stand in for one ``ctypes.WinDLL``; note how it was loaded."""

    def __init__(
        self, loads: list[tuple[str, Mapping[str, Any]]], name: str, **options: Any
    ) -> None:
        """Note the library's name and load options in ``loads``."""
        loads.append((name, options))
        self._functions: dict[str, Mock] = {}

    def __getattr__(self, name: str) -> Mock:
        """Return one stand-in export per name."""
        if name.startswith("__"):
            raise AttributeError(name)
        return self._functions.setdefault(name, Mock(name=name))


class _WindowsModule(NamedTuple):
    """The module loaded as on Windows, and the libraries it loaded."""

    module: ModuleType
    loads: list[tuple[str, Mapping[str, Any]]]


@pytest.fixture
def windows_module(monkeypatch: pytest.MonkeyPatch) -> _WindowsModule:
    """Load the module's Windows-only part with stand-in Win32 libraries.

    The desktop survey (``_windowed_process_ids`` and ``_window_class``) lives
    in that part. With every library export a ``Mock`` and the stdcall
    callback type the plain one, its filters, its class read and their
    failures run on any platform; only the real bindings need Windows.
    """
    loads: list[tuple[str, Mapping[str, Any]]] = []
    with monkeypatch.context() as patch:
        patch.setitem(sys.modules, "msvcrt", ModuleType("msvcrt"))
        patch.setattr(
            ctypes,
            "WinDLL",
            lambda name, **options: _Library(loads, name, **options),
            raising=False,
        )
        patch.setattr(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE, raising=False)
        patch.setattr(sys, "platform", "win32")
        module = _load_module()
    return _WindowsModule(module, loads)


class _Window(NamedTuple):
    """One top-level window on the stand-in desktop.

    ``window_class`` is ``None`` when ``GetClassNameW`` fails for the window.
    ``gone_after`` names the call after which the window no longer exists.
    """

    handle: int
    pid: int
    window_class: str | None
    visible: bool = True
    owner: int = 0
    gone_after: str = ""


class _Desktop:
    """The ``user32`` functions the desktop survey calls, over fixed windows."""

    def __init__(
        self, module: ModuleType, windows: Sequence[_Window], fail_at: int | None = None
    ) -> None:
        """Hold ``windows`` in Z order; ``EnumWindows`` fails at index ``fail_at``."""
        self.module = module
        self.windows = {window.handle: window for window in windows}
        self.order = [window.handle for window in windows]
        self.fail_at = fail_at
        self.gone: set[int] = set()
        self.class_buffers: list[int] = []
        self.diagnostics: list[str] = []

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Put the stand-ins in place of the module's bindings."""
        module = self.module
        monkeypatch.setattr(module, "_EnumWindows", self.enum_windows)
        monkeypatch.setattr(module, "_IsWindowVisible", self.is_window_visible)
        monkeypatch.setattr(module, "_GetWindow", self.get_window)
        monkeypatch.setattr(
            module, "_GetWindowThreadProcessId", self.get_window_thread_process_id
        )
        monkeypatch.setattr(module, "_GetClassNameW", self.get_class_name)
        monkeypatch.setattr(module, "diagnose", self.diagnostics.append)
        monkeypatch.setattr(module, "_last_error", lambda: OSError(8, "out of memory"))

    def _live(self, handle: int) -> _Window | None:
        """Return the window behind ``handle`` while it exists."""
        return None if handle in self.gone else self.windows.get(handle)

    def _after(self, window: _Window, call: str) -> None:
        """Destroy ``window`` once ``call`` returned, when it is set to go then."""
        if window.gone_after == call:
            self.gone.add(window.handle)

    def enum_windows(self, visit: Callable[[int, int], int], parameter: int) -> int:
        """Call ``visit`` per window; fail when ``fail_at`` is reached."""
        for index, handle in enumerate(self.order):
            if index == self.fail_at:
                return 0
            if not visit(handle, parameter):
                return 0
        return 1

    def is_window_visible(self, handle: int) -> int:
        """Report the visible style; a destroyed window is not visible."""
        window = self._live(handle)
        if window is None:
            return 0
        self._after(window, "visible")
        return int(window.visible)

    def get_window(self, handle: int, relationship: int) -> int | None:
        """Return the owner; a destroyed window has none (``NULL``, the error)."""
        assert relationship == self.module._GW_OWNER, relationship
        window = self._live(handle)
        return None if window is None or not window.owner else window.owner

    def get_window_thread_process_id(self, handle: int, pid: Any) -> int:
        """Store the owner PID through ``pid`` and return a thread, 0 when gone."""
        window = self._live(handle)
        if window is None:
            return 0
        pid._obj.value = window.pid
        self._after(window, "owner")
        return 1000 + window.pid

    def get_class_name(self, handle: int, name: Any, characters: int) -> int:
        """Copy the class as ``GetClassNameW`` does: truncated, terminated, or 0."""
        self.class_buffers.append(characters)
        assert characters == len(name)
        window = self._live(handle)
        if window is None or window.window_class is None:
            return 0
        copied = window.window_class[: characters - 1]
        name.value = copied
        return len(copied)


def _survey(
    windows_module: _WindowsModule,
    monkeypatch: pytest.MonkeyPatch,
    windows: Sequence[_Window],
    fail_at: int | None = None,
) -> tuple[set[int], _Desktop]:
    """Run the desktop survey over a stand-in desktop; return it and the desktop."""
    desktop = _Desktop(windows_module.module, windows, fail_at)
    desktop.install(monkeypatch)
    return windows_module.module._windowed_process_ids(), desktop


def test_desktop_survey_counts_visible_unowned_windows_of_any_class_but_a_console_s(
    windows_module: _WindowsModule, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The visible, unowned window of a program in a console window keeps it.

    A console window alone, a dialog owned by another window and a hidden
    window keep nobody.
    """
    result, _desktop = _survey(
        windows_module,
        monkeypatch,
        [
            _Window(0x10, 20, "ConsoleWindowClass"),
            _Window(0x11, 30, "ConsoleWindowClass"),
            _Window(0x12, 30, "TkTopLevel"),
            _Window(0x13, 40, "ConsoleWindowClass"),
            _Window(0x14, 40, "#32770", owner=0x13),
            _Window(0x15, 50, "Chrome_WidgetWin_1", visible=False),
        ],
    )
    assert result == {30}


def test_desktop_survey_names_windows_terminal_for_its_window_only(
    windows_module: _WindowsModule, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Windows Terminal's window names Windows Terminal, which no session tracks.

    The pseudoconsole window it gives a console it hosts is owned by that
    window, so it is not listed at all.
    """
    result, _desktop = _survey(
        windows_module,
        monkeypatch,
        [
            _Window(0x10, 900, "CASCADIA_HOSTING_WINDOW_CLASS"),
            _Window(0x11, 20, "PseudoConsoleWindow", owner=0x10),
        ],
    )
    assert result == {900}


def test_desktop_survey_leaves_out_a_shown_pseudoconsole_window(
    windows_module: _WindowsModule, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The session's own console window, once a program shows it, keeps nobody.

    This host gives the pseudoconsole no owner window, so ``ShowWindow`` on
    ``GetConsoleWindow()`` makes it a visible, unowned top-level window that
    names the shell.
    """
    result, _desktop = _survey(
        windows_module, monkeypatch, [_Window(0x10, 10, "PseudoConsoleWindow")]
    )
    assert result == set()


def test_desktop_survey_counts_a_window_whose_class_cannot_be_read(
    windows_module: _WindowsModule, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``GetClassNameW`` returning 0 keeps the owner: the safe failure."""
    result, _desktop = _survey(windows_module, monkeypatch, [_Window(0x10, 60, None)])
    assert result == {60}


def test_desktop_survey_holds_the_longest_class_name(
    windows_module: _WindowsModule, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The class buffer holds 256 characters and the terminator; a cut class counts."""
    result, desktop = _survey(
        windows_module,
        monkeypatch,
        [_Window(0x10, 70, "X" * 300), _Window(0x11, 71, "C" * 256)],
    )
    assert result == {70, 71}
    assert desktop.class_buffers == [257, 257]


def test_desktop_survey_skips_a_window_that_closes_while_it_runs(
    windows_module: _WindowsModule, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A window gone before its owner is read is skipped; gone after, it counts.

    The program of a console window that closes between the two reads stays
    for this round only, which is the safe side.
    """
    result, _desktop = _survey(
        windows_module,
        monkeypatch,
        [
            _Window(0x10, 80, "TkTopLevel", gone_after="visible"),
            _Window(0x11, 81, "ConsoleWindowClass", gone_after="owner"),
        ],
    )
    assert result == {81}


def test_desktop_survey_keeps_what_a_failed_enumeration_listed(
    windows_module: _WindowsModule, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``EnumWindows`` failing midway gives the owners read so far and a diagnostic."""
    result, desktop = _survey(
        windows_module,
        monkeypatch,
        [
            _Window(0x10, 90, "ConsoleWindowClass"),
            _Window(0x11, 91, "TkTopLevel"),
            _Window(0x12, 90, "TkTopLevel"),
        ],
        fail_at=2,
    )
    assert result == {91}
    assert desktop.diagnostics == [
        "could not list the windows on the desktop: [Errno 8] out of memory"
    ]


def test_user32_is_loaded_with_its_last_error_kept(
    windows_module: _WindowsModule,
) -> None:
    """``user32`` is loaded so ``_last_error`` reads what ``EnumWindows`` set.

    ``ctypes.get_last_error`` sees only calls through a library loaded with
    ``use_last_error``; otherwise the diagnostic names a stale error.
    """
    options = dict(windows_module.loads)
    assert options["kernel32"].get("use_last_error") is True
    assert options["user32"].get("use_last_error") is True


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_window_class_reads_the_desktop_window_s_class() -> None:
    """The real ``GetClassNameW`` binding names the desktop window's class.

    The desktop window is always there and its class is fixed, so this pins
    the binding whatever the default terminal is. No window reads as ``None``.
    """
    user32 = ctypes.WinDLL("user32")  # ty: ignore[possibly-missing-attribute]
    user32.GetDesktopWindow.restype = ctypes.c_void_p
    assert _MODULE._window_class(user32.GetDesktopWindow()) == "#32769"
    assert _MODULE._window_class(0) is None


# ---------------------------------------------------------------------------
# Session end: the tracking jobs let go, through stand-in Win32 libraries
# ---------------------------------------------------------------------------


"""Stand-in handles of the root tracking job and the job below it."""
_TRACKING_JOB, _BREAKAWAY_JOB = 11, 12


def test_sweep_lets_what_the_session_kept_break_away_before_release(
    windows_module: _WindowsModule, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A finished sweep restores breakaway without waiting for handle release."""
    module = windows_module.module
    events: list[tuple[str, object]] = []
    monkeypatch.setattr(module, "_sweep_descendants", Mock())
    monkeypatch.setattr(
        module, "_permit_breakaway", lambda jobs: events.append(("permit", tuple(jobs)))
    )
    monkeypatch.setattr(
        module, "_close", lambda handle: events.append(("close", handle))
    )
    monkeypatch.setattr(module, "diagnose", Mock())
    host = module._ConPtyHost(module.HostArguments(80, 24, "pipe", ("cmd",)), "token")
    host._tracking_job, host._breakaway_job = _TRACKING_JOB, _BREAKAWAY_JOB
    drained = threading.Event()
    drained.set()

    host._sweep_after_drain(drained, time.monotonic())

    assert events == [("permit", (_TRACKING_JOB, _BREAKAWAY_JOB))]


@pytest.mark.parametrize(
    "end", ("sweep-finished", "start-failed", "sweep-outlived-join")
)
def test_every_session_end_lets_what_the_session_kept_break_away(
    windows_module: _WindowsModule, monkeypatch: pytest.MonkeyPatch, end: str
) -> None:
    """The tracking jobs permit a breakaway again before the host lets go of them.

    The root tracking job refuses a breakaway while the session runs, and the
    jobs outlive their handles for as long as a program in them runs. So the
    refusal is lifted before the jobs are closed or left to the host's
    exit, however the session ends: after a sweep that finished, after a
    start that failed once the shell ran (no sweep runs then), and after a
    sweep that outlived ``_finish``'s join, which the host's exit abandons.
    Otherwise what the session kept could never break away again, where
    3.29.0 put it in no job.
    """
    module = windows_module.module
    events: list[tuple[str, object]] = []
    monkeypatch.setattr(
        module, "_permit_breakaway", lambda jobs: events.append(("permit", tuple(jobs)))
    )
    monkeypatch.setattr(
        module, "_close", lambda handle: events.append(("close", handle))
    )
    monkeypatch.setattr(module, "diagnose", lambda _message: None)
    stuck = threading.Event()

    def sweep_descendants(*_args: object, **_kwargs: object) -> None:
        """End nothing; hang past the join when the sweep is to outlive it."""
        if end == "sweep-outlived-join":
            stuck.wait(5.0)

    monkeypatch.setattr(module, "_sweep_descendants", sweep_descendants)
    if end == "sweep-outlived-join":
        monkeypatch.setattr(module, "_SWEEP_DEADLINE", 0.05)
        monkeypatch.setattr(module, "_SWEEP_JOIN_MARGIN", 0.05)
    host = module._ConPtyHost(module.HostArguments(80, 24, "pipe", ("cmd",)), "token")
    host._tracking_job, host._breakaway_job = _TRACKING_JOB, _BREAKAWAY_JOB
    try:
        if end == "start-failed":

            def start() -> None:
                """Fail as the ``ready`` write does once Obsidian's window has gone."""
                raise OSError("the control channel is unavailable")

            monkeypatch.setattr(host, "_start", start)
            assert host._run_session() == module._EXIT_HOST_ERROR
        else:
            host._finish()
        sweep = host._sweep_thread
        abandoned = sweep is not None and sweep.is_alive()
        assert abandoned == (end == "sweep-outlived-join"), events
        jobs = (_TRACKING_JOB, _BREAKAWAY_JOB)
        # An abandoned sweep may still use the jobs: they close with the host.
        closed = [] if abandoned else [("close", job) for job in jobs]
        permit = ("permit", jobs)
        assert permit in events, events
        assert [event for event in events if event[1] in jobs] == closed, events
        for event in closed:
            assert events.index(permit) < events.index(event), events
    finally:
        stuck.set()
        if host._sweep_thread is not None:
            host._sweep_thread.join(5.0)


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

    def handle(self, pid: int) -> int:
        """Return the open handle of a pinned process."""
        return self._handles[pid]

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


class _ExitTimes:
    """Note when pinned processes exit, from one waiting thread per process."""

    def __init__(self) -> None:
        """Start with nothing watched."""
        self._times: dict[int, float] = {}
        self._threads: list[threading.Thread] = []

    def watch(self, pid: int, handle: int, timeout: float) -> None:
        """Wait on ``handle`` in the background and note when ``pid`` exits."""
        wait = _kernel32().WaitForSingleObject
        wait.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        wait.restype = ctypes.c_uint32

        def run() -> None:
            """Note the time once the process handle is signalled."""
            if wait(handle, int(timeout * 1000)) == 0:
                self._times[pid] = time.monotonic()

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self._threads.append(thread)

    def of(self, pid: int) -> float | None:
        """Return when ``pid`` exited, once every watcher is done; ``None`` if not."""
        for thread in self._threads:
            thread.join()
        return self._times.get(pid)


def _read_when_published(path: Path, timeout: float) -> str:
    """Poll for a file another process publishes atomically; return its text.

    A ``timeout`` below zero, the rest of a budget already spent, counts as 0.
    """
    timeout = max(0.0, timeout)
    deadline = time.monotonic() + timeout
    while not path.exists():
        if time.monotonic() >= deadline:
            raise AssertionError(f"{path} was not published within {timeout:.0f}s")
        time.sleep(0.05)
    return path.read_text(encoding="utf-8")


def test_a_wait_with_no_time_left_reports_zero_seconds(tmp_path: Path) -> None:
    """A file awaited after its budget ran out is reported within 0s, not -0s.

    Files read in turn share one deadline, so the last of them can be given
    what is left of it, which is below zero once an earlier file came late.
    """
    with pytest.raises(AssertionError, match=r"was not published within 0s$"):
        _read_when_published(tmp_path / "program.json", -0.3)


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
        except Exception as error:  # noqa: BLE001 -- the test raises it later
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


def test_a_probe_error_of_any_type_is_kept_for_the_test() -> None:
    """A probe that fails with an error other than an assertion is kept too.

    An error that escaped would end the server thread before its replies,
    and the run would end as a host timeout that does not name the cause.
    """
    server = _ControlServer.__new__(_ControlServer)
    server.probe_error = None

    def probe(message: Mapping[str, Any]) -> None:
        """Parse a record that is not JSON."""
        json.loads(message["record"])

    server._probe(probe, {"record": ""})
    assert isinstance(server.probe_error, json.JSONDecodeError)


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
    creationflags: int = 0,
) -> _HostResult:
    """Run the ConPTY host once against a real control pipe and child.

    ``deferred`` boots the host with ``--defer-session``, plus
    ``--console-host`` with ``console_host_ahead`` when given, and delivers
    the command, size, ``child_environment``, ``child_cwd``, and
    ``console_host`` in a ``start`` op, followed by ``start_fields``; an
    immediate host inherits ``child_environment`` and receives ``child_cwd``
    and ``console_host`` as its ``--cwd`` and ``--console-host`` arguments.
    ``host_script`` runs in place of the host module, with the same arguments.
    ``creationflags`` are the host process's own creation flags.
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
            creationflags=creationflags,
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
            if server.probe_error is not None:
                # A probe that failed before it released the shell is the
                # cause of the timeout; report the cause.
                raise server.probe_error from timeout_error
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


"""Kinds of descendant ``_spawn_breakaway_descendants`` publishes, in order."""
_DESCENDANT_KINDS = (
    "newConsole",
    "noWindow",
    "gui",
    "guiChild",
    "guiOrphan",
    "breakaway",
    "grandBreakaway",
    "detached",
)

"""The kinds a session end leaves running, in ``_DESCENDANT_KINDS`` order."""
_DESCENDANTS_KEPT = ("gui", "guiChild", "detached")


def _spawn_breakaway_descendants(ready_file: Path, exit_gate: Path) -> list[str]:
    """Start one descendant of each kind outside the pseudoconsole; gate exit.

    ``newConsole`` and ``noWindow`` are console programs left in a hidden
    console by a launcher that has exited: the ``Start-Process -WindowStyle
    Hidden`` shape and the console a Node helper gets. ``gui`` is a program of
    the GUI subsystem, ``guiChild`` a console program it runs itself, and
    ``guiOrphan`` one it ran through a launcher that has exited. ``breakaway``
    is a console program the shell created with ``CREATE_BREAKAWAY_FROM_JOB``
    and ``grandBreakaway`` one that a launcher of the shell created that way:
    that creation must not be refused. ``detached`` is a console program with
    no console at all. The shell publishes the PIDs, or an ``error``, then
    waits for ``exit_gate`` and exits 42.
    """
    sleeper = "import time; time.sleep(120)"

    def launcher(flags: str) -> str:
        """Return code that starts a sleeper with ``flags``, prints its PID, exits."""
        return (
            "import subprocess, sys\n"
            "child = subprocess.Popen(\n"
            f"    [sys.executable, '-c', {sleeper!r}],\n"
            "    stdin=subprocess.DEVNULL,\n"
            "    stdout=subprocess.DEVNULL,\n"
            "    stderr=subprocess.DEVNULL,\n"
            f"    creationflags={flags},\n"
            ")\n"
            "print(child.pid)\n"
        )

    gui_code = (
        "import json, os, subprocess, sys, time\n"
        "child = subprocess.Popen(\n"
        f"    [sys.argv[1], '-c', {sleeper!r}],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        "    creationflags=subprocess.CREATE_NO_WINDOW,\n"
        ")\n"
        "done = subprocess.run(\n"
        f"    [sys.argv[1], '-c', {launcher('0')!r}],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    capture_output=True,\n"
        "    check=True,\n"
        "    creationflags=subprocess.CREATE_NO_WINDOW,\n"
        ")\n"
        "record = {'pid': os.getpid(), 'child': child.pid, 'orphan': int(done.stdout)}\n"
        "with open(sys.argv[2] + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump(record, stream)\n"
        "os.replace(sys.argv[2] + '.tmp', sys.argv[2])\n"
        "time.sleep(120)\n"
    )
    gui_file = str(ready_file) + ".gui"
    breakaway_flags = (
        "subprocess.CREATE_BREAKAWAY_FROM_JOB | subprocess.CREATE_NO_WINDOW"
    )
    code = (
        "import json, os, subprocess, sys, time\n"
        f"sleeper = {sleeper!r}\n"
        f"launcher = {launcher('0')!r}\n"
        f"breakaway_launcher = {launcher(breakaway_flags)!r}\n"
        f"gui_code = {gui_code!r}\n"
        "def hidden():\n"
        "    info = subprocess.STARTUPINFO()\n"
        "    info.dwFlags = subprocess.STARTF_USESHOWWINDOW\n"
        "    info.wShowWindow = subprocess.SW_HIDE\n"
        "    return info\n"
        "def quiet(command, **kwargs):\n"
        "    return subprocess.Popen(\n"
        "        command,\n"
        "        stdin=subprocess.DEVNULL,\n"
        "        stdout=subprocess.DEVNULL,\n"
        "        stderr=subprocess.DEVNULL,\n"
        "        **kwargs,\n"
        "    )\n"
        "def launch(flags, code=launcher):\n"
        "    done = subprocess.run(\n"
        "        [sys.executable, '-c', code],\n"
        "        stdin=subprocess.DEVNULL,\n"
        "        capture_output=True,\n"
        "        creationflags=flags,\n"
        "        startupinfo=hidden(),\n"
        "    )\n"
        "    if done.returncode != 0:\n"
        "        raise RuntimeError(done.stderr.decode('utf-8', 'replace'))\n"
        "    return int(done.stdout)\n"
        "def start():\n"
        "    pythonw = os.path.join(os.path.dirname(sys.executable), 'pythonw.exe')\n"
        "    if not os.path.isfile(pythonw):\n"
        "        raise FileNotFoundError(pythonw)\n"
        "    record = {'pid': os.getpid()}\n"
        "    record['newConsole'] = launch(subprocess.CREATE_NEW_CONSOLE)\n"
        "    record['noWindow'] = launch(subprocess.CREATE_NO_WINDOW)\n"
        f"    gui = quiet([pythonw, '-c', gui_code, sys.executable, {gui_file!r}])\n"
        "    deadline = time.monotonic() + 30\n"
        f"    while not os.path.exists({gui_file!r}):\n"
        "        if time.monotonic() >= deadline:\n"
        "            raise TimeoutError('the GUI program did not start')\n"
        "        time.sleep(0.05)\n"
        f"    with open({gui_file!r}, encoding='utf-8') as stream:\n"
        "        published = json.load(stream)\n"
        "    record['gui'] = gui.pid\n"
        "    record['guiChild'] = published['child']\n"
        "    record['guiOrphan'] = published['orphan']\n"
        f"    record['breakaway'] = quiet([sys.executable, '-c', sleeper], "
        f"creationflags={breakaway_flags}).pid\n"
        "    try:\n"
        "        record['grandBreakaway'] = launch(\n"
        "            subprocess.CREATE_NO_WINDOW, breakaway_launcher\n"
        "        )\n"
        "    except RuntimeError as error:\n"
        "        # Reported, not fatal: the other kinds still tell their story.\n"
        "        record['grandBreakawayRefused'] = str(error).strip().splitlines()[-1]\n"
        "    record['detached'] = quiet(\n"
        "        [sys.executable, '-c', sleeper],\n"
        "        creationflags=subprocess.DETACHED_PROCESS,\n"
        "    ).pid\n"
        "    return record\n"
        "try:\n"
        "    record = start()\n"
        "except Exception as error:\n"
        "    record = {'error': repr(error)}\n"
        f"path = {str(ready_file)!r}\n"
        "with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump(record, stream)\n"
        "os.replace(path + '.tmp', path)\n"
        "if 'error' in record:\n"
        "    sys.exit(2)\n"
        "deadline = time.monotonic() + 120\n"
        f"while not os.path.exists({str(exit_gate)!r}):\n"
        "    assert time.monotonic() < deadline, 'shell exit gate was not released'\n"
        "    time.sleep(0.05)\n"
        "sys.exit(42)\n"
    )
    # As in ``_spawn_grandchild``: the base interpreter is the shell the host
    # reports, and ``pythonw.exe`` is installed beside it.
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
@pytest.mark.parametrize(
    "console_host", (None, "auto"), ids=("built-in", "windows-terminal")
)
def test_a_cold_host_whose_window_went_before_it_connected_ends_its_shell(
    tmp_path: Path, console_host: str | None
) -> None:
    """A tab's host still booting when Obsidian's window goes ends by itself.

    The plugin spawns the host detached, so the window's exit no longer ends
    it. With nobody on the control pipe, the host gives up after
    ``_CONTROL_CONNECT`` and closes the job: the shell, created suspended,
    ends without having run, and the console host ends with it.
    """
    if console_host is not None:
        _installed_windows_terminal()
    marker = tmp_path / "shell-ran"
    environment = dict(os.environ)
    environment[_MODULE.TOKEN_ENVIRONMENT_VARIABLE] = uuid.uuid4().hex
    # The base interpreter, as the plugin spawns it: a venv redirector would
    # stand between this test and the host's own children.
    arguments = [
        getattr(sys, "_base_executable", sys.executable),
        str(_module_path()),
        "80",
        "24",
        # Nobody listens on this pipe: the window that made it has gone.
        "\\\\.\\pipe\\obsidian-terminal-conpty-test-" + uuid.uuid4().hex,
    ]
    if console_host is not None:
        arguments.extend(["--console-host", console_host])
    arguments.extend(["--", *_create_marker(marker)])
    earlier = set(_MODULE._parent_process_ids())
    children: set[int] = set()
    with closing(_ProcessWatch()) as watch:
        host = subprocess.Popen(
            arguments,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            # Node's ``detached`` spawn: no console, a new process group.
            creationflags=_DETACHED_PROCESS | _CREATE_NEW_PROCESS_GROUP,
        )
        deadline = time.monotonic() + _MODULE._CONTROL_CONNECT + 10.0
        try:
            # The console host and the shell wait while the host retries.
            while len(children) < 2 and host.poll() is None:
                assert time.monotonic() < deadline, children
                time.sleep(0.05)
                children = {
                    pid
                    for pid, parent in _MODULE._parent_process_ids().items()
                    if parent == host.pid and pid not in earlier
                }
            for pid in children:
                watch.pin(pid)
            _, errors = host.communicate(timeout=deadline - time.monotonic())
        finally:
            if host.poll() is None:
                host.kill()
                host.wait(10.0)
        assert len(children) == 2, (children, errors)
        assert watch.survivors(15.0) == []
    assert host.returncode == 250, errors
    assert b"control pipe unavailable" in errors, errors
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
@pytest.mark.parametrize("detached", (False, True), ids=("attached", "detached"))
def test_ctrl_c_byte_reaches_the_child(detached: bool) -> None:
    """A ``0x03`` byte on stdin must interrupt the child, not just close stdin.

    The byte is sent only once the child has attached to the console: a
    Ctrl+C that conhost translates before then has no process to signal.
    ``detached`` starts the host as Node's ``detached`` spawn does, with no
    console and in a new process group, which starts with Ctrl+C ignored.
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
        creationflags=_DETACHED_PROCESS | _CREATE_NEW_PROCESS_GROUP if detached else 0,
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
@pytest.mark.parametrize("shutdown", ("natural-exit", "kill", "host-death"))
@pytest.mark.parametrize("deferred", (False, True), ids=("immediate", "deferred"))
def test_session_end_ends_hidden_console_programs_and_keeps_gui_programs(
    tmp_path: Path, shutdown: str, deferred: bool
) -> None:
    """Console programs that run in a console of their own end with the session.

    That holds for the ones a launcher left behind, for one that asked to
    break away from the job, and for one under a GUI program whose launcher
    has exited. A GUI program, the console program it runs itself, and a
    console program with no console at all keep running. A host that is
    killed cannot act, so everything it tracked survives that, as before. A
    launcher of the shell is still allowed to ask for a breakaway.
    """
    ready_file = tmp_path / "descendants.json"
    exit_gate = tmp_path / "shell-exit"
    records: list[dict[str, int]] = []
    refusals: list[object] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_shutdown(ready: Mapping[str, object]) -> None:
            """Pin the shell and every descendant before the shutdown starts."""
            assert isinstance(ready["childPid"], int)
            watch.pin(ready["childPid"])
            published: object = json.loads(_read_when_published(ready_file, 45.0))
            assert isinstance(published, dict), published
            assert "error" not in published, published
            refusals.append(published.get("grandBreakawayRefused"))
            by_kind = {kind: published.get(kind) for kind in _DESCENDANT_KINDS}
            pids = {kind: pid for kind, pid in by_kind.items() if isinstance(pid, int)}
            # A refused breakaway is asserted last; the lifetimes come first.
            assert pids.keys() >= set(_DESCENDANT_KINDS) - {"grandBreakaway"}, published
            for pid in pids.values():
                watch.pin(pid)
            records.append(pids)
            assert watch.survivors(0.0) == [ready["childPid"], *pids.values()]
            if shutdown == "natural-exit":
                exit_gate.touch()
            elif shutdown == "host-death":
                # On Windows SIGTERM calls TerminateProcess on the host.
                assert isinstance(ready["hostPid"], int)
                os.kill(ready["hostPid"], signal.SIGTERM)

        result = _run_host(
            _spawn_breakaway_descendants(ready_file, exit_gate),
            close_stdin=False,
            replies=({"op": "kill"},) if shutdown == "kill" else (),
            ready_probe=pin_before_shutdown,
            timeout=90.0,
            deferred=deferred,
        )
        # A startup failure must not pass the host-death case with no handles.
        assert len(records) == 1, result
        pids = records[0]
        if shutdown == "host-death":
            assert "exit" not in [message["event"] for message in result.messages]
            kept: tuple[str, ...] = _DESCENDANT_KINDS
        else:
            assert result.messages[-1] == {"event": "exit", "code": result.code}
            if shutdown == "natural-exit":
                assert result.code == 42, result
            kept = _DESCENDANTS_KEPT
        # Assert through pinned handles before closing the watch kills survivors.
        survivors = [pids[kind] for kind in kept if kind in pids]
        assert watch.survivors(15.0, expected=survivors) == survivors, result.stderr
    # Only now the guard: a refusal here is the regression the breakaway job
    # must prevent, and the lifetimes above must not hide behind it.
    assert refusals == [None], refusals


def _spawn_detached_supervisor(ready_file: Path, exit_gate: Path) -> list[str]:
    """Start a detached program that runs a worker in a hidden console; gate exit.

    This is how a daemon started from the terminal looks on Windows: Node's
    ``detached`` gives it no console, and each worker it starts with
    ``windowsHide`` gets a hidden console of its own. The daemon publishes its
    PID and the worker's once the worker runs. The shell waits for
    ``exit_gate`` and exits 42.
    """
    worker_code = (
        "import sys, time\n"
        "with open(sys.argv[1], 'w', encoding='utf-8') as stream:\n"
        "    stream.write('up')\n"
        "time.sleep(120)\n"
    )
    daemon_code = (
        "import json, os, subprocess, sys, time\n"
        "up = sys.argv[1] + '.worker'\n"
        "worker = subprocess.Popen(\n"
        f"    [sys.executable, '-c', {worker_code!r}, up],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        "    creationflags=subprocess.CREATE_NO_WINDOW,\n"
        ")\n"
        "deadline = time.monotonic() + 30\n"
        "while not os.path.exists(up) and time.monotonic() < deadline:\n"
        "    time.sleep(0.05)\n"
        "record = {'pid': os.getpid(), 'worker': worker.pid}\n"
        "with open(sys.argv[1] + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump(record, stream)\n"
        "os.replace(sys.argv[1] + '.tmp', sys.argv[1])\n"
        "time.sleep(120)\n"
    )
    code = (
        "import os, subprocess, sys, time\n"
        "subprocess.Popen(\n"
        f"    [sys.executable, '-c', {daemon_code!r}, {str(ready_file)!r}],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        "    creationflags=subprocess.DETACHED_PROCESS,\n"
        ")\n"
        "deadline = time.monotonic() + 120\n"
        f"while not os.path.exists({str(exit_gate)!r}):\n"
        "    assert time.monotonic() < deadline, 'shell exit gate was not released'\n"
        "    time.sleep(0.05)\n"
        "sys.exit(42)\n"
    )
    return [getattr(sys, "_base_executable", sys.executable), "-c", code]


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("shutdown", ("natural-exit", "kill"))
def test_session_end_keeps_the_workers_of_a_detached_program(
    tmp_path: Path, shutdown: str
) -> None:
    """A detached program keeps running together with the workers it runs itself.

    Detached programs outlive the session so that daemons serving other
    applications go on working. A daemon whose workers are ended under it is
    running, but no longer working.
    """
    ready_file = tmp_path / "daemon.json"
    exit_gate = tmp_path / "shell-exit"
    published: list[tuple[int, int]] = []
    consoles: list[dict[int, int | None]] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_shutdown(ready: Mapping[str, object]) -> None:
            """Pin the shell, the daemon and its worker; check their consoles."""
            shell = ready["childPid"]
            assert isinstance(shell, int), ready
            watch.pin(shell)
            record: object = json.loads(_read_when_published(ready_file, 45.0))
            assert isinstance(record, dict), record
            daemon, worker = record.get("pid"), record.get("worker")
            assert isinstance(daemon, int) and isinstance(worker, int), record
            watch.pin(daemon)
            watch.pin(worker)
            published.append((daemon, worker))
            handles = {
                pid: _MODULE._as_handle(_MODULE._OpenProcess(_QUERY_ACCESS, False, pid))
                for pid in (daemon, worker)
            }
            try:
                consoles.append(
                    {pid: _MODULE._console_host_of(h) for pid, h in handles.items()}
                )
            finally:
                for handle in handles.values():
                    _MODULE._close(handle)
            if shutdown == "natural-exit":
                exit_gate.touch()

        result = _run_host(
            _spawn_detached_supervisor(ready_file, exit_gate),
            close_stdin=False,
            replies=({"op": "kill"},) if shutdown == "kill" else (),
            ready_probe=pin_before_shutdown,
            timeout=60.0,
        )
        assert len(published) == 1, result
        daemon, worker = published[0]
        # The shape holds: the daemon has no console host, its worker has one
        # of its own.
        assert consoles[0][daemon] == 0, consoles
        assert consoles[0][worker] not in (None, 0, worker), consoles
        assert result.messages[-1] == {"event": "exit", "code": result.code}
        if shutdown == "natural-exit":
            assert result.code == 42, result
        survivors = [daemon, worker]
        assert watch.survivors(15.0, expected=survivors) == survivors, result.stderr


"""Hidden-console programs one session leaves behind in the many-program test.

With their console hosts the tracking job holds more than twice as many
processes, past the first read of its process list (64) and past the 64
handles one ``WaitForMultipleObjects`` call takes.
"""
_MANY_HELPERS = 70


def _spawn_many_hidden_helpers(ready_file: Path, exit_gate: Path) -> list[str]:
    """Start ``_MANY_HELPERS`` pings in hidden consoles, publish them, gate exit."""
    code = (
        "import json, os, subprocess, sys, time\n"
        "ping = os.path.join(os.environ['SystemRoot'], 'System32', 'PING.EXE')\n"
        "pids = [\n"
        "    subprocess.Popen(\n"
        "        [ping, '-n', '300', '127.0.0.1'],\n"
        "        stdin=subprocess.DEVNULL,\n"
        "        stdout=subprocess.DEVNULL,\n"
        "        stderr=subprocess.DEVNULL,\n"
        "        creationflags=subprocess.CREATE_NO_WINDOW,\n"
        "    ).pid\n"
        f"    for _ in range({_MANY_HELPERS})\n"
        "]\n"
        f"path = {str(ready_file)!r}\n"
        "with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump({'pids': pids}, stream)\n"
        "os.replace(path + '.tmp', path)\n"
        "deadline = time.monotonic() + 120\n"
        f"while not os.path.exists({str(exit_gate)!r}):\n"
        "    assert time.monotonic() < deadline, 'shell exit gate was not released'\n"
        "    time.sleep(0.05)\n"
        "sys.exit(42)\n"
    )
    return [getattr(sys, "_base_executable", sys.executable), "-c", code]


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("shutdown", ("natural-exit", "kill"))
def test_session_end_ends_more_programs_than_one_list_read_holds(
    tmp_path: Path, shutdown: str
) -> None:
    """Every hidden-console program ends, however many, within the exit budget."""
    ready_file = tmp_path / "helpers.json"
    exit_gate = tmp_path / "shell-exit"
    pinned: list[int] = []
    started: list[float] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_shutdown(ready: Mapping[str, object]) -> None:
            """Pin the shell and every helper before the shutdown starts."""
            shell = ready["childPid"]
            assert isinstance(shell, int), ready
            watch.pin(shell)
            record: object = json.loads(_read_when_published(ready_file, 60.0))
            assert isinstance(record, dict), record
            pids = record.get("pids")
            assert isinstance(pids, list), record
            assert len(pids) == _MANY_HELPERS, record
            for pid in pids:
                assert isinstance(pid, int), record
                watch.pin(pid)
                pinned.append(pid)
            if shutdown == "natural-exit":
                exit_gate.touch()
            started.append(time.monotonic())

        result = _run_host(
            _spawn_many_hidden_helpers(ready_file, exit_gate),
            close_stdin=False,
            replies=({"op": "kill"},) if shutdown == "kill" else (),
            ready_probe=pin_before_shutdown,
            timeout=90.0,
        )
        elapsed = time.monotonic() - started[0]
        assert len(pinned) == _MANY_HELPERS, result
        assert result.messages[-1] == {"event": "exit", "code": result.code}
        assert elapsed < _IGNORED_CLOSE_BOUND, (elapsed, result.stderr)
        assert watch.survivors(15.0) == [], result.stderr
        assert b"did not end" not in result.stderr, result.stderr


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_session_end_classifies_programs_at_non_ascii_paths(tmp_path: Path) -> None:
    """A hidden-console program whose image path is not ASCII ends too.

    The sweep reads each image's header from the path Windows reports. A user
    folder named Jürgen, or a project named in Japanese, must not leave the
    program unclassified and running.
    """
    base = Path(getattr(sys, "_base_executable", sys.executable))
    folder = tmp_path / "Jürgen ünïcödé 日本語"
    folder.mkdir()
    copy = folder / "python.exe"
    shutil.copy2(base, copy)
    for library in base.parent.glob("*.dll"):
        shutil.copy2(library, folder / library.name)
    ready_file = tmp_path / "helper.json"
    exit_gate = tmp_path / "shell-exit"
    code = (
        "import json, os, subprocess, sys, time\n"
        "helper = subprocess.Popen(\n"
        f"    [{str(copy)!r}, '-c', 'import time; time.sleep(120)'],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        "    env={**os.environ, 'PYTHONHOME': sys.base_prefix},\n"
        "    creationflags=subprocess.CREATE_NO_WINDOW,\n"
        ")\n"
        f"path = {str(ready_file)!r}\n"
        "with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump({'pid': helper.pid}, stream)\n"
        "os.replace(path + '.tmp', path)\n"
        "deadline = time.monotonic() + 120\n"
        f"while not os.path.exists({str(exit_gate)!r}):\n"
        "    assert time.monotonic() < deadline, 'shell exit gate was not released'\n"
        "    time.sleep(0.05)\n"
        "sys.exit(42)\n"
    )
    pinned: list[int] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_shutdown(ready: Mapping[str, object]) -> None:
            """Pin the shell and the helper, and see that the helper runs."""
            pid = _pin_shell_and_published_pid(watch, ready, ready_file, 45.0)
            pinned.append(pid)
            # Still running a second later: the copy found its libraries.
            time.sleep(1.0)
            assert watch.survivors(0.0) == [ready["childPid"], pid]
            exit_gate.touch()

        result = _run_host(
            [str(base), "-c", code],
            close_stdin=False,
            ready_probe=pin_before_shutdown,
            timeout=60.0,
        )
        assert len(pinned) == 1, result
        assert result.code == 42, result
        assert watch.survivors(15.0) == [], result.stderr
        assert b"could not classify" not in result.stderr, result.stderr


def _spawn_published_program(
    ready_file: Path,
    exit_gate: Path,
    program: str,
    flags: str,
    startupinfo: str = "None",
) -> list[str]:
    """Start ``program`` with creation ``flags``; it publishes itself; gate exit.

    ``program`` is Python code that writes its record to ``sys.argv[1]``;
    ``startupinfo`` is code for the ``STARTUPINFO`` it starts with. The shell
    waits for ``exit_gate`` and exits 42.
    """
    code = (
        "import os, subprocess, sys, time\n"
        "subprocess.Popen(\n"
        f"    [sys.executable, '-c', {program!r}, {str(ready_file)!r}],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        f"    creationflags={flags},\n"
        f"    startupinfo={startupinfo},\n"
        ")\n"
        "deadline = time.monotonic() + 120\n"
        f"while not os.path.exists({str(exit_gate)!r}):\n"
        "    assert time.monotonic() < deadline, 'shell exit gate was not released'\n"
        "    time.sleep(0.05)\n"
        "sys.exit(42)\n"
    )
    return [getattr(sys, "_base_executable", sys.executable), "-c", code]


"""A console program that lets go of its hidden console, as daemons do.

It publishes its PID and whether ``FreeConsole`` succeeded.
"""
_CONSOLE_FREEING_PROGRAM = (
    "import ctypes, json, os, sys, time\n"
    "kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)\n"
    "freed = bool(kernel32.FreeConsole())\n"
    "time.sleep(0.5)\n"
    "with open(sys.argv[1] + '.tmp', 'w', encoding='utf-8') as stream:\n"
    "    json.dump({'pid': os.getpid(), 'freed': freed}, stream)\n"
    "os.replace(sys.argv[1] + '.tmp', sys.argv[1])\n"
    "time.sleep(120)\n"
)


def _run_published_program(
    tmp_path: Path,
    shutdown: str,
    program: str,
    flags: str,
    shape: str,
    deadline: float = 30.0,
    announces_start: bool = False,
    ends: bool = False,
    startupinfo: str = "None",
) -> tuple[_HostResult, Mapping[str, Any], list[int]]:
    """Run a session whose shell starts ``program``; return what is still running.

    The program's record must report ``shape`` as true before the shutdown.
    The program publishes it within ``deadline`` seconds of its start; the
    probe allows 15 seconds more for the start, and the host 15 more again.
    A program that ``announces_start`` first publishes ``<record>.started``,
    so a record that does not come says whether the program had started.
    ``startupinfo`` is code for the ``STARTUPINFO`` the program starts with.
    The result holds the host's result, the program's record, and the pinned
    processes that outlive the session, the program expected among them
    unless it ``ends`` with the session.
    """
    ready_file = tmp_path / "program.json"
    exit_gate = tmp_path / "shell-exit"
    read_timeout = deadline + 15.0
    records: list[Mapping[str, Any]] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_shutdown(ready: Mapping[str, object]) -> None:
            """Pin the shell and the program; check its shape."""
            shell = ready["childPid"]
            assert isinstance(shell, int), ready
            watch.pin(shell)
            until = time.monotonic() + read_timeout
            if announces_start:
                started = Path(f"{ready_file}.started")
                _read_when_published(started, until - time.monotonic())
            record: Mapping[str, Any] = json.loads(
                _read_when_published(ready_file, until - time.monotonic())
            )
            assert isinstance(record, dict), record
            pid = record.get("pid")
            assert isinstance(pid, int), record
            watch.pin(pid)
            records.append(record)
            assert record.get(shape) is True, record
            if shutdown == "natural-exit":
                exit_gate.touch()

        result = _run_host(
            _spawn_published_program(
                ready_file, exit_gate, program, flags, startupinfo
            ),
            close_stdin=False,
            replies=({"op": "kill"},) if shutdown == "kill" else (),
            ready_probe=pin_before_shutdown,
            timeout=read_timeout + 15.0,
        )
        assert len(records) == 1, result
        (published,) = records
        assert result.messages[-1] == {"event": "exit", "code": result.code}
        # Assert through pinned handles before closing the watch kills survivors.
        return (
            result,
            published,
            watch.survivors(15.0, expected=() if ends else [published["pid"]]),
        )


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("shutdown", ("natural-exit", "kill"))
def test_session_end_keeps_a_program_that_freed_its_console(
    tmp_path: Path, shutdown: str
) -> None:
    """A program that let go of its hidden console counts as detached and stays.

    Once ``FreeConsole`` returns, the program holds no console host, so it is
    a program without a console, which the session end keeps running.
    """
    result, record, survivors = _run_published_program(
        tmp_path,
        shutdown,
        _CONSOLE_FREEING_PROGRAM,
        "subprocess.CREATE_NO_WINDOW",
        "freed",
    )
    assert survivors == [record["pid"]], result.stderr


"""Seconds the windowed program waits for its window to show."""
_WINDOW_DEADLINE = 60.0

"""A console program that shows a window, as ``start python app.py`` runs a Tk app.

The window is a message box shown by another thread. The program publishes
its PID to ``<record>.started`` as it starts, then its record once the
window is visible or ``_WINDOW_DEADLINE`` has passed: whether the window was
found, whether it is visible, and the seconds it waited.
"""
_WINDOWED_CONSOLE_PROGRAM = (
    "import ctypes, json, os, sys, threading, time\n"
    "def publish(path, record):\n"
    "    with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
    "        json.dump(record, stream)\n"
    "    os.replace(path + '.tmp', path)\n"
    "started = time.monotonic()\n"
    "publish(sys.argv[1] + '.started', {'pid': os.getpid()})\n"
    "user32 = ctypes.WinDLL('user32', use_last_error=True)\n"
    "user32.FindWindowW.restype = ctypes.c_void_p\n"
    "title = f'session-end window {os.getpid()}'\n"
    "threading.Thread(\n"
    "    target=lambda: user32.MessageBoxW(None, 'unsaved work', title, 0),\n"
    "    daemon=True,\n"
    ").start()\n"
    "window = None\n"
    "visible = False\n"
    f"while not visible and time.monotonic() < started + {_WINDOW_DEADLINE}:\n"
    "    time.sleep(0.05)\n"
    "    window = user32.FindWindowW(None, title)\n"
    "    visible = bool(window) and bool(\n"
    "        user32.IsWindowVisible(ctypes.c_void_p(window))\n"
    "    )\n"
    "publish(sys.argv[1], {\n"
    "    'pid': os.getpid(),\n"
    "    'found': bool(window),\n"
    "    'visible': visible,\n"
    "    'waited': round(time.monotonic() - started, 1),\n"
    "})\n"
    "time.sleep(120)\n"
)


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("shutdown", ("natural-exit", "kill"))
def test_session_end_keeps_a_console_program_that_shows_a_window(
    tmp_path: Path, shutdown: str
) -> None:
    """A console program with a window of its own keeps running, as on 3.29.0.

    The changeset keeps programs with a window. A Tk or Qt app run as
    ``start python app.py``, a Swing app run through ``java.exe`` and a GUI
    app built as a console image all have one, in a console of their own.
    """
    result, record, survivors = _run_published_program(
        tmp_path,
        shutdown,
        _WINDOWED_CONSOLE_PROGRAM,
        "subprocess.CREATE_NEW_CONSOLE",
        "visible",
        deadline=_WINDOW_DEADLINE,
        announces_start=True,
    )
    assert survivors == [record["pid"]], result.stderr


"""A console program whose only window is its console window, as ``start ping``.

The program publishes its record once its console window is visible or
``_WINDOW_DEADLINE`` has passed: whether the window is visible, the class of
the window and the process Windows names as its owner.
"""
_PROGRAM_IN_A_CONSOLE_WINDOW = (
    "import ctypes, json, os, sys, time\n"
    "from ctypes import wintypes\n"
    "kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)\n"
    "user32 = ctypes.WinDLL('user32', use_last_error=True)\n"
    "kernel32.GetConsoleWindow.restype = ctypes.c_void_p\n"
    "def console_window():\n"
    "    window = kernel32.GetConsoleWindow()\n"
    "    visible = bool(window) and bool(\n"
    "        user32.IsWindowVisible(ctypes.c_void_p(window))\n"
    "    )\n"
    "    return window, visible\n"
    "started = time.monotonic()\n"
    "window, visible = console_window()\n"
    f"while not visible and time.monotonic() < started + {_WINDOW_DEADLINE}:\n"
    "    time.sleep(0.05)\n"
    "    window, visible = console_window()\n"
    "owner = wintypes.DWORD(0)\n"
    "name = ctypes.create_unicode_buffer(257)\n"
    "if window:\n"
    "    user32.GetWindowThreadProcessId(ctypes.c_void_p(window), ctypes.byref(owner))\n"
    "    user32.GetClassNameW(ctypes.c_void_p(window), name, len(name))\n"
    "with open(sys.argv[1] + '.tmp', 'w', encoding='utf-8') as stream:\n"
    "    json.dump({\n"
    "        'pid': os.getpid(),\n"
    "        'visible': visible,\n"
    "        'owner': owner.value,\n"
    "        'class': name.value,\n"
    "    }, stream)\n"
    "os.replace(sys.argv[1] + '.tmp', sys.argv[1])\n"
    "time.sleep(120)\n"
)

"""``ShowWindow`` state of a minimized window the console host keeps for itself.

The console host hands a new console to the default terminal unless it was
started hidden or minimized, so a minimized program sits in a classic console
window of its own wherever the test runs. A minimized window keeps the visible
style.
"""
_SW_SHOWMINNOACTIVE = 7


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("shutdown", ("natural-exit", "kill"))
def test_session_end_ends_a_console_program_in_a_console_window_of_its_own(
    tmp_path: Path, shutdown: str
) -> None:
    """A console program whose only window is its console window ends.

    A console window opened from the terminal, with ``start cmd`` say, closes
    with it, as the changeset says. The console host names the program in the
    window as the window's owner, so that window must not pass for one of the
    program's own. The program starts minimized, as ``start /min`` starts one,
    so its window is a classic console window of its own whatever the default
    terminal is. Under a handoff the window would be the pseudoconsole's,
    owned by Windows Terminal's window, and there would be nothing to tell
    apart; the guard below then says so instead of failing.
    """
    result, record, survivors = _run_published_program(
        tmp_path,
        shutdown,
        _PROGRAM_IN_A_CONSOLE_WINDOW,
        "subprocess.CREATE_NEW_CONSOLE",
        "visible",
        deadline=_WINDOW_DEADLINE,
        ends=True,
        startupinfo=(
            "subprocess.STARTUPINFO(dwFlags=subprocess.STARTF_USESHOWWINDOW,"
            f" wShowWindow={_SW_SHOWMINNOACTIVE})"
        ),
    )
    if record["class"] != "ConsoleWindowClass" or record["owner"] != record["pid"]:
        reason = f"the console window is not the program's own: {record}"
        pytest.skip(reason)  # ty: ignore[too-many-positional-arguments]
    assert survivors == [], result.stderr


"""Creation flag of a child with a hidden console of its own."""
_CREATE_NO_WINDOW = 0x08000000
"""Creation flag of a child with no console at all."""
_DETACHED_PROCESS = 0x00000008
"""Creation flag of a child that leads a new process group."""
_CREATE_NEW_PROCESS_GROUP = 0x00000200
"""Creation flag asking to leave the creator's job."""
_CREATE_BREAKAWAY_FROM_JOB = 0x01000000
"""Process access to assign a running child to jobs and to wait on it."""
_ASSIGN_ACCESS = 0x0100 | 0x0001 | 0x0400 | 0x1000 | 0x00100000
"""``PROCESS_QUERY_LIMITED_INFORMATION``: what the sweep opens a process with."""
_QUERY_ACCESS = 0x1000
"""Code of a child that starts a plain and a breakaway grandchild once gated.

It publishes both PIDs, or the error text of a refused breakaway, then sleeps.
"""
_CHILD_IN_JOBS = (
    "import json, os, subprocess, sys, time\n"
    "gate, out = sys.argv[1], sys.argv[2]\n"
    "while not os.path.exists(gate):\n"
    "    time.sleep(0.05)\n"
    "sleeper = [sys.executable, '-c', 'import time; time.sleep(60)']\n"
    f"plain = subprocess.Popen(sleeper, creationflags={_CREATE_NO_WINDOW}).pid\n"
    "try:\n"
    "    away = subprocess.Popen(\n"
    f"        sleeper, creationflags={_CREATE_NO_WINDOW | _CREATE_BREAKAWAY_FROM_JOB}\n"
    "    ).pid\n"
    "except OSError as error:\n"
    "    away = str(error)\n"
    "with open(out + '.tmp', 'w', encoding='utf-8') as stream:\n"
    "    json.dump({'plain': plain, 'away': away}, stream)\n"
    "os.replace(out + '.tmp', out)\n"
    "time.sleep(60)\n"
)


"""Code of a sleeper that writes ``up`` to the file named by its argument first."""
_UP_SLEEPER = (
    "import sys, time\n"
    "with open(sys.argv[1], 'w', encoding='utf-8') as stream:\n"
    "    stream.write('up')\n"
    "time.sleep(60)\n"
)


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_console_check_tells_consoles_apart(tmp_path: Path) -> None:
    """A program with a hidden console of its own has a console host; a detached one has none.

    Asked before a child has finished starting, the check sees the stand-in
    its creator left, not the child's own console, so both children report
    that they are up before the question is put. Named as the pseudoconsole's
    host, a console makes its client an attached one.
    """
    started = (tmp_path / "own", tmp_path / "detached")
    own = subprocess.Popen(
        [sys.executable, "-c", _UP_SLEEPER, str(started[0])],
        creationflags=_CREATE_NO_WINDOW,
    )
    detached = subprocess.Popen(
        [sys.executable, "-c", _UP_SLEEPER, str(started[1])],
        creationflags=_DETACHED_PROCESS,
    )
    handles = {
        pid: _MODULE._as_handle(_MODULE._OpenProcess(_QUERY_ACCESS, False, pid))
        for pid in (own.pid, detached.pid, os.getpid())
    }
    try:
        assert all(handles.values()), handles
        for marker in started:
            assert _read_when_published(marker, 30.0) == "up"
        kinds = _MODULE._console_kinds(handles, 0)
        assert kinds.get(own.pid) == "own", kinds
        assert kinds.get(detached.pid) == "none", kinds
        # Whether this process has a console depends on the runner; either way
        # the answer is one the sweep understands.
        assert kinds.get(os.getpid()) in ("own", "none"), kinds
        host = _MODULE._console_host_of(handles[own.pid])
        assert isinstance(host, int) and host not in (0, own.pid), host
        attached = _MODULE._console_kinds({own.pid: handles[own.pid]}, host)
        assert attached == {own.pid: "attached"}, attached
    finally:
        for handle in handles.values():
            _MODULE._close(handle)
        own.kill()
        detached.kill()
        own.wait(timeout=15.0)
        detached.wait(timeout=15.0)


"""Code of a pseudoconsole client that starts a plain and a hidden child.

Each child writes ``up`` to the marker named for it once it runs; the client
then publishes both PIDs and sleeps.
"""
_PSEUDOCONSOLE_CLIENT = (
    "import json, os, subprocess, sys, time\n"
    "out, plain_up, hidden_up = sys.argv[1:4]\n"
    f"plain = subprocess.Popen([sys.executable, '-c', {_UP_SLEEPER!r}, plain_up]).pid\n"
    "hidden = subprocess.Popen(\n"
    f"    [sys.executable, '-c', {_UP_SLEEPER!r}, hidden_up],\n"
    f"    creationflags={_CREATE_NO_WINDOW},\n"
    ").pid\n"
    "with open(out + '.tmp', 'w', encoding='utf-8') as stream:\n"
    "    json.dump({'plain': plain, 'hidden': hidden}, stream)\n"
    "os.replace(out + '.tmp', out)\n"
    "time.sleep(60)\n"
)


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_pseudoconsole_names_the_console_host_its_clients_report(
    tmp_path: Path,
) -> None:
    """The console host a pseudoconsole names is the one its clients report.

    The shell started on the pseudoconsole and a child that inherits its
    console both report that host, so the check reads them as attached; a
    child with a hidden console of its own does not. Before it runs, the
    shell reports its creator's PID in place of a console host, and the
    check told who created it reads it as too new to judge rather than as a
    program in a console of its own.
    """
    out = tmp_path / "children.json"
    markers = (tmp_path / "plain", tmp_path / "hidden")
    input_read, input_write = _MODULE._create_pipe()
    output_read, output_write = _MODULE._create_pipe()
    pseudoconsole = _MODULE._create_pseudoconsole(80, 24, input_read, output_write)
    handles: dict[int, int] = {}
    thread = 0
    try:
        host = pseudoconsole.host
        assert host not in (0, os.getpid()), host
        process, thread, pid = _MODULE._create_child(
            subprocess.list2cmdline(
                [sys.executable, "-c", _PSEUDOCONSOLE_CLIENT, str(out)]
                + [str(marker) for marker in markers]
            ),
            pseudoconsole.handle,
        )
        handles[pid] = process
        # Suspended, the shell has not connected: its creator's PID stands in.
        assert _MODULE._console_host_of(process) == os.getpid()
        assert _MODULE._console_kinds({pid: process}, host) == {pid: "own"}
        assert _MODULE._console_kinds({pid: process}, host, {pid: os.getpid()}) == {
            pid: "young"
        }
        assert _MODULE._ResumeThread(thread) == 1, _MODULE._last_error()
        record: object = json.loads(_read_when_published(out, 30.0))
        assert isinstance(record, dict), record
        for marker in markers:
            assert _read_when_published(marker, 30.0) == "up"
        plain, hidden = record.get("plain"), record.get("hidden")
        assert isinstance(plain, int) and isinstance(hidden, int), record
        for child in (plain, hidden):
            handles[child] = _MODULE._as_handle(
                _MODULE._OpenProcess(_MODULE._PROCESS_SWEEP_ACCESS, False, child)
            )
        assert all(handles.values()), (handles, _MODULE._last_error())
        creators = {pid: os.getpid(), plain: pid, hidden: pid}
        kinds = _MODULE._console_kinds(handles, host, creators)
        assert kinds == {pid: "attached", plain: "attached", hidden: "own"}, (
            kinds,
            host,
            {child: _MODULE._console_host_of(h) for child, h in handles.items()},
        )
    finally:
        for handle in handles.values():
            if handle:
                _MODULE._TerminateProcess(handle, 1)
                _MODULE._WaitForSingleObject(handle, 15000)
                _MODULE._close(handle)
        if thread:
            _MODULE._close(thread)
        # The read end breaks first: the built-in close waits for a drain.
        _MODULE._close(output_read)
        pseudoconsole.close()
        for handle in (input_read, input_write, output_write):
            _MODULE._close(handle)


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_pseudoconsole_host_is_unknown_when_it_names_no_console_host() -> None:
    """A pseudoconsole whose host handle names another program has no known host.

    The struct an ``HPCON`` points to is not a documented contract. Should
    its host slot ever name a program that is not a console host, every
    attached program would pass for one in a console of its own and end
    without its close event. An unknown host ends nothing early.
    """
    process = _MODULE._as_handle(
        _MODULE._OpenProcess(_MODULE._PROCESS_SWEEP_ACCESS, False, os.getpid())
    )
    assert process, _MODULE._last_error()
    try:
        # The slot names this Python process instead of a console host.
        struct = _MODULE._PSEUDOCONSOLE(0, 0, process)
        assert _MODULE._pseudoconsole_console_host(ctypes.addressof(struct)) == 0
    finally:
        _MODULE._close(process)


"""Seconds after the kill that the late helper is let connect to its console.

Past both sweeps of the session end, which run within milliseconds of the
kill when nothing holds the pseudoconsole open, and well inside their
deadline.
"""
_LATE_CONNECT = 0.3


def _spawn_suspended_helper(ready_file: Path) -> list[str]:
    """Start a hidden ping suspended, publish its PID, then wait for the kill.

    Suspended, the helper has not connected to its console yet, as a helper
    the shell started a moment before the session ended has not.
    """
    code = (
        "import json, os, subprocess, sys, time\n"
        "ping = os.path.join(os.environ['SystemRoot'], 'System32', 'PING.EXE')\n"
        "helper = subprocess.Popen(\n"
        "    [ping, '-n', '300', '127.0.0.1'],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        "    creationflags=subprocess.CREATE_NO_WINDOW | 0x00000004,\n"
        ")\n"
        f"path = {str(ready_file)!r}\n"
        "with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump({'pid': helper.pid}, stream)\n"
        "os.replace(path + '.tmp', path)\n"
        "time.sleep(120)\n"
    )
    return [getattr(sys, "_base_executable", sys.executable), "-c", code]


def _resume_later(pid: int, delay: float) -> None:
    """Resume the suspended process ``pid`` once ``delay`` seconds have passed."""
    kernel32 = _kernel32()
    open_process = kernel32.OpenProcess
    open_process.argtypes = (ctypes.c_uint32, ctypes.c_int32, ctypes.c_uint32)
    open_process.restype = ctypes.c_void_p
    # ``PROCESS_SUSPEND_RESUME``.
    handle = open_process(0x0800, False, pid)
    assert handle, _win32_error()
    ntdll = ctypes.WinDLL("ntdll")  # ty: ignore[possibly-missing-attribute]
    ntdll.NtResumeProcess.argtypes = (ctypes.c_void_p,)
    ntdll.NtResumeProcess.restype = ctypes.c_int32
    try:
        time.sleep(delay)
        assert ntdll.NtResumeProcess(handle) == 0
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(handle))


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_session_end_ends_a_helper_that_connects_to_its_console_late(
    tmp_path: Path,
) -> None:
    """A hidden helper too new to judge at the kill is ended once it connects.

    The sweep cannot judge a program that has not connected to its console
    yet. Its last round must wait for that program, or a helper the shell
    started just before the session ended outlives the session, which is the
    leak the sweep is there to close.
    """
    ready_file = tmp_path / "helper.json"
    resumers: list[threading.Thread] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_kill(ready: Mapping[str, object]) -> None:
            """Pin the shell and the helper; let the helper connect after the kill."""
            shell = ready["childPid"]
            assert isinstance(shell, int), ready
            watch.pin(shell)
            record: object = json.loads(_read_when_published(ready_file, 30.0))
            assert isinstance(record, dict), record
            pid = record.get("pid")
            assert isinstance(pid, int), record
            watch.pin(pid)
            resumer = threading.Thread(target=_resume_later, args=(pid, _LATE_CONNECT))
            resumer.start()
            resumers.append(resumer)

        result = _run_host(
            _spawn_suspended_helper(ready_file),
            close_stdin=False,
            replies=({"op": "kill"},),
            ready_probe=pin_before_kill,
            timeout=60.0,
        )
        for resumer in resumers:
            resumer.join(10.0)
        assert len(resumers) == 1, result
        assert result.messages[-1] == {"event": "exit", "code": result.code}
        assert watch.survivors(15.0) == [], result.stderr


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_tracking_jobs_hold_what_leaves_the_kill_on_close_job(tmp_path: Path) -> None:
    """The root job lists a child's plain and breakaway descendants; the inner job only the child.

    A plain grandchild leaves the kill-on-close job silently and stops in the
    middle job, which permits no silent breakaway; one that asks to break away
    is not refused and is still tracked.
    """
    gate = tmp_path / "gate"
    out = tmp_path / "pids.json"
    tracking, breakaway = _MODULE._create_tracking_jobs()
    inner = _MODULE._create_job()
    child = subprocess.Popen(
        [sys.executable, "-c", _CHILD_IN_JOBS, str(gate), str(out)],
        creationflags=_CREATE_NO_WINDOW,
    )
    handle = _MODULE._as_handle(_MODULE._OpenProcess(_ASSIGN_ACCESS, False, child.pid))
    assert handle, _MODULE._last_error()
    try:
        for job in (tracking, breakaway, inner):
            assert _MODULE._AssignProcessToJobObject(job, handle), _MODULE._last_error()
        gate.touch()
        published: object = json.loads(_read_when_published(out, 30.0))
        assert isinstance(published, dict), published
        plain, away = published.get("plain"), published.get("away")
        assert isinstance(plain, int), published
        assert isinstance(away, int), published
        tracked = _MODULE._tracked_process_ids(tracking)
        assert {child.pid, plain, away} <= set(tracked), tracked
        # The console hosts of the hidden consoles sit in the jobs as well.
        middle = set(_MODULE._tracked_process_ids(breakaway))
        assert {child.pid, plain} <= middle, middle
        assert _MODULE._tracked_process_ids(inner) == [child.pid]
        for pid in (child.pid, plain, away):
            opened = _MODULE._open_tracked_process(pid, tracking)
            assert opened, (pid, _MODULE._last_error())
            _MODULE._close(opened)
        assert _MODULE._open_tracked_process(os.getpid(), tracking) == 0
    finally:
        _MODULE._TerminateJobObject(tracking, 1)
        child.wait(timeout=15.0)
        for job in (inner, breakaway, tracking):
            _MODULE._close(job)
        _MODULE._close(handle)


"""Git for Windows' native bash launcher, where its installer puts it."""
_GIT_BASH_LAUNCHER = Path(r"C:\Program Files\Git\bin\bash.exe")
"""The MSYS ``bash.exe`` that the launcher starts."""
_MSYS_BASH = Path(r"C:\Program Files\Git\usr\bin\bash.exe")
"""Seconds within which the sweep ends a hidden helper, whatever else runs.

The plugin kills the host ``TERMINAL_EXIT_CLEANUP_WAIT`` (5 s) after it asks
for the kill, so the sweep's own deadline and join margin sit below that.
"""
_IGNORED_CLOSE_BOUND = 4.0
"""Seconds an attached program that ignores the close is known to live on.

The console host ends such a program through its own five-second timeout;
a sweep that ended it sooner would take that time away from programs that
use it to save their state.
"""
_CONSOLE_HOST_PATIENCE = 3.0
"""Seconds a session end may take once an attached program ignores the close.

The console host's timeout decides, as on 3.29.0, and nothing may hang after it.
"""
_SESSION_END_BOUND = 10.0


def _pin_shell_and_published_pid(
    watch: _ProcessWatch, ready: Mapping[str, object], ready_file: Path, timeout: float
) -> int:
    """Pin the shell and the program whose PID ``ready_file`` names; return it."""
    shell = ready["childPid"]
    assert isinstance(shell, int), ready
    watch.pin(shell)
    record: object = json.loads(_read_when_published(ready_file, timeout))
    assert isinstance(record, dict), record
    pid = record.get("pid")
    assert isinstance(pid, int), record
    watch.pin(pid)
    return pid


def _write_hidden_sleeper_launcher(
    script: Path, ready_file: Path, exit_gate: Path
) -> None:
    """Write a program that leaves a sleeper in a hidden console, then waits.

    It publishes the sleeper's PID to ``ready_file``, waits for ``exit_gate``
    and exits 42, so the shell that runs it as its last command exits 42 too.
    """
    script.write_text(
        "import json, os, subprocess, sys, time\n"
        "child = subprocess.Popen(\n"
        "    [sys.executable, '-c', 'import time; time.sleep(120)'],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        "    creationflags=subprocess.CREATE_NO_WINDOW,\n"
        ")\n"
        f"path = {str(ready_file)!r}\n"
        "with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump({'pid': child.pid}, stream)\n"
        "os.replace(path + '.tmp', path)\n"
        "deadline = time.monotonic() + 120\n"
        f"while not os.path.exists({str(exit_gate)!r}):\n"
        "    assert time.monotonic() < deadline, 'shell exit gate was not released'\n"
        "    time.sleep(0.05)\n"
        "sys.exit(42)\n",
        encoding="utf-8",
    )


def _msys_shell(shape: str, launcher: Path) -> list[str]:
    """Return a shell that runs ``launcher`` through MSYS bash in one shape.

    ``gitBash`` is the plugin's Git Bash preset: the native launcher in
    ``bin`` starts the MSYS ``bash.exe``. ``libuvLike`` is a Node-style
    program: it puts itself in a job with libuv's limits, then starts the MSYS
    ``bash.exe`` itself. MSYS rewrites arguments that look like POSIX paths,
    so the Windows paths keep their drive letter and use forward slashes.
    """
    python = getattr(sys, "_base_executable", sys.executable)
    command = f'"{Path(python).as_posix()}" "{launcher.as_posix()}"'
    if shape == "gitBash":
        return [str(_GIT_BASH_LAUNCHER), "-c", command]
    code = (
        "import ctypes, subprocess, sys\n"
        "from ctypes import wintypes\n"
        "kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)\n"
        "kernel32.CreateJobObjectW.restype = ctypes.c_void_p\n"
        "kernel32.GetCurrentProcess.restype = ctypes.c_void_p\n"
        "kernel32.SetInformationJobObject.argtypes = (\n"
        "    ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD\n"
        ")\n"
        "kernel32.AssignProcessToJobObject.argtypes = (ctypes.c_void_p, ctypes.c_void_p)\n"
        "class Limits(ctypes.Structure):\n"
        "    _fields_ = (\n"
        "        ('times', ctypes.c_int64 * 2),\n"
        "        ('LimitFlags', wintypes.DWORD),\n"
        "        ('working_set', ctypes.c_size_t * 2),\n"
        "        ('ActiveProcessLimit', wintypes.DWORD),\n"
        "        ('Affinity', ctypes.c_size_t),\n"
        "        ('classes', wintypes.DWORD * 2),\n"
        "        ('io_counters', ctypes.c_uint64 * 6),\n"
        "        ('memory', ctypes.c_size_t * 4),\n"
        "    )\n"
        "job = kernel32.CreateJobObjectW(None, None)\n"
        "assert job, ctypes.get_last_error()\n"
        "limits = Limits()\n"
        "# KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK | BREAKAWAY_OK, as libuv sets.\n"
        "limits.LimitFlags = 0x2000 | 0x1000 | 0x800\n"
        "assert kernel32.SetInformationJobObject(\n"
        "    job, 9, ctypes.byref(limits), ctypes.sizeof(limits)\n"
        "), ctypes.get_last_error()\n"
        "assert kernel32.AssignProcessToJobObject(\n"
        "    job, kernel32.GetCurrentProcess()\n"
        "), ctypes.get_last_error()\n"
        f"sys.exit(subprocess.run([{str(_MSYS_BASH)!r}, '-c', {command!r}]).returncode)\n"
    )
    return [python, "-c", code]


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.skipif(
    not (_GIT_BASH_LAUNCHER.is_file() and _MSYS_BASH.is_file()),
    reason="Git for Windows is not installed at its default path",
)
@pytest.mark.parametrize("shutdown", ("natural-exit", "kill"))
@pytest.mark.parametrize("shape", ("gitBash", "libuvLike"))
def test_session_end_ends_programs_left_behind_through_msys_bash(
    tmp_path: Path, shutdown: str, shape: str
) -> None:
    """A hidden-console program started under MSYS bash ends with the session.

    MSYS asks for ``CREATE_BREAKAWAY_FROM_JOB`` whenever the job it runs in
    permits a breakaway, so a job layout that permits one at the wrong level
    loses everything that Git Bash, or an agent's Bash tool, runs.
    """
    ready_file = tmp_path / "sleeper.json"
    exit_gate = tmp_path / "shell-exit"
    launcher = tmp_path / "launcher.py"
    _write_hidden_sleeper_launcher(launcher, ready_file, exit_gate)
    sleeper_pids: list[int] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_shutdown(ready: Mapping[str, object]) -> None:
            """Pin the shell and the sleeper before the shutdown starts."""
            pid = _pin_shell_and_published_pid(watch, ready, ready_file, 45.0)
            sleeper_pids.append(pid)
            if shutdown == "natural-exit":
                exit_gate.touch()

        result = _run_host(
            _msys_shell(shape, launcher),
            close_stdin=False,
            replies=({"op": "kill"},) if shutdown == "kill" else (),
            ready_probe=pin_before_shutdown,
            timeout=90.0,
        )
        assert len(sleeper_pids) == 1, result
        assert result.messages[-1] == {"event": "exit", "code": result.code}
        if shutdown == "natural-exit":
            assert result.code == 42, result
        assert watch.survivors(15.0) == [], result.stderr


"""Code defining ``job_flags()``: the limit flags of the caller's job, or ``None``.

With a ``NULL`` job handle, ``QueryInformationJobObject`` answers for the job
the calling process is in.
"""
_JOB_FLAGS_CODE = (
    "import ctypes\n"
    "from ctypes import wintypes\n"
    "kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)\n"
    "class Basic(ctypes.Structure):\n"
    "    _fields_ = (\n"
    "        ('times', ctypes.c_int64 * 2),\n"
    "        ('LimitFlags', wintypes.DWORD),\n"
    "        ('working_set', ctypes.c_size_t * 2),\n"
    "        ('ActiveProcessLimit', wintypes.DWORD),\n"
    "        ('Affinity', ctypes.c_size_t),\n"
    "        ('classes', wintypes.DWORD * 2),\n"
    "    )\n"
    "kernel32.QueryInformationJobObject.argtypes = (\n"
    "    ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p\n"
    ")\n"
    "def job_flags():\n"
    "    basic = Basic()\n"
    "    # JobObjectBasicLimitInformation of the job this process is in.\n"
    "    known = kernel32.QueryInformationJobObject(\n"
    "        None, 2, ctypes.byref(basic), ctypes.sizeof(basic), None\n"
    "    )\n"
    "    return basic.LimitFlags if known else None\n"
)
"""Code defining ``break_away(record)``: start a sleeper outside the job.

It notes the sleeper's PID under ``away``, or the error under ``refused``.
"""
_BREAK_AWAY_CODE = (
    "import subprocess, sys\n"
    "def break_away(record):\n"
    "    try:\n"
    "        record['away'] = subprocess.Popen(\n"
    "            [sys.executable, '-c', 'import time; time.sleep(60)'],\n"
    "            stdin=subprocess.DEVNULL,\n"
    "            stdout=subprocess.DEVNULL,\n"
    "            stderr=subprocess.DEVNULL,\n"
    "            creationflags=subprocess.CREATE_BREAKAWAY_FROM_JOB\n"
    "            | subprocess.CREATE_NO_WINDOW,\n"
    "        ).pid\n"
    "    except OSError as error:\n"
    "        record['refused'] = str(error)\n"
)
"""Code defining ``publish(path, record)``: write a JSON record atomically."""
_PUBLISH_CODE = (
    "import json, os\n"
    "def publish(path, record):\n"
    "    with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
    "        json.dump(record, stream)\n"
    "    os.replace(path + '.tmp', path)\n"
)
"""Code of a program that asks to leave its job, publishes the answer, then waits.

The answer carries the limit flags of the job the program runs in, so that a
refusal names the job that refused: the session's root job has none.
"""
_BREAKAWAY_PROBE = (
    _JOB_FLAGS_CODE + _BREAK_AWAY_CODE + _PUBLISH_CODE + "import os, sys, time\n"
    "record = {'pid': os.getpid(), 'jobFlags': job_flags()}\n"
    "break_away(record)\n"
    "publish(sys.argv[1], record)\n"
    "time.sleep(60)\n"
)
"""Code of a kept program that asks to leave its job once a gate opens.

It publishes its PID and job flags at once (``sys.argv[2]``), waits for the
gate (``sys.argv[1]``), then publishes its job flags again with the answer to
its breakaway (``sys.argv[3]``), and waits.
"""
_KEPT_PROBE = (
    _JOB_FLAGS_CODE + _BREAK_AWAY_CODE + _PUBLISH_CODE + "import os, sys, time\n"
    "gate, before, after = sys.argv[1:4]\n"
    "publish(before, {'pid': os.getpid(), 'jobFlags': job_flags()})\n"
    "deadline = time.monotonic() + 120\n"
    "while not os.path.exists(gate) and time.monotonic() < deadline:\n"
    "    time.sleep(0.05)\n"
    "record = {'jobFlags': job_flags()}\n"
    "break_away(record)\n"
    "publish(after, record)\n"
    "time.sleep(120)\n"
)
"""``JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK``."""
_BREAKAWAY_LIMITS = 0x00000800 | 0x00001000
"""``JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK``: a job that does not track children."""
_SILENT_BREAKAWAY_LIMIT = 0x00001000


"""What the breakaway probe publishes."""
_BREAKAWAY_RECORD_KEYS = ("pid", "jobFlags", "away", "refused")


def _breakaway_probe_shell(shape: str, script: Path, ready_file: Path) -> list[str]:
    """Return a shell that runs the breakaway probe one breakaway below the shell.

    ``breakawayChild``: the shell starts the probe with
    ``CREATE_BREAKAWAY_FROM_JOB``, as a launcher that means to outlive its
    caller does. ``gitBash``: the Git Bash preset runs the probe as an
    ordinary command, and MSYS asks for that breakaway itself.
    """
    python = getattr(sys, "_base_executable", sys.executable)
    if shape == "gitBash":
        command = (
            f'"{Path(python).as_posix()}" "{script.as_posix()}" '
            f'"{ready_file.as_posix()}"'
        )
        return [str(_GIT_BASH_LAUNCHER), "-c", command]
    code = (
        "import subprocess, sys, time\n"
        "subprocess.Popen(\n"
        f"    [sys.executable, {str(script)!r}, {str(ready_file)!r}],\n"
        "    creationflags=subprocess.CREATE_BREAKAWAY_FROM_JOB,\n"
        ")\n"
        "time.sleep(120)\n"
    )
    return [python, "-c", code]


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize(
    "shape",
    (
        "breakawayChild",
        pytest.param(
            "gitBash",
            marks=pytest.mark.skipif(
                not (_GIT_BASH_LAUNCHER.is_file() and _MSYS_BASH.is_file()),
                reason="Git for Windows is not installed at its default path",
            ),
        ),
    ),
)
def test_a_program_in_the_root_job_may_not_break_away_while_the_session_runs(
    tmp_path: Path, shape: str
) -> None:
    """A second breakaway under the shell is refused until the session ends.

    Every program Git Bash runs has broken away once already, because MSYS
    asks for it, and so has one the shell started with
    ``CREATE_BREAKAWAY_FROM_JOB``: both sit in the root tracking job. That
    job permits no breakaway, or MSYS would carry everything it runs out of
    the sweep's reach, so such a program's own ``CREATE_BREAKAWAY_FROM_JOB``
    fails with access denied while the session runs. This pins the price of
    tracking MSYS, and the limit flags name the job that refused. On a
    desktop 3.29.0 let the call succeed, as nothing above the shell's job
    refused it; under this runner's own job it refused there as well, so the
    difference to 3.29.0 does not show here. The next test pins that the
    refusal ends with the session.
    """
    script = tmp_path / "probe.py"
    script.write_text(_BREAKAWAY_PROBE, encoding="utf-8")
    ready_file = tmp_path / "probe.json"
    records: list[dict[str, object]] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_kill(ready: Mapping[str, object]) -> None:
            """Pin the probe and what it started, and keep its answer."""
            shell = ready["childPid"]
            assert isinstance(shell, int), ready
            watch.pin(shell)
            record: object = json.loads(_read_when_published(ready_file, 45.0))
            assert isinstance(record, dict), record
            for key in ("pid", "away"):
                pid = record.get(key)
                if isinstance(pid, int):
                    watch.pin(pid)
            records.append({key: record.get(key) for key in _BREAKAWAY_RECORD_KEYS})

        result = _run_host(
            _breakaway_probe_shell(shape, script, ready_file),
            close_stdin=False,
            replies=({"op": "kill"},),
            ready_probe=pin_before_kill,
            timeout=60.0,
        )
        assert len(records) == 1, result
        # The root tracking job, which has no limit flags, refused.
        assert records[0]["jobFlags"] == 0, records[0]
        assert records[0]["away"] is None, records[0]
        refused = records[0]["refused"]
        assert isinstance(refused, str) and "WinError 5" in refused, records[0]


def _kept_probe_shell(script: Path, gate: Path, before: Path, after: Path) -> list[str]:
    """Return a shell that starts the kept probe in the root job, then waits.

    The shell starts the probe with ``CREATE_BREAKAWAY_FROM_JOB``, which
    carries it up into the root tracking job, and ``DETACHED_PROCESS``, so it
    has no console and the session end keeps it. The shell waits to be killed.
    """
    code = (
        "import subprocess, sys, time\n"
        "subprocess.Popen(\n"
        f"    [sys.executable, {str(script)!r}, {str(gate)!r}, {str(before)!r},"
        f" {str(after)!r}],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        "    creationflags=subprocess.CREATE_BREAKAWAY_FROM_JOB\n"
        "    | subprocess.DETACHED_PROCESS,\n"
        ")\n"
        "time.sleep(120)\n"
    )
    return [getattr(sys, "_base_executable", sys.executable), "-c", code]


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_what_the_session_kept_may_break_away_once_it_has_ended(
    tmp_path: Path,
) -> None:
    """Once the session has ended, a kept program's job lets it and its children go.

    While the session runs, the tracking jobs hold a kept program's children
    and refuse its breakaway. Once the sweep is over, the host lets both
    jobs permit every breakaway, so a program the session kept behaves as on
    3.29.0 from then on: a child it starts is not tracked, and one it asks to
    break away is not refused.
    """
    script = tmp_path / "probe.py"
    script.write_text(_KEPT_PROBE, encoding="utf-8")
    gate, before, after = (tmp_path / name for name in ("gate", "before", "after"))
    records: list[Mapping[str, object]] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_kill(ready: Mapping[str, object]) -> None:
            """Pin the shell and the probe, and keep the probe's first answer."""
            shell = ready["childPid"]
            assert isinstance(shell, int), ready
            watch.pin(shell)
            record: object = json.loads(_read_when_published(before, 45.0))
            assert isinstance(record, dict), record
            pid = record.get("pid")
            assert isinstance(pid, int), record
            watch.pin(pid)
            records.append({"pid": pid, "jobFlags": record.get("jobFlags")})

        result = _run_host(
            _kept_probe_shell(script, gate, before, after),
            close_stdin=False,
            replies=({"op": "kill"},),
            ready_probe=pin_before_kill,
            timeout=60.0,
        )
        assert result.messages[-1] == {"event": "exit", "code": result.code}
        assert len(records) == 1, result
        probe = records[0]["pid"]
        assert isinstance(probe, int), records
        # The probe has no console, so it outlived the session.
        assert watch.survivors(15.0, expected=[probe]) == [probe], result.stderr
        gate.touch()
        answer: object = json.loads(_read_when_published(after, 30.0))
        assert isinstance(answer, dict), answer
        away = answer.get("away")
        if isinstance(away, int):
            watch.pin(away)
        records.append(
            {key: answer.get(key) for key in ("jobFlags", "away", "refused")}
        )
    tracked, freed = records[0].get("jobFlags"), records[1].get("jobFlags")
    # While the session ran, the probe's job held its children ...
    assert isinstance(tracked, int) and not tracked & _SILENT_BREAKAWAY_LIMIT, records
    # ... and once it ended, the job lets them and the probe go.
    assert isinstance(freed, int) and freed & _BREAKAWAY_LIMITS == _BREAKAWAY_LIMITS, (
        records,
        result.stderr,
    )
    assert records[1].get("refused") is None and isinstance(away, int), records


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_what_a_session_kept_may_break_away_after_its_start_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A session that fails once its shell ran lets what it kept break away too.

    When Obsidian's window goes just as the host reports ``ready``, the write
    fails after the shell has run, and the host releases the session without
    a sweep. A program the shell had started with
    ``CREATE_BREAKAWAY_FROM_JOB`` is then in the root tracking job alone,
    which refuses its breakaway while the session runs and outlives its
    handles for as long as the program runs. The release must lift that
    refusal as a finished sweep does, or the program could never break away
    again, where 3.29.0 put it in no job.
    """
    script = tmp_path / "probe.py"
    script.write_text(_KEPT_PROBE, encoding="utf-8")
    gate, before, after = (tmp_path / name for name in ("gate", "before", "after"))
    host = _MODULE._ConPtyHost(_MODULE.HostArguments(80, 24, "pipe", ("cmd",)), "token")
    with closing(_ProcessWatch()) as watch:
        probe = subprocess.Popen(
            [
                getattr(sys, "_base_executable", sys.executable),
                *(str(path) for path in (script, gate, before, after)),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_CREATE_NO_WINDOW,
        )
        watch.pin(probe.pid)

        def start() -> None:
            """Hold the probe as the session's jobs do; fail as a lost ``ready`` does."""
            tracking, breakaway = _MODULE._create_tracking_jobs()
            host._tracking_job, host._breakaway_job = tracking, breakaway
            handle = _MODULE._as_handle(
                _MODULE._OpenProcess(_ASSIGN_ACCESS, False, probe.pid)
            )
            assert handle, _MODULE._last_error()
            try:
                assigned = _MODULE._AssignProcessToJobObject(tracking, handle)
                assert assigned, _MODULE._last_error()
            finally:
                _MODULE._close(handle)
            raise OSError("the control channel is unavailable")

        monkeypatch.setattr(host, "_start", start)
        assert host._run_session() == _MODULE._EXIT_HOST_ERROR
        gate.touch()
        answer: object = json.loads(_read_when_published(after, 30.0))
        assert isinstance(answer, dict), answer
        away = answer.get("away")
        if isinstance(away, int):
            watch.pin(away)
    # The probe's job, the root, lets it and its children go ...
    flags = answer.get("jobFlags")
    assert isinstance(flags, int), answer
    assert flags & _BREAKAWAY_LIMITS == _BREAKAWAY_LIMITS, answer
    # ... so its own breakaway is not refused.
    assert answer.get("refused") is None and isinstance(away, int), answer


def _spawn_closing_grandchild(
    ready_file: Path,
    marker: Path,
    exit_gate: Path,
    handler_seconds: float,
    helper_file: Path | None = None,
) -> list[str]:
    """Publish an attached grandchild that marks ``CTRL_CLOSE_EVENT``; gate exit.

    The grandchild shares the shell's pseudoconsole. Its control handler
    writes ``marker`` and then keeps running for ``handler_seconds`` before it
    lets the process end. With ``helper_file``, the shell also leaves a
    sleeper in a hidden console of its own and publishes its PID there.
    """
    helper_code = (
        ""
        if helper_file is None
        else (
            "helper = subprocess.Popen(\n"
            "    [sys.executable, '-c', 'import time; time.sleep(120)'],\n"
            "    stdin=subprocess.DEVNULL,\n"
            "    stdout=subprocess.DEVNULL,\n"
            "    stderr=subprocess.DEVNULL,\n"
            "    creationflags=subprocess.CREATE_NO_WINDOW,\n"
            ")\n"
            f"with open({str(helper_file)!r} + '.tmp', 'w', encoding='utf-8') as s:\n"
            "    json.dump({'pid': helper.pid}, s)\n"
            f"os.replace({str(helper_file)!r} + '.tmp', {str(helper_file)!r})\n"
        )
    )
    grandchild_code = (
        "import ctypes, json, os, sys, time\n"
        "from ctypes import wintypes\n"
        "kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)\n"
        "HANDLER = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)\n"
        f"marker = {str(marker)!r}\n"
        "def handle(event):\n"
        "    if event == 2:  # CTRL_CLOSE_EVENT\n"
        "        with open(marker + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "            stream.write(str(event))\n"
        "        os.replace(marker + '.tmp', marker)\n"
        f"        time.sleep({handler_seconds!r})\n"
        "    return True\n"
        "routine = HANDLER(handle)\n"
        "kernel32.SetConsoleCtrlHandler.argtypes = (HANDLER, wintypes.BOOL)\n"
        "assert kernel32.SetConsoleCtrlHandler(routine, True), ctypes.get_last_error()\n"
        f"path = {str(ready_file)!r}\n"
        "with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump({'pid': os.getpid()}, stream)\n"
        "os.replace(path + '.tmp', path)\n"
        "time.sleep(120)\n"
    )
    code = (
        "import json, os, subprocess, sys, time\n"
        "grandchild = subprocess.Popen(\n"
        f"    [sys.executable, '-c', {grandchild_code!r}],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        ")\n"
        f"{helper_code}"
        "deadline = time.monotonic() + 120\n"
        f"while not os.path.exists({str(exit_gate)!r}):\n"
        "    assert time.monotonic() < deadline, 'shell exit gate was not released'\n"
        "    time.sleep(0.05)\n"
        "sys.exit(42)\n"
    )
    return [getattr(sys, "_base_executable", sys.executable), "-c", code]


class _ClosingRun(NamedTuple):
    """What a session with an attached closing grandchild left behind.

    ``elapsed`` is what passed between the shutdown request and the host's
    exit; ``exits`` holds, per pinned role, how long after that request the
    process exited, or ``None`` if it did not within the watch.
    """

    result: _HostResult
    marker: Path
    elapsed: float
    exits: Mapping[str, float | None]


def _run_closing_grandchild(
    tmp_path: Path, shutdown: str, handler_seconds: float, with_helper: bool = False
) -> _ClosingRun:
    """Run a session with an attached grandchild; return what it left behind.

    With ``with_helper``, the shell also leaves a sleeper in a hidden console
    of its own, timed under the role ``helper``; the grandchild is ``attached``.
    """
    ready_file = tmp_path / "grandchild.json"
    helper_file = tmp_path / "helper.json" if with_helper else None
    marker = tmp_path / "close-event"
    exit_gate = tmp_path / "shell-exit"
    started: list[float] = []
    roles: dict[str, int] = {}
    times = _ExitTimes()
    with closing(_ProcessWatch()) as watch:

        def pin_before_shutdown(ready: Mapping[str, object]) -> None:
            """Pin the shell, the grandchild and the helper before the shutdown."""
            roles["attached"] = _pin_shell_and_published_pid(
                watch, ready, ready_file, 30.0
            )
            if helper_file is not None:
                record: object = json.loads(_read_when_published(helper_file, 30.0))
                assert isinstance(record, dict), record
                helper = record.get("pid")
                assert isinstance(helper, int), record
                watch.pin(helper)
                roles["helper"] = helper
            for pid in roles.values():
                times.watch(pid, watch.handle(pid), 60.0)
            if shutdown == "natural-exit":
                exit_gate.touch()
            started.append(time.monotonic())

        result = _run_host(
            _spawn_closing_grandchild(
                ready_file, marker, exit_gate, handler_seconds, helper_file
            ),
            close_stdin=False,
            replies=({"op": "kill"},) if shutdown == "kill" else (),
            ready_probe=pin_before_shutdown,
            timeout=60.0,
        )
        elapsed = time.monotonic() - started[0]
        assert result.messages[-1] == {"event": "exit", "code": result.code}
        assert watch.survivors(15.0) == [], result.stderr
        exits = {
            role: None if at is None else at - started[0]
            for role, pid in roles.items()
            for at in (times.of(pid),)
        }
    return _ClosingRun(result, marker, elapsed, exits)


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("shutdown", ("natural-exit", "kill"))
def test_attached_programs_get_the_console_close_event_at_session_end(
    tmp_path: Path, shutdown: str
) -> None:
    """A program attached to the pseudoconsole sees ``CTRL_CLOSE_EVENT`` and ends.

    The event is how an agent CLI, a REPL or an editor saves its state when
    the terminal closes, so nothing may end such a program before it arrives.
    """
    run = _run_closing_grandchild(tmp_path, shutdown, 0.0)
    if shutdown == "natural-exit":
        assert run.result.code == 42, run.result
    assert run.marker.is_file(), run.result


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_session_end_ends_hidden_helpers_while_an_attached_program_ignores_the_close(
    tmp_path: Path,
) -> None:
    """A hidden helper ends within the budget; the attached program keeps its time.

    A program attached to the pseudoconsole whose close handler never
    returns is left to the console host, which ends it through its own
    five-second timeout, as on 3.29.0; the sweep does not cut that short.
    The sleeper the shell left in a hidden console of its own is ended within
    the sweep's budget all the same, and the session ends once the console
    host has given up on the attached program.
    """
    run = _run_closing_grandchild(tmp_path, "kill", 30.0, with_helper=True)
    assert run.marker.is_file()
    helper, attached = run.exits["helper"], run.exits["attached"]
    assert helper is not None and helper < _IGNORED_CLOSE_BOUND, (
        run.exits,
        run.result.stderr,
    )
    assert attached is not None and attached >= _CONSOLE_HOST_PATIENCE, (
        run.exits,
        run.result.stderr,
    )
    assert run.elapsed < _SESSION_END_BOUND, (run.elapsed, run.exits, run.result.stderr)


def _spawn_saving_grandchild(
    ready_file: Path, saved: Path, exit_gate: Path, save_seconds: float
) -> list[str]:
    """Publish an attached grandchild that saves for a while on close; gate exit.

    The grandchild shares the shell's pseudoconsole. On ``CTRL_CLOSE_EVENT``
    its handler works for ``save_seconds``, as a program saving its state
    does, and only then writes ``saved`` and lets the process end.
    """
    grandchild_code = (
        "import ctypes, json, os, sys, time\n"
        "from ctypes import wintypes\n"
        "kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)\n"
        "HANDLER = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)\n"
        f"saved = {str(saved)!r}\n"
        "def handle(event):\n"
        "    if event == 2:  # CTRL_CLOSE_EVENT\n"
        f"        time.sleep({save_seconds!r})\n"
        "        with open(saved + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "            stream.write('saved')\n"
        "        os.replace(saved + '.tmp', saved)\n"
        "    return True\n"
        "routine = HANDLER(handle)\n"
        "kernel32.SetConsoleCtrlHandler.argtypes = (HANDLER, wintypes.BOOL)\n"
        "assert kernel32.SetConsoleCtrlHandler(routine, True), ctypes.get_last_error()\n"
        f"path = {str(ready_file)!r}\n"
        "with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump({'pid': os.getpid()}, stream)\n"
        "os.replace(path + '.tmp', path)\n"
        "time.sleep(120)\n"
    )
    code = (
        "import os, subprocess, sys, time\n"
        "grandchild = subprocess.Popen(\n"
        f"    [sys.executable, '-c', {grandchild_code!r}],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        ")\n"
        "deadline = time.monotonic() + 120\n"
        f"while not os.path.exists({str(exit_gate)!r}):\n"
        "    assert time.monotonic() < deadline, 'shell exit gate was not released'\n"
        "    time.sleep(0.05)\n"
        "sys.exit(42)\n"
    )
    return [getattr(sys, "_base_executable", sys.executable), "-c", code]


"""Seconds the saving grandchild works in its close handler.

Well inside the five seconds the console host gives a close handler, and
longer than a program usually needs, but not longer than a large save does.
"""
_SAVE_ON_CLOSE_SECONDS = 2.5


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("shutdown", ("natural-exit", "kill"))
def test_attached_programs_may_finish_saving_on_close(
    tmp_path: Path, shutdown: str
) -> None:
    """A program that answers the close event by saving for a while gets to finish.

    On 3.29.0 such a program had the console host's five seconds. Ending it
    after a shorter grace loses whatever it was writing.
    """
    ready_file = tmp_path / "grandchild.json"
    saved = tmp_path / "saved"
    exit_gate = tmp_path / "shell-exit"
    with closing(_ProcessWatch()) as watch:

        def pin_before_shutdown(ready: Mapping[str, object]) -> None:
            """Pin the shell and the grandchild before the shutdown starts."""
            shell = ready["childPid"]
            assert isinstance(shell, int), ready
            watch.pin(shell)
            record: object = json.loads(_read_when_published(ready_file, 30.0))
            assert isinstance(record, dict), record
            pid = record.get("pid")
            assert isinstance(pid, int), record
            watch.pin(pid)
            if shutdown == "natural-exit":
                exit_gate.touch()

        result = _run_host(
            _spawn_saving_grandchild(
                ready_file, saved, exit_gate, _SAVE_ON_CLOSE_SECONDS
            ),
            close_stdin=False,
            replies=({"op": "kill"},) if shutdown == "kill" else (),
            ready_probe=pin_before_shutdown,
            timeout=60.0,
        )
        assert result.messages[-1] == {"event": "exit", "code": result.code}
        assert watch.survivors(15.0) == [], result.stderr
    assert saved.is_file(), result.stderr


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_stdin_end_of_file_shuts_the_session_down() -> None:
    """Closing host stdin stands in for the pane closing."""
    result = _run_host(
        [sys.executable, "-c", "import time; time.sleep(30)"], timeout=25.0
    )
    assert result.code == 1


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
def test_stdin_end_of_file_ends_hidden_console_programs(tmp_path: Path) -> None:
    """The stdin end of a session sweeps like a kill and a natural exit do.

    The plugin's end of the host's stdin closes when Obsidian lets go of the
    host without a kill; the session then ends through this path.
    """
    ready_file = tmp_path / "sleeper.json"
    launcher = tmp_path / "launcher.py"
    launcher.write_text(
        "import json, os, subprocess, sys, time\n"
        "child = subprocess.Popen(\n"
        "    [sys.executable, '-c', 'import time; time.sleep(120)'],\n"
        "    stdin=subprocess.DEVNULL,\n"
        "    stdout=subprocess.DEVNULL,\n"
        "    stderr=subprocess.DEVNULL,\n"
        "    creationflags=subprocess.CREATE_NO_WINDOW,\n"
        ")\n"
        f"path = {str(ready_file)!r}\n"
        "with open(path + '.tmp', 'w', encoding='utf-8') as stream:\n"
        "    json.dump({'pid': child.pid}, stream)\n"
        "os.replace(path + '.tmp', path)\n"
        "print('SLEEPER-UP', flush=True)\n"
        "time.sleep(120)\n",
        encoding="utf-8",
    )
    pinned: list[int] = []
    with closing(_ProcessWatch()) as watch:

        def pin(ready: Mapping[str, object]) -> None:
            """Pin the shell and the sleeper; stdin closes once it is up."""
            pinned.append(_pin_shell_and_published_pid(watch, ready, ready_file, 30.0))

        result = _run_host(
            [getattr(sys, "_base_executable", sys.executable), str(launcher)],
            stdout_ready=b"SLEEPER-UP",
            ready_probe=pin,
            timeout=60.0,
        )
        assert len(pinned) == 1, result
        assert result.messages[-1] == {"event": "exit", "code": result.code}
        assert watch.survivors(15.0) == [], result.stderr


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


@pytest.mark.skipif(sys.platform != "win32", reason=_WINDOWS_ONLY)
@pytest.mark.parametrize("deferred", (False, True), ids=("immediate", "deferred"))
def test_session_end_sweeps_after_a_console_host_fallback(
    tmp_path: Path, deferred: bool
) -> None:
    """A shell that runs on the built-in host after a fallback is tracked too.

    The fallback starts the shell again on the built-in console host; that
    shell, the one that runs, must sit in the tracking jobs, so the program
    it leaves in a hidden console ends with the session.
    """
    console_host = tmp_path / "OpenConsole.exe"
    system = os.path.join(os.environ["SystemRoot"], "System32")
    shutil.copyfile(os.path.join(system, "hostname.exe"), console_host)
    ready_file = tmp_path / "sleeper.json"
    exit_gate = tmp_path / "shell-exit"
    launcher = tmp_path / "launcher.py"
    _write_hidden_sleeper_launcher(launcher, ready_file, exit_gate)
    pinned: list[int] = []
    with closing(_ProcessWatch()) as watch:

        def pin_before_kill(ready: Mapping[str, object]) -> None:
            """Pin the shell and the sleeper before the kill."""
            pinned.append(_pin_shell_and_published_pid(watch, ready, ready_file, 45.0))

        result = _run_host(
            [getattr(sys, "_base_executable", sys.executable), str(launcher)],
            close_stdin=False,
            replies=({"op": "kill"},),
            ready_probe=pin_before_kill,
            timeout=60.0,
            deferred=deferred,
            console_host="auto",
            host_script=_stub_console_host_script(tmp_path, console_host),
        )
        assert len(pinned) == 1, result
        report = _ready_report(result)
        assert (report["engine"], report["fallback"]) == ("conhost", "exited"), result
        assert result.messages[-1] == {"event": "exit", "code": result.code}
        assert watch.survivors(15.0) == [], result.stderr


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
