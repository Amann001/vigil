import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Panel, RisingText, Sparkline } from "../components/Bits";
import { Decision } from "../components/Decision";
import { Markdown } from "../components/Markdown";
import { buildLog, STAGES, stageReached } from "../lib/log";
import { href } from "../lib/route";
import { diagnosisOf, serviceOf } from "../lib/state";
import { SERVICES } from "../lib/types";
import { agentName, agentRole, clock, formatValue, headline, outcomeName, proposalName, serviceName, signalName, signalService, statusName, toolName, } from "../lib/words";
import "./incident.css";
function offset(at, start) {
    if (!at || !start)
        return null;
    const s = Math.max(0, Math.round((new Date(at).getTime() - new Date(start).getTime()) / 1000));
    return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** How far a reading is from usual, in words: "6.6× usual", "half of usual". */
export function ratioWords(value, usual) {
    if (usual <= 0)
        return value > 0 ? "usually none" : "as usual";
    const r = value / usual;
    if (r >= 1.15)
        return `${r < 10 ? r.toFixed(1) : Math.round(r)}× usual`;
    if (r <= 0.87)
        return `${Math.round(r * 100)}% of usual`;
    return "about usual";
}
/** Where a reading sits on a log scale centred on its usual value: 1/16× at the left edge,
 *  16× at the right. Logarithmic, so "twice as slow" and "half as fast" look equally far. */
function meterPosition(value, usual) {
    if (usual <= 0)
        return value > 0 ? 1 : 0.5;
    return Math.min(1, Math.max(0, 0.5 + Math.log2(Math.max(value, 1e-9) / usual) / 8));
}
function pointAt(point, service) {
    return {
        onMouseEnter: () => point?.(SERVICES.includes(service) ? service : null),
        onMouseLeave: () => point?.(null),
    };
}
function SignalRow({ signal, point }) {
    const at = signal.value === null ? 0 : meterPosition(signal.value, signal.usual);
    return (_jsxs("li", { className: "signal", ...pointAt(point, signalService(signal.feature)), children: [_jsx("span", { className: "signal-name", children: signalName(signal.feature) }), _jsxs("span", { className: "signal-value num", children: [signal.value === null ? "stopped reporting" : formatValue(signal.feature, signal.value), _jsxs("span", { className: "signal-usual", children: [" usually ", formatValue(signal.feature, signal.usual)] })] }), _jsxs("span", { className: "meter", "aria-hidden": "true", children: [_jsx("span", { className: `meter-fill${at < 0.5 ? " is-below" : ""}`, style: { left: `${Math.min(at, 0.5) * 100}%`, width: `${Math.abs(at - 0.5) * 100}%` } }), _jsx("span", { className: "meter-usual" })] }), _jsx("span", { className: "signal-ratio num", children: signal.value === null ? "no data" : ratioWords(signal.value, signal.usual) })] }));
}
function Report({ text }) {
    const [open, setOpen] = useState(false);
    const long = text.length > 420;
    return (_jsxs("div", { className: `finding-report ${open || !long ? "is-open" : ""}`, children: [_jsx(Markdown, { text: text }), long && (_jsx("button", { className: "link-button", onClick: () => setOpen(!open), "aria-expanded": open, children: open ? "Show less" : "Read the whole answer" }))] }));
}
function Item({ item, start, point }) {
    const time = offset(item.at, start);
    const head = (who, what, tone = "") => (_jsxs("header", { className: `item-head ${tone}`, children: [_jsx("span", { className: "item-who", children: who }), _jsx("span", { className: "item-what", children: what }), time && _jsx("span", { className: "item-time num", children: time })] }));
    switch (item.kind) {
        case "alert":
            return (_jsxs(_Fragment, { children: [head("Detector", "raised an alert", "tone-sodium"), _jsx("p", { className: "item-lead", children: "These signals moved furthest from normal:" }), _jsx("ul", { className: "signals", children: item.signals.slice(0, 4).map((s) => (_jsx(SignalRow, { signal: s, point: point }, s.feature))) })] }));
        case "plan":
            return (_jsxs(_Fragment, { children: [head("Supervisor", item.round > 1 ? `wants more evidence, round ${item.round}` : "split the investigation"), _jsx("ul", { className: "questions", children: item.tasks.map((t) => (_jsxs("li", { children: [_jsx("span", { className: `agent-dot agent-${t.agent}`, "aria-hidden": "true" }), _jsxs("span", { children: [_jsx("strong", { children: agentName[t.agent] ?? t.agent }), ", ", t.question] })] }, t.agent))) })] }));
        case "finding":
            return (_jsxs(_Fragment, { children: [head(`${agentName[item.agent] ?? item.agent} agent`, "reported back"), _jsx("blockquote", { className: "question", children: item.question }), item.tools.length > 0 && (_jsx("p", { className: "tools", "aria-label": "Tools it used", children: [...new Set(item.tools)].map((t) => (_jsxs("span", { className: "tool", children: [toolName[t] ?? t, item.tools.filter((x) => x === t).length > 1 && (_jsxs("span", { className: "num", children: [" \u00D7", item.tools.filter((x) => x === t).length] }))] }, t))) })), _jsx(Report, { text: item.report })] }));
        case "diagnosis":
            return (_jsxs(_Fragment, { children: [head("Supervisor", "diagnosed the cause", "tone-strong"), _jsx("h3", { className: "diagnosis-title", ...pointAt(point, item.diagnosis.root_cause_service), children: headline(item.diagnosis) }), _jsx("p", { className: "diagnosis-summary", children: item.diagnosis.summary }), _jsx("ul", { className: "evidence", children: item.diagnosis.evidence.map((e, i) => (_jsx("li", { children: e }, i))) }), _jsxs("p", { className: `confidence confidence-${item.diagnosis.confidence}`, children: [_jsxs("span", { className: "confidence-bars", "aria-hidden": "true", children: [_jsx("i", {}), _jsx("i", {}), _jsx("i", {})] }), item.diagnosis.confidence[0].toUpperCase() + item.diagnosis.confidence.slice(1), " confidence"] })] }));
        case "recall":
            return (_jsxs(_Fragment, { children: [head("Memory", "recalled what helped before"), _jsx("p", { className: "recalled", children: item.recalled.map((r) => (_jsx("span", { className: `memory ${r.startsWith("live-") || r.startsWith("replay-") ? "is-incident" : ""}`, children: r.startsWith("live-") || r.startsWith("replay-") ? `Incident ${r}` : `Runbook: ${r.replace(/-/g, " ")}` }, r))) })] }));
        case "proposal":
            return (_jsxs(_Fragment, { children: [head("Remediation agent", "proposed a fix"), _jsx("h3", { className: "proposal-title", ...pointAt(point, item.proposal.service), children: proposalName(item.proposal) }), _jsx("p", { className: "item-body", children: item.proposal.rationale }), item.proposal.cited_incidents.length > 0 && (_jsxs("p", { className: "item-note", children: ["Based on ", item.proposal.cited_incidents.join(", "), "."] }))] }));
        case "waiting":
            return (_jsxs(_Fragment, { children: [head("Vigil", "is waiting for you", "tone-sodium"), _jsx("p", { className: "item-body", children: "Nothing changes until a person decides." })] }));
        case "decision":
            return (_jsxs(_Fragment, { children: [head(item.review.by, item.review.verdict === "confirmed" ? "confirmed the diagnosis" : "corrected the diagnosis"), item.review.notes && _jsx("blockquote", { className: "question", children: item.review.notes }), _jsx("p", { className: "item-body", children: item.review.instead
                            ? `Chose instead: restart ${serviceName[item.review.instead.service]}.`
                            : item.review.approve
                                ? "Approved the proposed fix."
                                : "Rejected the proposed fix." })] }));
        case "action": {
            const a = item.action;
            const ok = a.outcome === "executed";
            return (_jsxs(_Fragment, { children: [head("Guardrails", outcomeName(a.outcome, a.dry_run).toLowerCase(), ok ? "tone-aurora" : ""), _jsxs("p", { className: "item-body", children: [a.action === "restart_service" && a.service
                                ? ok
                                    ? a.dry_run
                                        ? `A replayed incident, so ${serviceName[a.service]} was not really restarted.`
                                        : `${serviceName[a.service]} restarted${a.result?.seconds ? ` and was ready in ${a.result.seconds} s` : ""}.`
                                    : `${serviceName[a.service]} was not restarted.`
                                : "No change was made to the shop.", a.reasons?.length ? ` ${a.reasons.join(" ")}` : ""] })] }));
        }
        case "report":
            return (_jsxs(_Fragment, { children: [head("Comms agent", "wrote the incident report"), item.markdown ? _jsx(Markdown, { text: item.markdown, className: "incident-report" }) : null] }));
    }
}
function Route({ reached, running }) {
    return (_jsx("ol", { className: "route", "aria-label": "Investigation progress", children: STAGES.map((stage, i) => (_jsxs("li", { className: i < reached ? "is-done" : i === reached ? (running ? "is-now is-running" : "is-now") : "", "aria-current": i === reached ? "step" : undefined, children: [_jsx("span", { className: "route-dot", "aria-hidden": "true" }), _jsx("span", { className: "route-label", children: stage.label })] }, stage.id))) }));
}
export function Incident({ id, investigation, mode, system, onPoint, }) {
    const logRef = useRef(null);
    const items = investigation ? buildLog(investigation) : [];
    const running = investigation?.status === "investigating" || investigation?.status === "acting";
    const count = items.length;
    // Follow a running investigation: keep its newest step in view.
    useEffect(() => {
        if (running)
            logRef.current?.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, [count, running]);
    const d = diagnosisOf(investigation);
    const service = serviceOf(investigation);
    const title = d ? headline(d) : service ? `Looking at ${serviceName[service]}` : "Investigating";
    const start = investigation?.started_at ?? investigation?.timeline?.[0]?.at;
    return (_jsxs("main", { className: "incident", children: [_jsxs(Panel, { className: "story", label: "What happened", children: [_jsx("a", { className: "back", href: href({ page: "history" }), children: "All incidents" }), !investigation ? (_jsxs("p", { className: "loading", children: ["Opening ", id, "\u2026"] })) : (_jsxs(_Fragment, { children: [_jsxs("header", { className: "story-head", children: [_jsx("p", { className: `status-chip chip-${investigation.status.replace(" ", "-")}`, children: statusName[investigation.status] }), _jsx("h1", { className: "story-title", children: _jsx(RisingText, { text: `${title}.` }, title) }), _jsxs("p", { className: "story-meta", children: ["Alert at ", clock(investigation.alert_at), investigation.seconds ? `, diagnosed in ${Math.round(investigation.seconds)} s` : "", investigation.action?.outcome ? `. ${outcomeName(investigation.action.outcome, investigation.action.dry_run)}.` : "."] })] }), _jsx(Route, { reached: stageReached(items, investigation.status), running: running }), _jsxs("ol", { className: "log", ref: logRef, children: [_jsx(AnimatePresence, { initial: false, children: items.map((item, i) => (_jsx(motion.li, { className: `log-item item-${item.kind}`, initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: running ? 0 : Math.min(i * 0.05, 0.5) }, children: _jsx(Item, { item: item, start: start, point: onPoint }) }, `${item.kind}-${i}`))) }), running && (_jsxs("li", { className: "log-item item-thinking", "aria-live": "polite", children: [_jsxs("span", { className: "thinking", "aria-hidden": "true", children: [_jsx("i", {}), _jsx("i", {}), _jsx("i", {})] }), "Agents at work"] }))] })] }))] }), investigation && (_jsxs(Panel, { as: "aside", className: "dock", delay: 0.25, label: "Your decision", children: [_jsx(Decision, { investigation: investigation, mode: mode }, investigation.status), _jsx(Recovery, { investigation: investigation, system: system }), _jsx(Team, { investigation: investigation })] }))] }));
}
function Team({ investigation }) {
    const models = [...new Set(investigation.models ?? [])];
    if (!models.length)
        return null;
    const byRole = new Map();
    for (const m of models) {
        const [role, model] = m.split(": ");
        byRole.set(role, [...(byRole.get(role) ?? []), model.split("/").pop() ?? model]);
    }
    return (_jsxs("section", { className: "team", children: [_jsx("h2", { children: "Who worked on it" }), _jsx("ul", { children: [...byRole].map(([role, used]) => (_jsxs("li", { children: [_jsx("span", { className: `agent-dot agent-${role}`, "aria-hidden": "true" }), _jsx("span", { className: "team-role", title: agentRole[role], children: agentName[role] ?? role }), _jsx("span", { className: "team-model", children: [...new Set(used)].join(", ") })] }, role))) })] }));
}
/**
 * After a fix: the signal that raised the alarm, as it was then and as it is now, with its
 * last ten minutes. The proof that the restart worked, in one glance.
 */
function Recovery({ investigation, system }) {
    const action = investigation.action;
    if (action?.outcome !== "executed" || action.dry_run || !system?.services)
        return null;
    const services = system.services;
    const signal = (investigation.signals ?? []).find((s) => {
        const [subject, metric] = s.feature.split(".");
        const view = SERVICES.includes(subject) ? services[subject] : undefined;
        return s.value !== null && view?.latest[metric] != null;
    });
    if (!signal)
        return null;
    const [subject, metric] = signal.feature.split(".");
    const view = services[subject];
    const now = view.latest[metric];
    return (_jsxs("section", { className: "recovery", "aria-label": "Then and now", children: [_jsx("h2", { children: "Then and now" }), _jsx("p", { className: "recovery-name", children: signalName(signal.feature) }), _jsxs("div", { className: "recovery-values", children: [_jsxs("span", { children: [_jsx("small", { children: "At the alert" }), _jsx("b", { className: "num tone-then", children: formatValue(signal.feature, signal.value) })] }), _jsx("span", { className: "recovery-arrow", "aria-hidden": "true" }), _jsxs("span", { children: [_jsx("small", { children: "Now" }), _jsx("b", { className: "num tone-now", children: formatValue(signal.feature, now) })] })] }), _jsx(Sparkline, { values: view.series[metric] ?? [], tone: "aurora", width: 320, height: 52 }), _jsxs("p", { className: "recovery-note", children: ["Usually ", formatValue(signal.feature, signal.usual), ". The line is the last ten minutes."] })] }));
}
