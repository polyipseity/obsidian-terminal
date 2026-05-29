"""Regression tests for the Unix PTY proxy lifecycle.

These tests validate host-disconnect behavior in
``src/terminal/unix_pseudoterminal.py`` without spawning real PTYs.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

"""Public API of this test module (empty)."""
__all__ = ()


def _load_unix_pseudoterminal_module() -> ModuleType:
    """Load the Unix PTY proxy module from source for monkeypatching tests."""
    path = Path(__file__).parents[3] / "src/terminal/unix_pseudoterminal.py"
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

    The selector can emit at most one configured event and then returns empty
    selections. If `select()` is called too many times, it raises an error to
    catch loops that should have stopped.
    """

    def __init__(self, event_fd: int, max_select_calls: int = 3) -> None:
        """Initialize with the file descriptor to emit and a loop guard."""
        self._callbacks: dict[int, Callable[[], None]] = {}
        self._event_fd = event_fd
        self._emitted = False
        self._select_calls = 0
        self._max_select_calls = max_select_calls

    def __enter__(self) -> _FakeSelector:
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
        """Return one synthetic event and then idle forever.

        A guard raises when too many `select()` calls occur, which catches
        loops that fail to stop after host disconnect.
        """
        self._select_calls += 1
        if self._select_calls > self._max_select_calls:
            raise RuntimeError("select loop did not terminate")

        if not self._emitted and self._event_fd in self._callbacks:
            self._emitted = True
            callback = self._callbacks[self._event_fd]
            if callback is None:
                raise AssertionError(self._event_fd)
            return [(SimpleNamespace(data=callback), 1)]
        return []


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

    monkeypatch.setattr(module, "fork", lambda: (1234, 99))
    monkeypatch.setattr(module, "DefaultSelector", lambda: _FakeSelector(module._STDIN))
    monkeypatch.setattr(module, "exit", fake_exit)
    monkeypatch.setattr(module, "getpgid", lambda _pid: 1234, raising=False)
    monkeypatch.setattr(module, "getppid", lambda: 4242, raising=False)
    monkeypatch.setattr(module, "killpg", fake_killpg, raising=False)
    monkeypatch.setattr(module, "read", fake_read)
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

    monkeypatch.setattr(module, "fork", lambda: (55, 77))
    monkeypatch.setattr(module, "DefaultSelector", lambda: _FakeSelector(77))
    monkeypatch.setattr(module, "exit", fake_exit)
    monkeypatch.setattr(module, "getpgid", lambda _pid: 55, raising=False)
    monkeypatch.setattr(module, "getppid", lambda: 4242, raising=False)
    monkeypatch.setattr(module, "killpg", fake_killpg, raising=False)
    monkeypatch.setattr(module, "read", fake_read)
    monkeypatch.setattr(module, "sleep", lambda _seconds: None, raising=False)
    monkeypatch.setattr(module, "waitpid", lambda pid, _flags: (pid, 0))
    monkeypatch.setattr(module, "waitstatus_to_exitcode", lambda status: status)

    with pytest.raises(SystemExit) as raised:
        module.main()

    assert raised.value.code == 0
    assert signal_calls == []
