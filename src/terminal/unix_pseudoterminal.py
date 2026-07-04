"""Unix PTY proxy used by the terminal plugin.

This module implements a simple pseudoterminal bridge that spawns a child
process on a pty, proxies stdin/stdout, and accepts control frames on a
separate FD to update terminal window size.
"""

from __future__ import annotations

import sys
from contextlib import suppress
from os import (
    execvp,
    read,
    waitpid,
    waitstatus_to_exitcode,
    write,
)
from selectors import EVENT_READ, BaseSelector, DefaultSelector
from signal import SIGINT, SIGTERM, signal
from struct import pack
from sys import exit, stdin, stdout
from time import sleep
from types import FrameType, TracebackType

from typing_extensions import override

"""Public API of this module."""
__all__ = ("main",)

"""Chunk size in bytes used when reading from the PTY."""
_CHUNK_SIZE = 1024

"""File descriptor for stdin used by the PTY proxy."""
_STDIN = stdin.fileno()

"""File descriptor for stdout used by the PTY proxy."""
_STDOUT = stdout.fileno()

"""File descriptor that carries resize/control frames from the host."""
_CMDIO = 3


def write_all(fd: int, data: bytes) -> None:
    """Write all bytes to `fd`, handling partial writes.

    Repeatedly call `write` until all data is written.
    """
    while data:
        data = data[write(fd, data) :]


def _read_or_eof(fd: int) -> bytes:
    """Read a chunk from `fd` and normalize read errors to EOF bytes.

    The PTY proxy treats transient read failures the same as stream closure to
    simplify shutdown behavior across all pipes.
    """
    with suppress(OSError):
        return read(fd, _CHUNK_SIZE)
    return b""


def main() -> None:
    """Not available on Windows — resize proxy is POSIX-only here."""
    raise NotImplementedError(sys.platform)


if sys.platform != "win32":
    from fcntl import ioctl  # ty: ignore[possibly-missing-import]
    from os import getpgid, getppid, killpg  # ty: ignore[possibly-missing-import]
    from pty import fork  # ty: ignore[possibly-missing-import]
    from signal import SIGHUP, SIGKILL  # ty: ignore[possibly-missing-import]
    from termios import TIOCSWINSZ  # ty: ignore[possibly-missing-import]

    """Selector timeout used to periodically check parent process liveness."""
    _SELECT_TIMEOUT_SECONDS = 0.5

    """Signal grace timings for child process-group termination escalation."""
    _TERMINATION_SEQUENCE = (
        (SIGHUP, 1.0),
        (SIGTERM, 1.0),
        (SIGKILL, 0.0),  # No grace period after SIGKILL since it's not catchable.
    )

    def terminate_process_group(pid: int) -> None:
        """Best-effort termination of the child process group for `pid`.

        The child created via ``pty.fork()`` runs in its own session/process group,
        so terminating the proxy process alone does not guarantee the shell tree
        exits. This helper escalates from ``SIGHUP`` to ``SIGTERM`` and then
        ``SIGKILL`` with short grace delays.
        """
        try:
            pgid = getpgid(pid)
        except ProcessLookupError:
            return

        for sig, wait_seconds in _TERMINATION_SEQUENCE:
            try:
                killpg(pgid, sig)
            except ProcessLookupError:
                return
            # Give the process group a brief grace window between escalation
            # steps to exit cleanly before sending a stronger signal.
            if wait_seconds > 0:
                sleep(wait_seconds)

    class _SelectorHandler:
        """Base context-manager that registers a read-callback for an FD.

        Subclasses should implement `_on_read()`; this base class provides the
        common registration/unregistration logic and exposes `registered`.
        """

        def __init__(self, selector: BaseSelector, fd: int) -> None:
            """Initialize the selector handler for `fd`."""
            self.selector = selector
            self.fd = fd
            self.registered = False

        def __enter__(self) -> _SelectorHandler:
            """Register the FD callback and return this manager."""
            self.selector.register(self.fd, EVENT_READ, self._on_read)
            self.registered = True
            return self

        def __exit__(
            self,
            exc_type: type[BaseException] | None,
            exc: BaseException | None,
            tb: TracebackType | None,
        ) -> None:
            """Unregister the FD if still registered."""
            if self.registered:
                with suppress(Exception):
                    self.selector.unregister(self.fd)
                self.registered = False

        def _on_read(self) -> None:
            """Read callback — must be implemented by subclasses."""
            raise NotImplementedError

        def _unregister(self) -> None:
            """Safely unregister and mark as not registered."""
            if self.registered:
                with suppress(Exception):
                    self.selector.unregister(self.fd)
                self.registered = False

    class _PipePty(_SelectorHandler):
        """Context manager that handles PTY -> stdout forwarding."""

        def __init__(self, selector: BaseSelector, pty_fd: int) -> None:
            """Initialize the PTY->stdout handler."""
            super().__init__(selector, pty_fd)

        @override
        def _on_read(self) -> None:
            """Read from the PTY and forward bytes to stdout; stop on EOF."""
            data = _read_or_eof(self.fd)
            if not data:
                self._unregister()
                return
            write_all(_STDOUT, data)

    class _PipeStdin(_SelectorHandler):
        """Context manager that forwards stdin -> PTY."""

        def __init__(self, selector: BaseSelector, pty_fd: int) -> None:
            """Initialize the stdin->PTY handler."""
            super().__init__(selector, _STDIN)
            self.pty_fd = pty_fd

        @override
        def _on_read(self) -> None:
            """Read from stdin and forward bytes to the PTY; unregister on EOF."""
            data = _read_or_eof(self.fd)
            if not data:
                self._unregister()
                return
            write_all(self.pty_fd, data)

    class _ProcessCmdIO(_SelectorHandler):
        """Context manager that applies window-size control frames to the PTY."""

        def __init__(self, selector: BaseSelector, pty_fd: int) -> None:
            """Initialize the command-FD -> pty resizer handler."""
            super().__init__(selector, _CMDIO)
            self.pty_fd = pty_fd

        @override
        def _on_read(self) -> None:
            """Read control frames from the command FD and apply window size.

            Expected input: lines like "<rows>x<cols>"; each line triggers an
            ioctl(TIOCSWINSZ) on the PTY.
            """
            data = _read_or_eof(self.fd)
            if not data:
                self._unregister()
                return
            for line in data.decode("UTF-8", "strict").splitlines():
                rows, columns = (int(ss.strip()) for ss in line.split("x", 2))
                ioctl(
                    self.pty_fd,
                    TIOCSWINSZ,
                    pack("HHHH", columns, rows, 0, 0),
                )

    def main() -> None:
        """Fork and proxy a child process on a pseudoterminal.

        The function forks; the child execs the requested program while the
        parent proxies IO between the controlling terminal and the pty.
        """
        pid, pty_fd = fork()
        if pid == 0:
            execvp(sys.argv[1], sys.argv[1:])

        shutdown_requested = False

        def request_shutdown(_signal_number: int, _frame: FrameType | None) -> None:
            """Mark the proxy for graceful shutdown on external signals."""
            nonlocal shutdown_requested
            shutdown_requested = True

        old_sigint = signal(SIGINT, request_shutdown)
        old_sigterm = signal(SIGTERM, request_shutdown)
        try:
            with DefaultSelector() as selector:
                with (
                    _PipePty(selector, pty_fd) as pipe_pty,
                    _PipeStdin(selector, pty_fd) as pipe_stdin,
                    _ProcessCmdIO(selector, pty_fd) as process_cmdio,
                ):
                    # Keep proxying while all host-facing pipes are alive and
                    # no explicit shutdown signal has been requested.
                    while (
                        pipe_pty.registered
                        and pipe_stdin.registered
                        and process_cmdio.registered
                        and not shutdown_requested
                    ):
                        for key, _ in selector.select(_SELECT_TIMEOUT_SECONDS):
                            key.data()
                        if getppid() == 1:
                            shutdown_requested = True

                    host_disconnected = (
                        not pipe_stdin.registered or not process_cmdio.registered
                    )
                    # If host side is gone (or we got SIGINT/SIGTERM), tear
                    # down the child session proactively to avoid orphans.
                    if pipe_pty.registered and (
                        host_disconnected or shutdown_requested
                    ):
                        terminate_process_group(pid)
        finally:
            signal(SIGINT, old_sigint)
            signal(SIGTERM, old_sigterm)

        exit(waitstatus_to_exitcode(waitpid(pid, 0)[1]))


if __name__ == "__main__":
    main()
