import { Panel, RisingText } from "../components/Bits";
import { href } from "../lib/route";
import "./pages.css";
import "./run.css";

const REPO = "https://github.com/Amann001/vigil";
const CODESPACE = "https://codespaces.new/Amann001/vigil";

/** Three ways to run Vigil, from watching to owning, and what it takes to point it at a new system. */
export function Run() {
  return (
    <main className="doc run-page">
      <Panel className="doc-panel" label="Run it">
        <header className="doc-head">
          <h1>
            <RisingText text="Run it yourself" />
          </h1>
          <p className="doc-lede">Free to run, end to end. Pick how close you want to get.</p>
        </header>

        <ol className="ways">
          <li>
            <span className="way-when">Now</span>
            <h2>Watch the replay</h2>
            <p>A real incident, recorded. Nothing to install.</p>
            <a className="button" href={href({ page: "watch" })}>
              Open the war room
            </a>
          </li>
          <li>
            <span className="way-when">5 minutes</span>
            <h2>Start the live system</h2>
            <p>The shop, Prometheus, the agents and the war room, in a free GitHub Codespace.</p>
            <a className="button button-primary" href={CODESPACE} target="_blank" rel="noreferrer">
              Create a codespace
            </a>
          </li>
          <li>
            <span className="way-when">On your machine</span>
            <h2>Clone and run</h2>
            <pre className="run-code">
              <code>{`git clone ${REPO}.git
cd vigil && uv sync
uv run python -m shop.launch
uv run vigil up`}</code>
            </pre>
          </li>
        </ol>

        <section className="doc-section">
          <h2>What it plugs into</h2>
          <dl className="fits">
            <div>
              <dt>Reads</dt>
              <dd>Prometheus metrics, JSON logs, restarts and deploys</dd>
            </div>
            <div>
              <dt>Thinks with</dt>
              <dd>Gemini and Groq on free tiers, with fallbacks</dd>
            </div>
            <div>
              <dt>Remembers in</dt>
              <dd>Postgres with pgvector, or local files</dd>
            </div>
            <div>
              <dt>Acts through</dt>
              <dd>
                A fixed catalogue, after a person approves (<a href={href({ page: "policy" })}>the policy</a>)
              </dd>
            </div>
          </dl>
        </section>

        <section className="doc-section">
          <h2>On your own services</h2>
          <p className="doc-note run-honest">
            Vigil is built and tested on its demo shop. A new system needs its services and who calls whom listed, a
            restart for each, and a healthy day of its traffic to learn what normal looks like.
          </p>
          <a className="link-button" href={REPO} target="_blank" rel="noreferrer">
            Read the code on GitHub
          </a>
        </section>
      </Panel>
    </main>
  );
}
