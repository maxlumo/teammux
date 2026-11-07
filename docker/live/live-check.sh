#!/bin/bash
# One live check inside the Docker live rig (board #55): this container's own gateway, tmux and
# HOME, the agent CLIs at the versions measured on the host, credentials from the environment only
# (passed by NAME at `docker run`). Nothing of the host is here.
#
#   live-check smoke   one managed codex and one managed claude, one turn each: each must answer
#                      `ready`. Without its credentials an agent is started and its turn is
#                      reported "skipped: <NAME> not set", never passed.
#   live-check codex-models   board #70: codex's model list follows the config it runs. With the
#                      staged config (no catalogue named) the list is codex's own `debug models`
#                      for that provider; a provider switch in this container's copy changes the
#                      list at the next ask; an agent saved on a listed id answers a turn on it.
set -euo pipefail
check="${1:-smoke}"
case "$check" in smoke|codex-models) ;; *) echo "live-check: unknown check '$check' (known: smoke, codex-models)" >&2; exit 2 ;; esac

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

# Each CLI answers for itself at its pinned version (round 1: omp needs its Bun runtime).
for c in claude codex omp bun; do printf 'live-check: %s --version: %s\n' "$c" "$($c --version 2>&1 | head -1)"; done

server >"$HOME/server.log" 2>&1 &
for _ in $(seq 1 100); do tmm project list >/dev/null 2>&1 && break; sleep 0.2; done
tmm project create /work/live --name live >/dev/null
tmm project up live >/dev/null

if [ "$check" = codex-models ]; then
  [ -f "$HOME/.codex/config.toml" ] || { echo "live-check: codex-models: skipped: ~/.codex/config.toml not staged"; exit 2; }
  rc=0
  row() { tmm agent backends --models | grep '^codex '; }
  first=$(row); echo "live-check: codex-models: as staged: $first"
  case "$first" in *"models (suggestions,"*) ;; *) echo "live-check: codex-models: FAIL (no suggestions list)"; rc=1 ;; esac
  provider=$(sed -n 's/^model_provider *= *"\(.*\)"/\1/p' "$HOME/.codex/config.toml")
  echo "live-check: codex-models: staged provider: ${provider:-openai}"
  # The switch, in this container's COPY only: the other built-in catalogue (bedrock-runtime).
  cp "$HOME/.codex/config.toml" "$HOME/.codex/config.toml.staged"
  sed -i 's/^model_provider *=.*/model_provider = "amazon-bedrock-runtime"/; s/^model *=.*/model = "global.openai.gpt-6.1-sol"/' "$HOME/.codex/config.toml"
  switched=$(row); echo "live-check: codex-models: after switch to amazon-bedrock-runtime: $switched"
  case "$switched" in *global.openai.*) ;; *) echo "live-check: codex-models: FAIL (the list did not follow the switch)"; rc=1 ;; esac
  cp "$HOME/.codex/config.toml.staged" "$HOME/.codex/config.toml"
  back=$(row); echo "live-check: codex-models: switched back: $back"
  [ "$back" = "$first" ] || { echo "live-check: codex-models: FAIL (switching back is not the first list)"; rc=1; }
  # A listed id other than the default saves, and the agent answers on it.
  default=$(printf '%s\n' "$first" | sed -n 's/.* · default: //p')
  pick=$(printf '%s\n' "$first" | sed -n 's/.*models (suggestions, [0-9]*): \(.*\) · default:.*/\1/p' | tr ',' '\n' | tr -d ' ' | grep -vxF "$default" | head -1)
  echo "live-check: codex-models: picked the first listed id that is not the default ($default): $pick"
  tmm registry save --name lcodex --backend codex --model "$pick" --system "Live check agent. Answer in one short line." >/dev/null
  tmm spawn lcodex --project live >/dev/null
  sleep 20
  tmm send --project live "@lcodex reply with the single word ready" >/dev/null
  if timeout 180 bash -c "until tmm log --project live --limit 20 | grep -q '] lcodex: ready'; do sleep 2; done"; then
    echo "live-check: codex-models: agent on $pick answered ready"
  else
    echo "live-check: codex-models: FAIL (no answer in 180 s)"; rc=1
  fi
  pane=$(tmux list-panes -a -F '#{pane_id} #{window_name}' | awk '$2=="lcodex"{print $1; exit}')
  echo "live-check: codex-models: lcodex footer: $(tmux capture-pane -p -t "$pane" | grep -E 'Context [0-9]+% (used|left)' | tail -1)"
  tmm agent list --project live
  exit $rc
fi

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
