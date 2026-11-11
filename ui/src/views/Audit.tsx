import { useState } from "react";
import { Panel, RisingText } from "../components/Bits";
import { api, usePoll } from "../lib/api";
import { href } from "../lib/route";
import type { AuditEntry } from "../lib/types";
import { outcomeName, serviceName } from "../lib/words";
import "./pages.css";

const FILTERS: { id: string; label: string; test: (e: AuditEntry) => boolean }[] = [
  { id: "all", label: "All", test: () => true },
  { id: "executed", label: "Carried out", test: (e) => e.outcome === "executed" && !e.dry_run },
  { id: "rehearsed", label: "Rehearsed", test: (e) => e.outcome === "executed" && Boolean(e.dry_run) },
  { id: "refused", label: "Blocked", test: (e) => e.outcome === "refused" },
  { id: "rejected", label: "Rejected", test: (e) => e.outcome === "rejected" },
  { id: "other", label: "Other", test: (e) => !["executed", "refused", "rejected"].includes(e.outcome) },
];

function actionName(e: AuditEntry): string {
  if (e.action === "restart_service") return `Restart ${serviceName[e.service ?? ""] ?? e.service}`;
  if (e.action === "escalate") return "Escalate to an engineer";
  if (e.action === "no_action") return "Change nothing";
  return e.action;
}

function tone(e: AuditEntry): string {
  if (e.outcome === "executed") return e.dry_run ? "calm" : "aurora";
  if (e.outcome === "refused") return "flare";
  if (e.outcome === "rejected") return "sodium";
  return "calm";
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** A spreadsheet of the log, for whoever has to answer for every change to production. */
function download(entries: AuditEntry[]) {
  const quote = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["time", "incident", "action", "service", "outcome", "rehearsal", "approved_by", "reasons"],
    ...entries.map((e) => [e.at, e.incident, e.action, e.service, e.outcome, e.dry_run ? "yes" : "no", e.approved_by, (e.reasons ?? []).join(" ")]),
  ];
  const blob = new Blob([rows.map((r) => r.map(quote).join(",")).join("\n")], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "vigil-audit-log.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * Every decision about changing the shop, in the order it happened. Written by the guardrails
 * (plain code), not by the agents, so it records what was allowed and what was refused.
 */
export function Audit({ mode }: { mode: "live" | "demo" | "unknown" }) {
  const entries = usePoll(api.audit, 5000, mode).data;
  const [filter, setFilter] = useState("all");
  const shown = (entries ?? []).filter(FILTERS.find((f) => f.id === filter)!.test);
  return (
    <main className="doc">
      <Panel className="doc-panel" label="Audit log">
        <header className="doc-head">
          <h1>
            <RisingText text="Audit log" />
          </h1>
          <p className="doc-lede">
            Every decision about changing the shop: what was asked for, who approved it, and whether the guardrails let it
            through. Written by plain code, not by the agents, and never edited.
          </p>
        </header>

        <div className="doc-tools">
          <div className="filters" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.id} className="chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
                {entries && <span className="num"> {entries.filter(f.test).length}</span>}
              </button>
            ))}
          </div>
          <button className="button" onClick={() => download(shown)} disabled={!shown.length}>
            Download as CSV
          </button>
        </div>

        {entries === null ? (
          <p className="doc-note">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="doc-note">No decisions {filter === "all" ? "yet" : "of this kind"}.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Outcome</th>
                  <th>Approved by</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <td className="num">
                      {when(e.at)}
                      <br />
                      <a href={href({ page: "incident", id: e.incident })}>{e.incident}</a>
                    </td>
                    <td>{actionName(e)}</td>
                    <td>
                      <span className={`pill pill-${tone(e)}`}>{outcomeName(e.outcome, e.dry_run) || e.outcome}</span>
                    </td>
                    <td>{e.approved_by ?? "–"}</td>
                    <td>{e.reasons?.length ? e.reasons.join(" ") : e.result?.seconds ? `Ready again in ${e.result.seconds} s.` : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="doc-note">
          A rehearsed fix belongs to a replayed incident: it passed every check but changed nothing. Read the rules on the{" "}
          <a href={href({ page: "policy" })}>policy page</a>.
        </p>
      </Panel>
    </main>
  );
}
