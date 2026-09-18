package opensearch

import "testing"

func TestSignatureIdentifiesTheSameDenial(t *testing.T) {
	base := AvcEvent{SContext: "s", TContext: "t", TClass: "file", Perms: []string{"write", "read"}, Path: "/a"}

	same := base
	same.Perms = []string{"read", "write"}
	same.PID = "999" // fields that don't change the answer
	same.RawLine = "different raw line"
	if Signature(base) != Signature(same) {
		t.Fatal("perm order, pid and raw line must not change the signature")
	}

	for name, mutate := range map[string]func(*AvcEvent){
		"path":       func(e *AvcEvent) { e.Path = "/b" },
		"perm added": func(e *AvcEvent) { e.Perms = []string{"read", "write", "open"} },
		"tclass":     func(e *AvcEvent) { e.TClass = "dir" },
		"tcontext":   func(e *AvcEvent) { e.TContext = "t2" },
		"scontext":   func(e *AvcEvent) { e.SContext = "s2" },
	} {
		other := base
		other.Perms = append([]string(nil), base.Perms...)
		mutate(&other)
		if Signature(base) == Signature(other) {
			t.Errorf("%s must change the signature", name)
		}
	}
}

func TestSignatureDoesNotMutateTheEventsPerms(t *testing.T) {
	e := AvcEvent{Perms: []string{"write", "read"}}
	_ = Signature(e)
	if e.Perms[0] != "write" {
		t.Fatal("Signature sorted the caller's slice in place")
	}
}
