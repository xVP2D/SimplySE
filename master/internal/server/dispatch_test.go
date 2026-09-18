package server

import (
	"reflect"
	"testing"
)

func TestPermsFromRawLine(t *testing.T) {
	cases := map[string][]string{
		`type=AVC msg=audit(1.1:2): avc:  denied  { search } for  pid=1 comm="rs:main Q:Reg" name="system" scontext=a tcontext=b tclass=dir permissive=0`: {"search"},
		`type=AVC msg=audit(1.1:2): avc:  denied  { read write open } for  pid=1 scontext=a`:                                                              {"read", "write", "open"},
		`type=USER_AVC msg=audit(1.1:2): pid=1 msg='avc:  denied  { send_msg } for msgtype=method_call'`:                                                  {"send_msg"},
		`type=SYSCALL msg=audit(1.1:2): arch=c000003e`:                                                                                                    nil,
		``: nil,
	}
	for line, want := range cases {
		if got := PermsFromRawLine(line); !reflect.DeepEqual(got, want) {
			t.Errorf("PermsFromRawLine(%q) = %v, want %v", line, got, want)
		}
	}
}
