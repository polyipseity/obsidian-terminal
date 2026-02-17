"""Unix PTY proxy used by the terminal plugin.

This module implements a simple pseudoterminal bridge that spawns a child
process on a pty, proxies stdin/stdout, and accepts control frames on a
separate FD to update terminal window size.
"""

import sys
from os import (
    execvp,
    read,
    waitpid,
    waitstatus_to_exitcode,
    write,
)
from selectors import EVENT_READ, DefaultSelector
from struct import pack
from sys import exit, stdin, stdout

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

    def main() -> None:
        """Fork and proxy a child process on a pseudoterminal.

        The function forks; the child execs the requested program while the
        parent proxies IO between the controlling terminal and the pty.
        """
        pid, pty_fd = fork()
        if pid == 0:
            execvp(sys.argv[1], sys.argv[1:])

        with DefaultSelector() as selector:
            running = True

            def pipe_pty():
                """Read from the pty and forward bytes to stdout.

                Signals when the child process has closed the pty.
                """
                try:
                    data = read(pty_fd, _CHUNK_SIZE)
                except OSError:
                    data = b""
                if not data:
                    selector.unregister(pty_fd)
                    global running
                    running = False
                    return
                write_all(_STDOUT, data)

            def pipe_stdin():
                """Read from stdin and forward input to the pty."""
                data = read(_STDIN, _CHUNK_SIZE)
                if not data:
                    selector.unregister(_STDIN)
                    return
                write_all(pty_fd, data)

            def process_cmdio():
                """Process control I/O coming from the command FD.

                Expects lines of the form "<rows>x<cols>" and applies a
                TIOCSWINSZ ioctl to resize the pty.
                """
                data = read(_CMDIO, _CHUNK_SIZE)
                if not data:
                    selector.unregister(_CMDIO)
                    return
                for line in data.decode("UTF-8", "strict").splitlines():
                    rows, columns = (int(ss.strip()) for ss in line.split("x", 2))
                    ioctl(
                        pty_fd,
                        TIOCSWINSZ,
                        pack("HHHH", columns, rows, 0, 0),
                    )

            selector.register(pty_fd, EVENT_READ, pipe_pty)
            selector.register(_STDIN, EVENT_READ, pipe_stdin)
            selector.register(_CMDIO, EVENT_READ, process_cmdio)
            while running:
                for key, _ in selector.select():
                    key.data()

        exit(waitstatus_to_exitcode(waitpid(pid, 0)[1]))


if __name__ == "__main__":
    main()
