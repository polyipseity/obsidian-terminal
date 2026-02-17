"""Windows helper to resize a console window for a process.

This module contains utilities used by the plugin to locate a console
window for a PID and resize the host window to match a requested terminal
size.  Most types and helpers are internal; the public API is listed in
`__all__`.
"""

from contextlib import contextmanager
from itertools import chain
from psutil import Process
from pywinctl import Window, getAllWindows
import sys
from time import sleep
from typing import (
    Any,
    Callable,
    Generator,
    Protocol,
    TypedDict,
    cast,
    final,
)

__all__ = (
    "main",
    "win_to_pid",
    "resizer",
    "resizer_reader",
    "resizer_writer",
)

if sys.platform == "win32":
    from pywintypes import error
    from win32api import SetConsoleCtrlHandler
    from win32con import (
        CTRL_BREAK_EVENT,
        CTRL_CLOSE_EVENT,
        CTRL_C_EVENT,
        FILE_SHARE_WRITE,
        GENERIC_READ,
        GENERIC_WRITE,
        OPEN_EXISTING,
        SWP_NOACTIVATE,
        SWP_NOREDRAW,
        SWP_NOZORDER,
    )
    from win32console import (
        AttachConsole,  # type: ignore
        FreeConsole,
        PyCOORDType,
        PySMALL_RECTType,
        PyConsoleScreenBufferType,
    )
    from win32file import CreateFile
    from win32gui import SetWindowPos
    from win32process import GetWindowThreadProcessId

    @final
    class _PyCOORDType0(Protocol):
        """Protocol describing a coordinate type returned by win32 APIs."""

        @property
        def X(self) -> int:
            """X coordinate (columns)."""
            ...

        @property
        def Y(self) -> int:
            """Y coordinate (rows)."""
            ...

    @final
    class _PySMALL_RECTType0(Protocol):
        """Protocol for a SMALL_RECT-like structure (window rectangle)."""

        @property
        def Left(self) -> int:
            """Left edge (pixels)."""
            ...

        @property
        def Top(self) -> int:
            """Top edge (pixels)."""
            ...

        @property
        def Right(self) -> int:
            """Right edge (pixels)."""
            ...

        @property
        def Bottom(self) -> int:
            """Bottom edge (pixels)."""
            ...

    @final
    class _PyConsoleScreenBufferInfo(TypedDict):
        """TypedDict mirroring the console screen buffer info structure."""

        Size: _PyCOORDType0
        CursorPosition: _PyCOORDType0
        Attributes: int
        Window: _PySMALL_RECTType0
        MaximumWindowSize: _PyCOORDType0

    _ATTACH_CONSOLE = cast(
        Callable[[int], None],
        AttachConsole,
    )
    _PY_COORD_TYPE = cast(
        Callable[[int, int], PyCOORDType],
        PyCOORDType,
    )
    _PY_CONSOLE_SCREEN_BUFFER_TYPE = cast(
        Callable[[Any], PyConsoleScreenBufferType],
        PyConsoleScreenBufferType,
    )
    _GET_CONSOLE_SCREEN_BUFFER_INFO = cast(
        Callable[[PyConsoleScreenBufferType], _PyConsoleScreenBufferInfo],
        PyConsoleScreenBufferType.GetConsoleScreenBufferInfo,  # type: ignore
    )
    _SET_CONSOLE_WINDOW_INFO = cast(
        Callable[
            [PyConsoleScreenBufferType, bool, PySMALL_RECTType],
            None,
        ],
        PyConsoleScreenBufferType.SetConsoleWindowInfo,  # type: ignore
    )
    _PY_SMALL_RECT_TYPE = cast(
        Callable[[int, int, int, int], PySMALL_RECTType],
        PySMALL_RECTType,
    )
    _LOOKUP_RETRY_INTERVAL = 1
    _LOOKUP_RETRIES = 10
    _RESIZE_ITERATIONS = 2

    def main():
        """Find the console window for a PID and resize it on demand.

        Prompts for a PID on stdin, looks up the process's window and runs the
        resizer loop to apply sizes received on stdin.
        """
        pid = int(input("PID: "))
        print(f"received: {pid}")
        proc = Process(pid)
        procs = {}
        windows = ()
        for tries in range(_LOOKUP_RETRIES):
            procs = {
                proc.pid: proc for proc in chain((proc,), proc.children(recursive=True))
            }
            print(f"process(es) (try {tries + 1}): {procs}")
            windows = getAllWindows()
            print(f"window(s) (try {tries + 1}): {windows}")
            for win in windows:
                win_pid = win_to_pid(win)
                if win_pid in procs:
                    resizer(procs[win_pid], win)
                    return
            sleep(_LOOKUP_RETRY_INTERVAL)
        raise LookupError(procs, windows)

    def win_to_pid(window: Window):
        """Return the process id that owns `window`."""
        return GetWindowThreadProcessId(window.getHandle())[1]

    def resizer(process: Process, window: Window):
        """Drive the resizer coroutine for `process`/`window`.

        Reads sizes from `resizer_reader` and sends them to the writer
        coroutine returned by `resizer_writer`.
        """
        print(f"window: {window}")
        writer = resizer_writer(process, window)
        next(writer)
        for size in resizer_reader(process):
            writer.send(size)

    def resizer_reader(process: Process):
        """Read size strings from stdin and yield (rows, columns) tuples.

        The reader waits for non-empty input lines of the form "<rows>x<cols>".
        """
        while True:
            size0 = ""
            while not size0:  # stdin watchdog triggers this loop
                if not process.is_running():
                    return
                size0 = input("size: ")
            rows, columns = (int(s.strip()) for s in size0.split("x", 2))
            print(f"received: {rows}x{columns}")
            yield rows, columns

    def resizer_writer(
        process: Process, window: Window
    ) -> Generator[None, tuple[int, int], None]:
        """Coroutine that receives (cols, rows) and resizes the host window.

        Yields control to the caller to receive new sizes and applies a set
        of setters to resize the native window / console buffer.
        """
        window.hide(True)

        def ignore_error(func: Callable[[], None]):
            """Call `func()` and silently ignore pywin32 errors."""
            try:
                func()
            except error:
                pass

        @contextmanager
        def attach_console(pid: int):
            """Temporarily attach to `pid`'s console and yield its console handle."""
            try:
                _ATTACH_CONSOLE(pid)
                yield _PY_CONSOLE_SCREEN_BUFFER_TYPE(
                    CreateFile(
                        "CONOUT$",
                        GENERIC_READ | GENERIC_WRITE,
                        FILE_SHARE_WRITE,
                        None,
                        OPEN_EXISTING,
                        0,
                        None,
                    )  # GetStdHandle gives the piped handle instead of the console handle
                )
            finally:
                FreeConsole()

        def console_ctrl_handler(event: int):
            """Console control handler that ignores CTRL events."""
            if event in (
                CTRL_C_EVENT,
                CTRL_BREAK_EVENT,
                CTRL_CLOSE_EVENT,
            ):
                return True
            return False

        FreeConsole()
        with attach_console(process.pid) as console:
            SetConsoleCtrlHandler(console_ctrl_handler, True)
            while True:
                columns, rows = yield
                # iterate to resize accurately
                for iter in range(_RESIZE_ITERATIONS):
                    info = _GET_CONSOLE_SCREEN_BUFFER_INFO(console)
                    old_rect = window.getClientFrame()
                    old_actual_rect = window.size
                    old_cols = info["Window"].Right - info["Window"].Left + 1
                    old_rows = info["Window"].Bottom - info["Window"].Top + 1
                    old_width = old_rect.right - old_rect.left
                    old_height = old_rect.bottom - old_rect.top
                    size = (
                        int(old_width * columns / old_cols)
                        + old_actual_rect.width
                        - old_width,
                        int(old_height * rows / old_rows)
                        + old_actual_rect.height
                        - old_height,
                    )
                    print(f"pixel size (iteration {iter + 1}): {size}")
                    setters = [
                        # almost accurate, works for alternate screen buffer
                        lambda: SetWindowPos(
                            cast(int, window.getHandle()),
                            None,
                            0,
                            0,
                            *size,
                            SWP_NOACTIVATE | SWP_NOREDRAW | SWP_NOZORDER,
                        ),
                        # accurate, SetConsoleWindowInfo does not work for alternate screen buffer
                        lambda: _SET_CONSOLE_WINDOW_INFO(
                            console,
                            True,
                            _PY_SMALL_RECT_TYPE(0, 0, columns - 1, old_rows - 1),
                        ),
                        lambda: console.SetConsoleScreenBufferSize(
                            _PY_COORD_TYPE(columns, old_rows)
                        ),
                        lambda: _SET_CONSOLE_WINDOW_INFO(
                            console,
                            True,
                            _PY_SMALL_RECT_TYPE(0, 0, columns - 1, rows - 1),
                        ),
                        lambda: console.SetConsoleScreenBufferSize(
                            _PY_COORD_TYPE(columns, rows)
                        ),
                    ]
                    if old_cols < columns:
                        setters[1], setters[2] = setters[2], setters[1]
                    if old_rows < rows:
                        setters[3], setters[4] = setters[4], setters[3]
                    for setter in setters:
                        ignore_error(setter)
                print(f"resized")

else:

    def main():
        """Not implemented on non-Windows platforms."""
        raise NotImplementedError(sys.platform)


if __name__ == "__main__":
    main()
