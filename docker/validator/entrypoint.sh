#!/bin/bash
# The life of one simulated machine (board #352): write a config.toml with a
# token generated HERE (never the operator's), run the gateway in the
# foreground, and declare + bring up one managed project with one agent so
# the container holds a real tmux session with a real agent window.
#
#   tmm-e2e          run the machine (the image's ENTRYPOINT)
#   tmm-e2e health   exit 0 when this machine is READY: the gateway answers
#                    an authenticated RPC AND the project + agent below are
#                    in place (the image's HEALTHCHECK, so `compose --wait`
#                    returns a usable machine, not just a listening port)
#
# Knobs (environment): TMM_PORT (9899), TMM_TOKEN (generated), TMM_PROJECT
# (demo), TMM_AGENT (kiro — the stand-in kiro-cli answers for it).
set -euo pipefail

cfg_dir="${XDG_CONFIG_HOME:-$HOME/.config}/tmux-mobile"
port="${TMM_PORT:-9899}"
project="${TMM_PROJECT:-demo}"
agent="${TMM_AGENT:-kiro}"

ready="$cfg_dir/e2e-ready"
if [ "${1:-}" = health ]; then
  [ -f "$ready" ] && exec tmm project list >/dev/null
  exit 1
fi
# A restart re-runs this script on the same filesystem: the marker from the
# previous life is dropped first, so health is red until THIS life's project
# and agent are back.
rm -f "$ready"

if [ ! -f "$cfg_dir/config.toml" ]; then
  mkdir -p "$cfg_dir"
  token="${TMM_TOKEN:-$(cat /proc/sys/kernel/random/uuid)}"
  # 0.0.0.0 INSIDE the compose network; the host reaches it only through the
  # port compose publishes on 127.0.0.1.
  printf 'host = "0.0.0.0"\nport = %s\ntoken = "%s"\n' "$port" "$token" > "$cfg_dir/config.toml"
fi

# `--service`: config.toml alone, no first-run questions (there is no tty).
# The machine id is created by this first start and kept in $cfg_dir.
tmm gateway start --service &
gw=$!
trap 'kill -TERM "$gw" 2>/dev/null; wait "$gw"' TERM INT

for _ in $(seq 1 100); do
  if tmm project list >/dev/null 2>&1; then break; fi
  if ! kill -0 "$gw" 2>/dev/null; then
    echo "tmm-e2e: the gateway exited before it answered" >&2
    exit 1
  fi
  sleep 0.2
done

# Idempotent, so a container restart changes nothing: the same session + path
# returns the existing project, `up` relaunches the agent slots it already
# holds (the recipe under /work/.tmm/agents/<name>/), and spawn runs only
# while no agent of that name is listed. `tmm spawn` (not `--with-agent`,
# which seeds a plain shell slot) makes a MANAGED agent: isolated home,
# launch recipe, hooks config — what the multi-server pass reads.
tmm project create /work --name "$project"
tmm project up "$project"
if ! tmm agent list --project "$project" --output json | grep -q "\"name\":\"$agent\""; then
  tmm spawn "$agent" --project "$project"
fi
touch "$ready"

wait "$gw"
