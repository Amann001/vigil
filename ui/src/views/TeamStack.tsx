import { motion, type MotionValue, useInView, useReducedMotion, useScroll, useTransform } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Reveal } from "../components/Motion";
import { href } from "../lib/route";
import { PARTS, STAGES } from "../lib/team";
import "./team.css";

/*
  The team as a stack of cards, one for each stage of an incident. Each card is pinned as it
  arrives and the next one slides up over it, while the cards beneath shrink and tip back into
  the dark. Each stage has its own colour, the same arc as the incident itself: ice blue while
  all is calm, sodium amber once there is trouble, violet while the cause is weighed, aurora
  green when it is fixed. Each card plays a small loop of what that stage does, with the real
  figures of the recorded incident (Orders leaking memory, 63 MB usually, 419 MB at the alert).
*/

const LOOK: { tone: string; line: string; Visual: (props: { play: boolean }) => ReactNode }[] = [
  { tone: "ice", line: "It notices first.", Visual: NoticeVisual },
  { tone: "amber", line: "Three specialists, all at once.", Visual: InvestigateVisual },
  { tone: "violet", line: "One cause, with evidence.", Visual: DecideVisual },
  { tone: "aurora", line: "You say yes. It does the rest.", Visual: ActVisual },
];

const EASE = [0.16, 1, 0.3, 1] as const;

/** A number that goes up by one every `ms` while `on`: used as a key, it replays a loop. */
function useLoop(on: boolean, ms: number): number {
  const [round, setRound] = useState(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!on || reduce) return;
    const timer = window.setInterval(() => setRound((r) => r + 1), ms);
    return () => window.clearInterval(timer);
  }, [on, ms, reduce]);
  return round;
}

// ---------------------------------------------------------------------------------------------
// The four loops.

/** Orders' memory climbs past the alert line; where it crosses, the alarm goes off. */
function NoticeVisual({ play }: { play: boolean }) {
  const round = useLoop(play, 5200);
  const LINE = 118; // the alert line's height in the drawing
  return (
    <svg key={round} className="visual-svg" viewBox="0 0 400 300" role="img" aria-label="Orders memory rising past the alert line">
      <defs>
        {/* The line is blue below the alert line and amber above it. */}
        <linearGradient id="notice-stroke" x1="0" y1="0" x2="0" y2="300" gradientUnits="userSpaceOnUse">
          <stop offset={LINE / 300} stopColor="#ffa53d" />
          <stop offset={LINE / 300} stopColor="#8fb7ff" />
        </linearGradient>
        <linearGradient id="notice-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8fb7ff" stopOpacity="0.28" />
          <stop offset="1" stopColor="#8fb7ff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[60, 120, 180, 240].map((y) => (
        <line key={y} x1="24" x2="376" y1={y} y2={y} className="grid-line" />
      ))}
      <line x1="24" x2="376" y1={LINE} y2={LINE} className="alert-line" />
      <text x="376" y={LINE - 8} textAnchor="end" className="svg-label amber">
        alert line
      </text>
      <motion.path
        d="M24 236 C80 234 110 232 150 226 S220 200 250 170 S300 100 330 74 S360 52 376 46 L376 276 L24 276Z"
        fill="url(#notice-fill)"
        initial={{ opacity: 0 }}
        animate={play ? { opacity: 1 } : {}}
        transition={{ duration: 1.6, delay: 0.6 }}
      />
      <motion.path
        d="M24 236 C80 234 110 232 150 226 S220 200 250 170 S300 100 330 74 S360 52 376 46"
        fill="none"
        stroke="url(#notice-stroke)"
        strokeWidth="3"
        strokeLinecap="round"
        initial={{ pathLength: 0 }}
        animate={play ? { pathLength: 1 } : {}}
        transition={{ duration: 2.4, ease: "easeInOut" }}
      />
      <motion.g initial={{ opacity: 0, scale: 0.4 }} animate={play ? { opacity: 1, scale: 1 } : {}} transition={{ delay: 1.75, duration: 0.5, ease: EASE }} style={{ transformOrigin: "296px 118px" }}>
        <circle cx="296" cy={LINE} r="7" className="alarm-dot" />
        <circle cx="296" cy={LINE} r="7" className="alarm-ring" />
      </motion.g>
      <motion.g initial={{ opacity: 0, y: 8 }} animate={play ? { opacity: 1, y: 0 } : {}} transition={{ delay: 2.1, duration: 0.6, ease: EASE }}>
        <rect x="150" y="30" width="128" height="40" rx="10" className="chip-bg amber" />
        <text x="214" y="55" textAnchor="middle" className="svg-label strong">
          Alert · 38 s
        </text>
      </motion.g>
      <text x="24" y="292" className="svg-label">
        Orders memory: 63 MB usually
      </text>
      <motion.text x="376" y="292" textAnchor="end" className="svg-label amber strong" initial={{ opacity: 0 }} animate={play ? { opacity: 1 } : {}} transition={{ delay: 2.3 }}>
        419 MB
      </motion.text>
    </svg>
  );
}

const AGENTS = [
  { name: "Logs", x: 72, y: 70, color: "#ffd38a" },
  { name: "Metrics", x: 328, y: 70, color: "#8fb7ff" },
  { name: "Changes", x: 200, y: 262, color: "#c9a6ff" },
];

/** The supervisor sends a question to each specialist at once; the answers come back. */
function InvestigateVisual({ play }: { play: boolean }) {
  const round = useLoop(play, 4800);
  const C = { x: 200, y: 150 };
  return (
    <svg key={round} className="visual-svg" viewBox="0 0 400 300" role="img" aria-label="The supervisor asking three specialist agents at once">
      {AGENTS.map((a, i) => (
        <g key={a.name}>
          <motion.line
            x1={C.x}
            y1={C.y}
            x2={a.x}
            y2={a.y}
            stroke={a.color}
            strokeOpacity="0.45"
            strokeWidth="1.5"
            initial={{ pathLength: 0 }}
            animate={play ? { pathLength: 1 } : {}}
            transition={{ delay: 0.3 + i * 0.12, duration: 0.7, ease: EASE }}
          />
          {/* A question goes out, an answer comes back. */}
          <motion.circle
            r="4.5"
            fill={a.color}
            style={{ filter: `drop-shadow(0 0 6px ${a.color})` }}
            initial={{ cx: C.x, cy: C.y, opacity: 0 }}
            animate={play ? { cx: [C.x, a.x, a.x, C.x], cy: [C.y, a.y, a.y, C.y], opacity: [0, 1, 1, 0] } : {}}
            transition={{ delay: 0.9 + i * 0.15, duration: 2.6, times: [0, 0.35, 0.6, 1], ease: "easeInOut" }}
          />
          <motion.g initial={{ opacity: 0, scale: 0.6 }} animate={play ? { opacity: 1, scale: 1 } : {}} transition={{ delay: 0.6 + i * 0.12, duration: 0.5, ease: EASE }} style={{ transformOrigin: `${a.x}px ${a.y}px` }}>
            <circle cx={a.x} cy={a.y} r="22" fill={a.color} fillOpacity="0.12" stroke={a.color} strokeOpacity="0.7" />
            <circle cx={a.x} cy={a.y} r="5" fill={a.color} />
            <text x={a.x} y={a.y + (a.y > C.y ? -32 : 40)} textAnchor="middle" className="svg-label strong">
              {a.name}
            </text>
          </motion.g>
        </g>
      ))}
      <motion.g initial={{ scale: 0.7, opacity: 0 }} animate={play ? { scale: 1, opacity: 1 } : {}} transition={{ duration: 0.6, ease: EASE }} style={{ transformOrigin: "200px 150px" }}>
        <circle cx={C.x} cy={C.y} r="34" className="hub" />
        <circle cx={C.x} cy={C.y} r="34" className="hub-ring" />
        <text x={C.x} y={C.y + 5} textAnchor="middle" className="svg-label strong">
          Supervisor
        </text>
      </motion.g>
    </svg>
  );
}

const EVIDENCE = ["Memory 6.7× usual", "Never comes back down", "Response times normal"];

/** The findings come together into one diagnosis, and memory recalls the matching runbook. */
function DecideVisual({ play }: { play: boolean }) {
  const round = useLoop(play, 5200);
  return (
    <div key={round} className="visual-html decide" role="img" aria-label="Three findings coming together into one diagnosis">
      <div className="evidence">
        {EVIDENCE.map((e, i) => (
          <motion.span
            key={e}
            className="evidence-chip"
            initial={{ opacity: 0, x: -24 }}
            animate={play ? { opacity: [0, 1, 1, 0.35], x: [-24, 0, 0, 0] } : {}}
            transition={{ delay: 0.2 + i * 0.25, duration: 2.6, times: [0, 0.2, 0.75, 1], ease: EASE }}
          >
            <i aria-hidden="true" />
            {e}
          </motion.span>
        ))}
      </div>
      <motion.div className="verdict" initial={{ opacity: 0, y: 18, scale: 0.94 }} animate={play ? { opacity: 1, y: 0, scale: 1 } : {}} transition={{ delay: 1.6, duration: 0.8, ease: EASE }}>
        <span className="verdict-label">Root cause</span>
        <strong>Orders is leaking memory.</strong>
        <span className="verdict-bars" aria-hidden="true">
          {[0, 1, 2].map((b) => (
            <motion.i key={b} initial={{ scaleY: 0 }} animate={play ? { scaleY: 1 } : {}} transition={{ delay: 2 + b * 0.12, duration: 0.4 }} />
          ))}
        </span>
        <span className="verdict-conf">High confidence</span>
      </motion.div>
      <motion.span className="recall-chip" initial={{ opacity: 0, y: 10 }} animate={play ? { opacity: 1, y: 0 } : {}} transition={{ delay: 2.6, duration: 0.6, ease: EASE }}>
        <i aria-hidden="true" />
        Recalled: the memory leak runbook
      </motion.span>
    </div>
  );
}

/** A person approves the restart; memory falls back to normal; the report is written. */
function ActVisual({ play }: { play: boolean }) {
  const round = useLoop(play, 5600);
  const [mb, setMb] = useState(419);
  useEffect(() => {
    setMb(419);
    if (!play) return;
    let frame = 0;
    const start = performance.now() + 1700;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / 1400));
      setMb(Math.round(419 - (419 - 65) * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [play, round]);
  return (
    <div key={round} className="visual-html act" role="img" aria-label="Approving the restart, and Orders memory falling from 419 MB to 65 MB">
      <div className="approve-row">
        {/* Pressed, then aurora: the same moment the star turns green in the sky. */}
        <motion.span
          className="approve"
          initial={{ scale: 1, backgroundColor: "#ffa53d" }}
          animate={play ? { scale: [1, 1, 0.93, 1], backgroundColor: ["#ffa53d", "#ffa53d", "#ffa53d", "#6fe3c8"] } : {}}
          transition={{ delay: 0.2, duration: 1.3, times: [0, 0.7, 0.8, 1] }}
        >
          <motion.span className="approve-text" initial={{ opacity: 1 }} animate={play ? { opacity: [1, 1, 0] } : {}} transition={{ delay: 0.2, duration: 1.3, times: [0, 0.85, 1] }}>
            Restart Orders
          </motion.span>
          <motion.span className="approve-done" initial={{ opacity: 0, scale: 0.6 }} animate={play ? { opacity: 1, scale: 1 } : {}} transition={{ delay: 1.45, duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}>
            ✓ Approved
          </motion.span>
        </motion.span>
        <motion.span
          className="pointer"
          aria-hidden="true"
          initial={{ x: 120, y: 70, opacity: 0 }}
          animate={play ? { x: [120, 0, 0, 30], y: [70, 0, 0, 40], opacity: [0, 1, 1, 0], scale: [1, 1, 0.75, 1] } : {}}
          transition={{ duration: 1.9, times: [0, 0.5, 0.62, 1], ease: "easeInOut" }}
        />
      </div>
      <div className="recovery-meter">
        <div className="meter-head">
          <span>Orders memory</span>
          <b className="num">{mb} MB</b>
        </div>
        <span className="meter-track">
          <span className="meter-usual" style={{ left: `${(63 / 440) * 100}%` }} />
          <span className="meter-fill" style={{ width: `${(mb / 440) * 100}%` }} />
        </span>
      </div>
      <motion.span className="report-chip" initial={{ opacity: 0, y: 10 }} animate={play ? { opacity: 1, y: 0 } : {}} transition={{ delay: 3.3, duration: 0.6, ease: EASE }}>
        Report written · Remembered for next time
      </motion.span>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The stack.

function StackCard({ index, progress }: { index: number; progress: MotionValue<number> }) {
  const stage = STAGES[index];
  const look = LOOK[index];
  const behind = STAGES.length - 1 - index; // how many cards will come to lie on top of this one
  const reduce = useReducedMotion();
  const start = index / STAGES.length;
  // Once the next card arrives, this one shrinks, tips back and darkens, a little more for each
  // card that lands on top of it.
  const scale = useTransform(progress, [start, 1], [1, reduce ? 1 : 1 - behind * 0.055]);
  const rotateX = useTransform(progress, [start, 1], [0, reduce ? 0 : behind * 5]);
  const shade = useTransform(progress, [start, 1], [0, reduce ? 0 : behind * 0.2]);
  const card = useRef<HTMLElement>(null);
  const inView = useInView(card, { amount: 0.55 });
  const { Visual } = look;
  return (
    <div className="stack-slot" style={{ "--i": index } as React.CSSProperties}>
      <motion.article ref={card} className={`stack-card tone-${look.tone}`} style={{ scale, rotateX }}>
        <div className="stack-visual">
          <Visual play={inView} />
        </div>
        <div className="stack-body">
          <div className="stack-top">
            <span className="stack-stage">{stage.title}</span>
            <span className="stack-number num" aria-hidden="true">
              0{index + 1}
            </span>
          </div>
          <h3>{look.line}</h3>
          <ul className="stack-parts">
            {stage.parts.map((id) => (
              <li key={id}>
                <span className={`agent-dot agent-${PARTS[id].role ?? id}`} aria-hidden="true" />
                <strong>{PARTS[id].name}</strong>
                <span>{PARTS[id].short}</span>
              </li>
            ))}
          </ul>
        </div>
        <motion.span className="stack-shade" style={{ opacity: shade }} aria-hidden="true" />
      </motion.article>
    </div>
  );
}

export function Team() {
  const stack = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: stack, offset: ["start start", "end end"] });
  return (
    <section className="chapter story-team" aria-label="The team">
      <header className="team-head">
        <Reveal className="section-title" text="Eleven parts. One job each." />
        <p className="section-lede">Four stages, the same every time.</p>
      </header>
      <div ref={stack} className="stack">
        {STAGES.map((stage, i) => (
          <StackCard key={stage.title} index={i} progress={scrollYProgress} />
        ))}
      </div>
      <a className="link-button team-more" href={href({ page: "how" })}>
        What each part did in the last real incident
      </a>
    </section>
  );
}
