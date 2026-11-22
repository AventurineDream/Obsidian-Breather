# Breather (Obsidian)

Guided breathing sessions inside Obsidian — box breathing, 4-7-8, or a custom pattern — that log to a meditation log note in your vault.

Built as the away-from-desktop companion to [Terminal-Breather](https://github.com/AventurineDream/Terminal-Breather): same patterns, same log format.

## Features

- Panel view with a breathing figure — **circle**, **planet** or **mandala** — that grows as you breathe in and shrinks as you breathe out, with phase labels (Breathe in / Hold / Breathe out) and a countdown
- Patterns: **Box breathing** (4·4·4·4), **4-7-8**, and one **custom** pattern (four phase lengths, set in settings)
- Session lengths: 1, 2, 5, 10, 15, or 20 minutes (plus your default, 1–120); start / pause / stop. Pattern and length are locked once a session starts.
- Sessions of one minute or more append a row to your meditation log note:

  ```
  | 2026-11-21 | Box breathing | 5 | yes |
  ```

  Same rules as Terminal-Breather: completed sessions log the full length and `yes`; early stops (Stop, or closing the panel) log the whole minutes breathed and `no`. A missing log note is created with Terminal-Breather's header if its folder exists; if the folder is missing or the write fails, a notice shows the row so you can paste it by hand.
- Optional chime when a session completes
- Works on mobile (no desktop-only APIs); the timer runs while the view is open. If the device sleeps (a gap over 90 s), the session pauses and the gap is not counted.

## Install

**BRAT**: add `AventurineDream/Obsidian-Breather` in BRAT settings. BRAT installs from GitHub releases, so this needs a published release carrying `main.js`, `manifest.json`, and `styles.css`.

**Manual**: copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/aven-breather/`, then enable **Breather** under Community plugins.

## Settings

- **Meditation log path** — vault path of the log note (default `20_Practices/Meditation/Meditation Log.md`)
- **Default pattern / Default minutes** (whole minutes, 1–120)
- **Figure** — circle, planet or mandala (also switchable in the panel)
- **Custom pattern** — name and the four phase lengths in seconds (inhale/exhale 1–60, holds 0–60); invalid input is marked and not saved
- **Chime on finish** — soft tone when a session completes (not on Stop)

## Development

No build step: `main.js` ships as-is. Checks need Node 20+ and no dependencies:

```
npm run check   # node --check
npm test        # node --test
```

## License

MIT
