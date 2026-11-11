import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Panel, RisingText, Sparkline } from "../components/Bits";
import { BreakSomething } from "../components/BreakSomething";
import { now } from "../lib/clock";
import { href } from "../lib/route";
import { diagnosisOf, eventsOf, serviceOf } from "../lib/state";
import { SERVICES } from "../lib/types";
import { ago, duration, formatValue, headline, outcomeName, proposalName, serviceName, serviceRole, statusName, } from "../lib/words";
import "./watch.css";
function useHeadline(s, system) {
    if (s.kind === "investigating" && s.running) {
        const d = diagnosisOf(s.running);
        const service = serviceOf(s.running);
        const started = s.running.started_at ?? s.running.alert_at;
        const seconds = (now() - new Date(started).getTime()) / 1000;
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
            line: s.pending.length > 1
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
function Inbox({ situation, list }) {
    const running = situation.running;
    const last = (list ?? []).find((i) => i.status !== "investigating");
    return (_jsxs(Panel, { as: "aside", className: "inbox", delay: 0.35, label: "Incidents needing attention", children: [situation.runningAll.map((inv) => {
                const steps = eventsOf(inv).length;
                const service = serviceOf(inv);
                return (_jsxs("a", { className: "inbox-row is-running", href: href({ page: "incident", id: inv.id }), children: [_jsx("span", { className: "pulse", "aria-hidden": "true" }), _jsxs("span", { className: "inbox-text", children: [_jsx("strong", { children: "Investigating now" }), _jsxs("span", { children: [steps, " ", steps === 1 ? "step" : "steps", " so far", service ? `, looking at ${serviceName[service]}` : ""] })] }), _jsx("span", { className: "inbox-go", children: "Watch" })] }, inv.id));
            }), [...situation.pending, ...situation.replays].map((item) => (_jsxs("a", { className: "inbox-row is-pending", href: href({ page: "incident", id: item.id }), children: [_jsx("span", { className: "dot dot-sodium", "aria-hidden": "true" }), _jsxs("span", { className: "inbox-text", children: [_jsx("strong", { children: item.root_cause_service && item.category
                                    ? headline({ root_cause_service: item.root_cause_service, category: item.category })
                                    : "Incident" }), _jsxs("span", { children: ["Proposed: ", item.proposal ? proposalName(item.proposal).toLowerCase() : "no fix", ".", " ", item.id.startsWith("live-") ? ago(item.alert_at) : "Replayed from a recording", "."] })] }), _jsx("span", { className: "inbox-go", children: "Decide" })] }, item.id))), !running && situation.pending.length + situation.replays.length === 0 && (_jsxs("div", { className: "inbox-empty", children: [_jsx("strong", { children: "Nothing needs you." }), last ? (_jsxs("span", { children: ["Last incident ", ago(last.alert_at), ":", " ", _jsx("a", { href: href({ page: "incident", id: last.id }), children: last.root_cause_service && last.category
                                    ? headline({ root_cause_service: last.root_cause_service, category: last.category }).toLowerCase()
                                    : "see it" }), ", ", (outcomeName(last.outcome) || statusName[last.status]).toLowerCase(), "."] })) : (_jsx("span", { children: "No incidents yet. Break something to see Vigil work." }))] }))] }));
}
const VITALS = [
    { key: "latency_p95", label: "Response time, p95" },
    { key: "error_ratio", label: "Requests failing" },
    { key: "memory_mb", label: "Memory" },
    { key: "request_rate", label: "Requests" },
];
function Vitals({ service, system, tone }) {
    const view = system?.services?.[service];
    const down = Boolean(system?.online && view && view.latest.up === null);
    return (_jsxs(motion.div, { className: "vitals", initial: { opacity: 0, x: 12 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: 12, transition: { duration: 0.15 } }, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] }, children: [_jsx("h2", { className: "vitals-name", children: serviceName[service] }), _jsx("p", { className: "vitals-role", children: serviceRole[service] }), _jsx("p", { className: `vitals-state state-${down ? "flare" : tone}`, children: down ? "Not responding" : tone === "sodium" ? "Under investigation" : tone === "aurora" ? "Recovered" : "Healthy" }), _jsx("dl", { children: VITALS.map(({ key, label }) => (_jsxs("div", { className: "vital", children: [_jsx("dt", { children: label }), _jsx("dd", { className: "num", children: formatValue(`x.${key}`, view?.latest[key] ?? null) }), _jsx(Sparkline, { values: view?.series[key] ?? [], tone: down ? "flare" : tone })] }, key))) })] }, service));
}
function Legend() {
    return (_jsxs("div", { className: "legend", children: [_jsx("p", { children: "Each star is a service of the shop. Click one to see its vitals." }), _jsxs("ul", { children: [_jsxs("li", { children: [_jsx("span", { className: "legend-spark", "aria-hidden": "true" }), " Sparks are live requests between services."] }), _jsxs("li", { children: [_jsx("span", { className: "legend-spark is-slow", "aria-hidden": "true" }), " Sparks crawl when calls slow down."] }), _jsxs("li", { children: [_jsx("span", { className: "legend-spark is-failed", "aria-hidden": "true" }), " Red sparks are failed calls."] }), _jsxs("li", { children: [_jsx("span", { className: "legend-comet", "aria-hidden": "true" }), " Comets are agents investigating a star."] })] })] }));
}
export function Watch({ system, situation, list, mode, selected, onSelect, }) {
    const { title, line } = useHeadline(situation, system);
    const [breaking, setBreaking] = useState(false);
    const [legend, setLegend] = useState(false);
    const toneFor = (s) => (situation.focus?.service === s ? situation.focus.tone : "calm");
    return (_jsxs("main", { className: "watch", children: [_jsx("h1", { className: "visually-hidden", children: "Vigil war room" }), _jsx(Inbox, { situation: situation, list: list }), _jsx(AnimatePresence, { children: selected && (_jsxs(Panel, { as: "aside", className: "side", label: "Service vitals", children: [_jsx(AnimatePresence, { mode: "wait", children: _jsx(Vitals, { service: selected, system: system, tone: toneFor(selected) }, selected) }), _jsx("button", { className: "link-button", onClick: () => onSelect(null), children: "Close" })] }, "side")) }), _jsxs("section", { className: `status status-${situation.kind}`, "aria-live": "polite", children: [_jsx("h2", { className: "status-title", children: _jsx(RisingText, { text: title }, title) }), _jsx(motion.p, { className: "status-line", initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { delay: 0.45, duration: 0.6 }, children: line }, title), situation.kind === "decide" && (_jsx(motion.a, { className: "button button-primary", href: href({ page: "incident", id: situation.pending[0].id }), initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { delay: 0.7 }, children: "Review the diagnosis" })), situation.kind === "investigating" && situation.running && (_jsx(motion.a, { className: "button", href: href({ page: "incident", id: situation.running.id }), initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { delay: 0.7 }, children: "Follow the investigation" }))] }), _jsxs("div", { className: "corner", children: [_jsx(AnimatePresence, { children: legend && (_jsxs(Panel, { className: "legend-panel", label: "How to read the sky", children: [_jsx(Legend, {}), _jsx("div", { className: "service-picker", role: "group", "aria-label": "Show a service's vitals", children: SERVICES.map((s) => (_jsx("button", { onClick: () => {
                                            onSelect(s);
                                            setLegend(false);
                                        }, className: `chip tone-${toneFor(s)}`, children: serviceName[s] }, s))) })] }, "legend")) }), _jsxs("div", { className: "corner-buttons", children: [_jsx("button", { className: "button button-ghost", "aria-expanded": legend, onClick: () => setLegend(!legend), children: legend ? "Close" : "How to read the sky" }), mode !== "demo" && (_jsx("button", { className: "button button-ghost", onClick: () => setBreaking(true), disabled: mode !== "live", children: "Break something" }))] }), mode === "demo" && _jsx(ReplayGuide, { kind: situation.kind })] }), _jsx(AnimatePresence, { children: breaking && _jsx(BreakSomething, { onClose: () => setBreaking(false) }) })] }));
}
/** The replay's story in four steps: what is happening now, and what a visitor can do. */
const GUIDE = {
    quiet: {
        step: 1,
        title: "A replay of a real incident",
        text: "This is Vigil watching its demo shop, recorded from a real run. Keep an eye on the Orders star: something is about to go wrong with it.",
    },
    investigating: {
        step: 2,
        title: "Vigil noticed on its own",
        text: "Its detector raised the alarm and AI agents are investigating. Follow the investigation to see each question they ask and what they find.",
    },
    decide: {
        step: 3,
        title: "Your turn",
        text: "Vigil never changes anything without a person. Review the diagnosis and approve the fix; in the replay, nothing real is touched.",
    },
    recovered: {
        step: 4,
        title: "Fixed, with your approval",
        text: "Open the incident to see the proof it worked, or Scores for how Vigil is tested. The replay starts again shortly.",
    },
};
function ReplayGuide({ kind }) {
    const guide = GUIDE[kind] ?? GUIDE.quiet;
    return (_jsx("div", { className: "replay-note", "aria-live": "polite", children: _jsx(AnimatePresence, { mode: "wait", initial: false, children: _jsxs(motion.div, { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -6 }, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] }, children: [_jsxs("p", { className: "guide-head", children: [_jsx("span", { className: "guide-steps", "aria-label": `Step ${guide.step} of 4`, children: [1, 2, 3, 4].map((n) => (_jsx("i", { className: n < guide.step ? "is-done" : n === guide.step ? "is-now" : "" }, n))) }), _jsx("strong", { children: guide.title })] }), _jsx("p", { children: guide.text })] }, guide.step) }) }));
}
