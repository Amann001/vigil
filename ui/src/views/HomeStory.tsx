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
// 2. The team as a deck of cards: stacked at first, then fanned into a ring that turns with the
//    scroll, so each of the eleven parts comes to the front in turn.

const ORDER = STAGES.flatMap((stage) => stage.parts.map((id) => ({ id, stage: stage.title })));
const CARDS = ORDER.length;
const STEP = 360 / CARDS; // degrees between neighbouring cards on the ring
const SPREAD_UNTIL = 0.16; // share of the section spent fanning the deck out into the ring
const TURN_UNTIL = 0.94; // the last card reaches the front here, and the ring rests

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Where card i sits at scroll progress p: its angle on the ring, and how far the deck has spread. */
function pose(i: number, p: number) {
  const spread = ease(clamp(p / SPREAD_UNTIL));
  const turn = clamp((p - SPREAD_UNTIL) / (TURN_UNTIL - SPREAD_UNTIL)) * STEP * (CARDS - 1);
  const raw = i * STEP * spread - turn;
  const angle = ((((raw + 180) % 360) + 360) % 360) - 180; // -180..180, 0 is the front
  return { angle, spread };
}

function frontCard(p: number): number {
  return Math.round(clamp((p - SPREAD_UNTIL) / (TURN_UNTIL - SPREAD_UNTIL)) * (CARDS - 1));
}

function DeckCard({ index, progress, radius, front }: { index: number; progress: MotionValue<number>; radius: number; front: boolean }) {
  const { id, stage } = ORDER[index];
  const part = PARTS[id];
  const transform = useTransform(progress, (p) => {
    const { angle, spread } = pose(index, p);
    // While stacked, each card sits a little higher and askew, like a squared-up deck in a hand.
    const tilt = (1 - spread) * (index - (CARDS - 1) / 2) * 1.8;
    const lift = (1 - spread) * -index * 2.5;
    // The ring's centre moves back by its radius, so the card at the front stays its own size.
    const r = radius * spread;
    return `translateZ(${-r}px) rotateY(${angle}deg) translateZ(${r}px) translateY(${lift}px) rotateZ(${tilt}deg)`;
  });
  const opacity = useTransform(progress, (p) => {
    const { angle, spread } = pose(index, p);
    const facing = (Math.cos((angle * Math.PI) / 180) + 1) / 2;
    return spread < 0.05 ? 1 : 0.18 + 0.82 * facing ** 1.6;
  });
  const zIndex = useTransform(progress, (p) => {
    const { angle } = pose(index, p);
    return Math.round((180 - Math.abs(angle)) * 10) + (CARDS - index);
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
  const [radius, setRadius] = useState(440);
  useEffect(() => {
    // Wide enough that eleven cards stand edge to edge round the ring, with a small gap.
    const measure = () => setRadius(window.innerWidth < 700 ? 330 : 440);
    measure();
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
              <DeckCard key={id} index={i} progress={progress} radius={radius} front={i === front} />
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
// 4. The architecture, drawn by the scroll.

const NODES = [
  { id: "shop", x: 70, y: 210, label: "The shop", sub: "4 services" },
  { id: "prom", x: 230, y: 110, label: "Prometheus", sub: "every 5 s" },
  { id: "logs", x: 230, y: 310, label: "JSON logs", sub: "every request" },
  { id: "detect", x: 400, y: 110, label: "Detector", sub: "robust z-score" },
  { id: "queue", x: 560, y: 110, label: "Job queue", sub: "Postgres" },
  { id: "agents", x: 560, y: 310, label: "Agent team", sub: "LangGraph" },
  { id: "memory", x: 400, y: 310, label: "Memory", sub: "pgvector" },
  { id: "you", x: 760, y: 310, label: "You", sub: "approve or not" },
  { id: "guard", x: 760, y: 110, label: "Guardrails", sub: "plain code" },
  { id: "report", x: 930, y: 210, label: "Report", sub: "and audit log" },
] as const;

const WIRES = [
  "M110 200 C160 150 180 120 200 115",
  "M110 220 C160 270 180 300 200 305",
  "M262 110 L366 110",
  "M434 110 L526 110",
  "M560 132 L560 288",
  "M526 310 L434 310",
  "M262 310 C330 360 470 360 530 325",
  "M594 310 L726 310",
  "M760 288 L760 132",
  "M794 120 C860 140 880 180 900 200",
  "M726 100 C600 20 200 20 92 190",
];

/** One connection, drawn in its turn as the diagram scrolls into view. */
function Wire({ d, index, progress }: { d: string; index: number; progress: MotionValue<number> }) {
  const pathLength = useTransform(progress, [index / WIRES.length, (index + 1) / WIRES.length], [0, 1]);
  return <motion.path d={d} className={`arch-wire${index === WIRES.length - 1 ? " is-return" : ""}`} style={{ pathLength }} />;
}

function Node({ node, progress, at }: { node: (typeof NODES)[number]; progress: MotionValue<number>; at: number }) {
  const opacity = useTransform(progress, [at - 0.06, at], [0.15, 1]);
  const scale = useTransform(progress, [at - 0.06, at], [0.85, 1]);
  return (
    <motion.g style={{ opacity, scale, transformOrigin: `${node.x}px ${node.y}px` }}>
      <circle cx={node.x} cy={node.y} r={node.id === "you" ? 30 : 24} className={`arch-node node-${node.id}`} />
      <text x={node.x} y={node.y + 50} className="arch-label">
        {node.label}
      </text>
      <text x={node.x} y={node.y + 68} className="arch-sub">
        {node.sub}
      </text>
    </motion.g>
  );
}

export function Architecture() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start 75%", "end 60%"] });
  const progress = useSpring(scrollYProgress, { stiffness: 90, damping: 26 });
  return (
    <section className="chapter story-arch" aria-label="How the parts connect">
      <h2 className="section-title">From a metric to a fix, and back</h2>
      <p className="section-lede">
        Readings flow in, an alert becomes a job, the agents investigate with memory beside them, and nothing reaches the shop
        except through you and the guardrails.
      </p>
      <div ref={ref} className="arch">
        <svg viewBox="0 0 1000 420" role="img" aria-label="The shop sends metrics and logs; the detector puts alerts on a queue; the agents investigate with memory; you approve; the guardrails act on the shop and write the report.">
          <defs>
            {/* Measured across the whole diagram: measured on each line, a straight line's box has no
                height and the browser draws nothing. */}
            <linearGradient id="wire" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1000" y2="0">
              <stop offset="0" stopColor="#8fb7ff" />
              <stop offset="1" stopColor="#6fe3c8" />
            </linearGradient>
          </defs>
          {WIRES.map((d, i) => (
            <Wire key={i} d={d} index={i} progress={progress} />
          ))}
          {NODES.map((node, i) => (
            <Node key={node.id} node={node} progress={progress} at={Math.min(1, (i + 0.6) / NODES.length)} />
          ))}
        </svg>
      </div>
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
