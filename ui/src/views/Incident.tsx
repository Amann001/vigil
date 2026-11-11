import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Panel, RisingText, Sparkline } from "../components/Bits";
import { Decision } from "../components/Decision";
import { ReplayBar } from "../components/ReplayBar";
import { Markdown } from "../components/Markdown";
import { buildLog, type LogItem, STAGES, stageReached } from "../lib/log";
import { href } from "../lib/route";
import { diagnosisOf, serviceOf } from "../lib/state";
import { SERVICES, type Investigation, type Service, type Signal, type SystemView } from "../lib/types";
import {
  agentName,
  agentRole,
  clock,
  duration,
  formatValue,
  headline,
  outcomeName,
  proposalName,
  serviceName,
  signalName,
  signalService,
  statusName,
  toolName,
} from "../lib/words";
import "./incident.css";

function offset(at: string | undefined, start: string | undefined): string | null {
  if (!at || !start) return null;
  const s = Math.max(0, Math.round((new Date(at).getTime() - new Date(start).getTime()) / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** When it happened and how long each stage took: the numbers a postmortem starts from. */
function Timings({ investigation: inv }: { investigation: Investigation }) {
  const after = (iso: string | undefined) =>
    iso ? duration((Date.parse(iso) - Date.parse(inv.alert_at)) / 1000) : null;
  // A replayed incident was decided long after its recorded alert, so only its diagnosis time means anything.
  const live = inv.id.startsWith("live-");
  const decided = live ? after(inv.review?.at) : null;
  const fixed = live && inv.action?.outcome === "executed" ? after(inv.action.at) : null;
  return (
    <p className="story-meta">
      <span>Alert at {clock(inv.alert_at)}</span>
      {inv.seconds ? <span>Diagnosed in {duration(inv.seconds)}</span> : null}
      {decided && <span>Decided {decided} after the alert</span>}
      {fixed && <span className="meta-good">Fixed {fixed} after the alert</span>}
      {inv.action?.outcome && !fixed && <span>{outcomeName(inv.action.outcome, inv.action.dry_run)}</span>}
    </p>
  );
}

/** The whole investigation as a Markdown file, to paste into a postmortem or a ticket. */
function asMarkdown(inv: Investigation, title: string): string {
  const d = diagnosisOf(inv);
  const lines = [
    `# ${title}`,
    "",
    `- Incident: ${inv.id}`,
    `- Alert: ${inv.alert_at}`,
    `- Status: ${statusName[inv.status]}`,
  ];
  if (inv.seconds) lines.push(`- Diagnosed in: ${duration(inv.seconds)}`);
  if (d) lines.push(`- Root cause: ${serviceName[d.root_cause_service] ?? d.root_cause_service}, ${d.category.replace(/_/g, " ")}, ${d.confidence} confidence`);
  if (inv.proposal) lines.push(`- Proposed fix: ${proposalName(inv.proposal)}`);
  if (inv.review) lines.push(`- Decision: ${inv.review.verdict} by ${inv.review.by} at ${inv.review.at}${inv.review.approve ? ", fix approved" : ""}`);
  if (inv.action) lines.push(`- Action: ${outcomeName(inv.action.outcome, inv.action.dry_run) || inv.action.outcome} at ${inv.action.at}`);
  if (d) lines.push("", "## Diagnosis", "", d.summary, "", "### Evidence", "", ...d.evidence.map((e) => `- ${e}`));
  if (inv.signals?.length) {
    lines.push("", "## Signals at the alert", "");
    for (const s of inv.signals) lines.push(`- ${signalName(s.feature)}: ${formatValue(s.feature, s.value)} (usually ${formatValue(s.feature, s.usual)})`);
  }
  if (inv.incident_report) lines.push("", "## Incident report", "", inv.incident_report);
  return lines.join("\n") + "\n";
}

function Share({ investigation, title }: { investigation: Investigation; title: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: the address bar still has the link */
    }
  };
  const download = () => {
    const blob = new Blob([asMarkdown(investigation, title)], { type: "text/markdown" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${investigation.id}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <div className="share" role="group" aria-label="Share this incident">
      <button className="link-button" onClick={copy}>
        {copied ? "Link copied" : "Copy link"}
      </button>
      <button className="link-button" onClick={download}>
        Download report
      </button>
    </div>
  );
}

/** How far a reading is from usual, in words: "6.6× usual", "half of usual". */
export function ratioWords(value: number, usual: number): string {
  if (usual <= 0) return value > 0 ? "usually none" : "as usual";
  const r = value / usual;
  if (r >= 1.15) return `${r < 10 ? r.toFixed(1) : Math.round(r)}× usual`;
  if (r <= 0.87) return `${Math.round(r * 100)}% of usual`;
  return "about usual";
}

/** Where a reading sits on a log scale centred on its usual value: 1/16× at the left edge,
 *  16× at the right. Logarithmic, so "twice as slow" and "half as fast" look equally far. */
function meterPosition(value: number, usual: number): number {
  if (usual <= 0) return value > 0 ? 1 : 0.5;
  return Math.min(1, Math.max(0, 0.5 + Math.log2(Math.max(value, 1e-9) / usual) / 8));
}

/** Pointing at a piece of evidence lights up the star it is about. */
type Point = (service: Service | null) => void;

function pointAt(point: Point | undefined, service: string | null | undefined) {
  return {
    onMouseEnter: () => point?.(SERVICES.includes(service as Service) ? (service as Service) : null),
    onMouseLeave: () => point?.(null),
  };
}

function SignalRow({ signal, point }: { signal: Signal; point?: Point }) {
  const at = signal.value === null ? 0 : meterPosition(signal.value, signal.usual);
  return (
    <li className="signal" {...pointAt(point, signalService(signal.feature))}>
      <span className="signal-name">{signalName(signal.feature)}</span>
      <span className="signal-value num">
        {signal.value === null ? "stopped reporting" : formatValue(signal.feature, signal.value)}
        <span className="signal-usual"> usually {formatValue(signal.feature, signal.usual)}</span>
      </span>
      <span className="meter" aria-hidden="true">
        <span
          className={`meter-fill${at < 0.5 ? " is-below" : ""}`}
          style={{ left: `${Math.min(at, 0.5) * 100}%`, width: `${Math.abs(at - 0.5) * 100}%` }}
        />
        <span className="meter-usual" />
      </span>
      <span className="signal-ratio num">
        {signal.value === null ? "no data" : ratioWords(signal.value, signal.usual)}
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

function Item({ item, start, point }: { item: LogItem; start?: string; point?: Point }) {
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
              <SignalRow key={s.feature} signal={s} point={point} />
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
          <h3 className="diagnosis-title" {...pointAt(point, item.diagnosis.root_cause_service)}>
            {headline(item.diagnosis)}
          </h3>
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
          <h3 className="proposal-title" {...pointAt(point, item.proposal.service)}>
            {proposalName(item.proposal)}
          </h3>
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
  system,
  onPoint,
}: {
  id: string;
  investigation: Investigation | null;
  mode: "live" | "demo" | "unknown";
  system: SystemView | null;
  onPoint?: Point;
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
        <div className="story-top">
          <a className="back" href={href({ page: "history" })}>
            Incidents
          </a>
          {investigation && <Share investigation={investigation} title={title} />}
        </div>
        {!investigation ? (
          <p className="loading">Opening {id}…</p>
        ) : (
          <>
            <header className="story-head">
              <p className={`status-chip chip-${investigation.status.replace(" ", "-")}`}>{statusName[investigation.status]}</p>
              <h1 className="story-title">
                <RisingText key={title} text={`${title}.`} />
              </h1>
              <Timings investigation={investigation} />
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
                    <Item item={item} start={start} point={onPoint} />
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

      {investigation && (
        <Panel as="aside" className="dock" delay={0.25} label="Your decision">
          {/* Keyed by status: the choices start afresh once there is a proposal to decide on. */}
          <Decision key={investigation.status} investigation={investigation} mode={mode} />
          <Recovery investigation={investigation} system={system} />
          {mode === "demo" && <ReplayBar />}
          <Team investigation={investigation} />
        </Panel>
      )}
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

/**
 * After a fix: the signal that raised the alarm, as it was then and as it is now, with its
 * last ten minutes. The proof that the restart worked, in one glance.
 */
function Recovery({ investigation, system }: { investigation: Investigation; system: SystemView | null }) {
  const action = investigation.action;
  if (action?.outcome !== "executed" || action.dry_run || !system?.services) return null;
  const services = system.services;
  const signal = (investigation.signals ?? []).find((s) => {
    const [subject, metric] = s.feature.split(".");
    const view = SERVICES.includes(subject as Service) ? services[subject as Service] : undefined;
    return s.value !== null && view?.latest[metric as keyof typeof view.latest] != null;
  });
  if (!signal) return null;
  const [subject, metric] = signal.feature.split(".");
  const view = services[subject as Service];
  const now = view.latest[metric as keyof typeof view.latest] as number;
  return (
    <section className="recovery" aria-label="Then and now">
      <h2>Then and now</h2>
      <p className="recovery-name">{signalName(signal.feature)}</p>
      <div className="recovery-values">
        <span>
          <small>At the alert</small>
          <b className="num tone-then">{formatValue(signal.feature, signal.value)}</b>
        </span>
        <span className="recovery-arrow" aria-hidden="true" />
        <span>
          <small>Now</small>
          <b className="num tone-now">{formatValue(signal.feature, now)}</b>
        </span>
      </div>
      <Sparkline values={view.series[metric] ?? []} tone="aurora" width={320} height={52} />
      <p className="recovery-note">
        Usually {formatValue(signal.feature, signal.usual)}. The line is the last ten minutes.
      </p>
    </section>
  );
}
