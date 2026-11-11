import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { replay } from "../lib/demo";
import { notificationsSupported, useNotifications } from "../lib/notify";
import { go, type Route } from "../lib/route";
import { useSound } from "../lib/sound";
import { SERVICES, type InvestigationSummary } from "../lib/types";
import { ago, headline, serviceName, serviceRole } from "../lib/words";
import "./palette.css";

export const OPEN_PALETTE = "vigil:palette";

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

const PAGES: [string, Route, string][] = [
  ["Home", { page: "home" }, "What Vigil is"],
  ["War room", { page: "watch" }, "The live watch"],
  ["Incidents", { page: "history" }, "Every incident and how long each took"],
  ["Status", { page: "status" }, "Each service's health now"],
  ["How it works", { page: "how" }, "The agent team"],
  ["Results", { page: "scores" }, "The evaluation"],
  ["Audit log", { page: "audit" }, "Every decision about an action"],
  ["Policy", { page: "policy" }, "What Vigil may do and who approves it"],
];

/**
 * Ctrl+K (or ⌘K, or /) anywhere: jump to any page, service or incident, or switch sound and
 * notifications, by typing a few letters.
 */
export function CommandPalette({ list, mode }: { list: InvestigationSummary[] | null; mode: "live" | "demo" | "unknown" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [sound, setSound] = useSound();
  const [notify, setNotify] = useNotifications();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]");
      if ((event.key === "k" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      window.setTimeout(() => input.current?.focus(), 30);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const all: Command[] = [
      ...PAGES.map(([label, route, hint]) => ({ id: `page-${route.page}`, group: "Pages", label, hint, run: () => go(route) })),
      ...SERVICES.map((s) => ({
        id: `service-${s}`,
        group: "Services",
        label: serviceName[s],
        hint: serviceRole[s],
        run: () => go({ page: "service", service: s }),
      })),
      ...(list ?? []).slice(0, 8).map((i) => ({
        id: `incident-${i.id}`,
        group: "Incidents",
        label:
          i.root_cause_service && i.category
            ? headline({ root_cause_service: i.root_cause_service, category: i.category })
            : "Investigating",
        hint: ago(i.alert_at),
        run: () => go({ page: "incident", id: i.id }),
      })),
      { id: "sound", group: "Settings", label: sound ? "Turn sound off" : "Turn sound on", hint: "Ambient hum and alert cues", run: () => setSound(!sound) },
    ];
    if (mode === "live" && notificationsSupported()) {
      all.push({
        id: "notify",
        group: "Settings",
        label: notify ? "Turn notifications off" : "Turn notifications on",
        hint: "When a fix is waiting for approval",
        run: () => void setNotify(!notify),
      });
    }
    if (mode === "demo") {
      all.push(
        { id: "replay-pause", group: "Replay", label: "Pause or play the replay", run: () => void replay.state().then((s) => replay.setPaused(!s.paused)) },
        { id: "replay-start", group: "Replay", label: "Start the replay again", run: () => void replay.seek(0) },
      );
    }
    return all;
  }, [list, mode, sound, notify, setSound, setNotify]);

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = commands.filter((c) => words.every((w) => `${c.label} ${c.group} ${c.hint ?? ""}`.toLowerCase().includes(w)));
  const choose = (command: Command | undefined) => {
    if (!command) return;
    setOpen(false);
    command.run();
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="palette-backdrop"
          onClick={() => setOpen(false)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            className="palette"
            role="dialog"
            aria-modal="true"
            aria-label="Go to a page, service or incident"
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <input
              ref={input}
              autoFocus
              className="palette-input"
              placeholder="Go to a page, a service or an incident…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, shown.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === "Enter") {
                  choose(shown[active]);
                } else if (e.key === "Escape") {
                  setOpen(false);
                }
              }}
              aria-controls="palette-results"
              aria-activedescendant={shown[active] ? `palette-${active}` : undefined}
            />
            <ul className="palette-results" id="palette-results" role="listbox">
              {shown.length === 0 && <li className="palette-empty">Nothing matches “{query}”.</li>}
              {shown.map((c, i) => (
                <li
                  key={c.id}
                  id={`palette-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? "is-active" : ""}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(c)}
                >
                  {(i === 0 || shown[i - 1].group !== c.group) && <span className="palette-group">{c.group}</span>}
                  <span className="palette-label">{c.label}</span>
                  {c.hint && <span className="palette-hint">{c.hint}</span>}
                </li>
              ))}
            </ul>
            <p className="palette-keys">
              <kbd>↑</kbd> <kbd>↓</kbd> to choose, <kbd>Enter</kbd> to go, <kbd>Esc</kbd> to close
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
