/**
 * The parts of Vigil and what each does, shared by the home page and How it works. What runs
 * each one (the models) comes from the investigations themselves, not from here.
 */

export type PartId = "detector" | "supervisor" | "logs" | "metrics" | "deploy" | "diagnosis" | "memory" | "remediation" | "you" | "guardrails" | "comms";

export interface Part {
  id: PartId;
  name: string;
  kind: "ml" | "agent" | "store" | "human" | "code";
  does: string;
  /** One short line, for the home page's deck of cards. */
  short: string;
  /** The model role this part runs as, in the investigation's list of models. */
  role?: string;
  fixedModel?: string;
  tools?: string;
}

export const PARTS: Record<PartId, Part> = {
  detector: {
    id: "detector",
    name: "Detector",
    short: "Notices trouble before anyone is paged.",
    kind: "ml",
    does: "Reads 40 signals from the shop every 5 seconds and scores how far they are from normal, against what it learned from healthy traffic. When readings stay past its line, it raises an alert and a job goes on the queue.",
    fixedModel: "Robust z-scores learned from healthy traffic, no LLM",
  },
  supervisor: {
    id: "supervisor",
    name: "Supervisor",
    short: "Turns an alert into the right questions.",
    kind: "agent",
    role: "plan",
    does: "Splits the alert into questions and sends each to the right specialist, all at once. If the answers disagree or leave a gap, it asks a second round before deciding.",
  },
  logs: {
    id: "logs",
    name: "Logs agent",
    short: "Reads thousands of log lines in seconds.",
    kind: "agent",
    role: "logs",
    does: "Groups thousands of log lines into templates, looks for new kinds of error and searches for what the supervisor asked about.",
  },
  metrics: {
    id: "metrics",
    name: "Metrics agent",
    short: "Follows latency, errors and memory.",
    kind: "agent",
    role: "metrics",
    does: "Reads latency, errors, memory and CPU from Prometheus, and the calls between services, to find where a problem started.",
  },
  deploy: {
    id: "deploy",
    name: "Changes agent",
    short: "Checks what changed, and what is building up.",
    kind: "agent",
    role: "deploy",
    does: "Checks what changed: restarts, downtime and anything building up over time, such as memory that never comes back down.",
  },
  diagnosis: {
    id: "diagnosis",
    name: "Diagnosis",
    short: "Names the root cause, with evidence.",
    kind: "agent",
    role: "diagnosis",
    does: "Weighs every finding and names the root cause: which service, what kind of failure, the evidence for it and how sure it is.",
  },
  memory: {
    id: "memory",
    name: "Memory",
    short: "Remembers every runbook and past incident.",
    kind: "store",
    does: "Finds the runbooks and past incidents that match the diagnosis by meaning, not keywords, including how reviewers corrected earlier mistakes.",
    fixedModel: "Vector search with pgvector and fastembed",
  },
  remediation: {
    id: "remediation",
    name: "Remediation agent",
    short: "Proposes one safe fix.",
    kind: "agent",
    role: "remediation",
    does: "Proposes one fix from a fixed catalogue (restart a service, call in an expert, or do nothing) and cites the runbook and incidents behind it.",
  },
  you: {
    id: "you",
    name: "You",
    short: "Says yes, or no. Nothing happens without you.",
    kind: "human",
    does: "Confirm or correct the diagnosis, then approve the fix, choose another service or reject it. Nothing changes until you answer.",
    fixedModel: "A person",
  },
  guardrails: {
    id: "guardrails",
    name: "Guardrails",
    short: "Plain code that guards the door.",
    kind: "code",
    does: "Plain code, not a model: the action must be approved and in the catalogue, and a service restarts at most once every 15 minutes. Every decision goes to an audit log.",
    fixedModel: "Ordinary code, no LLM",
  },
  comms: {
    id: "comms",
    name: "Comms agent",
    short: "Writes the incident report.",
    kind: "agent",
    role: "comms",
    does: "Writes the incident report once the shop has recovered. The reviewed incident is stored in memory for next time.",
  },
};

export const STAGES: { title: string; parts: PartId[] }[] = [
  { title: "Notice", parts: ["detector"] },
  { title: "Investigate", parts: ["supervisor", "logs", "metrics", "deploy"] },
  { title: "Decide", parts: ["diagnosis", "memory", "remediation"] },
  { title: "Act", parts: ["you", "guardrails", "comms"] },
];

