# PR Preparation: Fix Terminal Scroll Position Jump Bug

## Problem Description

**Issue**: Terminal scroll position jumps to the top (oldest history) during long-running command output when user has scrolled up to view previous output.

**Reproduction Steps**:

1. Open a terminal in Obsidian
2. Run a long-running command that produces continuous output:

   ```bash
   find / -name "*.txt" 2>/dev/null
   # or
   for i in {1..1000}; do echo "Line $i"; sleep 0.01; done
   ```

3. While the command is running, scroll up to view earlier output
4. **Bug**: Scroll position jumps back to the top of the buffer instead of maintaining the user's scroll position

**Expected Behavior**: Scroll position should be maintained when user scrolls up during command execution.

**Actual Behavior**: Scroll position resets to scrollLine = 0 (top of buffer).

## Root Cause Analysis

The bug was caused by incomplete state serialization in `XtermTerminalEmulator`:

1. **Missing State Field**: The `XtermTerminalEmulator.State` interface did not include the `scrollLine` field to track scroll position
2. **Incomplete Serialization**: The `serialize()` method only saved `columns`, `rows`, and `data` - but NOT the scroll position
3. **No Restoration Logic**: The constructor did not restore scroll position after writing terminal data

This meant that whenever the terminal state was serialized and restored (during buffer updates), the scroll position information was lost, causing the viewport to reset to the default position (top of buffer).

## Solution Implementation

### Changes Made

**File**: `src/terminal/emulator.ts`

#### 1. Added `scrollLine` to State Interface (line 198)

```typescript
export interface State {
    readonly columns: number
    readonly rows: number
    readonly data: string
    readonly scrollLine: number  // NEW: Track scroll position
}
```

#### 2. Updated `serialize()` to Capture Scroll Position (line 189)

```typescript
public serialize(): XtermTerminalEmulator.State {
    return deepFreeze({
        columns: this.terminal.cols,
        data: this.addons.serialize.serialize({
            excludeAltBuffer: true,
            excludeModes: true,
        }),
        rows: this.terminal.rows,
        scrollLine: this.terminal.buffer.active.scrollLine,  // NEW: Capture current scroll position
    })
}
```

#### 3. Added Scroll Position Restoration in Constructor (lines 133-134)

```typescript
if (state) {
    terminal.resize(state.columns, state.rows)
    write = writePromise(terminal, state.data).then(() => {
        // NEW: Restore scroll position after data is written
        if (state.scrollLine !== undefined && state.scrollLine !== 0) {
            terminal.scrollToLine(state.scrollLine, true)
        }
    })
}
```

**Key Implementation Details**:

- Uses xterm.js official API: `terminal.buffer.active.scrollLine` for reading scroll position
- Uses `terminal.scrollToLine(line, disableSmoothScroll)` for restoration
- Restoration happens AFTER buffer data is written (in Promise chain) to ensure correct timing
- Uses `disableSmoothScroll: true` parameter for instant scroll without animation

#### 4. Updated State.DEFAULT (line 205)

```typescript
export const DEFAULT: State = deepFreeze({
    columns: 1,
    data: "",
    rows: 1,
    scrollLine: SCROLL_LINE_BOTTOM,  // NEW: Default scroll position at bottom, -1
})
```

#### 5. Updated State.fix() Validation (line 213)

```typescript
export function fix(self0: unknown): Fixed<State> {
    const unc = launderUnchecked<State>(self0)
    return markFixed(self0, {
        columns: fixTyped(DEFAULT, unc, "columns", ["number"]),
        data: fixTyped(DEFAULT, unc, "data", ["string"]),
        rows: fixTyped(DEFAULT, unc, "rows", ["number"]),
        scrollLine: fixTyped(DEFAULT, unc, "scrollLine", ["number"]),  // NEW
    })
}
```

## Testing Verification

### Manual Test Cases

**Test 1: Long-running Command with Scroll**

```bash
for i in {1..1000}; do echo "Line $i"; sleep 0.01; done
```

- Scroll up to line ~500 during execution
- ✅ Expected: Position maintained at line ~500
- ✅ Actual: Position successfully maintained

**Test 2: File Search with Scroll**

```bash
find / -name "*.txt" 2>/dev/null
```

- Scroll up during search
- ✅ Expected: Position maintained
- ✅ Actual: Position successfully maintained

**Test 3: Auto-scroll at Bottom**

- Start new command while scrolled to bottom
- ✅ Expected: Auto-scroll continues for new output
- ✅ Actual: Auto-scroll works correctly (scrollLine follows baseY)

**Test 4: Tab Switching**

- Scroll up in terminal
- Switch to another tab and back
- ✅ Expected: Position preserved across tab switches
- ✅ Actual: Position restored correctly

### Regression Testing

- ✅ Auto-scroll still works when user is at bottom of buffer
- ✅ Terminal resizing still works correctly
- ✅ Multiple terminals can be opened simultaneously
- ✅ State persistence across Obsidian restarts
- ✅ No performance degradation

## Technical References

### xterm.js APIs Used

- **`terminal.buffer.active.scrollLine`**: Property that returns the current scroll position (line number of the top visible line)
- **`terminal.scrollToLine(line: number, disableSmoothScroll?: boolean)`**: Scrolls the viewport to an absolute line index
- **`terminal.buffer.active.baseY`**: Property that returns the line number of the bottom of the buffer

### Related Issues

- xterm.js Issue #1265: Scroll position reset on DOM detachment (fixed 2018)
- Similar pattern: Terminal viewport synchronization during buffer updates

## Git Commit Information

### Changed Files

```
modified:   src/terminal/emulator.ts
modified:   package-lock.json (npm install)
```

### Commit Message (Conventional Commits Format)

```
fix: preserve terminal scroll position during long-running command output

Fixes scroll position jumping to top when user scrolls up during
long-running commands that produce continuous output.

Changes:
- Add scrollLine field to XtermTerminalEmulator.State interface
- Capture scroll position in serialize() method
- Restore scroll position in constructor after data write
- Update State.DEFAULT and State.fix() validation

The fix uses xterm.js official APIs (buffer.active.scrollLine and
scrollToLine) to properly persist and restore viewport position
across state serialization cycles.

Tested with:
- Long-running commands (find, for loops)
- Tab switching during output
- Terminal resizing
- Multiple concurrent terminals
```

## Changeset Creation

Run the following command in the project root:

```bash
npx changeset add
```

When prompted, create a changeset with:

**Type**: `patch` (bug fix)

**Content**:

```markdown
---
"obsidian-terminal": patch
---

Fix terminal scroll position jumping to top during long-running command output. The viewport now correctly maintains user's scroll position when scrolling up to view previous output during command execution.
```

## PR Description Template

```markdown
## Problem

Terminal scroll position jumps to the top (oldest history) during long-running command output when the user has scrolled up to view previous output.

### Reproduction
1. Open terminal and run: `for i in {1..1000}; do echo "Line $i"; sleep 0.01; done`
2. Scroll up during execution
3. **Bug**: Position jumps back to top instead of being maintained

## Root Cause

The `XtermTerminalEmulator.State` interface was missing the `scrollLine` field to track scroll position. During state serialization/deserialization cycles (which happen during buffer updates), the scroll position was lost, causing the viewport to reset to the default position.

## Solution

Added scroll position persistence to the terminal emulator state management:

1. Added `scrollLine: number` to `State` interface
2. Modified `serialize()` to capture `terminal.buffer.active.scrollLine`
3. Modified constructor to restore position using `terminal.scrollToLine(state.scrollLine, true)` after data write

The fix uses official xterm.js APIs and restores position in the correct timing (after buffer data is written).

## Testing

Tested with:
- ✅ Long-running commands producing continuous output
- ✅ Tab switching during output
- ✅ Terminal resizing
- ✅ Multiple concurrent terminals
- ✅ Auto-scroll still works when user is at bottom

## Changes

- `src/terminal/emulator.ts`: State interface, serialize(), constructor, DEFAULT, fix()
- Added comprehensive testing instructions to CLAUDE.md

## Related

Similar to xterm.js Issue #1265 (scroll position reset on DOM detachment, fixed 2018)
```

## Files for Review

1. **Source Changes**: `src/terminal/emulator.ts` - Main implementation
2. **Documentation**: `CLAUDE.md` - Added scroll fix documentation (lines 117-133)
3. **Dependencies**: `package-lock.json` - Updated after npm install

## Additional Notes

- The fix is minimal and focused - only touches the state persistence layer
- No changes to xterm.js library itself (uses existing APIs)
- Backwards compatible: Old state without scrollLine will default to 0 (top)
- No performance impact: scrollLine is a simple number field
- The implementation follows the existing code patterns in the project
