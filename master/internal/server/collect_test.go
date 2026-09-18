package server

import (
	"strings"
	"testing"
	"time"
)

func TestValidCollectDomain(t *testing.T) {
	for _, ok := range []string{"syslogd_t", "httpd_sys_script_t", "a_t", "container_t2_t"} {
		if !ValidCollectDomain(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{
		"", "_t", "t", "Syslogd_t", "syslogd", "-a_t", "a b_t", "a;b_t", "../x_t", "a/b_t",
		"kernel_t", "init_t", strings.Repeat("a", 64) + "_t",
	} {
		if ValidCollectDomain(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}

func TestDomainOfContext(t *testing.T) {
	cases := map[string]string{
		"system_u:system_r:syslogd_t:s0-s0:c0.c1023": "syslogd_t",
		"system_u:system_r:sshd_t:s0":                "sshd_t",
		"garbage":                                    "",
		"":                                           "",
	}
	for ctx, want := range cases {
		if got := DomainOfContext(ctx); got != want {
			t.Errorf("DomainOfContext(%q) = %q, want %q", ctx, got, want)
		}
	}
}

func TestCollectedModuleNameIsUniquePerRunAndSafe(t *testing.T) {
	t0 := time.Unix(1000, 0)
	t1 := time.Unix(2000, 0)
	a := CollectedModuleName("syslogd_t", t0)
	b := CollectedModuleName("syslogd_t", t1)
	if a == b {
		t.Fatal("two different runs must not collide")
	}
	if len(a) > 64 {
		t.Fatalf("name too long for the agent's limit: %q (%d)", a, len(a))
	}
	if strings.ContainsAny(a, " /;-.\"'") {
		t.Fatalf("unsafe characters: %q", a)
	}
	// Hostile domain text is reduced to lowercase letters/digits only.
	if got := CollectedModuleName("a;rm -rf /_t", t0); strings.ContainsAny(got, " ;/-") {
		t.Fatalf("unsanitized: %q", got)
	}
}
