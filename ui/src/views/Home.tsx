import { AnimatePresence, motion, useMotionValueEvent, useScroll, useSpring } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RisingText } from "../components/Bits";
import { href } from "../lib/route";
import type { Situation } from "../lib/state";
import type { SystemView } from "../lib/types";
import "./home.css";

const FILM = `${import.meta.env.BASE_URL}film/vigil-demo.mp4`;

/** One real incident, as it happened on Vigil's demo shop. */
const NIGHT = [
  { at: "The fault", title: "Orders starts leaking memory", text: "Nobody tells Vigil. Nothing in the logs names the fault: there are only the symptoms a real leak would cause." },
  { at: "38 s later", title: "The detector notices", text: "A model that learned what normal looks like sees 40 signals drifting together and raises the alarm. No threshold was set by hand." },
  { at: "At once", title: "A team investigates", text: "A supervisor splits the problem into questions. Specialists read the logs, the metrics and the recent changes, side by side." },
  { at: "102 s later", title: "A diagnosis, with evidence", text: "Orders is leaking memory, with high confidence. Memory recalls the runbook and an earlier incident of the same kind." },
  { at: "Then", title: "It waits for a person", text: "The proposed fix is a restart. Nothing changes until someone confirms the diagnosis and approves it." },
  { at: "After the yes", title: "Fixed, and remembered", text: "Orders restarts and its memory falls from 419 MB to 65 MB. The incident report is written and kept for next time." },
];

const PRINCIPLES = [
  { title: "Read freely, write with permission", text: "Agents can look at anything. Every action that changes the system needs a person's approval." },
  { title: "Durable by default", text: "Every step is checkpointed. Kill a worker mid-investigation and another finishes it." },
  { title: "Measured, not assumed", text: "Tested on scenarios someone else wrote, and on public benchmarks, with the misses published." },
  { title: "Runs on free tiers", text: "Gemini, Groq, Neon and Langfuse free plans, and under 5 GB of disk." },
];

function liveLine(situation: Situation): string {
  switch (situation.kind) {
    case "investigating":
      return "Investigating an incident right now";
    case "decide":
      return "A fix is waiting for approval";
    case "recovered":
      return "Just fixed an incident";
    case "offline":
      return "Waiting for the shop to start";
    default:
      return "Watching the shop: all quiet";
  }
}

function Film({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <motion.div
      className="film"
      role="dialog"
      aria-modal="true"
      aria-label="Vigil in two minutes"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <motion.div
        className="film-frame"
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.92, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 10 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="film-head">
          <span>Vigil in two minutes: a real incident, from the fault to the fix. Esc closes.</span>
          <button className="button button-ghost" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
        <video src={FILM} controls autoPlay playsInline />
      </motion.div>
    </motion.div>
  );
}

/** The incident as a line that fills as you scroll; each step lights up when the line reaches it. */
function Night() {
  const section = useRef<HTMLOListElement>(null);
  const { scrollYProgress } = useScroll({ target: section, offset: ["start 75%", "end 55%"] });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  const [reached, setReached] = useState(-1);
  useMotionValueEvent(scrollYProgress, "change", (v) => setReached(Math.floor(v * NIGHT.length - 0.05)));
  return (
    <ol className="night" ref={section}>
      <motion.span className="night-line" style={{ scaleY: progress }} aria-hidden="true" />
      {NIGHT.map((step, i) => (
        <li key={step.title} className={i <= reached ? "is-lit" : ""}>
          <span className="night-at">{step.at}</span>
          <h3>{step.title}</h3>
          <p>{step.text}</p>
        </li>
      ))}
    </ol>
  );
}

export function Home({
  situation,
  onPastHero,
}: {
  situation: Situation;
  system: SystemView | null;
  /** Past the first screen the sky steps back, so the stars stop crossing the text. */
  onPastHero: (past: boolean) => void;
}) {
  const [film, setFilm] = useState(false);
  const { scrollY } = useScroll();
  useMotionValueEvent(scrollY, "change", (y) => onPastHero(y > window.innerHeight * 0.55));
  useEffect(() => () => onPastHero(false), [onPastHero]);
  return (
    <main className="home">
      <section className="hero">
        <motion.a
          className={`live-chip live-${situation.kind}`}
          href={href({ page: "watch" })}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.6 }}
        >
          <span className="live-dot" aria-hidden="true" />
          {liveLine(situation)}
        </motion.a>
        <h1 className="hero-title">
          <RisingText text="The on-call engineer that never sleeps." delay={0.1} />
        </h1>
        <motion.p
          className="hero-lede"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.7, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          Vigil watches a running system, notices trouble with machine learning, sends a team of AI agents to find the
          cause, and fixes it once a person says yes.
        </motion.p>
        <motion.div
          className="hero-actions"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.9, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <a className="button button-primary button-large" href={href({ page: "watch" })}>
            Enter the war room
          </a>
          <button className="button button-ghost button-large" onClick={() => setFilm(true)}>
            <span className="play" aria-hidden="true" />
            Play the film, 2 min
          </button>
        </motion.div>
        <p className="hero-hint">Every star on the right is a live service. Click one.</p>
        <span className="scroll-cue" aria-hidden="true">
          <i />
        </span>
      </section>

      <section className="home-section">
        <h2 className="section-title">One night, start to finish</h2>
        <p className="section-lede">A real incident on Vigil's demo shop, minute by minute.</p>
        <Night />
        <a className="button" href={href({ page: "watch" })}>
          Watch it happen in the war room
        </a>
      </section>

      <section className="home-section">
        <h2 className="section-title">Built like it runs in production</h2>
        <ul className="principles">
          {PRINCIPLES.map((p) => (
            <li key={p.title}>
              <h3>{p.title}</h3>
              <p>{p.text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="home-section home-proof">
        <p className="proof-number num">5/5</p>
        <div>
          <h2 className="section-title">Five incidents nobody tuned it for. Five right.</h2>
          <p className="section-lede">
            Someone else wrote the test scenarios. Vigil found the cause and the right fix every time, and raised no false
            alarms.
          </p>
          <div className="proof-links">
            <a className="button" href={href({ page: "scores" })}>
              See the results
            </a>
            <a className="button button-ghost" href={href({ page: "how" })}>
              Meet the agents
            </a>
          </div>
        </div>
      </section>

      <footer className="home-footer">
        <p className="footer-word">Vigil</p>
        <p>
          Python, LangGraph, PostgreSQL with pgvector, scikit-learn, ONNX Runtime, FastAPI, React and Three.js. Built to run on
          free tiers.
        </p>
      </footer>

      {/* In a portal: inside the home layer it would inherit "let the pointer through" (so the
          stars stay clickable) and sit under the top bar, and its buttons would not respond. */}
      {createPortal(<AnimatePresence>{film && <Film onClose={() => setFilm(false)} />}</AnimatePresence>, document.body)}
    </main>
  );
}
