/**
 * The war room's sense of "now". Live, it is the wall clock; in the replay, it is the moment of
 * the recording being shown, so "started 40 s ago" stays true while the replay runs faster
 * than real time.
 */
let source = null;
export function now() {
    return source ? source() : Date.now();
}
export function setClock(clock) {
    source = clock;
}
