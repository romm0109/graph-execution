import { describe, expect, it } from "vitest";
import { BACKOFF_MS, classifyInput, EchoBackoff, isSecretPrompt, MISS_LIMIT } from "./echo.js";

describe("classifyInput", () => {
  it("predicts typed characters, including a short IME commit", () => {
    expect(classifyInput("a")).toEqual({ kind: "chars", chars: ["a"] });
    expect(classifyInput("/")).toEqual({ kind: "chars", chars: ["/"] });
    expect(classifyInput("日本")).toEqual({ kind: "chars", chars: ["日", "本"] });
  });

  it("treats Backspace and Enter on their own", () => {
    expect(classifyInput("\x7f")).toEqual({ kind: "backspace" });
    expect(classifyInput("\r")).toEqual({ kind: "submit" });
  });

  it("tells the terminal's own reports apart from keys (they must not clear the guesses)", () => {
    for (const data of ["\x1b[I", "\x1b[O", "\x1b[<35;28;12M", "\x1b[<0;28;12M", "\x1b[<0;28;12m", "\x1b[<64;10;5M", "\x1b[M !!", "\x1b[12;40R", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b]11;rgb:0f0f/1111/1515\x07", "\x1b]10;rgb:d6d6/d9d9/dede\x1b\\"]) {
      expect(classifyInput(data)).toEqual({ kind: "report" });
    }
    // Arrow keys look similar but move the cursor.
    expect(classifyInput("\x1b[A")).toEqual({ kind: "other" });
    expect(classifyInput("\x1b[C")).toEqual({ kind: "other" });
  });

  it("never guesses escape sequences, control keys or pastes", () => {
    for (const data of ["\x1b[A", "\x1b", "\t", "\x03", "\x1b[200~hi\x1b[201~", "a long pasted line"]) {
      expect(classifyInput(data)).toEqual({ kind: "other" });
    }
  });
});

describe("isSecretPrompt", () => {
  it("spots password and token prompts", () => {
    expect(isSecretPrompt("[sudo] password for ada: ")).toBe(true);
    expect(isSecretPrompt("Enter passphrase for key '/root/.ssh/id_ed25519': ")).toBe(true);
    expect(isSecretPrompt("Paste your API token:")).toBe(true);
  });

  it("leaves ordinary prompts alone", () => {
    expect(isSecretPrompt("root@vm:~# ")).toBe(false);
    expect(isSecretPrompt("❯ ")).toBe(false);
    expect(isSecretPrompt("❯ reset the password: field validation ")).toBe(false);
  });
});

describe("EchoBackoff", () => {
  it("pauses after MISS_LIMIT writes in a row that only dropped guesses, and resumes after BACKOFF_MS", () => {
    let now = 0;
    const b = new EchoBackoff(() => now);
    // One write dropping a whole run of guesses is one miss.
    b.observe(0, 6);
    for (let i = 2; i < MISS_LIMIT; i++) b.observe(0, 6 + i);
    expect(b.paused).toBe(false);
    b.observe(0, 20);
    expect(b.paused).toBe(true);
    now += BACKOFF_MS;
    expect(b.paused).toBe(false);
  });

  it("guesses we cleared ourselves are not misses", () => {
    const b = new EchoBackoff(() => 0);
    for (let i = 1; i <= MISS_LIMIT + 2; i++) b.sync(0, i * 5);
    b.observe(0, (MISS_LIMIT + 2) * 5);
    expect(b.paused).toBe(false);
  });

  it("a confirmed guess clears the misses; Enter clears a pause", () => {
    const b = new EchoBackoff(() => 0);
    for (let i = 1; i < MISS_LIMIT; i++) b.observe(0, i);
    b.observe(1, MISS_LIMIT);
    for (let i = 1; i < MISS_LIMIT; i++) b.observe(1, MISS_LIMIT + i);
    expect(b.paused).toBe(false);
    b.observe(1, 2 * MISS_LIMIT + 1);
    expect(b.paused).toBe(true);
    b.reset();
    expect(b.paused).toBe(false);
  });
});
