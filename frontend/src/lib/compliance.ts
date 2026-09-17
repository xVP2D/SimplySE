import type { Agent, Alert } from "./api";

// Baseline compliance checks derived purely from data the master already
// has (agent heartbeat state + open alerts) — not an implementation of a
// real benchmark (e.g. CIS). A dedicated compliance engine (policy
// baselines, richer facts collected by the agent) is a follow-up; this
// gives operators a first, honest signal rather than a stub page.

export interface CheckResult {
  id: string;
  label: string;
  status: "pass" | "fail" | "unknown";
}

export interface AgentCompliance {
  agent: Agent;
  checks: CheckResult[];
  score: number; // 0-100, over applicable (non-"unknown") checks
}

export function evaluateAgent(agent: Agent, openAlertsByAgent: Map<string, number>): AgentCompliance {
  const heartbeatSeen = agent.mode !== "unknown";

  const checks: CheckResult[] = [
    {
      id: "enforcing",
      label: "Mode enforcing",
      status: !heartbeatSeen ? "unknown" : agent.mode === "enforcing" ? "pass" : "fail",
    },
    {
      id: "connected",
      label: "Agent joignable",
      status: agent.connected ? "pass" : "fail",
    },
    {
      id: "policy",
      label: "Politique targeted",
      status: !heartbeatSeen ? "unknown" : agent.policy_name === "targeted" ? "pass" : "fail",
    },
    {
      id: "no_open_alerts",
      label: "Aucune alerte ouverte",
      status: (openAlertsByAgent.get(agent.id) ?? 0) === 0 ? "pass" : "fail",
    },
  ];

  const applicable = checks.filter((c) => c.status !== "unknown");
  const passed = applicable.filter((c) => c.status === "pass").length;
  const score = applicable.length === 0 ? 100 : Math.round((100 * passed) / applicable.length);

  return { agent, checks, score };
}

export function evaluateFleet(agents: Agent[], openAlerts: Alert[]): AgentCompliance[] {
  const openAlertsByAgent = new Map<string, number>();
  for (const a of openAlerts) {
    openAlertsByAgent.set(a.agent_id, (openAlertsByAgent.get(a.agent_id) ?? 0) + 1);
  }
  return agents.map((agent) => evaluateAgent(agent, openAlertsByAgent));
}

export function fleetScore(results: AgentCompliance[]): number {
  if (results.length === 0) return 100;
  const sum = results.reduce((acc, r) => acc + r.score, 0);
  return Math.round(sum / results.length);
}
