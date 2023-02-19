export const
	DEFAULT_ENCODING = "utf-8",
	DISABLED_TOOLTIP = "",
	DOUBLE_ACTION_TIMEOUT = 2,
	EXIT_SUCCESS = 0,
	JSON_STRINGIFY_SPACE = "\t",
	NOTICE_NO_TIMEOUT = 0,
	SAVE_SETTINGS_TIMEOUT = 2,
	SI_PREFIX_SCALE = 1000,
	TERMINAL_EXIT_SUCCESS = Object.freeze([
		EXIT_SUCCESS,
		"SIGINT",
		"SIGTERM",
	] as const),
	TERMINAL_RESIZE_TIMEOUT = 0.5,
	TERMINAL_RESIZER_WATCHDOG_INTERVAL = 0.5,
	TERMINAL_SEARCH_RESULTS_LIMIT = 999,
	// eslint-disable-next-line no-void
	UNDEFINED = void 0,
	UNHANDLED_REJECTION_MESSAGE = "Uncaught (in promise)"

export namespace DOMClasses {
	export const
		MOD_WARNING = "mod-warning",
		MODAL = "modal",
		MODAL_CLOSE_BUTTON = "modal-close-button",
		STATUS_BAR = "status-bar",
		VERTICAL_TAB_CONTENT = "vertical-tab-content",
		VERTICAL_TAB_CONTENT_CONTAINER = "vertical-tab-content-container",
		VIEW_HEADER_TITLE = "view-header-title",
		WORKSPACE_TAB_HEADER = "workspace-tab-header",
		WORKSPACE_TAB_HEADER_CONTAINER = "workspace-tab-header-container",
		WORKSPACE_TAB_HEADER_INNER_TITLE = "workspace-tab-header-inner-title"
}

export namespace FileExtensions {
	export const
		MARKDOWN = "md"
}
