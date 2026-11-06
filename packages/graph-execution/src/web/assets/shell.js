// Full-viewport shell helpers shared by the run and suite pages: phase stepper, events drawer, summary card.

/** "7/12" for the top bar's progress. */
export function progressText(done, total) {
  return done + "/" + total;
}

/** "loop ×N" for a node stopped N times for repeating tool calls, else undefined. */
export function loopBadge(loops) {
  return typeof loops === "number" && loops > 0 ? "loop ×" + loops : undefined;
}

/** The state of each phase pill: done before the current one (all of them when `done`), then current, then later. */
export function phaseStates(count, current, done) {
  return Array.from({ length: count }, (_, i) => (done || i < current ? "done" : i === current ? "current" : "later"));
}

/** The phase keys to show in the stepper: the "human" step only appears when the run has human review. */
export function visiblePhases(phases, humanReview) {
  return humanReview ? [...phases] : phases.filter((p) => p !== "human");
}

/** Fills `el` with one pill per phase. `current` is an index; `done` marks every phase as done. */
export function renderPhaseStepper(el, phases, current, done) {
  const states = phaseStates(phases.length, current, !!done);
  el.replaceChildren(...phases.map((label, i) => {
    const pill = document.createElement("span");
    pill.className = "pill " + states[i];
    const mark = document.createElement("i");
    mark.className = "mark";
    mark.textContent = states[i] === "done" ? "✓" : "";
    pill.append(mark, label);
    return pill;
  }));
}

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStored(key, value) {
  try { localStorage.setItem(key, value); } catch { /* the page works without it */ }
}
const typing = (t) => !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/**
 * Turns `el` into a bottom drawer: a drag handle on the top edge, a 28px strip with the latest line, and a body that
 * holds `el`'s original children. Collapsed by default; the open state is kept in localStorage[storageKey].
 */
export function createDrawer(el, { storageKey }) {
  const body = document.createElement("div");
  body.className = "drawer-body";
  body.append(...el.childNodes);
  const handle = document.createElement("div");
  handle.className = "drawer-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "horizontal");
  const strip = document.createElement("div");
  strip.className = "drawer-strip";
  strip.tabIndex = 0;
  strip.setAttribute("role", "button");
  const line = document.createElement("span");
  line.className = "drawer-line";
  const chevron = document.createElement("span");
  chevron.className = "drawer-chevron";
  strip.append(line, chevron);
  el.replaceChildren(handle, strip, body);
  el.classList.add("drawer");

  let bodyHeight = 220;
  const maxBody = () => Math.max(0, Math.floor(window.innerHeight / 2) - 28);
  const apply = () => {
    const open = el.classList.contains("open");
    body.style.height = open ? Math.min(bodyHeight, maxBody()) + "px" : "0px";
    chevron.textContent = open ? "▾" : "▴";
    strip.setAttribute("aria-expanded", String(open));
  };
  const set = (open, persist = true) => {
    el.classList.toggle("open", open);
    apply();
    if (open) body.scrollTop = body.scrollHeight;
    if (persist) writeStored(storageKey, open ? "1" : "0");
  };
  strip.addEventListener("click", () => set(!el.classList.contains("open")));
  strip.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); set(!el.classList.contains("open")); }
  });
  document.addEventListener("keydown", (ev) => {
    if ((ev.key !== "e" && ev.key !== "E") || ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target)) return;
    ev.preventDefault();
    set(!el.classList.contains("open"));
  });
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    el.classList.add("open", "dragging");
    const move = (e) => {
      bodyHeight = Math.max(0, Math.min(maxBody(), Math.round(el.getBoundingClientRect().bottom - e.clientY - 28)));
      apply();
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      el.classList.remove("dragging");
      set(bodyHeight > 0);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  window.addEventListener("resize", apply);
  set(readStored(storageKey) === "1", false);
  return {
    body,
    isOpen: () => el.classList.contains("open"),
    toggle: () => set(!el.classList.contains("open")),
    setStrip(content) { line.replaceChildren(content); },
    scrollToEnd() { body.scrollTop = body.scrollHeight; },
  };
}

/** Shows `contentEl` in the centred glass card (`#summarycard`) over the canvas. */
export function showSummaryCard(contentEl) {
  const card = document.getElementById("summarycard");
  if (!card) return;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "card-close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss summary");
  close.addEventListener("click", hideSummaryCard);
  card.replaceChildren(close, contentEl);
  card.hidden = false;
}
export function hideSummaryCard() {
  const card = document.getElementById("summarycard");
  if (card) card.hidden = true;
}
export function summaryCardOpen() {
  const card = document.getElementById("summarycard");
  return !!card && !card.hidden;
}

// Pause every CSS animation while the tab is hidden (see `html.paused` in theme.css).
if (typeof document !== "undefined") {
  const sync = () => document.documentElement.classList.toggle("paused", document.hidden);
  document.addEventListener("visibilitychange", sync);
  sync();
}
