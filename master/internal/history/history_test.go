package history

import (
	"testing"
	"time"

	"console-selinux/master/internal/store/opensearch"
	"console-selinux/master/internal/store/postgres"
)

func TestNormalizePermsMatchesEventSignature(t *testing.T) {
	// Live counts and backfilled counts must land on the same rows: the perms
	// text has to equal what opensearch.Signature embeds and PermsFromSig reads.
	e := opensearch.AvcEvent{SContext: "s", TContext: "t", TClass: "file", Perms: []string{"write", "read", "getattr"}, Path: "/a|b"}
	got := NormalizePerms(e.Perms)
	if got != "getattr,read,write" {
		t.Fatalf("NormalizePerms = %q", got)
	}
	if fromSig := opensearch.PermsFromSig(opensearch.Signature(e)); fromSig != got {
		t.Fatalf("PermsFromSig = %q, want %q (path containing the separator must not shift the fields)", fromSig, got)
	}
	if e.Perms[0] != "write" {
		t.Fatal("NormalizePerms mutated its input")
	}
}

func TestComplianceScoreMatchesTheDashboard(t *testing.T) {
	cases := []struct {
		name      string
		mode      string
		policy    string
		connected bool
		alerts    int
		want      int
	}{
		{"all four pass", "enforcing", "targeted", true, 0, 100},
		{"permissive fails one of four", "permissive", "targeted", true, 0, 75},
		{"disconnected and open alert", "enforcing", "targeted", false, 2, 50},
		{"unknown mode skips two checks, both applicable pass", "unknown", "", true, 0, 100},
		{"unknown mode, offline, alerts", "unknown", "", false, 1, 0},
		{"wrong policy", "enforcing", "mls", true, 0, 75},
		{"permissive and wrong policy: two of four", "permissive", "mls", true, 0, 50},
	}
	for _, c := range cases {
		if got := ComplianceScore(c.mode, c.policy, c.connected, c.alerts); got != c.want {
			t.Errorf("%s: ComplianceScore = %d, want %d", c.name, got, c.want)
		}
	}
}

func TestRecordDenialBucketsByEventHourNotArrivalTime(t *testing.T) {
	r := NewRecorder(nil, nil)
	// 2026-09-18 21:59:59 UTC and 22:00:00 UTC fall in different hours.
	late := time.Date(2026, 9, 18, 21, 59, 59, 0, time.UTC).Unix()
	next := time.Date(2026, 9, 18, 22, 0, 0, 0, time.UTC).Unix()
	r.RecordDenial("a1", "s", "t", "file", []string{"read"}, late)
	r.RecordDenial("a1", "s", "t", "file", []string{"read"}, late)
	r.RecordDenial("a1", "s", "t", "file", []string{"read"}, next)
	if len(r.pending) != 2 {
		t.Fatalf("expected 2 hourly rows, got %d", len(r.pending))
	}
	k := postgres.DenialKey{Bucket: time.Date(2026, 9, 18, 21, 0, 0, 0, time.UTC), AgentID: "a1", SContext: "s", TContext: "t", TClass: "file", Perms: "read"}
	if r.pending[k] != 2 {
		t.Fatalf("21:00 bucket = %d, want 2", r.pending[k])
	}
}
