// Small DOM and time helpers shared by the run page and the suite page.
export const div = (cls, text) => {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};
export const span = (cls, text) => Object.assign(document.createElement("span"), { className: cls, textContent: text });
export const v = (name) => "var(" + name + ")";
/** h:mm:ss, always with hours. */
export function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, "0");
  return Math.floor(s / 3600) + ":" + p(Math.floor(s / 60) % 60) + ":" + p(s % 60);
}
