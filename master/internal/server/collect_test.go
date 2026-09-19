package server

import (
	"regexp"
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

func TestSelectScanDomainsSkipsInvalidAndAlreadyActiveDomainsAndCapsTheRest(t *testing.T) {
	known := []string{"httpd_t", "kernel_t", "sshd_t", "not a domain", "postgresql_t"}
	active := map[string]bool{"sshd_t": true}

	selected, skipped := selectScanDomains(known, active, 10)
	if want := []string{"httpd_t", "postgresql_t"}; !slicesEqual(selected, want) {
		t.Fatalf("selected = %v, want %v", selected, want)
	}
	if want := []string{"kernel_t", "sshd_t", "not a domain"}; !slicesEqual(skipped, want) {
		t.Fatalf("skipped = %v, want %v", skipped, want)
	}
}

func TestSelectScanDomainsCapsAtMaxAndSkipsTheOverflow(t *testing.T) {
	known := []string{"a_t", "b_t", "c_t", "d_t"}
	selected, skipped := selectScanDomains(known, nil, 2)
	if want := []string{"a_t", "b_t"}; !slicesEqual(selected, want) {
		t.Fatalf("selected = %v, want %v", selected, want)
	}
	if want := []string{"c_t", "d_t"}; !slicesEqual(skipped, want) {
		t.Fatalf("skipped = %v, want %v", skipped, want)
	}
}

func TestSelectScanDomainsWithNothingKnownSelectsNothing(t *testing.T) {
	selected, skipped := selectScanDomains(nil, nil, 10)
	if len(selected) != 0 || len(skipped) != 0 {
		t.Fatalf("selected = %v, skipped = %v, want both empty", selected, skipped)
	}
}

func TestNewScanIDLooksLikeAV4UUIDAndIsNeverRepeated(t *testing.T) {
	re := `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := newScanID()
		if !regexMatch(re, id) {
			t.Fatalf("%q does not look like a v4 UUID", id)
		}
		if seen[id] {
			t.Fatalf("newScanID repeated %q", id)
		}
		seen[id] = true
	}
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func regexMatch(pattern, s string) bool {
	ok, err := regexp.MatchString(pattern, s)
	return err == nil && ok
}
