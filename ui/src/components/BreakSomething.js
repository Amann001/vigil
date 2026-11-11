import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from "motion/react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { api, getToken } from "../lib/api";
import { SERVICES } from "../lib/types";
import { serviceName } from "../lib/words";
import { TokenField } from "./TokenField";
import "./drawer.css";
const FAULTS = [
    { id: "latency", label: "Slow it down", detail: "Every request takes 1.5 s longer.", body: { fault: "latency", latency_seconds: 1.5 } },
    { id: "errors", label: "Make requests fail", detail: "Half of its requests return an error.", body: { fault: "errors", error_rate: 0.5 } },
    { id: "leak", label: "Leak memory", detail: "10 MB a second until it is killed at 600 MB.", body: { fault: "leak", leak_mb_per_second: 10, leak_limit_mb: 600 } },
    { id: "crash", label: "Crash it", detail: "The process stops at once.", body: { fault: "crash" } },
    { id: "cpu", label: "Max out its CPU", detail: "Each request burns 50 ms of CPU.", body: { fault: "cpu", cpu_seconds: 0.05 } },
];
/**
 * The demo control: inject a real fault into the running shop and watch Vigil find it. The
 * fault stays until the service restarts, so it is only fixed if Vigil's fix is approved.
 */
export function BreakSomething({ onClose }) {
    const [service, setService] = useState("payments");
    const [fault, setFault] = useState("latency");
    const [state, setState] = useState({ kind: "idle" });
    const [hasToken, setHasToken] = useState(Boolean(getToken()));
    const chosen = FAULTS.find((f) => f.id === fault);
    async function submit() {
        setState({ kind: "sending" });
        try {
            await api.breakService(service, { ...chosen.body });
            setState({ kind: "done", message: `${serviceName[service]}: ${chosen.label.toLowerCase()}. The detector should notice within a minute.` });
        }
        catch (e) {
            const error = e;
            if (error.status === 401)
                setHasToken(false);
            setState({ kind: "error", message: error.message });
        }
    }
    // Rendered at the end of the page, so it covers the top bar too.
    return createPortal(_jsx(motion.div, { className: "scrim", initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, onClick: onClose, children: _jsxs(motion.div, { className: "drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": "break-title", initial: { x: 40, opacity: 0 }, animate: { x: 0, opacity: 1 }, exit: { x: 40, opacity: 0 }, transition: { duration: 0.45, ease: [0.16, 1, 0.3, 1] }, onClick: (e) => e.stopPropagation(), onKeyDown: (e) => e.key === "Escape" && onClose(), children: [_jsx("h2", { id: "break-title", children: "Break something" }), _jsx("p", { className: "drawer-intro", children: "Inject a real fault into the running shop. Nothing tells Vigil what you did: it has to notice from the metrics and logs, find the cause, and ask you before fixing it." }), _jsxs("fieldset", { children: [_jsx("legend", { children: "Which service" }), _jsx("div", { className: "choice-row", children: SERVICES.map((s) => (_jsx("button", { className: "chip", "aria-pressed": service === s, onClick: () => setService(s), autoFocus: s === "payments", children: serviceName[s] }, s))) })] }), _jsxs("fieldset", { children: [_jsx("legend", { children: "What goes wrong" }), _jsx("div", { className: "choice-list", children: FAULTS.map((f) => (_jsxs("button", { className: "choice", "aria-pressed": fault === f.id, onClick: () => setFault(f.id), children: [_jsx("strong", { children: f.label }), _jsx("span", { children: f.detail })] }, f.id))) })] }), !hasToken && _jsx(TokenField, { onSaved: () => setHasToken(true) }), _jsxs("div", { className: "drawer-actions", children: [_jsx("button", { className: "button button-danger", onClick: submit, disabled: !hasToken || state.kind === "sending", children: state.kind === "sending" ? "Breaking…" : `Break ${serviceName[service]}` }), _jsx("button", { className: "button button-ghost", onClick: onClose, children: state.kind === "done" ? "Watch it happen" : "Cancel" })] }), state.message && (_jsx("p", { className: `drawer-note note-${state.kind}`, role: "status", children: state.message }))] }) }), document.body);
}
