// Covers Breather's log contract (row format parity with Terminal-Breather,
// minute rules, create/append behaviour), settings repair, breath timing, and
// the view's log-once guarantee when Stop, completion and close race.
// Run: node --test (no dependencies; "obsidian" is replaced by a stub below).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

class FakeEl {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.classes = new Set();
    this.style = { setProperty() {} };
    this.textContent = "";
    this.value = "";
    this.disabled = false;
  }
  empty() { this.children = []; }
  addClass(c) { for (const x of c.split(" ")) this.classes.add(x); }
  removeClass(c) { this.classes.delete(c); }
  hasClass(c) { return this.classes.has(c); }
  toggleClass(c, on) { if (on) this.addClass(c); else this.removeClass(c); }
  createEl(tag, opts = {}) {
    const el = new FakeEl(tag);
    if (opts.cls) el.addClass(opts.cls);
    if (opts.text !== undefined) el.textContent = opts.text;
    if (opts.value !== undefined) el.value = opts.value;
    this.children.push(el);
    return el;
  }
  createDiv(opts) { return this.createEl("div", opts); }
}

class TAbstractFile { constructor(path) { this.path = path; } }
class TFile extends TAbstractFile {}
class TFolder extends TAbstractFile {}
const notices = [];
const obsidianStub = {
  Plugin: class {},
  ItemView: class { constructor(leaf) { this.leaf = leaf; this.contentEl = new FakeEl(); } },
  PluginSettingTab: class {},
  Setting: class {},
  Notice: class { constructor(msg) { notices.push(msg); } },
  TFile,
  TFolder,
  normalizePath: (p) => p.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === "obsidian" ? obsidianStub : realLoad.call(this, request, ...rest);
};
globalThis.window = globalThis;
const I = require("../main.js").internals;

/** In-memory vault with the subset of app.vault that Breather uses. */
function fakeVault(files = {}, folders = [], { failWrites = false } = {}) {
  const data = { ...files };
  return {
    data,
    getAbstractFileByPath(p) {
      if (p in data) return new TFile(p);
      if (folders.includes(p)) return new TFolder(p);
      return null;
    },
    async process(file, fn) {
      if (failWrites) throw new Error("EACCES");
      data[file.path] = fn(data[file.path]);
    },
    async create(p, content) {
      if (failWrites) throw new Error("EACCES");
      data[p] = content;
    },
  };
}

test("log rows match Terminal-Breather's logRow golden cases", () => {
  // Expected strings copied from Terminal-Breather test/ZenModel.test.js.
  assert.equal(I.logRow("2026-11-11", "Breath of Fire", 5, true), "| 2026-11-11 | Breath of Fire | 5 | yes |");
  assert.equal(I.logRow("2026-11-11", "Box breathing", 2, false), "| 2026-11-11 | Box breathing | 2 | no |");
  assert.equal(I.logRow("2026-11-11", "We|ird\nName", 3, true), "| 2026-11-11 | We ird Name | 3 | yes |");
  assert.equal(I.logRow("2026-11-11", "", 1, true), "| 2026-11-11 | Unknown | 1 | yes |");
});

test("header is Terminal-Breather's MEDITATION_LOG_HEADER", () => {
  assert.equal(
    I.MEDITATION_LOG_HEADER,
    "# Meditation Log\n\nSessions logged by Terminal-Breather (fork of luotao.zen) — one row per session, appended automatically when a session ends.\n\n| Date | Pattern | Minutes | Completed |\n| --- | --- | --- | --- |"
  );
});

test("minutes: floor of elapsed when stopped early, full length when completed", () => {
  assert.equal(I.sessionMinutes(59_999, 5, false), 0);
  assert.equal(I.sessionMinutes(119_900, 5, false), 1);
  assert.equal(I.sessionMinutes(150_000, 5, false), 2);
  assert.equal(I.sessionMinutes(300_000, 5, true), 5);
});

test("appendLogRow appends, repairs a missing final newline, and creates with header", async () => {
  const path = "20_Practices/Meditation/Meditation Log.md";
  const v = fakeVault({ [path]: "| a |" }, ["20_Practices/Meditation"]);
  assert.equal(await I.appendLogRow(v, path, "| r1 |"), "appended");
  assert.equal(await I.appendLogRow(v, path, "| r2 |"), "appended");
  assert.equal(v.data[path], "| a |\n| r1 |\n| r2 |\n");

  const fresh = fakeVault({}, ["20_Practices/Meditation"]);
  assert.equal(await I.appendLogRow(fresh, path, "| r |"), "created");
  assert.equal(fresh.data[path], `${I.MEDITATION_LOG_HEADER}\n| r |\n`);

  assert.equal(await I.appendLogRow(fakeVault(), path, "| r |"), "no-folder");
  assert.equal(await I.appendLogRow(fakeVault({}, [path]), path, "| r |"), "not-a-file");
  const root = fakeVault();
  assert.equal(await I.appendLogRow(root, "Log.md", "| r |"), "created");
});

test("resolveLogPath normalizes and defaults", () => {
  assert.equal(I.resolveLogPath(""), I.DEFAULT_LOG_PATH);
  assert.equal(I.resolveLogPath("   "), I.DEFAULT_LOG_PATH);
  assert.equal(I.resolveLogPath("/Notes//Log.md"), "Notes/Log.md");
  assert.equal(I.resolveLogPath("Notes/Log"), "Notes/Log.md");
});

test("sanitizeSettings repairs bad data.json values", () => {
  const s = I.sanitizeSettings({
    logPath: 42,
    defaultPattern: "constructor",
    defaultMinutes: "abc",
    visual: "toString",
    customName: null,
    customInhale: 0,
    customHoldIn: -3,
    customExhale: "Infinity",
    customHoldOut: 1000,
    chime: "yes",
  });
  assert.deepEqual(s, {
    ...I.DEFAULT_SETTINGS,
    customInhale: 1,
    customHoldIn: 0,
    customHoldOut: 60,
  });
  assert.deepEqual(I.sanitizeSettings(null), I.DEFAULT_SETTINGS);
  assert.equal(I.sanitizeSettings({ defaultMinutes: 500 }).defaultMinutes, 120);
  assert.equal(I.sanitizeSettings({ defaultMinutes: "7.4" }).defaultMinutes, 7);
  assert.equal(I.sanitizeSettings({ visual: "mandala" }).visual, "mandala");
  assert.equal(I.parseMinutes(""), null);
  assert.equal(I.parsePhaseSecs("5.55", true), 5.6);
});

test("breathAt follows the phases and skips zero-length holds", () => {
  const box = I.BUILTIN_PATTERNS.box;
  assert.deepEqual(I.breathAt(box, 0), { label: "Breathe in", level: 0 });
  assert.deepEqual(I.breathAt(box, 2000), { label: "Breathe in", level: 0.5 });
  assert.deepEqual(I.breathAt(box, 5000), { label: "Hold", level: 1 });
  assert.deepEqual(I.breathAt(box, 10_000), { label: "Breathe out", level: 0.5 });
  assert.deepEqual(I.breathAt(box, 13_000), { label: "Hold", level: 0 });
  assert.deepEqual(I.breathAt(box, 16_000), { label: "Breathe in", level: 0 });
  const p478 = I.BUILTIN_PATTERNS["478"];
  assert.equal(I.breathAt(p478, 18_999).label, "Breathe out");
  assert.equal(I.breathAt(p478, 19_000).label, "Breathe in");
});

test("advanceSession counts real time, clamps at the end, and drops sleep gaps", () => {
  const s = { elapsedMs: 0, totalMs: 60_000, lastTick: 1000 };
  assert.equal(I.advanceSession(s, 1250), "running");
  assert.equal(s.elapsedMs, 250);
  assert.equal(I.advanceSession(s, 1250 + I.SUSPEND_GAP_MS + 1), "suspended");
  assert.equal(s.elapsedMs, 250);
  assert.equal(I.advanceSession(s, s.lastTick + 80_000), "done");
  assert.equal(s.elapsedMs, 60_000);
});

/** Builds a view on a fake vault; returns the view and the vault. */
async function openView(vaultOpts = {}) {
  const vault = fakeVault({ "M/Log.md": "" }, ["M"], vaultOpts);
  const plugin = {
    settings: I.sanitizeSettings({ logPath: "M/Log.md" }),
    app: { vault },
    async saveSettings() {},
  };
  plugin.logSession = require("../main.js").prototype.logSession.bind(plugin);
  const view = new I.BreatherView({}, plugin);
  view.app = plugin.app;
  await view.onOpen();
  return { view, vault };
}

test("a session is logged once even when Stop and close race", async () => {
  const { view, vault } = await openView();
  view.start();
  view.session.elapsedMs = 125_000;
  await Promise.all([view.endSession(false), view.onClose()]);
  view.clearTimer();
  assert.match(vault.data["M/Log.md"], /^\| \d{4}-\d{2}-\d{2} \| Box breathing \| 2 \| no \|\n$/);
});

test("completion logs yes once; closing afterwards adds nothing", async () => {
  const { view, vault } = await openView();
  view.minutes = 1;
  view.start();
  view.session.lastTick = performance.now() - 61_000;
  view.tick();
  await view.onClose();
  assert.match(vault.data["M/Log.md"], /^\| \d{4}-\d{2}-\d{2} \| Box breathing \| 1 \| yes \|\n$/);
  assert.equal(view.timer, null);
});

test("closing mid-session under a minute writes nothing; a failed write surfaces the row", async () => {
  const { view, vault } = await openView();
  view.start();
  view.session.elapsedMs = 30_000;
  await view.onClose();
  assert.equal(vault.data["M/Log.md"], "");

  const failing = await openView({ failWrites: true });
  failing.view.start();
  failing.view.session.elapsedMs = 60_000;
  notices.length = 0;
  await failing.view.onClose();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /could not write.*\nRow: \| \d{4}-\d{2}-\d{2} \| Box breathing \| 1 \| no \|/s);
});

test("Stop counts time since the last (throttled) tick and marks an overdue session completed", async () => {
  const { view, vault } = await openView();
  view.start();
  view.session.elapsedMs = 70_000;
  view.session.lastTick = performance.now() - 80_000;
  await view.endSession(false);
  assert.match(vault.data["M/Log.md"], /\| Box breathing \| 2 \| no \|\n$/);

  view.minutes = 1;
  view.start();
  view.session.lastTick = performance.now() - 70_000;
  await view.endSession(false);
  assert.match(vault.data["M/Log.md"], /\| Box breathing \| 1 \| yes \|\n$/);
});

test("custom pattern is frozen at start and its name is scrubbed in the row", async () => {
  const { view, vault } = await openView();
  view.plugin.settings.customName = "Slow|wave";
  view.patternKey = "custom";
  view.start();
  view.plugin.settings.customName = "Renamed mid-session";
  view.session.elapsedMs = 60_000;
  await view.endSession(false);
  assert.match(vault.data["M/Log.md"], /\| Slow wave \| 1 \| no \|\n$/);
});

test("each visual builds its own figure", () => {
  for (const visual of Object.keys(I.VISUALS)) {
    const el = new FakeEl();
    I.buildFigure(el, visual);
    assert.ok(el.hasClass(`is-${visual}`));
    assert.ok(el.children.length > 0);
  }
  const el = new FakeEl();
  I.buildFigure(el, "mandala");
  I.buildFigure(el, "circle");
  assert.ok(!el.hasClass("is-mandala"));
  assert.equal(el.children.length, 1);
});
