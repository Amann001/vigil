import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from "motion/react";
import { Panel } from "../components/Bits";
import { href } from "../lib/route";
import { headline, outcomeName, proposalName, statusName } from "../lib/words";
import "./history.css";
function dayOf(iso) {
    return new Date(iso).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}
function tone(i) {
    if (i.status === "investigating")
        return "sodium";
    if (i.status === "awaiting review")
        return "sodium";
    if (i.outcome === "executed")
        return "aurora";
    if (i.status === "corrected")
        return "flare";
    return "calm";
}
export function History({ list }) {
    const items = list ?? [];
    const days = new Map();
    for (const item of items)
        days.set(dayOf(item.alert_at), [...(days.get(dayOf(item.alert_at)) ?? []), item]);
    const waiting = items.filter((i) => i.status === "awaiting review").length;
    const fixed = items.filter((i) => i.outcome === "executed").length;
    const corrected = items.filter((i) => i.status === "corrected").length;
    return (_jsx("main", { className: "history", children: _jsxs(Panel, { className: "history-panel", label: "Every incident", children: [_jsxs("header", { className: "history-head", children: [_jsx("h1", { children: "Incidents" }), _jsx("p", { children: items.length === 0
                                ? "None yet. When the detector raises an alert, the investigation appears here."
                                : `${items.length} investigated. ${fixed} fixed or rehearsed, ${corrected} corrected by a reviewer${waiting ? `, ${waiting} waiting for a decision` : ""}.` })] }), [...days].map(([day, entries], d) => (_jsxs("section", { className: "day", children: [_jsx("h2", { children: day }), _jsx("ol", { children: entries.map((i, n) => (_jsx(motion.li, { initial: { opacity: 0, x: -10 }, animate: { opacity: 1, x: 0 }, transition: { delay: Math.min(0.15 + d * 0.06 + n * 0.03, 0.8), duration: 0.5 }, children: _jsxs("a", { className: "row", href: href({ page: "incident", id: i.id }), children: [_jsx("span", { className: "row-time num", children: new Date(i.alert_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) }), _jsx("span", { className: `dot dot-${tone(i)}`, "aria-hidden": "true" }), _jsxs("span", { className: "row-main", children: [_jsx("strong", { children: i.root_cause_service && i.category
                                                        ? headline({ root_cause_service: i.root_cause_service, category: i.category })
                                                        : "Investigating" }), _jsxs("span", { children: [i.proposal ? `Proposed: ${proposalName(i.proposal).toLowerCase()}` : "No proposal yet", i.id.startsWith("replay-") ? ". Replayed from a recording" : ""] })] }), _jsx("span", { className: "row-outcome", children: outcomeName(i.outcome) || statusName[i.status] }), _jsx("span", { className: "row-time num row-took", children: i.seconds ? `${Math.round(i.seconds)} s` : "" })] }) }, i.id))) })] }, day)))] }) }));
}
