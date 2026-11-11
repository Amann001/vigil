import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from "motion/react";
import { Panel, RisingText } from "../components/Bits";
import "./scores.css";
/*
  The evaluation from docs/RESULTS.md. These are measured results, fixed at the time of the run,
  so they are kept here rather than fetched.
*/
const ABLATION = [
    { name: "Vigil", detail: "Supervisor and specialists, memory, models chosen per role", right: 11, unsafe: 1, tokens: 24.7, best: true },
    { name: "Without memory", detail: "Same team, no runbooks or past incidents", right: 9, unsafe: 0, tokens: 22.4 },
    { name: "One small model", detail: "The same small model in every role", right: 9, unsafe: 2, tokens: 26.8 },
    { name: "One agent alone", detail: "A single agent holding every tool", right: 8, unsafe: 4, tokens: 18.7 },
];
const FACTS = [
    { value: "12/12", label: "incidents detected on the public set, a median of 21 s after the fault began, with no false alarms" },
    { value: "13 s", label: "for a second worker to take over a killed worker's investigation and finish it from its checkpoint" },
    { value: "11/11", label: "right runbook recalled first for a diagnosis, by vector search over memory" },
    { value: "2.4 s → 95 ms", label: "payments response time after a reviewer-approved restart, seven minutes after the fault" },
    { value: "≈23,600", label: "tokens for a whole investigation: about 23 model calls on free tiers, in 41 s" },
    { value: "$0", label: "to run: free tiers of Gemini, Groq, Neon and Langfuse, under 5 GB of disk" },
];
export function Scores() {
    return (_jsx("main", { className: "scores", children: _jsxs(Panel, { className: "scores-panel", label: "How well Vigil does", children: [_jsxs("section", { className: "hidden-test", children: [_jsx("h1", { children: _jsx(RisingText, { text: "Five incidents nobody tuned it for. Five right." }) }), _jsx("p", { className: "lede", children: "Someone else wrote six failure scenarios; a separate agent turned them into tests the builder never saw. Vigil found the cause, the kind of failure and the right fix for all five incidents, left the sixth (not an incident) alone, proposed nothing unsafe and raised no false alarms." }), _jsxs("ol", { className: "tally", "aria-label": "Hidden test results", children: [[1, 2, 3, 4, 5].map((n) => (_jsx(motion.li, { className: "tally-mark is-right", initial: { scale: 0.4, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: { delay: 0.9 + n * 0.12, type: "spring", stiffness: 260, damping: 18 }, children: _jsxs("span", { className: "visually-hidden", children: ["Incident ", n, ": right"] }) }, n))), _jsx(motion.li, { className: "tally-mark is-quiet", initial: { scale: 0.4, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: { delay: 0.9 + 6 * 0.12, type: "spring", stiffness: 260, damping: 18 }, children: _jsx("span", { className: "visually-hidden", children: "Not an incident: correctly left alone" }) })] })] }), _jsxs("section", { className: "ablation", children: [_jsx("h2", { children: "What each part is worth" }), _jsx("p", { className: "lede", children: "14 public scenarios, 12 of them incidents, investigated by Vigil and by versions of it with one part removed. Bars count fully right answers: cause, kind of failure and fix." }), _jsx("ul", { className: "bars", children: ABLATION.map((row, i) => (_jsxs("li", { className: row.best ? "is-best" : "", children: [_jsxs("div", { className: "bar-label", children: [_jsx("strong", { children: row.name }), _jsx("span", { children: row.detail })] }), _jsxs("div", { className: "bar-track", "aria-hidden": "true", children: [_jsx(motion.div, { className: "bar-fill", initial: { width: 0 }, whileInView: { width: `${(row.right / 12) * 100}%` }, viewport: { once: true }, transition: { delay: 0.15 + i * 0.12, duration: 1.1, ease: [0.16, 1, 0.3, 1] } }), Array.from({ length: 11 }, (_, k) => (_jsx("span", { className: "bar-grid", style: { left: `${((k + 1) / 12) * 100}%` } }, k)))] }), _jsxs("div", { className: "bar-numbers num", children: [_jsxs("span", { className: "bar-right", children: [row.right, "/12"] }), _jsxs("span", { className: `bar-unsafe ${row.unsafe ? "has-unsafe" : ""}`, children: [row.unsafe, " unsafe ", row.unsafe === 1 ? "fix" : "fixes"] }), _jsxs("span", { className: "bar-tokens", children: [row.tokens, "k tokens"] })] })] }, row.name))) }), _jsx("p", { className: "footnote", children: "An unsafe fix restarts a service that was not the cause. Single runs on 12 incidents: a difference of one or two is a hint, not a result. The one-agent gap is the clearest." })] }), _jsxs("section", { className: "facts", children: [_jsx("h2", { children: "Measured along the way" }), _jsx("dl", { children: FACTS.map((f) => (_jsxs("div", { className: "fact", children: [_jsx("dt", { className: "num", children: f.value }), _jsx("dd", { children: f.label })] }, f.value))) })] })] }) }));
}
