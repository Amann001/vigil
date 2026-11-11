import { useEffect, useRef, useState } from "react";

/**
 * The war room's sound, made in the browser with the Web Audio API (no audio files): a low
 * ambient hum while sound is on, and short cues when something changes. Off until the viewer
 * turns it on, and remembered on this device.
 *
 *   alarm    an alert: two low notes, falling
 *   decide   a fix is waiting for a person: one soft bell
 *   fixed    the fix landed: a rising chord
 *   move     a page change: a short breath of filtered noise, with the camera's warp
 */

const KEY = "vigil.sound";
const listeners = new Set<(on: boolean) => void>();

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let hum: { stop: () => void } | null = null;

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

let enabled = stored();

function audio(): { ctx: AudioContext; out: GainNode } | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.7;
    // A gentle limiter, so overlapping cues never clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    master.connect(limiter).connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return { ctx, out: master! };
}

function note(freq: number, at: number, length: number, { type = "sine" as OscillatorType, gain = 0.12 } = {}) {
  const a = audio();
  if (!a) return;
  const start = a.ctx.currentTime + at;
  const osc = a.ctx.createOscillator();
  const env = a.ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(gain, start + 0.015);
  env.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(env).connect(a.out);
  osc.start(start);
  osc.stop(start + length + 0.05);
}

function startHum() {
  const a = audio();
  if (!a || hum) return;
  const { ctx: c, out } = a;
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 320;
  const level = c.createGain();
  level.gain.setValueAtTime(0, c.currentTime);
  level.gain.linearRampToValueAtTime(0.045, c.currentTime + 3);
  // A slow drift of the filter keeps the hum from sounding like a machine left on.
  const lfo = c.createOscillator();
  const depth = c.createGain();
  lfo.frequency.value = 0.07;
  depth.gain.value = 120;
  lfo.connect(depth).connect(filter.frequency);
  const voices = [55, 82.41, 110.3].map((f, i) => {
    const o = c.createOscillator();
    o.type = i === 2 ? "triangle" : "sine";
    o.frequency.value = f;
    o.detune.value = (i - 1) * 6;
    o.connect(filter);
    o.start();
    return o;
  });
  filter.connect(level).connect(out);
  lfo.start();
  hum = {
    stop: () => {
      const end = c.currentTime + 0.8;
      level.gain.cancelScheduledValues(c.currentTime);
      level.gain.setValueAtTime(level.gain.value, c.currentTime);
      level.gain.linearRampToValueAtTime(0, end);
      [...voices, lfo].forEach((o) => o.stop(end + 0.05));
    },
  };
}

function stopHum() {
  hum?.stop();
  hum = null;
}

export const sounds = {
  alarm() {
    if (!enabled) return;
    note(440, 0, 0.5, { type: "triangle", gain: 0.1 });
    note(329.6, 0.22, 0.8, { type: "triangle", gain: 0.1 });
  },
  decide() {
    if (!enabled) return;
    note(880, 0, 1.4, { gain: 0.07 });
    note(1318.5, 0.01, 1.0, { gain: 0.03 });
  },
  fixed() {
    if (!enabled) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(f, i * 0.09, 1.3 - i * 0.15, { gain: 0.06 }));
  },
  move() {
    const a = enabled ? audio() : null;
    if (!a) return;
    const { ctx: c, out } = a;
    const length = 0.5;
    const buffer = c.createBuffer(1, Math.floor(c.sampleRate * length), c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = c.createBufferSource();
    noise.buffer = buffer;
    const band = c.createBiquadFilter();
    band.type = "bandpass";
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(300, c.currentTime);
    band.frequency.exponentialRampToValueAtTime(2200, c.currentTime + length);
    const env = c.createGain();
    env.gain.setValueAtTime(0, c.currentTime);
    env.gain.linearRampToValueAtTime(0.05, c.currentTime + 0.12);
    env.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + length);
    noise.connect(band).connect(env).connect(out);
    noise.start();
  },
};

export function setSound(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* not remembered; still works for this visit */
  }
  if (on) startHum();
  else stopHum();
  listeners.forEach((listener) => listener(on));
}

export function useSound(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(enabled);
  useEffect(() => {
    listeners.add(setOn);
    return () => void listeners.delete(setOn);
  }, []);
  return [on, setSound];
}

/**
 * Browsers only allow sound after the viewer has interacted with the page, so a remembered
 * "on" starts the hum at the first click or key press.
 */
export function useSoundStart() {
  useEffect(() => {
    if (!enabled) return;
    const start = () => enabled && startHum();
    window.addEventListener("pointerdown", start, { once: true });
    window.addEventListener("keydown", start, { once: true });
    return () => {
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
    };
  }, []);
}

/** Plays the cue for each change in what the war room is about (not for the first state). */
export function useSoundCues(kind: string, page: string) {
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = kind;
    if (before === null || before === kind) return;
    if (kind === "investigating") sounds.alarm();
    else if (kind === "decide") sounds.decide();
    else if (kind === "recovered") sounds.fixed();
  }, [kind]);
  const lastPage = useRef(page);
  useEffect(() => {
    if (lastPage.current !== page) sounds.move();
    lastPage.current = page;
  }, [page]);
}
