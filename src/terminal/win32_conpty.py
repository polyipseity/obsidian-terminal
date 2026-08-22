"""Windows ConPTY host for integrated terminal profiles.

The plugin embeds this file as text, writes it to a temporary file, and runs::

    python <file> <columns> <rows> <pipe-name> -- <executable> [args...]

The source exceeds the 32767-character Windows command-line limit, so a
``python -c`` spawn cannot work.

The host binds the child process to a pseudoconsole and bridges three channels.
Its stdin and stdout carry raw terminal bytes.  A local named pipe, created by
the plugin before the spawn and connected to by this host, carries NDJSON
control messages: the host announces itself with ``hello``, the plugin sends
an authenticated response, and the host reports ``ready`` only after Job
Object assignment and primary-thread resume. The plugin then sends ``resize``
and ``kill`` operations, and the host reports ``exit`` before leaving. The
token authenticating that pipe arrives in the
``OBSIDIAN_TERMINAL_CONPTY_TOKEN`` environment variable, never on the command
line.

Only the standard library and ``ctypes`` are used, ConPTY needs Windows 10
version 1809 or newer, and the host exit code mirrors the child exit code.
Diagnostics go to stderr; stdout carries data only.
"""

from __future__ import annotations

import ctypes
import json
import os
import shutil
import sys
import threading
import time
from collections.abc import Mapping, Sequence
from typing import Any, BinaryIO, Callable, NamedTuple

"""Public API of this module."""
__all__ = (
    "READY_ATTESTATION",
    "TOKEN_ENVIRONMENT_VARIABLE",
    "ChildStartError",
    "ControlMessageReader",
    "DeferredArguments",
    "HostArguments",
    "NdjsonDecoder",
    "assign_suspended_child",
    "build_command_line",
    "decode_message",
    "diagnose",
    "encode_message",
    "environment_path",
    "main",
    "parse_arguments",
    "parse_resize",
    "quote_argument",
    "resolve_executable",
    "resume_assigned_child",
    "spawn_exit_code",
    "to_exit_status",
)

"""Environment variable carrying the control-channel authentication token."""
TOKEN_ENVIRONMENT_VARIABLE = "OBSIDIAN_TERMINAL_CONPTY_TOKEN"

"""Attestation required by the TypeScript backend-ready contract."""
READY_ATTESTATION = (
    "create-pseudoconsole+authenticated-control-channel+job-object-assigned"
)

"""Largest value a ``COORD`` field accepts."""
_MAX_DIMENSION = 32767
"""Bytes moved in one pipe or descriptor operation."""
_CHUNK_SIZE = 65536
"""Longest control line accepted before the fragment is discarded."""
_MAX_CONTROL_LINE_BYTES = 64 * 1024

"""Local named-pipe prefixes accepted for the control channel."""
_PIPE_PREFIXES = ("\\\\.\\pipe\\", "\\\\?\\pipe\\")

"""Host exit codes.

``9009`` is the ``cmd.exe`` "not recognized" code, reused here so the plugin
can report one message about a missing executable for both Windows backends.
"""
_EXIT_EXECUTABLE_NOT_FOUND = 9009
"""Host exit code used when the host itself cannot start a session."""
_EXIT_HOST_ERROR = 250
"""Host exit code used when the shell exists but Windows refused to start it."""
_EXIT_SHELL_START_FAILED = 251
"""Exit code reported for a child the host had to terminate."""
_EXIT_TERMINATED = 1

"""Win32 errors meaning the requested executable does not exist."""
_ERROR_FILE_NOT_FOUND = 2
"""Win32 error meaning the executable's directory does not exist."""
_ERROR_PATH_NOT_FOUND = 3
"""Win32 error meaning the requested pending operation was not found."""
_ERROR_NOT_FOUND = 1168

"""Standard descriptors, used raw so no buffered stream is ever shared."""
_STDIN_FD = 0
"""Descriptor carrying terminal output back to the plugin."""
_STDOUT_FD = 1
"""Descriptor carrying host diagnostics."""
_STDERR_FD = 2

"""The value returned by ``ResumeThread`` when it fails."""
_RESUME_FAILED = 0xFFFFFFFF

"""Process attribute that binds a new child to a pseudoconsole."""
_PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
"""STARTUPINFO flag making the explicit null standard handles authoritative."""
_STARTF_USESTDHANDLES = 0x00000100


class DeferredArguments(NamedTuple):
    """The parsed ``--defer-session`` host command line."""

    pipe_name: str


class HostArguments(NamedTuple):
    """The parsed host command line."""

    columns: int
    rows: int
    pipe_name: str
    command: tuple[str, ...]


class _ControlFiles(NamedTuple):
    """Independent file objects for one full-duplex control-pipe connection."""

    reader: BinaryIO
    writer: BinaryIO


def _write_control_message(control: _ControlFiles, message: Mapping[str, Any]) -> None:
    """Write one complete control message through the independent writer."""
    view = memoryview(encode_message(message))
    while view:
        written = control.writer.write(view)
        if not written:
            raise OSError("the control channel stopped accepting data")
        view = view[written:]


def _cancel_and_join_reader(
    thread: threading.Thread,
    cancel: Callable[[], None],
    timeout: float,
    interval: float,
) -> None:
    """Cancel a blocked reader until it joins or the bounded wait expires."""
    deadline = time.monotonic() + timeout
    while thread.is_alive():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise OSError("the control reader did not stop")
        cancel()
        thread.join(min(interval, remaining))


def _update_pseudoconsole_attribute(
    update: Callable[..., object], attributes: object, pseudoconsole: int
) -> bool:
    """Pass the pointer-like HPCON value directly to the Win32 attribute API."""
    return bool(
        update(
            attributes,
            0,
            _PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            ctypes.c_void_p(pseudoconsole),
            ctypes.sizeof(ctypes.c_void_p),
            None,
            None,
        )
    )


def assign_suspended_child(
    assign: Callable[[], bool], terminate: Callable[[], None]
) -> None:
    """Assign a suspended child to its Job Object or terminate it.

    The caller must not resume the child before this function succeeds.
    """
    if assign():
        return
    terminate()
    raise OSError("AssignProcessToJobObject failed")


def resume_assigned_child(
    resume: Callable[[], int], terminate: Callable[[], None]
) -> None:
    """Resume a job-contained child or terminate its process tree."""
    if resume() != _RESUME_FAILED:
        return
    terminate()
    raise OSError("ResumeThread failed")


def quote_argument(argument: str) -> str:
    """Quote one argument using the canonical Windows command-line rules.

    A backslash is literal unless it precedes a quote, where the whole run must
    be doubled and the quote escaped.  This is the exact inverse of the parser
    the C runtime uses to rebuild ``argv`` from ``lpCommandLine``.
    """
    if argument and not any(character in argument for character in ' \t\n\v"'):
        return argument
    parts = ['"']
    backslashes = 0
    for character in argument:
        if character == "\\":
            backslashes += 1
            continue
        if character == '"':
            parts.append("\\" * (backslashes * 2 + 1))
            parts.append('"')
        else:
            parts.append("\\" * backslashes)
            parts.append(character)
        backslashes = 0
    # Trailing backslashes would otherwise escape the closing quote.
    parts.append("\\" * (backslashes * 2))
    parts.append('"')
    return "".join(parts)


def build_command_line(command: Sequence[str]) -> str:
    """Join ``command`` into a ``CreateProcessW`` command line.

    No shell is involved, so nothing in any argument is expanded.
    """
    if not command or not command[0]:
        raise ValueError("a non-empty executable is required")
    return " ".join(quote_argument(argument) for argument in command)


def encode_message(message: Mapping[str, Any]) -> bytes:
    """Encode one control message as a UTF-8 NDJSON line."""
    line = json.dumps(dict(message), ensure_ascii=False, separators=(",", ":"))
    return (line + "\n").encode("utf-8")


def decode_message(line: str) -> dict[str, Any] | None:
    """Decode one NDJSON line, or return ``None`` when it is not an object."""
    text = line.strip()
    if not text:
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


class NdjsonDecoder:
    """Reassemble NDJSON control messages from arbitrary byte chunks."""

    def __init__(self) -> None:
        """Start with an empty partial-line buffer."""
        self._buffer = bytearray()

    def feed(self, data: bytes) -> list[dict[str, Any]]:
        """Consume ``data`` and return every complete, well-formed message."""
        self._buffer.extend(data)
        messages: list[dict[str, Any]] = []
        while True:
            newline = self._buffer.find(b"\n")
            if newline < 0:
                break
            raw = bytes(self._buffer[:newline])
            del self._buffer[: newline + 1]
            if len(raw) > _MAX_CONTROL_LINE_BYTES:
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                continue
            message = decode_message(text)
            if message is not None:
                messages.append(message)
        if len(self._buffer) > _MAX_CONTROL_LINE_BYTES:
            # An unterminated line this long is malformed, not merely partial.
            del self._buffer[:]
        return messages


class ControlMessageReader:
    """Deliver decoded control messages across handshake phases.

    One decoder and one backlog serve every phase of the channel —
    authenticate, await-start, serve — so an operation that arrives in the
    same chunk as an earlier message reaches the next phase instead of
    dying with a phase-local decoder.
    """

    def __init__(self, reader: BinaryIO) -> None:
        """Bind the connection's reader to one decoder and one backlog."""
        self._reader = reader
        self._decoder = NdjsonDecoder()
        self._backlog: list[dict[str, Any]] = []

    def next_message(self) -> dict[str, Any] | None:
        """Return the next control message, or ``None`` when the pipe ends."""
        while not self._backlog:
            data = self._reader.read(_CHUNK_SIZE)
            if not data:
                return None
            self._backlog.extend(self._decoder.feed(data))
        return self._backlog.pop(0)


def _dimension_or_none(value: Any) -> int | None:
    """Return ``value`` when it is a valid terminal dimension, else ``None``."""
    # ``True`` is an ``int`` in Python but never a terminal dimension.
    if not isinstance(value, int) or isinstance(value, bool):
        return None
    return value if 1 <= value <= _MAX_DIMENSION else None


def parse_resize(message: Mapping[str, Any]) -> tuple[int, int] | None:
    """Return the validated ``(columns, rows)`` of a resize op, or ``None``."""
    columns = _dimension_or_none(message.get("columns"))
    rows = _dimension_or_none(message.get("rows"))
    if columns is None or rows is None:
        return None
    return columns, rows


def _parse_dimension(text: str, name: str) -> int:
    """Parse one terminal dimension given on the command line."""
    value = int(text, 10)
    if not 1 <= value <= _MAX_DIMENSION:
        raise ValueError(f"{name} out of range: {value}")
    return value


def parse_arguments(
    arguments: Sequence[str],
) -> DeferredArguments | HostArguments:
    """Parse the host command line.

    Immediate form: ``<columns> <rows> <pipe-name> -- <executable> [args...]``.
    Deferred form: ``--defer-session <pipe-name>``.
    """
    values = list(arguments)
    if values and values[0] == "--defer-session":
        if len(values) != 2:
            raise ValueError("--defer-session takes exactly one pipe name")
        deferred_pipe = values[1]
        if not deferred_pipe.lower().startswith(_PIPE_PREFIXES):
            raise ValueError(f"not a local named pipe: {deferred_pipe}")
        return DeferredArguments(pipe_name=deferred_pipe)
    if "--" not in values:
        raise ValueError("a -- separator is required before the executable")
    separator = values.index("--")
    head = values[:separator]
    command = values[separator + 1 :]
    if len(head) != 3:
        raise ValueError("expected <columns> <rows> <pipe-name> before --")
    pipe_name = head[2]
    if not pipe_name.lower().startswith(_PIPE_PREFIXES):
        raise ValueError(f"not a local named pipe: {pipe_name}")
    if not command or not command[0]:
        raise ValueError("an executable is required after --")
    return HostArguments(
        columns=_parse_dimension(head[0], "columns"),
        rows=_parse_dimension(head[1], "rows"),
        pipe_name=pipe_name,
        command=tuple(command),
    )


def spawn_exit_code(win32_error: int) -> int:
    """Map a child-start Win32 error to the exit code the plugin will report.

    Both codes tell the plugin the host runtime is fine and the profile is not:
    the classic console would fail the same way, so neither condemns ConPTY.
    """
    if win32_error in (_ERROR_FILE_NOT_FOUND, _ERROR_PATH_NOT_FOUND):
        return _EXIT_EXECUTABLE_NOT_FOUND
    return _EXIT_SHELL_START_FAILED


class ChildStartError(OSError):
    """Windows refused to start the shell; the host itself is healthy."""

    def __init__(self, message: str, exit_code: int) -> None:
        """Carry the exit code the host reports for this failure."""
        super().__init__(message)
        self.exit_code = exit_code


def to_exit_status(code: int) -> int:
    """Convert an unsigned Win32 exit code into a value ``sys.exit`` keeps.

    ``GetExitCodeProcess`` yields a ``DWORD`` while CPython passes the argument
    of ``sys.exit`` through a C ``int``, so anything above ``INT_MAX`` must be
    re-encoded as its signed two's-complement equivalent to survive the trip.
    """
    value = code & 0xFFFFFFFF
    return value - 0x100000000 if value >= 0x80000000 else value


def diagnose(message: str) -> None:
    """Write one host diagnostic to the raw stderr descriptor.

    Worker threads must never write through ``sys.stderr``: a thread holding a
    buffered stream's lock while the interpreter finalises aborts CPython in
    ``_enter_buffered_busy``.
    """
    try:
        os.write(_STDERR_FD, ("win32_conpty: " + message + "\n").encode("utf-8"))
    except OSError:
        pass


def _parse_ack_sequence(message: Mapping[str, Any]) -> int | None:
    """Return the validated ack sequence of a resize op, or ``None``."""
    value = message.get("seq")
    if not isinstance(value, int) or isinstance(value, bool):
        return None
    return value if value >= 1 else None


def _build_environment_block(environment: Mapping[str, str]) -> str:
    """Build the ``CreateProcessW`` environment block content.

    Entries are sorted case-insensitively per Windows convention; every entry
    ends with a NUL and the block ends with one extra NUL.
    """
    entries = sorted(environment.items(), key=lambda item: item[0].upper())
    return "".join(f"{key}={value}\x00" for key, value in entries) + "\x00"


class _StartRequest(NamedTuple):
    """A validated deferred-session ``start`` operation."""

    arguments: HostArguments
    environment: dict[str, str] | None
    cwd: str | None


def environment_path(environment: Mapping[str, str] | None) -> str | None:
    """Return the ``PATH`` entry of a child environment, matched case-insensitively."""
    if environment is None:
        return None
    return next(
        (value for key, value in environment.items() if key.upper() == "PATH"), None
    )


def resolve_executable(executable: str, path: str | None) -> str:
    """Resolve a bare program name through the PATH the child will see.

    ``CreateProcessW`` searches the *host's* PATH for a bare name. An immediate
    session inherits the profile environment, so that search sees the profile's
    PATH entries; a deferred session receives them only in the child block, after
    the search. Resolving here keeps both sessions identical. A name with a
    directory component, or one the search cannot find, is passed through.
    """
    if os.path.dirname(executable):
        return executable
    return shutil.which(executable, path=path) or executable


def _parse_start(message: Mapping[str, Any], pipe_name: str) -> _StartRequest | None:
    """Return the validated deferred ``start`` op, or ``None``."""
    if message.get("op") != "start":
        return None
    columns = _dimension_or_none(message.get("columns"))
    rows = _dimension_or_none(message.get("rows"))
    command = message.get("command")
    if (
        columns is None
        or rows is None
        or not isinstance(command, list)
        or not command
        or not all(isinstance(argument, str) for argument in command)
        or not command[0]
    ):
        return None
    cwd = message.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
        return None
    environment = message.get("env")
    if environment is not None and (
        not isinstance(environment, dict)
        or not all(
            isinstance(key, str) and key and "=" not in key and isinstance(value, str)
            for key, value in environment.items()
        )
    ):
        return None
    return _StartRequest(
        arguments=HostArguments(
            columns=columns,
            rows=rows,
            pipe_name=pipe_name,
            command=tuple(command),
        ),
        environment=dict(environment) if environment else None,
        cwd=cwd,
    )


def main() -> None:
    """Not implemented on non-Windows platforms."""
    raise NotImplementedError(sys.platform)


if sys.platform == "win32":
    import msvcrt
    from ctypes import wintypes

    """Creation flag declaring an extended STARTUPINFO with attributes."""
    _EXTENDED_STARTUPINFO_PRESENT = 0x00080000
    """Creation flag keeping the primary thread stopped until containment."""
    _CREATE_SUSPENDED = 0x00000004
    """Creation flag declaring the environment block to be UTF-16."""
    _CREATE_UNICODE_ENVIRONMENT = 0x00000400
    """Thread access required by ``CancelSynchronousIo``."""
    _THREAD_TERMINATE = 0x0001
    """Duplicate a handle without changing its granted access."""
    _DUPLICATE_SAME_ACCESS = 0x00000002
    """Job class selecting ``JOBOBJECT_EXTENDED_LIMIT_INFORMATION``."""
    _JOBOBJECT_EXTENDED_LIMIT_CLASS = 9
    """Job limit killing every assigned process when the job closes."""
    _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    """Wait result meaning the waited-on object is signalled."""
    _WAIT_OBJECT_0 = 0x00000000
    """Placeholder exit code Windows reports for a running process."""
    _STILL_ACTIVE = 259

    """Milliseconds between child-liveness checks while a session runs."""
    _POLL_MILLISECONDS = 100

    """Seconds a contained child may take to exit before it is terminated."""
    _TERMINATE_GRACE = 2.0
    """Seconds allowed for the output pump to observe end of file."""
    _OUTPUT_JOIN = 5.0
    """Seconds spent unblocking the stdin reader before the host exits."""
    _INPUT_STOP = 1.0
    """Seconds between attempts to cancel the blocking stdin read."""
    _INPUT_CANCEL_INTERVAL = 0.05
    """Seconds spent waiting for the control pipe to accept a client."""
    _CONTROL_CONNECT = 5.0
    """Seconds allowed for the plugin to authenticate the host."""
    _CONTROL_AUTHENTICATE = 5.0
    """Seconds allowed for a cancelled control reader to stop."""
    _CONTROL_STOP = 1.0
    """Seconds between synchronous control-read cancellation attempts."""
    _CONTROL_CANCEL_INTERVAL = 0.05
    """Seconds between control-pipe connection attempts."""
    _CONTROL_RETRY_INTERVAL = 0.05

    """Win32 boolean."""
    _BOOL = wintypes.BOOL
    """Win32 unsigned 32-bit integer."""
    _DWORD = wintypes.DWORD
    """Win32 unsigned 16-bit integer."""
    _WORD = wintypes.WORD
    """Win32 unsigned integer."""
    _UINT = wintypes.UINT
    """Pointer-width Win32 object handle."""
    _HANDLE = wintypes.HANDLE
    """Pointer to a UTF-16 string."""
    _LPWSTR = wintypes.LPCWSTR
    """Untyped pointer."""
    _VOID = ctypes.c_void_p
    """Pointer-width unsigned size."""
    _SIZE = ctypes.c_size_t
    """Win32 signed 32-bit integer, used for ``HRESULT`` results."""
    _LONG = ctypes.c_long
    """Pointer-width pseudoconsole handle."""
    _HPCON = ctypes.c_void_p

    """The ``kernel32`` library, bound so Win32 errors stay readable."""
    _kernel32 = ctypes.WinDLL(  # ty: ignore[possibly-missing-attribute]
        "kernel32", use_last_error=True
    )

    class _COORD(ctypes.Structure):
        """Win32 ``COORD``: a pair of signed 16-bit cell coordinates."""

        _fields_ = (("X", ctypes.c_short), ("Y", ctypes.c_short))

    class _STARTUPINFOW(ctypes.Structure):
        """Exact Win32 ``STARTUPINFOW`` layout used by CreateProcessW."""

        _fields_ = (
            ("cb", _DWORD),
            ("lpReserved", _LPWSTR),
            ("lpDesktop", _LPWSTR),
            ("lpTitle", _LPWSTR),
            ("dwX", _DWORD),
            ("dwY", _DWORD),
            ("dwXSize", _DWORD),
            ("dwYSize", _DWORD),
            ("dwXCountChars", _DWORD),
            ("dwYCountChars", _DWORD),
            ("dwFillAttribute", _DWORD),
            ("dwFlags", _DWORD),
            ("wShowWindow", _WORD),
            ("cbReserved2", _WORD),
            ("lpReserved2", _VOID),
            ("hStdInput", _HANDLE),
            ("hStdOutput", _HANDLE),
            ("hStdError", _HANDLE),
        )

    class _STARTUPINFOEXW(ctypes.Structure):
        """Win32 ``STARTUPINFOEXW``: a startup info plus an attribute list."""

        _fields_ = (("StartupInfo", _STARTUPINFOW), ("lpAttributeList", _VOID))

    class _PROCESS_INFORMATION(ctypes.Structure):
        """Win32 ``PROCESS_INFORMATION`` returned by ``CreateProcessW``."""

        _fields_ = (
            ("hProcess", _HANDLE),
            ("hThread", _HANDLE),
            ("dwProcessId", _DWORD),
            ("dwThreadId", _DWORD),
        )

    class _JOB_LIMITS(ctypes.Structure):
        """Win32 ``JOBOBJECT_EXTENDED_LIMIT_INFORMATION``.

        Only ``LimitFlags`` is ever set, so the other members are grouped by
        type while keeping the documented offsets and total size.
        """

        _fields_ = (
            ("times", ctypes.c_int64 * 2),
            ("LimitFlags", _DWORD),
            ("working_set", _SIZE * 2),
            ("ActiveProcessLimit", _DWORD),
            ("Affinity", _SIZE),
            ("classes", _DWORD * 2),
            ("io_counters", ctypes.c_uint64 * 6),
            ("memory", _SIZE * 4),
        )

    def _bind(name: str, argtypes: tuple[Any, ...], restype: Any) -> Any:
        """Resolve one ``kernel32`` export and attach its explicit signature."""
        function = getattr(_kernel32, name)
        function.argtypes = argtypes
        function.restype = restype
        return function

    """Pointer to a Win32 handle."""
    _PHANDLE = ctypes.POINTER(_HANDLE)
    """Pointer to a Win32 unsigned 32-bit integer."""
    _PDWORD = ctypes.POINTER(_DWORD)

    """Put an existing process under a job object."""
    _AssignProcessToJobObject = _bind(
        "AssignProcessToJobObject", (_HANDLE, _HANDLE), _BOOL
    )
    """Cancel any I/O in flight on a handle, from any thread."""
    _CancelIoEx = _bind("CancelIoEx", (_HANDLE, _VOID), _BOOL)
    """Cancel synchronous I/O issued by one thread."""
    _CancelSynchronousIo = _bind("CancelSynchronousIo", (_HANDLE,), _BOOL)
    """Release one Win32 handle."""
    _CloseHandle = _bind("CloseHandle", (_HANDLE,), _BOOL)
    """Create an unnamed job object."""
    _CreateJobObjectW = _bind("CreateJobObjectW", (_VOID, _LPWSTR), _HANDLE)
    """Create a synchronous anonymous pipe pair."""
    _CreatePipe = _bind("CreatePipe", (_PHANDLE, _PHANDLE, _VOID, _DWORD), _BOOL)
    """Start a process from a command line."""
    _CreateProcessW = _bind(
        "CreateProcessW",
        (
            _LPWSTR,
            _VOID,
            _VOID,
            _VOID,
            _BOOL,
            _DWORD,
            _VOID,
            _LPWSTR,
            ctypes.POINTER(_STARTUPINFOEXW),
            ctypes.POINTER(_PROCESS_INFORMATION),
        ),
        _BOOL,
    )
    """Release a process-thread attribute list."""
    _DeleteAttributeList = _bind("DeleteProcThreadAttributeList", (_VOID,), None)
    """Duplicate a control-pipe handle for independent write ownership."""
    _DuplicateHandle = _bind(
        "DuplicateHandle",
        (_HANDLE, _HANDLE, _HANDLE, _PHANDLE, _DWORD, _BOOL, _DWORD),
        _BOOL,
    )
    """Read the exit code of a process."""
    _GetExitCodeProcess = _bind("GetExitCodeProcess", (_HANDLE, _PDWORD), _BOOL)
    """Return a pseudo-handle for the current process."""
    _GetCurrentProcess = _bind("GetCurrentProcess", (), _HANDLE)
    """Size and then initialise a process-thread attribute list."""
    _InitAttributeList = _bind(
        "InitializeProcThreadAttributeList",
        (_VOID, _DWORD, _DWORD, ctypes.POINTER(_SIZE)),
        _BOOL,
    )
    """Read bytes from a handle, blocking until some arrive."""
    _ReadFile = _bind("ReadFile", (_HANDLE, _VOID, _DWORD, _PDWORD, _VOID), _BOOL)
    """Open a thread so its pending synchronous read can be cancelled."""
    _OpenThread = _bind("OpenThread", (_DWORD, _BOOL, _DWORD), _HANDLE)
    """Resume a suspended primary process thread."""
    _ResumeThread = _bind("ResumeThread", (_HANDLE,), _DWORD)
    """Apply limits to a job object."""
    _SetInformationJobObject = _bind(
        "SetInformationJobObject", (_HANDLE, ctypes.c_int, _VOID, _DWORD), _BOOL
    )
    """Kill every process in a job object."""
    _TerminateJobObject = _bind("TerminateJobObject", (_HANDLE, _UINT), _BOOL)
    """Terminate one process when it could not enter the Job Object."""
    _TerminateProcess = _bind("TerminateProcess", (_HANDLE, _UINT), _BOOL)
    """Add one attribute to a process-thread attribute list."""
    _UpdateAttribute = _bind(
        "UpdateProcThreadAttribute",
        (_VOID, _DWORD, _SIZE, _VOID, _SIZE, _VOID, _VOID),
        _BOOL,
    )
    """Wait for one object to become signalled."""
    _WaitForSingleObject = _bind("WaitForSingleObject", (_HANDLE, _DWORD), _DWORD)
    """Write bytes to a handle."""
    _WriteFile = _bind("WriteFile", (_HANDLE, _VOID, _DWORD, _PDWORD, _VOID), _BOOL)

    def _no_conpty(*_arguments: Any) -> Any:
        """Stand in for the ConPTY exports missing before Windows 10 1809."""
        raise OSError("ConPTY requires Windows 10 version 1809 or newer")

    try:
        """Create a pseudoconsole over a pipe pair."""
        _CreatePseudoConsole = _bind(
            "CreatePseudoConsole",
            (_COORD, _HANDLE, _HANDLE, _DWORD, ctypes.POINTER(_HPCON)),
            _LONG,
        )
        """Change the cell dimensions of a pseudoconsole."""
        _ResizePseudoConsole = _bind("ResizePseudoConsole", (_HPCON, _COORD), _LONG)
        """Flush and destroy a pseudoconsole."""
        _ClosePseudoConsole = _bind("ClosePseudoConsole", (_HPCON,), None)
    except AttributeError:
        """Create a pseudoconsole over a pipe pair."""
        _CreatePseudoConsole = _no_conpty
        """Change the cell dimensions of a pseudoconsole."""
        _ResizePseudoConsole = _no_conpty
        """Flush and destroy a pseudoconsole."""
        _ClosePseudoConsole = _no_conpty

    def _as_handle(value: int | None) -> int:
        """Return a pointer-width Win32 result as a plain integer handle."""
        return 0 if value is None else int(value)

    def _close(handle: int) -> None:
        """Close a Win32 handle, ignoring an already-invalid value."""
        if handle:
            _CloseHandle(handle)

    def _last_error() -> OSError:
        """Return the calling thread's last Win32 error as an exception."""
        return ctypes.WinError(  # ty: ignore[possibly-missing-attribute]
            ctypes.get_last_error()  # ty: ignore[possibly-missing-attribute]
        )

    def _error_code(error: OSError) -> int:
        """Return the Win32 error code carried by ``error``, or ``0``."""
        return getattr(error, "winerror", None) or 0

    def _set_binary_mode() -> None:
        """Put stdin and stdout in binary mode.

        Text mode rewrites line endings in both directions and would stop the
        input pump at the first Ctrl+Z byte.
        """
        binary = os.O_BINARY  # ty: ignore[possibly-missing-attribute]
        msvcrt.setmode(_STDIN_FD, binary)  # ty: ignore[possibly-missing-attribute]
        msvcrt.setmode(_STDOUT_FD, binary)  # ty: ignore[possibly-missing-attribute]

    def _write_all(fd: int, data: bytes | memoryview) -> bool:
        """Write every byte of ``data`` to ``fd``; report whether that worked."""
        view = memoryview(data)
        while view:
            try:
                written = os.write(fd, view)
            except OSError:
                return False
            if written <= 0:
                return False
            view = view[written:]
        return True

    def _write_handle(handle: int, data: bytes) -> bool:
        """Write every byte of ``data`` to a Win32 handle."""
        buffer = (ctypes.c_char * len(data)).from_buffer_copy(data)
        written = _DWORD(0)
        offset = 0
        while offset < len(data):
            if not _WriteFile(
                handle,
                ctypes.byref(buffer, offset),
                len(data) - offset,
                ctypes.byref(written),
                None,
            ):
                return False
            if written.value == 0:
                return False
            offset += written.value
        return True

    def _create_pipe() -> tuple[int, int]:
        """Create a synchronous anonymous pipe and return ``(read, write)``."""
        read = _HANDLE()
        write = _HANDLE()
        if not _CreatePipe(ctypes.byref(read), ctypes.byref(write), None, 0):
            raise _last_error()
        return _as_handle(read.value), _as_handle(write.value)

    def _create_pseudoconsole(
        columns: int, rows: int, input_read: int, output_write: int
    ) -> int:
        """Create the pseudoconsole that owns the child's console I/O."""
        handle = _HPCON()
        result = int(
            _CreatePseudoConsole(
                _COORD(columns, rows),
                input_read,
                output_write,
                0,
                ctypes.byref(handle),
            )
        )
        # The result is an HRESULT, so only a negative value means failure.
        if result < 0 or not handle.value:
            raise OSError(f"CreatePseudoConsole failed: 0x{result & 0xFFFFFFFF:08X}")
        return _as_handle(handle.value)

    def _create_job() -> int:
        """Create a job object that kills its whole tree when it is closed."""
        job = _as_handle(_CreateJobObjectW(None, None))
        if not job:
            raise _last_error()
        limits = _JOB_LIMITS()
        limits.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not _SetInformationJobObject(
            job,
            _JOBOBJECT_EXTENDED_LIMIT_CLASS,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        ):
            error = _last_error()
            _close(job)
            raise error
        return job

    def _terminate_process(process: int) -> None:
        """Terminate an uncontained suspended child and wait for cleanup."""
        if not _TerminateProcess(process, _EXIT_TERMINATED):
            raise _last_error()
        _WaitForSingleObject(process, int(_TERMINATE_GRACE * 1000))

    def _terminate_job(job: int) -> None:
        """Terminate every contained process; Job close remains the fallback."""
        if not _TerminateJobObject(job, _EXIT_TERMINATED):
            raise _last_error()

    def _create_child(
        command_line: str,
        pseudoconsole: int,
        environment_block: str | None = None,
        cwd: str | None = None,
    ) -> tuple[int, int, int]:
        """Create a suspended child; return process, thread, and PID.

        A deferred session passes the child environment and working directory
        explicitly; an immediate session inherits both from this host.
        """
        size = _SIZE(0)
        # The first call is expected to fail; it only reports the buffer size.
        _InitAttributeList(None, 1, 0, ctypes.byref(size))
        if size.value == 0:
            raise _last_error()
        storage = ctypes.create_string_buffer(size.value)
        attributes = ctypes.cast(storage, _VOID)
        if not _InitAttributeList(attributes, 1, 0, ctypes.byref(size)):
            raise _last_error()
        information = _PROCESS_INFORMATION()
        try:
            # Microsoft's EchoCon sample at b888cb7 passes the pointer-like
            # HPCON value directly. Passing addressof(HPCON storage) adds an
            # invalid indirection and leaves the child detached from ConPTY.
            if not _update_pseudoconsole_attribute(
                _UpdateAttribute, attributes, pseudoconsole
            ):
                raise _last_error()
            startup = _STARTUPINFOEXW()
            startup.StartupInfo.cb = ctypes.sizeof(_STARTUPINFOEXW)
            # Explicit null standard handles: the parent's pipes must not be
            # inherited, so ConPTY installs its own console handles.
            startup.StartupInfo.dwFlags = _STARTF_USESTDHANDLES
            startup.StartupInfo.hStdInput = None
            startup.StartupInfo.hStdOutput = None
            startup.StartupInfo.hStdError = None
            startup.lpAttributeList = attributes
            buffer = ctypes.create_unicode_buffer(command_line)
            environment_buffer = (
                ctypes.create_unicode_buffer(environment_block)
                if environment_block
                else None
            )
            if not _CreateProcessW(
                None,
                ctypes.cast(buffer, _VOID),
                None,
                None,
                False,
                _EXTENDED_STARTUPINFO_PRESENT
                | _CREATE_SUSPENDED
                | _CREATE_UNICODE_ENVIRONMENT,
                (
                    ctypes.cast(environment_buffer, _VOID)
                    if environment_buffer
                    else None
                ),
                cwd,
                ctypes.byref(startup),
                ctypes.byref(information),
            ):
                error = _last_error()
                raise ChildStartError(
                    str(error), spawn_exit_code(_error_code(error))
                ) from error
        finally:
            _DeleteAttributeList(attributes)
        return (
            _as_handle(information.hProcess),
            _as_handle(information.hThread),
            int(information.dwProcessId),
        )

    def _exit_code(process: int) -> int:
        """Return the child exit code, or the terminated code if it still runs."""
        code = _DWORD(0)
        if not _GetExitCodeProcess(process, ctypes.byref(code)):
            return _EXIT_TERMINATED
        if code.value == _STILL_ACTIVE:
            return _EXIT_TERMINATED
        return int(code.value)

    def _duplicate_control_writer(reader: BinaryIO) -> BinaryIO:
        """Wrap an explicit DuplicateHandle result as an unbuffered writer."""
        process = _GetCurrentProcess()
        duplicated = _HANDLE()
        source = _as_handle(
            msvcrt.get_osfhandle(  # ty: ignore[possibly-missing-attribute]
                reader.fileno()
            )
        )
        if not _DuplicateHandle(
            process,
            source,
            process,
            ctypes.byref(duplicated),
            0,
            False,
            _DUPLICATE_SAME_ACCESS,
        ):
            raise _last_error()
        handle = _as_handle(duplicated.value)
        try:
            binary = os.O_BINARY  # ty: ignore[possibly-missing-attribute]
            descriptor = msvcrt.open_osfhandle(  # ty: ignore[possibly-missing-attribute]
                handle, binary | os.O_WRONLY
            )
        except OSError:
            _close(handle)
            raise
        try:
            return os.fdopen(descriptor, "wb", buffering=0)
        except OSError:
            os.close(descriptor)
            raise

    def _connect_control(pipe_name: str) -> _ControlFiles | None:
        """Open the plugin's named pipe as a client, retrying briefly."""
        deadline = time.monotonic() + _CONTROL_CONNECT
        while True:
            try:
                reader = open(  # noqa: SIM115 -- ownership moves to _ControlFiles
                    pipe_name, "r+b", buffering=0
                )
                try:
                    # One FileIO serving both directions deadlocks: a blocked
                    # synchronous read also blocks a write until it is
                    # cancelled, even through a duplicate handle. Hence the
                    # independent writer.
                    writer = _duplicate_control_writer(reader)
                except OSError:
                    reader.close()
                    raise
                return _ControlFiles(reader, writer)
            except OSError as error:
                if time.monotonic() >= deadline:
                    diagnose(f"control pipe unavailable: {error}")
                    return None
            time.sleep(_CONTROL_RETRY_INTERVAL)

    class _ConPtyHost:
        """Own one pseudoconsole session and pump its data and control planes."""

        def __init__(
            self,
            arguments: HostArguments | None,
            token: str,
            pipe_name: str | None = None,
        ) -> None:
            """Store the launch inputs and initialise empty session state.

            A deferred host passes ``arguments=None`` plus ``pipe_name``; its
            session inputs arrive later through the ``start`` operation.
            """
            self._arguments = arguments
            self._pipe_name = (
                pipe_name
                if pipe_name is not None
                else (arguments.pipe_name if arguments is not None else "")
            )
            self._child_environment: dict[str, str] | None = None
            self._child_cwd: str | None = None
            self._token = token
            self._pseudoconsole = 0
            self._input_write = 0
            self._output_read = 0
            self._job = 0
            self._process = 0
            self._thread = 0
            self._process_id = 0
            self._input_eof = threading.Event()
            self._stopping = threading.Event()
            self._handles = threading.Lock()
            # Serializes ResizePseudoConsole against pseudoconsole close
            # without holding ``_handles`` across the slow Win32 call, which
            # would block the input pump for the whole reflow.
            self._resize_lock = threading.Lock()
            self._channel = threading.Lock()
            self._control: _ControlFiles | None = None
            self._control_messages: ControlMessageReader | None = None
            self._control_reader_stop = threading.Event()
            self._control_thread: threading.Thread | None = None
            self._output_thread: threading.Thread | None = None
            self._input_thread: threading.Thread | None = None

        def run(self) -> int:
            """Run one immediate session; return the unsigned child exit code."""
            return self._run_session()

        def run_deferred(self) -> int:
            """Boot idle, authenticate, then run one session on ``start``.

            The interpreter boot, control connection, and authentication all
            happen before any terminal opens; the ``start`` operation later
            carries the session inputs. The host exits quietly when the
            control pipe closes before a session starts.
            """
            try:
                self._connect()
                self._send_required(
                    {
                        "event": "idle",
                        "token": self._token,
                        "hostPid": os.getpid(),
                    }
                )
                self._authenticate_control()
                start = self._await_start()
            except OSError as error:
                diagnose(f"could not enter the deferred session: {error}")
                self._close_control()
                return _EXIT_HOST_ERROR
            if start is None:
                self._close_control()
                return 0
            self._arguments = start.arguments
            self._child_environment = start.environment
            self._child_cwd = start.cwd
            return self._run_session()

        def _run_session(self) -> int:
            """Run one session and return the unsigned child exit code."""
            try:
                self._start()
            except OSError as error:
                diagnose(f"could not start the session: {error}")
                self._release()
                self._close_control()
                return (
                    error.exit_code
                    if isinstance(error, ChildStartError)
                    else _EXIT_HOST_ERROR
                )
            code = self._supervise()
            self._finish()
            try:
                try:
                    self._stop_control_reader()
                except OSError as error:
                    # A reader that survives its cancel window must not cost
                    # the exit report: the child's code still reaches the
                    # plugin, and the host still exits with it.
                    diagnose(f"control reader did not stop: {error}")
                self._send({"event": "exit", "code": code})
            finally:
                self._close_control()
            return code

        def _await_start(self) -> _StartRequest | None:
            """Wait for the plugin's ``start`` op; ``None`` when it leaves."""
            messages = self._require_control_messages()
            while True:
                try:
                    message = messages.next_message()
                except OSError:
                    return None
                if message is None or message.get("op") == "kill":
                    return None
                start = _parse_start(message, self._pipe_name)
                if start is not None:
                    return start
                diagnose("ignored a non-start control operation while idle")

        def _start(self) -> None:
            """Create the pseudoconsole, the child, and the worker threads."""
            arguments = self._arguments
            if arguments is None:
                raise OSError("the session arguments are missing")
            input_read, self._input_write = _create_pipe()
            self._output_read, output_write = _create_pipe()

            cwd = self._child_cwd
            if cwd is not None:
                # Match an immediate session, which the plugin starts in the
                # profile's directory: ``CreateProcessW`` searches the parent's
                # directory before PATH, and relative program names need it.
                try:
                    os.chdir(cwd)
                except OSError as error:
                    raise ChildStartError(
                        f"working directory unavailable: {cwd}",
                        _EXIT_SHELL_START_FAILED,
                    ) from error

            def create_session() -> tuple[int, int, int]:
                """Create ConPTY and its suspended child before pipe cleanup."""
                self._pseudoconsole = _create_pseudoconsole(
                    arguments.columns,
                    arguments.rows,
                    input_read,
                    output_write,
                )
                self._job = _create_job()
                environment = self._child_environment
                program, *rest = arguments.command
                return _create_child(
                    build_command_line(
                        (
                            resolve_executable(program, environment_path(environment)),
                            *rest,
                        )
                    ),
                    self._pseudoconsole,
                    _build_environment_block(environment) if environment else None,
                    self._child_cwd,
                )

            try:
                self._process, self._thread, self._process_id = create_session()
            finally:
                # Release the host copies of the ConPTY channel handles only
                # after CreateProcess has consumed them.
                _close(input_read)
                _close(output_write)
            assign_suspended_child(
                lambda: bool(_AssignProcessToJobObject(self._job, self._process)),
                lambda: _terminate_process(self._process),
            )
            if self._control is None:
                self._connect()
                self._send_hello()
                self._authenticate_control()
            else:
                # Deferred host: connected and authenticated before start.
                self._send_hello()
            resume_assigned_child(
                lambda: int(_ResumeThread(self._thread)),
                lambda: _terminate_job(self._job),
            )
            _set_binary_mode()
            self._output_thread = threading.Thread(
                target=self._pump_output, name="conpty-output", daemon=False
            )
            self._output_thread.start()
            self._input_thread = threading.Thread(
                target=self._pump_input, name="conpty-input", daemon=True
            )
            self._input_thread.start()
            self._send_required(
                {
                    "event": "ready",
                    "attestation": READY_ATTESTATION,
                    "hostPid": os.getpid(),
                    "childPid": self._process_id,
                    "createPseudoConsole": True,
                    "controlChannelAuthenticated": True,
                    "jobObjectAssigned": True,
                }
            )
            self._control_thread = threading.Thread(
                target=self._serve_control, name="conpty-control", daemon=True
            )
            self._control_thread.start()

        def _supervise(self) -> int:
            """Wait for the child to exit, or terminate it when asked to."""
            while not self._stopping.is_set():
                if (
                    _WaitForSingleObject(self._process, _POLL_MILLISECONDS)
                    == _WAIT_OBJECT_0
                ):
                    return _exit_code(self._process)
                if self._input_eof.is_set():
                    grace = int(_TERMINATE_GRACE * 1000)
                    # Terminate only a child that outlives its EOF grace.
                    if _WaitForSingleObject(self._process, grace) != _WAIT_OBJECT_0:
                        _TerminateJobObject(self._job, _EXIT_TERMINATED)
                        _WaitForSingleObject(self._process, grace)
                    return _exit_code(self._process)
            # An explicit plugin stop terminates the whole contained child tree.
            _TerminateJobObject(self._job, _EXIT_TERMINATED)
            _WaitForSingleObject(self._process, int(_TERMINATE_GRACE * 1000))
            return _exit_code(self._process)

        def _finish(self) -> None:
            """Drain the pseudoconsole and release every session handle."""
            # ``ClosePseudoConsole`` flushes the last child output through the
            # pipe and only returns once a reader drains it, so the output pump
            # must still run and its read handle must still be open.  Stopping
            # the blocked stdin reader needs no drained output, so it runs
            # concurrently to shorten the close path.
            input_stop = threading.Thread(
                target=self._stop_input_thread,
                name="conpty-input-stop",
                daemon=True,
            )
            input_stop.start()
            self._close_pseudoconsole()
            thread = self._output_thread
            if thread is not None:
                thread.join(_OUTPUT_JOIN)
                if thread.is_alive():
                    diagnose("output drain timed out")
                    _CancelIoEx(self._output_read, None)
                    thread.join(_OUTPUT_JOIN)
            input_stop.join(_INPUT_STOP)
            self._release()

        def _release(self) -> None:
            """Close every handle the session still owns, exactly once."""

            # Without a pump to drain shutdown data, the output channel must
            # break first or ClosePseudoConsole could block flushing into it.
            if self._output_thread is None:
                output_read, self._output_read = self._output_read, 0
                _close(output_read)
            self._close_pseudoconsole()
            # The job swaps out under ``_handles`` because the control
            # thread's kill path reads it under the same lock.
            with self._handles:
                input_write, self._input_write = self._input_write, 0
                job, self._job = self._job, 0
            input_thread = self._input_thread
            if input_thread is not None and input_thread.is_alive():
                # The pump may hold a snapshot of this handle for a write in
                # flight; closing it now would let Windows recycle the value
                # under that write. The host exits shortly, which releases it.
                diagnose("input pump still running; its pipe closes with the host")
            else:
                _close(input_write)
            _close(self._output_read)
            self._output_read = 0
            _close(self._thread)
            self._thread = 0
            _close(job)
            _close(self._process)
            self._process = 0

        def _close_pseudoconsole(self) -> None:
            """Close the pseudoconsole handle at most once.

            Taking ``_resize_lock`` first waits out any in-flight
            ``ResizePseudoConsole`` so the handle can never be closed under
            it. The lock order is ``_resize_lock`` then ``_handles``,
            matching ``_resize``.
            """
            with self._resize_lock, self._handles:
                pseudoconsole, self._pseudoconsole = self._pseudoconsole, 0
            if pseudoconsole:
                _ClosePseudoConsole(pseudoconsole)

        def _stop_input_thread(self) -> None:
            """Unblock the daemon stdin reader so it ends before the host does."""
            thread = self._input_thread
            if thread is None:
                return
            try:
                stdin_handle = _as_handle(
                    msvcrt.get_osfhandle(  # ty: ignore[possibly-missing-attribute]
                        _STDIN_FD
                    )
                )
            except OSError:
                return
            deadline = time.monotonic() + _INPUT_STOP
            while thread.is_alive() and time.monotonic() < deadline:
                # A cancel only lands while a read is in flight, so it has to be
                # retried until the thread reports that it is done.
                _CancelIoEx(stdin_handle, None)
                thread.join(_INPUT_CANCEL_INTERVAL)

        def _pump_output(self) -> None:
            """Copy pseudoconsole output to the host stdout descriptor.

            The write goes through ``os.write`` on the raw descriptor: a thread
            writing to ``sys.stdout.buffer`` can hold the buffered writer's lock
            while the interpreter finalises, which aborts CPython inside
            ``_enter_buffered_busy``.
            """
            buffer = ctypes.create_string_buffer(_CHUNK_SIZE)
            count = _DWORD(0)
            while True:
                if not _ReadFile(
                    self._output_read, buffer, _CHUNK_SIZE, ctypes.byref(count), None
                ):
                    return
                if count.value == 0:
                    return
                # A memoryview slice avoids two 64 KiB copies per chunk
                # (``.raw`` copies the whole buffer, the slice copies again),
                # shrinking this thread's GIL-holding window.
                if not _write_all(_STDOUT_FD, memoryview(buffer)[: count.value]):
                    return

        def _pump_input(self) -> None:
            """Copy host stdin bytes into the pseudoconsole input pipe."""
            while True:
                try:
                    data = os.read(_STDIN_FD, _CHUNK_SIZE)
                except OSError:
                    break
                if not data:
                    break
                with self._handles:
                    input_write = self._input_write
                if not input_write or not _write_handle(input_write, data):
                    break
            self._input_eof.set()

        def _connect(self) -> None:
            """Connect to the plugin and install the channel's message reader."""
            control = _connect_control(self._pipe_name)
            if control is None:
                raise OSError("the control pipe did not accept the host")
            with self._channel:
                self._control = control
                self._control_messages = ControlMessageReader(control.reader)

        def _send_hello(self) -> None:
            """Announce the created child over the authenticated channel."""
            self._send_required(
                {
                    "event": "hello",
                    "token": self._token,
                    "hostPid": os.getpid(),
                    "childPid": self._process_id,
                }
            )

        def _require_control_messages(self) -> ControlMessageReader:
            """Return the connection's message reader; fail before connect."""
            with self._channel:
                messages = self._control_messages
            if messages is None:
                raise OSError("the control channel is unavailable")
            return messages

        def _authenticate_control(self) -> None:
            """Require one valid plugin response within a bounded interval."""
            messages = self._require_control_messages()
            responses: list[object] = []
            received = threading.Event()

            def deliver(response: object) -> None:
                """Publish the single authentication response exactly once."""
                responses.append(response)
                received.set()

            def receive() -> None:
                """Read the first bounded authentication response."""
                try:
                    message = messages.next_message()
                    deliver(
                        OSError("the control channel closed")
                        if message is None
                        else message
                    )
                except OSError as error:
                    deliver(error)

            thread = threading.Thread(
                target=receive, name="conpty-authenticate", daemon=True
            )
            self._control_thread = thread
            thread.start()
            if not received.wait(timeout=_CONTROL_AUTHENTICATE):
                self._stop_control_reader()
                self._close_control()
                raise OSError("control authentication timed out")
            response = responses[0]
            thread.join(_CONTROL_CANCEL_INTERVAL)
            if thread.is_alive():
                self._stop_control_reader()
                raise OSError("the authentication reader did not stop")
            self._control_thread = None
            if isinstance(response, OSError):
                raise response
            if not isinstance(response, dict) or (
                response.get("op") != "authenticate"
                or response.get("token") != self._token
            ):
                raise OSError("control authentication failed")

        def _serve_control(self) -> None:
            """Apply operations after the authenticated ready transition."""
            try:
                messages = self._require_control_messages()
                while not self._control_reader_stop.is_set():
                    message = messages.next_message()
                    if message is None:
                        break
                    self._dispatch(message)
            except OSError as error:
                if not self._control_reader_stop.is_set():
                    diagnose(f"control channel failed: {error}")
            self._stopping.set()

        def _cancel_control_read(self, thread: threading.Thread) -> None:
            """Cancel one synchronous read issued by the control thread."""
            native_id = thread.native_id
            if native_id is None:
                raise OSError("the control reader has no native thread id")
            handle = _as_handle(_OpenThread(_THREAD_TERMINATE, False, native_id))
            if not handle:
                if not thread.is_alive():
                    return
                raise _last_error()
            try:
                if not _CancelSynchronousIo(handle):
                    error = _last_error()
                    if _error_code(error) != _ERROR_NOT_FOUND and thread.is_alive():
                        raise error
            finally:
                _close(handle)

        def _stop_control_reader(self) -> None:
            """Cancel and join the control reader within the shutdown budget."""
            thread = self._control_thread
            if thread is None:
                return
            self._control_reader_stop.set()
            _cancel_and_join_reader(
                thread,
                lambda: self._cancel_control_read(thread),
                _CONTROL_STOP,
                _CONTROL_CANCEL_INTERVAL,
            )
            self._control_thread = None

        def _dispatch(self, message: Mapping[str, Any]) -> None:
            """Apply one control message from the plugin."""
            operation = message.get("op")
            if operation == "resize":
                size = parse_resize(message)
                if size is None:
                    diagnose("ignored a malformed resize operation")
                    return
                self._resize(size[0], size[1], _parse_ack_sequence(message))
            elif operation == "kill":
                # ``_release`` swaps the job handle out under ``_handles``;
                # the lock must span the terminate call itself, or the
                # handle value could be closed and recycled between the
                # read and the use. The Win32 call is fast.
                with self._handles:
                    job = self._job
                    if job:
                        _TerminateJobObject(job, _EXIT_TERMINATED)
                self._stopping.set()
            else:
                diagnose("ignored an unknown control operation")

        def _resize(self, columns: int, rows: int, seq: int | None = None) -> None:
            """Resize the pseudoconsole unless it has already been closed.

            ``_handles`` is held only for the handle read: holding it across
            ``ResizePseudoConsole`` blocked every input write for the whole
            conhost reflow (milliseconds to tens of milliseconds).
            ``_resize_lock`` keeps the close path from invalidating the
            handle while the call is in flight.
            """
            with self._resize_lock:
                with self._handles:
                    pseudoconsole = self._pseudoconsole
                if not pseudoconsole:
                    return
                result = int(_ResizePseudoConsole(pseudoconsole, _COORD(columns, rows)))
            if result < 0:
                diagnose(f"resize failed: 0x{result & 0xFFFFFFFF:08X}")
                return
            # The ack leaves the handle lock first: a slow control write must
            # never delay input writes or pseudoconsole shutdown.
            if seq is not None:
                self._send(
                    {"event": "resized", "columns": columns, "rows": rows, "seq": seq}
                )

        def _send_required(self, message: Mapping[str, Any]) -> None:
            """Send one complete control line or fail the startup transition."""
            with self._channel:
                control = self._control
                if control is None:
                    raise OSError("the control channel is unavailable")
                _write_control_message(control, message)

        def _send(self, message: Mapping[str, Any]) -> None:
            """Send a post-readiness control message, best effort."""
            try:
                self._send_required(message)
            except OSError as error:
                diagnose(f"could not send a message: {error}")

        def _close_control(self) -> None:
            """Close the control channel once nothing else will be sent."""
            with self._channel:
                control, self._control = self._control, None
            if control is not None:
                try:
                    control.writer.close()
                except OSError:
                    pass
                thread = self._control_thread
                if thread is None or not thread.is_alive():
                    try:
                        control.reader.close()
                    except OSError:
                        pass

    def main() -> None:
        """Run the ConPTY session described by the host command line."""
        try:
            arguments = parse_arguments(sys.argv[1:])
        except ValueError as error:
            diagnose(str(error))
            sys.exit(_EXIT_HOST_ERROR)
        token = os.environ.get(TOKEN_ENVIRONMENT_VARIABLE, "")
        # The child inherits this process's environment block, so the token has
        # to be removed before the child is created.
        os.environ.pop(TOKEN_ENVIRONMENT_VARIABLE, None)
        if not token:
            diagnose("the control authentication token is missing")
            sys.exit(_EXIT_HOST_ERROR)
        if isinstance(arguments, DeferredArguments):
            sys.exit(
                to_exit_status(
                    _ConPtyHost(
                        None, token, pipe_name=arguments.pipe_name
                    ).run_deferred()
                )
            )
        sys.exit(to_exit_status(_ConPtyHost(arguments, token).run()))


if __name__ == "__main__":
    main()
