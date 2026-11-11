import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { RisingText } from "../components/Bits";
import { api } from "../lib/api";
import { href } from "../lib/route";
import { diagnosisOf } from "../lib/state";
import { PARTS, type Part, type PartId, STAGES } from "../lib/team";
import type { Investigation, InvestigationSummary } from "../lib/types";
import { agentName, formatValue, outcomeName, proposalName, signalName, toolName } from "../lib/words";
import "./how.css";

/*
  The agent team as a pipeline you can explore. What each part does is fixed; the models, the
  tools and the quotes come from the most recent finished incident, so they are what really ran.
*/

function plain(markdown: string, max = 260): string {
  const text = markdown
    .replace(/[#*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s\S*$/, "")}…` : text;
}

/** What a part said or did in a real investigation, in a sentence or two. */
function evidence(part: PartId, inv: Investigation | null): string | null {
  if (!inv) return null;
  const finding = (agent: string) => inv.findings?.find((f) => f.agent === agent);
  switch (part) {
    case "detector": {
      const top = inv.signals?.slice(0, 2) ?? [];
      return top.length
        ? `Raised the alert on ${top.map((s) => `${signalName(s.feature).toLowerCase()} at ${formatValue(s.feature, s.value)} (usually ${formatValue(s.feature, s.usual)})`).join(" and ")}.`
        : null;
    }
    case "supervisor": {
      const plan = inv.timeline?.find((e) => e.step === "plan");
      const question = (plan?.step === "plan" ? plan.tasks[0]?.question : undefined) ?? inv.findings?.[0]?.question;
      return question ? `Asked the ${agentName[inv.findings?.[0]?.agent ?? ""]?.toLowerCase() ?? "first"} agent: "${question}"` : null;
    }
    case "logs":
    case "metrics":
    case "deploy": {
      const f = finding(part);
      return f ? `Found: ${plain(f.report)}` : null;
    }
    case "diagnosis": {
      const d = diagnosisOf(inv);
      return d ? `${d.summary} (${d.confidence} confidence)` : null;
    }
    case "memory":
      return inv.recalled?.length
        ? `Recalled ${inv.recalled.map((r) => (r.startsWith("live-") || r.startsWith("replay-") ? "an earlier incident" : `the "${r.replace(/-/g, " ")}" runbook`)).filter((v, i, all) => all.indexOf(v) === i).join(", ")}.`
        : null;
    case "remediation":
      return inv.proposal ? `Proposed: ${proposalName(inv.proposal)}. ${plain(inv.proposal.rationale, 200)}` : null;
    case "you":
      return inv.review
        ? `${inv.review.verdict === "confirmed" ? "Confirmed the diagnosis" : "Corrected the diagnosis"} and ${inv.review.approve ? "approved the fix" : inv.review.instead ? "chose a different fix" : "rejected the fix"}.`
        : null;
    case "guardrails":
      return inv.action ? `${outcomeName(inv.action.outcome, inv.action.dry_run)}.${inv.action.reasons?.length ? ` ${inv.action.reasons.join(" ")}` : ""}` : null;
    case "comms":
      return inv.incident_report ? plain(inv.incident_report) : null;
  }
}

function modelsOf(part: Part, inv: Investigation | null): string {
  if (part.fixedModel) return part.fixedModel;
  const used = (inv?.models ?? [])
    .filter((m) => m.split(": ")[0] === part.role)
    .map((m) => m.split(": ")[1].split("/").pop());
  return used.length ? [...new Set(used)].join(", ") : "Gemini or Groq, with fallbacks";
}

function toolsOf(part: Part, inv: Investigation | null): string | null {
  const calls = (inv?.findings ?? []).filter((f) => f.agent === part.role).flatMap((f) => f.tool_calls.map((c) => c.name));
  if (!calls.length) return null;
  return [...new Set(calls)].map((t) => toolName[t] ?? t).join(", ");
}

export function HowItWorks({ list }: { list: InvestigationSummary[] | null }) {
  const [chosen, setChosen] = useState<PartId>("supervisor");
  const [latest, setLatest] = useState<Investigation | null>(null);
  const finished = (list ?? []).find((i) => i.id.startsWith("live-") && (i.status === "confirmed" || i.status === "corrected") && i.outcome === "executed");

  useEffect(() => {
    if (!finished) return;
    let gone = false;
    api.investigation(finished.id).then((inv) => !gone && setLatest(inv), () => {});
    return () => {
      gone = true;
    };
  }, [finished?.id]);

  const part = PARTS[chosen];
  const said = evidence(chosen, latest);
  const tools = toolsOf(part, latest);

  return (
    <main className="how">
      <header className="how-head">
        <h1>
          <RisingText text="A team, not a chatbot." />
        </h1>
        <p className="how-lede">
          Each part of Vigil does one job, and the language models never touch the shop directly. Choose a part to see what it
          does, what runs it and what it said in the last real incident.
        </p>
      </header>

      <div className="how-body">
      <div className="pipeline" role="tablist" aria-label="The parts of Vigil">
        {STAGES.map((stage, s) => (
          <section key={stage.title} className="stage">
            <h2>
              <span className="stage-number num">{s + 1}</span>
              {stage.title}
            </h2>
            <div className="stage-parts">
              {stage.parts.map((id) => (
                <button
                  key={id}
                  role="tab"
                  data-part={id}
                  aria-selected={chosen === id}
                  className={`part part-${PARTS[id].kind}`}
                  onClick={() => setChosen(id)}
                  onMouseEnter={() => setChosen(id)}
                >
                  <span className={`part-dot agent-dot agent-${PARTS[id].role ?? id}`} aria-hidden="true" />
                  {PARTS[id].name}
                </button>
              ))}
            </div>
            {s < STAGES.length - 1 && (
              <span className="stage-flow" aria-hidden="true">
                <i />
              </span>
            )}
          </section>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.article
          key={chosen}
          className="part-detail"
          role="tabpanel"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <h2>{part.name}</h2>
          <p className="part-does">{part.does}</p>
          <dl>
            <div>
              <dt>Runs on</dt>
              <dd>{modelsOf(part, latest)}</dd>
            </div>
            {tools && (
              <div>
                <dt>Tools it used</dt>
                <dd>{tools}</dd>
              </div>
            )}
          </dl>
          {said && (
            <blockquote className="part-said">
              <span>In the last incident</span>
              {said}
            </blockquote>
          )}
          {finished && (
            <a className="link-button" href={href({ page: "incident", id: finished.id })}>
              Open that incident
            </a>
          )}
        </motion.article>
      </AnimatePresence>
      </div>

      <p className="how-foot">
        Every step is checkpointed in Postgres, so a crashed worker's investigation is picked up by another. Each model call
        and tool call is traced in Langfuse.
      </p>
    </main>
  );
}
