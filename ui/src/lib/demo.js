import { setClock } from "./clock";
const WINDOW = 120; // ten minutes of 5-second readings
const HOLD_SECONDS = 40; // how long the replay waits for the viewer at the review
const END_PAUSE = 25;
const START_AT = 25; // seconds into the tape: a short healthy stretch, then the fault
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
function onStage(item) {
    return item.id.startsWith("live-") || item.status !== "awaiting review";
}
function shifted(value, ms) {
    if (typeof value === "string") {
        return (ISO.test(value) ? new Date(Date.parse(value) + ms).toISOString() : value);
    }
    if (Array.isArray(value))
        return value.map((v) => shifted(v, ms));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shifted(v, ms)]));
    }
    return value;
}
class Player {
    tape;
    position = START_AT; // seconds into the tape
    lastTick = performance.now();
    loopStarted = Date.now(); // the wall clock when this loop of the replay began
    holdStarted = null;
    decided = false;
    start;
    reviewAt;
    end;
    constructor(tape) {
        this.tape = tape;
        this.start = Date.parse(tape.recorded_at);
        this.end = tape.frames.at(-1)?.t ?? 0;
        this.reviewAt = this.findReview();
    }
    /** The first moment the recorded reviewer's decision shows on the tape. */
    findReview() {
        let waiting = false;
        for (const frame of this.tape.frames) {
            for (const inv of Object.values(frame.details ?? {})) {
                if (inv.status === "awaiting review")
                    waiting = true;
                else if (waiting && inv.status !== "investigating")
                    return frame.t;
            }
        }
        return null;
    }
    frames() {
        return this.tape.frames.filter((f) => f.t <= this.position);
    }
    latest(key) {
        const frames = this.frames();
        for (let i = frames.length - 1; i >= 0; i--)
            if (frames[i][key] !== undefined)
                return frames[i][key];
        return this.tape.frames.find((f) => f[key] !== undefined)?.[key];
    }
    tick() {
        const now = performance.now();
        const dt = Math.min((now - this.lastTick) / 1000, 2);
        this.lastTick = now;
        const working = (this.latest("live") ?? []).some((i) => i.status === "investigating" || i.status === "acting");
        const speed = working ? 3 : 2;
        let next = this.position + dt * speed;
        if (this.reviewAt !== null && !this.decided && next >= this.reviewAt) {
            this.holdStarted ??= now;
            if ((now - this.holdStarted) / 1000 < HOLD_SECONDS)
                next = this.reviewAt - 0.01;
            else
                this.decided = true;
        }
        if (next > this.end + END_PAUSE) {
            next = START_AT;
            this.loopStarted = Date.now();
            this.decided = false;
            this.holdStarted = null;
        }
        this.position = next;
    }
    /** How far the tape's timestamps move so that the replay starts now. Fixed for a whole loop,
     *  so times stay consistent while playback runs faster than real time. */
    offset() {
        return this.loopStarted - (this.start + START_AT * 1000);
    }
    /** The moment of the recording being shown, on the shifted timeline. */
    now() {
        return this.start + this.position * 1000 + this.offset();
    }
    decide() {
        this.decided = true;
    }
    system() {
        const base = this.tape.system0;
        const rows = this.frames().flatMap((f) => (f.row ? [f.row] : []));
        const times = [...(base.times ?? []), ...rows.map((r) => r.time)].slice(-WINDOW);
        const services = Object.fromEntries(Object.entries(base.services ?? {}).map(([name, view]) => {
            const series = Object.fromEntries(Object.entries(view.series).map(([metric, values]) => [
                metric,
                [...values, ...rows.map((r) => r.services[name]?.[metric] ?? null)].slice(-WINDOW),
            ]));
            // The newest reading of a metric can be missing (Prometheus has not computed it yet):
            // like the API, show the last value there is, except for "up", where missing means down.
            const latest = { ...view.latest };
            for (const row of rows) {
                for (const [metric, value] of Object.entries(row.services[name] ?? {})) {
                    if (value !== null || metric === "up")
                        latest[metric] = value;
                }
            }
            return [name, { latest: latest, series }];
        }));
        const lastRow = rows.at(-1);
        const edges = (base.edges ?? []).map((edge, i) => ({ ...edge, latest: lastRow?.edges[i] ?? edge.latest }));
        const score = base.score && {
            threshold: base.score.threshold,
            values: [...base.score.values, ...rows.map((r) => r.score)].slice(-WINDOW),
        };
        return shifted({ online: true, times, services, edges, score }, this.offset());
    }
    get(path) {
        this.tick();
        const ms = this.offset();
        if (path === "/system")
            return this.system();
        if (path === "/live")
            return shifted(this.latest("live") ?? [], ms);
        // A development replay left waiting for review would sit in the inbox through the whole
        // story; the public replay is about the one live incident, so it is left out.
        if (path === "/investigations")
            return shifted((this.latest("list") ?? []).filter(onStage), ms);
        if (path === "/audit")
            return [];
        const match = path.match(/^\/investigations\/(.+)$/);
        if (match) {
            const id = decodeURIComponent(match[1]);
            const frames = this.frames();
            for (let i = frames.length - 1; i >= 0; i--) {
                const found = frames[i].details?.[id];
                if (found)
                    return shifted(found, ms);
            }
            if (this.tape.details0[id])
                return shifted(this.tape.details0[id], ms);
            // Opened by a link before the replay has reached it: show how it ended.
            const later = this.tape.frames.findLast((f) => f.details?.[id])?.details?.[id];
            if (later)
                return shifted(later, ms);
            throw new Error(`No investigation ${id}`);
        }
        throw new Error(`Not in the replay: ${path}`);
    }
}
let player = null;
function load() {
    player ??= fetch(`${import.meta.env.BASE_URL}demo/tape.json`)
        .then((r) => {
        if (!r.ok)
            throw new Error("No recording to replay");
        return r.json();
    })
        .then((tape) => {
        const replay = new Player(tape);
        setClock(() => replay.now());
        return replay;
    });
    return player;
}
export const demo = {
    async get(path) {
        return (await load()).get(path);
    },
    async send(method, path, _body) {
        if (method === "POST" && path.endsWith("/review")) {
            (await load()).decide();
            return { queued: true };
        }
        throw new Error("The replay cannot change anything: run Vigil locally to break and fix the shop.");
    },
};
