package postgres

import (
	"strings"
	"testing"
)

func TestNormalizeHistoryQueryRejectsAnythingOutsideTheWhitelist(t *testing.T) {
	bad := []struct {
		name    string
		dataset string
		bucket  string
		group   []string
	}{
		{"unknown dataset", "users", "day", nil},
		{"sql in dataset", "denials; DROP TABLE agents", "day", nil},
		{"unknown bucket", "denials", "minute", nil},
		{"sql in bucket", "denials", "day') FROM x; --", nil},
		{"unknown dim", "denials", "day", []string{"password"}},
		{"sql in dim", "denials", "day", []string{"agent\" FROM agents; --"}},
		{"dim of another dataset", "alerts", "day", []string{"tclass"}},
		{"too many dims", "denials", "day", []string{"agent", "scontext", "tcontext", "tclass", "perms"}},
	}
	for _, c := range bad {
		if _, err := NormalizeHistoryQuery(c.dataset, 30, c.bucket, c.group); err == nil {
			t.Errorf("%s: expected an error", c.name)
		}
	}
}

func TestNormalizeHistoryQueryClampsAndDedupes(t *testing.T) {
	q, err := NormalizeHistoryQuery("denials", 100000, "", []string{"agent", " agent ", "", "tclass"})
	if err != nil {
		t.Fatal(err)
	}
	if q.Days != maxHistoryDays || q.Bucket != "day" {
		t.Fatalf("days/bucket = %d/%s", q.Days, q.Bucket)
	}
	if strings.Join(q.Group, ",") != "agent,tclass" {
		t.Fatalf("group = %v", q.Group)
	}
	if q, _ := NormalizeHistoryQuery("commands", 0, "none", nil); q.Days != defaultHistDays {
		t.Fatalf("default days = %d", q.Days)
	}
}

func TestBuildHistorySQLShape(t *testing.T) {
	q, _ := NormalizeHistoryQuery("denials", 30, "day", []string{"agent", "tclass"})
	stmt, err := buildHistorySQL(q)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"date_trunc('day', bucket AT TIME ZONE 'UTC')",
		`agent_id AS "agent"`, `tclass AS "tclass"`,
		"SUM(count)::bigint AS count",
		"FROM history_denials_hourly",
		"GROUP BY 1, 2, 3", "ORDER BY 1, 2, 3",
		"make_interval(days => $1)",
	} {
		if !strings.Contains(stmt, want) {
			t.Errorf("statement missing %q:\n%s", want, stmt)
		}
	}

	// No bucket: no time column, biggest first.
	q, _ = NormalizeHistoryQuery("fleet", 7, "none", []string{"mode"})
	stmt, _ = buildHistorySQL(q)
	if strings.Contains(stmt, "date_trunc") || !strings.Contains(stmt, "ORDER BY samples DESC") {
		t.Errorf("bucket=none statement wrong:\n%s", stmt)
	}

	// The revert/deploy split is a computed dimension, not a column.
	q, _ = NormalizeHistoryQuery("commands", 7, "week", []string{"kind"})
	stmt, _ = buildHistorySQL(q)
	if !strings.Contains(stmt, "CASE WHEN is_revert THEN 'revert' ELSE 'deploy' END") {
		t.Errorf("kind dimension missing:\n%s", stmt)
	}
}
