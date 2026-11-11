import { motion } from "motion/react";
import { Panel, RisingText } from "../components/Bits";
import { api, usePoll } from "../lib/api";
import { href } from "../lib/route";
import type { Situation } from "../lib/state";
import { SERVICES, type InvestigationSummary, type Service, type SystemView } from "../lib/types";
import { ago, formatValue, headline, outcomeName, serviceName, serviceRole, statusName } from "../lib/words";
import "./pages.css";
import "./status.css";

// Past these a service is degraded: a twentieth of requests failing, or a second at p95.
const DEGRADED_ERROR_RATIO = 0.05;
const DEGRADED_P95_SECONDS = 1;

type Health = { label: string; tone: "aurora" | "sodium" | "flare" | "calm" };

function healthOf(service: Service, system: SystemView | null, situation: Situation): Health {
  const latest = system?.services?.[service]?.latest;
  if (!system?.online || !latest) return { label: "No signal", tone: "calm" };
  if (latest.up === null) return { label: "Down", tone: "flare" };
  if (situation.focus?.service === service && situation.focus.tone === "sodium") return { label: "Under investigation", tone: "sodium" };
  if ((latest.error_ratio ?? 0) > DEGRADED_ERROR_RATIO || (latest.latency_p95 ?? 0) > DEGRADED_P95_SECONDS)
    return { label: "Degraded", tone: "sodium" };
  return { label: "Operational", tone: "aurora" };
}

function overall(system: SystemView | null, situation: Situation): string {
  if (!system) return "Checking…";
  if (!system.online) return "No signal from the shop.";
  const states = SERVICES.map((s) => [s, healthOf(s, system, situation).label] as const);
  const find = (label: string) => states.find(([, l]) => l === label)?.[0];
  const down = find("Down");
  if (down) return `${serviceName[down]} is down.`;
  const looking = find("Under investigation");
  if (looking) return `Vigil is investigating ${serviceName[looking]}.`;
  const degraded = find("Degraded");
  if (degraded) return `${serviceName[degraded]} is degraded.`;
  return "All systems operational.";
}

/**
 * A status page, as a team that depends on the shop would want it: each service's state,
 * how much of the last ten minutes it was up, and how Vigil itself is set up.
 */
export function Status({
  system,
  situation,
  list,
  mode,
}: {
  system: SystemView | null;
  situation: Situation;
  list: InvestigationSummary[] | null;
  mode: "live" | "demo" | "unknown";
}) {
  const health = usePoll(api.health, 10000, mode).data;
  const title = overall(system, situation);
  const recent = (list ?? []).slice(0, 5);
  return (
    <main className="doc status-page">
      <Panel className="doc-panel" label="Status">
        <header className="doc-head">
          <h1>
            <RisingText key={title} text={title} />
          </h1>
          <p className="doc-lede">
            Each service of the shop as Vigil sees it now, and how much of the last ten minutes it was up. Updated every 5
            seconds{mode === "demo" ? ", from the recording" : ""}.
          </p>
        </header>

        <section className="doc-section" aria-label="Services">
          <ul className="status-list">
            {SERVICES.map((s, i) => {
              const view = system?.services?.[s];
              const ups = view?.series.up ?? [];
              const upCount = ups.filter((v) => v !== null && v >= 1).length;
              const share = ups.length ? (upCount / ups.length) * 100 : null;
              const state = healthOf(s, system, situation);
              return (
                <motion.li
                  key={s}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + i * 0.06, duration: 0.5 }}
                >
                  <div className="status-name">
                    <a href={href({ page: "service", service: s })}>{serviceName[s]}</a>
                    <span>{serviceRole[s]}</span>
                  </div>
                  <span className={`pill pill-${state.tone}`}>
                    <span className={`dot dot-${state.tone}`} aria-hidden="true" />
                    {state.label}
                  </span>
                  <span className="status-figures num">
                    {view && system?.online && view.latest.latency_p95 !== null
                      ? `${formatValue("x.latency_p95", view.latest.latency_p95)} p95, ${formatValue("x.error_ratio", view.latest.error_ratio)} failing`
                      : "No readings"}
                  </span>
                  <div className="uptime" aria-label={share === null ? "No readings" : `Up ${share.toFixed(1)}% of the last ten minutes`}>
                    <span className="uptime-ticks" aria-hidden="true">
                      {ups.map((v, n) => (
                        <i key={n} className={v === null ? "is-gap" : v >= 1 ? "is-up" : "is-down"} />
                      ))}
                    </span>
                    <span className="uptime-share num">{share === null ? "–" : `${share.toFixed(share === 100 ? 0 : 1)}%`}</span>
                  </div>
                </motion.li>
              );
            })}
          </ul>
          <p className="doc-note">
            Degraded means more than {DEGRADED_ERROR_RATIO * 100}% of requests failing or a p95 response time over{" "}
            {DEGRADED_P95_SECONDS} s. Each tick is one 5-second reading; a gap is a reading that never arrived.
          </p>
        </section>

        <section className="doc-section">
          <h2>Vigil itself</h2>
          <dl className="stats">
            <div className="stat">
              <dt>Detector</dt>
              <dd>{system?.online ? "Watching" : "No signal"}</dd>
              <small>{system?.online ? "40 signals every 5 s" : "Prometheus is not answering"}</small>
            </div>
            <div className="stat">
              <dt>Investigations</dt>
              <dd>{mode === "demo" ? "Replay" : health?.queue ? "Queued" : "In process"}</dd>
              <small>{mode === "demo" ? "A recorded incident" : health?.queue ? "Workers on a Postgres queue" : "One at a time, no database"}</small>
            </div>
            <div className="stat">
              <dt>Reviews</dt>
              <dd>{health?.reviews ? "On" : "Off"}</dd>
              <small>{health?.reviews ? "For holders of the API token" : mode === "demo" ? "Nothing in a replay is real" : "No API token is set"}</small>
            </div>
            <div className="stat">
              <dt>Version</dt>
              <dd className="num">{health?.version ?? "…"}</dd>
              <small>
                <a href={href({ page: "policy" })}>The policy it runs under</a>
              </small>
            </div>
          </dl>
        </section>

        <section className="doc-section">
          <h2>Recent incidents</h2>
          {recent.length === 0 ? (
            <p className="doc-note">None yet.</p>
          ) : (
            <ul className="status-incidents">
              {recent.map((i) => (
                <li key={i.id}>
                  <a href={href({ page: "incident", id: i.id })}>
                    {i.root_cause_service && i.category
                      ? headline({ root_cause_service: i.root_cause_service, category: i.category })
                      : "Investigating"}
                  </a>
                  <span>
                    {ago(i.alert_at)}, {(outcomeName(i.outcome) || statusName[i.status]).toLowerCase()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </Panel>
    </main>
  );
}
