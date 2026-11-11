import { now as clockNow } from "./clock";
import { SERVICES } from "./types";
import { suspect } from "./words";
/** What the whole war room is about right now, derived from the API's answers. */
export function eventsOf(inv) {
    return inv?.events ?? inv?.timeline ?? [];
}
export function diagnosisOf(inv) {
    if (!inv)
        return undefined;
    if (inv.diagnosis)
        return inv.diagnosis;
    const event = eventsOf(inv).find((e) => e.step === "diagnose");
    return event && event.step === "diagnose" ? event.diagnosis : undefined;
}
function isService(s) {
    return SERVICES.includes(s);
}
/** The service an investigation is about: its diagnosis once there is one, else the alert's. */
export function serviceOf(inv) {
    const diagnosed = diagnosisOf(inv)?.root_cause_service;
    if (isService(diagnosed))
        return diagnosed;
    const guessed = inv ? suspect(inv) : null;
    return isService(guessed) ? guessed : null;
}
/** The agents at work at this moment of a running investigation, for the comets. */
export function activeAgents(inv) {
    if (!inv || !["investigating", "acting"].includes(inv.status))
        return [];
    const events = eventsOf(inv);
    const last = events.at(-1);
    if (!last)
        return ["plan"];
    const lastPlan = events.findLastIndex((e) => e.step === "plan");
    if (last.step === "plan" || last.step === "specialist") {
        const plan = events[lastPlan];
        if (plan?.step === "plan" && plan.tasks.length) {
            const answered = new Set(events.slice(lastPlan + 1).flatMap((e) => (e.step === "specialist" ? [e.agent] : [])));
            const waiting = plan.tasks.map((t) => t.agent).filter((a) => !answered.has(a));
            return waiting.length ? waiting : ["plan"];
        }
        return ["diagnose"];
    }
    if (last.step === "diagnose")
        return ["recall"];
    if (last.step === "recall")
        return ["propose"];
    return ["plan"];
}
const RECOVERED_FOR_MS = 8 * 60 * 1000;
export function situation(system, live, list, now = clockNow()) {
    // Only live incidents are about the shop as it is now; a replayed one waiting for review is
    // listed in the inbox but does not change what the sky says.
    const waiting = (list ?? []).filter((i) => i.status === "awaiting review");
    const pending = waiting.filter((i) => i.id.startsWith("live-"));
    const replays = waiting.filter((i) => !i.id.startsWith("live-"));
    const runningAll = (live ?? []).filter((i) => i.status === "investigating" || i.status === "acting");
    // The newest running investigation is the one the sky shows.
    const running = runningAll[0] ?? null;
    const down = SERVICES.find((s) => system?.online && system.services?.[s]?.latest.up === null);
    if (running) {
        const service = serviceOf(running) ?? down ?? null;
        return {
            kind: "investigating",
            focus: service ? { service, tone: down === service ? "flare" : "sodium" } : null,
            agents: activeAgents(running),
            running,
            runningAll,
            pending,
            replays,
            recent: null,
        };
    }
    if (pending.length) {
        const first = pending[0];
        const service = isService(first.root_cause_service) ? first.root_cause_service : null;
        return {
            kind: "decide",
            focus: service ? { service, tone: down === service ? "flare" : "sodium" } : null,
            agents: [],
            running: null,
            runningAll,
            pending,
            replays,
            recent: null,
        };
    }
    const recent = (list ?? []).find((i) => i.outcome === "executed" && now - new Date(i.alert_at).getTime() < RECOVERED_FOR_MS);
    if (recent && isService(recent.proposal?.service ?? recent.root_cause_service)) {
        const service = (recent.proposal?.service ?? recent.root_cause_service);
        return { kind: "recovered", focus: { service, tone: "aurora" }, agents: [], running: null, runningAll, pending, replays, recent };
    }
    if (system && !system.online) {
        return { kind: "offline", focus: null, agents: [], running: null, runningAll, pending, replays, recent: null };
    }
    return { kind: "quiet", focus: down ? { service: down, tone: "flare" } : null, agents: [], running: null, runningAll, pending, replays, recent: null };
}
