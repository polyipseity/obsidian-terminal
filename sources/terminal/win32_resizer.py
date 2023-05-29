# -*- coding: UTF-8 -*-
# dependencies: psutil, pywinctl

import contextlib as _contextlib
import itertools as _itertools
import psutil as _psutil
import pywinctl as _pywinctl
import pywintypes as _pywintypes
import sys as _sys
import time as _time
import typing as _typing
import win32api as _win32api
import win32con as _win32con
import win32console as _win32console
import win32file as _win32file
import win32gui as _win32gui
import win32process as _win32process


@_typing.final
class PyCOORDType(_typing.Protocol):
    @property
    def X(self) -> int:
        ...

    @property
    def Y(self) -> int:
        ...


@_typing.final
class PySMALL_RECTType(_typing.Protocol):
    @property
    def Left(self) -> int:
        ...

    @property
    def Top(self) -> int:
        ...

    @property
    def Right(self) -> int:
        ...

    @property
    def Bottom(self) -> int:
        ...


@_typing.final
class PyConsoleScreenBufferInfo(_typing.TypedDict):
    Size: PyCOORDType
    CursorPosition: PyCOORDType
    Attributes: int
    Window: PySMALL_RECTType
    MaximumWindowSize: PyCOORDType


_WIN32CONSOLE_ATTACH_CONSOLE = _typing.cast(
    _typing.Callable[[int], None],
    _win32console.AttachConsole,  # type: ignore
)
_WIN32CONSOLE_PY_COORD_TYPE = _typing.cast(
    _typing.Callable[[int, int], _win32console.PyCOORDType],
    _win32console.PyCOORDType,
)
_WIN32CONSOLE_PY_CONSOLE_SCREEN_BUFFER_TYPE = _typing.cast(
    _typing.Callable[[_typing.Any], _win32console.PyConsoleScreenBufferType],
    _win32console.PyConsoleScreenBufferType,
)
_WIN32CONSOLE_PY_CONSOLE_SCREEN_BUFFER_TYPE_GET_CONSOLE_SCREEN_BUFFER_INFO = _typing.cast(
    _typing.Callable[
        [_win32console.PyConsoleScreenBufferType], PyConsoleScreenBufferInfo
    ],
    _win32console.PyConsoleScreenBufferType.GetConsoleScreenBufferInfo,  # type: ignore
)
_WIN32CONSOLE_PY_CONSOLE_SCREEN_BUFFER_TYPE_SET_CONSOLE_WINDOW_INFO = _typing.cast(
    _typing.Callable[
        [_win32console.PyConsoleScreenBufferType, bool, _win32console.PySMALL_RECTType],
        None,
    ],
    _win32console.PyConsoleScreenBufferType.SetConsoleWindowInfo,  # type: ignore
)
_WIN32CONSOLE_PY_SMALL_RECT_TYPE = _typing.cast(
    _typing.Callable[[int, int, int, int], _win32console.PySMALL_RECTType],
    _win32console.PySMALL_RECTType,
)

if _sys.platform == "win32":
    LOOKUP_RETRY_INTERVAL = 1
    LOOKUP_RETRIES = 10
    RESIZE_ITERATIONS = 2

    def main():
        pid = int(input("PID: "))
        print(f"received: {pid}")
        proc = _psutil.Process(pid)
        procs = {}
        windows = ()
        for tries in range(LOOKUP_RETRIES):
            procs = {
                proc.pid: proc
                for proc in _itertools.chain((proc,), proc.children(recursive=True))
            }
            print(f"process(es) (try {tries + 1}): {procs}")
            windows = _pywinctl.getAllWindows()
            print(f"window(s) (try {tries + 1}): {windows}")
            for win in windows:
                win_pid = win_to_pid(win)
                if win_pid in procs:
                    resizer(procs[win_pid], win)
                    return
            _time.sleep(LOOKUP_RETRY_INTERVAL)
        raise LookupError(procs, windows)

    def win_to_pid(window: _pywinctl.Window):
        return _win32process.GetWindowThreadProcessId(window.getHandle())[1]

    def resizer(process: _psutil.Process, window: _pywinctl.BaseWindow):
        print(f"window: {window}")
        writer = resizer_writer(process, window)
        next(writer)
        for size in resizer_reader(process):
            writer.send(size)

    def resizer_reader(process: _psutil.Process):
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
        process: _psutil.Process, window: _pywinctl.BaseWindow
    ) -> _typing.Generator[None, tuple[int, int], None]:
        window.hide(True)

        def ignore_error(func: _typing.Callable[[], None]):
            try:
                func()
            except _pywintypes.error:
                pass

        @_contextlib.contextmanager
        def attach_console(pid: int):
            try:
                _WIN32CONSOLE_ATTACH_CONSOLE(pid)
                yield _WIN32CONSOLE_PY_CONSOLE_SCREEN_BUFFER_TYPE(
                    _win32file.CreateFile(
                        "CONOUT$",
                        _win32file.GENERIC_READ | _win32file.GENERIC_WRITE,
                        _win32file.FILE_SHARE_WRITE,
                        None,
                        _win32file.OPEN_EXISTING,
                        0,
                        None,
                    )  # GetStdHandle gives the piped handle instead of the console handle
                )
            finally:
                _win32console.FreeConsole()

        def console_ctrl_handler(event: int):
            if event in (
                _win32con.CTRL_C_EVENT,
                _win32con.CTRL_BREAK_EVENT,
                _win32con.CTRL_CLOSE_EVENT,
            ):
                return True
            return False

        _win32console.FreeConsole()
        with attach_console(process.pid) as console:
            _win32api.SetConsoleCtrlHandler(console_ctrl_handler, True)
            while True:
                columns, rows = yield
                # iterate to resize accurately
                for iter in range(RESIZE_ITERATIONS):
                    info = _WIN32CONSOLE_PY_CONSOLE_SCREEN_BUFFER_TYPE_GET_CONSOLE_SCREEN_BUFFER_INFO(
                        console
                    )
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
                        lambda: _win32gui.SetWindowPos(
                            _typing.cast(int, window.getHandle()),
                            None,
                            0,
                            0,
                            *size,
                            _win32con.SWP_NOACTIVATE
                            | _win32con.SWP_NOREDRAW
                            | _win32con.SWP_NOZORDER,
                        ),
                        # accurate, SetConsoleWindowInfo does not work for alternate screen buffer
                        lambda: _WIN32CONSOLE_PY_CONSOLE_SCREEN_BUFFER_TYPE_SET_CONSOLE_WINDOW_INFO(
                            console,
                            True,
                            _WIN32CONSOLE_PY_SMALL_RECT_TYPE(
                                0, 0, columns - 1, old_rows - 1
                            ),
                        ),
                        lambda: console.SetConsoleScreenBufferSize(
                            _WIN32CONSOLE_PY_COORD_TYPE(columns, old_rows)
                        ),
                        lambda: _WIN32CONSOLE_PY_CONSOLE_SCREEN_BUFFER_TYPE_SET_CONSOLE_WINDOW_INFO(
                            console,
                            True,
                            _WIN32CONSOLE_PY_SMALL_RECT_TYPE(
                                0, 0, columns - 1, rows - 1
                            ),
                        ),
                        lambda: console.SetConsoleScreenBufferSize(
                            _WIN32CONSOLE_PY_COORD_TYPE(columns, rows)
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
