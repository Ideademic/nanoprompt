# nanoprompt

A minimal terminal emulator with tabbed sessions, built with Tauri v2 and xterm.js.

![icon](icon.png)

Full PTY interactivity — nano, vim, and Claude Code all work. Three built-in themes, configurable fonts, and starred commands for quick-launch workflows.

## Features

- **Tabbed terminals** with full PTY support (not just a command runner — interactive TUI apps work)
- **Tab titles** update automatically from shell/program escape sequences
- **3 themes**: Espresso, Darcula, Default — live-switchable, applies to all tabs instantly
- **Custom fonts**: type any installed font name in settings
- **Starred commands**: save named commands (e.g. "Claude Code") and launch them from the sidebar
- **WebGL rendering** with automatic canvas fallback
- **Keyboard shortcuts**: Cmd/Ctrl+T new tab, Cmd/Ctrl+, settings, Escape to close panels
- **Cross-platform**: macOS (.dmg), Windows (.exe), Linux (.AppImage)

## Install

Grab a build from [Releases](../../releases), or build from source:

```
git clone https://github.com/anthropics/nanoprompt.git
cd nanoprompt
pnpm install
pnpm tauri build
```

The app bundle lands in `src-tauri/target/release/bundle/`.

## Development

```
pnpm install
pnpm tauri dev
```

## Tech Stack

- **Backend**: Tauri v2 (Rust) + `portable-pty`
- **Frontend**: Vanilla JS + xterm.js (no framework)
- **Rendering**: xterm.js WebGL addon
- **Bundler**: Vite

## Project Structure

```
index.html              Entry point
src/
  main.js               Tab management, xterm, IPC, settings
  themes.js             Espresso, Darcula, Default theme definitions
  style.css             Sidebar, tabs, config panel layout
src-tauri/
  src/lib.rs            PTY manager, 4 Tauri commands
  src/main.rs           Entry point
  tauri.conf.json       Window config, capabilities
```

## License

BSD-3-Clause
