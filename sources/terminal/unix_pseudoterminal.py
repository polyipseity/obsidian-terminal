# -*- coding: UTF-8
# dependencies: (none)

import fcntl as _fcntl
import os as _os
import pty as _pty
import selectors as _selectors
import struct as _struct
import sys as _sys
import termios as _termios
import typing as _typing

_PTY_FORK = _typing.cast(
    _typing.Callable[[], tuple[int, int]],
    _pty.fork,  # type: ignore
)

if _sys.platform != "win32":
    CHUNK_SIZE = 1024
    STDIN = _sys.stdin.fileno()
    STDOUT = _sys.stdout.fileno()
    CMDIO = 3

    def main():
        pid, pty_fd = _PTY_FORK()
        if pid == 0:
            _os.execvp(_sys.argv[1], _sys.argv[1:])

        def write_all(fd: int, data: bytes):
            while data:
                data = data[_os.write(fd, data) :]

        with _selectors.DefaultSelector() as selector:
            running = True

            def pipe_pty():
                try:
                    data = _os.read(pty_fd, CHUNK_SIZE)
                except OSError:
                    data = b""
                if not data:
                    selector.unregister(pty_fd)
                    global running
                    running = False
                    return
                write_all(STDOUT, data)

            def pipe_stdin():
                data = _os.read(STDIN, CHUNK_SIZE)
                if not data:
                    selector.unregister(STDIN)
                    return
                write_all(pty_fd, data)

            def process_cmdio():
                data = _os.read(CMDIO, CHUNK_SIZE)
                if not data:
                    selector.unregister(CMDIO)
                    return
                for line in data.decode("UTF-8", "strict").splitlines():
                    rows, columns = (int(ss.strip()) for ss in line.split("x", 2))
                    _fcntl.ioctl(
                        pty_fd,
                        _termios.TIOCSWINSZ,
                        _struct.pack("HHHH", columns, rows, 0, 0),
                    )

            selector.register(pty_fd, _selectors.EVENT_READ, pipe_pty)
            selector.register(STDIN, _selectors.EVENT_READ, pipe_stdin)
            selector.register(CMDIO, _selectors.EVENT_READ, process_cmdio)
            while running:
                for key, _ in selector.select():
                    key.data()

        _sys.exit(_os.waitstatus_to_exitcode(_os.waitpid(pid, 0)[1]))

else:

    def main():
        raise NotImplementedError(_sys.platform)


if __name__ == "__main__":
    main()
