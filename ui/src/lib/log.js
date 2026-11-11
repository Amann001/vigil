export function parseSignals(alert) {
    return alert
        .split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => {
        const m = l.match(/^- ([^:]+): ([^,]+), usual ([^,]+), ([\d.]+)x/);
        if (!m)
            return null;
        const value = m[2].startsWith("missing") ? null : Number(m[2]);
        return { feature: m[1], value, usual: Number(m[3]), deviations: Number(m[4]) };
    })
        .filter((s) => s !== null);
}
function fromEvent(e, inv) {
    switch (e.step) {
        case "plan":
            return e.tasks.length ? { kind: "plan", at: e.at, round: e.round, tasks: e.tasks } : null;
        case "specialist":
        case "solo":
            return { kind: "finding", at: e.at, agent: e.agent, question: e.question, tools: e.tools, report: e.report };
        case "diagnose":
            return { kind: "diagnosis", at: e.at, diagnosis: e.diagnosis };
        case "recall":
            return { kind: "recall", at: e.at, recalled: e.recalled };
        case "propose":
            return { kind: "proposal", at: e.at, proposal: e.proposal };
        case "review":
            return inv.status === "awaiting review" ? { kind: "waiting", at: e.at } : null;
        case "decision":
            return { kind: "decision", at: e.at, review: e.review };
        case "act":
            return { kind: "action", at: e.at, action: e.action };
        case "report":
            return { kind: "report", at: e.at, markdown: inv.incident_report ?? null };
    }
}
export function buildLog(inv) {
    const signals = inv.signals ?? parseSignals(inv.alert ?? "");
    const items = [{ kind: "alert", at: inv.started_at ?? inv.timeline?.[0]?.at, signals, text: inv.alert }];
    const events = inv.events ?? inv.timeline;
    if (events?.length) {
        for (const e of events) {
            const item = fromEvent(e, inv);
            if (item)
                items.push(item);
        }
        if (inv.status === "awaiting review" && !items.some((i) => i.kind === "waiting"))
            items.push({ kind: "waiting" });
        return items;
    }
    // An older report: rebuilt from its parts, in the order the graph runs them.
    for (const f of inv.findings ?? []) {
        items.push({ kind: "finding", agent: f.agent, question: f.question, tools: f.tool_calls.map((c) => c.name), report: f.report });
    }
    if (inv.diagnosis)
        items.push({ kind: "diagnosis", diagnosis: inv.diagnosis });
    if (inv.recalled?.length)
        items.push({ kind: "recall", recalled: inv.recalled });
    if (inv.proposal)
        items.push({ kind: "proposal", proposal: inv.proposal });
    if (inv.status === "awaiting review") {
        items.push({ kind: "waiting" });
        return items; // anything after the review belongs to an earlier, discarded run
    }
    if (inv.review)
        items.push({ kind: "decision", at: inv.review.at, review: inv.review });
    if (inv.action)
        items.push({ kind: "action", at: inv.action.at, action: inv.action });
    if (inv.incident_report)
        items.push({ kind: "report", markdown: inv.incident_report });
    return items;
}
/** The stages of an investigation, for the progress route at the top of the page. */
export const STAGES = [
    { id: "alert", label: "Alert" },
    { id: "investigate", label: "Investigate" },
    { id: "diagnose", label: "Diagnose" },
    { id: "propose", label: "Propose" },
    { id: "decide", label: "You decide" },
    { id: "resolve", label: "Resolved" },
];
export function stageReached(items, status) {
    const kinds = new Set(items.map((i) => i.kind));
    if (kinds.has("report") || (kinds.has("action") && status !== "acting"))
        return 6;
    if (kinds.has("decision") || status === "acting")
        return 5;
    if (kinds.has("waiting") || status === "awaiting review")
        return 4;
    if (kinds.has("proposal") || kinds.has("recall"))
        return 3;
    if (kinds.has("diagnosis"))
        return 2;
    if (kinds.has("finding") || kinds.has("plan"))
        return 1;
    return 0;
}
