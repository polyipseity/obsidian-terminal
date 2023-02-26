/**
 * https://github.com/komagata/eastasianwidth
 * @license MIT
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import eaw from "eastasianwidth"

eaw.slice = function slice(text, start, end) {
	const textLen = eaw.length(text)
	let start0 = start ?? 0,
		end0 = end ?? 1
	if (start0 < 0) {
		start0 = textLen + start0
	}
	if (end0 < 0) {
		end0 = textLen + end0
	}
	let result = "",
		eawLen = 0
	const chars = text
		.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\uD800-\uDFFF]/ug) || []
	for (let ii = 0; ii < chars.length; ii++) {
		const char = chars[ii],
			charLen = eaw.length(char ?? "")
		// eslint-disable-next-line no-magic-numbers
		if (eawLen >= start0 - (charLen === 2 ? 1 : 0)) {
			if (eawLen + charLen <= end0) {
				result += char
			} else {
				break
			}
		}
		eawLen += charLen
	}
	return result
}

export default eaw
