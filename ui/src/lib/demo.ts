import { setClock } from "./clock";
import type { AuditEntry, Config, Investigation, InvestigationSummary, SystemView } from "./types";

/**
 * The public replay: a recording of what the war room fetched from Vigil's API during a real
 * incident (scripts/record_demo.py), played back as if it were happening now. Every answer
 * comes from the tape; only its timestamps are moved to the moment it is watched.
 *
 * Playback runs faster while the agents are working, waits for the viewer at the review (as
 * Vigil does), then continues with what the real reviewer decided, and loops.
 */

interface Row {
  time: string;
  services: Record<string, Record<string, number | null>>;
  edges: { failure_ratio: number | null; latency_p95: number | null }[];
  score: number | null;
}

interface Frame {
  t: number;
  row?: Row;
  live?: Investigation[];
  list?: InvestigationSummary[];
  details?: Record<string, Investigation>;
}

interface Tape {
  recorded_at: string;
  system0: SystemView;
  details0: Record<string, Investigation>;
  config?: Config;
  frames: Frame[];
}

/** A moment in the recording worth jumping to. */
export interface Marker {
  t: number;
  label: string;
}

/** What the replay controls show and change. */
export interface ReplayState {
  position: number;
  start: number;
  end: number;
  paused: boolean;
  speed: number;
  waiting: boolean; // held at the review, waiting for the viewer's decision
  markers: Marker[];
}

const WINDOW = 120; // ten minutes of 5-second readings
const HOLD_SECONDS = 40; // how long the replay waits for the viewer at the review
const END_PAUSE = 25;
const START_AT = 25; // seconds into the tape: a short healthy stretch, then the fault
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function onStage(item: InvestigationSummary): boolean {
  return item.id.startsWith("live-") || item.status !== "awaiting review";
}

function shifted<T>(value: T, ms: number): T {
  if (typeof value === "string") {
    return (ISO.test(value) ? new Date(Date.parse(value) + ms).toISOString() : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => shifted(v, ms)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shifted(v, ms)])) as T;
  }
  return value;
}

class Player {
  private position = START_AT; // seconds into the tape
  private lastTick = performance.now();
  private loopStarted = Date.now(); // the wall clock when this loop of the replay began
  private holdStarted: number | null = null;
  private decided = false;
  private paused = false;
  private speed = 1; // the viewer's choice, on top of the replay's own pace
  private readonly start: number;
  private readonly reviewAt: number | null;
  private readonly end: number;
  readonly markers: Marker[];

  constructor(private tape: Tape) {
    this.start = Date.parse(tape.recorded_at);
    this.end = tape.frames.at(-1)?.t ?? 0;
    this.reviewAt = this.findReview();
    this.markers = this.findMarkers();
  }

  /** The story's turning points, read from the tape itself. */
  private findMarkers(): Marker[] {
    const first = (test: (f: Frame) => boolean) => this.tape.frames.find(test)?.t;
    // Only the live incident counts: the recording also holds older replays, one of them
    // waiting for review from the very first frame, which put "Diagnosis" at the start.
    const live = (f: Frame) => Object.values(f.details ?? {}).filter((i) => i.id.startsWith("live-"));
    const statuses = (f: Frame) => live(f).map((i) => i.status);
    const found: [number | undefined | null, string][] = [
      [START_AT, "All quiet"],
      [first((f) => (f.live ?? []).some((i) => i.status === "investigating")), "Alert"],
      [first((f) => statuses(f).includes("awaiting review")), "Diagnosis"],
      [first((f) => live(f).some((i) => i.action?.outcome === "executed")), "Fixed"],
    ];
    return found.flatMap(([t, label]) => (t === undefined || t === null ? [] : [{ t, label }]));
  }

  state(): ReplayState {
    return {
      position: this.position,
      start: START_AT,
      end: this.end,
      paused: this.paused,
      speed: this.speed,
      waiting: this.holdStarted !== null && !this.decided,
      markers: this.markers,
    };
  }

  seek(t: number) {
    this.position = Math.min(Math.max(t, START_AT), this.end);
    // Before the decision the replay waits for the viewer again; after it, it has been made.
    this.decided = this.reviewAt !== null && this.position >= this.reviewAt;
    this.holdStarted = null;
    this.lastTick = performance.now();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.lastTick = performance.now();
  }

  setSpeed(speed: number) {
    this.speed = speed;
  }

  /** The first moment the recorded reviewer's decision shows on the tape. */
  private findReview(): number | null {
    let waiting = false;
    for (const frame of this.tape.frames) {
      for (const inv of Object.values(frame.details ?? {})) {
        if (inv.status === "awaiting review") waiting = true;
        else if (waiting && inv.status !== "investigating") return frame.t;
      }
    }
    return null;
  }

  private frames(): Frame[] {
    return this.tape.frames.filter((f) => f.t <= this.position);
  }

  private latest<K extends "live" | "list">(key: K): Frame[K] | undefined {
    const frames = this.frames();
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i][key] !== undefined) return frames[i][key];
    return this.tape.frames.find((f) => f[key] !== undefined)?.[key];
  }

  private tick() {
    const now = performance.now();
    const dt = Math.min((now - this.lastTick) / 1000, 2);
    this.lastTick = now;
    if (this.paused) return;
    const working = (this.latest("live") ?? []).some((i) => i.status === "investigating" || i.status === "acting");
    const speed = (working ? 3 : 2) * this.speed;
    let next = this.position + dt * speed;
    if (this.reviewAt !== null && !this.decided && next >= this.reviewAt) {
      this.holdStarted ??= now;
      if ((now - this.holdStarted) / 1000 < HOLD_SECONDS) next = this.reviewAt - 0.01;
      else this.decided = true;
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
  private offset(): number {
    return this.loopStarted - (this.start + START_AT * 1000);
  }

  /** The moment of the recording being shown, on the shifted timeline. */
  now(): number {
    return this.start + this.position * 1000 + this.offset();
  }

  decide() {
    this.decided = true;
  }

  system(): SystemView {
    const base = this.tape.system0;
    const rows = this.frames().flatMap((f) => (f.row ? [f.row] : []));
    const times = [...(base.times ?? []), ...rows.map((r) => r.time)].slice(-WINDOW);
    const services = Object.fromEntries(
      Object.entries(base.services ?? {}).map(([name, view]) => {
        const series = Object.fromEntries(
          Object.entries(view.series).map(([metric, values]) => [
            metric,
            [...values, ...rows.map((r) => r.services[name]?.[metric] ?? null)].slice(-WINDOW),
          ]),
        );
        // The newest reading of a metric can be missing (Prometheus has not computed it yet):
        // like the API, show the last value there is, except for "up", where missing means down.
        const latest: Record<string, number | null> = { ...view.latest };
        for (const row of rows) {
          for (const [metric, value] of Object.entries(row.services[name] ?? {})) {
            if (value !== null || metric === "up") latest[metric] = value;
          }
        }
        return [name, { latest: latest as typeof view.latest, series }];
      }),
    );
    const lastRow = rows.at(-1);
    const edges = (base.edges ?? []).map((edge, i) => ({ ...edge, latest: lastRow?.edges[i] ?? edge.latest }));
    const score = base.score && {
      threshold: base.score.threshold,
      values: [...base.score.values, ...rows.map((r) => r.score)].slice(-WINDOW),
    };
    return shifted({ online: true, times, services, edges, score } as SystemView, this.offset());
  }

  /** An investigation as it stood at this point of the recording. */
  private detailsNow(id: string): Investigation | undefined {
    const frames = this.frames();
    for (let i = frames.length - 1; i >= 0; i--) {
      const found = frames[i].details?.[id];
      if (found) return found;
    }
    return this.tape.details0[id];
  }

  /** The recording's lists predate the decision and action times in the API's list, so they
   *  are filled in from the full investigations. */
  private withTimes(item: InvestigationSummary): InvestigationSummary {
    if (item.decided_at !== undefined) return item;
    const full = this.detailsNow(item.id);
    return {
      ...item,
      affected_services: full?.diagnosis?.affected_services ?? [],
      decided_at: full?.review?.at ?? null,
      decided_by: full?.review?.by ?? null,
      acted_at: full?.action?.at ?? null,
    };
  }

  /** The audit log as it stood: every decision about an action the recording has reached. */
  private audit(): AuditEntry[] {
    const ids = new Set([
      ...Object.keys(this.tape.details0),
      ...this.frames().flatMap((f) => Object.keys(f.details ?? {})),
    ]);
    return [...ids]
      .flatMap((id) => {
        const action = this.detailsNow(id)?.action;
        return action ? [{ ...action, incident: id } as AuditEntry] : [];
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  get(path: string): unknown {
    this.tick();
    const ms = this.offset();
    if (path === "/system") return this.system();
    if (path === "/live") return shifted(this.latest("live") ?? [], ms);
    // A development replay left waiting for review would sit in the inbox through the whole
    // story; the public replay is about the one live incident, so it is left out.
    if (path === "/investigations")
      return shifted((this.latest("list") ?? []).filter(onStage).map((item) => this.withTimes(item)), ms);
    if (path === "/audit") return shifted(this.audit(), ms);
    if (path === "/health") return { status: "ok", version: "replay", queue: false, reviews: false };
    if (path === "/config") {
      if (!this.tape.config) throw new Error("This recording has no policy");
      return this.tape.config;
    }
    const match = path.match(/^\/investigations\/(.+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const found = this.detailsNow(id);
      if (found) return shifted(found, ms);
      // Opened by a link before the replay has reached it: show how it ended.
      const later = this.tape.frames.findLast((f) => f.details?.[id])?.details?.[id];
      if (later) return shifted(later, ms);
      throw new Error(`No investigation ${id}`);
    }
    throw new Error(`Not in the replay: ${path}`);
  }
}

let player: Promise<Player> | null = null;

function load(): Promise<Player> {
  player ??= fetch(`${import.meta.env.BASE_URL}demo/tape.json`)
    .then((r) => {
      if (!r.ok) throw new Error("No recording to replay");
      return r.json();
    })
    .then((tape: Tape) => {
      const replay = new Player(tape);
      setClock(() => replay.now());
      return replay;
    });
  return player;
}

/** The replay's controls, for the timeline under the war room. */
export const replay = {
  async state(): Promise<ReplayState> {
    return (await load()).state();
  },
  async seek(t: number) {
    (await load()).seek(t);
  },
  async setPaused(paused: boolean) {
    (await load()).setPaused(paused);
  },
  async setSpeed(speed: number) {
    (await load()).setSpeed(speed);
  },
};

export const demo = {
  async get(path: string): Promise<unknown> {
    return (await load()).get(path);
  },
  async send(method: string, path: string, _body?: unknown): Promise<unknown> {
    if (method === "POST" && path.endsWith("/review")) {
      (await load()).decide();
      return { queued: true };
    }
    throw new Error("The replay cannot change anything: run Vigil locally to break and fix the shop.");
  },
};
