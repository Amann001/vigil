import { useEffect, useRef, useState } from "react";
import { go } from "./route";
import type { InvestigationSummary } from "./types";
import { headline } from "./words";

/**
 * Desktop notifications for a fix waiting for approval, so the on-call engineer does not have
 * to keep the war room in view. Opt-in, live only (a replay never needs anyone), and each
 * incident notifies once.
 */

const KEY = "vigil.notify";
const listeners = new Set<(on: boolean) => void>();

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) === "on" && "Notification" in window && Notification.permission === "granted";
  } catch {
    return false;
  }
}

let enabled = stored();

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function setNotifications(on: boolean): Promise<boolean> {
  if (on && notificationsSupported() && Notification.permission !== "granted") {
    on = (await Notification.requestPermission()) === "granted";
  }
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* not remembered */
  }
  listeners.forEach((listener) => listener(on));
  return on;
}

export function useNotifications(): [boolean, (on: boolean) => Promise<boolean>] {
  const [on, setOn] = useState(enabled);
  useEffect(() => {
    listeners.add(setOn);
    return () => void listeners.delete(setOn);
  }, []);
  return [on, setNotifications];
}

/** Notifies once for each incident that starts waiting for a decision. */
export function useDecisionNotifications(pending: InvestigationSummary[], live: boolean) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = pending.map((p) => p.id);
    // Whatever is already waiting when the page opens is on screen; only new ones notify.
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    for (const item of pending) {
      if (seen.current.has(item.id)) continue;
      seen.current.add(item.id);
      if (!live || !enabled || !notificationsSupported() || Notification.permission !== "granted") continue;
      const title =
        item.root_cause_service && item.category
          ? headline({ root_cause_service: item.root_cause_service, category: item.category })
          : "An incident";
      const notice = new Notification(`Vigil: ${title}`, {
        body: "A fix is waiting for your approval. Nothing changes until you decide.",
        tag: item.id,
      });
      notice.onclick = () => {
        window.focus();
        go({ page: "incident", id: item.id });
        notice.close();
      };
    }
  }, [pending, live]);
}
