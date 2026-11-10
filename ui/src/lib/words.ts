import { now as clockNow } from "./clock";
import type { Category, Diagnosis, Investigation, Proposal, Status } from "./types";

/** Plain-English names for everything the system calls by an internal name. */

export const serviceName: Record<string, string> = {
  storefront: "Storefront",
  orders: "Orders",
  payments: "Payments",
  inventory: "Inventory",
  none: "Nothing",
  unknown: "Unknown service",
};

export const serviceRole: Record<string, string> = {
  storefront: "Product pages and checkout",
  orders: "Reserves stock, takes payment",
  payments: "Charges cards",
  inventory: "Keeps stock levels",
};

const problem: Record<Category, string> = {
  service_crash: "is down",
  memory_leak: "is leaking memory",
  slow_responses: "is slow",
  error_responses: "is failing requests",
  not_an_incident: "",
  other: "is behaving oddly",
};

export function headline(d: Pick<Diagnosis, "root_cause_service" | "category">): string {
  if (d.category === "not_an_incident" || d.root_cause_service === "none") return "Nothing is broken";
  if (d.root_cause_service === "unknown") return "Cause not found";
  return `${serviceName[d.root_cause_service]} ${problem[d.category]}`;
}

export const statusName: Record<Status, string> = {
  investigating: "Investigating",
  acting: "Carrying out",
  "awaiting review": "Needs your call",
  confirmed: "Confirmed",
  corrected: "Corrected",
  failed: "Stopped",
};

export function proposalName(p: Pick<Proposal, "action" | "service">): string {
  if (p.action === "restart_service") return `Restart ${serviceName[p.service ?? ""] ?? p.service}`;
  if (p.action === "escalate") return "Call a human expert";
  return "Leave it alone";
}

export function outcomeName(outcome: string | null | undefined, dryRun?: boolean): string {
  switch (outcome) {
    case "executed":
      return dryRun ? "Fix rehearsed" : "Fixed";
    case "refused":
      return "Blocked by a safety rule";
    case "rejected":
      return "Rejected";
    case "escalated":
      return "Escalated";
    case "no action":
      return "Left alone";
    case "failed":
      return "Fix failed";
    default:
      return "";
  }
}

export const agentName: Record<string, string> = {
  plan: "Supervisor",
  metrics: "Metrics",
  logs: "Logs",
  deploy: "Changes",
  solo: "Lone agent",
  diagnose: "Supervisor",
  recall: "Memory",
  propose: "Remediation",
  remediation: "Remediation",
  diagnosis: "Diagnosis",
  comms: "Comms",
};

export const agentRole: Record<string, string> = {
  metrics: "Reads latency, errors, memory and CPU",
  logs: "Reads warnings, errors and new kinds of log line",
  deploy: "Checks restarts, downtime and resource build-up",
};

export const toolName: Record<string, string> = {
  service_overview: "service overview",
  dependency_overview: "calls between services",
  metric_history: "metric history",
  availability: "uptime and restarts",
  log_summary: "log summary",
  search_logs: "log search",
};

/** "payments.latency_p95" → "Payments response time (p95)" */
export function signalName(feature: string): string {
  const [subject, metric] = feature.split(".");
  const metricName: Record<string, string> = {
    up: "is up",
    request_rate: "requests per second",
    error_ratio: "errors",
    latency_p50: "response time (median)",
    latency_p95: "response time (p95)",
    in_flight: "requests in progress",
    memory_mb: "memory",
    cpu: "CPU",
    failure_ratio: "failed calls",
  };
  const who = subject.includes("->")
    ? subject
        .split("->")
        .map((s) => serviceName[s] ?? s)
        .join(" → ")
    : (serviceName[subject] ?? subject);
  return `${who} ${metricName[metric] ?? metric}`;
}

export function signalService(feature: string): string {
  const subject = feature.split(".")[0];
  return subject.includes("->") ? subject.split("->")[1] : subject;
}

/** The service an alert points at, before any diagnosis: the one its top signal is about. */
export function suspect(inv: Pick<Investigation, "signals" | "alert">): string | null {
  const first = inv.signals?.[0]?.feature ?? inv.alert?.match(/- ([a-z]+)(?:->[a-z]+)?\./)?.[1];
  return first ? signalService(first) : null;
}

export function formatValue(feature: string, value: number | null): string {
  if (value === null || value === undefined) return "no data";
  const metric = feature.split(".").pop();
  if (metric === "latency_p95" || metric === "latency_p50") return seconds(value);
  if (metric === "error_ratio" || metric === "failure_ratio") return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
  if (metric === "memory_mb") return `${value.toFixed(0)} MB`;
  if (metric === "request_rate") return `${value.toFixed(1)}/s`;
  if (metric === "cpu") return `${(value * 100).toFixed(0)}%`;
  if (metric === "up") return value >= 1 ? "up" : "down";
  return value.toFixed(2);
}

export function seconds(value: number): string {
  if (value < 1) return `${Math.round(value * 1000)} ms`;
  return `${value.toFixed(value < 10 ? 2 : 1)} s`;
}

export function duration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60 ? `${s % 60} s` : ""}`.trim();
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

export function ago(iso: string, now = clockNow()): string {
  const s = (now - new Date(iso).getTime()) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
