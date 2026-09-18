export interface Agent {
  id: string;
  hostname: string;
  ip: string;
  os_release: string;
  kernel_version: string;
  agent_version: string;
  mode: string;
  policy_name: string;
  policy_version: string;
  group: string;
  status: "online" | "offline" | string;
  enrolled_at: string;
  last_seen_at?: string;
  connected: boolean;
}

export interface TopSignature {
  pair: string;
  class: string;
  perms: string;
  count: number;
  agents: number;
}

export interface Command {
  id: string;
  agent_id: string;
  rule_id?: string;
  type: string;
  payload_json: string;
  status: string;
  result_message: string;
  created_at: string;
  acked_at?: string;
}

export interface AvcEventHit {
  agent_id: string;
  ts_unix: number;
  scontext: string;
  tcontext: string;
  tclass: string;
  perms: string[];
  comm: string;
  path: string;
  pid: string;
  raw_line: string;
  timestamp: string;
}

export interface DenialSearchResult {
  events: AvcEventHit[];
  total: number;
}

export interface MatrixRow {
  scontext: string;
  tcontext: string;
  tclass: string;
  perms: string[];
  count: number;
  agent_count: number;
  agents: string[];
}

export interface TrendPoint {
  agent_id: string;
  day_unix: number;
  count: number;
}

export interface CommandSearchResult {
  commands: Command[];
  total: number;
}

export interface SelinuxBoolean {
  name: string;
  value: boolean;
}

export interface SelinuxModule {
  name: string;
  version: string;
}

export interface SelinuxState {
  agent_id: string;
  booleans: SelinuxBoolean[];
  modules: SelinuxModule[];
  collected_at?: string;
}

export interface SuggestedModule {
  id: string;
  command_id: string;
  agent_id: string;
  module_name: string;
  scontext: string;
  tcontext: string;
  tclass: string;
  te_text: string;
  pp_base64?: string;
  status: "generating" | "pending" | "failed" | "approved" | "rejected" | string;
  error_message: string;
  created_at: string;
  reviewed_at?: string;
  reviewed_by: string;
}

export interface SuggestedModuleSearchResult {
  modules: SuggestedModule[];
  total: number;
}

export interface Alert {
  id: string;
  type: string;
  title: string;
  message: string;
  agent_id: string;
  scontext: string;
  tcontext: string;
  tclass: string;
  severity: "low" | "medium" | "high" | string;
  status: "open" | "acknowledged" | string;
  created_at: string;
  acknowledged_at?: string;
  acknowledged_by: string;
}

export interface AlertSearchResult {
  alerts: Alert[];
  total: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    // Merged rather than replaced by ...init, so callers can add headers
    // (e.g. Idempotency-Key) without losing Content-Type.
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `request to ${path} failed with ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listAgents: () => request<Agent[]>("/agents"),
  getAgent: (id: string) => request<{ agent: Agent; connected: boolean }>(`/agents/${id}`),
  getAgentSelinux: (id: string) => request<SelinuxState>(`/agents/${id}/selinux`),
  listDenials: (params: { agentId?: string; query?: string; offset?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.agentId) qs.set("agent_id", params.agentId);
    if (params.query) qs.set("q", params.query);
    if (params.offset) qs.set("offset", String(params.offset));
    if (params.limit) qs.set("limit", String(params.limit));
    return request<DenialSearchResult>(`/denials?${qs.toString()}`);
  },
  topSignatures: (limit = 10) => request<TopSignature[]>(`/denials/top?limit=${limit}`),
  denialMatrix: (params: { days?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.days !== undefined) qs.set("days", String(params.days));
    if (params.limit) qs.set("limit", String(params.limit));
    return request<MatrixRow[]>(`/denials/matrix?${qs.toString()}`);
  },
  denialTrend: (params: { agentId?: string; days?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.agentId) qs.set("agent_id", params.agentId);
    if (params.days !== undefined) qs.set("days", String(params.days));
    return request<TrendPoint[]>(`/denials/trend?${qs.toString()}`);
  },
  listSuggestedModules: (params: { status?: string; offset?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.offset) qs.set("offset", String(params.offset));
    qs.set("limit", String(params.limit ?? 20));
    return request<SuggestedModuleSearchResult>(`/suggested-modules?${qs.toString()}`);
  },
  getSuggestedModule: (id: string) => request<SuggestedModule>(`/suggested-modules/${id}`),
  approveSuggestedModule: (id: string, agentIds: string[]) =>
    request<{ status: string }>(`/suggested-modules/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ agent_ids: agentIds }),
    }),
  rejectSuggestedModule: (id: string) =>
    request<{ status: string }>(`/suggested-modules/${id}/reject`, { method: "POST", body: JSON.stringify({}) }),
  recentCommands: (params: { agentId?: string; status?: string; offset?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.agentId) qs.set("agent_id", params.agentId);
    if (params.status) qs.set("status", params.status);
    if (params.offset) qs.set("offset", String(params.offset));
    qs.set("limit", String(params.limit ?? 20));
    return request<CommandSearchResult>(`/commands/recent?${qs.toString()}`);
  },
  getCommand: (id: string) => request<Command>(`/commands/${id}`),
  listAlerts: (params: { status?: string; severity?: string; offset?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.severity) qs.set("severity", params.severity);
    if (params.offset) qs.set("offset", String(params.offset));
    qs.set("limit", String(params.limit ?? 20));
    return request<AlertSearchResult>(`/alerts?${qs.toString()}`);
  },
  acknowledgeAlert: (id: string) =>
    request<{ status: string }>(`/alerts/${id}/ack`, { method: "POST", body: JSON.stringify({}) }),
  deployRule: (
    payload: {
      name: string;
      type: "set_mode" | "set_boolean" | "install_module" | "chcon";
      payload_json: string;
      agent_ids: string[];
    },
    idempotencyKey: string,
  ) =>
    request<{ rule: unknown; commands: Command[] }>("/rules/deploy", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(payload),
    }),
};
