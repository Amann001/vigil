import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { api, ApiError, getToken } from "../lib/api";
import { diagnosisOf } from "../lib/state";
import { SERVICES, type Investigation, type Service } from "../lib/types";
import { headline, outcomeName, proposalName, serviceName } from "../lib/words";
import { TokenField } from "./TokenField";
import "./decision.css";

type Choice = "approve" | "instead" | "reject";

/**
 * The human in the loop. Two questions, in the order an on-call engineer would ask them: is the
 * diagnosis right, and what should happen now. Nothing changes until the decision is sent, and
 * whatever is chosen still goes through the guardrails.
 */
export function Decision({ investigation, mode }: { investigation: Investigation; mode: "live" | "demo" | "unknown" }) {
  const d = diagnosisOf(investigation);
  const proposal = investigation.proposal;
  const proposedRestart = proposal?.action === "restart_service";
  const [verdict, setVerdict] = useState<"confirmed" | "corrected" | null>(null);
  const [notes, setNotes] = useState("");
  const [choice, setChoice] = useState<Choice>(proposal ? "approve" : "reject");
  const [instead, setInstead] = useState<Service>(
    (SERVICES.find((s) => s === d?.root_cause_service) as Service | undefined) ?? "payments",
  );
  const [state, setState] = useState<{ kind: "idle" | "sending" | "sent" | "error"; message?: string }>({ kind: "idle" });
  const [hasToken, setHasToken] = useState(mode === "demo" || Boolean(getToken()));

  if (investigation.status === "investigating") {
    return (
      <section className="decision is-waiting">
        <h2>Your decision</h2>
        <p className="decision-wait">
          The agents are still investigating. When they have a diagnosis and a proposed fix, you decide here.
        </p>
      </section>
    );
  }

  if (investigation.status !== "awaiting review" || state.kind === "sent") {
    return <Decided investigation={investigation} queued={state.kind === "sent" && investigation.status === "awaiting review"} />;
  }

  const action =
    choice === "approve"
      ? proposedRestart
        ? proposalName(proposal!)
        : proposal?.action === "escalate"
          ? "Escalate to a human expert"
          : "Close it, change nothing"
      : choice === "instead"
        ? `Restart ${serviceName[instead]} instead`
        : "Reject the fix";
  const ready = verdict !== null && (verdict === "confirmed" || notes.trim().length > 0) && hasToken;

  async function send() {
    setState({ kind: "sending" });
    try {
      await api.review(investigation.id, {
        verdict: verdict!,
        notes: notes.trim(),
        approve: choice === "approve",
        restart: choice === "instead" ? instead : null,
        by: "war room",
      });
      setState({ kind: "sent" });
    } catch (e) {
      const error = e as ApiError;
      if (error.status === 401) setHasToken(false);
      setState({ kind: "error", message: error.message });
    }
  }

  return (
    <section className="decision">
      <h2>Your decision</h2>

      <fieldset className="question-block">
        <legend>
          <span className="q-number num">1</span> Is the diagnosis right?
        </legend>
        <p className="question-context">{d ? `${headline(d)}, with ${d.confidence} confidence.` : "No diagnosis."}</p>
        <div className="segmented">
          <button aria-pressed={verdict === "confirmed"} onClick={() => setVerdict("confirmed")}>
            Yes, that's it
          </button>
          <button aria-pressed={verdict === "corrected"} onClick={() => setVerdict("corrected")}>
            No, it's wrong
          </button>
        </div>
        <AnimatePresence>
          {verdict === "corrected" && (
            <motion.label
              className="notes"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
            >
              <span>What really happened? Vigil remembers your correction for next time.</span>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Payments itself is slow; there is no outside gateway." />
            </motion.label>
          )}
        </AnimatePresence>
      </fieldset>

      <fieldset className="question-block">
        <legend>
          <span className="q-number num">2</span> What should happen?
        </legend>
        <div className="options">
          {proposal && (
            <button className="option" aria-pressed={choice === "approve"} onClick={() => setChoice("approve")}>
              <strong>{proposalName(proposal)}</strong>
              <span>As proposed.{proposal.runbook ? ` Follows the ${proposal.runbook.replace(/-/g, " ")} runbook.` : ""}</span>
            </button>
          )}
          <div className={`option option-instead ${choice === "instead" ? "is-on" : ""}`}>
            <button className="option-hit" aria-pressed={choice === "instead"} onClick={() => setChoice("instead")}>
              <strong>Restart another service</strong>
              <span>When the cause is right but the fix is not, or the cause is elsewhere.</span>
            </button>
            {choice === "instead" && (
              <div className="choice-row" role="group" aria-label="Service to restart">
                {SERVICES.map((s) => (
                  <button key={s} className="chip" aria-pressed={instead === s} onClick={() => setInstead(s)}>
                    {serviceName[s]}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="option" aria-pressed={choice === "reject"} onClick={() => setChoice("reject")}>
            <strong>Change nothing</strong>
            <span>Reject the proposal. The incident is still recorded.</span>
          </button>
        </div>
      </fieldset>

      {!hasToken && <TokenField onSaved={() => setHasToken(true)} />}

      <button className={`button button-primary decision-send ${choice === "reject" ? "is-quiet" : ""}`} disabled={!ready || state.kind === "sending"} onClick={send}>
        {state.kind === "sending" ? "Sending…" : action}
      </button>
      <p className="guardrail-note">
        {verdict === null
          ? "Answer both questions to continue."
          : "A worker carries it out. Restarts are limited to one per service every 15 minutes, and every decision is written to the audit log."}
      </p>
      {state.kind === "error" && (
        <p className="decision-error" role="alert">
          {state.message}
        </p>
      )}
    </section>
  );
}

function Decided({ investigation, queued }: { investigation: Investigation; queued: boolean }) {
  const review = investigation.review;
  const action = investigation.action;
  if (queued || investigation.status === "acting") {
    return (
      <section className="decision is-done">
        <h2>Decision sent</h2>
        <p className="decision-wait">A worker is carrying it out. This page updates when it is done.</p>
        <span className="thinking" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </section>
    );
  }
  if (investigation.status === "failed") {
    return (
      <section className="decision">
        <h2>Investigation stopped</h2>
        <p className="decision-wait">The agents could not finish, usually because every model's free quota ran out. The job is retried automatically.</p>
      </section>
    );
  }
  const fixed = action?.outcome === "executed";
  return (
    <section className={`decision is-done ${fixed ? "is-fixed" : ""}`}>
      <h2>{outcomeName(action?.outcome, action?.dry_run) || "Decided"}</h2>
      <dl className="decided">
        {review && (
          <>
            <dt>Diagnosis</dt>
            <dd>{review.verdict === "confirmed" ? "Confirmed right" : "Corrected"}{review.notes ? `: ${review.notes}` : ""}</dd>
            <dt>Decided by</dt>
            <dd>
              {review.by}, {new Date(review.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
            </dd>
          </>
        )}
        {action && (
          <>
            <dt>What happened</dt>
            <dd>
              {action.action === "restart_service" && action.service
                ? `Restart ${serviceName[action.service]}${action.chosen_by_reviewer ? ", chosen by the reviewer" : ""}${action.dry_run ? " (rehearsed: a replayed incident)" : ""}`
                : action.action === "escalate"
                  ? "Escalated to a human expert"
                  : "No change"}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
