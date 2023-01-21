# -*- coding: UTF-8 -*-
# dependencies: psutil, pywinctl

import contextlib as _contextlib
import psutil as _psutil
import pywinctl as _pywinctl  # type: ignore
import pywintypes as _pywintypes
import sys as _sys
import types as _types
import typing as _typing
import win32con as _win32con
import win32console as _win32console
import win32file as _win32file
import win32gui as _win32gui
import win32process as _win32process

if _sys.platform == "win32":

    def main() -> None:
        pid = int(input("PID: "))
        print(f"received: {pid}")
        proc = _psutil.Process(pid)
        procs = (proc,) + tuple(proc.children(recursive=True))
        print(f"process(es): {procs}")
        pids: _typing.Mapping[int, _psutil.Process] = _types.MappingProxyType(
            {proc.pid: proc for proc in procs}
        )

        windows: _typing.Collection[_pywinctl.Window] = _pywinctl.getAllWindows()
        print(f"window(s): {windows}")
        for win in windows:
            win_pid = win_to_pid(win)
            if win_pid in pids:
                resizer(pids[win_pid], win)
                return

    def win_to_pid(window: _pywinctl.Window) -> int:
        return _win32process.GetWindowThreadProcessId(window.getHandle())[1]

    def resizer(process: _psutil.Process, window: _pywinctl.BaseWindow) -> None:
        print(f"window: {window}")
        r_in = resizer_in(process)
        r_out = resizer_out(process, window)
        next(r_out)
        for size in r_in:
            r_out.send(size)

    def resizer_in(process: _psutil.Process) -> _typing.Iterator[tuple[int, int]]:
        while True:
            size0 = ""
            while not size0:  # stdin watchdog triggers this loop
                if not process.is_running():
                    return
                size0 = input("size: ")
            size = _typing.cast(
                tuple[int, int],
                tuple(int(s.strip()) for s in size0.split("x", 2)),
            )
            print(f"received: {'x'.join(map(str, size))}")
            yield size

    def resizer_out(
        process: _psutil.Process, window: _pywinctl.BaseWindow
    ) -> _typing.Generator[None, tuple[int, int], None]:
        window.hide()

        @_typing.final
        class ConsoleScreenBufferInfo(_typing.TypedDict):
            Size: _win32console.PyCOORDType
            CursorPosition: _win32console.PyCOORDType
            Attributes: int
            Window: _win32console.PySMALL_RECTType
            MaximumWindowSize: _win32console.PyCOORDType

        def ignore_error(func: _typing.Callable[[], None]) -> bool:
            try:
                func()
                return True
            except _pywintypes.error:
                return False

        @_contextlib.contextmanager
        def attach_console(
            pid: int,
        ) -> _typing.Iterator[_win32console.PyConsoleScreenBufferType]:
            try:
                _win32console.AttachConsole(pid)  # type: ignore
                yield (_win32console.PyConsoleScreenBufferType)(  # type: ignore
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

        _win32console.FreeConsole()
        with attach_console(process.pid) as console:
            while True:
                columns: int
                rows: int
                columns, rows = yield
                info: ConsoleScreenBufferInfo = (
                    console.GetConsoleScreenBufferInfo()  # type: ignore
                )
                old_rect = window.getClientFrame()
                old_actual_rect = window.size
                old_cols: int = (
                    info["Window"].Right - info["Window"].Left + 1  # type: ignore
                )
                old_rows: int = (
                    info["Window"].Bottom - info["Window"].Top + 1  # type: ignore
                )
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
                print(f"pixel size: {size}")
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
                    lambda: console.SetConsoleWindowInfo(  # type: ignore
                        True,
                        _win32console.PySMALL_RECTType(0, 0, columns - 1, old_rows - 1),  # type: ignore
                    ),
                    lambda: console.SetConsoleScreenBufferSize(
                        _win32console.PyCOORDType(columns, old_rows)  # type: ignore
                    ),
                    lambda: console.SetConsoleWindowInfo(  # type: ignore
                        True,
                        _win32console.PySMALL_RECTType(0, 0, columns - 1, rows - 1),  # type: ignore
                    ),
                    lambda: console.SetConsoleScreenBufferSize(
                        _win32console.PyCOORDType(columns, rows)  # type: ignore
                    ),
                ]
                if old_cols < columns:
                    setters[1], setters[2] = setters[2], setters[1]
                if old_rows < rows:
                    setters[3], setters[4] = setters[4], setters[3]
                for setter in setters:
                    ignore_error(setter)
                print(f"resized")

    if __name__ == "__main__":
        main()
