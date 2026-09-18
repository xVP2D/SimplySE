package server

import (
	"testing"

	"console-selinux/master/internal/store/postgres"
)

func TestDescribeRevert(t *testing.T) {
	recordedModuleUndo := `{"type":"remove_module","payload":{"name":"mymod"},"action":"semodule -r mymod"}`
	tests := []struct {
		name       string
		cmd        postgres.Command
		wantKind   string
		wantReason string
		wantAction string
	}{
		{"failed command applied nothing", postgres.Command{Type: "install_module", Status: "failed"}, RevertRecord, "", ""},
		{"pending command applied nothing", postgres.Command{Type: "set_mode", Status: "pending"}, RevertRecord, "", ""},
		{"sent command has no result yet", postgres.Command{Type: "set_mode", Status: "sent"}, RevertNone, ReasonInFlight, ""},
		{"undo already in flight", postgres.Command{Type: "install_module", Status: "acked", RevertPending: true}, RevertNone, ReasonInFlight, ""},
		{"suggest_module is never removable", postgres.Command{Type: "suggest_module", Status: "acked"}, RevertNone, ReasonNotSupported, ""},
		{
			"recorded undo wins",
			postgres.Command{Type: "install_module", Status: "acked", PayloadJSON: `{"name":"mymod"}`, UndoJSON: recordedModuleUndo},
			RevertMachine, "", "semodule -r mymod",
		},
		{
			"legacy chcon is derivable",
			postgres.Command{Type: "chcon", Status: "acked", PayloadJSON: `{"path":"/srv/x","type":"httpd_sys_content_t","recursive":true}`},
			RevertMachine, "", "restorecon -R /srv/x",
		},
		{
			"legacy chcon with a relative path is refused",
			postgres.Command{Type: "chcon", Status: "acked", PayloadJSON: `{"path":"srv/x","type":"t"}`},
			RevertNone, ReasonUnknownPrevious, "",
		},
		{
			"legacy generated module is derivable",
			postgres.Command{Type: "install_module", Status: "acked", PayloadJSON: `{"name":"suggested_a_b_file"}`},
			RevertMachine, "", "semodule -r suggested_a_b_file",
		},
		{
			"legacy hand-named module could have pre-existed",
			postgres.Command{Type: "install_module", Status: "acked", PayloadJSON: `{"name":"httpd"}`},
			RevertNone, ReasonUnknownPrevious, "",
		},
		{
			"legacy boolean has no recorded previous value",
			postgres.Command{Type: "set_boolean", Status: "acked", PayloadJSON: `{"name":"x","value":true}`},
			RevertNone, ReasonUnknownPrevious, "",
		},
		{
			"recorded boolean undo",
			postgres.Command{Type: "set_boolean", Status: "acked", UndoJSON: `{"type":"set_boolean","payload":{"name":"x","value":false},"action":"setsebool -P x off"}`},
			RevertMachine, "", "setsebool -P x off",
		},
		{
			"corrupt recorded undo is not trusted",
			postgres.Command{Type: "set_mode", Status: "acked", UndoJSON: `{not json`},
			RevertNone, ReasonUnknownPrevious, "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := DescribeRevert(tc.cmd)
			if got.Kind != tc.wantKind || got.Reason != tc.wantReason || got.Action != tc.wantAction {
				t.Fatalf("DescribeRevert = %+v, want kind=%q reason=%q action=%q", got, tc.wantKind, tc.wantReason, tc.wantAction)
			}
		})
	}
}

func TestChconUndoPayload(t *testing.T) {
	plan := chconUndo(`{"path":"/srv/x","context":"system_u:object_r:t:s0","recursive":false}`)
	if plan == nil || plan.Type != "restorecon" {
		t.Fatalf("plan = %+v", plan)
	}
	if string(plan.Payload) != `{"path":"/srv/x","recursive":false}` {
		t.Fatalf("payload = %s", plan.Payload)
	}
	if chconUndo(`{"path":"-R"}`) != nil || chconUndo(`not json`) != nil {
		t.Fatal("unsafe/invalid chcon payloads must not produce an undo")
	}
}
