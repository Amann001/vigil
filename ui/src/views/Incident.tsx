import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Panel, RisingText } from "../components/Bits";
import { Decision } from "../components/Decision";
import { Markdown } from "../components/Markdown";
import { buildLog, type LogItem, STAGES, stageReached } from "../lib/log";
import { href } from "../lib/route";
import { diagnosisOf, serviceOf } from "../lib/state";
import type { Investigation, Signal } from "../lib/types";
import {
  agentName,
  agentRole,
  clock,
  formatValue,
  headline,
  outcomeName,
  proposalName,
  serviceName,
  signalName,
  statusName,
  toolName,
} from "../lib/words";
import "./incident.css";

function offset(at: string | undefined, start: string | undefined): string | null {
  if (!at || !start) return null;
  const s = Math.max(0, Math.round((new Date(at).getTime() - new Date(start).getTime()) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function SignalRow({ signal }: { signal: Signal }) {
  return (
    <li className="signal">
      <span className="signal-name">{signalName(signal.feature)}</span>
      <span className="signal-value num">
        {signal.value === null ? "stopped reporting" : formatValue(signal.feature, signal.value)}
        <span className="signal-usual"> usually {formatValue(signal.feature, signal.usual)}</span>
      </span>
    </li>
  );
}

function Report({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420;
  return (
    <div className={`finding-report ${open || !long ? "is-open" : ""}`}>
      <Markdown text={text} />
      {long && (
        <button className="link-button" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Show less" : "Read the whole answer"}
        </button>
      )}
    </div>
  );
}

function Item({ item, start }: { item: LogItem; start?: string }) {
  const time = offset(item.at, start);
  const head = (who: string, what: string, tone = "") => (
    <header className={`item-head ${tone}`}>
      <span className="item-who">{who}</span>
      <span className="item-what">{what}</span>
      {time && <span className="item-time num">{time}</span>}
    </header>
  );
  switch (item.kind) {
    case "alert":
      return (
        <>
          {head("Detector", "raised an alert", "tone-sodium")}
          <p className="item-lead">These signals moved furthest from normal:</p>
          <ul className="signals">
            {item.signals.slice(0, 4).map((s) => (
              <SignalRow key={s.feature} signal={s} />
            ))}
          </ul>
        </>
      );
    case "plan":
      return (
        <>
          {head("Supervisor", item.round > 1 ? `wants more evidence, round ${item.round}` : "split the investigation")}
          <ul className="questions">
            {item.tasks.map((t) => (
              <li key={t.agent}>
                <span className={`agent-dot agent-${t.agent}`} aria-hidden="true" />
                <span>
                  <strong>{agentName[t.agent] ?? t.agent}</strong>, {t.question}
                </span>
              </li>
            ))}
          </ul>
        </>
      );
    case "finding":
      return (
        <>
          {head(`${agentName[item.agent] ?? item.agent} agent`, "reported back")}
          <blockquote className="question">{item.question}</blockquote>
          {item.tools.length > 0 && (
            <p className="tools" aria-label="Tools it used">
              {[...new Set(item.tools)].map((t) => (
                <span key={t} className="tool">
                  {toolName[t] ?? t}
                  {item.tools.filter((x) => x === t).length > 1 && (
                    <span className="num"> ×{item.tools.filter((x) => x === t).length}</span>
                  )}
                </span>
              ))}
            </p>
          )}
          <Report text={item.report} />
        </>
      );
    case "diagnosis":
      return (
        <>
          {head("Supervisor", "diagnosed the cause", "tone-strong")}
          <h3 className="diagnosis-title">{headline(item.diagnosis)}</h3>
          <p className="diagnosis-summary">{item.diagnosis.summary}</p>
          <ul className="evidence">
            {item.diagnosis.evidence.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
          <p className={`confidence confidence-${item.diagnosis.confidence}`}>
            <span className="confidence-bars" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {item.diagnosis.confidence[0].toUpperCase() + item.diagnosis.confidence.slice(1)} confidence
          </p>
        </>
      );
    case "recall":
      return (
        <>
          {head("Memory", "recalled what helped before")}
          <p className="recalled">
            {item.recalled.map((r) => (
              <span key={r} className={`memory ${r.startsWith("live-") || r.startsWith("replay-") ? "is-incident" : ""}`}>
                {r.startsWith("live-") || r.startsWith("replay-") ? `Incident ${r}` : `Runbook: ${r.replace(/-/g, " ")}`}
              </span>
            ))}
          </p>
        </>
      );
    case "proposal":
      return (
        <>
          {head("Remediation agent", "proposed a fix")}
          <h3 className="proposal-title">{proposalName(item.proposal)}</h3>
          <p className="item-body">{item.proposal.rationale}</p>
          {item.proposal.cited_incidents.length > 0 && (
            <p className="item-note">Based on {item.proposal.cited_incidents.join(", ")}.</p>
          )}
        </>
      );
    case "waiting":
      return (
        <>
          {head("Vigil", "is waiting for you", "tone-sodium")}
          <p className="item-body">Nothing changes until a person decides.</p>
        </>
      );
    case "decision":
      return (
        <>
          {head(item.review.by, item.review.verdict === "confirmed" ? "confirmed the diagnosis" : "corrected the diagnosis")}
          {item.review.notes && <blockquote className="question">{item.review.notes}</blockquote>}
          <p className="item-body">
            {item.review.instead
              ? `Chose instead: restart ${serviceName[item.review.instead.service]}.`
              : item.review.approve
                ? "Approved the proposed fix."
                : "Rejected the proposed fix."}
          </p>
        </>
      );
    case "action": {
      const a = item.action;
      const ok = a.outcome === "executed";
      return (
        <>
          {head("Guardrails", outcomeName(a.outcome, a.dry_run).toLowerCase(), ok ? "tone-aurora" : "")}
          <p className="item-body">
            {a.action === "restart_service" && a.service
              ? ok
                ? a.dry_run
                  ? `A replayed incident, so ${serviceName[a.service]} was not really restarted.`
                  : `${serviceName[a.service]} restarted${a.result?.seconds ? ` and was ready in ${a.result.seconds} s` : ""}.`
                : `${serviceName[a.service]} was not restarted.`
              : "No change was made to the shop."}
            {a.reasons?.length ? ` ${a.reasons.join(" ")}` : ""}
          </p>
        </>
      );
    }
    case "report":
      return (
        <>
          {head("Comms agent", "wrote the incident report")}
          {item.markdown ? <Markdown text={item.markdown} className="incident-report" /> : null}
        </>
      );
  }
}

function Route({ reached, running }: { reached: number; running: boolean }) {
  return (
    <ol className="route" aria-label="Investigation progress">
      {STAGES.map((stage, i) => (
        <li
          key={stage.id}
          className={i < reached ? "is-done" : i === reached ? (running ? "is-now is-running" : "is-now") : ""}
          aria-current={i === reached ? "step" : undefined}
        >
          <span className="route-dot" aria-hidden="true" />
          <span className="route-label">{stage.label}</span>
        </li>
      ))}
    </ol>
  );
}

export function Incident({
  id,
  investigation,
  mode,
}: {
  id: string;
  investigation: Investigation | null;
  mode: "live" | "demo" | "unknown";
}) {
  const logRef = useRef<HTMLOListElement>(null);
  const items = investigation ? buildLog(investigation) : [];
  const running = investigation?.status === "investigating" || investigation?.status === "acting";
  const count = items.length;

  // Follow a running investigation: keep its newest step in view.
  useEffect(() => {
    if (running) logRef.current?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [count, running]);

  const d = diagnosisOf(investigation);
  const service = serviceOf(investigation);
  const title = d ? headline(d) : service ? `Looking at ${serviceName[service]}` : "Investigating";
  const start = investigation?.started_at ?? investigation?.timeline?.[0]?.at;

  return (
    <main className="incident">
      <Panel className="story" label="What happened">
        <a className="back" href={href({ page: "history" })}>
          All incidents
        </a>
        {!investigation ? (
          <p className="loading">Opening {id}…</p>
        ) : (
          <>
            <header className="story-head">
              <p className={`status-chip chip-${investigation.status.replace(" ", "-")}`}>{statusName[investigation.status]}</p>
              <h1 className="story-title">
                <RisingText key={title} text={`${title}.`} />
              </h1>
              <p className="story-meta">
                Alert at {clock(investigation.alert_at)}
                {investigation.seconds ? `, diagnosed in ${Math.round(investigation.seconds)} s` : ""}
                {investigation.action?.outcome ? `. ${outcomeName(investigation.action.outcome, investigation.action.dry_run)}.` : "."}
              </p>
            </header>
            <Route reached={stageReached(items, investigation.status)} running={running} />
            <ol className="log" ref={logRef}>
              <AnimatePresence initial={false}>
                {items.map((item, i) => (
                  <motion.li
                    key={`${item.kind}-${i}`}
                    className={`log-item item-${item.kind}`}
                    initial={{ opacity: 0, y: 18 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: running ? 0 : Math.min(i * 0.05, 0.5) }}
                  >
                    <Item item={item} start={start} />
                  </motion.li>
                ))}
              </AnimatePresence>
              {running && (
                <li className="log-item item-thinking" aria-live="polite">
                  <span className="thinking" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  Agents at work
                </li>
              )}
            </ol>
          </>
        )}
      </Panel>

      <Panel as="aside" className="dock" delay={0.25} label="Your decision">
        {investigation && <Decision investigation={investigation} mode={mode} />}
        {investigation && <Team investigation={investigation} />}
      </Panel>
    </main>
  );
}

function Team({ investigation }: { investigation: Investigation }) {
  const models = [...new Set(investigation.models ?? [])];
  if (!models.length) return null;
  const byRole = new Map<string, string[]>();
  for (const m of models) {
    const [role, model] = m.split(": ");
    byRole.set(role, [...(byRole.get(role) ?? []), model.split("/").pop() ?? model]);
  }
  return (
    <section className="team">
      <h2>Who worked on it</h2>
      <ul>
        {[...byRole].map(([role, used]) => (
          <li key={role}>
            <span className={`agent-dot agent-${role}`} aria-hidden="true" />
            <span className="team-role" title={agentRole[role]}>
              {agentName[role] ?? role}
            </span>
            <span className="team-model">{[...new Set(used)].join(", ")}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
