import test from "node:test";
import assert from "node:assert/strict";
import { agentsNeedingAttention } from "../src/lib/attention.ts";
import type { Agent } from "../src/lib/api.ts";

const agent = (over: Partial<Agent>): Agent => ({
  id: over.id ?? "a",
  hostname: over.hostname ?? "host",
  ip: "10.0.0.1",
  os_release: "",
  kernel_version: "",
  agent_version: "1.2.0",
  mode: "enforcing",
  policy_name: "targeted",
  policy_version: "5",
  group: "default",
  status: "online",
  enrolled_at: "2026-01-01T00:00:00Z",
  connected: true,
  ...over,
});

test("a uniform, connected, enforcing fleet needs no attention", () => {
  const fleet = [agent({ id: "a" }), agent({ id: "b" }), agent({ id: "c" })];
  assert.deepEqual(agentsNeedingAttention(fleet), []);
});

test("offline is flagged regardless of everything else, and ranks first", () => {
  const fleet = [agent({ id: "a", connected: false }), agent({ id: "b", mode: "permissive" })];
  const out = agentsNeedingAttention(fleet);
  assert.equal(out.length, 2);
  assert.equal(out[0].agent.id, "a", "offline outranks permissive");
  assert.deepEqual(out[0].reasons, ["offline"]);
  assert.deepEqual(out[1].reasons, ["permissive"]);
});

test("disabled and unknown modes are flagged, enforcing is not", () => {
  const fleet = [agent({ id: "a", mode: "disabled" }), agent({ id: "b", mode: "unknown" }), agent({ id: "c", mode: "enforcing" })];
  const out = agentsNeedingAttention(fleet);
  assert.deepEqual(out.map((o) => o.agent.id).sort(), ["a", "b"]);
});

test("a lone minority version is outdated, a fleet with no majority (all different) flags nobody for version", () => {
  const majorityFleet = [agent({ id: "a", agent_version: "2.0" }), agent({ id: "b", agent_version: "2.0" }), agent({ id: "c", agent_version: "1.0" })];
  const out = agentsNeedingAttention(majorityFleet);
  assert.deepEqual(out.map((o) => o.agent.id), ["c"]);
  assert.deepEqual(out[0].reasons, ["outdated"]);

  const noMajority = [agent({ id: "a", agent_version: "1.0" }), agent({ id: "b", agent_version: "2.0" })];
  assert.deepEqual(agentsNeedingAttention(noMajority), [], "no version has more copies than another: nothing to call outdated");
});

test("a policy mismatch is flagged the same way as a version mismatch, both can apply at once", () => {
  const fleet = [agent({ id: "a" }), agent({ id: "b" }), agent({ id: "d" }), agent({ id: "c", policy_version: "4", agent_version: "0.9" })];
  const out = agentsNeedingAttention(fleet);
  const c = out.find((o) => o.agent.id === "c")!;
  assert.deepEqual(c.reasons.sort(), ["outdated", "policyMismatch"].sort());
});

test("a single agent, or an empty fleet, is never flagged for version or policy (nothing to compare against)", () => {
  assert.deepEqual(agentsNeedingAttention([]), []);
  assert.deepEqual(agentsNeedingAttention([agent({ id: "a" })]), []);
});
