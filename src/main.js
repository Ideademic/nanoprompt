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

let settings = loadSettings();

const tabsEl = document.getElementById("tabs");
const containerEl = document.getElementById("terminal-container");
const newTabBtn = document.getElementById("new-tab");
const starBtn = document.getElementById("star-btn");
const starMenu = document.getElementById("star-menu");
const configBtn = document.getElementById("config-btn");
const quitOverlay = document.getElementById("quit-overlay");
const quitMessage = document.getElementById("quit-message");
const quitCancel = document.getElementById("quit-cancel");
const quitConfirm = document.getElementById("quit-confirm");

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

// --- Settings changed (from config window) ---

listen("settings-changed", async (event) => {
  const s = event.payload;

  if (s.theme !== settings.theme) {
    settings.theme = s.theme;
    applyChrome(s.theme);
    for (const [, session] of sessions) {
      session.term.options.theme = themes[s.theme].terminal;
    }
  }

  if (s.fontFamily !== settings.fontFamily) {
    settings.fontFamily = s.fontFamily;
    await ensureFont(s.fontFamily);
    const css = cssFontFamily(s.fontFamily);
    for (const [, session] of sessions) {
      session.term.options.fontFamily = css;
      session.fitAddon.fit();
    }
  }

  if (s.fontSize !== settings.fontSize) {
    settings.fontSize = s.fontSize;
    for (const [, session] of sessions) {
      session.term.options.fontSize = s.fontSize;
      session.fitAddon.fit();
    }
  }

  settings.starred = s.starred;
});

// --- Config ---

configBtn.addEventListener("click", () => invoke("open_config"));

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

  sessions.set(id, { term, fitAddon, wrapper, tabEl, tabNum, title: null, exited: false });
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
    session.exited = true;
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
    invoke("open_config");
  }
  if (e.key === "Escape") {
    if (!quitOverlay.classList.contains("hidden")) {
      quitOverlay.classList.add("hidden");
      const session = sessions.get(activeId);
      if (session) session.term.focus();
    }
    starMenu.classList.add("hidden");
  }
});

// --- Quit confirmation ---

listen("confirm-quit", () => {
  let running = 0;
  for (const [, session] of sessions) {
    if (!session.exited) running++;
  }
  if (running === 0) {
    invoke("force_quit");
    return;
  }
  quitMessage.textContent =
    `You have ${running} active session${running === 1 ? "" : "s"}. Quit nanoprompt?`;
  quitOverlay.classList.remove("hidden");
});

quitCancel.addEventListener("click", () => {
  quitOverlay.classList.add("hidden");
  const session = sessions.get(activeId);
  if (session) session.term.focus();
});

quitConfirm.addEventListener("click", () => {
  invoke("force_quit");
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
