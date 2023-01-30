import { deepFreeze } from "./utils/util"

export const
	DEFAULT_ENCODING = "utf-8",
	NOTICE_NO_TIMEOUT = 0,
	TERMINAL_EXIT_SUCCESS = deepFreeze([0, "SIGINT", "SIGTERM"] as const),
	TERMINAL_RESIZE_TIMEOUT = 500,
	TERMINAL_RESIZER_WATCHDOG_INTERVAL = 500
