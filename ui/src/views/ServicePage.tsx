import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Panel, RisingText, Sparkline } from "../components/Bits";
import { BreakSomething } from "../components/BreakSomething";
import { go, href } from "../lib/route";
import type { Situation } from "../lib/state";
import { SERVICES, type InvestigationSummary, type Service, type SystemView } from "../lib/types";
import { ago, calls, formatValue, headline, outcomeName, serviceName, serviceRole, serviceStory, statusName } from "../lib/words";
import "./service.css";

const VITALS: { key: string; label: string }[] = [
  { key: "latency_p95", label: "Response time, p95" },
  { key: "error_ratio", label: "Requests failing" },
  { key: "memory_mb", label: "Memory" },
  { key: "request_rate", label: "Requests" },
];

/**
 * One star's own page: what the service does, how it is right now, who it talks to and what
 * has gone wrong with it before. The camera flies in close to the star beside it.
 */
export function ServicePage({
  service,
  system,
  list,
  situation,
  mode,
}: {
  service: Service;
  system: SystemView | null;
  list: InvestigationSummary[] | null;
  situation: Situation;
  mode: "live" | "demo" | "unknown";
}) {
  const [breaking, setBreaking] = useState(false);
  const view = system?.services?.[service];
  const down = Boolean(system?.online && view && view.latest.up === null);
  const tone = down ? "flare" : situation.focus?.service === service ? situation.focus.tone : "calm";
  const state = down
    ? "Not responding"
    : tone === "sodium"
      ? "Under investigation"
      : tone === "aurora"
        ? "Recovered"
        : system?.online === false
          ? "No signal"
          : "Healthy";
  const calledBy = SERVICES.filter((s) => calls[s].includes(service));
  const incidents = (list ?? []).filter((i) => i.root_cause_service === service);
  const index = SERVICES.indexOf(service);
  const previous = SERVICES[(index + SERVICES.length - 1) % SERVICES.length];
  const next = SERVICES[(index + 1) % SERVICES.length];

  // The arrow keys walk round the constellation.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest?.("input, textarea, select")) return;
      if (event.key === "ArrowRight") go({ page: "service", service: next });
      if (event.key === "ArrowLeft") go({ page: "service", service: previous });
      if (event.key === "Escape") go({ page: "watch" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, previous]);

  return (
    <main className="service-page">
      <Panel className="service-panel" label={`${serviceName[service]}, one of the shop's services`}>
        <a className="back" href={href({ page: "watch" })}>
          War room
        </a>
        <header className="service-head">
          <p className={`service-state state-${tone}`}>
            <span className={`dot dot-${tone}`} aria-hidden="true" />
            {state}
          </p>
          <h1 className="service-name">
            <RisingText key={service} text={serviceName[service]} />
          </h1>
          <p className="service-role">{serviceRole[service]}</p>
        </header>
        <p className="service-story">{serviceStory[service]}</p>

        <dl className="service-vitals">
          {VITALS.map(({ key, label }, i) => (
            <motion.div
              key={key}
              className="service-vital"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 + i * 0.06, duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            >
              <dt>{label}</dt>
              <dd className="num">{down ? "no data" : formatValue(`x.${key}`, view?.latest[key as keyof typeof view.latest] ?? null)}</dd>
              <Sparkline values={view?.series[key] ?? []} tone={tone} width={220} height={40} />
            </motion.div>
          ))}
        </dl>
        <p className="service-note">The last ten minutes, read every 5 seconds.</p>

        <section className="service-links" aria-label="Who it talks to">
          <h2>Talks to</h2>
          <p>
            {calls[service].length ? (
              <>
                Calls{" "}
                {calls[service].map((s, i) => (
                  <span key={s}>
                    {i > 0 && " and "}
                    <a href={href({ page: "service", service: s as Service })}>{serviceName[s]}</a>
                  </span>
                ))}
                .{" "}
              </>
            ) : (
              "Calls nothing else. "
            )}
            {calledBy.length ? (
              <>
                Called by{" "}
                {calledBy.map((s, i) => (
                  <span key={s}>
                    {i > 0 && " and "}
                    <a href={href({ page: "service", service: s })}>{serviceName[s]}</a>
                  </span>
                ))}
                .
              </>
            ) : (
              "Customers call it directly."
            )}
          </p>
        </section>

        <section className="service-incidents" aria-label="Incidents">
          <h2>Incidents caused here</h2>
          {incidents.length === 0 ? (
            <p className="service-none">None so far.</p>
          ) : (
            <ul>
              {incidents.slice(0, 4).map((i) => (
                <li key={i.id}>
                  <a href={href({ page: "incident", id: i.id })}>
                    <strong>
                      {i.root_cause_service && i.category
                        ? headline({ root_cause_service: i.root_cause_service, category: i.category })
                        : "Incident"}
                    </strong>
                    <span>
                      {ago(i.alert_at)}, {(outcomeName(i.outcome) || statusName[i.status]).toLowerCase()}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        {mode === "live" ? (
          <button className="button button-danger service-break" onClick={() => setBreaking(true)}>
            Break {serviceName[service]}
          </button>
        ) : (
          <p className="service-none">
            This is a replay, so nothing here can be broken. Run Vigil on your machine to break {serviceName[service]} and watch it
            get fixed.
          </p>
        )}

        <nav className="service-walk" aria-label="Other services">
          <a href={href({ page: "service", service: previous })} rel="prev">
            <span aria-hidden="true">‹</span> {serviceName[previous]}
          </a>
          <span className="service-keys">Use the arrow keys</span>
          <a href={href({ page: "service", service: next })} rel="next">
            {serviceName[next]} <span aria-hidden="true">›</span>
          </a>
        </nav>
      </Panel>
      <AnimatePresence>
        {breaking && <BreakSomething initial={service} onClose={() => setBreaking(false)} />}
      </AnimatePresence>
    </main>
  );
}
