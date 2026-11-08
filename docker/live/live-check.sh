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
#   live-check codex-provider   board #74: a codex chat started under one provider, restarted
#                      under another (a second provider id for the same endpoint, in this
#                      container's copy of the config), comes back on a fresh conversation and
#                      the room says why; a restart under the same provider resumes as before.
#   live-check pi      board #71: a managed pi 1.5.0 agent end to end. The rig writes ~/.pi/agent
#                      in the owner's provider shape (ust anthropic-messages + ust-openai
#                      openai-responses, apiKey $UST_API_KEY; orchestrator, #71 note 6); nothing of
#                      the host's ~/.pi. Spawned with a model and effort, a turn answered through
#                      the telemetry, /model and /thinking from the room, a restart that resumes
#                      the conversation, the user's auth.json and models.json still linked.
#   live-check codex-limit   board #66: the provider's request-body limit, bisected with unbilled
#                      requests (a model nobody serves: 404 under the limit, 413 over it), and that
#                      codex takes `model_auto_compact_token_limit` from a profile file.
#   live-check codex-picker  board #66: a person opens codex's /new picker in a git repo; a delivery
#                      sent meanwhile is held (the picker stays open, no worktree), and is typed and
#                      answered once Escape closes it.
set -euo pipefail
check="${1:-smoke}"
case "$check" in smoke|codex-models|codex-provider|pi|omp-tools|codex-limit|codex-picker) ;; *) echo "live-check: unknown check '$check' (known: smoke, codex-models, codex-provider, pi, omp-tools, codex-limit, codex-picker)" >&2; exit 2 ;; esac

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
for c in claude codex omp bun pi; do printf 'live-check: %s --version: %s\n' "$c" "$($c --version 2>&1 | head -1)"; done

server >"$HOME/server.log" 2>&1 &
for _ in $(seq 1 100); do tmm project list >/dev/null 2>&1 && break; sleep 0.2; done
tmm project create /work/live --name live >/dev/null
tmm project up live >/dev/null

if [ "$check" = pi ]; then
  [ -n "${UST_API_KEY:-}" ] || { echo "live-check: pi: skipped: UST_API_KEY not set"; exit 2; }
  [ -f "$HOME/.codex/config.toml" ] || { echo "live-check: pi: skipped: no UST base URL (codex config not staged)"; exit 2; }
  rc=0
  A="$HOME/.pi/agent"; mkdir -p "$A"
  base=$(sed -n 's/^base_url *= *"\(.*\)"/\1/p' "$HOME/.codex/config.toml" | head -1)
  cat > "$A/models.json" <<J
{"providers":{"ust":{"baseUrl":"${base%/v1}","api":"anthropic-messages","apiKey":"\$UST_API_KEY","models":[{"id":"claude-opus-5-5","reasoning":true},{"id":"claude-fable-5-1","reasoning":true},{"id":"claude-sonnet-5-5","reasoning":true},{"id":"claude-haiku-5-5","reasoning":true}]},
"ust-openai":{"baseUrl":"$base","api":"openai-responses","apiKey":"\$UST_API_KEY","models":[{"id":"gpt-6-astra"},{"id":"gpt-6.1-sol"}]}}}
J
  printf '{"defaultProvider":"ust","defaultModel":"claude-opus-5-5","defaultThinkingLevel":"medium"}\n' > "$A/settings.json"
  printf '{}\n' > "$A/auth.json"
  ok() { echo "live-check: pi: $1"; }; bad() { echo "live-check: pi: FAIL ($1)"; rc=1; }
  all=$(tmm agent backends --models 2>&1 || true); row=$(printf '%s\n' "$all" | grep '^pi ' || true); ok "models: ${row:-none; the whole answer: $all}"
  case "$row" in *"ust/claude-haiku-5-5"*) ;; *) bad "the model list lacks models.json's ids" ;; esac
  tmm registry save --name lpi --backend pi --model ust/claude-haiku-5-5 --effort low --system "Live check agent. Answer in one short line." >/dev/null
  tmm spawn lpi --project live >/dev/null
  sleep 25
  H=/work/live/.tmm/agents/lpi
  for f in auth.json models.json; do [ "$(readlink "$H/$f")" = "$A/$f" ] && ok "$f linked to the user's" || bad "$f is not a link to the user's ($(ls -la "$H/$f" 2>&1))"; done
  pane() { tmux list-panes -a -F '#{pane_id} #{window_name}' | awk '$2=="lpi"{print $1; exit}'; }
  foot() { tmux capture-pane -p -t "$(pane)" | grep -E '%/[0-9]+k' | tail -1 | sed 's/  */ /g'; }
  ok "pane runs: $(tmux list-panes -a -F '#{window_name} #{pane_current_command}' | awk '$1=="lpi"{print $2; exit}')"
  ok "footer: $(foot)"
  ask() { tmm send --project live "@lpi $1" >/dev/null; timeout 180 bash -c "until tmm log --project live --limit 40 | grep -q '] lpi: $2'; do sleep 2; done"; }
  ask "reply with the single word ready" ready && ok "turn 1 answered ready (Stop recorded through the telemetry)" || bad "no answer to turn 1"
  tmm agent list --project live | grep lpi || true
  # /model first: switching the model resets the level (measured), so /thinking follows it.
  tmm send --project live "@lpi /model ust/claude-sonnet-5-5" >/dev/null; sleep 6
  tmm send --project live "@lpi /thinking high" >/dev/null; sleep 4
  ok "footer after /model ust/claude-sonnet-5-5, /thinking high: $(foot)"
  case "$(foot)" in *"claude-sonnet-5-5 • high"*) ;; *) bad "the footer does not show the switched model and level" ;; esac
  ask "reply with the single word second" second && ok "turn 2 answered second" || bad "no answer to turn 2"
  tmm agent restart lpi --project live >/dev/null
  sleep 25
  ok "restart line: $(tmm log --project live --limit 40 | grep '\[tmm\] restarted lpi' | tail -1)"
  ok "footer after the restart (the definition's model and effort win): $(foot)"
  ask "what single word did you reply first in this conversation? answer with that word only" ready && ok "after the restart it remembered 'ready' (resumed)" || bad "the restart did not resume the conversation"
  for f in auth.json models.json; do [ "$(readlink "$H/$f")" = "$A/$f" ] || bad "$f lost its link after a restart"; done
  tmm send --project live "@lpi /new" >/dev/null; sleep 6
  ask "reply with the single word fresh" fresh && ok "after /new it answered fresh" || bad "no answer after /new"
  tmm agent list --project live
  exit $rc
fi

if [ "$check" = omp-tools ]; then
  # Board #72: a managed omp's own tools (plan, ask, goal, out) are off by default and on by
  # the definition's switch, read from omp's own /tools list ('* name' active, '- name' not).
  rc=0
  pid() { tmux list-panes -a -F '#{pane_id} #{window_name}' | awk '$2=="lomp"{print $1; exit}'; }
  # omp's /tools is a scrolling table (│ │ name │ description); every page is read, then closed.
  tools() {
    tmm send --project live "@lomp /tools" >/dev/null; sleep 6
    for _ in $(seq 1 25); do tmux capture-pane -p -t "$(pid)" || true; tmux send-keys -t "$(pid)" PageDown; sleep 0.4; done \
      | sed -n 's/^[[:space:]]*│ │ \([a-z_][a-z0-9_]*\)[[:space:]]*│.*/\1/p' | sort -u
    tmux send-keys -t "$(pid)" Escape
  }
  has() { printf '%s\n' "$1" | grep -qx "$2"; }
  tmm registry save --name lomp --backend omp --system "Live check agent." >/dev/null
  tmm spawn lomp --project live >/dev/null
  sleep 25
  echo "live-check: omp-tools: config.yml (default): $(tr '\n' ' ' < /work/live/.tmm/agents/lomp/config.yml)"
  off=$(tools); echo "live-check: omp-tools: /tools with the switch off: $(printf '%s ' $off)"
  for t in ask goal; do if has "$off" "$t"; then echo "live-check: omp-tools: FAIL ($t active with the switch off)"; rc=1; fi; done
  if ! has "$off" read; then echo "live-check: omp-tools: FAIL (no tool list read)"; rc=1; echo "    panes: $(tmux list-panes -a -F '#{pane_id} #{window_name} #{pane_current_command}' | tr '\n' ';')"; tmm log --project live --limit 6 | sed 's/^/    /'; fi
  tmm registry save --name lomp --backend omp --system "Live check agent." --omp-tools on >/dev/null
  tmm agent restart lomp --project live >/dev/null
  sleep 25
  echo "live-check: omp-tools: config.yml (on): $(tr '\n' ' ' < /work/live/.tmm/agents/lomp/config.yml 2>/dev/null || echo absent)"
  on=$(tools); echo "live-check: omp-tools: /tools with the switch on: $(printf '%s ' $on)"
  if ! has "$on" ask; then echo "live-check: omp-tools: FAIL (ask not active with the switch on)"; rc=1; fi
  if [ $rc = 0 ]; then echo "live-check: omp-tools: PASS"; fi
  exit $rc
fi

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

if [ "$check" = codex-provider ]; then
  [ -f "$HOME/.codex/config.toml" ] || { echo "live-check: codex-provider: skipped: ~/.codex/config.toml not staged"; exit 2; }
  rc=0
  cfg_file="$HOME/.codex/config.toml"
  provider=$(sed -n 's/^model_provider *= *"\(.*\)"/\1/p' "$cfg_file")
  echo "live-check: codex-provider: staged provider: ${provider:-openai}"
  ask() { # $1 word: one turn that must answer it
    tmm send --project live "@lcodex reply with the single word $1" >/dev/null
    timeout 180 bash -c "until tmm log --project live --limit 30 | grep -q '] lcodex: $1'; do sleep 2; done"
  }
  pane_cmd() { tmux list-panes -a -F '#{window_name} #{pane_current_command}' | awk '$1=="lcodex"{print $2; exit}'; }
  tmm registry save --name lcodex --backend codex --system "Live check agent. Answer in one short line." >/dev/null
  tmm spawn lcodex --project live >/dev/null
  sleep 20
  if ask alpha; then echo "live-check: codex-provider: turn 1 on $provider answered alpha"; else echo "live-check: codex-provider: FAIL (no first answer)"; exit 1; fi
  # Same provider: the restart resumes, as before.
  tmm agent restart lcodex --project live >/dev/null
  sleep 20
  echo "live-check: codex-provider: same-provider restart line: $(tmm log --project live --limit 40 | grep '\[tmm\] restarted lcodex' | tail -1)"
  # The switch, in this container's COPY only: a second provider id for the same endpoint.
  awk -v p="$provider" '
    $0 ~ "^\\[model_providers\\."p"\\]" {copy=1}
    copy && /^\[/ && $0 !~ "^\\[model_providers\\."p"\\]" {copy=0}
    {print} copy {buf=buf $0 "\n"}
    END {sub("\\[model_providers\\."p"\\]", "[model_providers."p"2]", buf); printf "\n%s", buf}
  ' "$cfg_file" > "$cfg_file.new"
  sed -i "s/^model_provider *=.*/model_provider = \"${provider}2\"/" "$cfg_file.new"
  mv "$cfg_file.new" "$cfg_file"
  echo "live-check: codex-provider: switched to ${provider}2 (sections: $(grep -c '^\[model_providers\.' "$cfg_file"))"
  tmm agent restart lcodex --project live >/dev/null
  sleep 25
  line=$(tmm log --project live --limit 40 | grep '\[tmm\] restarted lcodex' | tail -1)
  echo "live-check: codex-provider: cross-provider restart line: $line"
  case "$line" in *"fresh conversation: its chat was started on $provider and codex is now on ${provider}2"*) ;; *) echo "live-check: codex-provider: FAIL (the room did not say why)"; rc=1 ;; esac
  echo "live-check: codex-provider: pane runs: $(pane_cmd)"
  case "$(pane_cmd)" in bash|zsh|sh|dash) echo "live-check: codex-provider: FAIL (a shell, not codex)"; rc=1 ;; esac
  if ask beta; then echo "live-check: codex-provider: after the switch it answered beta"; else echo "live-check: codex-provider: FAIL (no answer after the switch)"; rc=1; fi
  pane=$(tmux list-panes -a -F '#{pane_id} #{window_name}' | awk '$2=="lcodex"{print $1; exit}')
  if tmux capture-pane -p -S -200 -t "$pane" | grep -q 'thread/resume failed'; then echo "live-check: codex-provider: FAIL (codex printed thread/resume failed)"; rc=1; fi
  # Review R2, MEASURED and reported, never pass/fail: does a trusted project config's
  # model_provider outrank the home's? The chat now runs on ${provider}2. The project names
  # ${provider}; our rule then predicts nothing (unknown), so the restart resumes as before.
  # If codex honours the project layer it refuses that resume, a provider mismatch.
  mkdir -p /work/live/.codex
  printf 'model_provider = "%s"\n' "$provider" > /work/live/.codex/config.toml
  printf '\n[projects."/work/live"]\ntrust_level = "trusted"\n' >> "$cfg_file"
  tmm agent restart lcodex --project live >/dev/null
  sleep 25
  echo "live-check: codex-provider: project-layer restart line: $(tmm log --project live --limit 40 | grep '\[tmm\] restarted lcodex' | tail -1)"
  pane=$(tmux list-panes -a -F '#{pane_id} #{window_name}' | awk '$2=="lcodex"{print $1; exit}')
  if tmux capture-pane -p -S -200 -t "$pane" | grep -q 'thread/resume failed'; then
    echo "live-check: codex-provider: MEASURED project layer: honoured (codex refused the resume: $(tmux capture-pane -p -S -200 -t "$pane" | grep -m1 'thread/resume failed'))"
  else
    echo "live-check: codex-provider: MEASURED project layer: not honoured for the provider (resumed; pane runs $(pane_cmd))"
  fi
  # Round 3 (orchestrator, #74 note 27): the home goes back to ${provider}, so home and project
  # AGREE on ${provider} while the chat runs on ${provider}2. Whichever layer wins, codex would
  # refuse that chat, so the restart must start fresh, say why, and answer.
  sed -i "s/^model_provider *=.*/model_provider = \"${provider}\"/" "$cfg_file"
  tmm agent restart lcodex --project live >/dev/null
  sleep 25
  line=$(tmm log --project live --limit 40 | grep '\[tmm\] restarted lcodex' | tail -1)
  echo "live-check: codex-provider: agreeing project and home restart line: $line"
  case "$line" in *"fresh conversation: its chat was started on ${provider}2 and codex is now on ${provider}"*) ;; *) echo "live-check: codex-provider: FAIL (agreeing layers: no fresh start with its reason)"; rc=1 ;; esac
  case "$(pane_cmd)" in bash|zsh|sh|dash) echo "live-check: codex-provider: FAIL (agreeing layers: a shell, not codex)"; rc=1 ;; esac
  if ask gamma; then echo "live-check: codex-provider: agreeing layers: it answered gamma"; else echo "live-check: codex-provider: FAIL (agreeing layers: no answer)"; rc=1; fi
  tmm agent list --project live
  exit $rc
fi

if [ "$check" = codex-picker ]; then
  # Board #66 item 1: codex's own pickers and menus, opened by a person in the pane, and what
  # a delivery does while one is open. The screens are printed whole: the reading is by structure.
  [ -f "$HOME/.codex/config.toml" ] || { echo "live-check: codex-picker: skipped: ~/.codex/config.toml not staged"; exit 2; }
  rc=0
  # The /new picker asks where the new chat runs, so it shows only in a git repository (orchestrator, 11-05 16:56).
  git -C /work/live init -q && git -C /work/live -c user.name=live -c user.email=live@rig commit -q --allow-empty -m init
  tmm registry save --name lcodex --backend codex --system "Live check agent. Answer in one short line." >/dev/null
  tmm spawn lcodex --project live >/dev/null
  sleep 20
  pane=$(tmux list-panes -a -F '#{pane_id} #{window_name}' | awk '$2=="lcodex"{print $1; exit}')
  shot() { echo "live-check: codex-picker: --- screen: $1"; tmux capture-pane -p -t "$pane" | sed 's/^/    |/'; }
  shot "idle composer"
  tmm send --project live "@lcodex reply with the single word ready" >/dev/null
  timeout 180 bash -c "until tmm log --project live --limit 20 | grep -q '] lcodex: ready'; do sleep 2; done" || { echo "live-check: codex-picker: FAIL (no first answer)"; exit 1; }
  sleep 2
  tmux send-keys -t "$pane" -l /new; sleep 1; tmux send-keys -t "$pane" Enter; sleep 3; shot "/new during a conversation"
  tmux capture-pane -p -t "$pane" | grep -q 'enter select' || { echo "live-check: codex-picker: FAIL (no /new picker to test against)"; exit 1; }
  # The incident: the stamp's `2026` answered the picker (option 2, a new worktree).
  tmm send --project live "@lcodex reply with the single word picked" >/dev/null; sleep 6
  shot "a delivery sent while the /new picker is open"
  if tmux capture-pane -p -t "$pane" | grep -q 'enter select'; then echo "live-check: codex-picker: the picker is still open, nothing typed into it"; else echo "live-check: codex-picker: FAIL (the picker was answered)"; rc=1; fi
  if ls -d /work/live/.tmm/agents/lcodex/codex/worktrees/* >/dev/null 2>&1; then echo "live-check: codex-picker: FAIL (a new worktree was created)"; rc=1; fi
  if tmm log --project live --limit 10 | grep -q '] lcodex: picked'; then echo "live-check: codex-picker: FAIL (answered under the picker)"; rc=1; fi
  # A person closes it (Escape: back, keeping the current chat); the capture tick types the line.
  tmux send-keys -t "$pane" Escape
  if timeout 120 bash -c "until tmm log --project live --limit 10 | grep -q '] lcodex: picked'; do sleep 2; done"; then echo "live-check: codex-picker: after Escape the held line was typed and answered"; else echo "live-check: codex-picker: FAIL (no answer after the picker closed)"; rc=1; fi
  shot "after Escape"
  n=$(tmm log --project live --limit 20 | grep -c 'single word picked' || true)
  [ "$n" = 1 ] || { echo "live-check: codex-picker: FAIL (the line is in the room $n times)"; rc=1; }
  exit $rc
fi

if [ "$check" = codex-limit ]; then
  # Board #66: the provider's request-body limit, measured with UNBILLED requests: a body of N
  # bytes naming a model no provider serves is refused 400 (invalid model) when the gateway takes
  # it, 413 when the body is over its limit; the limit is bisected to 64 KiB. Nothing is generated.
  [ -n "${UST_API_KEY:-}" ] || { echo "live-check: codex-limit: skipped: UST_API_KEY not set"; exit 2; }
  base=$(sed -n 's/^base_url *= *"\(.*\)"/\1/p' "$HOME/.codex/config.toml" | head -1)
  [ -n "$base" ] || { echo "live-check: codex-limit: skipped: no base_url in the staged codex config"; exit 2; }
  # node is in the image (the CLIs run on it); curl is not.
  status() {
    node -e 'const [n, url] = process.argv.slice(1);
      const body = `{"model":"tmm-limit-probe-no-such-model","input":"${"a".repeat(+n)}"}`;
      fetch(url, { method: "POST", headers: { authorization: `Bearer ${process.env.UST_API_KEY}`, "content-type": "application/json" }, body })
        .then(async (r) => { require("fs").writeFileSync("/tmp/limit-out", (await r.text()).slice(0, 160)); console.log(r.status); }, (e) => { require("fs").writeFileSync("/tmp/limit-out", String(e.cause ?? e)); console.log("000"); });' "$1" "$base/responses"
  }
  # Does codex take `model_auto_compact_token_limit` from a profile FILE, the layer the managed
  # profile is (`<name>.config.toml`, --profile)? A scratch CODEX_HOME holding this container's copy
  # of the user's config and a profile with a limit far below one turn's prompt: codex compacts.
  # The control, the same profile without the key, does not. Two one-word turns each.
  honoured() {
    local rc=0
    for limit in 2000 none; do
      H=$(mktemp -d); cp "$HOME/.codex/config.toml" "$H/"
      { echo '# live-check profile'; [ "$limit" = none ] || echo "model_auto_compact_token_limit = $limit"; } > "$H/tmm-limit.config.toml"
      out=$(cd "$H" && CODEX_HOME="$H" timeout 240 codex exec --profile tmm-limit --skip-git-repo-check "Reply with the single word ready." 2>&1 | tail -2 | tr '\n' ' ')
      # codex compares the limit before its NEXT request: a second turn on the same chat.
      out="$out / $(cd "$H" && CODEX_HOME="$H" timeout 240 codex exec --profile tmm-limit --skip-git-repo-check resume --last "Reply with the single word again." 2>&1 | tail -2 | tr '\n' ' ')"
      n=$(cat "$H"/sessions/*/*/*/*.jsonl 2>/dev/null | grep -c '"type":"compacted"' || true)
      echo "live-check: codex-limit: profile limit $limit: compactions $n; codex said: ${out:0:160}"
      case "$limit:$n" in 2000:0) echo "live-check: codex-limit: FAIL (the profile's limit was not taken)"; rc=1 ;; none:[1-9]*) echo "live-check: codex-limit: FAIL (compacted with no limit)"; rc=1 ;; esac
      rm -rf "$H"
    done
    exit $rc
  }
  lo=$((1024 * 1024)); hi=$((64 * 1024 * 1024))
  s=$(status $lo); echo "live-check: codex-limit: $lo bytes -> $s $(head -c 160 /tmp/limit-out)"
  [ "$s" = 413 ] && { echo "live-check: codex-limit: FAIL (413 already at 1 MiB)"; exit 1; }
  s=$(status $hi); echo "live-check: codex-limit: $hi bytes -> $s $(head -c 160 /tmp/limit-out)"
  [ "$s" = 413 ] || { echo "live-check: codex-limit: no 413 up to 64 MiB"; honoured; }
  while [ $((hi - lo)) -gt 65536 ]; do
    mid=$(((lo + hi) / 2)); s=$(status $mid)
    if [ "$s" = 413 ]; then hi=$mid; else lo=$mid; fi
    echo "live-check: codex-limit: $mid bytes -> $s"
  done
  echo "live-check: codex-limit: accepted at $lo bytes, 413 at $hi bytes"
  honoured
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
