import { motion } from "motion/react";
import { Panel, RisingText } from "../components/Bits";
import "./scores.css";

/*
  The evaluation from docs/RESULTS.md. These are measured results, fixed at the time of the run,
  so they are kept here rather than fetched.
*/

const ABLATION = [
  { name: "Vigil", detail: "Supervisor and specialists, memory, models chosen per role", right: 11, unsafe: 1, tokens: 24.7, best: true },
  { name: "Without memory", detail: "Same team, no runbooks or past incidents", right: 9, unsafe: 0, tokens: 22.4 },
  { name: "One small model", detail: "The same small model in every role", right: 9, unsafe: 2, tokens: 26.8 },
  { name: "One agent alone", detail: "A single agent holding every tool", right: 8, unsafe: 4, tokens: 18.7 },
];

const FACTS = [
  { value: "12/12", label: "incidents detected on the public set, a median of 21 s after the fault began, with no false alarms" },
  { value: "13 s", label: "for a second worker to take over a killed worker's investigation and finish it from its checkpoint" },
  { value: "11/11", label: "right runbook recalled first for a diagnosis, by vector search over memory" },
  { value: "2.4 s → 95 ms", label: "payments response time after a reviewer-approved restart, seven minutes after the fault" },
  { value: "≈23,600", label: "tokens for a whole investigation: about 23 model calls on free tiers, in 41 s" },
  { value: "$0", label: "to run: free tiers of Gemini, Groq, Neon and Langfuse, under 5 GB of disk" },
];

export function Scores() {
  return (
    <main className="scores">
      <Panel className="scores-panel" label="How well Vigil does">
        <section className="hidden-test">
          <h1>
            <RisingText text="Five incidents nobody tuned it for. Five right." />
          </h1>
          <p className="lede">
            Someone else wrote six failure scenarios; a separate agent turned them into tests the builder never saw.
            Vigil found the cause, the kind of failure and the right fix for all five incidents, left the sixth
            (not an incident) alone, proposed nothing unsafe and raised no false alarms.
          </p>
          <ol className="tally" aria-label="Hidden test results">
            {[1, 2, 3, 4, 5].map((n) => (
              <motion.li
                key={n}
                className="tally-mark is-right"
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.9 + n * 0.12, type: "spring", stiffness: 260, damping: 18 }}
              >
                <span className="visually-hidden">Incident {n}: right</span>
              </motion.li>
            ))}
            <motion.li
              className="tally-mark is-quiet"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ delay: 0.9 + 6 * 0.12, type: "spring", stiffness: 260, damping: 18 }}
            >
              <span className="visually-hidden">Not an incident: correctly left alone</span>
            </motion.li>
          </ol>
        </section>

        <section className="ablation">
          <h2>What each part is worth</h2>
          <p className="lede">
            14 public scenarios, 12 of them incidents, investigated by Vigil and by versions of it with one part
            removed. Bars count fully right answers: cause, kind of failure and fix.
          </p>
          <ul className="bars">
            {ABLATION.map((row, i) => (
              <li key={row.name} className={row.best ? "is-best" : ""}>
                <div className="bar-label">
                  <strong>{row.name}</strong>
                  <span>{row.detail}</span>
                </div>
                <div className="bar-track" aria-hidden="true">
                  <motion.div
                    className="bar-fill"
                    initial={{ width: 0 }}
                    whileInView={{ width: `${(row.right / 12) * 100}%` }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.15 + i * 0.12, duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
                  />
                  {Array.from({ length: 11 }, (_, k) => (
                    <span key={k} className="bar-grid" style={{ left: `${((k + 1) / 12) * 100}%` }} />
                  ))}
                </div>
                <div className="bar-numbers num">
                  <span className="bar-right">{row.right}/12</span>
                  <span className={`bar-unsafe ${row.unsafe ? "has-unsafe" : ""}`}>
                    {row.unsafe} unsafe {row.unsafe === 1 ? "fix" : "fixes"}
                  </span>
                  <span className="bar-tokens">{row.tokens}k tokens</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="footnote">
            An unsafe fix restarts a service that was not the cause. Single runs on 12 incidents: a difference of one or
            two is a hint, not a result. The one-agent gap is the clearest.
          </p>
        </section>

        <section className="facts">
          <h2>Measured along the way</h2>
          <dl>
            {FACTS.map((f) => (
              <div key={f.value} className="fact">
                <dt className="num">{f.value}</dt>
                <dd>{f.label}</dd>
              </div>
            ))}
          </dl>
        </section>
      </Panel>
    </main>
  );
}
