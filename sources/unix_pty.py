# -*- coding: UTF-8
import os as _os
import pty as _pty
import sys as _sys

ret: int = _pty.spawn(_sys.argv[1:])  # type: ignore
_sys.exit(_os.waitstatus_to_exitcode(ret))
