import { useEffect, useRef, useState } from "react";
import { demo } from "./demo";
/**
 * The war room reads Vigil's API on the same origin. When there is no API (the public demo,
 * served as static files), it switches to a replay of a real recorded incident instead.
 */
const TOKEN_KEY = "vigil.token";
export class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
let mode = "unknown";
const listeners = new Set();
async function detectMode() {
    if (mode !== "unknown")
        return mode;
    try {
        const response = await fetch("/health", { headers: { Accept: "application/json" } });
        const body = response.ok ? await response.json() : null;
        mode = body?.status === "ok" ? "live" : "demo";
    }
    catch {
        mode = "demo";
    }
    listeners.forEach((listener) => listener(mode));
    return mode;
}
export function useMode() {
    const [current, setCurrent] = useState(mode);
    useEffect(() => {
        listeners.add(setCurrent);
        detectMode().then(setCurrent);
        return () => {
            listeners.delete(setCurrent);
        };
    }, []);
    return current;
}
async function get(path) {
    if ((await detectMode()) === "demo")
        return (await demo.get(path));
    const response = await fetch(path, { headers: { Accept: "application/json" } });
    if (!response.ok)
        throw new ApiError(response.status, await errorText(response));
    return response.json();
}
async function errorText(response) {
    try {
        const body = await response.json();
        return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    }
    catch {
        return response.statusText;
    }
}
export function getToken() {
    try {
        return sessionStorage.getItem(TOKEN_KEY);
    }
    catch {
        return null;
    }
}
export function setToken(token) {
    try {
        if (token)
            sessionStorage.setItem(TOKEN_KEY, token);
        else
            sessionStorage.removeItem(TOKEN_KEY);
    }
    catch {
        /* private mode: the token is asked for again next time */
    }
}
async function send(method, path, body) {
    if ((await detectMode()) === "demo")
        return demo.send(method, path, body);
    const response = await fetch(path, {
        method,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${getToken() ?? ""}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok)
        throw new ApiError(response.status, await errorText(response));
    return response.json();
}
export const api = {
    system: () => get("/system"),
    investigations: () => get("/investigations"),
    investigation: (id) => get(`/investigations/${encodeURIComponent(id)}`),
    live: () => get("/live"),
    audit: () => get("/audit"),
    review: (id, decision) => send("POST", `/investigations/${encodeURIComponent(id)}/review`, decision),
    breakService: (service, fault) => send("POST", `/chaos/${service}`, fault),
    healService: (service) => send("DELETE", `/chaos/${service}`),
};
/** Poll an endpoint while the page is visible. Keeps the last good value through errors. */
export function usePoll(load, ms, key = null) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const loadRef = useRef(load);
    loadRef.current = load;
    useEffect(() => {
        let alive = true;
        let timer;
        const tick = async () => {
            if (document.visibilityState === "visible") {
                try {
                    const value = await loadRef.current();
                    if (alive) {
                        setData(value);
                        setError(null);
                    }
                }
                catch (e) {
                    if (alive)
                        setError(e);
                }
            }
            if (alive)
                timer = window.setTimeout(tick, ms);
        };
        setData(null);
        tick();
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [ms, key]);
    return { data, error };
}
