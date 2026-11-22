/**
 * @file Breather — guided breathing sessions inside Obsidian.
 *
 * Obsidian loads this file directly (no bundler): module.exports is the plugin
 * class, and `module.exports.internals` exposes the pure helpers for
 * test/main.test.js. The plugin registers one side-panel view that animates a
 * figure (circle, planet or mandala) growing on the inhale and shrinking on the
 * exhale, and appends one row per session to a meditation log note.
 *
 * Log contract: rows must stay byte-identical to Terminal-Breather's
 * (ZenModel.js logRow / MEDITATION_LOG_HEADER, tb-guide log_session) because
 * both tools append to the same note. Minutes are floor(elapsed / 60) for an
 * early stop and the full session length when completed; under one minute
 * nothing is written.
 *
 * Constraints: no Node or desktop-only APIs (the plugin is mobile-safe); all
 * vault I/O goes through app.vault.
 */
const {
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  TFolder,
  normalizePath,
} = require("obsidian");

const VIEW_TYPE = "aven-breather-view";

/** Built-in patterns; names are what lands in the log, so they match Terminal-Breather's. */
const BUILTIN_PATTERNS = {
  box: { name: "Box breathing", inhale: 4, holdIn: 4, exhale: 4, holdOut: 4 },
  "478": { name: "4-7-8", inhale: 4, holdIn: 7, exhale: 8, holdOut: 0 },
};

/** Figure styles; every one is a single element scaled as a whole. */
const VISUALS = { circle: "Circle", planet: "Planet", mandala: "Mandala" };

const DEFAULT_LOG_PATH = "20_Practices/Meditation/Meditation Log.md";

/** Same header Terminal-Breather writes when it creates the log, so either tool yields the same file. */
const MEDITATION_LOG_HEADER =
  "# Meditation Log\n\nSessions logged by Terminal-Breather (fork of luotao.zen) — one row per session, appended automatically when a session ends.\n\n| Date | Pattern | Minutes | Completed |\n| --- | --- | --- | --- |";

// Session length bounds in minutes; 120 matches Terminal-Breather's MAX_SESSION_MINUTES.
const MIN_SESSION_MINUTES = 1;
const MAX_SESSION_MINUTES = 120;
const MINUTE_CHOICES = [1, 2, 5, 10, 15, 20];

// Custom phase bounds in seconds. Inhale and exhale need at least 1 s so the
// figure always moves; holds may be 0 (skipped).
const MAX_PHASE_SECS = 60;
const MIN_BREATH_SECS = 1;

// Figure scale at full exhale; full inhale is 1. 0.55 keeps the exhaled
// figure readable at the 160 px base size.
const MIN_SCALE = 0.55;

// Timer cadence in ms. Elapsed time comes from performance.now() deltas, not
// tick counts, so a late or skipped tick never drifts the session clock.
const TICK_MS = 100;

// A gap between ticks longer than this (ms) means the device slept or the app
// was suspended (mobile background, Windows sleep where the monotonic clock
// keeps running). The gap is not counted and the session pauses. 90 s stays
// above Chromium's one-minute intensive throttling of hidden windows, so a
// minimized-but-running session keeps counting.
const SUSPEND_GAP_MS = 90 * 1000;

const DEFAULT_SETTINGS = {
  logPath: DEFAULT_LOG_PATH,
  defaultPattern: "box",
  defaultMinutes: 5,
  visual: "circle",
  customName: "Custom",
  customInhale: 4,
  customHoldIn: 4,
  customExhale: 6,
  customHoldOut: 2,
  chime: false,
};

/**
 * Own-property test that ignores Object.prototype, so keys like "constructor"
 * from a hand-edited data.json never resolve. (Object.hasOwn is avoided for
 * older mobile WebViews.)
 * @param {object} obj Lookup table.
 * @param {*} key Candidate key; non-strings never match.
 * @returns {boolean} True when `key` is a string own property of `obj`.
 */
function hasOwn(obj, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Formats a local calendar date as YYYY-MM-DD, the log's date column.
 * @param {Date} [d] Date to format; defaults to now (local time, like Terminal-Breather).
 * @returns {string} Date key, e.g. "2026-11-22".
 */
function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Builds one meditation-log table row; a port of Terminal-Breather's logRow.
 * Pipes and newlines in the name are scrubbed so a custom name can never
 * break the table.
 * @param {string} day Date key (YYYY-MM-DD).
 * @param {string} patternName Pattern name; empty becomes "Unknown".
 * @param {number} minutes Whole minutes; fractions are floored.
 * @param {boolean} completed Whether the session ran to its full length.
 * @returns {string} Row without a trailing newline, e.g. "| 2026-11-22 | 4-7-8 | 5 | yes |".
 */
function logRow(day, patternName, minutes, completed) {
  let name = String(patternName || "")
    .replace(/[|\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) name = "Unknown";
  return `| ${day} | ${name} | ${Math.floor(Number(minutes) || 0)} | ${completed ? "yes" : "no"} |`;
}

/**
 * Minutes a session counts for, using Terminal-Breather's rule.
 * @param {number} elapsedMs Time breathed, in ms.
 * @param {number} totalMinutes Session length the user chose, in minutes.
 * @param {boolean} completed Whether the session reached its full length.
 * @returns {number} Whole minutes; 0 means "do not log".
 */
function sessionMinutes(elapsedMs, totalMinutes, completed) {
  if (completed) return Math.max(1, Math.round(totalMinutes));
  return Math.floor(Math.max(0, elapsedMs) / 60000);
}

/**
 * Clamps a number into [min, max], or returns null when it is not a finite number.
 * @param {*} value Raw value (number or numeric string).
 * @param {number} min Lower bound.
 * @param {number} max Upper bound.
 * @returns {number|null} Clamped value, or null for blank/non-numeric input.
 */
function clampNumber(value, min, max) {
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

/**
 * Parses a custom phase length typed in settings.
 * @param {*} value Raw input.
 * @param {boolean} isBreath True for inhale/exhale (minimum 1 s), false for holds (minimum 0 s).
 * @returns {number|null} Seconds rounded to 0.1 s and clamped, or null if not numeric.
 */
function parsePhaseSecs(value, isBreath) {
  const n = clampNumber(value, isBreath ? MIN_BREATH_SECS : 0, MAX_PHASE_SECS);
  return n === null ? null : Math.round(n * 10) / 10;
}

/**
 * Parses a session length in minutes.
 * @param {*} value Raw input.
 * @returns {number|null} Whole minutes in [1, 120], or null if not numeric.
 */
function parseMinutes(value) {
  const n = clampNumber(value, MIN_SESSION_MINUTES, MAX_SESSION_MINUTES);
  return n === null ? null : Math.round(n);
}

/**
 * Repairs settings loaded from data.json: wrong types, out-of-range numbers and
 * unknown keys fall back to defaults so the view can always render.
 * @param {*} raw Whatever loadData() returned (null on first run).
 * @returns {typeof DEFAULT_SETTINGS} A fresh, valid settings object.
 */
function sanitizeSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_SETTINGS;
  const phase = (key, isBreath) => {
    const n = parsePhaseSecs(r[key], isBreath);
    return n === null ? d[key] : n;
  };
  const minutes = parseMinutes(r.defaultMinutes);
  return {
    logPath: typeof r.logPath === "string" ? r.logPath.trim() : d.logPath,
    defaultPattern:
      r.defaultPattern === "custom" || hasOwn(BUILTIN_PATTERNS, r.defaultPattern)
        ? String(r.defaultPattern)
        : d.defaultPattern,
    defaultMinutes: minutes === null ? d.defaultMinutes : minutes,
    visual: hasOwn(VISUALS, r.visual) ? String(r.visual) : d.visual,
    customName: typeof r.customName === "string" ? r.customName : d.customName,
    customInhale: phase("customInhale", true),
    customHoldIn: phase("customHoldIn", false),
    customExhale: phase("customExhale", true),
    customHoldOut: phase("customHoldOut", false),
    chime: typeof r.chime === "boolean" ? r.chime : d.chime,
  };
}

/**
 * Resolves the configured log path to a vault path.
 * @param {string} raw Path from settings; blank means the default.
 * @returns {string} Normalized vault-relative path ending in ".md".
 */
function resolveLogPath(raw) {
  const trimmed = String(raw || "").trim();
  let path = normalizePath(trimmed || DEFAULT_LOG_PATH);
  // normalizePath keeps a leading slash on some versions; vault paths never have one.
  path = path.replace(/^\/+/, "");
  if (!path || path === "/") path = DEFAULT_LOG_PATH;
  if (!/\.md$/i.test(path)) path += ".md";
  return path;
}

/**
 * Returns the pattern for a key, with custom phases taken from settings.
 * @param {string} key "box", "478" or "custom"; unknown keys fall back to box.
 * @param {typeof DEFAULT_SETTINGS} settings Current (sanitized) settings.
 * @returns {{name: string, inhale: number, holdIn: number, exhale: number, holdOut: number}} Phase lengths in seconds.
 */
function resolvePattern(key, settings) {
  if (key === "custom") {
    const s = sanitizeSettings(settings);
    return {
      name: s.customName.trim() || "Custom",
      inhale: s.customInhale,
      holdIn: s.customHoldIn,
      exhale: s.customExhale,
      holdOut: s.customHoldOut,
    };
  }
  return hasOwn(BUILTIN_PATTERNS, key) ? BUILTIN_PATTERNS[key] : BUILTIN_PATTERNS.box;
}

/**
 * Where in the breath cycle a moment falls.
 * @param {{inhale: number, holdIn: number, exhale: number, holdOut: number}} pattern Phase lengths in seconds.
 * @param {number} elapsedMs Time since the session started, in ms.
 * @returns {{label: string, level: number}} Phase label and figure size, 0 (exhaled) to 1 (inhaled).
 */
function breathAt(pattern, elapsedMs) {
  const phases = [
    { label: "Breathe in", ms: pattern.inhale * 1000, from: 0, to: 1 },
    { label: "Hold", ms: pattern.holdIn * 1000, from: 1, to: 1 },
    { label: "Breathe out", ms: pattern.exhale * 1000, from: 1, to: 0 },
    { label: "Hold", ms: pattern.holdOut * 1000, from: 0, to: 0 },
  ].filter((p) => p.ms > 0);
  const cycle = phases.reduce((sum, p) => sum + p.ms, 0);
  if (cycle <= 0) return { label: "Breathe in", level: 0 };
  let t = Math.max(0, elapsedMs) % cycle;
  for (const p of phases) {
    if (t < p.ms) return { label: p.label, level: p.from + (p.to - p.from) * (t / p.ms) };
    t -= p.ms;
  }
  return { label: "Breathe in", level: 0 };
}

/**
 * Advances a running session to `now`; mutates `session`.
 * @param {{elapsedMs: number, totalMs: number, lastTick: number}} session Running session state (ms).
 * @param {number} now Monotonic timestamp in ms (performance.now()).
 * @returns {"running"|"done"|"suspended"} "done" once elapsedMs reaches totalMs (clamped there);
 *   "suspended" when the gap exceeded SUSPEND_GAP_MS, which is then not counted.
 */
function advanceSession(session, now) {
  const gap = now - session.lastTick;
  session.lastTick = now;
  if (gap > SUSPEND_GAP_MS) return "suspended";
  if (gap > 0) session.elapsedMs += gap;
  if (session.elapsedMs >= session.totalMs) {
    session.elapsedMs = session.totalMs;
    return "done";
  }
  return "running";
}

/**
 * Appends one row to the meditation log, creating the note with Terminal-Breather's
 * header when it is missing but its folder exists. A missing folder is left alone,
 * like Terminal-Breather, so a moved vault never gets a stray log.
 * @param {*} vault app.vault.
 * @param {string} path Vault path from resolveLogPath().
 * @param {string} row Row from logRow(), without newline.
 * @returns {Promise<"appended"|"created"|"no-folder"|"not-a-file">} What happened.
 * @throws Vault I/O errors (permissions, sync conflicts) propagate to the caller.
 */
async function appendLogRow(vault, path, row) {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    // process() is an atomic read-modify-write within Obsidian; the newline guard
    // keeps a hand-edited note without a final newline from gluing two rows together.
    await vault.process(existing, (data) => {
      const sep = data === "" || data.endsWith("\n") ? "" : "\n";
      return `${data}${sep}${row}\n`;
    });
    return "appended";
  }
  if (existing) return "not-a-file";
  const slash = path.lastIndexOf("/");
  const parent = slash === -1 ? "" : path.slice(0, slash);
  if (parent && !(vault.getAbstractFileByPath(parent) instanceof TFolder)) return "no-folder";
  await vault.create(path, `${MEDITATION_LOG_HEADER}\n${row}\n`);
  return "created";
}

/**
 * Builds the DOM of one figure style inside `el`; every style is static
 * geometry so the only motion is the scale the view applies to `el`.
 * @param {HTMLElement} el Figure container (emptied first).
 * @param {string} visual Key of VISUALS.
 */
function buildFigure(el, visual) {
  el.empty();
  for (const key of Object.keys(VISUALS)) el.removeClass(`is-${key}`);
  el.addClass(`is-${visual}`);
  if (visual === "planet") {
    el.createDiv({ cls: "aven-breather-ring aven-breather-ring-back" });
    el.createDiv({ cls: "aven-breather-planet" });
    el.createDiv({ cls: "aven-breather-ring aven-breather-ring-front" });
  } else if (visual === "mandala") {
    el.createDiv({ cls: "aven-breather-mandala-halo" });
    for (let i = 0; i < 12; i++) {
      el.createDiv({ cls: "aven-breather-petal is-outer" }).style.setProperty("--aven-breather-turn", `${i * 30}deg`);
    }
    for (let i = 0; i < 8; i++) {
      el.createDiv({ cls: "aven-breather-petal is-inner" }).style.setProperty("--aven-breather-turn", `${22.5 + i * 45}deg`);
    }
    el.createDiv({ cls: "aven-breather-mandala-core" });
  } else {
    el.createDiv({ cls: "aven-breather-circle" });
  }
}

/**
 * Side-panel view running one breathing session at a time.
 *
 * Invariant: a session is logged at most once. endSession() detaches
 * `this.session` before its first await, so a Stop click, a completion and a
 * view close racing each other cannot append duplicate rows.
 */
class BreatherView extends ItemView {
  /**
   * @param {*} leaf Workspace leaf hosting the view.
   * @param {BreatherPlugin} plugin Owning plugin (settings, saveSettings).
   */
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.timer = null;
    /** @type {null|{pattern: object, minutes: number, totalMs: number, elapsedMs: number, lastTick: number, running: boolean}} */
    this.session = null;
    this.patternKey = plugin.settings.defaultPattern;
    this.minutes = plugin.settings.defaultMinutes;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Breather";
  }

  getIcon() {
    return "wind";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("aven-breather");

    const controls = root.createDiv({ cls: "aven-breather-controls" });
    this.patternSel = controls.createEl("select", { cls: "dropdown aven-breather-select" });
    this.patternSel.onchange = () => {
      this.patternKey = this.patternSel.value;
      this.render();
    };
    this.minutesSel = controls.createEl("select", { cls: "dropdown aven-breather-select" });
    this.minutesSel.onchange = () => {
      this.minutes = parseMinutes(this.minutesSel.value) || this.plugin.settings.defaultMinutes;
      this.render();
    };
    this.visualSel = controls.createEl("select", { cls: "dropdown aven-breather-select" });
    for (const [k, v] of Object.entries(VISUALS)) this.visualSel.createEl("option", { value: k, text: v });
    this.visualSel.onchange = async () => {
      this.plugin.settings.visual = this.visualSel.value;
      await this.plugin.saveSettings();
    };

    const stage = root.createDiv({ cls: "aven-breather-stage" });
    this.figureEl = stage.createDiv({ cls: "aven-breather-figure" });
    this.phaseEl = root.createDiv({ cls: "aven-breather-phase", text: "Ready" });
    this.timeEl = root.createDiv({ cls: "aven-breather-time" });

    const btns = root.createDiv({ cls: "aven-breather-buttons" });
    this.startBtn = btns.createEl("button", { text: "Start", cls: "mod-cta" });
    this.startBtn.onclick = () => {
      if (this.session && this.session.running) this.pause();
      else this.start();
    };
    this.stopBtn = btns.createEl("button", { text: "Stop" });
    this.stopBtn.onclick = () => this.endSession(false);

    this.onSettingsChanged();
  }

  async onClose() {
    // Closing the panel (or disabling the plugin) mid-session counts as an
    // early stop, so the minutes already breathed are still logged.
    await this.endSession(false);
  }

  /** Re-reads settings into the controls; safe to call before onOpen. */
  onSettingsChanged() {
    if (!this.patternSel) return;
    const s = this.plugin.settings;
    this.patternSel.empty();
    for (const [k, v] of Object.entries(BUILTIN_PATTERNS)) this.patternSel.createEl("option", { value: k, text: v.name });
    this.patternSel.createEl("option", { value: "custom", text: s.customName.trim() || "Custom" });
    this.patternSel.value = this.patternKey;

    this.minutesSel.empty();
    const choices = new Set(MINUTE_CHOICES);
    choices.add(s.defaultMinutes);
    choices.add(this.minutes);
    for (const m of [...choices].sort((a, b) => a - b)) {
      this.minutesSel.createEl("option", { value: String(m), text: `${m} min` });
    }
    this.minutesSel.value = String(this.minutes);

    if (this.visualSel.value !== s.visual || !this.figureEl.hasClass(`is-${s.visual}`)) {
      this.visualSel.value = s.visual;
      buildFigure(this.figureEl, s.visual);
    }
    this.render();
  }

  clearTimer() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  start() {
    if (!this.session) {
      // Pattern and length are frozen for the session, so a settings edit
      // mid-session cannot change the rhythm or the name that gets logged.
      this.session = {
        pattern: resolvePattern(this.patternKey, this.plugin.settings),
        minutes: this.minutes,
        totalMs: this.minutes * 60000,
        elapsedMs: 0,
        lastTick: 0,
        running: false,
      };
    }
    if (this.session.running) return;
    this.session.running = true;
    this.session.lastTick = performance.now();
    this.clearTimer();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.render();
  }

  pause() {
    const s = this.session;
    if (!s) return;
    // Count up to now first: a throttled hidden window may not have ticked
    // for up to a minute, and that time was breathed.
    if (s.running && advanceSession(s, performance.now()) === "done") {
      void this.endSession(true);
      return;
    }
    s.running = false;
    this.clearTimer();
    this.render();
  }

  tick() {
    const s = this.session;
    if (!s || !s.running) {
      this.clearTimer();
      return;
    }
    const state = advanceSession(s, performance.now());
    if (state === "done") {
      void this.endSession(true);
      return;
    }
    if (state === "suspended") {
      this.pause();
      new Notice("Breather paused: the device was asleep. Press Resume to continue.");
      return;
    }
    this.render();
  }

  /**
   * Ends the current session (if any), resets the view, and logs it.
   * @param {boolean} completed True only when the full length was reached.
   * @returns {Promise<void>} Resolves after the log write settles; never rejects.
   */
  async endSession(completed) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.clearTimer();
    // Same catch-up as pause(); a Stop that lands after the end counts as completed.
    if (s.running && !completed && advanceSession(s, performance.now()) === "done") completed = true;
    this.render();
    if (completed && this.plugin.settings.chime) playChime();
    const minutes = sessionMinutes(s.elapsedMs, s.minutes, completed);
    if (minutes < 1) return;
    await this.plugin.logSession(logRow(dateKey(), s.pattern.name, minutes, completed), minutes, s.pattern.name);
  }

  /** Draws the figure, phase and countdown for the current state. */
  render() {
    const s = this.session;
    const active = s !== null;
    if (this.patternSel) this.patternSel.disabled = active;
    if (this.minutesSel) this.minutesSel.disabled = active;
    if (this.startBtn) this.startBtn.textContent = !active ? "Start" : s.running ? "Pause" : "Resume";
    if (this.stopBtn) this.stopBtn.disabled = !active;

    const pattern = active ? s.pattern : resolvePattern(this.patternKey, this.plugin.settings);
    const elapsedMs = active ? s.elapsedMs : 0;
    const { label, level } = breathAt(pattern, elapsedMs);
    const scale = MIN_SCALE + (1 - MIN_SCALE) * level;
    if (this.figureEl) this.figureEl.style.transform = `scale(${scale.toFixed(3)})`;
    if (this.phaseEl) this.phaseEl.textContent = !active ? "Ready" : s.running ? label : "Paused";
    const totalSecs = (active ? s.minutes : this.minutes) * 60;
    const remain = Math.max(0, totalSecs - Math.floor(elapsedMs / 1000));
    if (this.timeEl) this.timeEl.textContent = `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")}`;
  }
}

/** Plays a soft 660 Hz tone for 1.2 s; silently does nothing where Web Audio is unavailable. */
function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 660;
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.2);
    o.connect(g).connect(ctx.destination);
    // Close the context afterwards; browsers cap live AudioContexts per page.
    o.onended = () => void ctx.close();
    o.start();
    o.stop(ctx.currentTime + 1.2);
  } catch (e) {
    console.warn("Breather: chime unavailable", e);
  }
}

class BreatherSettingTab extends PluginSettingTab {
  /**
   * @param {*} app Obsidian app.
   * @param {BreatherPlugin} plugin Owning plugin.
   */
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    // Invalid input keeps the last good value and marks the field instead of
    // silently saving a substitute the user never typed. On blur the field
    // shows what was actually saved (clamped or the last good value).
    const validated = (setting, key, parse) =>
      setting.addText((t) => {
        t.setValue(String(s[key])).onChange(async (v) => {
          const n = parse(v);
          t.inputEl.toggleClass("aven-breather-invalid", n === null);
          if (n === null) return;
          s[key] = n;
          await save();
        });
        t.inputEl.addEventListener("blur", () => {
          t.setValue(String(s[key]));
          t.inputEl.removeClass("aven-breather-invalid");
        });
      });

    new Setting(containerEl)
      .setName("Meditation log path")
      .setDesc(`Vault path of the log note (blank = ${DEFAULT_LOG_PATH}). Rows use Terminal-Breather's table format; a missing note is created with its header if the folder exists.`)
      .addText((t) =>
        t
          .setPlaceholder(DEFAULT_LOG_PATH)
          .setValue(s.logPath)
          .onChange(async (v) => {
            s.logPath = v.trim();
            await save();
          })
      );
    new Setting(containerEl).setName("Default pattern").addDropdown((d) =>
      d
        .addOption("box", BUILTIN_PATTERNS.box.name)
        .addOption("478", BUILTIN_PATTERNS["478"].name)
        .addOption("custom", "Custom")
        .setValue(s.defaultPattern)
        .onChange(async (v) => {
          s.defaultPattern = v;
          await save();
        })
    );
    validated(
      new Setting(containerEl).setName("Default minutes").setDesc(`Whole minutes, ${MIN_SESSION_MINUTES}–${MAX_SESSION_MINUTES}.`),
      "defaultMinutes",
      parseMinutes
    );
    new Setting(containerEl)
      .setName("Figure")
      .setDesc("Shape that grows as you breathe in and shrinks as you breathe out.")
      .addDropdown((d) => {
        for (const [k, v] of Object.entries(VISUALS)) d.addOption(k, v);
        d.setValue(s.visual).onChange(async (v) => {
          s.visual = v;
          await save();
        });
      });
    new Setting(containerEl).setName("Custom pattern name").addText((t) =>
      t.setValue(s.customName).onChange(async (v) => {
        s.customName = v;
        await save();
      })
    );
    const phase = (name, key, isBreath) =>
      validated(
        new Setting(containerEl).setName(name).setDesc(`Seconds, ${isBreath ? MIN_BREATH_SECS : 0}–${MAX_PHASE_SECS}.`),
        key,
        (v) => parsePhaseSecs(v, isBreath)
      );
    phase("Custom: inhale (s)", "customInhale", true);
    phase("Custom: hold after inhale (s)", "customHoldIn", false);
    phase("Custom: exhale (s)", "customExhale", true);
    phase("Custom: hold after exhale (s)", "customHoldOut", false);
    new Setting(containerEl)
      .setName("Chime on finish")
      .setDesc("Soft tone when a session completes (not on Stop).")
      .addToggle((t) =>
        t.setValue(s.chime).onChange(async (v) => {
          s.chime = v;
          await save();
        })
      );
  }
}

/** Plugin entry point: registers the view, ribbon icon, command and settings tab. */
class BreatherPlugin extends Plugin {
  async onload() {
    this.settings = sanitizeSettings(await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new BreatherView(leaf, this));
    this.addRibbonIcon("wind", "Open Breather", () => this.activateView());
    this.addCommand({ id: "open-breather", name: "Open Breather", callback: () => this.activateView() });
    this.addSettingTab(new BreatherSettingTab(this.app, this));
  }

  /** Persists settings and pushes them to every open Breather view. */
  async saveSettings() {
    await this.saveData(this.settings);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof BreatherView) leaf.view.onSettingsChanged();
    }
  }

  /**
   * Appends a session row and tells the user the outcome. On failure the row
   * is shown in a sticky notice (and the console) so it can be pasted by hand.
   * @param {string} row Row from logRow().
   * @param {number} minutes Minutes in the row, for the notice.
   * @param {string} patternName Pattern name, for the notice.
   * @returns {Promise<void>} Never rejects.
   */
  async logSession(row, minutes, patternName) {
    const path = resolveLogPath(this.settings.logPath);
    try {
      const result = await appendLogRow(this.app.vault, path, row);
      if (result === "appended" || result === "created") {
        new Notice(`Breather: logged ${minutes} min (${patternName})`);
        return;
      }
      const why = result === "no-folder" ? `folder for ${path} does not exist` : `${path} is a folder, not a note`;
      new Notice(`Breather: not logged — ${why}.\nRow: ${row}`, 0);
    } catch (e) {
      console.error("Breather: log write failed", e);
      new Notice(`Breather: could not write to ${path}.\nRow: ${row}`, 0);
    }
  }

  /** Reveals the Breather panel, creating it in the right sidebar (or a new tab) if needed. */
  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      // getRightLeaf can return null (e.g. no right sidebar on some mobile layouts).
      leaf = workspace.getRightLeaf(false) || workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }
}

module.exports = BreatherPlugin;
module.exports.internals = {
  BUILTIN_PATTERNS,
  VISUALS,
  DEFAULT_SETTINGS,
  DEFAULT_LOG_PATH,
  MEDITATION_LOG_HEADER,
  SUSPEND_GAP_MS,
  dateKey,
  logRow,
  sessionMinutes,
  parsePhaseSecs,
  parseMinutes,
  sanitizeSettings,
  resolveLogPath,
  resolvePattern,
  breathAt,
  advanceSession,
  appendLogRow,
  buildFigure,
  BreatherView,
};
