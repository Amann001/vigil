import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Panel, RisingText, Sparkline } from "../components/Bits";
import { BreakSomething } from "../components/BreakSomething";
import { now } from "../lib/clock";
import { href } from "../lib/route";
import { diagnosisOf, eventsOf, serviceOf, type Situation } from "../lib/state";
import { SERVICES, type InvestigationSummary, type Service, type SystemView } from "../lib/types";
import {
  ago,
  duration,
  formatValue,
  headline,
  outcomeName,
  proposalName,
  serviceName,
  serviceRole,
  statusName,
} from "../lib/words";
import "./watch.css";

function useHeadline(s: Situation, system: SystemView | null): { title: string; line: string } {
  if (s.kind === "investigating" && s.running) {
    const d = diagnosisOf(s.running);
    const service = serviceOf(s.running);
    const started = s.running.started_at ?? s.running.alert_at;
    const seconds = (now() - new Date(started).getTime()) / 1000;
    const agents = s.agents.length;
    return {
      title: d ? `${headline(d)}.` : service ? `Something is wrong with ${serviceName[service]}.` : "Something is wrong.",
      line: d
        ? `Diagnosis ready, choosing a fix. Started ${duration(seconds)} ago.`
        : `${agents > 1 ? `${agents} agents are` : "The supervisor is"} investigating. Started ${duration(seconds)} ago.`,
    };
  }
  if (s.kind === "decide") {
    const first = s.pending[0];
    const d = first.root_cause_service && first.category ? headline({ root_cause_service: first.root_cause_service, category: first.category }) : "An incident";
    return {
      title: `${d}.`,
      line:
        s.pending.length > 1
          ? `${s.pending.length} diagnoses are waiting for your call. Nothing changes until you decide.`
          : `Vigil has a diagnosis and a proposed fix. Nothing changes until you decide.`,
    };
  }
  if (s.kind === "recovered" && s.recent) {
    return {
      title: `${serviceName[s.recent.proposal?.service ?? s.recent.root_cause_service ?? ""] ?? "The shop"} is back.`,
      line: `${outcomeName(s.recent.outcome)} ${ago(s.recent.alert_at)}. Vigil keeps watching.`,
    };
  }
  if (s.kind === "offline") {
    return {
      title: "No signal.",
      line: "Vigil cannot read the shop's metrics. Start the shop and Prometheus to begin the watch.",
    };
  }
  const down = SERVICES.filter((sv) => system?.services?.[sv]?.latest.up === null);
  if (down.length) {
    return { title: `${serviceName[down[0]]} is not responding.`, line: "The detector is confirming it before raising an alert." };
  }
  return {
    title: "All quiet.",
    line: "Four services healthy. Vigil reads 40 signals every 5 seconds and will wake the team if any turn strange.",
  };
}

function Inbox({ situation, list }: { situation: Situation; list: InvestigationSummary[] | null }) {
  const running = situation.running;
  const last = (list ?? []).find((i) => i.status !== "investigating");
  return (
    <Panel as="aside" className="inbox" delay={0.35} label="Incidents needing attention">
      {situation.runningAll.map((inv) => {
        const steps = eventsOf(inv).length;
        const service = serviceOf(inv);
        return (
          <a key={inv.id} className="inbox-row is-running" href={href({ page: "incident", id: inv.id })}>
            <span className="pulse" aria-hidden="true" />
            <span className="inbox-text">
              <strong>Investigating now</strong>
              <span>
                {steps} {steps === 1 ? "step" : "steps"} so far
                {service ? `, looking at ${serviceName[service]}` : ""}
              </span>
            </span>
            <span className="inbox-go">Watch</span>
          </a>
        );
      })}
      {[...situation.pending, ...situation.replays].map((item) => (
        <a key={item.id} className="inbox-row is-pending" href={href({ page: "incident", id: item.id })}>
          <span className="dot dot-sodium" aria-hidden="true" />
          <span className="inbox-text">
            <strong>
              {item.root_cause_service && item.category
                ? headline({ root_cause_service: item.root_cause_service, category: item.category })
                : "Incident"}
            </strong>
            <span>
              Proposed: {item.proposal ? proposalName(item.proposal).toLowerCase() : "no fix"}.{" "}
              {item.id.startsWith("live-") ? ago(item.alert_at) : "Replayed from a recording"}.
            </span>
          </span>
          <span className="inbox-go">Decide</span>
        </a>
      ))}
      {!running && situation.pending.length + situation.replays.length === 0 && (
        <div className="inbox-empty">
          <strong>Nothing needs you.</strong>
          {last ? (
            <span>
              Last incident {ago(last.alert_at)}:{" "}
              <a href={href({ page: "incident", id: last.id })}>
                {last.root_cause_service && last.category
                  ? headline({ root_cause_service: last.root_cause_service, category: last.category }).toLowerCase()
                  : "see it"}
              </a>
              , {(outcomeName(last.outcome) || statusName[last.status]).toLowerCase()}.
            </span>
          ) : (
            <span>No incidents yet. Break something to see Vigil work.</span>
          )}
        </div>
      )}
    </Panel>
  );
}

const VITALS: { key: string; label: string }[] = [
  { key: "latency_p95", label: "Response time, p95" },
  { key: "error_ratio", label: "Requests failing" },
  { key: "memory_mb", label: "Memory" },
  { key: "request_rate", label: "Requests" },
];

function Vitals({ service, system, tone }: { service: Service; system: SystemView | null; tone: "calm" | "sodium" | "flare" | "aurora" }) {
  const view = system?.services?.[service];
  const down = Boolean(system?.online && view && view.latest.up === null);
  return (
    <motion.div
      key={service}
      className="vitals"
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 12, transition: { duration: 0.15 } }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
    >
      <h2 className="vitals-name">{serviceName[service]}</h2>
      <p className="vitals-role">{serviceRole[service]}</p>
      <p className={`vitals-state state-${down ? "flare" : tone}`}>
        {down ? "Not responding" : tone === "sodium" ? "Under investigation" : tone === "aurora" ? "Recovered" : "Healthy"}
      </p>
      <dl>
        {VITALS.map(({ key, label }) => (
          <div key={key} className="vital">
            <dt>{label}</dt>
            <dd className="num">{formatValue(`x.${key}`, view?.latest[key as keyof typeof view.latest] ?? null)}</dd>
            <Sparkline values={view?.series[key] ?? []} tone={down ? "flare" : tone} />
          </div>
        ))}
      </dl>
    </motion.div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <p>Each star is a service of the shop. Click one to see its vitals.</p>
      <ul>
        <li>
          <span className="legend-spark" aria-hidden="true" /> Sparks are live requests between services.
        </li>
        <li>
          <span className="legend-spark is-slow" aria-hidden="true" /> Sparks crawl when calls slow down.
        </li>
        <li>
          <span className="legend-spark is-failed" aria-hidden="true" /> Red sparks are failed calls.
        </li>
        <li>
          <span className="legend-comet" aria-hidden="true" /> Comets are agents investigating a star.
        </li>
      </ul>
    </div>
  );
}

export function Watch({
  system,
  situation,
  list,
  mode,
  selected,
  onSelect,
}: {
  system: SystemView | null;
  situation: Situation;
  list: InvestigationSummary[] | null;
  mode: "live" | "demo" | "unknown";
  selected: Service | null;
  onSelect: (s: Service | null) => void;
}) {
  const { title, line } = useHeadline(situation, system);
  const [breaking, setBreaking] = useState(false);
  const [legend, setLegend] = useState(false);
  const toneFor = (s: Service) => (situation.focus?.service === s ? situation.focus.tone : "calm");
  return (
    <main className="watch">
      <h1 className="visually-hidden">Vigil war room</h1>
      <Inbox situation={situation} list={list} />

      {/* Vitals appear when a star is chosen, so the sky stays clear the rest of the time. */}
      <AnimatePresence>
        {selected && (
          <Panel key="side" as="aside" className="side" label="Service vitals">
            <AnimatePresence mode="wait">
              <Vitals key={selected} service={selected} system={system} tone={toneFor(selected)} />
            </AnimatePresence>
            <button className="link-button" onClick={() => onSelect(null)}>
              Close
            </button>
          </Panel>
        )}
      </AnimatePresence>

      <section className={`status status-${situation.kind}`} aria-live="polite">
        <h2 className="status-title">
          <RisingText key={title} text={title} />
        </h2>
        <motion.p
          key={title}
          className="status-line"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45, duration: 0.6 }}
        >
          {line}
        </motion.p>
        {situation.kind === "decide" && (
          <motion.a
            className="button button-primary"
            href={href({ page: "incident", id: situation.pending[0].id })}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 }}
          >
            Review the diagnosis
          </motion.a>
        )}
        {situation.kind === "investigating" && situation.running && (
          <motion.a
            className="button"
            href={href({ page: "incident", id: situation.running.id })}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 }}
          >
            Follow the investigation
          </motion.a>
        )}
      </section>

      <div className="corner">
        <AnimatePresence>
          {legend && (
            <Panel key="legend" className="legend-panel" label="How to read the sky">
              <Legend />
              <div className="service-picker" role="group" aria-label="Show a service's vitals">
                {SERVICES.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      onSelect(s);
                      setLegend(false);
                    }}
                    className={`chip tone-${toneFor(s)}`}
                  >
                    {serviceName[s]}
                  </button>
                ))}
              </div>
            </Panel>
          )}
        </AnimatePresence>
        <div className="corner-buttons">
          <button className="button button-ghost" aria-expanded={legend} onClick={() => setLegend(!legend)}>
            {legend ? "Close" : "How to read the sky"}
          </button>
          {mode !== "demo" && (
            <button className="button button-ghost" onClick={() => setBreaking(true)} disabled={mode !== "live"}>
              Break something
            </button>
          )}
        </div>
        {mode === "demo" && <ReplayGuide kind={situation.kind} />}
      </div>
      <AnimatePresence>{breaking && <BreakSomething onClose={() => setBreaking(false)} />}</AnimatePresence>
    </main>
  );
}

/** The replay's story in four steps: what is happening now, and what a visitor can do. */
const GUIDE: Record<string, { step: number; title: string; text: string }> = {
  quiet: {
    step: 1,
    title: "A replay of a real incident",
    text: "This is Vigil watching its demo shop, recorded from a real run. Keep an eye on the Orders star: something is about to go wrong with it.",
  },
  investigating: {
    step: 2,
    title: "Vigil noticed on its own",
    text: "Its detector raised the alarm and AI agents are investigating. Follow the investigation to see each question they ask and what they find.",
  },
  decide: {
    step: 3,
    title: "Your turn",
    text: "Vigil never changes anything without a person. Review the diagnosis and approve the fix; in the replay, nothing real is touched.",
  },
  recovered: {
    step: 4,
    title: "Fixed, with your approval",
    text: "Open the incident to see the proof it worked, or Scores for how Vigil is tested. The replay starts again shortly.",
  },
};

function ReplayGuide({ kind }: { kind: Situation["kind"] }) {
  const guide = GUIDE[kind] ?? GUIDE.quiet;
  return (
    <div className="replay-note" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={guide.step}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <p className="guide-head">
            <span className="guide-steps" aria-label={`Step ${guide.step} of 4`}>
              {[1, 2, 3, 4].map((n) => (
                <i key={n} className={n < guide.step ? "is-done" : n === guide.step ? "is-now" : ""} />
              ))}
            </span>
            <strong>{guide.title}</strong>
          </p>
          <p>{guide.text}</p>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
