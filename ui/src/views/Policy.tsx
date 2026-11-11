import { Panel, RisingText } from "../components/Bits";
import { api, usePoll } from "../lib/api";
import { href } from "../lib/route";
import "./pages.css";
import "./policy.css";

const ACTION_NAMES: Record<string, string> = {
  restart_service: "Restart a service",
  escalate: "Escalate to an engineer",
  no_action: "Change nothing",
};

const ROLE_NAMES: Record<string, [string, string]> = {
  planner: ["Supervisor", "Splits the alert into questions"],
  metrics: ["Metrics agent", "Reads Prometheus"],
  logs: ["Logs agent", "Reads the logs"],
  deploy: ["Changes agent", "Restarts, downtime, build-up"],
  diagnosis: ["Diagnosis", "Names the root cause"],
  remediation: ["Remediation agent", "Proposes one fix"],
  comms: ["Comms agent", "Writes the report"],
};

function model(name: string): string {
  return name.split("/").pop() ?? name;
}

/**
 * What Vigil is allowed to do and who must agree, read from the running code (GET /config):
 * change a guardrail there and this page changes with it.
 */
export function Policy({ mode }: { mode: "live" | "demo" | "unknown" }) {
  const config = usePoll(api.config, 30000, mode).data;
  return (
    <main className="doc">
      <Panel className="doc-panel" label="Policy">
        <header className="doc-head">
          <h1>
            <RisingText text="What Vigil may do" />
          </h1>
          <p className="doc-lede">
            The agents can read anything. Changing the shop is a short list of actions, each needing a person's yes and
            checked by plain code before it runs. Read from the running system, not written by hand.
          </p>
        </header>

        {!config ? (
          <p className="doc-note">Loading…</p>
        ) : (
          <>
            <section className="doc-section">
              <h2>Guardrails</h2>
              <ul className="rules">
                <li>
                  <strong>A person approves every change.</strong> The agents only propose; nothing runs until someone confirms
                  the diagnosis and approves the fix{config.reviews_enabled ? ", with the API token" : ""}.
                </li>
                <li>
                  <strong>Only actions from the catalogue.</strong> Anything else an agent suggests is refused, whatever it
                  says.
                </li>
                <li>
                  <strong>One restart per service every {config.guardrails.restart_cooldown_minutes} minutes.</strong> A second
                  restart inside that window is refused: a fix that does not hold needs a person to look again.
                </li>
                <li>
                  <strong>Every decision is written down.</strong> Approved, rejected or blocked, it goes to the{" "}
                  <a href={href({ page: "audit" })}>audit log</a>.
                </li>
                <li>
                  <strong>The language models never touch the shop.</strong> They read through tools and answer in text; only
                  the guardrails' code can act.
                </li>
              </ul>
            </section>

            <section className="doc-section">
              <h2>The catalogue</h2>
              <ul className="catalogue">
                {config.actions.map((a) => (
                  <li key={a.name}>
                    <div>
                      <strong>{ACTION_NAMES[a.name] ?? a.name}</strong>
                      <span className={`pill ${a.changes_system ? "pill-sodium" : ""}`}>
                        {a.changes_system ? "Changes the shop" : "Changes nothing"}
                      </span>
                    </div>
                    <p>{a.description}</p>
                  </li>
                ))}
              </ul>
            </section>

            <section className="doc-section">
              <h2>Who runs each step</h2>
              <p className="doc-note">The first model answers; if it fails or is busy, the next one takes over.</p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Step</th>
                      <th>First choice</th>
                      <th>Fallbacks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(config.models).map(([role, models]) => (
                      <tr key={role}>
                        <td>
                          <strong>{ROLE_NAMES[role]?.[0] ?? role}</strong>
                          <br />
                          <span className="doc-note">{ROLE_NAMES[role]?.[1]}</span>
                        </td>
                        <td>
                          <code>{model(models[0])}</code>
                        </td>
                        <td>
                          {models.slice(1).map((m) => (
                            <code key={m} className="fallback">
                              {model(m)}
                            </code>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="doc-section">
              <h2>When it raises an alert</h2>
              <dl className="stats">
                <div className="stat">
                  <dt>Method</dt>
                  <dd>Robust z-score</dd>
                  <small>Learned from healthy traffic</small>
                </div>
                <div className="stat">
                  <dt>Line</dt>
                  <dd className="num">{(config.detector.quantile * 100).toFixed(1)}%</dd>
                  <small>Only this share of healthy readings score lower</small>
                </div>
                <div className="stat">
                  <dt>Confirmation</dt>
                  <dd className="num">{config.detector.points_in_a_row} in a row</dd>
                  <small>Readings past the line before it pages</small>
                </div>
                <div className="stat">
                  <dt>Reads</dt>
                  <dd className="num">Every {config.detector.every_seconds} s</dd>
                  <small>40 signals from Prometheus</small>
                </div>
              </dl>
            </section>
          </>
        )}
      </Panel>
    </main>
  );
}
