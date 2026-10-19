#!/usr/bin/env bash
# Board #422 round 4: the LIVE acceptance of the reboot restore, on an
# isolated rig. It is the gate for `restore_on_start` defaulting to true.
#
# What it proves, against a real gateway (`tmm gateway start`) and a real
# private tmux server:
#   baseline  a real capture writes a checkpoint naming both projects and both
#             agents' conversation ids (observed before anything else);
#   tmux alive  the gateway restarts on a NEW boot while the old tmux server
#             still runs: nothing is restored, the server's pid is unchanged;
#   unchanged boot / switch false / no checkpoint: nothing is restored;
#   positive  tmux killed by -S, a NEW boot injected: both sessions come back,
#             each agent relaunched with its exact conversation id; claude is
#             held, then released by its SessionStart (TMM_LAUNCH-matched);
#             the fake kiro stays HELD — a backlog line is not typed — until
#             the rig types as a person into its pane, which releases it and
#             flushes the backlog; each project's room carries its line;
#   auth      a call with the wrong token executes nothing.
#
# Isolation (reviewer, 19:06):
# - the boot id is injected ONLY through a user+mount namespace with a file
#   bind-mounted over /proc/sys/kernel/random/boot_id (`unshare --user
#   --map-root-user --mount`); no production env door. The host's own boot
#   id is read before and after and must be unchanged;
# - every process gets `env -i` with HOME, PATH, XDG_CONFIG/DATA/STATE_HOME,
#   TMUX_TMPDIR, LANG, TERM and SHELL only, all inside the rig directory;
#   no TMUX, TMUX_PANE, TMM_*, HOST, PORT, TOKEN or TLS reaches anything;
# - config.toml sets host 127.0.0.1 (the default is 0.0.0.0), a free port, a
#   random token and the rig's own tmux socket; before each start the rig
#   asserts config, state.db and socket all live under the rig directory;
# - it ends only the gateway pids it recorded and its own -S tmux server; it
#   reads no owner login and calls no model (the CLIs are fakes on PATH).
# In Docker, the rig container needs `--security-opt seccomp=unconfined` for
# the namespace (the default profile refuses unshare); a flag on that
# disposable test container only — see docs/conventions/testing.md. A rig
# that cannot inject the boot id FAILS: a skip is not acceptance.
#
# Usage: scripts/restore-acceptance.sh <path to a built tmm>
set -euo pipefail
TMM_SRC=${1:?usage: restore-acceptance.sh <tmm>}
fail() { echo "ACCEPTANCE FAIL: $*" >&2; exit 1; }
ok() { echo "  ok: $*"; }
for t in unshare tmux python3; do command -v "$t" >/dev/null || fail "needs $t"; done

R=$(mktemp -d /tmp/tmm-restore-rig.XXXX)
GW=
HOST_BOOT=$(cat /proc/sys/kernel/random/boot_id)
SOCK="$R/tmux.sock"
# #406: every destructive tmux command names THIS rig's server.
case "$SOCK" in "$R"/*) ;; *) echo "the rig socket is outside the rig" >&2; exit 1 ;; esac
cleanup() {
  rc=$?
  trap - EXIT
  [ -n "$GW" ] && { kill "$GW" 2>/dev/null || true; wait "$GW" 2>/dev/null || true; }
  tmux -S "$SOCK" kill-server 2>/dev/null || true
  [ "$(cat /proc/sys/kernel/random/boot_id)" = "$HOST_BOOT" ] || { echo "the HOST boot id changed" >&2; rc=1; }
  if [ $rc -eq 0 ]; then rm -rf "$R"; echo "ACCEPTANCE OK"; else echo "ACCEPTANCE FAILED (rc=$rc); rig kept in $R" >&2; fi
  exit $rc
}
trap cleanup EXIT

mkdir -p "$R"/{home,config/tmux-mobile,data,state,tmp,bin,ws1,ws2,log}
cp "$TMM_SRC" "$R/bin/tmm"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
TOKEN=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
echo "11111111-1111-4111-8111-aaaaaaaaaaaa" > "$R/boot-A"
echo "22222222-2222-4222-8222-bbbbbbbbbbbb" > "$R/boot-B"

config() { # $1 = restore_on_start: true | false | default (the key absent)
  printf 'token = "%s"\nhost = "127.0.0.1"\nport = %s\ntmux_socket = "%s"\n' "$TOKEN" "$PORT" "$SOCK" > "$R/config/tmux-mobile/config.toml"
  [ "$1" = default ] || printf 'restore_on_start = %s\n' "$1" >> "$R/config/tmux-mobile/config.toml"
}

# ── the fake CLIs: they log what they were started with and every line typed
#    into them, and fire their own hooks through the helper the app wrote ──
cat > "$R/bin/fakecli.py" <<'PY'
import json, os, subprocess, sys, uuid
backend, args = sys.argv[1], sys.argv[2:]
rig = os.environ["RIG"]
launch = os.environ.get("TMM_LAUNCH", "")
log = open(os.path.join(rig, "log", f"{backend}.log"), "a", buffering=1)
def note(kind, **kw): log.write(json.dumps({"kind": kind, "launch": launch, **kw}) + "\n")
def flag(name):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None
def fire(cmd, payload):
    subprocess.run(["/bin/sh", "-c", cmd], input=json.dumps(payload).encode(), check=False)
if backend == "claude":
    sid = flag("--resume") or str(uuid.uuid4())
    hooks = json.load(open(os.path.join(os.environ["CLAUDE_CONFIG_DIR"], "settings.json")))["hooks"]
    on = lambda ev: hooks[ev][0]["hooks"][0]["command"]
    note("start", argv=args, session=sid)
    fire(on("SessionStart"), {"hook_event_name": "SessionStart", "session_id": sid, "source": "resume" if flag("--resume") else "startup", "cwd": os.getcwd()})
    prompt = lambda text: fire(on("UserPromptSubmit"), {"hook_event_name": "UserPromptSubmit", "session_id": sid, "prompt": text, "cwd": os.getcwd()})
    stop = lambda: fire(on("Stop"), {"hook_event_name": "Stop", "session_id": sid, "last_assistant_message": "ok", "cwd": os.getcwd()})
    # A fresh conversation has its first turn (its id is learned from the
    # hooks); a resumed one types nothing on its own.
    if not flag("--resume"):
        prompt("(first turn)"); stop()
else:
    agent = flag("--agent")
    home = os.environ["KIRO_HOME"]
    sid = flag("--resume-id") or str(uuid.uuid4())
    store = os.path.join(home, "sessions", "cli")
    os.makedirs(store, exist_ok=True)
    json.dump({"session_id": sid, "session_state": {"agent_name": agent}}, open(os.path.join(store, f"{sid}.json"), "w"))
    profile = json.load(open(os.path.join(home, "agents", f"{agent}.json")))
    by = {h["trigger"]: h["action"]["command"] for h in profile["hooks"]}
    note("start", argv=args, session=sid)
    prompt = lambda text: fire(by["userPromptSubmit"], {"hook_event_name": "userPromptSubmit", "session_id": sid, "prompt": text, "cwd": os.getcwd()})
    stop = lambda: fire(by["stop"], {"hook_event_name": "stop", "session_id": sid, "cwd": os.getcwd()})
    # A fresh start has a first turn, so its conversation id is recorded; a
    # resumed one does NOTHING until a line is typed into it (no fake
    # readiness: kiro has no startup evidence).
    if not flag("--resume-id"):
        prompt("(first turn)"); stop()
for line in sys.stdin:
    line = line.rstrip("\n")
    note("typed", text=line)
    prompt(line); stop()
PY
for b in claude kiro-cli; do
  name=${b%-cli}
  # argv[0] is the CLI's own name, as for the real one.
  printf '#!/bin/bash\nRIG=%s exec -a %s python3 %s/bin/fakecli.py %s "$@"\n' "$R" "$b" "$R" "$name" > "$R/bin/$b"
  chmod +x "$R/bin/$b"
done

ENVI=(HOME="$R/home" PATH="$R/bin:/usr/local/bin:/usr/bin:/bin" XDG_CONFIG_HOME="$R/config" XDG_DATA_HOME="$R/data" XDG_STATE_HOME="$R/state" TMUX_TMPDIR="$R/tmp" LANG=C.UTF-8 TERM=xterm-256color SHELL=/bin/bash)
T() { env -i "${ENVI[@]}" "$R/bin/tmm" "$@"; }
TJ() { T "$@" --output json; }
under_rig() { case "$1" in "$R"/*) ;; *) fail "$2 is outside the rig: $1" ;; esac; }

gw_start() { # $1 = boot file; the gateway reads it as its boot id
  under_rig "$R/config/tmux-mobile/config.toml" config
  under_rig "$SOCK" socket
  grep -q '^host = "127.0.0.1"$' "$R/config/tmux-mobile/config.toml" || fail "the rig gateway must listen on loopback"
  : > "$R/log/gw.log"
  unshare --user --map-root-user --mount sh -c 'mount --bind "$1" /proc/sys/kernel/random/boot_id && shift && exec "$@"' sh "$1" \
    env -i "${ENVI[@]}" "$R/bin/tmm" gateway start >> "$R/log/gw.log" 2>&1 &
  GW=$!
  for _ in $(seq 120); do grep -q "listening on" "$R/log/gw.log" && break; sleep 0.25; done
  grep -q "listening on ws://127.0.0.1:$PORT" "$R/log/gw.log" || { cat "$R/log/gw.log" >&2; fail "the rig gateway is not on 127.0.0.1:$PORT"; }
  [ -e "$R/config/tmux-mobile/state.db" ] && under_rig "$R/config/tmux-mobile/state.db" state.db
  return 0
}
gw_stop() { # only the pid this rig started, and only while it carries the rig's HOME
  tr '\0' '\n' < "/proc/$GW/environ" | grep -qx "HOME=$R/home" || fail "pid $GW is not this rig's gateway"
  kill "$GW"; wait "$GW" 2>/dev/null || true; GW=
}
tmux_stop() { tmux -S "$SOCK" kill-server; ! tmux -S "$SOCK" list-sessions >/dev/null 2>&1 || fail "the rig's tmux server is still there"; }
said() { grep -q "$1" "$R/log/gw.log"; }
until_true() { # $1 = seconds, rest = a command
  local n=$1; shift
  for _ in $(seq "$n"); do "$@" && return 0; sleep 1; done
  return 1
}
sessions() { tmux -S "$SOCK" list-sessions -F '#{session_name}' 2>/dev/null | sort | tr '\n' ' '; }
started() { grep -q '"kind": "start"' "$R/log/$1.log"; }
snapshot() { rm -rf "$R/snap"; cp -a "$R/config" "$R/snap"; }
restore_snapshot() { rm -rf "$R/config"; cp -a "$R/snap" "$R/config"; }

# ── baseline A: a real capture writes the checkpoint ──────────────────────────
echo "--- baseline: two projects, a claude and a kiro agent, captured on boot A"
config true
gw_start "$R/boot-A"
T project create "$R/ws1" --session rig1 >/dev/null
T project create "$R/ws2" --session rig2 >/dev/null
T project up rig1 >/dev/null
T project up rig2 >/dev/null
# Two managed agents (isolated homes, recipes), started as a person does.
T registry save --name rigc --backend claude --system "acceptance rig agent" >/dev/null
T registry save --name rigk --backend kiro --system "acceptance rig agent" >/dev/null
T spawn rigc --project rig1 >/dev/null
T spawn rigk --project rig2 >/dev/null
checkpointed() {
  TJ project restore > "$R/log/show.json" 2>/dev/null || return 1
  python3 - "$R/log/show.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
ps = {p["session"]: p for p in v.get("plan", {}).get("projects", [])}
ok = all(any(w["kind"] == "agent" and w.get("agent_session_id") for w in ps.get(s, {}).get("windows", [])) for s in ("rig1", "rig2"))
sys.exit(0 if ok else 1)
PY
}
until_true 400 checkpointed || { cat "$R/log/show.json" >&2; fail "no checkpoint with both agents' conversation ids"; }
CLAUDE_SID=$(python3 -c 'import json,sys; print([json.loads(l) for l in open(sys.argv[1])][0]["session"])' "$R/log/claude.log")
KIRO_SID=$(python3 -c 'import json,sys; print([json.loads(l) for l in open(sys.argv[1])][0]["session"])' "$R/log/kiro.log")
ok "checkpoint names rig1 and rig2 with ids (claude $CLAUDE_SID, kiro $KIRO_SID)"
TMUX_PID=$(tmux -S "$SOCK" display -p '#{pid}')
gw_stop
snapshot

echo "--- tmux alive: a new boot while the old server still runs restores nothing"
gw_start "$R/boot-B"
until_true 30 said "no restore at start" || fail "no decision was said"
said "the tmux server that held the sessions is still running" || { grep "restore" "$R/log/gw.log" >&2; fail "the live server was not recognized"; }
[ "$(tmux -S "$SOCK" display -p '#{pid}')" = "$TMUX_PID" ] || fail "the tmux server changed"
ok "nothing restored; tmux pid $TMUX_PID unchanged"
gw_stop
tmux_stop

echo "--- unchanged boot: nothing"
restore_snapshot
gw_start "$R/boot-A"
until_true 30 said "no restore at start" || fail "no decision was said"
said "the host did not reboot" || fail "an unchanged boot was not recognized"
[ -z "$(sessions)" ] || fail "sessions appeared: $(sessions)"
ok "nothing restored"
gw_stop

echo "--- restore_on_start = false: nothing"
restore_snapshot
config false
gw_start "$R/boot-B"
until_true 30 said "no restore at start" || fail "no decision was said"
said "restore on start is off" || fail "the switch was not honoured"
[ -z "$(sessions)" ] || fail "sessions appeared: $(sessions)"
ok "nothing restored"
echo "--- the person's door, with the switch still off: tmm project restore --run / --abandon"
: > "$R/log/claude.log"; : > "$R/log/kiro.log"
TJ project restore --run > "$R/log/run.json" || fail "--run was refused"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["accepted"] is True and r["mode"] == "new", r' "$R/log/run.json" || fail "--run was not accepted"
until_true 120 sh -c "[ \"\$(tmux -S '$SOCK' list-sessions -F '#{session_name}' 2>/dev/null | sort | tr '\n' ' ')\" = 'rig1 rig2 ' ]" || fail "--run did not bring the sessions back: $(sessions)"
until_true 60 started claude || fail "--run did not relaunch claude"
ok "--run accepted and run in the background: rig1 and rig2 back"
done_or_open() { TJ project restore | python3 -c 'import json,sys; v=json.load(sys.stdin); sys.exit(0 if v["source"] == "last" and v["batch"]["closed"] else 1)'; }
until_true 120 done_or_open || fail "the run's batch did not finish"
PIDS=$(tmux -S "$SOCK" list-panes -a -F '#{pane_pid}' | sort | tr '\n' ' ')
T project restore --abandon | grep -q "nothing to abandon" || fail "--abandon with nothing open did not say so"
[ "$(tmux -S "$SOCK" list-panes -a -F '#{pane_pid}' | sort | tr '\n' ' ')" = "$PIDS" ] || fail "--abandon touched a pane"
ok "--abandon with nothing open says so and touches no pane"
gw_stop
tmux_stop
: > "$R/log/claude.log"; : > "$R/log/kiro.log"

echo "--- no checkpoint: nothing"
restore_snapshot
config true
python3 - "$R/config/tmux-mobile/state.db" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("DELETE FROM meta WHERE key LIKE 'restore_checkpoint%'"); c.commit()
PY
gw_start "$R/boot-B"
until_true 30 said "no restore at start" || fail "no decision was said"
said "no checkpoint" || { grep "restore" "$R/log/gw.log" >&2; fail "a missing checkpoint was not recognized"; }
[ -z "$(sessions)" ] || fail "sessions appeared: $(sessions)"
ok "nothing restored"
gw_stop

echo "--- positive: tmux gone, boot B, restore_on_start left to its DEFAULT"
restore_snapshot
config default
grep -q restore_on_start "$R/config/tmux-mobile/config.toml" && fail "the positive case must run on the default"
: > "$R/log/claude.log"; : > "$R/log/kiro.log"
gw_start "$R/boot-B"
until_true 30 said "after a host reboot" || { cat "$R/log/gw.log" >&2; fail "no restore was started"; }
until_true 120 sh -c "[ \"\$(tmux -S '$SOCK' list-sessions -F '#{session_name}' 2>/dev/null | sort | tr '\n' ' ')\" = 'rig1 rig2 ' ]" || fail "sessions back: $(sessions)"
ok "rig1 and rig2 are back"
until_true 120 started claude || fail "claude was not relaunched"
until_true 120 started kiro || fail "kiro was not relaunched"
python3 - "$R/log" "$CLAUDE_SID" "$KIRO_SID" <<'PY' || fail "an agent did not resume its exact conversation"
import json, os, sys
d, csid, ksid = sys.argv[1:]
c = [json.loads(l) for l in open(os.path.join(d, "claude.log"))][0]
k = [json.loads(l) for l in open(os.path.join(d, "kiro.log"))][0]
assert c["argv"][c["argv"].index("--resume") + 1] == csid, c
assert k["argv"][k["argv"].index("--resume-id") + 1] == ksid, k
assert len(c["launch"]) == 36 and len(k["launch"]) == 36, (c, k)
PY
ok "claude --resume $CLAUDE_SID, kiro --resume-id $KIRO_SID, each with its launch uuid"
KIRO=rigk
T send "@$KIRO backlog-line-422" --project rig2 >/dev/null 2>&1 || T send "@$KIRO backlog-line-422" >/dev/null 2>&1 || true
sleep 3
grep -q "backlog-line-422" "$R/log/kiro.log" && fail "the held kiro window got its backlog before a person typed"
ok "kiro held: the backlog line was not typed"
tmux -S "$SOCK" send-keys -t "=rig2:$KIRO" -l "a person types here"
tmux -S "$SOCK" send-keys -t "=rig2:$KIRO" Enter
until_true 60 grep -q "backlog-line-422" "$R/log/kiro.log" || fail "the backlog was not delivered after the person's prompt released kiro"
ok "a person's prompt released kiro; the backlog followed"
released() { # $1 = window: its hold released on evidence, as the batch records it
  TJ project restore > "$R/log/show.json" 2>/dev/null || return 1
  python3 - "$R/log/show.json" "$1" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
ws = [w for p in v.get("batch", {}).get("projects", []) for w in p["windows"] if w["name"] == sys.argv[2]]
sys.exit(0 if ws and ws[0]["state"] == "launched" and ws[0].get("released") is True else 1)
PY
}
until_true 60 released rigc || { cat "$R/log/show.json" >&2; fail "claude's hold was not released by its SessionStart"; }
until_true 60 released rigk || { cat "$R/log/show.json" >&2; fail "kiro's hold was not released by the person's prompt"; }
ok "claude released by SessionStart, kiro by the person's prompt (launch-matched)"
one_line() { [ "$(T log --project "$1" --limit 50 2>/dev/null | grep -c 'restored after a host reboot: 2 windows created (1 agent relaunched')" = 1 ]; }
for p in rig1 rig2; do
  until_true 60 one_line "$p" || { T log --project "$p" --limit 50 >&2; fail "$p's room does not carry exactly one restore line"; }
done
ok "each project's room carries exactly one restore line"

echo "--- auth: the wrong token executes nothing"
mkdir -p "$R/bad/tmux-mobile"
sed "s/^token = .*/token = \"wrong\"/" "$R/config/tmux-mobile/config.toml" > "$R/bad/tmux-mobile/config.toml"
before=$(TJ project restore)
env -i "${ENVI[@]}" XDG_CONFIG_HOME="$R/bad" "$R/bin/tmm" project restore --abandon >/dev/null 2>&1 && fail "a wrong token was accepted"
[ "$(TJ project restore)" = "$before" ] || fail "the refused call changed the restore"
ok "refused; nothing changed"
gw_stop
