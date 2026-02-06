import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { themes } from "./themes.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const sessions = new Map();
let activeId = null;

const DEFAULTS = {
  theme: "espresso",
  fontFamily: "",
  fontSize: 14,
  starred: [],
};

const registeredFonts = new Set();

async function ensureFont(name) {
  const clean = name.replace(/^["']+|["']+$/g, "").trim();
  if (!clean || registeredFonts.has(clean)) return;
  registeredFonts.add(clean);
  try {
    const dataUrl = await invoke("load_font", { family: clean });
    if (dataUrl) {
      const face = new FontFace(clean, `url(${dataUrl})`);
      const loaded = await face.load();
      document.fonts.add(loaded);
    }
  } catch (e) {
    console.warn("Font load failed:", e);
  }
}

function cssFontFamily(name) {
  const clean = name.replace(/^["']+|["']+$/g, "").trim();
  if (!clean) return "monospace";
  return '"' + clean + '", monospace';
}

function loadSettings() {
  try {
    const raw = localStorage.getItem("nanoprompt-settings");
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULTS };
}

function saveSettings() {
  localStorage.setItem("nanoprompt-settings", JSON.stringify(settings));
}

let settings = loadSettings();

const tabsEl = document.getElementById("tabs");
const containerEl = document.getElementById("terminal-container");
const newTabBtn = document.getElementById("new-tab");
const starBtn = document.getElementById("star-btn");
const starMenu = document.getElementById("star-menu");
const configBtn = document.getElementById("config-btn");
const configOverlay = document.getElementById("config-overlay");
const configClose = document.getElementById("config-close");
const fontInput = document.getElementById("font-input");
const fontSizeInput = document.getElementById("font-size-input");
const themeBtns = document.querySelectorAll(".theme-btn");
const starredListEl = document.getElementById("starred-list");
const starredNameInput = document.getElementById("starred-name");
const starredCmdInput = document.getElementById("starred-cmd");
const starredAddBtn = document.getElementById("starred-add-btn");

// --- Base64 decode ---

function b64decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// --- Theme ---

function applyChrome(name) {
  const chrome = themes[name].chrome;
  const root = document.documentElement;
  root.style.setProperty("--sidebar-bg", chrome.sidebarBg);
  root.style.setProperty("--tab-bg", chrome.tabBg);
  root.style.setProperty("--tab-active-bg", chrome.tabActiveBg);
  root.style.setProperty("--tab-hover-bg", chrome.tabHoverBg);
  root.style.setProperty("--tab-text", chrome.tabText);
  root.style.setProperty("--tab-active-text", chrome.tabActiveText);
  root.style.setProperty("--accent", chrome.accent);
  root.style.setProperty("--button-bg", chrome.buttonBg);
  root.style.setProperty("--button-hover-bg", chrome.buttonHoverBg);
  document.body.style.background = themes[name].terminal.background;
}

function setTheme(name) {
  settings.theme = name;
  applyChrome(name);
  themeBtns.forEach((btn) =>
    btn.classList.toggle("active", btn.dataset.theme === name)
  );
  for (const [, session] of sessions) {
    session.term.options.theme = themes[name].terminal;
  }
  saveSettings();
}

async function setFont(name) {
  settings.fontFamily = name;
  const css = cssFontFamily(name);
  await ensureFont(name);
  for (const [, session] of sessions) {
    session.term.options.fontFamily = css;
    session.fitAddon.fit();
  }
  saveSettings();
}

function setFontSize(size) {
  settings.fontSize = size;
  for (const [, session] of sessions) {
    session.term.options.fontSize = size;
    session.fitAddon.fit();
  }
  saveSettings();
}

// --- Config panel ---

function openConfig() {
  fontInput.value = settings.fontFamily;
  fontSizeInput.value = settings.fontSize;
  themeBtns.forEach((btn) =>
    btn.classList.toggle("active", btn.dataset.theme === settings.theme)
  );
  renderStarredList();
  configOverlay.classList.remove("hidden");
}

function closeConfig() {
  configOverlay.classList.add("hidden");
  const session = sessions.get(activeId);
  if (session) session.term.focus();
}

configBtn.addEventListener("click", openConfig);
configClose.addEventListener("click", closeConfig);
configOverlay.addEventListener("click", (e) => {
  if (e.target === configOverlay) closeConfig();
});

themeBtns.forEach((btn) =>
  btn.addEventListener("click", () => setTheme(btn.dataset.theme))
);

let fontDebounce = null;
fontInput.addEventListener("input", () => {
  clearTimeout(fontDebounce);
  fontDebounce = setTimeout(() => setFont(fontInput.value), 300);
});

fontSizeInput.addEventListener("change", () => {
  const v = parseInt(fontSizeInput.value, 10);
  if (v >= 8 && v <= 32) setFontSize(v);
});

// --- Starred commands (config) ---

function renderStarredList() {
  starredListEl.innerHTML = "";
  settings.starred.forEach((entry, i) => {
    const row = document.createElement("div");
    row.className = "starred-item";
    const name = document.createElement("span");
    name.className = "starred-item-name";
    name.textContent = entry.name;
    const cmd = document.createElement("span");
    cmd.className = "starred-item-cmd";
    cmd.textContent = entry.command;
    cmd.title = entry.command;
    const del = document.createElement("button");
    del.className = "starred-item-del";
    del.textContent = "\u00d7";
    del.addEventListener("click", () => {
      settings.starred.splice(i, 1);
      saveSettings();
      renderStarredList();
    });
    row.appendChild(name);
    row.appendChild(cmd);
    row.appendChild(del);
    starredListEl.appendChild(row);
  });
}

starredAddBtn.addEventListener("click", () => {
  const name = starredNameInput.value.trim();
  const command = starredCmdInput.value.trim();
  if (!name || !command) return;
  settings.starred.push({ name, command });
  saveSettings();
  starredNameInput.value = "";
  starredCmdInput.value = "";
  renderStarredList();
});

// --- Star dropdown menu ---

function renderStarMenu() {
  starMenu.innerHTML = "";
  if (settings.starred.length === 0) {
    const empty = document.createElement("div");
    empty.className = "star-empty";
    empty.textContent = "No starred commands";
    starMenu.appendChild(empty);
    return;
  }
  settings.starred.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "star-item";
    item.textContent = entry.name;
    item.title = entry.command;
    item.addEventListener("click", () => {
      starMenu.classList.add("hidden");
      createTab(entry.command);
    });
    starMenu.appendChild(item);
  });
}

starBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (starMenu.classList.contains("hidden")) {
    renderStarMenu();
    starMenu.classList.remove("hidden");
  } else {
    starMenu.classList.add("hidden");
  }
});

// Close star menu on outside click
document.addEventListener("click", () => {
  starMenu.classList.add("hidden");
});
starMenu.addEventListener("click", (e) => e.stopPropagation());

// --- Tabs ---

let tabCounter = 0;

async function createTab(initialCommand) {
  const tabNum = ++tabCounter;
  await ensureFont(settings.fontFamily);
  const term = new Terminal({
    fontSize: settings.fontSize,
    fontFamily: cssFontFamily(settings.fontFamily),
    theme: themes[settings.theme].terminal,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const wrapper = document.createElement("div");
  wrapper.className = "terminal-wrapper";
  containerEl.appendChild(wrapper);

  term.open(wrapper);

  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (e) {
    console.warn("WebGL addon failed, using canvas renderer:", e);
  }

  fitAddon.fit();

  const rows = term.rows;
  const cols = term.cols;

  const id = await invoke("create_pty", { rows, cols });

  // Create tab element
  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.title = `Terminal ${tabNum}`;
  const labelEl = document.createElement("span");
  labelEl.className = "tab-label";
  labelEl.textContent = `Terminal ${tabNum}`;
  const closeEl = document.createElement("span");
  closeEl.className = "tab-close";
  closeEl.textContent = "\u00d7";
  tabEl.appendChild(labelEl);
  tabEl.appendChild(closeEl);
  tabsEl.appendChild(tabEl);

  labelEl.addEventListener("click", () => switchTab(id));
  closeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    closeTab(id);
  });

  term.onTitleChange((title) => {
    const session = sessions.get(id);
    if (session) {
      session.title = title;
      const display = title || `Terminal ${tabNum}`;
      labelEl.textContent = display;
      tabEl.title = display;
    }
  });

  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      invoke("write_pty", { id, data: "\x1b\r" });
      return false;
    }
    return true;
  });

  term.onData((data) => invoke("write_pty", { id, data }));
  term.onResize(({ rows, cols }) => invoke("resize_pty", { id, rows, cols }));

  sessions.set(id, { term, fitAddon, wrapper, tabEl, tabNum, title: null });
  switchTab(id);

  // Execute starred command after shell has time to initialize
  if (initialCommand) {
    setTimeout(() => {
      invoke("write_pty", { id, data: initialCommand + "\n" });
    }, 150);
  }
}

function switchTab(id) {
  if (!sessions.has(id)) return;

  activeId = id;

  for (const [sid, session] of sessions) {
    const isActive = sid === id;
    session.wrapper.classList.toggle("active", isActive);
    session.tabEl.classList.toggle("active", isActive);
  }

  const session = sessions.get(id);
  requestAnimationFrame(() => {
    session.fitAddon.fit();
    session.term.focus();
  });
}

async function closeTab(id) {
  const session = sessions.get(id);
  if (!session) return;

  await invoke("close_pty", { id });
  session.term.dispose();
  session.wrapper.remove();
  session.tabEl.remove();
  sessions.delete(id);

  if (sessions.size === 0) {
    createTab();
  } else if (activeId === id) {
    const nextId = sessions.keys().next().value;
    switchTab(nextId);
  }
}

// --- Events ---

listen("pty-output", (event) => {
  const { id, data } = event.payload;
  const session = sessions.get(id);
  if (session) session.term.write(b64decode(data));
});

listen("pty-exit", (event) => {
  const id = event.payload;
  const session = sessions.get(id);
  if (session) {
    session.term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
  }
});

// --- Resize ---

window.addEventListener("resize", () => {
  if (activeId !== null) {
    const session = sessions.get(activeId);
    if (session) session.fitAddon.fit();
  }
});

// --- Keyboard shortcuts ---

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "t") {
    e.preventDefault();
    createTab();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === ",") {
    e.preventDefault();
    if (configOverlay.classList.contains("hidden")) {
      openConfig();
    } else {
      closeConfig();
    }
  }
  if (e.key === "Escape") {
    if (!configOverlay.classList.contains("hidden")) {
      closeConfig();
    }
    starMenu.classList.add("hidden");
  }
});

// --- Disable default context menu outside terminal ---

document.addEventListener("contextmenu", (e) => {
  if (!e.target.closest(".xterm")) {
    e.preventDefault();
  }
});

// --- Init ---

newTabBtn.addEventListener("click", () => createTab());
applyChrome(settings.theme);
createTab();
