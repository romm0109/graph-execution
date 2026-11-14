// The agent's icon under the terminal, as a small companion: it leans toward the mouse, does its own emote when
// clicked (each agent has one), and has a few moods of its own (see Mascot.css). All motion is off under
// prefers-reduced-motion.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AgentId } from "../types";
import { AgentIcon } from "../ui/AgentIcon";
import "./Mascot.css";

/** Rapid clicks within this window that make it dizzy. */
const DIZZY_CLICKS = 5;
const DIZZY_WINDOW_MS = 1600;
const DIZZY_MS = 2400;
/** No pointer or key activity for this long (and no output): it dozes off. */
export const SLEEP_MS = 45_000;

export type MascotKind = AgentId | "terminal";

/** Each one's click emote, and how long it lasts. The glyphs fly out of it (Mascot.css, `.fx-<kind>`). */
export const EMOTES: Record<MascotKind, { name: string; ms: number; fx: string[] }> = {
  claude: { name: "sparkle", ms: 1280, fx: ["✻", "✻", "✻", "✻", "✻", "✻"] },
  codex: { name: "whirl", ms: 950, fx: [""] },
  opencode: { name: "flip", ms: 900, fx: ["{", "}"] },
  qwen: { name: "boing", ms: 1000, fx: ["⬡", "⬡", "⬡"] },
  terminal: { name: "type", ms: 1100, fx: [">_"] },
};

type Trick = "emote" | "dizzy" | null;

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The plain terminal's own face: a prompt in a rounded square. */
function TerminalFace({ size }: { size: number }) {
  return (
    <svg className="agent-icon agent-terminal" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="20" height="18" rx="4" fill="currentColor" />
      <path d="m7 9 3 3-3 3M12.5 15.5H17" fill="none" stroke="var(--term)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface MascotProps {
  agent?: AgentId;
  label: string;
  /** The process is printing output. */
  busy: boolean;
  /** Changes every time Enter is typed. */
  fed: number;
}

export function Mascot({ agent, label, busy, fed }: MascotProps) {
  const kind: MascotKind = agent ?? "terminal";
  const emote = EMOTES[kind];
  const ref = useRef<HTMLButtonElement>(null);
  const [trick, setTrick] = useState<Trick>(null);
  // Bumped on every emote, so its glyphs mount afresh and replay.
  const [round, setRound] = useState(0);
  const [nom, setNom] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const clicks = useRef<number[]>([]);
  const trickTimer = useRef<number | undefined>(undefined);
  const trickFrame = useRef(0);
  const trickRef = useRef<Trick>(null);
  trickRef.current = trick;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Lean toward the pointer, and doze off when nothing happens for a while.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    let last: { x: number; y: number } | undefined;
    let sleepTimer: number | undefined;
    const still = reducedMotion();
    const scheduleSleep = () => {
      window.clearTimeout(sleepTimer);
      sleepTimer = window.setTimeout(function doze() {
        if (busyRef.current) sleepTimer = window.setTimeout(doze, SLEEP_MS);
        else setAsleep(true);
      }, SLEEP_MS);
    };
    const wake = () => {
      setAsleep(false);
      scheduleSleep();
    };
    const look = () => {
      frame = 0;
      if (!last) return;
      const r = el.getBoundingClientRect();
      const dx = last.x - (r.left + r.width / 2);
      const dy = last.y - (r.top + r.height / 2);
      const dist = Math.hypot(dx, dy);
      // Close by it leans hard; far away it only glances.
      const pull = clamp(1 - dist / 900, 0.25, 1);
      el.style.setProperty("--mx", `${(clamp(dx / 40, -4, 4) * pull).toFixed(2)}px`);
      el.style.setProperty("--my", `${(clamp(dy / 40, -4, 4) * pull).toFixed(2)}px`);
      el.style.setProperty("--tilt", `${(clamp(dx / 18, -18, 18) * pull).toFixed(2)}deg`);
    };
    const onMove = (e: PointerEvent) => {
      wake();
      if (still) return;
      last = { x: e.clientX, y: e.clientY };
      if (!frame) frame = window.requestAnimationFrame(look);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("keydown", wake, true);
    scheduleSleep();
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", wake, true);
      window.cancelAnimationFrame(frame);
      window.clearTimeout(sleepTimer);
    };
  }, []);

  // Each Enter: a happy gulp.
  const firstFed = useRef(fed);
  useEffect(() => {
    if (fed === firstFed.current) return;
    setAsleep(false);
    setNom(false);
    const raf = window.requestAnimationFrame(() => setNom(true));
    const t = window.setTimeout(() => setNom(false), 520);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [fed]);

  useEffect(
    () => () => {
      window.clearTimeout(trickTimer.current);
      window.cancelAnimationFrame(trickFrame.current);
    },
    [],
  );

  const onClick = () => {
    setAsleep(false);
    // Too dizzy for tricks until it has recovered.
    if (trickRef.current === "dizzy") return;
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < DIZZY_WINDOW_MS), now];
    window.clearTimeout(trickTimer.current);
    window.cancelAnimationFrame(trickFrame.current);
    if (clicks.current.length >= DIZZY_CLICKS) {
      clicks.current = [];
      setTrick("dizzy");
      trickTimer.current = window.setTimeout(() => setTrick(null), DIZZY_MS);
      return;
    }
    // Restart the emote even when it is mid-way.
    setTrick(null);
    trickFrame.current = window.requestAnimationFrame(() => {
      setRound((n) => n + 1);
      setTrick("emote");
      trickTimer.current = window.setTimeout(() => setTrick(null), emote.ms);
    });
  };

  const mood = trick === "dizzy" ? "dizzy" : asleep ? "asleep" : busy ? "busy" : "idle";
  const emoting = trick === "emote";
  return (
    <button
      ref={ref}
      type="button"
      className={`mascot mascot-${kind} mood-${mood}${emoting ? ` emote emote-${emote.name}` : ""}${nom ? " nom" : ""}`}
      aria-label={`${label}${busy ? " (working)" : ""}`}
      title={busy ? `${label} is working…` : asleep ? `${label} is napping` : label}
      onClick={onClick}
      data-testid="mascot"
      data-mood={mood}
      data-emote={emoting ? emote.name : undefined}
    >
      <span className="mascot-shadow" aria-hidden="true" />
      <span className="mascot-hop">
        <span className="mascot-mood">
          <span className="mascot-look">{agent ? <AgentIcon agent={agent} size={18} /> : <TerminalFace size={18} />}</span>
        </span>
      </span>
      {emoting && (
        <span key={round} className={`mascot-fx fx-${kind}`} aria-hidden="true">
          {emote.fx.map((g, i) => (
            <i key={i} style={{ "--i": i } as CSSProperties}>
              {g}
            </i>
          ))}
        </span>
      )}
      {mood === "dizzy" && (
        <span className="mascot-stars" aria-hidden="true">
          <i>✦</i>
          <i>✧</i>
          <i>✦</i>
        </span>
      )}
      {mood === "asleep" && (
        <span className="mascot-z" aria-hidden="true">
          <i>z</i>
          <i>z</i>
          <i>Z</i>
        </span>
      )}
    </button>
  );
}
