/**
 * The war room's sense of "now". Live, it is the wall clock; in the replay, it is the moment of
 * the recording being shown, so "started 40 s ago" stays true while the replay runs faster
 * than real time.
 */
let source: (() => number) | null = null;

export function now(): number {
  return source ? source() : Date.now();
}

export function setClock(clock: (() => number) | null): void {
  source = clock;
}
