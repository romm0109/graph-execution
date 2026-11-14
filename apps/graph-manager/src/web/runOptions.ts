/** The Start run drawer's options form (docs/prd/run-options.md, KAN-89): pure helpers, no React. */

export type Tri = "default" | "on" | "off";

export interface RunOptionsForm {
  humanReview: Tri;
  merge: "on" | "off";
  model: string;
  concurrency: string;
  attempts: string;
  fixPasses: string;
  validationRounds: string;
  validateAt: "default" | "task" | "end";
  validateParallel: Tri;
  idleTimeout: string;
  extraArgs: string;
}

/** What POST /api/runs/:ws takes as `options` (mirrors runOptionsSchema in src/server/runoptions.ts). */
export interface RunOptionsBody {
  humanReview?: boolean;
  merge?: boolean;
  model?: string;
  concurrency?: number;
  attempts?: number;
  fixPasses?: number;
  validationRounds?: number;
  validateAt?: "task" | "end";
  validateParallel?: boolean;
  idleTimeoutMinutes?: number;
  extraArgs?: string;
}

export const emptyForm = (): RunOptionsForm => ({
  humanReview: "default",
  merge: "on",
  model: "",
  concurrency: "",
  attempts: "",
  fixPasses: "",
  validationRounds: "",
  validateAt: "default",
  validateParallel: "default",
  idleTimeout: "",
  extraArgs: "",
});

export type FormErrors = Partial<Record<"concurrency" | "attempts" | "fixPasses" | "validationRounds" | "idleTimeout" | "model", string>>;

/** The fields in the collapsed "More options" group. */
export const MORE_FIELDS: (keyof RunOptionsForm)[] = ["attempts", "fixPasses", "validationRounds", "validateAt", "validateParallel", "idleTimeout", "extraArgs"];

/** The options a project run takes (PROJECT_OPTIONS in src/server/runoptions.ts), as form fields. */
export const PROJECT_FIELDS: (keyof RunOptionsForm)[] = ["humanReview", "merge", "model", "concurrency", "extraArgs"];

/** The form with only the fields of a project run; the others back at their defaults. The same object when nothing changes. */
export function projectForm(f: RunOptionsForm): RunOptionsForm {
  const out = emptyForm();
  if ((Object.keys(out) as (keyof RunOptionsForm)[]).every((k) => PROJECT_FIELDS.includes(k) || f[k] === out[k])) return f;
  return { ...out, humanReview: f.humanReview, merge: f.merge, model: f.model, concurrency: f.concurrency, extraArgs: f.extraArgs };
}

const INT = /^\d+$/;
const DECIMAL = /^\d+(\.\d+)?$/;
const MODEL = /^[^\s-]\S*$/;

function intError(value: string, min: number, max: number | undefined, message: string): string | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  if (!INT.test(v)) return message;
  const n = Number(v);
  return n < min || (max !== undefined && n > max) ? message : undefined;
}

/** Inline errors per field; a blank field means "repo default" and is never an error. */
export function formErrors(f: RunOptionsForm): FormErrors {
  const errors: FormErrors = {};
  const set = (key: keyof FormErrors, msg: string | undefined) => {
    if (msg !== undefined) errors[key] = msg;
  };
  set("concurrency", intError(f.concurrency, 1, 64, "Whole number from 1 to 64"));
  set("attempts", intError(f.attempts, 1, undefined, "Whole number, 1 or more"));
  set("fixPasses", intError(f.fixPasses, 0, undefined, "Whole number, 0 or more"));
  set("validationRounds", intError(f.validationRounds, 0, undefined, "Whole number, 0 or more"));
  const idle = f.idleTimeout.trim();
  if (idle !== "" && !(DECIMAL.test(idle) && Number.isFinite(Number(idle)))) errors.idleTimeout = "Number of minutes, 0 or more";
  const model = f.model.trim();
  if (model !== "" && !MODEL.test(model)) errors.model = "One word, not starting with -";
  return errors;
}

const tri = (t: Tri): boolean | undefined => (t === "on" ? true : t === "off" ? false : undefined);

/** The `options` body with only the set fields. Call only when formErrors(f) is empty. */
export function optionsOf(f: RunOptionsForm): RunOptionsBody {
  const o: RunOptionsBody = {};
  const humanReview = tri(f.humanReview);
  if (humanReview !== undefined) o.humanReview = humanReview;
  if (f.merge === "off") o.merge = false;
  const model = f.model.trim();
  if (model !== "") o.model = model;
  const num = (s: string): number | undefined => (s.trim() === "" ? undefined : Number(s.trim()));
  const concurrency = num(f.concurrency);
  if (concurrency !== undefined) o.concurrency = concurrency;
  const attempts = num(f.attempts);
  if (attempts !== undefined) o.attempts = attempts;
  const fixPasses = num(f.fixPasses);
  if (fixPasses !== undefined) o.fixPasses = fixPasses;
  const validationRounds = num(f.validationRounds);
  if (validationRounds !== undefined) o.validationRounds = validationRounds;
  if (f.validateAt !== "default") o.validateAt = f.validateAt;
  const validateParallel = tri(f.validateParallel);
  if (validateParallel !== undefined) o.validateParallel = validateParallel;
  const idle = num(f.idleTimeout);
  if (idle !== undefined) o.idleTimeoutMinutes = idle;
  const extra = f.extraArgs.trim();
  if (extra !== "") o.extraArgs = extra;
  return o;
}

/** The form for a saved `options` object (the server stores it loosely: wrong types are ignored). */
export function formOf(saved: unknown): RunOptionsForm {
  const f = emptyForm();
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return f;
  const s = saved as Record<string, unknown>;
  const bool = (v: unknown): Tri | undefined => (typeof v === "boolean" ? (v ? "on" : "off") : undefined);
  const numStr = (v: unknown): string | undefined => (typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  f.humanReview = bool(s.humanReview) ?? f.humanReview;
  if (typeof s.merge === "boolean") f.merge = s.merge ? "on" : "off";
  f.model = str(s.model) ?? f.model;
  f.concurrency = numStr(s.concurrency) ?? f.concurrency;
  f.attempts = numStr(s.attempts) ?? f.attempts;
  f.fixPasses = numStr(s.fixPasses) ?? f.fixPasses;
  f.validationRounds = numStr(s.validationRounds) ?? f.validationRounds;
  if (s.validateAt === "task" || s.validateAt === "end") f.validateAt = s.validateAt;
  f.validateParallel = bool(s.validateParallel) ?? f.validateParallel;
  f.idleTimeout = numStr(s.idleTimeoutMinutes) ?? f.idleTimeout;
  f.extraArgs = str(s.extraArgs) ?? f.extraArgs;
  return f;
}

/** One flag per line, in the order of optionArgs in src/server/runoptions.ts, then the extra arguments as typed. */
export function optionLines(o: RunOptionsBody): string[] {
  const lines: string[] = [];
  if (o.merge === false) lines.push("--no-merge");
  if (o.humanReview !== undefined) lines.push(o.humanReview ? "--human-review" : "--no-human-review");
  if (o.model !== undefined) lines.push(`--model ${o.model}`);
  if (o.concurrency !== undefined) lines.push(`--concurrency ${o.concurrency}`);
  if (o.attempts !== undefined) lines.push(`--attempts ${o.attempts}`);
  if (o.fixPasses !== undefined) lines.push(`--fix-passes ${o.fixPasses}`);
  if (o.validationRounds !== undefined) lines.push(`--validation-rounds ${o.validationRounds}`);
  if (o.validateAt !== undefined) lines.push(`--validate-at ${o.validateAt}`);
  if (o.validateParallel !== undefined) lines.push(o.validateParallel ? "--validate-parallel" : "--no-validate-parallel");
  if (o.idleTimeoutMinutes !== undefined) lines.push(`--idle-timeout ${o.idleTimeoutMinutes}`);
  const extra = o.extraArgs?.trim();
  if (extra) lines.push(extra);
  return lines;
}
