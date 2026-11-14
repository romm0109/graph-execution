// The agent's icon beside the compose bar, as a small companion: it leans toward the mouse, jumps and spins when
// clicked, and has a few moods of its own (see Mascot.css). All motion is off under prefers-reduced-motion.

import { useEffect, useRef, useState } from "react";
import type { AgentId } from "../types";
import { AgentIcon } from "../ui/AgentIcon";
import "./Mascot.css";

/** Rapid clicks within this window that make it dizzy. */
const DIZZY_CLICKS = 5;
const DIZZY_WINDOW_MS = 1600;
const DIZZY_MS = 2400;
/** No pointer or key activity for this long (and no output): it dozes off. */
export const SLEEP_MS = 45_000;

type Trick = "jump" | "dizzy" | null;

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
  /** Changes every time a message is sent. */
  fed: number;
}

export function Mascot({ agent, label, busy, fed }: MascotProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [trick, setTrick] = useState<Trick>(null);
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

  // Each message sent: a happy gulp.
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
    // Too dizzy to jump until it has recovered.
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
    // Restart the jump even when it is mid-air.
    setTrick(null);
    trickFrame.current = window.requestAnimationFrame(() => {
      setTrick("jump");
      trickTimer.current = window.setTimeout(() => setTrick(null), 760);
    });
  };

  const mood = trick === "dizzy" ? "dizzy" : asleep ? "asleep" : busy ? "busy" : "idle";
  return (
    <button
      ref={ref}
      type="button"
      className={`mascot mood-${mood}${trick === "jump" ? " jump" : ""}${nom ? " nom" : ""}`}
      aria-label={`${label}${busy ? " (working)" : ""}`}
      title={busy ? `${label} is working…` : asleep ? `${label} is napping` : label}
      onClick={onClick}
      data-testid="mascot"
      data-mood={mood}
    >
      <span className="mascot-shadow" aria-hidden="true" />
      <span className="mascot-hop">
        <span className="mascot-mood">
          <span className="mascot-look">{agent ? <AgentIcon agent={agent} size={20} /> : <TerminalFace size={20} />}</span>
        </span>
      </span>
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
