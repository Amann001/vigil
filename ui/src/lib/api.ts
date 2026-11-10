import { useEffect, useRef, useState } from "react";
import type { AuditEntry, Investigation, InvestigationSummary, Service, SystemView } from "./types";
import { demo } from "./demo";

/**
 * The war room reads Vigil's API on the same origin. When there is no API (the public demo,
 * served as static files), it switches to a replay of a real recorded incident instead.
 */

const TOKEN_KEY = "vigil.token";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let mode: "live" | "demo" | "unknown" = "unknown";
const listeners = new Set<(m: "live" | "demo") => void>();

async function detectMode(): Promise<"live" | "demo"> {
  if (mode !== "unknown") return mode;
  try {
    const response = await fetch("/health", { headers: { Accept: "application/json" } });
    const body = response.ok ? await response.json() : null;
    mode = body?.status === "ok" ? "live" : "demo";
  } catch {
    mode = "demo";
  }
  listeners.forEach((listener) => listener(mode as "live" | "demo"));
  return mode;
}

export function useMode(): "live" | "demo" | "unknown" {
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

async function get<T>(path: string): Promise<T> {
  if ((await detectMode()) === "demo") return (await demo.get(path)) as T;
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new ApiError(response.status, await errorText(response));
  return response.json();
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
  } catch {
    return response.statusText;
  }
}

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the token is asked for again next time */
  }
}

async function send(method: "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  if ((await detectMode()) === "demo") return demo.send(method, path, body);
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken() ?? ""}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new ApiError(response.status, await errorText(response));
  return response.json();
}

export interface ReviewDecision {
  verdict: "confirmed" | "corrected";
  notes: string;
  approve: boolean;
  restart: Service | null;
  by: string;
}

export const api = {
  system: () => get<SystemView>("/system"),
  investigations: () => get<InvestigationSummary[]>("/investigations"),
  investigation: (id: string) => get<Investigation>(`/investigations/${encodeURIComponent(id)}`),
  live: () => get<Investigation[]>("/live"),
  audit: () => get<AuditEntry[]>("/audit"),
  review: (id: string, decision: ReviewDecision) =>
    send("POST", `/investigations/${encodeURIComponent(id)}/review`, decision),
  breakService: (service: Service, fault: Record<string, unknown>) =>
    send("POST", `/chaos/${service}`, fault),
  healService: (service: Service) => send("DELETE", `/chaos/${service}`),
};

/** Poll an endpoint while the page is visible. Keeps the last good value through errors. */
export function usePoll<T>(load: () => Promise<T>, ms: number, key: unknown = null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const value = await loadRef.current();
          if (alive) {
            setData(value);
            setError(null);
          }
        } catch (e) {
          if (alive) setError(e as Error);
        }
      }
      if (alive) timer = window.setTimeout(tick, ms);
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
