# Breather (Obsidian)

Guided breathing sessions inside Obsidian — box breathing, 4-7-8, or a custom pattern — that log to a meditation log note in your vault.

Built as the away-from-desktop companion to [Terminal-Breather](https://github.com/AventurineDream/Terminal-Breather): same patterns, same log format.

## Features

- Panel view with an animated breathing circle and phase labels (Breathe in / Hold / Breathe out) plus a countdown
- Patterns: **Box breathing** (4·4·4·4), **4-7-8**, and one **custom** pattern (four phase lengths, set in settings)
- Session lengths: 1, 2, 5, 10, 15, or 20 minutes; start / pause / stop
- Sessions of one minute or more append a row to your meditation log note:

  ```
  | 2026-11-21 | Box breathing | 5 | yes |
  ```

  Completed sessions log `yes`; early stops log `no` (same rule as Terminal-Breather).
- Optional finish chime
- Works on mobile (no desktop-only APIs); the timer runs while the view is open

## Install

**BRAT** (recommended until this is in the community directory): add `AventurineDream/Obsidian-Breather` in BRAT settings.

**Manual**: copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/aven-breather/`, then enable **Breather** under Community plugins.

## Settings

- **Meditation log path** — vault path of the log note (default `20_Practices/Meditation/Meditation Log.md`)
- **Default pattern / Default minutes**
- **Custom pattern** — name and the four phase lengths in seconds
- **Chime on finish** — soft tone when a session completes

## License

MIT
