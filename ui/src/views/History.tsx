import { motion } from "motion/react";
import { Panel } from "../components/Bits";
import { href } from "../lib/route";
import type { InvestigationSummary } from "../lib/types";
import { headline, outcomeName, proposalName, statusName } from "../lib/words";
import "./history.css";

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

export function History({ list }: { list: InvestigationSummary[] | null }) {
  const items = list ?? [];
  const days = new Map<string, InvestigationSummary[]>();
  for (const item of items) days.set(dayOf(item.alert_at), [...(days.get(dayOf(item.alert_at)) ?? []), item]);
  const waiting = items.filter((i) => i.status === "awaiting review").length;
  const fixed = items.filter((i) => i.outcome === "executed").length;
  const corrected = items.filter((i) => i.status === "corrected").length;

  return (
    <main className="history">
      <Panel className="history-panel" label="Every incident">
        <header className="history-head">
          <h1>Incidents</h1>
          <p>
            {items.length === 0
              ? "None yet. When the detector raises an alert, the investigation appears here."
              : `${items.length} investigated. ${fixed} fixed or rehearsed, ${corrected} corrected by a reviewer${waiting ? `, ${waiting} waiting for a decision` : ""}.`}
          </p>
        </header>
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
