import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Panel, RisingText, Sparkline } from "../components/Bits";
import { BreakSomething } from "../components/BreakSomething";
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
    const seconds = (Date.now() - new Date(started).getTime()) / 1000;
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
      {running && (
        <a className="inbox-row is-running" href={href({ page: "incident", id: running.id })}>
          <span className="pulse" aria-hidden="true" />
          <span className="inbox-text">
            <strong>Investigating now</strong>
            <span>
              {eventsOf(running).length} steps so far
              {serviceOf(running) ? `, looking at ${serviceName[serviceOf(running)!]}` : ""}
            </span>
          </span>
          <span className="inbox-go">Watch</span>
        </a>
      )}
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
  const toneFor = (s: Service) => (situation.focus?.service === s ? situation.focus.tone : "calm");
  return (
    <main className="watch">
      <h1 className="visually-hidden">Vigil war room</h1>
      <Inbox situation={situation} list={list} />

      <Panel as="aside" className="side" delay={0.5} label="Service vitals">
        <AnimatePresence mode="wait">
          {selected ? (
            <Vitals key={selected} service={selected} system={system} tone={toneFor(selected)} />
          ) : (
            <motion.div key="legend" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Legend />
              <div className="service-picker" role="group" aria-label="Show a service's vitals">
                {SERVICES.map((s) => (
                  <button key={s} onClick={() => onSelect(s)} className={`chip tone-${toneFor(s)}`}>
                    {serviceName[s]}
                  </button>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {selected && (
          <button className="link-button" onClick={() => onSelect(null)}>
            Show all services
          </button>
        )}
      </Panel>

      <section className={`status status-${situation.kind}`} aria-live="polite">
        <h2 className="status-title">
          <RisingText key={title} text={title} />
        </h2>
        <motion.p
          key={line}
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
        <button className="button button-ghost" onClick={() => setBreaking(true)} disabled={mode !== "live"} title={mode === "live" ? undefined : "Needs a running shop"}>
          Break something
        </button>
      </div>
      <AnimatePresence>{breaking && <BreakSomething onClose={() => setBreaking(false)} />}</AnimatePresence>
    </main>
  );
}
