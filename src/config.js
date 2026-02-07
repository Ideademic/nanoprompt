import { themes } from "./themes.js";

const { emit } = window.__TAURI__.event;

const DEFAULTS = {
  theme: "espresso",
  fontFamily: "",
  fontSize: 14,
  starred: [],
};

function loadSettings() {
  try {
    const raw = localStorage.getItem("nanoprompt-settings");
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULTS };
}

function saveSettings() {
  localStorage.setItem("nanoprompt-settings", JSON.stringify(settings));
  emit("settings-changed", settings);
}

let settings = loadSettings();

// --- Apply chrome to this window ---

function applyChrome(name) {
  const chrome = themes[name].chrome;
  const root = document.documentElement;
  root.style.setProperty("--sidebar-bg", chrome.sidebarBg);
  root.style.setProperty("--button-bg", chrome.buttonBg);
  root.style.setProperty("--button-hover-bg", chrome.buttonHoverBg);
  root.style.setProperty("--tab-text", chrome.tabText);
  root.style.setProperty("--tab-active-text", chrome.tabActiveText);
  root.style.setProperty("--accent", chrome.accent);
}

// --- Theme ---

const themeSelect = document.getElementById("theme-select");
const themeInfo = document.getElementById("theme-info");
const themeSourcePopup = document.getElementById("theme-source-popup");

for (const [key, theme] of Object.entries(themes)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = theme.label;
  themeSelect.appendChild(opt);
}
themeSelect.value = settings.theme;

function updateThemeInfo(name) {
  const source = themes[name].source;
  if (source) {
    themeInfo.classList.remove("hidden");
  } else {
    themeInfo.classList.add("hidden");
    themeSourcePopup.classList.add("hidden");
  }
}

function showSourcePopup() {
  const source = themes[settings.theme].source;
  if (!source) return;
  themeSourcePopup.innerHTML = "";
  if (source.url) {
    const a = document.createElement("a");
    a.href = source.url;
    a.target = "_blank";
    a.textContent = source.name;
    themeSourcePopup.appendChild(a);
  } else {
    themeSourcePopup.textContent = source.name;
  }
  themeSourcePopup.classList.remove("hidden");
}

themeSelect.addEventListener("change", () => {
  const name = themeSelect.value;
  settings.theme = name;
  applyChrome(name);
  updateThemeInfo(name);
  themeSourcePopup.classList.add("hidden");
  saveSettings();
});

themeInfo.addEventListener("click", (e) => {
  e.stopPropagation();
  if (themeSourcePopup.classList.contains("hidden")) {
    showSourcePopup();
  } else {
    themeSourcePopup.classList.add("hidden");
  }
});

document.addEventListener("click", () => {
  themeSourcePopup.classList.add("hidden");
});

themeSourcePopup.addEventListener("click", (e) => e.stopPropagation());

// --- Font ---

const fontInput = document.getElementById("font-input");
fontInput.value = settings.fontFamily;

let fontDebounce = null;
fontInput.addEventListener("input", () => {
  clearTimeout(fontDebounce);
  fontDebounce = setTimeout(() => {
    settings.fontFamily = fontInput.value;
    saveSettings();
  }, 300);
});

// --- Font size ---

const fontSizeInput = document.getElementById("font-size-input");
fontSizeInput.value = settings.fontSize;

fontSizeInput.addEventListener("change", () => {
  const v = parseInt(fontSizeInput.value, 10);
  if (v >= 8 && v <= 32) {
    settings.fontSize = v;
    saveSettings();
  }
});

// --- Starred commands ---

const starredListEl = document.getElementById("starred-list");
const starredNameInput = document.getElementById("starred-name");
const starredCmdInput = document.getElementById("starred-cmd");
const starredAddBtn = document.getElementById("starred-add-btn");

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

// --- Disable context menu ---

document.addEventListener("contextmenu", (e) => e.preventDefault());

// --- Init ---

applyChrome(settings.theme);
updateThemeInfo(settings.theme);
renderStarredList();
