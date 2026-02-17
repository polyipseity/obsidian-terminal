from contextlib import contextmanager as _contextmanager
from itertools import chain as _chain
from psutil import Process as _Process
from pywinctl import Window as _Window, getAllWindows as _getAllWindows
import sys as _sys
from time import sleep as _sleep
from typing import (
    Any as _Any,
    Callable as _Callable,
    Generator as _Generator,
    Protocol as _Protocol,
    TypedDict as _TypedDict,
    cast as _cast,
    final as _final,
)

__all__ = (
    "main",
    "win_to_pid",
    "resizer",
    "resizer_reader",
    "resizer_writer",
)

if _sys.platform == "win32":
    from pywintypes import error as _error
    from win32api import SetConsoleCtrlHandler as _SetConsoleCtrlHandler
    from win32con import (
        CTRL_BREAK_EVENT as _CTRL_BREAK_EVENT,
        CTRL_CLOSE_EVENT as _CTRL_CLOSE_EVENT,
        CTRL_C_EVENT as _CTRL_C_EVENT,
        FILE_SHARE_WRITE as _FILE_SHARE_WRITE,
        GENERIC_READ as _GENERIC_READ,
        GENERIC_WRITE as _GENERIC_WRITE,
        OPEN_EXISTING as _OPEN_EXISTING,
        SWP_NOACTIVATE as _SWP_NOACTIVATE,
        SWP_NOREDRAW as _SWP_NOREDRAW,
        SWP_NOZORDER as _SWP_NOZORDER,
    )
    from win32console import (
        AttachConsole as _AttachConsole,  # type: ignore
        FreeConsole as _FreeConsole,
        PyCOORDType as _PyCOORDType,
        PySMALL_RECTType as _PySMALL_RECTType,
        PyConsoleScreenBufferType as _PyConsoleScreenBufferType,
    )
    from win32file import CreateFile as _CreateFile
    from win32gui import SetWindowPos as _SetWindowPos
    from win32process import GetWindowThreadProcessId as _GetWindowThreadProcessId

    @_final
    class _PyCOORDType0(_Protocol):
        @property
        def X(self) -> int: ...

        @property
        def Y(self) -> int: ...

    @_final
    class _PySMALL_RECTType0(_Protocol):
        @property
        def Left(self) -> int: ...

        @property
        def Top(self) -> int: ...

        @property
        def Right(self) -> int: ...

        @property
        def Bottom(self) -> int: ...

    @_final
    class _PyConsoleScreenBufferInfo(_TypedDict):
        Size: _PyCOORDType0
        CursorPosition: _PyCOORDType0
        Attributes: int
        Window: _PySMALL_RECTType0
        MaximumWindowSize: _PyCOORDType0

    _ATTACH_CONSOLE = _cast(
        _Callable[[int], None],
        _AttachConsole,
    )
    _PY_COORD_TYPE = _cast(
        _Callable[[int, int], _PyCOORDType],
        _PyCOORDType,
    )
    _PY_CONSOLE_SCREEN_BUFFER_TYPE = _cast(
        _Callable[[_Any], _PyConsoleScreenBufferType],
        _PyConsoleScreenBufferType,
    )
    _GET_CONSOLE_SCREEN_BUFFER_INFO = _cast(
        _Callable[[_PyConsoleScreenBufferType], _PyConsoleScreenBufferInfo],
        _PyConsoleScreenBufferType.GetConsoleScreenBufferInfo,  # type: ignore
    )
    _SET_CONSOLE_WINDOW_INFO = _cast(
        _Callable[
            [_PyConsoleScreenBufferType, bool, _PySMALL_RECTType],
            None,
        ],
        _PyConsoleScreenBufferType.SetConsoleWindowInfo,  # type: ignore
    )
    _PY_SMALL_RECT_TYPE = _cast(
        _Callable[[int, int, int, int], _PySMALL_RECTType],
        _PySMALL_RECTType,
    )
    _LOOKUP_RETRY_INTERVAL = 1
    _LOOKUP_RETRIES = 10
    _RESIZE_ITERATIONS = 2

    def main():
        pid = int(input("PID: "))
        print(f"received: {pid}")
        proc = _Process(pid)
        procs = {}
        windows = ()
        for tries in range(_LOOKUP_RETRIES):
            procs = {
                proc.pid: proc
                for proc in _chain((proc,), proc.children(recursive=True))
            }
            print(f"process(es) (try {tries + 1}): {procs}")
            windows = _getAllWindows()
            print(f"window(s) (try {tries + 1}): {windows}")
            for win in windows:
                win_pid = win_to_pid(win)
                if win_pid in procs:
                    resizer(procs[win_pid], win)
                    return
            _sleep(_LOOKUP_RETRY_INTERVAL)
        raise LookupError(procs, windows)

    def win_to_pid(window: _Window):
        return _GetWindowThreadProcessId(window.getHandle())[1]

    def resizer(process: _Process, window: _Window):
        print(f"window: {window}")
        writer = resizer_writer(process, window)
        next(writer)
        for size in resizer_reader(process):
            writer.send(size)

    def resizer_reader(process: _Process):
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
        process: _Process, window: _Window
    ) -> _Generator[None, tuple[int, int], None]:
        window.hide(True)

        def ignore_error(func: _Callable[[], None]):
            try:
                func()
            except _error:
                pass

        @_contextmanager
        def attach_console(pid: int):
            try:
                _ATTACH_CONSOLE(pid)
                yield _PY_CONSOLE_SCREEN_BUFFER_TYPE(
                    _CreateFile(
                        "CONOUT$",
                        _GENERIC_READ | _GENERIC_WRITE,
                        _FILE_SHARE_WRITE,
                        None,
                        _OPEN_EXISTING,
                        0,
                        None,
                    )  # GetStdHandle gives the piped handle instead of the console handle
                )
            finally:
                _FreeConsole()

        def console_ctrl_handler(event: int):
            if event in (
                _CTRL_C_EVENT,
                _CTRL_BREAK_EVENT,
                _CTRL_CLOSE_EVENT,
            ):
                return True
            return False

        _FreeConsole()
        with attach_console(process.pid) as console:
            _SetConsoleCtrlHandler(console_ctrl_handler, True)
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
                        lambda: _SetWindowPos(
                            _cast(int, window.getHandle()),
                            None,
                            0,
                            0,
                            *size,
                            _SWP_NOACTIVATE | _SWP_NOREDRAW | _SWP_NOZORDER,
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
        raise NotImplementedError(_sys.platform)


if __name__ == "__main__":
    main()
