import { useEffect, useState } from "react";
import { now as clockNow } from "../lib/clock";
import { href, type Route } from "../lib/route";
import type { Situation } from "../lib/state";
import type { SystemView } from "../lib/types";
import "./watchbar.css";

const PAGES: { route: Route; label: string }[] = [
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
function DetectorStrip({ system }: { system: SystemView | null }) {
  const values = system?.score?.values ?? [];
  const threshold = system?.score?.threshold ?? 1;
  const ticks = values.slice(-120);
  const width = 240;
  const height = 26;
  const step = width / 120;
  const last = ticks.at(-1) ?? 0;
  const ratio = threshold ? (last ?? 0) / threshold : 0;
  const mood = !system?.online ? "No metrics" : ratio >= 1 ? "Alarmed" : ratio >= 0.6 ? "Uneasy" : "Calm";
  const scale = (v: number) => Math.min(1, Math.log1p(v) / Math.log1p(threshold * 2.2));
  return (
    <div className="detector" tabIndex={0} aria-describedby="detector-explainer">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Detector: ${mood}`}>
        <line x1="0" x2={width} y1={height - scale(threshold) * height} y2={height - scale(threshold) * height} className="detector-line" />
        {ticks.map((v, i) => {
          const h = v === null ? 2 : Math.max(2, scale(v) * height);
          const x = width - (ticks.length - i) * step;
          return (
            <rect
              key={i}
              x={x}
              y={height - h}
              width={Math.max(1, step - 0.8)}
              height={h}
              className={v !== null && v >= threshold ? "tick tick-hot" : "tick"}
            />
          );
        })}
      </svg>
      <span className={`detector-mood mood-${mood.toLowerCase().replace(" ", "-")}`}>{mood}</span>
      <div className="detector-explainer" id="detector-explainer" role="tooltip">
        <strong>The anomaly detector</strong>
        <p>
          A machine-learning model reads 40 signals from the shop every 5 seconds. Each bar is one
          reading, as tall as it is unusual: the last ten minutes, newest on the right.
        </p>
        <p>
          Bars past the dashed line turn amber. When readings stay past it, Vigil raises an alert
          and the agents start investigating. No fixed thresholds: it learned what normal looks like.
        </p>
      </div>
    </div>
  );
}

export function WatchBar({
  route,
  system,
  mode,
  situation,
}: {
  route: Route;
  system: SystemView | null;
  mode: "live" | "demo" | "unknown";
  situation: Situation;
}) {
  const now = useNow();
  const waiting = situation.pending.length + situation.replays.length;
  return (
    <header className="watchbar">
      <a className="brand" href={href({ page: "watch" })} aria-label="Vigil, back to the watch">
        <span className={`brand-eye eye-${situation.kind}`} aria-hidden="true" />
        <span className="brand-word">Vigil</span>
      </a>
      <nav className="pages" aria-label="Pages">
        {PAGES.map(({ route: target, label }) => {
          const current = route.page === target.page || (route.page === "incident" && target.page === "history");
          return (
            <a key={label} href={href(target)} aria-current={current ? "page" : undefined}>
              {label}
              {target.page === "history" && waiting > 0 && <span className="badge num">{waiting}</span>}
            </a>
          );
        })}
      </nav>
      <DetectorStrip system={system} />
      <div className="clock num" aria-label="Current time">
        <span>{now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
        <span className="clock-utc">
          {now.toISOString().slice(11, 16)} UTC
        </span>
      </div>
      <span className={`mode mode-${mode}`} title={mode === "demo" ? "No API found: replaying a recorded incident" : "Connected to Vigil"}>
        {mode === "demo" ? "Replay" : mode === "live" ? "Live" : "…"}
      </span>
    </header>
  );
}
