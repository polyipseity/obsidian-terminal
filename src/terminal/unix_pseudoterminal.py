"""Unix PTY proxy used by the terminal plugin.

This module implements a simple pseudoterminal bridge that spawns a child
process on a pty, proxies stdin/stdout, and accepts control frames on a
separate FD to update terminal window size.
"""

from __future__ import annotations

import sys
from os import (
    execvp,
    read,
    waitpid,
    waitstatus_to_exitcode,
    write,
)
from selectors import EVENT_READ, BaseSelector, DefaultSelector
from struct import pack
from sys import exit, stdin, stdout
from types import TracebackType

__all__ = ("main",)

_CHUNK_SIZE = 1024
_STDIN = stdin.fileno()
_STDOUT = stdout.fileno()
_CMDIO = 3


def write_all(fd: int, data: bytes):
    """Write all bytes to `fd`, handling partial writes.

    Repeatedly call `write` until all data is written.
    """
    while data:
        data = data[write(fd, data) :]


def main() -> None:
    """Not available on Windows — resize proxy is POSIX-only here."""
    raise NotImplementedError(sys.platform)


if sys.platform != "win32":
    from fcntl import ioctl
    from pty import fork
    from termios import TIOCSWINSZ

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
                try:
                    self.selector.unregister(self.fd)
                except Exception:
                    pass
                self.registered = False

        def _on_read(self) -> None:
            """Read callback — must be implemented by subclasses."""
            raise NotImplementedError

        def _unregister(self) -> None:
            """Safely unregister and mark as not registered."""
            if self.registered:
                try:
                    self.selector.unregister(self.fd)
                except Exception:
                    pass
                self.registered = False

    class _PipePty(_SelectorHandler):
        """Context manager that handles PTY -> stdout forwarding."""

        def __init__(self, selector: BaseSelector, pty_fd: int) -> None:
            """Initialize the PTY->stdout handler."""
            super().__init__(selector, pty_fd)

        def _on_read(self) -> None:
            """Read from the PTY and forward bytes to stdout; stop on EOF."""
            try:
                data = read(self.fd, _CHUNK_SIZE)
            except OSError:
                data = b""
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

        def _on_read(self) -> None:
            """Read from stdin and forward bytes to the PTY; unregister on EOF."""
            try:
                data = read(self.fd, _CHUNK_SIZE)
            except OSError:
                data = b""
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

        def _on_read(self) -> None:
            """Read control frames from the command FD and apply window size.

            Expected input: lines like "<rows>x<cols>"; each line triggers an
            ioctl(TIOCSWINSZ) on the PTY.
            """
            try:
                data = read(self.fd, _CHUNK_SIZE)
            except OSError:
                data = b""
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

        with DefaultSelector() as selector:
            with (
                _PipePty(selector, pty_fd) as pipe_pty,
                _PipeStdin(selector, pty_fd) as _pipe_stdin,
                _ProcessCmdIO(selector, pty_fd) as _process_cmdio,
            ):
                while pipe_pty.registered:
                    for key, _ in selector.select():
                        key.data()

        exit(waitstatus_to_exitcode(waitpid(pid, 0)[1]))


if __name__ == "__main__":
    main()
