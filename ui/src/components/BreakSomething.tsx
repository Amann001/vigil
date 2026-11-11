import { motion } from "motion/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiError, getToken } from "../lib/api";
import { SERVICES, type Service } from "../lib/types";
import { serviceName } from "../lib/words";
import { TokenField } from "./TokenField";
import "./drawer.css";

const FAULTS = [
  { id: "latency", label: "Slow it down", detail: "Every request takes 1.5 s longer.", body: { fault: "latency", latency_seconds: 1.5 } },
  { id: "errors", label: "Make requests fail", detail: "Half of its requests return an error.", body: { fault: "errors", error_rate: 0.5 } },
  { id: "leak", label: "Leak memory", detail: "10 MB a second until it is killed at 600 MB.", body: { fault: "leak", leak_mb_per_second: 10, leak_limit_mb: 600 } },
  { id: "crash", label: "Crash it", detail: "The process stops at once.", body: { fault: "crash" } },
  { id: "cpu", label: "Max out its CPU", detail: "Each request burns 50 ms of CPU.", body: { fault: "cpu", cpu_seconds: 0.05 } },
] as const;

/**
 * The demo control: inject a real fault into the running shop and watch Vigil find it. The
 * fault stays until the service restarts, so it is only fixed if Vigil's fix is approved.
 */
export function BreakSomething({ onClose, initial = "payments" }: { onClose: () => void; initial?: Service }) {
  const [service, setService] = useState<Service>(initial);
  const [fault, setFault] = useState<(typeof FAULTS)[number]["id"]>("latency");
  const [state, setState] = useState<{ kind: "idle" | "sending" | "done" | "error"; message?: string }>({ kind: "idle" });
  const [hasToken, setHasToken] = useState(Boolean(getToken()));
  const chosen = FAULTS.find((f) => f.id === fault)!;

  async function submit() {
    setState({ kind: "sending" });
    try {
      await api.breakService(service, { ...chosen.body });
      setState({ kind: "done", message: `${serviceName[service]}: ${chosen.label.toLowerCase()}. The detector should notice within a minute.` });
    } catch (e) {
      const error = e as ApiError;
      if (error.status === 401) setHasToken(false);
      setState({ kind: "error", message: error.message });
    }
  }

  // Rendered at the end of the page, so it covers the top bar too.
  return createPortal(
    <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="break-title"
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
      >
        <h2 id="break-title">Break something</h2>
        <p className="drawer-intro">
          Inject a real fault into the running shop. Nothing tells Vigil what you did: it has to notice from the
          metrics and logs, find the cause, and ask you before fixing it.
        </p>

        <fieldset>
          <legend>Which service</legend>
          <div className="choice-row">
            {SERVICES.map((s) => (
              <button key={s} className="chip" aria-pressed={service === s} onClick={() => setService(s)} autoFocus={s === "payments"}>
                {serviceName[s]}
              </button>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>What goes wrong</legend>
          <div className="choice-list">
            {FAULTS.map((f) => (
              <button key={f.id} className="choice" aria-pressed={fault === f.id} onClick={() => setFault(f.id)}>
                <strong>{f.label}</strong>
                <span>{f.detail}</span>
              </button>
            ))}
          </div>
        </fieldset>

        {!hasToken && <TokenField onSaved={() => setHasToken(true)} />}

        <div className="drawer-actions">
          <button className="button button-danger" onClick={submit} disabled={!hasToken || state.kind === "sending"}>
            {state.kind === "sending" ? "Breaking…" : `Break ${serviceName[service]}`}
          </button>
          <button className="button button-ghost" onClick={onClose}>
            {state.kind === "done" ? "Watch it happen" : "Cancel"}
          </button>
        </div>
        {state.message && (
          <p className={`drawer-note note-${state.kind}`} role="status">
            {state.message}
          </p>
        )}
      </motion.div>
    </motion.div>,
    document.body,
  );
}
