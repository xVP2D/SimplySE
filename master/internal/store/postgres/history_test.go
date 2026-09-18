package postgres

import (
	"strings"
	"testing"
	"time"
)

var testNow = time.Date(2026, 9, 18, 12, 0, 0, 0, time.UTC)

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
		if _, err := NormalizeHistoryQuery(c.dataset, 30, 0, testNow, c.bucket, c.group); err == nil {
			t.Errorf("%s: expected an error", c.name)
		}
	}
}

func TestNormalizeHistoryQueryClampsAndDedupes(t *testing.T) {
	q, err := NormalizeHistoryQuery("denials", 100000, 0, testNow, "", []string{"agent", " agent ", "", "tclass"})
	if err != nil {
		t.Fatal(err)
	}
	if q.Days != maxHistoryDays || q.Bucket != "day" {
		t.Fatalf("days/bucket = %d/%s", q.Days, q.Bucket)
	}
	if strings.Join(q.Group, ",") != "agent,tclass" {
		t.Fatalf("group = %v", q.Group)
	}
	if q, _ := NormalizeHistoryQuery("commands", 0, 0, testNow, "none", nil); q.Days != defaultHistDays {
		t.Fatalf("default days = %d", q.Days)
	}
}

func TestBuildHistorySQLShape(t *testing.T) {
	q, _ := NormalizeHistoryQuery("denials", 30, 0, testNow, "day", []string{"agent", "tclass"})
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
		"WHERE bucket >= $1",
	} {
		if !strings.Contains(stmt, want) {
			t.Errorf("statement missing %q:\n%s", want, stmt)
		}
	}

	// No bucket: no time column, biggest first.
	q, _ = NormalizeHistoryQuery("fleet", 7, 0, testNow, "none", []string{"mode"})
	stmt, _ = buildHistorySQL(q)
	if strings.Contains(stmt, "date_trunc") || !strings.Contains(stmt, "ORDER BY samples DESC") {
		t.Errorf("bucket=none statement wrong:\n%s", stmt)
	}

	// The revert/deploy split is a computed dimension, not a column.
	q, _ = NormalizeHistoryQuery("commands", 7, 0, testNow, "week", []string{"kind"})
	stmt, _ = buildHistorySQL(q)
	if !strings.Contains(stmt, "CASE WHEN is_revert THEN 'revert' ELSE 'deploy' END") {
		t.Errorf("kind dimension missing:\n%s", stmt)
	}
}

func TestHistoryWindowStart(t *testing.T) {
	// days is relative to now...
	q, _ := NormalizeHistoryQuery("denials", 30, 0, testNow, "day", nil)
	if want := testNow.Add(-30 * 24 * time.Hour); !q.From.Equal(want) {
		t.Fatalf("From = %v, want %v", q.From, want)
	}
	// ...an explicit start wins over days, exactly
	start := testNow.Add(-9 * 24 * time.Hour).Truncate(24 * time.Hour)
	q, _ = NormalizeHistoryQuery("denials", 30, start.Unix(), testNow, "day", nil)
	if !q.From.Equal(start) {
		t.Fatalf("explicit From = %v, want %v", q.From, start)
	}
	// but never older than the history can hold, nor in the future
	q, _ = NormalizeHistoryQuery("denials", 30, testNow.Add(-2000*24*time.Hour).Unix(), testNow, "day", nil)
	if want := testNow.Add(-maxHistoryDays * 24 * time.Hour); !q.From.Equal(want) {
		t.Fatalf("clamped From = %v, want %v", q.From, want)
	}
	q, _ = NormalizeHistoryQuery("denials", 30, testNow.Add(48*time.Hour).Unix(), testNow, "day", nil)
	if !q.From.Equal(testNow) {
		t.Fatalf("future From = %v, want now", q.From)
	}
}

func TestEveryDimensionOfEveryDatasetBuildsIntoAWellFormedQuery(t *testing.T) {
	for _, dataset := range HistoryDatasets() {
		for _, dim := range HistoryDims(dataset) {
			for _, bucket := range []string{"hour", "day", "week", "month", "none"} {
				q, err := NormalizeHistoryQuery(dataset, 30, 0, testNow, bucket, []string{dim})
				if err != nil {
					t.Fatalf("%s/%s/%s: %v", dataset, dim, bucket, err)
				}
				stmt, err := buildHistorySQL(q)
				if err != nil {
					t.Fatalf("%s/%s/%s: %v", dataset, dim, bucket, err)
				}
				if !strings.Contains(stmt, `AS "`+dim+`"`) || !strings.Contains(stmt, "WHERE "+historyDatasets[dataset].timeCol+" >= $1") {
					t.Fatalf("%s/%s/%s: unexpected SQL %s", dataset, dim, bucket, stmt)
				}
			}
		}
	}
}

func TestNewMeasuresAreExposedUnderTheNamesTheDashboardReads(t *testing.T) {
	want := map[string][]string{
		"commands":   {" AS count", " AS failed", " AS reverts", " AS acked", " AS latency", " AS failure_rate"},
		"alerts":     {" AS count", " AS high", " AS acked", " AS open", " AS ack_time", " AS open_age"},
		"signatures": {" AS count", " AS classes", " AS sources"},
	}
	for dataset, aliases := range want {
		for _, a := range aliases {
			if !strings.Contains(historyDatasets[dataset].measures, a) {
				t.Errorf("%s: measure %q is missing", dataset, a)
			}
		}
	}
}

func TestAveragedMeasuresCannotDivideByZero(t *testing.T) {
	// an empty aggregate (a window with no rows) still returns one row when
	// there is no GROUP BY, so every ratio must guard its denominator
	m := historyDatasets["commands"].measures
	if !strings.Contains(m, "NULLIF(COUNT(*), 0)") {
		t.Fatal("failure_rate divides by an unguarded COUNT(*)")
	}
}

func TestDimensionsBelongToTheirOwnDataset(t *testing.T) {
	cross := []struct{ dataset, dim string }{
		{"commands", "acked_by"}, {"alerts", "error"}, {"denials", "error"}, {"signatures", "agent"}, {"fleet", "error"},
	}
	for _, c := range cross {
		if _, err := NormalizeHistoryQuery(c.dataset, 30, 0, testNow, "day", []string{c.dim}); err == nil {
			t.Errorf("%s must not be groupable by %s", c.dataset, c.dim)
		}
	}
}

func TestNormalizeHistoryQueryNeverReturnsANilGroup(t *testing.T) {
	// An empty group must round-trip through JSON as [], never null: the
	// client iterates it unconditionally (see frontend charts/history.ts).
	q, err := NormalizeHistoryQuery("denials", 7, 0, testNow, "hour", nil)
	if err != nil {
		t.Fatal(err)
	}
	if q.Group == nil {
		t.Fatal("Group is nil")
	}
	if len(q.Group) != 0 {
		t.Fatalf("Group = %v, want empty", q.Group)
	}
}
