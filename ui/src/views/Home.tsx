import { AnimatePresence, motion, useInView, useMotionValueEvent, useScroll, useSpring } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RisingText } from "../components/Bits";
import { Wordmark } from "../components/Brand";
import { Magnetic, Parallax, Reveal, RollText, useSmoothScroll } from "../components/Motion";
import { useMode } from "../lib/api";
import { LIVE_URL } from "../lib/live";
import { href, type Route } from "../lib/route";
import type { Situation } from "../lib/state";
import { homeScroll } from "../lib/scroll";
import type { InvestigationSummary, SystemView } from "../lib/types";
import { FinalCall, Numbers, Problem, Shot, Stack, Steps, Terminal } from "./HomeStory";
import { Team } from "./TeamStack";
import "./home.css";

const FILM = `${import.meta.env.BASE_URL}film/vigil-demo.mp4`;

/** One real incident, as it happened on Vigil's demo shop. */
const NIGHT = [
  { at: "The fault", title: "Orders starts leaking memory", text: "Nobody tells Vigil." },
  { at: "38 s later", title: "The detector notices", text: "40 signals drift from normal. The alarm goes off." },
  { at: "At once", title: "A team investigates", text: "Specialists read logs, metrics and changes in parallel." },
  { at: "102 s later", title: "A diagnosis, with evidence", text: "Orders is leaking memory. High confidence." },
  { at: "Then", title: "It waits for a person", text: "Restart proposed. Nothing happens without a yes." },
  { at: "After the yes", title: "Fixed, and remembered", text: "Memory 419 MB → 65 MB. Report written." },
];

const PRINCIPLES = [
  { title: "Read freely, write with permission", text: "Agents read anything. Changes need a person." },
  { title: "Durable by default", text: "A crashed worker's job carries on from its checkpoint." },
  { title: "Measured, not assumed", text: "Tested on scenarios someone else wrote." },
  { title: "Runs on free tiers", text: "Free tiers only. Under 5 GB." },
];

const FOOTER: [string, [string, Route][]][] = [
  ["Watch", [["War room", { page: "watch" }], ["Incidents", { page: "history" }], ["Status", { page: "status" }]]],
  ["Learn", [["How it works", { page: "how" }], ["Results", { page: "scores" }]]],
  ["Operate", [["Audit log", { page: "audit" }], ["Policy", { page: "policy" }], ["Run it", { page: "run" }]]],
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

/**
 * The incident as a line that fills as you scroll; each step lights up when the line reaches it.
 * While the line is on screen the 3D sky replays the same step around the Orders star (see
 * STORY in App.tsx), so the words and the stars tell the night together.
 */
function Night({ onStep }: { onStep: (step: number) => void }) {
  const section = useRef<HTMLOListElement>(null);
  const { scrollYProgress } = useScroll({ target: section, offset: ["start 75%", "end 55%"] });
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  const [reached, setReached] = useState(-1);
  const inView = useInView(section, { margin: "-30% 0px -30% 0px" });
  useMotionValueEvent(scrollYProgress, "change", (v) => setReached(Math.floor(v * NIGHT.length - 0.05)));
  useEffect(() => onStep(inView ? Math.max(0, Math.min(NIGHT.length - 1, reached)) : -1), [inView, reached, onStep]);
  useEffect(() => () => onStep(-1), [onStep]);
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
  list,
  onPastHero,
  onStory,
}: {
  situation: Situation;
  system: SystemView | null;
  list: InvestigationSummary[] | null;
  /** Past the first screen the sky steps back, so the stars stop crossing the text. */
  onPastHero: (past: boolean) => void;
  /** Which step of the night is on screen, or -1: the sky replays it. */
  onStory: (step: number) => void;
}) {
  const [film, setFilm] = useState(false);
  const mode = useMode();
  useSmoothScroll(true);
  const { scrollY, scrollYProgress } = useScroll();
  useMotionValueEvent(scrollY, "change", (y) => onPastHero(y > window.innerHeight * 0.55));
  // The sky turns and the camera rises as the story goes on (read by the 3D scene each frame).
  useMotionValueEvent(scrollYProgress, "change", (p) => (homeScroll.progress = p));
  useEffect(
    () => () => {
      onPastHero(false);
      homeScroll.progress = 0;
    },
    [onPastHero],
  );
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
          Finds what broke, explains why, and fixes it when you say yes.
        </motion.p>
        <motion.div
          className="hero-actions"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.9, duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        >
          <Magnetic>
            <a className="button button-primary button-large" href={href({ page: "watch" })}>
              <RollText>Enter the war room</RollText>
            </a>
          </Magnetic>
          <Magnetic>
            <button className="button button-ghost button-large" onClick={() => setFilm(true)}>
              <span className="play" aria-hidden="true" />
              <RollText>Play the film, 2 min</RollText>
            </button>
          </Magnetic>
        </motion.div>
        <p className="hero-hint">
          Each star is a service. Click one. Sound on, top right, for the full story.
          {LIVE_URL && mode === "demo" && (
            <>
              {" "}
              This page replays a recorded incident; <a href={LIVE_URL}>the real system is running here</a>.
            </>
          )}
        </p>
        <span className="scroll-cue" aria-hidden="true">
          <i />
        </span>
      </section>

      <Problem />
      <Shot />

      <section className="home-section">
        <Reveal className="section-title" text="One night, start to finish" />
        <p className="section-lede">A real incident, as it happened.</p>
        <Night onStep={onStory} />
        <a className="button" href={href({ page: "watch" })}>
          Watch it happen in the war room
        </a>
      </section>

      <Team />
      <Terminal list={list} />
      <Steps />
      <Numbers />

      <section className="home-section">
        <Reveal className="section-title" text="Built like it runs in production" />
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
        <Parallax distance={120}>
          <p className="proof-number num">5/5</p>
        </Parallax>
        <div>
          <Reveal className="section-title" text="Five incidents nobody tuned it for. Five right." />
          <p className="section-lede">
            Scenarios written by someone else. Right cause, right fix, no false alarms.
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

      <Stack />
      <FinalCall />

      <footer className="home-footer">
        <div className="footer-top">
          <div className="footer-brand">
            <Parallax distance={60}>
              <Wordmark className="footer-word" />
            </Parallax>
            <p>The AI on-call engineer that never sleeps.</p>
          </div>
          <nav className="footer-links" aria-label="Site">
            {FOOTER.map(([title, links]) => (
              <div key={title}>
                <h3>{title}</h3>
                <ul>
                  {links.map(([label, route]) => (
                    <li key={label}>
                      <a href={href(route)}>{label}</a>
                    </li>
                  ))}
                  {title === "Learn" && (
                    <li>
                      <button className="footer-film" onClick={() => setFilm(true)}>
                        The film
                      </button>
                    </li>
                  )}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <p className="footer-base">
          Built on free tiers. Press <kbd>Ctrl K</kbd> to jump anywhere.
        </p>
      </footer>

      {/* In a portal: inside the home layer it would inherit "let the pointer through" (so the
          stars stay clickable) and sit under the top bar, and its buttons would not respond. */}
      {createPortal(<AnimatePresence>{film && <Film onClose={() => setFilm(false)} />}</AnimatePresence>, document.body)}
    </main>
  );
}
