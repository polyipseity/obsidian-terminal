"""Unix PTY proxy used by the terminal plugin.

This module implements a simple pseudoterminal bridge that spawns a child
process on a pty, proxies stdin/stdout, and accepts control frames on a
separate FD to update terminal window size.
"""

from __future__ import annotations

import os
import sys
from contextlib import suppress
from os import (
    close,
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
from typing import TYPE_CHECKING, TypeVar

if TYPE_CHECKING:
    from typing_extensions import Self, override
else:
    """Runtime stand-in for ``typing_extensions.Self`` on Python 3.9."""
    Self = TypeVar("Self", bound="_SelectorHandler")

    def override(func):
        """No-op fallback for the ``@override`` decorator at runtime.

        The real ``typing_extensions.override`` is a static-only marker; this
        pass-through is functionally identical when type checkers are not
        running.
        """
        return func


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
    from os import (
        WNOHANG,  # ty: ignore[possibly-missing-import]
        getppid,
        killpg,  # ty: ignore[possibly-missing-import]
    )
    from pty import fork  # ty: ignore[possibly-missing-import]
    from signal import SIGHUP, SIGKILL  # ty: ignore[possibly-missing-import]
    from termios import TIOCSWINSZ  # ty: ignore[possibly-missing-import]

    """Selector timeout used to periodically check parent process liveness."""
    _SELECT_TIMEOUT_SECONDS = 0.5

    """Seconds to wait for the shell to exit after each signal."""
    _TERMINATION_SEQUENCE = (
        (SIGHUP, 1.0),
        (SIGTERM, 1.0),
        (SIGKILL, 2.0),
    )

    """Polling interval while waiting for the child to exit."""
    _TERMINATION_POLL_SECONDS = 0.05

    def _group_alive(pgid: int) -> bool:
        """Return True while at least one live process remains in process group.

        The process group is identified by `pgid`.
        """
        if os.path.isdir("/proc"):
            for entry in os.listdir("/proc"):
                if not entry.isdigit():
                    continue
                try:
                    with open(f"/proc/{entry}/stat", encoding="utf-8") as stat_file:
                        fields = stat_file.read().rsplit(")", 1)[1].split()
                    if int(fields[2]) == pgid and fields[0] not in "ZX":
                        return True
                except (OSError, ValueError):
                    continue
            return False

        try:
            killpg(pgid, 0)
            return True
        except PermissionError:
            # On macOS, a group whose remaining members have all exited but
            # are not yet collected answers EPERM, so this means "no live
            # member".
            return False
        except ProcessLookupError:
            return False
        except OSError:
            return False

    def terminate_shell(pid: int, pty_fd: int) -> int | None:
        """Close the pseudo-terminal and stop the shell's process group.

        Close the pseudo-terminal, send SIGHUP, SIGTERM, and SIGKILL to the
        shell's process group, waiting after each until no live process remains
        in the group. Then collect the shell and return its wait status, or
        ``None`` if it remains running.
        """
        # Close the master first: the kernel hangs up the session and drops
        # pending output, so an exiting shell cannot block on its final terminal
        # write.
        with suppress(OSError):
            close(pty_fd)

        group_quiet = False
        for sig, grace in _TERMINATION_SEQUENCE:
            # On macOS, killpg can raise PermissionError when the group's only
            # member has exited; the next poll collects the child harmlessly.
            with suppress(OSError):
                killpg(pid, sig)
            elapsed = 0.0
            while elapsed < grace:
                interval = min(_TERMINATION_POLL_SECONDS, grace - elapsed)
                sleep(interval)
                elapsed += interval
                if not _group_alive(pid):
                    group_quiet = True
                    break
            if group_quiet:
                break

        try:
            waited, status = waitpid(pid, WNOHANG)
        except ChildProcessError:
            return 0
        if waited == pid:
            return status
        return None

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

        def __enter__(self) -> Self:
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
        exit_code: int | None = None
        try:
            with (
                DefaultSelector() as selector,
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
                # Exit 0 when the host asked for the shutdown and the shell has
                # exited: the shell's signal status carries no information for
                # the user, and "0" is in the plugin's default success exit
                # codes (src/magic.ts), so no error notice.
                # Exit 1 only when the shell is still running after the last wait.
                if host_disconnected or shutdown_requested:
                    if pipe_pty.registered:
                        exit_code = 0 if terminate_shell(pid, pty_fd) is not None else 1
                    else:
                        # The shell already exited on its own; collect it and
                        # report success because the host asked for shutdown.
                        with suppress(ChildProcessError):
                            waitpid(pid, 0)
                        exit_code = 0
        finally:
            signal(SIGINT, old_sigint)
            signal(SIGTERM, old_sigterm)

        if exit_code is not None:
            exit(exit_code)
        exit(waitstatus_to_exitcode(waitpid(pid, 0)[1]))


if __name__ == "__main__":
    main()
