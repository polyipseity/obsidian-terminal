# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is **Terminal for Obsidian** - an Obsidian plugin that integrates consoles, shells, and terminals inside Obsidian. It uses xterm.js v5.5.0 as the core terminal emulator and supports multiple terminal profiles, external terminals, integrated terminals, and a developer console.

## Build & Development Commands

### Essential Commands

```bash
# Install dependencies
npm install

# Type check and lint
npm run check
# Equivalent to: tsc --noEmit && eslint --cache .

# Build plugin (with checks)
npm run build
# Equivalent to: npm run check && npm run build:force

# Build without checks (faster for iteration)
npm run build:force
# Output: main.js and styles.css in project root (OUTDIR = ".")

# Auto-rebuild on changes
npm run dev

# Lint with auto-fix
npm run fix

# Install to Obsidian vault
npm run obsidian:install <vault-directory>
# Or force install without checks:
npm run obsidian:install:force
```

### Build System

- **esbuild** for bundling (see `build/build.mjs`)
- Build outputs to project root: `main.js` (1.9MB minified), `styles.css`
- Minification enabled in production, disabled in dev mode
- Source maps: inline in dev mode, none in production

## Architecture Overview

### Core Components Layer Structure

```
┌─────────────────────────────────────────────────────────┐
│ Obsidian Plugin (src/main.ts)                          │
│ - Lifecycle management, command registration           │
└────────────────┬────────────────────────────────────────┘
                 │
┌────────────────┴────────────────────────────────────────┐
│ Terminal View Layer (src/terminal/view.ts)             │
│ - TerminalView extends Obsidian ItemView                │
│ - View lifecycle: onOpen(), onClose(), setState()      │
│ - State management & persistence                       │
│ - Keyboard scope management for terminal focus         │
└────────────────┬────────────────────────────────────────┘
                 │
┌────────────────┴────────────────────────────────────────┐
│ Emulator Layer (src/terminal/emulator.ts)              │
│ - XtermTerminalEmulator wraps xterm.js Terminal        │
│ - Manages addons (FitAddon, SerializeAddon, etc.)      │
│ - State serialization & restoration                    │
│ - Resize handling (debounced/throttled)                │
└────────────────┬────────────────────────────────────────┘
                 │
┌────────────────┴────────────────────────────────────────┐
│ Pseudoterminal Layer (src/terminal/pseudoterminal.ts)  │
│ - Process spawning & I/O management                    │
│ - Platform-specific shell integration (Unix/Windows)   │
│ - Python scripts for Windows PTY (win32_resizer.py)    │
└─────────────────────────────────────────────────────────┘
```

### Key State Management

**Terminal State Persistence:**

- `XtermTerminalEmulator.State` interface stores:
  - `columns`, `rows`: Terminal dimensions
  - `data`: Serialized buffer content (via SerializeAddon)
  - `viewportY`: Scroll position (critical for scroll bug fix)
- Serialization: `serialize()` method called during view state save
- Restoration: Constructor accepts state, calls `writePromise()` + `scrollToLine()`

**View State Flow:**

```
User action → TerminalView.setState() → State deserialization
           → startEmulator() → XtermTerminalEmulator constructor
           → Terminal initialization → State restoration
           → scrollToLine(state.viewportY) [if viewportY != 0]
```

### Profile System

Profiles defined in `src/terminal/profile-presets.ts`:

- **Integrated profiles**: Run shells inside Obsidian (bash, zsh, pwsh, etc.)
- **External profiles**: Launch external terminal emulators
- **Developer console**: JavaScript REPL with Obsidian API access

Profile properties in `src/terminal/profile-properties.ts`:

- `integratable`: Can run integrated (vs external only)
- `platforms`: Supported OS (darwin, linux, win32)
- `terminalOptions`: xterm.js ITerminalOptions configuration

### Renderer System

`src/terminal/emulator-addons.ts` - `RendererAddon`:

- Manages Canvas vs WebGL rendering
- User preference: `settings.value.preferredRenderer`
- Fallback chain: WebGL → Canvas → DOM

### Critical Bug Fix: Scroll Position Preservation

**Problem:** viewportY not saved/restored, causing scroll to jump to top during long output.

**Solution implemented in `src/terminal/emulator.ts`:**

1. Added `viewportY: number` to `State` interface (line 193)
2. Capture in `serialize()`: `viewportY: this.terminal.buffer.active.viewportY` (line 184)
3. Restore in constructor after data write: `terminal.scrollToLine(state.viewportY, true)` (line 134)

**Testing scroll fix:**

```bash
# Generate long output
find / -name "*.txt" 2>/dev/null
# or
for i in {1..1000}; do echo "Line $i"; sleep 0.01; done
```

Scroll up during execution - position should be maintained.

## Source Structure

```
src/
├── @types/              # TypeScript definitions
│   ├── obsidian-terminal.ts    # Public API types
│   └── obsidian.ts             # Obsidian API extensions
├── main.ts              # Plugin entry point
├── settings.ts          # Settings UI
├── settings-data.ts     # Settings data structures & validation
├── modals.ts            # Modal dialogs (EditTerminalModal, ProfileModal)
├── terminal/
│   ├── view.ts          # TerminalView (Obsidian ItemView integration)
│   ├── emulator.ts      # XtermTerminalEmulator (xterm.js wrapper)
│   ├── emulator-addons.ts    # Custom xterm addons
│   ├── pseudoterminal.ts     # Process spawning & PTY management
│   ├── profile-presets.ts    # Default terminal profiles
│   ├── profile-properties.ts # Profile metadata & validation
│   ├── load.ts          # Terminal loading logic
│   ├── spawn.ts         # Process spawning utilities
│   └── util.ts          # Terminal utilities
├── patch.ts             # Monkey-patching for Obsidian require()
├── documentations.ts    # Embedded docs (README, CHANGELOG)
└── icons.ts             # Simple Icons integration
```

## xterm.js Integration

**Core dependencies:**

- `@xterm/xterm` v5.5.0 - Base terminal
- Addons: canvas, webgl, fit, serialize, search, ligatures, unicode11, web-links

**Key APIs used:**

- `terminal.buffer.active.viewportY` - Current scroll position
- `terminal.scrollToLine(line, disableSmoothScroll)` - Scroll to absolute line
- `terminal.onWriteParsed()` - Trigger on content update
- `terminal.onResize()` - Handle dimension changes
- `terminal.onTitleChange()` - Update tab title

**Viewport synchronization:**

- xterm.js manages internal `Viewport` class (`src/browser/Viewport.ts` in xterm.js)
- Our plugin must preserve `viewportY` across serialization cycles
- Restore after data write to prevent scroll position loss

## Development Patterns

### Async Pattern for Terminal Operations

Terminal operations are heavily async with Promise chains:

```typescript
this.pseudoterminal = write.then(async () => {
    const pty0 = await pseudoterminal(terminal, addons0)
    await pty0.pipe(terminal)
    return pty0
})
```

### Debouncing/Throttling

Resize operations use `asyncDebounce(throttle(...))` to prevent excessive calls:

- `TERMINAL_EMULATOR_RESIZE_WAIT` - Emulator resize delay
- `TERMINAL_PTY_RESIZE_WAIT` - PTY resize delay

### Settings Mutation Observation

Settings use reactive pattern:

```typescript
settings.onMutate(
    settings0 => settings0.preferredRenderer,
    cur => { renderer.use(cur) }
)
```

### Svelte for UI Components

Find component (`FindComponent`) uses Svelte 5 mount/unmount API:

```typescript
this.find = mount(FindComponent, { props: {...}, target: contentEl })
unmount(this.find, { outro: true })
```

## Changesets for Contributions

When creating PRs, add changeset files describing changes:

```bash
# Create changeset interactively
npx changeset add
```

Changeset format:

```markdown
---
"obsidian-terminal": patch
---

Description of change. ([GH#123](PR-link) by [@username](profile-link))
```

## Python Dependencies (Windows Only)

Required for Windows integrated terminals:

```bash
pip3 install psutil==5.9.5 pywinctl==0.0.50 typing_extensions==4.7.1
```

Scripts:

- `src/terminal/unix_pseudoterminal.py` - Unix PTY
- `src/terminal/win32_resizer.py` - Windows terminal resizing

## Testing in Obsidian

1. Build plugin: `npm run build`
2. Copy output to vault: `cp main.js styles.css manifest.json /path/to/vault/.obsidian/plugins/terminal/`
3. Restart Obsidian or reload plugin
4. Test with long-running commands to verify scroll behavior

## Important Configuration Files

- `tsconfig.json` - Strict TypeScript config (extends @tsconfig/strictest)
- `eslint.config.mjs` - ESLint v9 flat config
- `build/build.mjs` - esbuild configuration
- `manifest.json` - Obsidian plugin metadata
- `versions.json` - Version compatibility matrix

## API Surface

Public API in `src/@types/obsidian-terminal.ts`:

- Exposes terminal plugin API for other plugins
- Access via `app.plugins.plugins.terminal`
- Developer console context variable: `$$` (dynamically change terminal options)

## Internationalization

Localization files: `assets/locales/{lang}/translation.json`

- Uses i18next for translations
- Asset keys in separate `asset.json` files (icons, etc.)
- Language strings in `language.json`

## Testing Recommendations

Currently, this project does not have a test infrastructure. For future improvements, consider adding:

### Recommended Test Framework

- **Vitest** or **Jest** with TypeScript support
- `@testing-library` for UI component testing
- Mock xterm.js Terminal and Buffer APIs

### Critical Test Cases for Scroll Position Fix

**Edge Cases for viewportY Restoration:**

```typescript
// Test 1: Restoring viewportY = 0 (should not scroll)
test('viewportY restoration skips when at top', () => {
    const state = { columns: 80, rows: 24, data: 'test\n', viewportY: 0, wasAtBottom: false }
    // Assert: no scrollToLine() call
})

// Test 2: Restoring with empty buffer
test('viewportY restoration handles empty buffer', () => {
    const state = { columns: 80, rows: 24, data: '', viewportY: 5, wasAtBottom: false }
    // Assert: viewportY clamped to 0
})

// Test 3: Restoring with viewportY larger than buffer
test('viewportY restoration clamps out-of-bounds values', () => {
    const state = { columns: 80, rows: 24, data: 'line1\nline2\n', viewportY: 9999, wasAtBottom: false }
    // Assert: viewportY clamped to maxScrollY
})

// Test 4: Restoring with negative viewportY
test('viewportY restoration clamps negative values', () => {
    const state = { columns: 80, rows: 24, data: 'test\n', viewportY: -10, wasAtBottom: false }
    // Assert: viewportY clamped to 0
})

// Test 5: Auto-scroll behavior preservation
test('wasAtBottom flag restores auto-scroll behavior', () => {
    const state = { columns: 80, rows: 24, data: 'test\n', viewportY: 0, wasAtBottom: true }
    // Assert: scrollToBottom() called instead of scrollToLine()
})

// Test 6: Multiple serialization cycles preserve position
test('multiple save/restore cycles maintain scroll position', () => {
    const emulator = createEmulator()
    emulator.terminal.scrollToLine(10, true)
    const state1 = emulator.serialize()
    const restored = createEmulator(state1)
    const state2 = restored.serialize()
    // Assert: state1.viewportY === state2.viewportY
})
```

### Manual Testing Checklist

When testing scroll position fixes:

1. Run long command: `find / -name "*.txt" 2>/dev/null`
2. Scroll up mid-execution
3. Switch to another pane/tab (triggers state save)
4. Switch back (triggers state restore)
5. Verify: Scroll position maintained
6. Test at bottom: Should auto-scroll with new output
7. Test at top: Should stay at top
8. Test mid-scroll: Should stay at exact position
