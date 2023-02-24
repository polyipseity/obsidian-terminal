import {
	cartesianProduct,
	deepFreeze,
	rangeCodePoint,
} from "sources/utils/util"
import type { IFunctionIdentifier } from "xterm"
import { codePoint } from "sources/utils/types"

export const FUNCTION_IDENTIFIER_PREFIXES =
	rangeCodePoint(codePoint("\x3c"), codePoint("\x3f"))
export const FUNCTION_IDENTIFIER_INTERMEDIATES =
	rangeCodePoint(codePoint("\x20"), codePoint("\x2f"))
export const FUNCTION_IDENTIFIER_FINAL = deepFreeze({
	"long": rangeCodePoint(codePoint("\x30"), codePoint("\x7e")),
	"short": rangeCodePoint(codePoint("\x40"), codePoint("\x7e")),
} as const)
export const ALL_CSI_IDENTIFIERS = deepFreeze(cartesianProduct(
	FUNCTION_IDENTIFIER_PREFIXES,
	FUNCTION_IDENTIFIER_INTERMEDIATES,
	FUNCTION_IDENTIFIER_INTERMEDIATES,
	FUNCTION_IDENTIFIER_FINAL.short,
).map(([prefix, intermediates0, intermediates1, final]) => ({
	final,
	intermediates: `${intermediates0}${intermediates1}`,
	prefix,
} as const satisfies IFunctionIdentifier)))
export const ALL_DCS_IDENTIFIERS = ALL_CSI_IDENTIFIERS
export const ALL_ESC_IDENTIFIERS = deepFreeze(cartesianProduct(
	FUNCTION_IDENTIFIER_INTERMEDIATES,
	FUNCTION_IDENTIFIER_INTERMEDIATES,
	FUNCTION_IDENTIFIER_FINAL.long,
).map(([intermediates0, intermediates1, final]) => ({
	final,
	intermediates: `${intermediates0}${intermediates1}`,
} as const satisfies IFunctionIdentifier)))
