import { useEffect, useState } from "react";
import { replay, type ReplayState } from "../lib/demo";
import "./replaybar.css";

const SPEEDS = [1, 2, 4];

function minutes(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Controls for the public replay: play or pause, drag through the recorded incident, jump to
 * its turning points and change the speed. Times are minutes into the recording.
 */
export function ReplayBar() {
  const [state, setState] = useState<ReplayState | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () => replay.state().then((s) => alive && setState(s), () => {});
    read();
    const timer = window.setInterval(read, 250);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!state) return null;
  const span = state.end - state.start || 1;
  const at = (t: number) => `${((t - state.start) / span) * 100}%`;
  const seek = (t: number) => {
    void replay.seek(t);
    setState({ ...state, position: t });
  };

  return (
    <div className="replaybar" role="group" aria-label="Replay controls">
      <button
        className="replay-play"
        onClick={() => {
          void replay.setPaused(!state.paused);
          setState({ ...state, paused: !state.paused });
        }}
        aria-label={state.paused ? "Play the replay" : "Pause the replay"}
      >
        <span className={state.paused ? "icon-play" : "icon-pause"} aria-hidden="true" />
      </button>
      <div className="replay-track">
        <div className="replay-markers">
          {state.markers.map((m) => (
            <button
              key={m.label}
              className={`replay-marker${state.position >= m.t ? " is-past" : ""}`}
              style={{ left: at(m.t) }}
              onClick={() => seek(m.t)}
              title={`Jump to: ${m.label}`}
            >
              <span>{m.label}</span>
            </button>
          ))}
        </div>
        <input
          type="range"
          min={state.start}
          max={state.end}
          step={0.5}
          value={state.position}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Position in the recording"
          aria-valuetext={`${minutes(state.position - state.start)} of ${minutes(span)}`}
          style={{ "--fill": at(state.position) } as React.CSSProperties}
        />
      </div>
      <span className="replay-time num">
        {state.waiting ? "Waiting for you" : `${minutes(state.position - state.start)} / ${minutes(span)}`}
      </span>
      <div className="replay-speeds" role="group" aria-label="Speed">
        {SPEEDS.map((speed) => (
          <button
            key={speed}
            aria-pressed={state.speed === speed}
            onClick={() => {
              void replay.setSpeed(speed);
              setState({ ...state, speed });
            }}
          >
            {speed}×
          </button>
        ))}
      </div>
    </div>
  );
}
