import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { api, getToken } from "../lib/api";
import { diagnosisOf } from "../lib/state";
import { SERVICES } from "../lib/types";
import { headline, outcomeName, proposalName, serviceName } from "../lib/words";
import { TokenField } from "./TokenField";
import "./decision.css";
/**
 * The human in the loop. Two questions, in the order an on-call engineer would ask them: is the
 * diagnosis right, and what should happen now. Nothing changes until the decision is sent, and
 * whatever is chosen still goes through the guardrails.
 */
export function Decision({ investigation, mode }) {
    const d = diagnosisOf(investigation);
    const proposal = investigation.proposal;
    const proposedRestart = proposal?.action === "restart_service";
    const [verdict, setVerdict] = useState(null);
    const [notes, setNotes] = useState("");
    const [choice, setChoice] = useState(proposal ? "approve" : "reject");
    const [instead, setInstead] = useState(SERVICES.find((s) => s === d?.root_cause_service) ?? "payments");
    const [state, setState] = useState({ kind: "idle" });
    const [hasToken, setHasToken] = useState(mode === "demo" || Boolean(getToken()));
    if (investigation.status === "investigating") {
        return (_jsxs("section", { className: "decision is-waiting", children: [_jsx("h2", { children: "Your decision" }), _jsx("p", { className: "decision-wait", children: "The agents are still investigating. When they have a diagnosis and a proposed fix, you decide here." })] }));
    }
    if (investigation.status !== "awaiting review" || state.kind === "sent") {
        return _jsx(Decided, { investigation: investigation, queued: state.kind === "sent" && investigation.status === "awaiting review" });
    }
    const action = choice === "approve"
        ? proposedRestart
            ? proposalName(proposal)
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
                verdict: verdict,
                notes: notes.trim(),
                approve: choice === "approve",
                restart: choice === "instead" ? instead : null,
                by: "war room",
            });
            setState({ kind: "sent" });
        }
        catch (e) {
            const error = e;
            if (error.status === 401)
                setHasToken(false);
            setState({ kind: "error", message: error.message });
        }
    }
    return (_jsxs("section", { className: "decision", children: [_jsx("h2", { children: "Your decision" }), _jsxs("fieldset", { className: "question-block", children: [_jsxs("legend", { children: [_jsx("span", { className: "q-number num", children: "1" }), " Is the diagnosis right?"] }), _jsx("p", { className: "question-context", children: d ? `${headline(d)}, with ${d.confidence} confidence.` : "No diagnosis." }), _jsxs("div", { className: "segmented", children: [_jsx("button", { "aria-pressed": verdict === "confirmed", onClick: () => setVerdict("confirmed"), children: "Yes, that's it" }), _jsx("button", { "aria-pressed": verdict === "corrected", onClick: () => setVerdict("corrected"), children: "No, it's wrong" })] }), _jsx(AnimatePresence, { children: verdict === "corrected" && (_jsxs(motion.label, { className: "notes", initial: { height: 0, opacity: 0 }, animate: { height: "auto", opacity: 1 }, exit: { height: 0, opacity: 0 }, children: [_jsx("span", { children: "What really happened? Vigil remembers your correction for next time." }), _jsx("textarea", { value: notes, onChange: (e) => setNotes(e.target.value), rows: 3, placeholder: "Payments itself is slow; there is no outside gateway." })] })) })] }), _jsxs("fieldset", { className: "question-block", children: [_jsxs("legend", { children: [_jsx("span", { className: "q-number num", children: "2" }), " What should happen?"] }), _jsxs("div", { className: "options", children: [proposal && (_jsxs("button", { className: "option", "aria-pressed": choice === "approve", onClick: () => setChoice("approve"), children: [_jsx("strong", { children: proposalName(proposal) }), _jsxs("span", { children: ["As proposed.", proposal.runbook ? ` Follows the ${proposal.runbook.replace(/-/g, " ")} runbook.` : ""] })] })), _jsxs("div", { className: `option option-instead ${choice === "instead" ? "is-on" : ""}`, children: [_jsxs("button", { className: "option-hit", "aria-pressed": choice === "instead", onClick: () => setChoice("instead"), children: [_jsx("strong", { children: "Restart another service" }), _jsx("span", { children: "When the cause is right but the fix is not, or the cause is elsewhere." })] }), choice === "instead" && (_jsx("div", { className: "choice-row", role: "group", "aria-label": "Service to restart", children: SERVICES.map((s) => (_jsx("button", { className: "chip", "aria-pressed": instead === s, onClick: () => setInstead(s), children: serviceName[s] }, s))) }))] }), _jsxs("button", { className: "option", "aria-pressed": choice === "reject", onClick: () => setChoice("reject"), children: [_jsx("strong", { children: "Change nothing" }), _jsx("span", { children: "Reject the proposal. The incident is still recorded." })] })] })] }), !hasToken && _jsx(TokenField, { onSaved: () => setHasToken(true) }), _jsx("button", { className: `button button-primary decision-send ${choice === "reject" ? "is-quiet" : ""}`, disabled: !ready || state.kind === "sending", onClick: send, children: state.kind === "sending" ? "Sending…" : action }), _jsx("p", { className: "guardrail-note", children: mode === "demo"
                    ? "This is a replay: your decision is not sent anywhere. The recording goes on with what the real reviewer decided."
                    : verdict === null
                        ? "Answer both questions to continue."
                        : "A worker carries it out. Restarts are limited to one per service every 15 minutes, and every decision is written to the audit log." }), state.kind === "error" && (_jsx("p", { className: "decision-error", role: "alert", children: state.message }))] }));
}
function Decided({ investigation, queued }) {
    const review = investigation.review;
    const action = investigation.action;
    if (queued || investigation.status === "acting") {
        return (_jsxs("section", { className: "decision is-done", children: [_jsx("h2", { children: "Decision sent" }), _jsx("p", { className: "decision-wait", children: "A worker is carrying it out. This page updates when it is done." }), _jsxs("span", { className: "thinking", "aria-hidden": "true", children: [_jsx("i", {}), _jsx("i", {}), _jsx("i", {})] })] }));
    }
    if (investigation.status === "failed") {
        return (_jsxs("section", { className: "decision", children: [_jsx("h2", { children: "Investigation stopped" }), _jsx("p", { className: "decision-wait", children: "The agents could not finish, usually because every model's free quota ran out. The job is retried automatically." })] }));
    }
    const fixed = action?.outcome === "executed";
    return (_jsxs("section", { className: `decision is-done ${fixed ? "is-fixed" : ""}`, children: [_jsx("h2", { children: outcomeName(action?.outcome, action?.dry_run) || "Decided" }), _jsxs("dl", { className: "decided", children: [review && (_jsxs(_Fragment, { children: [_jsx("dt", { children: "Diagnosis" }), _jsxs("dd", { children: [review.verdict === "confirmed" ? "Confirmed right" : "Corrected", review.notes ? `: ${review.notes}` : ""] }), _jsx("dt", { children: "Decided by" }), _jsxs("dd", { children: [review.by, ", ", new Date(review.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })] })] })), action && (_jsxs(_Fragment, { children: [_jsx("dt", { children: "What happened" }), _jsx("dd", { children: action.action === "restart_service" && action.service
                                    ? `Restart ${serviceName[action.service]}${action.chosen_by_reviewer ? ", chosen by the reviewer" : ""}${action.dry_run ? " (rehearsed: a replayed incident)" : ""}`
                                    : action.action === "escalate"
                                        ? "Escalated to a human expert"
                                        : "No change" })] }))] })] }));
}
