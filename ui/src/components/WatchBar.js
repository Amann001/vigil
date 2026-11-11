import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { now as clockNow } from "../lib/clock";
import { href } from "../lib/route";
import "./watchbar.css";
const PAGES = [
    { route: { page: "watch" }, label: "Watch" },
    { route: { page: "history" }, label: "Incidents" },
    { route: { page: "scores" }, label: "Scores" },
];
function useNow(ms = 1000) {
    const [now, setNow] = useState(() => new Date(clockNow()));
    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date(clockNow())), ms);
        return () => window.clearInterval(timer);
    }, [ms]);
    return now;
}
/**
 * The detector's last ten minutes as a strip of ticks: each tick is one 5-second reading, as
 * tall as it is unusual. Ticks past the alarm line turn amber; three in a row raise an alert.
 */
function DetectorStrip({ system }) {
    const values = system?.score?.values ?? [];
    const threshold = system?.score?.threshold ?? 1;
    const ticks = values.slice(-120);
    const width = 240;
    const height = 26;
    const step = width / 120;
    const last = ticks.at(-1) ?? 0;
    const ratio = threshold ? (last ?? 0) / threshold : 0;
    const mood = !system?.online ? "No metrics" : ratio >= 1 ? "Alarmed" : ratio >= 0.6 ? "Uneasy" : "Calm";
    const scale = (v) => Math.min(1, Math.log1p(v) / Math.log1p(threshold * 2.2));
    return (_jsxs("div", { className: "detector", tabIndex: 0, "aria-describedby": "detector-explainer", children: [_jsxs("svg", { width: width, height: height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `Detector: ${mood}`, children: [_jsx("line", { x1: "0", x2: width, y1: height - scale(threshold) * height, y2: height - scale(threshold) * height, className: "detector-line" }), ticks.map((v, i) => {
                        const h = v === null ? 2 : Math.max(2, scale(v) * height);
                        const x = width - (ticks.length - i) * step;
                        return (_jsx("rect", { x: x, y: height - h, width: Math.max(1, step - 0.8), height: h, className: v !== null && v >= threshold ? "tick tick-hot" : "tick" }, i));
                    })] }), _jsx("span", { className: `detector-mood mood-${mood.toLowerCase().replace(" ", "-")}`, children: mood }), _jsxs("div", { className: "detector-explainer", id: "detector-explainer", role: "tooltip", children: [_jsx("strong", { children: "The anomaly detector" }), _jsx("p", { children: "A machine-learning model reads 40 signals from the shop every 5 seconds. Each bar is one reading, as tall as it is unusual: the last ten minutes, newest on the right." }), _jsx("p", { children: "Bars past the dashed line turn amber. When readings stay past it, Vigil raises an alert and the agents start investigating. No fixed thresholds: it learned what normal looks like." })] })] }));
}
export function WatchBar({ route, system, mode, situation, }) {
    const now = useNow();
    const waiting = situation.pending.length + situation.replays.length;
    return (_jsxs("header", { className: "watchbar", children: [_jsxs("a", { className: "brand", href: href({ page: "watch" }), "aria-label": "Vigil, back to the watch", children: [_jsx("span", { className: `brand-eye eye-${situation.kind}`, "aria-hidden": "true" }), _jsx("span", { className: "brand-word", children: "Vigil" })] }), _jsx("nav", { className: "pages", "aria-label": "Pages", children: PAGES.map(({ route: target, label }) => {
                    const current = route.page === target.page || (route.page === "incident" && target.page === "history");
                    return (_jsxs("a", { href: href(target), "aria-current": current ? "page" : undefined, children: [label, target.page === "history" && waiting > 0 && _jsx("span", { className: "badge num", children: waiting })] }, label));
                }) }), _jsx(DetectorStrip, { system: system }), _jsxs("div", { className: "clock num", "aria-label": "Current time", children: [_jsx("span", { children: now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }), _jsxs("span", { className: "clock-utc", children: [now.toISOString().slice(11, 16), " UTC"] })] }), _jsx("span", { className: `mode mode-${mode}`, title: mode === "demo" ? "No API found: replaying a recorded incident" : "Connected to Vigil", children: mode === "demo" ? "Replay" : mode === "live" ? "Live" : "…" })] }));
}
