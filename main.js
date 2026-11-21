const { Plugin, ItemView, PluginSettingTab, Setting, Notice } = require("obsidian");

const VIEW_TYPE = "aven-breather-view";

const BUILTIN_PATTERNS = {
  box: { name: "Box breathing", inhale: 4, holdIn: 4, exhale: 4, holdOut: 4 },
  "478": { name: "4-7-8", inhale: 4, holdIn: 7, exhale: 8, holdOut: 0 },
};

const DEFAULT_SETTINGS = {
  logPath: "20_Practices/Meditation/Meditation Log.md",
  defaultPattern: "box",
  defaultMinutes: 5,
  customName: "Custom",
  customInhale: 4,
  customHoldIn: 4,
  customExhale: 6,
  customHoldOut: 2,
  chime: false,
};

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class BreatherView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.timer = null;
    this.running = false;
    this.elapsedMs = 0;
    this.lastTick = 0;
    this.patternKey = plugin.settings.defaultPattern;
    this.minutes = plugin.settings.defaultMinutes;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Breather"; }
  getIcon() { return "wind"; }

  getPattern() {
    if (this.patternKey === "custom") {
      const s = this.plugin.settings;
      return { name: s.customName || "Custom", inhale: +s.customInhale || 4, holdIn: +s.customHoldIn || 0, exhale: +s.customExhale || 4, holdOut: +s.customHoldOut || 0 };
    }
    return BUILTIN_PATTERNS[this.patternKey] || BUILTIN_PATTERNS.box;
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("aven-breather");

    const controls = root.createDiv({ cls: "aven-breather-controls" });
    const patSel = controls.createEl("select", { cls: "aven-breather-select" });
    for (const [k, v] of Object.entries(BUILTIN_PATTERNS)) patSel.createEl("option", { value: k, text: v.name });
    patSel.createEl("option", { value: "custom", text: this.plugin.settings.customName || "Custom" });
    patSel.value = this.patternKey;
    patSel.onchange = () => { this.patternKey = patSel.value; this.reset(); };

    const minSel = controls.createEl("select", { cls: "aven-breather-select" });
    for (const m of [1, 2, 5, 10, 15, 20]) minSel.createEl("option", { value: String(m), text: `${m} min` });
    minSel.value = String(this.minutes);
    minSel.onchange = () => { this.minutes = +minSel.value; this.reset(); };

    this.circleEl = root.createDiv({ cls: "aven-breather-circle" });
    this.phaseEl = root.createDiv({ cls: "aven-breather-phase", text: "Ready" });
    this.timeEl = root.createDiv({ cls: "aven-breather-time", text: "" });

    const btns = root.createDiv({ cls: "aven-breather-buttons" });
    this.startBtn = btns.createEl("button", { text: "Start", cls: "mod-cta" });
    this.startBtn.onclick = () => (this.running ? this.pause() : this.start());
    const stopBtn = btns.createEl("button", { text: "Stop" });
    stopBtn.onclick = () => this.stop(true);

    this.render(0);
  }

  async onClose() {
    this.clearTimer();
    if (this.running || this.elapsedMs > 0) await this.finish(false);
  }

  clearTimer() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startBtn.textContent = "Pause";
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), 100);
  }

  pause() {
    this.running = false;
    this.startBtn.textContent = "Resume";
    this.clearTimer();
  }

  async stop(manual) {
    const wasRunning = this.running || this.elapsedMs > 0;
    this.running = false;
    this.clearTimer();
    if (wasRunning) await this.finish(false);
    this.reset();
  }

  reset() {
    this.elapsedMs = 0;
    this.running = false;
    this.clearTimer();
    if (this.startBtn) this.startBtn.textContent = "Start";
    this.render(0);
  }

  tick() {
    const now = Date.now();
    this.elapsedMs += now - this.lastTick;
    this.lastTick = now;
    const totalMs = this.minutes * 60 * 1000;
    if (this.elapsedMs >= totalMs) {
      this.elapsedMs = totalMs;
      this.running = false;
      this.clearTimer();
      this.finish(true).then(() => this.reset());
      return;
    }
    this.render(this.elapsedMs);
  }

  render(elapsedMs) {
    const p = this.getPattern();
    const cycle = (p.inhale + p.holdIn + p.exhale + p.holdOut) * 1000;
    const t = cycle > 0 ? elapsedMs % cycle : 0;
    const inMs = p.inhale * 1000, holdInMs = p.holdIn * 1000, exMs = p.exhale * 1000;
    let scale, phase;
    if (t < inMs) { scale = 0.55 + 0.45 * (t / inMs); phase = "Breathe in"; }
    else if (t < inMs + holdInMs) { scale = 1; phase = "Hold"; }
    else if (t < inMs + holdInMs + exMs) { scale = 1 - 0.45 * ((t - inMs - holdInMs) / exMs); phase = "Breathe out"; }
    else { scale = 0.55; phase = "Hold"; }
    if (this.circleEl) this.circleEl.style.transform = `scale(${scale.toFixed(3)})`;
    if (this.phaseEl) this.phaseEl.textContent = this.running || elapsedMs > 0 ? phase : "Ready";
    const remain = Math.max(0, this.minutes * 60 - Math.floor(elapsedMs / 1000));
    if (this.timeEl) this.timeEl.textContent = `${Math.floor(remain / 60)}:${String(remain % 60).padStart(2, "0")}`;
  }

  async finish(completed) {
    const secs = this.elapsedMs / 1000;
    if (secs < 60) return; // Breather rule: only sessions >= 1 min are logged
    const minutes = Math.max(1, Math.round(secs / 60));
    const p = this.getPattern();
    const row = `| ${todayStr()} | ${p.name} | ${minutes} | ${completed ? "yes" : "no"} |`;
    try {
      const file = this.app.vault.getAbstractFileByPath(this.plugin.settings.logPath);
      if (file) {
        await this.app.vault.append(file, row + "\n");
        new Notice(`Breather: logged ${minutes} min (${p.name})`);
      } else {
        new Notice(`Breather: log file not found at ${this.plugin.settings.logPath}`);
      }
    } catch (e) {
      new Notice("Breather: could not write to the meditation log");
      console.error(e);
    }
    if (this.plugin.settings.chime) this.chime();
  }

  chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 660;
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.2);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 1.2);
    } catch (e) { /* audio unavailable */ }
  }
}

class BreatherSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    new Setting(containerEl).setName("Meditation log path").setDesc("Vault path of the log note; rows are appended in Breather's table format.")
      .addText((t) => t.setValue(s.logPath).onChange(async (v) => { s.logPath = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Default pattern")
      .addDropdown((d) => d.addOption("box", "Box breathing").addOption("478", "4-7-8").addOption("custom", "Custom").setValue(s.defaultPattern)
        .onChange(async (v) => { s.defaultPattern = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Default minutes")
      .addText((t) => t.setValue(String(s.defaultMinutes)).onChange(async (v) => { s.defaultMinutes = Math.max(1, +v || 5); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Custom pattern name")
      .addText((t) => t.setValue(s.customName).onChange(async (v) => { s.customName = v; await this.plugin.saveSettings(); }));
    const num = (name, key) => new Setting(containerEl).setName(name)
      .addText((t) => t.setValue(String(s[key])).onChange(async (v) => { s[key] = Math.max(0, +v || 0); await this.plugin.saveSettings(); }));
    num("Custom: inhale (s)", "customInhale");
    num("Custom: hold after inhale (s)", "customHoldIn");
    num("Custom: exhale (s)", "customExhale");
    num("Custom: hold after exhale (s)", "customHoldOut");
    new Setting(containerEl).setName("Chime on finish")
      .addToggle((t) => t.setValue(s.chime).onChange(async (v) => { s.chime = v; await this.plugin.saveSettings(); }));
  }
}

module.exports = class BreatherPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.registerView(VIEW_TYPE, (leaf) => new BreatherView(leaf, this));
    this.addRibbonIcon("wind", "Open Breather", () => this.activateView());
    this.addCommand({ id: "open-breather", name: "Open Breather", callback: () => this.activateView() });
    this.addSettingTab(new BreatherSettingTab(this.app, this));
  }

  async saveSettings() { await this.saveData(this.settings); }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
};
