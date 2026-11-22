# Changelog

## [Unreleased]

## [0.2.0] — 2026-11-22

### Added
- Planet and mandala figures alongside the circle; pick one in the panel or under **Figure** in settings. Each figure only grows on the inhale and shrinks on the exhale.
- A missing log note is created with Terminal-Breather's header when its folder exists.
- Tests (`npm test`): log-row parity with Terminal-Breather, minute rules, settings repair, timing, and log-once on close.

### Fixed
- Early stops logged rounded minutes (1:40 → 2); they now log floor(elapsed), like Terminal-Breather. Completed sessions log the full length.
- A session could be logged twice when a Stop click, completion or panel close overlapped.
- Changing the pattern or length mid-session silently discarded the session; both selectors are now locked while a session is active, and the pattern is frozen at Start.
- Sleep/suspend gaps counted as breathing time; the timer now uses a monotonic clock and pauses after a gap over 90 s. Stop and Pause count time up to the click even when a hidden window's timer was throttled.
- The chime played on Stop and only when a row was logged; it now plays on completion only.
- Pipes or newlines in the custom pattern name broke the log table.
- Rows were glued onto the last line of a note without a final newline.
- A failed log write lost the row; the notice now shows it so it can be pasted by hand.
- Settings validation: non-numeric or out-of-range values (default minutes 1–120, inhale/exhale 1–60 s, holds 0–60 s) are rejected or clamped instead of saved as 0 or Infinity; corrupted `data.json` values fall back to defaults; a default length outside the menu is now selectable.
- The panel now opens in a new tab where no right sidebar leaf is available.

### Changed
- `minAppVersion` is 1.1.0 (uses `vault.process` for atomic appends).

## [0.1.0] — 2026-11-21

### Added
- First release: box, 4-7-8 and custom patterns, animated circle, meditation-log rows.
