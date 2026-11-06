#!/bin/bash
# One live check inside the Docker live rig (board #55): this container's own gateway, tmux and
# HOME, the agent CLIs at the versions measured on the host, credentials from the environment only
# (passed by NAME at `docker run`). Nothing of the host is here.
#
#   live-check smoke   one managed codex and one managed claude, one turn each: each must answer
#                      `ready`. Without its credentials an agent is started and its turn is
#                      reported "skipped: <NAME> not set", never passed.
set -euo pipefail
check="${1:-smoke}"
[ "$check" = smoke ] || { echo "live-check: unknown check '$check' (known: smoke)" >&2; exit 2; }

cfg="$HOME/.config/teammux"
mkdir -p "$cfg" /work/live
printf 'host = "127.0.0.1"\nport = 9899\ntoken = "%s"\n' "$(cat /proc/sys/kernel/random/uuid)" > "$cfg/config.toml"
chmod 600 "$cfg/config.toml"
# The host's credential files arrive read-only under /stage (owner 15:26: copy or map them; only the
# files scripts/live-docker.mjs names). They are COPIED into this container's own HOME, so a CLI
# writes only its copy and nothing can reach the host.
if [ -d /stage ]; then
  for d in codex claude; do
    [ -d "/stage/$d" ] || continue
    install -d -m 700 "$HOME/.$d"
    for f in /stage/$d/* /stage/$d/.[!.]*; do [ -f "$f" ] && install -m 600 "$f" "$HOME/.$d/$(basename "$f")"; done
  done
fi

server >"$HOME/server.log" 2>&1 &
for _ in $(seq 1 100); do tmm project list >/dev/null 2>&1 && break; sleep 0.2; done
tmm project create /work/live --name live >/dev/null
tmm project up live >/dev/null
for b in codex claude; do tmm registry save --name "l$b" --backend "$b" --system "Live check agent. Answer in one short line." >/dev/null; done

rc=0
for b in codex claude; do
  # A CLI with no credentials here starts, and its turn is said to be skipped, never passed.
  missing=""
  case $b in
    codex) [ -f "$HOME/.codex/config.toml" ] || missing=" ~/.codex/config.toml" ;;
    claude) [ -f "$HOME/.claude/settings.json" ] || missing=" ~/.claude/settings.json" ;;
  esac
  tmm spawn "l$b" --project live >/dev/null
  if [ -n "$missing" ]; then echo "live-check: $b: started; turn skipped:${missing} not staged"; continue; fi
  sleep 20
  tmm send --project live "@l$b reply with the single word ready" >/dev/null
  if timeout 180 bash -c "until tmm log --project live --limit 20 | grep -q '] l$b: ready'; do sleep 2; done"; then
    echo "live-check: $b: PASS (answered ready)"
  else
    echo "live-check: $b: FAIL (no answer in 180 s)"; rc=1
  fi
done
tmm agent list --project live
exit $rc
