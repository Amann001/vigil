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
import type { Investigation, InvestigationSummary } from "../lib/types";
import { agentName, proposalName, serviceName, toolName } from "../lib/words";
import { Reveal, RollText } from "../components/Motion";
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
  "3 a.m. Something breaks. Someone is paged, opens six dashboards and starts searching. Every minute is downtime.";

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
      <p className="problem-answer">Vigil does the search. You make the call.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 1b. The product itself: a real screenshot of the incident page, lying back in space, that
//     stands up to face the visitor as it scrolls into view (scripts/capture-shot.mjs makes it).

const SHOT = `${import.meta.env.BASE_URL}shots/incident.webp`;

export function Shot() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "center center"] });
  const p = useSpring(scrollYProgress, { stiffness: 90, damping: 24 });
  const rotateX = useTransform(p, [0, 1], reduce ? [0, 0] : [38, 0]);
  const scale = useTransform(p, [0, 1], reduce ? [1, 1] : [0.82, 1]);
  const sheen = useTransform(p, [0, 1], ["-60%", "140%"]);
  return (
    <section className="chapter story-shot" aria-label="The screen you decide on">
      <div ref={ref} className="shot-stage">
        <motion.figure className="shot-frame" style={{ rotateX, scale }}>
          <img
            src={SHOT}
            width={1920}
            height={1200}
            loading="lazy"
            alt="Vigil's incident page: Orders is leaking memory, the signals that moved, and the decision to restart it."
          />
          <motion.span className="shot-sheen" style={{ left: sheen }} aria-hidden="true" />
        </motion.figure>
      </div>
      <p className="shot-caption">The cause, the evidence, and one button. That is the whole job at 3 a.m.</p>
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
          <Reveal className="section-title" text="Inside an investigation" />
          <p className="section-lede">
            The last real incident, call by call. Scroll to play.
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
    text: "Spots what isn't normal.",
    icon: "M3 12h4l2-6 4 12 2-6h6",
  },
  {
    title: "Investigate",
    text: "Agents find the cause.",
    icon: "M10.5 17a6.5 6.5 0 1 1 0-13 6.5 6.5 0 0 1 0 13zM15.5 15.5 21 21",
  },
  {
    title: "Decide",
    text: "You approve the fix.",
    icon: "M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21c1.5-4 4.5-6 8-6s6.5 2 8 6",
  },
  {
    title: "Fix",
    text: "Applied safely, and logged.",
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
      <Reveal className="section-title" text="Four steps, every time" />
      <p className="section-lede">About two minutes and one click.</p>
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
  { to: 12, of: 12, label: "incidents detected, no false alarms" },
  { to: 11, of: 12, label: "diagnosed and fixed right" },
  { to: 5, of: 5, label: "right on a hidden test written by someone else" },
  { to: 11, of: 11, label: "right runbook found first" },
  { to: 13, unit: "s", label: "to recover from a crashed worker" },
  { to: 0, prefix: "$", label: "to run" },
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
      <Reveal className="section-title" text="Measured, not promised" />
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
      <Reveal className="final-title" text="The shop is being watched right now." />
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
          <RollText>Enter the war room</RollText>
        </motion.a>
        <a className="button button-ghost button-large" href={href({ page: "run" })}>
          <RollText>Run it yourself</RollText>
        </a>
      </div>
    </section>
  );
}
