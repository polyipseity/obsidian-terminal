"""Regression tests for the Unix PTY proxy lifecycle.

These tests validate host-disconnect behavior, input buffering, resize frames
and the exit status in ``src/terminal/unix_pseudoterminal.py`` with
deterministic doubles and real proxies.
"""

from __future__ import annotations

import errno
import hashlib
import itertools
import os
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager, suppress
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from selectors import EVENT_READ, EVENT_WRITE, BaseSelector, DefaultSelector
from types import ModuleType, SimpleNamespace

import pytest
from typing_extensions import Self, override

"""Public API of this test module (empty)."""
__all__ = ()

"""Bytes of input sent in one burst: more than a PTY takes while its child
does not read. That was 1022 bytes on macOS, and about 20 KiB in the one Linux
run measured (kernel 7.0, aarch64)."""
_BURST_BYTES = 256 * 1024

"""Bytes the burst child writes before it reads the rest of its input: more
than the PTY's output queue holds, so the child blocks unless the proxy keeps
reading."""
_FLOOD_BYTES = 1024 * 1024

"""Bytes offered to a child that never reads: more than twice what the PTY,
the proxy's input buffer and the pipe to the proxy hold together (a pipe holds
up to 1 MiB on Linux with 64 KiB pages)."""
_PENDING_BYTES = 4 * 1024 * 1024

"""Bytes of input the proxy holds for a PTY that takes no more, before it
stops reading its stdin: the proxy's `_INPUT_BUFFER_LIMIT`. Stated here, so
that the real-proxy tests describe the proxy from outside."""
_HELD_BYTES = 64 * 1024

"""Counts the markers this process has handed out."""
_MARKER_COUNT = itertools.count()

"""Child that takes the first byte of a burst, writes `_FLOOD_BYTES` without
reading, then reads the rest and reports the size and SHA-256 of its input.

Raw mode matters: a terminal in canonical mode discards input past its line
limit instead of making the writer wait."""
_BURST_CHILD = """
import hashlib, os, sys, termios, tty
total, flood = int(sys.argv[2]), int(sys.argv[3])
tty.setraw(0)
os.write(1, b"READY\\n")
digest = hashlib.sha256()
data = os.read(0, 1)
digest.update(data)
count = len(data)
block = b"o" * 4096
while flood:
    flood -= os.write(1, block[:flood])
while count < total:
    data = os.read(0, 65536)
    if not data:
        break
    digest.update(data)
    count += len(data)
os.write(1, b"\\nGOT %d %s\\n" % (count, digest.hexdigest().encode()))
termios.tcdrain(1)
"""

"""Child that never reads its input. Its sleep duration is the test's marker."""
_DEAF_CHILD = """
import os, sys, time, tty
tty.setraw(0)
os.write(1, b"READY\\n")
time.sleep(float(sys.argv[1]))
"""

"""Child that never reads its input and reports the terminal's size whenever
it changes. Its sleep duration is the test's marker."""
_RESIZED_CHILD = """
import os, signal, sys, time, tty
def report(_signal_number, _frame):
    size = os.get_terminal_size(0)
    os.write(1, b"SIZE %d %d\\n" % (size.columns, size.lines))
tty.setraw(0)
signal.signal(signal.SIGWINCH, report)
os.write(1, b"READY\\n")
time.sleep(float(sys.argv[1]))
"""

"""Child that never reads its input. Once the file named by its second
argument exists, it writes a last line and exits with status 7."""
_EXITING_CHILD = """
import os, sys, termios, time, tty
tty.setraw(0)
os.write(1, b"READY\\n")
while not os.path.exists(sys.argv[2]):
    time.sleep(0.01)
os.write(1, b"BYE\\n")
termios.tcdrain(1)
sys.exit(7)
"""

"""Child that reads nothing until the file named by its second argument
exists, then discards the terminal's input queue and reads until the line
`END`, or until no input comes for 3 seconds. It reports the bytes it read and
which of the two ended the reading.

Its third argument says how it discards the queue: `tcflush`, or `tcsaflush`
for setting the terminal's attributes with TCSAFLUSH, as `getpass` and
`tty.setraw` do.

The terminal stays in canonical mode, without echo: complete lines make the
writer wait once the queue is full, and nothing is written back."""
_DISCARDING_CHILD = """
import os, select, sys, termios, time
attributes = termios.tcgetattr(0)
attributes[3] &= ~termios.ECHO
termios.tcsetattr(0, termios.TCSANOW, attributes)
os.write(1, b"READY\\n")
while not os.path.exists(sys.argv[2]):
    time.sleep(0.01)
if sys.argv[3] == "tcflush":
    termios.tcflush(0, termios.TCIFLUSH)
else:
    termios.tcsetattr(0, termios.TCSAFLUSH, attributes)
count, ending = 0, b"STALLED"
while select.select([0], [], [], 3.0)[0]:
    data = os.read(0, 65536)
    count += len(data)
    if not data or data.endswith(b"END\\n"):
        ending = b"END" if data else b"EOF"
        break
os.write(1, b"GOT %d %s\\n" % (count, ending))
termios.tcdrain(1)
"""

"""Stand-in for a proxy that has closed its stdin and keeps its stdout open."""
_CLOSED_STDIN_STAND_IN = """
import os, time
os.close(0)
os.write(1, b"READY\\n")
time.sleep(60)
"""

"""Stand-in for a proxy that reads nothing and never stops writing."""
_ENDLESS_OUTPUT_STAND_IN = """
import os, time
os.write(1, b"READY\\n")
while True:
    os.write(1, b".")
    time.sleep(0.01)
"""


def _module_path() -> Path:
    """Return the filesystem path to the Unix PTY proxy module."""
    return Path(__file__).parents[3] / "src/terminal/unix_pseudoterminal.py"


def _load_unix_pseudoterminal_module() -> ModuleType:
    """Load the Unix PTY proxy module from source for monkeypatching tests."""
    path = _module_path()
    spec = spec_from_file_location("tests_unix_pseudoterminal_module", path)
    if spec is None or spec.loader is None:
        raise AssertionError(path)
    module = module_from_spec(spec)
    with open(os.devnull, "rb") as stdin_file, open(os.devnull, "wb") as stdout_file:
        old_stdin = sys.stdin
        old_stdout = sys.stdout
        try:
            sys.stdin = stdin_file
            sys.stdout = stdout_file
            spec.loader.exec_module(module)
        finally:
            sys.stdin = old_stdin
            sys.stdout = old_stdout
    return module


class _FakeSelector:
    """A deterministic selector test double.

    The selector emits all configured events in one batch and then returns
    empty selections. If `select()` is called too many times, it raises an
    error to catch loops that should have stopped.
    """

    def __init__(
        self, event_fd: int | Sequence[int], max_select_calls: int = 3
    ) -> None:
        """Initialize with one or more file descriptors to emit."""
        self._callbacks: dict[int, Callable[[int], None]] = {}
        self._event_fds = (event_fd,) if isinstance(event_fd, int) else tuple(event_fd)
        self._emitted = False
        self._select_calls = 0
        self._max_select_calls = max_select_calls

    def __enter__(self) -> Self:
        """Return the context-managed selector instance."""
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        """Clear callbacks on context exit."""
        self._callbacks.clear()

    def register(self, fd: int, _event: int, callback: Callable[[int], None]) -> None:
        """Register a callback for the given file descriptor."""
        self._callbacks[fd] = callback

    def modify(self, fd: int, _event: int, callback: Callable[[int], None]) -> None:
        """Replace the callback for the given file descriptor."""
        self._callbacks[fd] = callback

    def unregister(self, fd: int) -> None:
        """Unregister the callback for the given file descriptor."""
        self._callbacks.pop(fd, None)

    def select(self, _timeout: float | None = None) -> list[tuple[object, int]]:
        """Return one synthetic batch and then idle forever.

        A guard raises when too many `select()` calls occur, which catches
        loops that fail to stop after host disconnect.
        """
        self._select_calls += 1
        if self._select_calls > self._max_select_calls:
            raise RuntimeError("select loop did not terminate")

        if not self._emitted:
            events: list[tuple[object, int]] = [
                (SimpleNamespace(data=self._callbacks[fd]), 1)
                for fd in self._event_fds
                if fd in self._callbacks
            ]
            if events:
                self._emitted = True
                return events
        return []


def _patch_proxy(
    monkeypatch: pytest.MonkeyPatch,
    module: ModuleType,
    *,
    fork_result: tuple[int, int],
    event_fd: int | Sequence[int],
    killpg: Callable[[int, int], None],
    waitpid: Callable[[int, int], tuple[int, int]],
    close: Callable[[int], None] | None = None,
    sleep: Callable[[float], None] | None = None,
    group_alive: Callable[[int], bool] | None = None,
) -> None:
    """Apply common deterministic patches for proxy shutdown unit tests."""
    monkeypatch.setattr(module, "fork", lambda: fork_result)
    monkeypatch.setattr(
        module, "set_blocking", lambda _fd, _blocking: None, raising=False
    )
    monkeypatch.setattr(module, "DefaultSelector", lambda: _FakeSelector(event_fd))
    monkeypatch.setattr(module, "getppid", lambda: 4242, raising=False)
    monkeypatch.setattr(module, "read", lambda *_: b"")
    monkeypatch.setattr(module, "killpg", killpg, raising=False)
    monkeypatch.setattr(module, "waitpid", waitpid)
    monkeypatch.setattr(module, "close", close or (lambda _fd: None))
    monkeypatch.setattr(module, "sleep", sleep or (lambda _s: None), raising=False)
    monkeypatch.setattr(
        module,
        "_group_alive",
        group_alive or (lambda _pgid: False),
        raising=False,
    )
    monkeypatch.setattr(module, "waitstatus_to_exitcode", lambda status: status)


def test_main_stops_on_stdin_eof_and_terminates_child_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When host stdin closes, main should stop promptly and signal child group."""
    module = _load_unix_pseudoterminal_module()
    signal_calls: list[int] = []

    def fake_exit(code: int) -> None:
        """Raise `SystemExit` to let tests assert the exit code."""
        raise SystemExit(code)

    def fake_read(fd: int, _chunk_size: int) -> bytes:
        """Return EOF for stdin and no PTY data for all other descriptors."""
        if fd == module._STDIN:
            return b""
        return b""

    def fake_killpg(_pgid: int, signal: int) -> None:
        """Record each signal used to terminate the child process group."""
        signal_calls.append(signal)

    def fake_close(_fd: int) -> None:
        """Ignore PTY closure after the host disconnects."""

    monkeypatch.setattr(module, "fork", lambda: (1234, 99))
    monkeypatch.setattr(
        module, "set_blocking", lambda _fd, _blocking: None, raising=False
    )
    monkeypatch.setattr(module, "DefaultSelector", lambda: _FakeSelector(module._STDIN))
    monkeypatch.setattr(module, "exit", fake_exit)
    monkeypatch.setattr(module, "getppid", lambda: 4242, raising=False)
    monkeypatch.setattr(module, "killpg", fake_killpg, raising=False)
    monkeypatch.setattr(module, "_group_alive", lambda _pgid: False, raising=False)
    monkeypatch.setattr(module, "read", fake_read)
    monkeypatch.setattr(module, "close", fake_close)
    monkeypatch.setattr(module, "sleep", lambda _seconds: None, raising=False)
    monkeypatch.setattr(module, "waitpid", lambda pid, _flags: (pid, 0))
    monkeypatch.setattr(module, "waitstatus_to_exitcode", lambda status: status)

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 0
    assert signal_calls
    assert signal_calls[0] == module._TERMINATION_SEQUENCE[0][0]


def test_main_does_not_terminate_group_when_pty_exits_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the PTY side closes first, main should not signal the child group."""
    module = _load_unix_pseudoterminal_module()
    signal_calls: list[int] = []

    def fake_exit(code: int) -> None:
        """Raise `SystemExit` to let tests assert the exit code."""
        raise SystemExit(code)

    def fake_read(fd: int, _chunk_size: int) -> bytes:
        """Return PTY EOF and no stdin payload."""
        if fd == 77:
            return b""
        return b""

    def fake_killpg(_pgid: int, signal: int) -> None:
        """Record each signal if the proxy attempts group termination."""
        signal_calls.append(signal)

    def fake_close(_fd: int) -> None:
        """Ignore PTY closure if the PTY side closes first."""

    monkeypatch.setattr(module, "fork", lambda: (55, 77))
    monkeypatch.setattr(
        module, "set_blocking", lambda _fd, _blocking: None, raising=False
    )
    monkeypatch.setattr(module, "DefaultSelector", lambda: _FakeSelector(77))
    monkeypatch.setattr(module, "exit", fake_exit)
    monkeypatch.setattr(module, "getppid", lambda: 4242, raising=False)
    monkeypatch.setattr(module, "killpg", fake_killpg, raising=False)
    monkeypatch.setattr(module, "_group_alive", lambda _pgid: False, raising=False)
    monkeypatch.setattr(module, "read", fake_read)
    monkeypatch.setattr(module, "close", fake_close)
    monkeypatch.setattr(module, "sleep", lambda _seconds: None, raising=False)
    monkeypatch.setattr(module, "waitpid", lambda pid, _flags: (pid, 0))
    monkeypatch.setattr(module, "waitstatus_to_exitcode", lambda status: status)

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 0
    assert signal_calls == []


def test_teardown_stops_after_child_exits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop signaling when the process group is quiet after the first signal."""
    module = _load_unix_pseudoterminal_module()
    signal_calls: list[int] = []
    events: list[str] = []

    def fake_killpg(_pgid: int, signal: int) -> None:
        """Record each signal used to terminate the child process group."""
        signal_calls.append(signal)
        events.append(f"killpg:{signal}")

    def fake_close(fd: int) -> None:
        """Record PTY closure before the first termination signal."""
        assert fd == 99
        events.append("close")

    def fake_waitpid(pid: int, flags: int) -> tuple[int, int]:
        """Report immediate signal-encoded exit and reject blocking waits."""
        if flags == 0:
            raise AssertionError(
                "blocking waitpid must not run after the shell was collected"
            )
        events.append("waitpid")
        return pid, 1

    _patch_proxy(
        monkeypatch,
        module,
        fork_result=(1234, 99),
        event_fd=module._STDIN,
        killpg=fake_killpg,
        waitpid=fake_waitpid,
        close=fake_close,
        group_alive=lambda _pgid: False,
    )
    monkeypatch.setattr(
        module, "waitstatus_to_exitcode", lambda status: -1 if status == 1 else status
    )

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 0
    assert signal_calls == [module.SIGHUP]
    assert events == ["close", f"killpg:{module.SIGHUP}", "waitpid"]
    assert events.index("close") < events.index(f"killpg:{module.SIGHUP}")


@pytest.mark.parametrize(("collectable_after", "exit_code"), [(1, 0), (None, 1)])
def test_teardown_waits_for_a_shell_that_cannot_be_collected_yet(
    monkeypatch: pytest.MonkeyPatch,
    collectable_after: int | None,
    exit_code: int,
) -> None:
    """Poll for the shell's status when its group is quiet before it is a zombie."""
    module = _load_unix_pseudoterminal_module()
    signal_calls: list[int] = []
    slept: list[float] = []
    polls = 0

    def fake_killpg(_pgid: int, signal_number: int) -> None:
        """Record each signal used to terminate the child process group."""
        signal_calls.append(signal_number)

    def fake_sleep(seconds: float) -> None:
        """Record polling intervals without delaying the test."""
        slept.append(seconds)

    def fake_waitpid(pid: int, flags: int) -> tuple[int, int]:
        """Report nothing to collect for the first polls; reject blocking waits."""
        nonlocal polls
        if flags == 0:
            raise AssertionError("blocking waitpid should not run during teardown")
        polls += 1
        if collectable_after is None or polls <= collectable_after:
            return 0, 0
        return pid, 1

    _patch_proxy(
        monkeypatch,
        module,
        fork_result=(1234, 99),
        event_fd=module._STDIN,
        killpg=fake_killpg,
        waitpid=fake_waitpid,
        sleep=fake_sleep,
        group_alive=lambda _pgid: False,
    )

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == exit_code
    assert signal_calls == [module.SIGHUP]
    # The polling ends with the grace period of the signal that was sent.
    assert sum(slept) <= module._TERMINATION_SEQUENCE[0][1] + 0.01


def test_shutdown_request_with_pty_eof_exits_zero(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Report success when host shutdown and PTY EOF arrive in one batch."""
    module = _load_unix_pseudoterminal_module()
    signal_calls: list[int] = []

    def fake_killpg(_pgid: int, signal_number: int) -> None:
        """Record any unexpected process-group termination attempt."""
        signal_calls.append(signal_number)

    def fake_waitpid(pid: int, _flags: int) -> tuple[int, int]:
        """Return a signal-encoded status for polling and blocking waits."""
        return pid, 1

    _patch_proxy(
        monkeypatch,
        module,
        fork_result=(1234, 99),
        event_fd=(module._STDIN, 99),
        killpg=fake_killpg,
        waitpid=fake_waitpid,
    )
    monkeypatch.setattr(
        module, "waitstatus_to_exitcode", lambda status: -1 if status == 1 else status
    )

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 0
    assert signal_calls == []


def test_teardown_survives_killpg_permission_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Continue polling when a process-group signal raises PermissionError."""
    module = _load_unix_pseudoterminal_module()
    signal_calls: list[int] = []
    term_attempted = False

    def fake_killpg(_pgid: int, _signal: int) -> None:
        """Allow SIGHUP, then deny SIGTERM after recording the attempt."""
        nonlocal term_attempted
        signal_calls.append(_signal)
        if _signal == module.SIGTERM:
            term_attempted = True
            raise PermissionError

    def fake_waitpid(pid: int, flags: int) -> tuple[int, int]:
        """Report the collected shell status after the group becomes quiet."""
        if flags == 0:
            raise AssertionError(
                "blocking waitpid must not run after the shell was collected"
            )
        return pid, 0

    def fake_group_alive(_pgid: int) -> bool:
        """Keep the group alive through SIGHUP, then report it as quiet."""
        return not term_attempted

    _patch_proxy(
        monkeypatch,
        module,
        fork_result=(1234, 99),
        event_fd=module._STDIN,
        killpg=fake_killpg,
        waitpid=fake_waitpid,
        group_alive=fake_group_alive,
    )

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 0
    assert signal_calls == [module.SIGHUP, module.SIGTERM]


def test_teardown_bounded_when_child_unsignalable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Exit with failure after the bounded wait when no signal can be delivered."""
    module = _load_unix_pseudoterminal_module()
    slept: list[float] = []
    close_calls: list[int] = []

    def fake_killpg(_pgid: int, _signal: int) -> None:
        """Reject every group signal to exercise the unsignalable path."""
        raise PermissionError

    def fake_sleep(seconds: float) -> None:
        """Record bounded polling intervals without delaying the test."""
        slept.append(seconds)

    def fake_waitpid(_pid: int, flags: int) -> tuple[int, int]:
        """Report that the child remains running and reject blocking waits."""
        if flags == 0:
            raise AssertionError(
                "blocking waitpid should not run after failed teardown"
            )
        return 0, 0

    def fake_close(fd: int) -> None:
        """Record closure of the PTY descriptor before failure exit."""
        close_calls.append(fd)

    _patch_proxy(
        monkeypatch,
        module,
        fork_result=(1234, 99),
        event_fd=module._STDIN,
        killpg=fake_killpg,
        waitpid=fake_waitpid,
        close=fake_close,
        sleep=fake_sleep,
        group_alive=lambda _pgid: True,
    )

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 1
    assert 3.9 <= sum(slept) <= 4.0 + 0.01
    assert close_calls == [99]


def test_teardown_ends_group_members_after_shell_exits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Continue signaling after the shell exits while a group member remains."""
    module = _load_unix_pseudoterminal_module()
    signal_calls: list[int] = []
    slept: list[float] = []
    term_signal_elapsed: list[float] = []
    term_sent = False

    def fake_killpg(_pgid: int, signal_number: int) -> None:
        """Record group signals and the elapsed SIGHUP grace period."""
        nonlocal term_sent
        signal_calls.append(signal_number)
        if signal_number == module.SIGTERM:
            term_signal_elapsed.append(sum(slept))
            term_sent = True

    def fake_sleep(seconds: float) -> None:
        """Record polling intervals without delaying the test."""
        slept.append(seconds)

    def fake_group_alive(_pgid: int) -> bool:
        """Keep a remaining group member alive until SIGTERM is sent."""
        return not term_sent

    def fake_waitpid(pid: int, flags: int) -> tuple[int, int]:
        """Return the collected shell status without allowing a blocking wait."""
        if flags == 0:
            raise AssertionError("blocking waitpid should not run after teardown")
        return pid, 0

    _patch_proxy(
        monkeypatch,
        module,
        fork_result=(1234, 99),
        event_fd=module._STDIN,
        killpg=fake_killpg,
        waitpid=fake_waitpid,
        sleep=fake_sleep,
        group_alive=fake_group_alive,
    )

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 0
    assert signal_calls == [module.SIGHUP, module.SIGTERM]
    assert 0.95 <= term_signal_elapsed[0] <= 1.06


@contextmanager
def _socket_pty() -> Iterator[tuple[int, socket.socket]]:
    """Yield a non-blocking descriptor that stands in for the PTY, and its peer.

    A socket pair does what matters here: it takes a bounded amount of input
    and then reports that a write would block, until the peer reads.
    """
    ours, peer = socket.socketpair()
    ours.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
    ours.setblocking(False)
    peer.setblocking(False)
    try:
        yield ours.fileno(), peer
    finally:
        ours.close()
        peer.close()


def _drive(
    selector: BaseSelector,
    *,
    until: Callable[[], bool],
    each: Callable[[], None] | None = None,
) -> None:
    """Dispatch selector events as the proxy's loop does until `until` holds."""
    deadline = time.monotonic() + 5.0
    while not until():
        if time.monotonic() > deadline:
            raise TimeoutError("the handlers made no progress")
        for key, mask in selector.select(0.05):
            key.data(mask)
        if each is not None:
            each()


@pytest.fixture
def _deadline() -> Iterator[None]:
    """Fail a handler test that blocks instead of letting it hang the run."""

    def expire(_signal_number: int, _frame: object) -> None:
        """End the test from inside whatever call is blocking it.

        The outcome is not an `Exception`, so the handlers cannot swallow it.
        """
        raise pytest.fail.Exception("a handler blocked for 10 seconds")

    if not hasattr(signal, "SIGALRM"):
        # Windows has no alarm; the tests that can block are POSIX-only.
        yield
        return
    previous = signal.signal(signal.SIGALRM, expire)
    signal.alarm(10)  # ty: ignore[possibly-missing-attribute]
    try:
        yield
    finally:
        signal.alarm(0)  # ty: ignore[possibly-missing-attribute]
        signal.signal(signal.SIGALRM, previous)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
@pytest.mark.usefixtures("_deadline")
def test_pty_handler_writes_at_once_what_the_pty_takes() -> None:
    """Write input straight through while the PTY has room for it."""
    module = _load_unix_pseudoterminal_module()
    # Less than the stand-in takes, and more than one small write.
    payload = bytes(range(256)) * 8
    with (
        _socket_pty() as (fd, peer),
        DefaultSelector() as selector,
        module._PipePty(selector, fd) as pipe_pty,
    ):
        pipe_pty.feed(payload)

        # All of it is there before the selector has had a turn.
        assert peer.recv(4096) == payload
        assert pipe_pty.accepting
        # Nothing waits, so the PTY is not watched for room.
        assert selector.get_key(fd).events == EVENT_READ


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
@pytest.mark.usefixtures("_deadline")
def test_pty_handler_keeps_input_the_pty_cannot_take() -> None:
    """Hold back what the PTY refuses and write it, in order, once it has room."""
    module = _load_unix_pseudoterminal_module()
    payload = bytes(range(256)) * 4096
    received = bytearray()
    with (
        _socket_pty() as (fd, peer),
        DefaultSelector() as selector,
        module._PipePty(selector, fd) as pipe_pty,
    ):
        pipe_pty.feed(payload)

        # Part of the input waits, so the PTY is watched for room.
        assert not pipe_pty.accepting
        assert selector.get_key(fd).events == EVENT_READ | EVENT_WRITE

        def drain() -> None:
            """Read what the stand-in PTY holds, as the child would."""
            with suppress(BlockingIOError):
                received.extend(peer.recv(65536))

        _drive(selector, until=lambda: len(received) >= len(payload), each=drain)

        assert hashlib.sha256(received).digest() == hashlib.sha256(payload).digest()
        assert pipe_pty.accepting
        # Nothing waits any more: a writable PTY must not wake the loop.
        assert selector.get_key(fd).events == EVENT_READ
        assert selector.select(0) == []


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
@pytest.mark.usefixtures("_deadline")
def test_stdin_waits_while_the_input_buffer_is_full(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Leave input in the host's pipe while the buffer is full, then take it."""
    module = _load_unix_pseudoterminal_module()
    stdin_read, stdin_write = os.pipe()
    monkeypatch.setattr(module, "_STDIN", stdin_read)
    backlog = b"a" * (module._INPUT_BUFFER_LIMIT + 256 * 1024)
    received = bytearray()
    try:
        with (
            _socket_pty() as (fd, peer),
            DefaultSelector() as selector,
            module._PipePty(selector, fd) as pipe_pty,
            module._PipeStdin(selector, pipe_pty) as pipe_stdin,
        ):
            pipe_pty.feed(backlog)
            os.write(stdin_write, b"typed")
            pipe_stdin.throttle()

            # The host is still there; it only has to wait.
            assert pipe_stdin.registered
            with pytest.raises(KeyError):
                selector.get_key(stdin_read)
            # A read event from before the buffer filled reads nothing.
            pipe_stdin._on_event(EVENT_READ)
            assert select.select([stdin_read], [], [], 0)[0] == [stdin_read]

            def step() -> None:
                """Read as the child would, then let the loop throttle."""
                with suppress(BlockingIOError):
                    received.extend(peer.recv(65536))
                pipe_stdin.throttle()

            _drive(
                selector,
                until=lambda: len(received) >= len(backlog) + 5,
                each=step,
            )

            assert received[-5:] == b"typed"
            assert len(received) == len(backlog) + 5
            assert selector.get_key(stdin_read).events == EVENT_READ
    finally:
        os.close(stdin_read)
        os.close(stdin_write)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
@pytest.mark.usefixtures("_deadline")
def test_pty_read_that_would_block_is_not_eof(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep the PTY registered when a read finds nothing, until its real EOF."""
    module = _load_unix_pseudoterminal_module()
    stdout_read, stdout_write = os.pipe()
    monkeypatch.setattr(module, "_STDOUT", stdout_write)
    try:
        with (
            _socket_pty() as (fd, peer),
            DefaultSelector() as selector,
            module._PipePty(selector, fd) as pipe_pty,
        ):
            selector.get_key(fd).data(EVENT_READ)
            assert pipe_pty.registered

            peer.send(b"output")
            _drive(
                selector,
                until=lambda: bool(select.select([stdout_read], [], [], 0)[0]),
            )
            assert os.read(stdout_read, 64) == b"output"

            peer.close()
            _drive(selector, until=lambda: not pipe_pty.registered)
    finally:
        os.close(stdout_read)
        os.close(stdout_write)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
@pytest.mark.usefixtures("_deadline")
def test_pty_write_error_drops_the_queued_input() -> None:
    """Drop input for a PTY whose other side is gone instead of raising."""
    module = _load_unix_pseudoterminal_module()
    with (
        _socket_pty() as (fd, peer),
        DefaultSelector() as selector,
        module._PipePty(selector, fd) as pipe_pty,
    ):
        peer.close()

        pipe_pty.feed(b"late input")

        assert pipe_pty.accepting
        assert selector.get_key(fd).events == EVENT_READ
        # The read side reports the end of the PTY.
        _drive(selector, until=lambda: not pipe_pty.registered)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
def test_pty_read_error_is_the_end_of_the_pty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Take a failed PTY read as its end: Linux reports a closed PTY as EIO."""
    module = _load_unix_pseudoterminal_module()

    def fake_read(_fd: int, _size: int) -> bytes:
        """Fail as a Linux PTY master does once the child side is closed."""
        raise OSError(errno.EIO, os.strerror(errno.EIO))

    with (
        _socket_pty() as (fd, _peer),
        DefaultSelector() as selector,
        module._PipePty(selector, fd) as pipe_pty,
    ):
        monkeypatch.setattr(module, "read", fake_read)
        selector.get_key(fd).data(EVENT_READ)

        assert not pipe_pty.registered


def test_main_stops_watching_stdin_while_the_input_buffer_is_full(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop selecting on stdin once the buffer is full, so the loop can sleep."""
    module = _load_unix_pseudoterminal_module()
    watched: list[list[int]] = []

    class _Selector(_FakeSelector):
        """Report stdin readable once, then end the loop through the command pipe."""

        @override
        def select(self, _timeout: float | None = None) -> list[tuple[object, int]]:
            """Record what is watched, then emit the next scripted event."""
            if len(watched) == 2:
                raise RuntimeError("select loop did not terminate")
            watched.append(sorted(self._callbacks))
            fd = module._STDIN if len(watched) == 1 else module._CMDIO
            return [(SimpleNamespace(data=self._callbacks[fd]), EVENT_READ)]

    def fake_read(fd: int, _size: int) -> bytes:
        """Fill the buffer from stdin in one read; report EOF elsewhere."""
        return b"x" * module._INPUT_BUFFER_LIMIT if fd == module._STDIN else b""

    def fake_write(_fd: int, _data: bytes) -> int:
        """Refuse every write, as a PTY with a full input queue does."""
        raise BlockingIOError

    _patch_proxy(
        monkeypatch,
        module,
        fork_result=(1234, 99),
        event_fd=(),
        killpg=lambda _pgid, _signal: None,
        waitpid=lambda pid, _flags: (pid, 0),
    )
    # The module was loaded with a stand-in stdin, whose descriptor can be the
    # command pipe's number; the two have to differ here.
    monkeypatch.setattr(module, "_STDIN", 0)
    monkeypatch.setattr(module, "DefaultSelector", lambda: _Selector(()))
    monkeypatch.setattr(module, "read", fake_read)
    monkeypatch.setattr(module, "write", fake_write)

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 0
    assert len(watched) == 2
    assert module._STDIN in watched[0]
    assert module._STDIN not in watched[1]


def test_main_offers_held_input_again_without_a_writable_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Write held input on a turn with no events, then watch stdin again."""
    module = _load_unix_pseudoterminal_module()
    watched: list[list[int]] = []
    written = bytearray()

    class _Selector(_FakeSelector):
        """Report stdin readable, then nothing, then end through the command pipe."""

        @override
        def select(self, _timeout: float | None = None) -> list[tuple[object, int]]:
            """Record what is watched, then emit the next scripted event."""
            if len(watched) == 3:
                raise RuntimeError("select loop did not terminate")
            watched.append(sorted(self._callbacks))
            if len(watched) == 2:
                # The PTY has room now, and no event says so.
                return []
            fd = module._STDIN if len(watched) == 1 else module._CMDIO
            return [(SimpleNamespace(data=self._callbacks[fd]), EVENT_READ)]

    def fake_read(fd: int, _size: int) -> bytes:
        """Fill the buffer from stdin in one read; report EOF elsewhere."""
        return b"x" * module._INPUT_BUFFER_LIMIT if fd == module._STDIN else b""

    def fake_write(_fd: int, data: bytes) -> int:
        """Refuse input until the second turn, then take all of it."""
        if len(watched) < 2:
            raise BlockingIOError
        written.extend(data)
        return len(data)

    _patch_proxy(
        monkeypatch,
        module,
        fork_result=(1234, 99),
        event_fd=(),
        killpg=lambda _pgid, _signal: None,
        waitpid=lambda pid, _flags: (pid, 0),
    )
    # See test_main_stops_watching_stdin_while_the_input_buffer_is_full.
    monkeypatch.setattr(module, "_STDIN", 0)
    monkeypatch.setattr(module, "DefaultSelector", lambda: _Selector(()))
    monkeypatch.setattr(module, "read", fake_read)
    monkeypatch.setattr(module, "write", fake_write)

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 0
    assert bytes(written) == b"x" * module._INPUT_BUFFER_LIMIT
    assert module._STDIN not in watched[1]
    # The buffer emptied before the loop throttled stdin on the same turn.
    assert module._STDIN in watched[2]


def test_main_applies_a_resize_frame_while_the_input_buffer_is_full(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Set the window size from a frame although the PTY takes no input."""
    module = _load_unix_pseudoterminal_module()
    watched: list[list[int]] = []
    resizes: list[tuple[int, int, bytes]] = []

    class _Selector(_FakeSelector):
        """Report stdin readable once, then the command pipe twice."""

        @override
        def select(self, _timeout: float | None = None) -> list[tuple[object, int]]:
            """Record what is watched, then emit the next scripted event."""
            if len(watched) == 3:
                raise RuntimeError("select loop did not terminate")
            watched.append(sorted(self._callbacks))
            fd = module._STDIN if len(watched) == 1 else module._CMDIO
            return [(SimpleNamespace(data=self._callbacks[fd]), EVENT_READ)]

    def fake_read(fd: int, _size: int) -> bytes:
        """Fill the buffer from stdin; send one frame, then EOF, as commands."""
        if fd == module._STDIN:
            return b"x" * module._INPUT_BUFFER_LIMIT
        return b"80x24\n" if len(watched) == 2 else b""

    def fake_write(_fd: int, _data: bytes) -> int:
        """Refuse every write, as a PTY with a full input queue does."""
        raise BlockingIOError

    def fake_ioctl(fd: int, request: int, argument: bytes) -> None:
        """Record the window size set on the PTY."""
        resizes.append((fd, request, argument))

    _patch_proxy(
        monkeypatch,
        module,
        fork_result=(1234, 99),
        event_fd=(),
        killpg=lambda _pgid, _signal: None,
        waitpid=lambda pid, _flags: (pid, 0),
    )
    # See test_main_stops_watching_stdin_while_the_input_buffer_is_full.
    monkeypatch.setattr(module, "_STDIN", 0)
    monkeypatch.setattr(module, "DefaultSelector", lambda: _Selector(()))
    monkeypatch.setattr(module, "read", fake_read)
    monkeypatch.setattr(module, "write", fake_write)
    monkeypatch.setattr(module, "ioctl", fake_ioctl, raising=False)

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 0
    # The frame came while the buffer was full: stdin was not watched.
    assert module._STDIN not in watched[1]
    # 80 columns by 24 rows; the kernel's structure has the rows first.
    assert resizes == [(99, module.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))]


def _marker(seconds: int) -> str:
    """Return a sleep duration that no other live process on this machine uses."""
    return f"{seconds}.{os.getpid():07d}{next(_MARKER_COUNT) % 100:02d}"


@contextmanager
def _spawn_proxy(
    argv: list[str], marker: str
) -> Iterator[tuple[subprocess.Popen[bytes], int]]:
    """Spawn a real proxy and clean up its process and command pipe."""
    cmd_read, cmd_write = os.pipe()
    process: subprocess.Popen[bytes] | None = None

    def preexec() -> None:
        """Duplicate the resize pipe into the proxy's fixed command descriptor."""
        os.dup2(cmd_read, 3)

    try:
        process = subprocess.Popen(
            [sys.executable, str(_module_path()), *argv],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            preexec_fn=preexec,  # noqa: PLW1509
            pass_fds=(cmd_read, 3),
            close_fds=True,
        )
        os.close(cmd_read)
        cmd_read = -1
        process_stdout = process.stdout
        if process_stdout is None:
            raise AssertionError("proxy stdout pipe is unavailable")
        output = b""
        deadline = time.monotonic() + 5.0
        while not any(b"READY" in line for line in output.splitlines()):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("proxy did not become ready")
            ready_fds, _, _ = select.select([process_stdout], [], [], remaining)
            if not ready_fds:
                raise TimeoutError("proxy did not become ready")
            data = os.read(process_stdout.fileno(), 1024)
            if not data:
                raise AssertionError("proxy exited before becoming ready")
            output += data
        yield process, cmd_write
    finally:
        if cmd_read >= 0:
            with suppress(OSError):
                os.close(cmd_read)
        with suppress(OSError):
            os.close(cmd_write)
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        survivors = subprocess.run(
            ["pgrep", "-f", marker],
            capture_output=True,
            text=True,
            check=False,
        )
        for line in survivors.stdout.splitlines():
            with suppress(ValueError, ProcessLookupError):
                os.kill(int(line), 9)
        assert survivors.returncode != 0 or not survivors.stdout.strip()


def _pump(
    process: subprocess.Popen[bytes],
    payload: bytes,
    *,
    stall: float,
    limit: float = 30.0,
) -> tuple[bytes, int, bool]:
    """Offer `payload` to the proxy's stdin while draining its stdout.

    Return the output read, the number of payload bytes the proxy took, and
    whether the output reached EOF. Give up once no byte moves in either
    direction for `stall` seconds, or after `limit` seconds in all, so a proxy
    that is deadlocked or never stops writing fails the test instead of
    hanging it. The payload is written without blocking: a write that waited
    for the proxy would deadlock the test itself.
    """
    stdin, stdout = process.stdin, process.stdout
    if stdin is None or stdout is None:
        raise AssertionError("proxy pipes are unavailable")
    os.set_blocking(  # ty: ignore[possibly-missing-attribute]
        stdin.fileno(), False
    )
    view = memoryview(payload)
    sent = 0
    output = bytearray()
    offering = True
    moved = time.monotonic()
    deadline = moved + limit
    while True:
        wait = min(moved + stall, deadline) - time.monotonic()
        if wait <= 0:
            return bytes(output), sent, False
        pending = [stdin] if offering and sent < len(view) else []
        readable, writable, _ = select.select([stdout], pending, [], wait)
        if writable:
            taken = 0
            try:
                taken = os.write(stdin.fileno(), view[sent : sent + 65536])
            except BlockingIOError:
                pass
            except BrokenPipeError:
                # Nobody reads the pipe any more, and it stays writable: stop
                # offering. A proxy that died shows as the end of its output.
                offering = False
            if taken:
                sent += taken
                moved = time.monotonic()
        if readable:
            data = os.read(stdout.fileno(), 65536)
            if not data:
                return bytes(output), sent, True
            output += data
            moved = time.monotonic()


def _pipe_capacity() -> int:
    """Return how many bytes a pipe takes before a write to it would block."""
    read_end, write_end = os.pipe()
    try:
        os.set_blocking(  # ty: ignore[possibly-missing-attribute]
            write_end, False
        )
        capacity = 0
        with suppress(BlockingIOError):
            while True:
                capacity += os.write(write_end, bytes(65536))
        return capacity
    finally:
        os.close(read_end)
        os.close(write_end)


def _fill_input_buffer(process: subprocess.Popen[bytes]) -> None:
    """Offer a child that never reads more input than the proxy may hold.

    On return the proxy has taken a full input buffer out of its pipe and
    stopped reading. The pipe alone takes the first bytes whatever the proxy
    does, so only what went in beyond the pipe's capacity counts. A proxy that
    is slow to start gets 5 seconds before that count is judged.
    """
    capacity = _pipe_capacity()
    payload = b"x" * _PENDING_BYTES
    sent = 0
    deadline = time.monotonic() + 5.0
    while sent - capacity < _HELD_BYTES and time.monotonic() < deadline:
        output, taken, eof = _pump(process, payload[sent:], stall=0.5)
        assert not eof
        assert not output, output[:200]
        sent += taken
    assert sent - capacity >= _HELD_BYTES, (
        f"the proxy took {sent - capacity} bytes out of its pipe, "
        f"less than the {_HELD_BYTES} it holds"
    )
    # The proxy stopped taking input instead of holding all of it.
    assert sent <= len(payload) // 2


def _read_until(process: subprocess.Popen[bytes], token: bytes) -> bytes:
    """Read the proxy's output until it contains `token`, for up to 5 seconds."""
    stdout = process.stdout
    if stdout is None:
        raise AssertionError("proxy stdout pipe is unavailable")
    output = b""
    deadline = time.monotonic() + 5.0
    while token not in output:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([stdout], [], [], remaining)[0]:
            break
        data = os.read(stdout.fileno(), 65536)
        if not data:
            break
        output += data
    return output


@contextmanager
def _stand_in(program: str) -> Iterator[subprocess.Popen[bytes]]:
    """Run `program` in place of a proxy once it is ready, and end it afterwards."""
    with subprocess.Popen(
        [sys.executable, "-c", program],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
    ) as process:
        try:
            assert process.stdout is not None
            assert os.read(process.stdout.fileno(), 6) == b"READY\n"
            yield process
        finally:
            process.kill()


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
@pytest.mark.usefixtures("_deadline")
def test_pump_stops_offering_input_that_nobody_reads() -> None:
    """Give up on a proxy that closed its stdin instead of spinning on the pipe."""
    with _stand_in(_CLOSED_STDIN_STAND_IN) as process:
        assert _pump(process, b"x" * 65536, stall=0.2) == (b"", 0, False)


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
@pytest.mark.usefixtures("_deadline")
def test_pump_ends_at_its_limit_while_output_keeps_coming() -> None:
    """Give up on a proxy that never stops writing once the time limit passes."""
    with _stand_in(_ENDLESS_OUTPUT_STAND_IN) as process:
        output, _sent, eof = _pump(process, b"", stall=5.0, limit=0.5)

        assert output
        assert not eof


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
def test_real_proxy_exits_cleanly_on_host_disconnect() -> None:
    """Exit cleanly without a traceback when the host closes both input pipes."""
    marker = _marker(4000)
    with _spawn_proxy(
        ["/bin/sh", "-c", f"echo READY; exec sleep {marker}"], marker
    ) as (
        process,
        cmd_write,
    ):
        start = time.monotonic()
        os.close(cmd_write)
        _, stderr_data = process.communicate(timeout=5)
        elapsed = time.monotonic() - start

        assert process.returncode == 0
        assert stderr_data == b""
        assert elapsed < 3.0


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
@pytest.mark.skipif(shutil.which("zsh") is None, reason="zsh is unavailable")
def test_real_proxy_exits_promptly() -> None:
    """Exit an interactive shell promptly after both host pipes close."""
    zsh = shutil.which("zsh")
    assert zsh is not None
    marker = _marker(4000)
    with _spawn_proxy(
        [zsh, "-l", "-i", "-c", f"echo READY; sleep {marker}; exec zsh -l"],
        marker,
    ) as (process, cmd_write):
        os.write(cmd_write, b"24x80\n")
        start = time.monotonic()
        if process.stdin is None:
            raise AssertionError("proxy stdin pipe is unavailable")
        process.stdin.close()
        process.stdin = None
        os.close(cmd_write)
        _, stderr_data = process.communicate(timeout=5)
        elapsed = time.monotonic() - start

        assert process.returncode == 0
        assert stderr_data == b""
        assert elapsed < 3.0


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
def test_real_proxy_exits_zero_on_sigterm_with_stdin_open() -> None:
    """Exit cleanly when SIGTERM arrives while host pipes remain open."""
    marker = _marker(4000)
    with _spawn_proxy(
        ["/bin/sh", "-c", f"echo READY; exec sleep {marker}"], marker
    ) as (process, _cmd_write):
        process.send_signal(signal.SIGTERM)
        _, stderr_data = process.communicate(timeout=5)

        assert process.returncode == 0
        assert stderr_data == b""


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
def test_real_proxy_ends_nohup_child() -> None:
    """End a nohup child when the host disconnects from the proxy."""
    marker = _marker(9500)
    with _spawn_proxy(
        [
            "/bin/sh",
            "-c",
            f"echo READY; nohup sleep {marker} >/dev/null 2>&1 & wait",
        ],
        marker,
    ) as (process, cmd_write):
        time.sleep(0.1)
        start = time.monotonic()
        os.close(cmd_write)
        _, stderr_data = process.communicate(timeout=5)
        elapsed = time.monotonic() - start

        assert process.returncode == 0
        assert stderr_data == b""
        assert 0.9 <= elapsed <= 3.0


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
def test_real_proxy_delivers_input_burst_while_child_writes() -> None:
    """Deliver a whole burst of input to a child that writes before it reads."""
    marker = _marker(4000)
    payload = bytes(range(256)) * (_BURST_BYTES // 256)
    tail = f"\nGOT {len(payload)} {hashlib.sha256(payload).hexdigest()}\n".encode()
    child = [sys.executable, "-c", _BURST_CHILD, marker]
    with _spawn_proxy([*child, str(len(payload)), str(_FLOOD_BYTES)], marker) as (
        process,
        _cmd_write,
    ):
        output, sent, eof = _pump(process, payload, stall=5.0)

        assert (sent, eof) == (len(payload), True), (
            f"stalled after {sent} of {len(payload)} input bytes "
            f"and {len(output)} output bytes"
        )
        assert output[-len(tail) :] == tail
        assert len(output) == _FLOOD_BYTES + len(tail)
        assert output.count(b"o", 0, _FLOOD_BYTES) == _FLOOD_BYTES
        assert process.wait(timeout=5) == 0
        assert process.stderr is not None
        assert process.stderr.read() == b""


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
@pytest.mark.parametrize("how", ["tcflush", "tcsaflush"])
def test_real_proxy_delivers_held_input_after_the_child_discards_its_queue(
    tmp_path: Path, how: str
) -> None:
    """Deliver the input the proxy holds to a child that discarded its queue.

    Discarding the queue gives the PTY room without a read. On macOS the
    selector then never reports the PTY as writable, so a proxy that waits for
    that report holds the input for good. Not known to happen on Linux, where
    this test checks the delivery only.
    """
    marker = _marker(4000)
    discard = tmp_path / "discard"
    line = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\n"
    payload = line * (_BURST_BYTES // len(line)) + b"END\n"
    child = [sys.executable, "-c", _DISCARDING_CHILD, marker, str(discard), how]
    with _spawn_proxy(child, marker) as (process, _cmd_write):
        output, sent, eof = _pump(process, payload, stall=0.5)
        assert (output, eof) == (b"", False)

        discard.touch()
        output, taken, eof = _pump(process, payload[sent:], stall=5.0)

        assert (sent + taken, eof) == (len(payload), True), (
            f"stalled after {sent + taken} of {len(payload)} input bytes: "
            f"{output[-200:]!r}"
        )
        report = output.split()
        assert (report[0], report[2:]) == (b"GOT", [b"END"]), output[-200:]
        # The discarded queue is all that is missing.
        assert int(report[1]) >= len(payload) // 2
        assert process.wait(timeout=5) == 0
        assert process.stderr is not None
        assert process.stderr.read() == b""


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
@pytest.mark.parametrize("ending", ["sigterm", "disconnect"])
def test_real_proxy_ends_while_input_is_pending(ending: str) -> None:
    """End promptly although the child never reads the input sent to it."""
    marker = _marker(4000)
    with _spawn_proxy([sys.executable, "-c", _DEAF_CHILD, marker], marker) as (
        process,
        cmd_write,
    ):
        _fill_input_buffer(process)

        start = time.monotonic()
        if ending == "sigterm":
            process.send_signal(signal.SIGTERM)
        else:
            if process.stdin is None:
                raise AssertionError("proxy stdin pipe is unavailable")
            process.stdin.close()
            process.stdin = None
            os.close(cmd_write)
        returncode = process.wait(timeout=5)
        elapsed = time.monotonic() - start

        assert returncode == 0
        assert process.stderr is not None
        assert process.stderr.read() == b""
        assert elapsed < 3.0


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
def test_real_proxy_resizes_while_input_is_pending() -> None:
    """Apply a resize frame although the child never reads the input sent to it."""
    marker = _marker(4000)
    with _spawn_proxy([sys.executable, "-c", _RESIZED_CHILD, marker], marker) as (
        process,
        cmd_write,
    ):
        _fill_input_buffer(process)

        os.write(cmd_write, b"132x43\n")

        assert _read_until(process, b"\n") == b"SIZE 132 43\n"
        process.send_signal(signal.SIGTERM)
        assert process.wait(timeout=5) == 0
        assert process.stderr is not None
        assert process.stderr.read() == b""


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
def test_real_proxy_reports_the_child_exit_status_while_input_is_pending(
    tmp_path: Path,
) -> None:
    """Forward the child's last output and its exit status although input waits."""
    marker = _marker(4000)
    leave = tmp_path / "leave"
    child = [sys.executable, "-c", _EXITING_CHILD, marker, str(leave)]
    with _spawn_proxy(child, marker) as (process, _cmd_write):
        _fill_input_buffer(process)

        leave.touch()
        output, _sent, eof = _pump(process, b"", stall=5.0)

        assert (output, eof) == (b"BYE\n", True)
        assert process.wait(timeout=5) == 7
        assert process.stderr is not None
        assert process.stderr.read() == b""
