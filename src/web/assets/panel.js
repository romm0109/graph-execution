// @ts-check
// Right panel shared by the run and suite pages: drag-resize, remembered width/open/tab, tabs, full-screen sheet when narrow.

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 640;
const STEP = 32;
const TAB_LABEL = { review: "Review", overview: "Overview", changes: "Changes", logs: "Logs" };

/**
 * Pure: clamps a requested width to [320, 0.85*viewport].
 * @param {number} w
 * @param {number} viewport
 */
export function clampWidth(w, viewport) { return Math.round(Math.min(Math.max(w, MIN_WIDTH), Math.floor(viewport * 0.85))); }

/**
 * Pure: reads {width, open, tab} from a JSON string; defaults on any error.
 * @param {string} text
 */
export function readPanelState(text) {
  const state = { width: DEFAULT_WIDTH, open: false, tab: "overview" };
  try {
    const o = JSON.parse(text || "");
    if (o && typeof o.width === "number" && Number.isFinite(o.width)) state.width = o.width;
    if (o && typeof o.open === "boolean") state.open = o.open;
    if (o && typeof o.tab === "string" && o.tab) state.tab = o.tab;
  } catch { /* defaults */ }
  return state;
}

/** @param {EventTarget | null} t */
const typing = (t) => !!t && /** @type {HTMLElement} */ (t).isContentEditable === true || (!!t && ["INPUT", "TEXTAREA", "SELECT"].includes(/** @type {HTMLElement} */ (t).tagName));

/**
 * @param {HTMLElement} mainEl the grid container; the panel becomes its second column
 * @returns {{open(title: string, statusChip?: string | {text: string, color?: string}): void, close(): void, setTab(name: string): void, tab(name: string): HTMLElement, addTab(name: string, o?: {first?: boolean}): void, removeTab(name: string): void, footer(): HTMLElement, setWidth(w: number): void, userSized(): boolean, onClose(fn: () => void): void, onTab(fn: (name: string) => void): void, isOpen(): boolean, el: HTMLElement}}
 */
export function createPanel(mainEl, { storageKey = "ge.panel", tabs = ["overview", "changes", "logs"] } = {}) {
  /** @type {{width: number, open: boolean, tab: string, sized?: boolean}} */
  const state = (() => { try { return readPanelState(localStorage.getItem(storageKey) || ""); } catch { return readPanelState(""); } })();
  try { if (JSON.parse(localStorage.getItem(storageKey) || "null")?.sized === true) state.sized = true; } catch { /* no saved state */ }
  if (!tabs.includes(state.tab)) state.tab = tabs[0] || "overview";
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* the page works without it */ } };

  const el = document.createElement("aside");
  el.id = "panel";
  el.hidden = true;
  const handle = document.createElement("div");
  handle.className = "panel-resize";
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize panel");
  handle.setAttribute("aria-valuemin", String(MIN_WIDTH));
  const back = document.createElement("button");
  back.type = "button";
  back.className = "panel-back";
  back.textContent = "← Graph";
  const title = document.createElement("div");
  title.className = "panel-title";
  const chip = document.createElement("span");
  chip.className = "panel-chip";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "panel-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Close");
  const head = document.createElement("div");
  head.className = "panel-head";
  head.append(back, title, chip, closeBtn);
  const bar = document.createElement("div");
  bar.className = "panel-tabs";
  bar.setAttribute("role", "tablist");
  /** @type {Map<string, HTMLElement>} */
  const bodies = new Map();
  /** @type {Map<string, HTMLElement>} */
  const buttons = new Map();
  /** Names of the tabs shown, in order; a removed tab keeps its (hidden) body so `tab(name)` stays valid. @type {string[]} */
  let shown = [];
  /** @param {string} name */
  const makeTab = (name) => {
    if (bodies.has(name)) return;
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "tab");
    b.dataset.tab = name;
    b.textContent = TAB_LABEL[/** @type {keyof typeof TAB_LABEL} */ (name)] || name;
    b.addEventListener("click", () => setTab(name));
    buttons.set(name, b);
    const body = document.createElement("div");
    body.className = "panel-body";
    body.dataset.tab = name;
    body.setAttribute("role", "tabpanel");
    bodies.set(name, body);
    el.insertBefore(body, foot);
  };
  const foot = document.createElement("div");
  foot.className = "panel-foot";
  el.append(handle, head, bar, foot);
  for (const name of tabs) { makeTab(name); shown.push(name); }
  bar.replaceChildren(...shown.map((n) => /** @type {HTMLElement} */ (buttons.get(n))));
  mainEl.append(el);

  /** @type {Array<() => void>} */ const closeFns = [];
  /** @type {Array<(name: string) => void>} */ const tabFns = [];
  const narrow = window.matchMedia("(max-width: 899px)");
  let isOpen = false;
  // A width the user dragged in an earlier session counts as the user's choice.
  let dragged = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || "null")?.sized === true; } catch { return false; } })();

  const apply = () => {
    state.width = clampWidth(state.width, window.innerWidth);
    el.hidden = !isOpen;
    el.classList.toggle("sheet", narrow.matches);
    mainEl.style.setProperty("--panel-w", isOpen && !narrow.matches ? state.width + "px" : "0px");
    mainEl.style.gridTemplateColumns = isOpen && !narrow.matches ? `minmax(0,1fr) ${state.width}px` : "1fr";
    handle.setAttribute("aria-valuenow", String(state.width));
    handle.setAttribute("aria-valuemax", String(Math.floor(window.innerWidth * 0.85)));
    for (const [name, b] of buttons) {
      const on = name === state.tab && shown.includes(name);
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
      /** @type {HTMLElement} */ (bodies.get(name)).hidden = !on;
    }
    bar.replaceChildren(...shown.map((n) => /** @type {HTMLElement} */ (buttons.get(n))));
  };
  /** @param {number} w */
  const setWidth = (w) => { state.width = clampWidth(w, window.innerWidth); apply(); save(); };
  /** @param {number} w */
  const userWidth = (w) => { dragged = true; state.sized = true; setWidth(w); };
  /** @param {string} name */
  function setTab(name) {
    if (!bodies.has(name) || !shown.includes(name)) return;
    state.tab = name;
    apply();
    save();
    for (const fn of tabFns) fn(name);
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    state.open = false;
    apply();
    save();
    for (const fn of closeFns) fn();
  }

  closeBtn.addEventListener("click", close);
  back.addEventListener("click", close);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && isOpen && !typing(ev.target)) close();
  });
  handle.addEventListener("dblclick", () => userWidth(DEFAULT_WIDTH));
  handle.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    userWidth(state.width + (ev.key === "ArrowLeft" ? STEP : -STEP));
  });
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    el.classList.add("dragging");
    const move = (/** @type {PointerEvent} */ e) => userWidth(mainEl.getBoundingClientRect().right - e.clientX);
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      el.classList.remove("dragging");
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  window.addEventListener("resize", apply);
  narrow.addEventListener("change", apply);
  apply();

  return {
    el,
    isOpen: () => isOpen,
    open(text, statusChip) {
      title.textContent = text;
      title.title = text;
      const c = typeof statusChip === "string" ? { text: statusChip, color: undefined } : statusChip || { text: "", color: undefined };
      chip.textContent = c.text;
      chip.style.color = c.color || "";
      chip.hidden = !c.text;
      if (isOpen) return;
      isOpen = true;
      state.open = true;
      apply();
      save();
    },
    close,
    setTab,
    tab: (name) => /** @type {HTMLElement} */ (bodies.get(name)),
    addTab(name, { first = false } = {}) {
      makeTab(name);
      if (!shown.includes(name)) shown = first ? [name, ...shown] : [...shown, name];
      apply();
    },
    removeTab(name) {
      if (!shown.includes(name)) return;
      shown = shown.filter((n) => n !== name);
      if (state.tab === name) state.tab = shown[0] || state.tab;
      apply();
    },
    footer: () => foot,
    /** A width that is not remembered as the user's choice. @param {number} w */
    setWidth(w) { state.width = clampWidth(w, window.innerWidth); apply(); },
    userSized: () => dragged,
    onClose: (fn) => void closeFns.push(fn),
    onTab: (fn) => void tabFns.push(fn),
  };
}
