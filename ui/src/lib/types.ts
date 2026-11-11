export const SERVICES = ["storefront", "orders", "payments", "inventory"] as const;
export type Service = (typeof SERVICES)[number];

export type Category =
  | "service_crash"
  | "memory_leak"
  | "slow_responses"
  | "error_responses"
  | "not_an_incident"
  | "other";

export type Status = "investigating" | "acting" | "awaiting review" | "confirmed" | "corrected" | "failed";

export interface Signal {
  feature: string;
  value: number | null;
  usual: number;
  deviations: number;
}

export interface Diagnosis {
  root_cause_service: Service | "none" | "unknown";
  category: Category;
  summary: string;
  evidence: string[];
  affected_services: string[];
  confidence: "low" | "medium" | "high";
  next_steps: string[];
}

export interface Proposal {
  action: "restart_service" | "escalate" | "no_action";
  service: Service | null;
  rationale: string;
  runbook: string | null;
  expected_outcome: string;
  cited_incidents: string[];
}

export interface Finding {
  agent: string;
  question: string;
  report: string;
  tool_calls: { name: string; args: Record<string, unknown> }[];
  models: string[];
}

export interface Review {
  verdict: "confirmed" | "corrected";
  notes: string;
  approve: boolean;
  instead: { action: string; service: Service } | null;
  by: string;
  at: string;
}

export interface ActionRecord {
  at: string;
  outcome: string;
  action: string;
  service: string | null;
  dry_run?: boolean;
  reasons?: string[];
  approved_by?: string;
  result?: { seconds?: number; ready?: boolean; dry_run?: boolean } | null;
  chosen_by_reviewer?: boolean;
}

export type TimelineEvent =
  | { at: string; step: "plan"; round: number; tasks: { agent: string; question: string }[] }
  | { at: string; step: "specialist" | "solo"; agent: string; question: string; tools: string[]; report: string }
  | { at: string; step: "diagnose"; diagnosis: Diagnosis }
  | { at: string; step: "recall"; recalled: string[] }
  | { at: string; step: "propose"; proposal: Proposal }
  | { at: string; step: "review" }
  | { at: string; step: "decision"; review: Review }
  | { at: string; step: "act"; action: ActionRecord }
  | { at: string; step: "report" };

/** A full investigation: a finished report, or the timeline of one still running. */
export interface Investigation {
  id: string;
  status: Status;
  alert: string;
  alert_at: string;
  started_at?: string;
  investigated_at?: string;
  seconds?: number;
  signals?: Signal[];
  findings?: Finding[];
  models?: string[];
  diagnosis?: Diagnosis;
  recalled?: string[];
  proposal?: Proposal | null;
  review?: Review;
  action?: ActionRecord | null;
  incident_report?: string | null;
  timeline?: TimelineEvent[];
  events?: TimelineEvent[]; // while running
}

export interface InvestigationSummary {
  id: string;
  status: Status;
  alert_at: string;
  root_cause_service?: Diagnosis["root_cause_service"];
  category?: Category;
  confidence?: Diagnosis["confidence"];
  proposal?: Proposal | null;
  seconds?: number;
  outcome?: string | null;
  affected_services?: string[];
  decided_at?: string | null;
  decided_by?: string | null;
  acted_at?: string | null;
}

/** GET /health: the version and what is switched on. */
export interface Health {
  status: string;
  version: string;
  queue: boolean;
  reviews: boolean;
}

/** Vigil's operating policy, from GET /config. */
export interface Config {
  actions: { name: string; description: string; changes_system: boolean; needs_service: boolean }[];
  guardrails: { approval_required: boolean; restart_cooldown_minutes: number; audit_log: boolean };
  models: Record<string, string[]>;
  detector: { method: string; quantile: number; points_in_a_row: number; every_seconds: number };
  reviews_enabled: boolean;
  queue: boolean;
}

export interface ServiceView {
  latest: Record<"up" | "request_rate" | "error_ratio" | "latency_p95" | "memory_mb" | "cpu", number | null>;
  series: Record<string, (number | null)[]>;
}

export interface SystemView {
  online: boolean;
  times?: string[];
  services?: Record<Service, ServiceView>;
  edges?: { from: Service; to: Service; latest: { failure_ratio: number | null; latency_p95: number | null } }[];
  score?: { values: (number | null)[]; threshold: number };
}

export interface AuditEntry {
  at: string;
  incident: string;
  action: string;
  service: string | null;
  outcome: string;
  approved_by?: string;
  reasons?: string[];
  dry_run?: boolean;
  result?: { seconds?: number; ready?: boolean; dry_run?: boolean } | null;
}
