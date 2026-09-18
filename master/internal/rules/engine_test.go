package rules

import (
	"strings"
	"testing"
)

func obs(agent string, perms ...string) Observation {
	return Observation{
		AgentID:  agent,
		SContext: "system_u:system_r:syslogd_t:s0",
		TContext: "system_u:object_r:nfs_t:s0",
		TClass:   "dir",
		Perms:    perms,
	}
}

func TestModuleNameCarriesThePermissionsSoModulesAddUp(t *testing.T) {
	write := SuggestedModuleName(obs("a", "write"))
	search := SuggestedModuleName(obs("a", "search"))
	if write == search {
		t.Fatalf("different permissions must not share a module name: %q", write)
	}
	if write != "suggested_syslogdt_nfst_dir_write" {
		t.Fatalf("name = %q", write)
	}
	// Order and duplicates in the AVC line must not change the name.
	if SuggestedModuleName(obs("a", "write", "search")) != SuggestedModuleName(obs("a", "search", "write")) {
		t.Fatal("permission order changed the module name")
	}
	if SuggestedModuleName(obs("a", "search", "write")) != "suggested_syslogdt_nfst_dir_search_write" {
		t.Fatalf("name = %q", SuggestedModuleName(obs("a", "search", "write")))
	}
}

func TestModuleNameIsSafeAndFitsTheAgentLimit(t *testing.T) {
	long := obs("a", "name_connect", "name_bind", "node_bind", "sendto", "recvfrom", "listen", "accept", "shutdown", "getopt", "setopt")
	name := SuggestedModuleName(long)
	if len(name) > 64 {
		t.Fatalf("name is %d chars, the agent refuses over 64: %q", len(name), name)
	}
	if strings.ContainsAny(name, " /;-.\"'") {
		t.Fatalf("unsafe characters in %q", name)
	}
	// Two long names differing only in the cut-off tail must not collide.
	other := obs("a", "name_connect", "name_bind", "node_bind", "sendto", "recvfrom", "listen", "accept", "shutdown", "getopt", "othersetopt")
	if name == SuggestedModuleName(other) {
		t.Fatal("distinct long permission sets collided after truncation")
	}
	// Hostile permission text is reduced to letters and digits.
	if got := SuggestedModuleName(obs("a", "read; rm -rf /")); strings.ContainsAny(got, " ;/-") {
		t.Fatalf("unsanitized: %q", got)
	}
}
