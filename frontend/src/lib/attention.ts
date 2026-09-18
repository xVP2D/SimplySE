import type { Agent } from "./api";

// Reasons an agent is worth a look, most urgent first. An agent can carry
// several at once (e.g. offline AND on an old version).
export type AttentionReason = "offline" | "disabled" | "permissive" | "policyMismatch" | "outdated";

const REASON_RANK: Record<AttentionReason, number> = { offline: 0, disabled: 1, permissive: 2, policyMismatch: 3, outdated: 4 };

export interface AttentionAgent {
  agent: Agent;
  reasons: AttentionReason[];
}

// The value shared by more agents than any other, or null with fewer than 2
// distinct non-empty values, or a tie for the top spot — an exact split has
// no majority to compare against, so nobody gets singled out.
function majority(values: string[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (counts.size < 2) return null;
  let best: string | null = null;
  let bestCount = 0;
  let tie = false;
  for (const [v, n] of counts) {
    if (n > bestCount) {
      best = v;
      bestCount = n;
      tie = false;
    } else if (n === bestCount) {
      tie = true;
    }
  }
  return tie ? null : best;
}

// Agents an operator should look at: offline, not enforcing, on a minority
// agent or policy version compared to the rest of the fleet. Pure and
// client-side — every field it reads is already on the agent list.
export function agentsNeedingAttention(agents: Agent[]): AttentionAgent[] {
  const commonVersion = majority(agents.map((a) => a.agent_version));
  const commonPolicy = majority(agents.map((a) => a.policy_version));
  const out: AttentionAgent[] = [];
  for (const agent of agents) {
    const reasons: AttentionReason[] = [];
    if (!agent.connected) reasons.push("offline");
    if (agent.mode === "disabled" || agent.mode === "unknown") reasons.push("disabled");
    else if (agent.mode === "permissive") reasons.push("permissive");
    if (commonPolicy && agent.policy_version && agent.policy_version !== commonPolicy) reasons.push("policyMismatch");
    if (commonVersion && agent.agent_version && agent.agent_version !== commonVersion) reasons.push("outdated");
    if (reasons.length) out.push({ agent, reasons });
  }
  return out.sort((a, b) => Math.min(...a.reasons.map((r) => REASON_RANK[r])) - Math.min(...b.reasons.map((r) => REASON_RANK[r])) || a.agent.hostname.localeCompare(b.agent.hostname));
}
