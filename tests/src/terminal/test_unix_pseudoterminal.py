"""Regression tests for the Unix PTY proxy lifecycle.

These tests validate host-disconnect behavior in
``src/terminal/unix_pseudoterminal.py`` with deterministic doubles and two real proxies.
"""

from __future__ import annotations

import os
import select
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager, suppress
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from typing_extensions import Self

"""Public API of this test module (empty)."""
__all__ = ()


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
        self._callbacks: dict[int, Callable[[], None]] = {}
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

    def register(self, fd: int, _event: int, callback: Callable[[], None]) -> None:
        """Register a callback for the given file descriptor."""
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


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX-only proxy")
def test_real_proxy_exits_cleanly_on_host_disconnect() -> None:
    """Exit cleanly without a traceback when the host closes both input pipes."""
    marker = f"4000.{time.monotonic_ns() % 1_000_000:06d}"
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
    marker = f"4000.{time.monotonic_ns() % 1_000_000:06d}"
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
    marker = f"4000.{time.monotonic_ns() % 1_000_000:06d}"
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
    marker = f"9500.{time.monotonic_ns() % 1_000_000:06d}"
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
