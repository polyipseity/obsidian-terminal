export const
	CHECK_EXECUTABLE_WAIT = 5,
	DEFAULT_ENCODING = "utf-8",
	DEFAULT_PYTHON_EXECUTABLE = "python3",
	DEFAULT_PYTHONIOENCODING = `${DEFAULT_ENCODING}:backslashreplace` as const,
	EXIT_SUCCESS = 0,
	DEFAULT_SUCCESS_EXIT_CODES = Object.freeze([
		EXIT_SUCCESS.toString(),
		"SIGINT",
		"SIGTERM",
	]),
	MAX_LOCK_PENDING = 1000,
	TERMINAL_EMULATOR_RESIZE_WAIT = 0.1,
	TERMINAL_EXIT_CLEANUP_WAIT = 5,
	TERMINAL_PTY_RESIZE_WAIT = 0.5,
	TERMINAL_RESIZER_WATCHDOG_WAIT = 0.5,
	TERMINAL_SEARCH_RESULTS_LIMIT = 999,
	// eslint-disable-next-line no-void
	UNDEFINED = void 0,
	WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe",
	WINDOWS_CONHOST_PATH = "C:\\Windows\\System32\\conhost.exe"

export namespace DOMClasses2 {
	export const
		LUCIDE_HEART = "lucide-heart",
		SVG_ICON = "svg-icon"
	export namespace Namespaced {
		export const
			TERMINAL = "terminal"
	}
}
