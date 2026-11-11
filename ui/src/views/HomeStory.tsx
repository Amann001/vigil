import {
  animate,
  motion,
  type MotionValue,
  useInView,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { href } from "../lib/route";
import { diagnosisOf } from "../lib/state";
import { PARTS, STAGES } from "../lib/team";
import type { Investigation, InvestigationSummary } from "../lib/types";
import { agentName, proposalName, serviceName, toolName } from "../lib/words";
import "./story.css";

/*
  The home page's story, below the hero. Each section has one kind of motion, tied to the
  scroll so the visitor sets the pace: words that light up as they are read, a row of cards
  that slides sideways while the page stands still, a terminal that types out a real
  investigation, a diagram that draws itself, and numbers that count up. Every figure and every
  line of the terminal is real.
*/

// ---------------------------------------------------------------------------------------------
// 1. The problem: a statement whose words light up as it scrolls past.

const PROBLEM =
  "Three in the morning. A service slows down, then another. Someone is paged, opens six dashboards, reads ten thousand log lines and hunts for the change that caused it. Every minute of that search is downtime.";

function Word({ word, range, progress }: { word: string; range: [number, number]; progress: MotionValue<number> }) {
  const opacity = useTransform(progress, range, [0.14, 1]);
  const y = useTransform(progress, range, [6, 0]);
  return (
    <motion.span className="lit-word" style={{ opacity, y }}>
      {word}{" "}
    </motion.span>
  );
}

export function Problem() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 80%", "end 45%"] });
  const words = PROBLEM.split(" ");
  return (
    <section className="chapter story-problem" aria-label="The problem">
      <div ref={ref} className="problem-text">
        <p className="visually-hidden">{PROBLEM}</p>
        <p aria-hidden="true">
          {words.map((word, i) => (
            <Word key={i} word={word} progress={scrollYProgress} range={[i / words.length, (i + 1) / words.length]} />
          ))}
        </p>
      </div>
      <p className="problem-answer">Vigil does that search for you, in about a minute and a half, and waits for your yes before it fixes anything.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. The team as a deck of cards: stacked at first, then dealt across the whole width of the page
//    on a wide, shallow arc that turns with the scroll, so each part comes to the front in turn.

const ORDER = STAGES.flatMap((stage) => stage.parts.map((id) => ({ id, stage: stage.title })));
const CARDS = ORDER.length;
const STEP = 21; // degrees between neighbouring cards on the arc
const SPREAD_UNTIL = 0.16; // share of the section spent dealing the deck out
const TURN_UNTIL = 0.94; // the last card reaches the front here, and the arc rests

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Where card i sits at scroll progress p: its angle on the arc (0 is the front, in the middle
 *  of the page) and how far the deck has been dealt. */
function pose(i: number, p: number) {
  const spread = ease(clamp(p / SPREAD_UNTIL));
  const turn = clamp((p - SPREAD_UNTIL) / (TURN_UNTIL - SPREAD_UNTIL)) * STEP * (CARDS - 1);
  return { angle: i * STEP * spread - turn, spread };
}

function frontCard(p: number): number {
  return Math.round(clamp((p - SPREAD_UNTIL) / (TURN_UNTIL - SPREAD_UNTIL)) * (CARDS - 1));
}

/** The arc: as wide as the page, so the cards run from edge to edge, and shallow, so the ones
 *  at the sides lean back without shrinking away to nothing. */
interface Arc {
  wide: number;
  deep: number;
}

function arcFor(width: number): Arc {
  // On a phone the arc is wider than the screen: the front card shows whole and its neighbours
  // peek in from the edges, instead of all eleven crowding into 390 pixels.
  const wide = width * (width < 700 ? 1.5 : width < 1300 ? 0.63 : 0.56);
  return { wide, deep: wide * 0.55 };
}

function DeckCard({ index, progress, arc, front }: { index: number; progress: MotionValue<number>; arc: Arc; front: boolean }) {
  const { id, stage } = ORDER[index];
  const part = PARTS[id];
  const transform = useTransform(progress, (p) => {
    const { angle, spread } = pose(index, p);
    const rad = (angle * Math.PI) / 180;
    const x = arc.wide * Math.sin(rad);
    const z = arc.deep * (Math.cos(rad) - 1);
    // While stacked, each card sits a little higher and askew, like a squared-up deck in a hand.
    const tilt = (1 - spread) * (index - (CARDS - 1) / 2) * 1.8;
    const lift = (1 - spread) * -index * 2.5;
    return `translate3d(${x}px, ${lift}px, ${z}px) rotateY(${angle * 0.75}deg) rotateZ(${tilt}deg)`;
  });
  const opacity = useTransform(progress, (p) => {
    const { angle, spread } = pose(index, p);
    if (spread < 0.05) return 1;
    // Full strength across the page, fading as a card turns past the edge.
    return clamp(1 - (Math.abs(angle) - 70) / 40) * (0.55 + 0.45 * Math.cos((Math.min(Math.abs(angle), 90) * Math.PI) / 180));
  });
  const zIndex = useTransform(progress, (p) => {
    const { angle } = pose(index, p);
    return Math.round((200 - Math.abs(angle)) * 10) + (CARDS - index);
  });
  return (
    <motion.article
      className={`deck-card kind-${part.kind}${front ? " is-front" : ""}`}
      style={{ transform, opacity, zIndex }}
      aria-hidden={!front}
    >
      <span className="deck-index num">{String(index + 1).padStart(2, "0")}</span>
      <span className={`deck-glow agent-dot agent-${part.role ?? id}`} aria-hidden="true" />
      <span className="deck-stage">{stage}</span>
      <h3>{part.name}</h3>
      <p>{part.short}</p>
    </motion.article>
  );
}

export function Team() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  const progress = useSpring(scrollYProgress, { stiffness: 90, damping: 24, mass: 0.6 });
  const [front, setFront] = useState(0);
  useMotionValueEvent(progress, "change", (p) => setFront(frontCard(p)));
  const [arc, setArc] = useState<Arc>(() => arcFor(window.innerWidth));
  useEffect(() => {
    const measure = () => setArc(arcFor(window.innerWidth));
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const reduce = useReducedMotion();
  const current = PARTS[ORDER[front].id];

  if (reduce) {
    return (
      <section className="chapter" aria-label="The team">
        <h2 className="section-title">Eleven parts. One job each.</h2>
        <ol className="deck-list">
          {ORDER.map(({ id }, i) => (
            <li key={id}>
              <span className="num">{String(i + 1).padStart(2, "0")}</span> <strong>{PARTS[id].name}</strong>: {PARTS[id].short}
            </li>
          ))}
        </ol>
      </section>
    );
  }

  return (
    <section ref={ref} className="story-team" aria-label="The team">
      <div className="team-pin">
        <header className="team-head">
          <h2 className="section-title">Eleven parts. One job each.</h2>
          <p className="section-lede">Scroll to deal the deck.</p>
        </header>
        <div className="deck" aria-live="polite">
          <div className="deck-ring">
            {ORDER.map(({ id }, i) => (
              <DeckCard key={id} index={i} progress={progress} arc={arc} front={i === front} />
            ))}
          </div>
        </div>
        <footer className="deck-foot">
          <ol className="deck-dots" aria-label={`Part ${front + 1} of ${CARDS}: ${current.name}`}>
            {ORDER.map(({ id }, i) => (
              <li key={id} className={i === front ? "is-front" : i < front ? "is-past" : ""} />
            ))}
          </ol>
          <a className="link-button" href={href({ page: "how" })}>
            What each part did in the last real incident
          </a>
        </footer>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Inside an investigation: the real tool calls of the last incident, typed out by the scroll.

interface Line {
  kind: "ask" | "call" | "found" | "verdict" | "fix" | "wait";
  text: string;
}

function argsText(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`)
    .join(", ");
}

function linesOf(inv: Investigation): Line[] {
  const lines: Line[] = [];
  const top = inv.signals?.[0];
  lines.push({ kind: "wait", text: `alert ${inv.id}${top ? `: ${top.feature} far from usual` : ""}` });
  for (const f of inv.findings ?? []) {
    const who = (agentName[f.agent] ?? f.agent).toLowerCase();
    lines.push({ kind: "ask", text: `supervisor → ${who}: ${f.question.length > 110 ? `${f.question.slice(0, 107)}…` : f.question}` });
    for (const call of f.tool_calls.slice(0, 3)) lines.push({ kind: "call", text: `${who}.${call.name}(${argsText(call.args)})` });
    const first = f.report.replace(/[#*`>_]/g, "").split(/\n+/).map((l) => l.trim()).find((l) => l.length > 20);
    if (first) lines.push({ kind: "found", text: `${who}: ${first.length > 120 ? `${first.slice(0, 117)}…` : first}` });
  }
  const d = diagnosisOf(inv);
  if (d) lines.push({ kind: "verdict", text: `diagnosis: ${serviceName[d.root_cause_service] ?? d.root_cause_service}, ${d.category.replace(/_/g, " ")}, ${d.confidence} confidence` });
  if (inv.proposal) lines.push({ kind: "fix", text: `proposal: ${proposalName(inv.proposal).toLowerCase()}, waiting for a person` });
  return lines;
}

export function Terminal({ list }: { list: InvestigationSummary[] | null }) {
  const [inv, setInv] = useState<Investigation | null>(null);
  // The first fixed live incident seen stays the one played, even if a newer one lands mid-scroll.
  const chosen = useRef<InvestigationSummary | undefined>(undefined);
  chosen.current ??= (list ?? []).find((i) => i.id.startsWith("live-") && i.outcome === "executed");
  const featured = chosen.current;
  useEffect(() => {
    if (!featured) return;
    let gone = false;
    api.investigation(featured.id).then((r) => !gone && setInv(r), () => {});
    return () => {
      gone = true;
    };
  }, [featured?.id]);

  const lines = useMemo(() => (inv ? linesOf(inv) : []), [inv]);
  if (!featured || !inv || !lines.length) return null;
  return <TerminalPlayer inv={inv} lines={lines} />;
}

/** Mounted only once the incident has loaded: the scroll tracker needs its section on the page
 *  when it starts, or it tracks nothing. */
function TerminalPlayer({ inv, lines }: { inv: Investigation; lines: Line[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  // How far through the section the visitor is; the lines shown follow from it, so lines that
  // arrive after the scroll has moved still appear at the right count.
  const [progress, setProgress] = useState(0);
  useMotionValueEvent(scrollYProgress, "change", setProgress);
  const reduce = useReducedMotion();
  const visible = reduce ? lines.length : Math.round(Math.min(1, progress * 1.15) * lines.length);
  const body = useRef<HTMLOListElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight, behavior: "smooth" });
  }, [visible]);

  const tools = new Set((inv.findings ?? []).flatMap((f) => f.tool_calls.map((c) => c.name)));
  return (
    <section ref={ref} className="story-terminal" aria-label="Inside an investigation">
      <div className="terminal-pin">
        <header>
          <h2 className="section-title">Inside an investigation</h2>
          <p className="section-lede">
            The questions and tool calls from the last real incident, as the agents made them. Scroll to play it.
          </p>
          <ul className="terminal-facts">
            <li>
              <strong className="num">{inv.findings?.length ?? 0}</strong> questions answered
            </li>
            <li>
              <strong className="num">{(inv.findings ?? []).reduce((n, f) => n + f.tool_calls.length, 0)}</strong> tool calls, using{" "}
              {[...tools].map((t) => toolName[t] ?? t).join(", ")}
            </li>
            <li>
              <strong className="num">{inv.seconds ? Math.round(inv.seconds) : "–"} s</strong> from alert to diagnosis
            </li>
          </ul>
          <a className="link-button" href={href({ page: "incident", id: inv.id })}>
            Open this incident
          </a>
        </header>
        <div className="terminal">
          <div className="terminal-bar" aria-hidden="true">
            <i />
            <i />
            <i />
            <span>vigil, investigation {inv.id}</span>
          </div>
          <ol ref={body} className="terminal-body">
            {lines.slice(0, Math.max(1, visible)).map((line, i) => (
              <motion.li
                key={i}
                className={`line-${line.kind}`}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25 }}
              >
                {line.text}
              </motion.li>
            ))}
            <li className="terminal-caret" aria-hidden="true" />
          </ol>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Four steps, every time: one line that fills as the page scrolls, lighting each step.

const STEPS = [
  {
    title: "Notice",
    text: "A model that knows what normal looks like spots readings that are not.",
    icon: "M3 12h4l2-6 4 12 2-6h6",
  },
  {
    title: "Investigate",
    text: "AI agents read the logs, the metrics and what changed, all at once.",
    icon: "M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM15.5 15.5 21 21",
  },
  {
    title: "Decide",
    text: "You see the cause and the evidence, and say yes or no to the fix.",
    icon: "M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6",
  },
  {
    title: "Fix",
    text: "Safe, checked code applies it, and the report writes itself.",
    icon: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6zM8.5 12l2.5 2.5 4.5-5",
  },
];

function Step({ step, index, progress }: { step: (typeof STEPS)[number]; index: number; progress: MotionValue<number> }) {
  const at = (index + 0.5) / STEPS.length;
  const lit = useTransform(progress, [at - 0.12, at], [0, 1]);
  const opacity = useTransform(lit, [0, 1], [0.35, 1]);
  const y = useTransform(lit, [0, 1], [18, 0]);
  return (
    <motion.li className="step" style={{ opacity, y }}>
      <span className="step-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <motion.path d={step.icon} style={{ pathLength: lit }} />
        </svg>
      </span>
      <span className="step-number num">{index + 1}</span>
      <h3>{step.title}</h3>
      <p>{step.text}</p>
    </motion.li>
  );
}

export function Steps() {
  const ref = useRef<HTMLOListElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 85%", "end 45%"] });
  const progress = useSpring(scrollYProgress, { stiffness: 100, damping: 26 });
  const fill = useTransform(progress, [0, 1], ["0%", "100%"]);
  return (
    <section className="chapter chapter-steps" aria-label="How it works, in four steps">
      <h2 className="section-title">Four steps, every time</h2>
      <p className="section-lede">From the first strange reading to the fix, in about two minutes and one click.</p>
      <ol ref={ref} className="steps">
        <span className="steps-line" aria-hidden="true">
          <motion.i style={{ width: fill }} />
        </span>
        {STEPS.map((step, i) => (
          <Step key={step.title} step={step} index={i} progress={progress} />
        ))}
      </ol>
      <a className="link-button" href={href({ page: "how" })}>
        See every part of each step
      </a>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 5. The numbers, counting up as they arrive.

const NUMBERS = [
  { to: 12, of: 12, label: "incidents detected on the public set, with no false alarms" },
  { to: 11, of: 12, label: "root cause, kind and fix all right, on scenarios it was built on" },
  { to: 5, of: 5, label: "right on scenarios someone else wrote, never seen while building" },
  { to: 11, of: 11, label: "times the right runbook was the first one memory found" },
  { to: 13, unit: "s", label: "for a second worker to finish an investigation whose worker was killed" },
  { to: 0, prefix: "$", label: "to run: free tiers only, under 5 GB of disk" },
];

function Count({ to, of, unit, prefix }: { to: number; of?: number; unit?: string; prefix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, { once: true, margin: "-15% 0px" });
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!seen) return;
    const controls = animate(0, to, { duration: 1.6, ease: [0.16, 1, 0.3, 1], onUpdate: (v) => setValue(Math.round(v)) });
    return () => controls.stop();
  }, [seen, to]);
  return (
    <span ref={ref} className="num">
      {prefix}
      {value}
      {of !== undefined && <span className="count-of">/{of}</span>}
      {unit && <span className="count-of"> {unit}</span>}
    </span>
  );
}

export function Numbers() {
  return (
    <section className="chapter story-numbers" aria-label="Measured results">
      <h2 className="section-title">Measured, not promised</h2>
      <dl className="numbers">
        {NUMBERS.map((n, i) => (
          <motion.div
            key={n.label}
            className="number"
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-10% 0px" }}
            transition={{ delay: (i % 3) * 0.08, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          >
            <dt>
              <Count to={n.to} of={n.of} unit={n.unit} prefix={n.prefix} />
            </dt>
            <dd>{n.label}</dd>
          </motion.div>
        ))}
      </dl>
      <a className="button" href={href({ page: "scores" })}>
        Every result, with the misses
      </a>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 6. What it is built with, sliding past.

const STACK = [
  "Python",
  "LangGraph",
  "PostgreSQL",
  "pgvector",
  "FastAPI",
  "scikit-learn",
  "PyTorch",
  "ONNX Runtime",
  "Drain3",
  "fastembed",
  "Prometheus",
  "Langfuse",
  "Gemini",
  "Groq",
  "React",
  "Three.js",
  "Motion",
];

export function Stack() {
  return (
    <section className="story-stack" aria-label="Built with">
      <p className="visually-hidden">Built with {STACK.join(", ")}.</p>
      <div className="marquee" aria-hidden="true">
        {[0, 1].map((copy) => (
          <div key={copy} className="marquee-run">
            {STACK.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 7. The last word: a button that leans towards the pointer.

export function FinalCall() {
  const button = useRef<HTMLAnchorElement>(null);
  const [pull, setPull] = useState({ x: 0, y: 0 });
  return (
    <section className="chapter story-final" aria-label="Start">
      <motion.h2
        className="final-title"
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
      >
        The shop is being watched right now.
      </motion.h2>
      <div
        className="final-actions"
        onPointerMove={(e) => {
          const box = button.current?.getBoundingClientRect();
          if (!box) return;
          const dx = e.clientX - (box.left + box.width / 2);
          const dy = e.clientY - (box.top + box.height / 2);
          setPull({ x: Math.max(-14, Math.min(14, dx * 0.25)), y: Math.max(-10, Math.min(10, dy * 0.3)) });
        }}
        onPointerLeave={() => setPull({ x: 0, y: 0 })}
      >
        <motion.a
          ref={button}
          className="button button-primary button-huge"
          href={href({ page: "watch" })}
          animate={pull}
          transition={{ type: "spring", stiffness: 260, damping: 18 }}
        >
          Enter the war room
        </motion.a>
        <a className="button button-ghost button-large" href={href({ page: "status" })}>
          See what is running
        </a>
      </div>
    </section>
  );
}
