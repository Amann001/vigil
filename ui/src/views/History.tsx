import { motion } from "motion/react";
import { useState } from "react";
import { Panel } from "../components/Bits";
import { href } from "../lib/route";
import { SERVICES, type InvestigationSummary } from "../lib/types";
import { duration, headline, outcomeName, proposalName, serviceName, statusName } from "../lib/words";
import "./history.css";
import "./pages.css";

function dayOf(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

function tone(i: InvestigationSummary) {
  if (i.status === "investigating") return "sodium";
  if (i.status === "awaiting review") return "sodium";
  if (i.outcome === "executed") return "aurora";
  if (i.status === "corrected") return "flare";
  return "calm";
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function secondsBetween(from: string, to: string | null | undefined): number | null {
  return to ? (Date.parse(to) - Date.parse(from)) / 1000 : null;
}

const FILTERS: { id: string; label: string; test: (i: InvestigationSummary) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "waiting", label: "Waiting", test: (i) => i.status === "awaiting review" },
  { id: "fixed", label: "Fixed", test: (i) => i.outcome === "executed" },
  { id: "corrected", label: "Corrected", test: (i) => i.status === "corrected" },
  ...SERVICES.map((s) => ({ id: s, label: serviceName[s], test: (i: InvestigationSummary) => i.root_cause_service === s })),
];

/**
 * How the on-call is going, in the numbers a team lead would ask for. Only live incidents count
 * towards decision and recovery times: a replayed incident was decided days after its alert.
 */
function Reliability({ items }: { items: InvestigationSummary[] }) {
  const live = items.filter((i) => i.id.startsWith("live-"));
  const diagnose = median(items.flatMap((i) => (i.seconds ? [i.seconds] : [])));
  const decide = median(live.flatMap((i) => secondsBetween(i.alert_at, i.decided_at) ?? []));
  const recover = median(
    live.filter((i) => i.outcome === "executed").flatMap((i) => secondsBetween(i.alert_at, i.acted_at) ?? []),
  );
  const reviewed = items.filter((i) => i.status === "confirmed" || i.status === "corrected");
  const confirmed = reviewed.filter((i) => i.status === "confirmed").length;
  const byService = SERVICES.map((s) => [s, items.filter((i) => i.root_cause_service === s).length] as const);
  const most = Math.max(1, ...byService.map(([, n]) => n));
  const show = (v: number | null) => (v === null ? "–" : duration(v));
  return (
    <section className="reliability" aria-label="Reliability">
      <dl className="stats">
        <div className="stat">
          <dt>Time to diagnose</dt>
          <dd className="num">{show(diagnose)}</dd>
          <small>Median, alert to diagnosis</small>
        </div>
        <div className="stat">
          <dt>Time to decision</dt>
          <dd className="num">{show(decide)}</dd>
          <small>Median, alert to a person's call</small>
        </div>
        <div className="stat">
          <dt>Time to recover</dt>
          <dd className="num">{show(recover)}</dd>
          <small>Median, alert to the fix running</small>
        </div>
        <div className="stat">
          <dt>Diagnoses confirmed</dt>
          <dd className="num">{reviewed.length ? `${Math.round((confirmed / reviewed.length) * 100)}%` : "–"}</dd>
          <small>
            {confirmed} of {reviewed.length} reviewed
          </small>
        </div>
      </dl>
      <div className="by-service" aria-label="Incidents by root cause">
        {byService.map(([s, n]) => (
          <div key={s} className="by-service-row">
            <span>{serviceName[s]}</span>
            <span className="by-service-bar">
              <motion.i initial={{ width: 0 }} animate={{ width: `${(n / most) * 100}%` }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }} />
            </span>
            <span className="num">{n}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function History({ list }: { list: InvestigationSummary[] | null }) {
  const all = list ?? [];
  const [filter, setFilter] = useState("all");
  const items = all.filter(FILTERS.find((f) => f.id === filter)!.test);
  const days = new Map<string, InvestigationSummary[]>();
  for (const item of items) days.set(dayOf(item.alert_at), [...(days.get(dayOf(item.alert_at)) ?? []), item]);
  const waiting = all.filter((i) => i.status === "awaiting review").length;
  const fixed = all.filter((i) => i.outcome === "executed").length;
  const corrected = all.filter((i) => i.status === "corrected").length;

  return (
    <main className="history">
      <Panel className="history-panel" label="Every incident">
        <header className="history-head">
          <h1>Incidents</h1>
          <p>
            {all.length === 0
              ? "None yet. When the detector raises an alert, the investigation appears here."
              : `${all.length} investigated. ${fixed} fixed or rehearsed, ${corrected} corrected by a reviewer${waiting ? `, ${waiting} waiting for a decision` : ""}.`}
          </p>
        </header>
        {all.length > 0 && <Reliability items={all} />}
        <div className="filters history-filters" role="group" aria-label="Show">
          {FILTERS.map((f) => {
            const count = all.filter(f.test).length;
            return (
              <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} disabled={!count && f.id !== "all"}>
                {f.label} <span className="num">{count}</span>
              </button>
            );
          })}
        </div>
        {[...days].map(([day, entries], d) => (
          <section key={day} className="day">
            <h2>{day}</h2>
            <ol>
              {entries.map((i, n) => (
                <motion.li
                  key={i.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(0.15 + d * 0.06 + n * 0.03, 0.8), duration: 0.5 }}
                >
                  <a className="row" href={href({ page: "incident", id: i.id })}>
                    <span className="row-time num">
                      {new Date(i.alert_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <span className={`dot dot-${tone(i)}`} aria-hidden="true" />
                    <span className="row-main">
                      <strong>
                        {i.root_cause_service && i.category
                          ? headline({ root_cause_service: i.root_cause_service, category: i.category })
                          : "Investigating"}
                      </strong>
                      <span>
                        {i.proposal ? `Proposed: ${proposalName(i.proposal).toLowerCase()}` : "No proposal yet"}
                        {i.id.startsWith("replay-") ? ". Replayed from a recording" : ""}
                      </span>
                    </span>
                    <span className="row-outcome">{outcomeName(i.outcome) || statusName[i.status]}</span>
                    <span className="row-time num row-took">{i.seconds ? `${Math.round(i.seconds)} s` : ""}</span>
                  </a>
                </motion.li>
              ))}
            </ol>
          </section>
        ))}
      </Panel>
    </main>
  );
}
