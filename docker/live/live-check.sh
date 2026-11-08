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
#   live-check pi-tools   board #86: a managed pi runs two bash calls; the activity log holds one
#                      tool row per call, each with its command, and no blank (argument-less) row.
#   live-check pi-paste  board #85: five lines carrying `#81` and ending in `"..."`. typed into a
#                      BUSY pi, then into an idle one, each arrive as their own user message with no
#                      inserted text and no unconfirmed report; a /command stays a command, and a
#                      two-line delivery keeps its break.
#   live-check codex-limit   board #66: the provider's request-body limit, bisected with unbilled
#                      requests (a model nobody serves: 404 under the limit, 413 over it), and that
#                      codex takes `model_auto_compact_token_limit` from a profile file.
#   live-check codex-picker  board #66: the footers of codex's menus are printed; a person opens
#                      /new's picker in a git repo, then /experimental; a delivery sent while each is
#                      open is held (the menu stays open, no worktree), and is typed and answered once
#                      Escape closes it.
set -euo pipefail
check="${1:-smoke}"
case "$check" in smoke|codex-models|codex-provider|pi|pi-tools|pi-paste|omp-tools|codex-limit|codex-picker) ;; *) echo "live-check: unknown check '$check' (known: smoke, codex-models, codex-provider, pi, pi-tools, pi-paste, omp-tools, codex-limit, codex-picker)" >&2; exit 2 ;; esac

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

# The user's ~/.pi/agent in the owner's provider shape (#71 note 6), for every pi check.
pi_user() {
  [ -n "${UST_API_KEY:-}" ] || { echo "live-check: $check: skipped: UST_API_KEY not set"; exit 2; }
  [ -f "$HOME/.codex/config.toml" ] || { echo "live-check: $check: skipped: no UST base URL (codex config not staged)"; exit 2; }
  A="$HOME/.pi/agent"; mkdir -p "$A"
  base=$(sed -n 's/^base_url *= *"\(.*\)"/\1/p' "$HOME/.codex/config.toml" | head -1)
  cat > "$A/models.json" <<J
{"providers":{"ust":{"baseUrl":"${base%/v1}","api":"anthropic-messages","apiKey":"\$UST_API_KEY","models":[{"id":"claude-opus-5-5","reasoning":true},{"id":"claude-fable-5-1","reasoning":true},{"id":"claude-sonnet-5-5","reasoning":true},{"id":"claude-haiku-5-5","reasoning":true}]},
"ust-openai":{"baseUrl":"$base","api":"openai-responses","apiKey":"\$UST_API_KEY","models":[{"id":"gpt-6-astra"},{"id":"gpt-6.1-sol"}]}}}
J
  printf '{"defaultProvider":"ust","defaultModel":"claude-opus-5-5","defaultThinkingLevel":"medium"}\n' > "$A/settings.json"
  printf '{}\n' > "$A/auth.json"
}

if [ "$check" = pi-tools ]; then
  pi_user
  rc=0
  tmm registry save --name lpt --backend pi --model ust/claude-haiku-5-5 --effort low --system "Live check agent. Do exactly what you are asked." >/dev/null
  tmm spawn lpt --project live >/dev/null
  # Ready = pi's footer (its context meter, `%/<n>k`) painted in the pane; polled with a deadline
  # (process.md section 4, validator #86 note 5), never a guessed sleep.
  pane() { tmux list-panes -a -F '#{pane_id} #{window_name}' | awk '$2=="lpt"{print $1; exit}'; }
  ready() { p=$(pane); [ -n "$p" ] && tmux capture-pane -p -t "$p" | grep -qE '%/[0-9]+k'; }
  for _ in $(seq 1 120); do ready && break; sleep 0.5; done
  ready && echo "live-check: pi-tools: pi is ready (its footer is painted)" || { echo "live-check: pi-tools: FAIL (pi's footer never painted in 60 s)"; exit 1; }
  ext=$(grep -rl --include='*.ts' 'PostToolUse' /work/live/.tmm/agents/lpt 2>/dev/null | head -1)
  grep -q 'hook_event_name: "PostToolUse", tool_name: event?.toolName ?? "tool", tool_input: event?.input' "$ext" \
    && echo "live-check: pi-tools: the home's extension sends tool_input on PostToolUse ($ext)" \
    || { echo "live-check: pi-tools: FAIL (the extension's PostToolUse carries no input: $ext)"; rc=1; }
  tmm send --project live "@lpt Run exactly two bash tool calls, one after the other: first 'echo first-86', then 'echo second-86'. Then reply with the single word done." >/dev/null
  timeout 180 bash -c "until tmm log --project live --limit 40 | grep -q '] lpt: done'; do sleep 2; done" || { echo "live-check: pi-tools: FAIL (no answer)"; rc=1; }
  # The hook helpers run detached, so a tool row may land after the Stop: the activity log is
  # polled for the exact expected state (two bash rows, both commands, no blank) until a 30 s
  # deadline; a log that never reaches it fails with what it holds.
  rows_now() { python3 - "$HOME/.config/teammux/state.db" <<'PY'
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
cols = [r[1] for r in db.execute("PRAGMA table_info(activity)")]
win = "win" if "win" in cols else "window"
for tool, text, w in db.execute(f"SELECT tool, text, {win} FROM activity WHERE kind = 'tool' ORDER BY id"):
    print(json.dumps({"window": w, "tool": tool, "text": text}))
PY
  }
  expected() {
    [ "$(printf '%s\n' "$1" | grep -c '"tool": "bash"' || true)" = 2 ] && ! printf '%s\n' "$1" | grep -q '"text": ""' \
      && printf '%s\n' "$1" | grep -q '"text": "[^"]*echo first-86' && printf '%s\n' "$1" | grep -q '"text": "[^"]*echo second-86'
  }
  for _ in $(seq 1 60); do rows=$(rows_now); expected "$rows" && break; sleep 0.5; done
  echo "live-check: pi-tools: tool rows in the activity log:"; printf '%s\n' "$rows" | sed 's/^/    /'
  n=$(printf '%s\n' "$rows" | grep -c '"tool": "bash"' || true)
  blank=$(printf '%s\n' "$rows" | grep -c '"text": ""' || true)
  for c in first-86 second-86; do printf '%s\n' "$rows" | grep -q "\"text\": \"[^\"]*echo $c" || { echo "live-check: pi-tools: FAIL (no row with echo $c)"; rc=1; }; done
  [ "$n" = 2 ] || { echo "live-check: pi-tools: FAIL ($n bash rows, expected 2)"; rc=1; }
  [ "$blank" = 0 ] || { echo "live-check: pi-tools: FAIL ($blank blank rows)"; rc=1; }
  if [ $rc = 0 ]; then echo "live-check: pi-tools: PASS"; fi
  exit $rc
fi

if [ "$check" = pi ]; then
  pi_user
  rc=0
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

if [ "$check" = pi-paste ]; then
  # Board #85: a line typed into pi's editor with `#81` in it opened pi's completion list (`#` is
  # one of its default triggers), the list followed every later character, the line's final `.`
  # listed the cwd's dot-entries, and the delivery's Enter accepted `.claude/` instead of
  # submitting: five lines became one prompt with junk at every junction, all unconfirmed.
  # Every wait polls the expected state with a deadline (process.md, board #208).
  rc=0
  pi_user
  mkdir -p /work/live/.claude   # the cwd's first dot-entry, as in the incident
  ok() { echo "live-check: pi-paste: $1"; }; bad() { echo "live-check: pi-paste: FAIL ($1)"; rc=1; }
  # until <seconds> <what> <command…>: poll the command until it succeeds or the deadline passes.
  until_ok() { local t=$1 what=$2; shift 2; local end=$((SECONDS + t)); until "$@"; do [ $SECONDS -ge $end ] && { bad "timed out after ${t}s: $what"; return 1; }; sleep 1; done; }
  H=/work/live/.tmm/agents/lpi
  pane() { tmux list-panes -a -F '#{pane_id} #{window_name}' | awk '$2=="lpi"{print $1; exit}'; }
  shot() { echo "live-check: pi-paste: --- screen: $1"; tmux capture-pane -p -t "$(pane)" | grep -v '^\s*$' | tail -12 | sed 's/^/    |/'; }
  foot() { tmux capture-pane -p -t "$(pane)" 2>/dev/null | grep -E '%/[0-9]+k' | tail -1 | sed 's/  */ /g'; }
  state() { tmm agent list --project live | sed -n 's/^[0-9]*: lpi \[pi\] \([a-z]*\).*/\1/p'; }
  is() { [ "$(state)" = "$1" ]; }
  footer_has() { case "$(foot)" in *"$1"*) return 0 ;; *) return 1 ;; esac; }
  # The user messages pi recorded, one JSON string per line, from its own session files.
  users() { { cat "$H"/sessions/*/*.jsonl 2>/dev/null || true; } | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{for(const l of t.split("\n")){if(!l.trim())continue;let e;try{e=JSON.parse(l)}catch{continue}const m=e.message;if(e.type!=="message"||!m||m.role!=="user")continue;const c=typeof m.content==="string"?m.content:(m.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("");console.log(JSON.stringify(c))}})'; }
  # Delivery rows still waiting for their confirmation (a confirmed row is deleted), read-only.
  pending() { node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("SELECT count(*) AS n FROM deliveries WHERE win = ?").get("lpi").n)' "$cfg/state.db"; }
  settled() { [ "$(pending)" = 0 ]; }
  # The rows themselves: id, typed-at and the line's head, one per row.
  rows() { node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});for(const r of d.prepare("SELECT id, ts, line FROM deliveries WHERE win = ? ORDER BY id").all("lpi"))console.log(`    row ${r.id} ts=${r.ts} ${String(r.line).slice(0,90)}`)' "$cfg/state.db"; }
  unconfirmed() { tmm log --project live --limit 200 | grep -c '\[tmm\] unconfirmed lpi' || true; }
  # The room's reply row naming `$1`, and its recipients (`to`), from the room JSON.
  reply_to() { tmm log --project live --limit 80 --output json | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{const j=JSON.parse(t);const rows=Array.isArray(j)?j:(j.messages||[]);const r=rows.filter(m=>m.from==="lpi"&&new RegExp("\\b"+process.argv[1]+"\\b").test(m.body||"")).pop();console.log(r?JSON.stringify(r.to):"none")})' "$1"; }
  # The incident's shape: `#81`, and a last token `` `…"..."`. ``. The quote is text, not a task.
  line() { printf '[board #81 reply] builder: note %s. Run nothing; reply with the single word %s. Quoted: `tmm board note 81 "..."`.' "$1" "$1"; }
  # Each marker in exactly one user message, alone, and no message carrying `.claude/`.
  apart() { # $1 label, $2.. markers
    local label=$1; shift; local all; all=$(users)
    for m in "$@"; do
      n=$(printf '%s\n' "$all" | grep -c "single word $m\\." || true)
      [ "$n" = 1 ] || bad "$label: '$m' is in $n user messages"
      if printf '%s\n' "$all" | grep "single word $m\\." | grep -q 'board #81 reply.*board #81 reply'; then bad "$label: '$m' shares its message with another line"; fi
    done
    if printf '%s\n' "$all" | grep -q '\.claude/'; then bad "$label: a user message carries .claude/"; fi
    ok "$label: user messages so far: $(printf '%s\n' "$all" | wc -l)"
  }
  tmm registry save --name lpi --backend pi --model ust/claude-haiku-5-5 --effort low --system "Live check agent. Answer in one short line." >/dev/null
  tmm spawn lpi --project live >/dev/null
  until_ok 120 "pi's footer (ready)" footer_has '%/' && ok "ready: $(foot)"
  # BUSY: a turn whose bash tool runs for 40 s; the five lines go in while it is working.
  tmm send --project live "@lpi run the shell command 'sleep 40' with your bash tool, then reply with the single word slept" >/dev/null
  until_ok 120 "lpi running" is running && ok "busy: lpi is $(state)"
  for i in 1 2 3 4 5; do tmm send --project live "@lpi $(line b$i)" >/dev/null; done
  ok "busy: after the five sends lpi is $(state), $(pending) delivery rows pending:"; rows
  is running || bad "busy: the five lines were not sent into a running turn"
  shot "busy, after the five lines"
  until_ok 240 "every busy delivery confirmed" settled && ok "busy: every delivery row confirmed ($(pending) pending)"
  until_ok 240 "the busy turn's end" is idle || true
  ok "busy: reply $(tmm log --project live --limit 40 | grep '] lpi: ' | tail -1 | cut -c1-100)"
  apart busy b1 b2 b3 b4 b5
  [ "$(unconfirmed)" = 0 ] && ok "busy: no unconfirmed report" || bad "busy: $(unconfirmed) unconfirmed reports"
  # IDLE: the same five lines, each to an agent at rest: five turns, five replies, each to its sender.
  for i in 1 2 3 4 5; do
    until_ok 120 "lpi idle before i$i" is idle || true
    tmm send --project live "@lpi $(line i$i)" >/dev/null
    ok "idle: i$i sent, pending:"; rows
    until_ok 180 "a reply naming i$i" bash -c "tmm log --project live --limit 60 | grep -q '] lpi: .*\bi$i\b'" || true
    to=$(reply_to "i$i"); ok "idle: i$i answered, reply to $to, $(pending) rows pending"
    [ "$to" = '["human"]' ] || bad "idle: the reply naming i$i went to $to, not its sender human"
  done
  until_ok 120 "every idle delivery confirmed" settled && ok "idle: every delivery row confirmed ($(pending) pending)"
  apart idle i1 i2 i3 i4 i5
  [ "$(unconfirmed)" = 0 ] && ok "idle: no unconfirmed report" || bad "idle: $(unconfirmed) unconfirmed reports"
  # A /command still reaches pi as a command, and a multi-line delivery keeps its break.
  until_ok 120 "lpi idle before /thinking" is idle || true
  tmm send --project live "@lpi /thinking high" >/dev/null
  until_ok 30 "the footer shows • high" footer_has '• high' && ok "footer after /thinking high: $(foot)"
  if users | grep -q '/thinking'; then bad "/thinking high became a user message"; fi
  tmm send --project live "@lpi first line of two
reply with the single word multi" >/dev/null
  until_ok 180 "a reply naming multi" bash -c "tmm log --project live --limit 60 | grep -q '] lpi: .*multi'" && ok "the two-line delivery answered multi"
  users | grep -q 'first line of two\\nreply with the single word multi' && ok "the two-line delivery arrived with its line break" || bad "the two-line delivery lost its line break: $(users | grep 'first line of two')"
  shot "at the end"
  echo "live-check: pi-paste: --- the user messages pi recorded:"; users | sed 's/^/    /'
  tmm log --project live --limit 60 | grep -E 'lpi|unconfirmed' | sed 's/^/    log|/'
  [ $rc = 0 ] && echo "live-check: pi-paste: PASS"
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
  # The menus a person can open: the slash list, then each menu's bottom furniture (round 1:
  # validator's /experimental footer starts `space toggle`). Escape twice closes any of them.
  tmux send-keys -t "$pane" -l /; sleep 1; shot "the slash list"; tmux send-keys -t "$pane" Escape; sleep 1; tmux send-keys -t "$pane" C-u; sleep 1
  for m in /model /experimental /skills /permissions /approvals /mcp /theme /personality /statusline /resume; do
    tmux send-keys -t "$pane" -l "$m"; sleep 1; tmux send-keys -t "$pane" Enter; sleep 3
    echo "live-check: codex-picker: --- footer of $m:"; tmux capture-pane -p -t "$pane" | grep -v '^\s*$' | tail -3 | sed 's/^/    |/'
    tmux send-keys -t "$pane" Escape; sleep 1; tmux send-keys -t "$pane" Escape; sleep 1; tmux send-keys -t "$pane" C-u; sleep 1
  done
  shot "after the survey"
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
  # Round 1 (validator's note 10): a menu whose footer leads with `space`, not `enter`.
  sleep 3
  tmux send-keys -t "$pane" -l /experimental; sleep 1; tmux send-keys -t "$pane" Enter; sleep 3; shot "/experimental opened"
  tmux capture-pane -p -t "$pane" | grep -q 'esc save/close' || { echo "live-check: codex-picker: FAIL (no /experimental menu to test against)"; exit 1; }
  tmm send --project live "@lcodex reply with the single word toggled" >/dev/null; sleep 6
  shot "a delivery sent while /experimental is open"
  if tmux capture-pane -p -t "$pane" | grep -q 'esc save/close'; then echo "live-check: codex-picker: /experimental is still open, nothing typed into it"; else echo "live-check: codex-picker: FAIL (the /experimental menu was answered)"; rc=1; fi
  if tmm log --project live --limit 10 | grep -q '] lcodex: toggled'; then echo "live-check: codex-picker: FAIL (answered under /experimental)"; rc=1; fi
  tmux send-keys -t "$pane" Escape
  if timeout 120 bash -c "until tmm log --project live --limit 10 | grep -q '] lcodex: toggled'; do sleep 2; done"; then echo "live-check: codex-picker: after Escape on /experimental the held line was typed and answered"; else echo "live-check: codex-picker: FAIL (no answer after /experimental closed)"; rc=1; fi
  n=$(tmm log --project live --limit 20 | grep -c 'single word toggled' || true)
  [ "$n" = 1 ] || { echo "live-check: codex-picker: FAIL (the toggled line is in the room $n times)"; rc=1; }
  exit $rc
fi

if [ "$check" = codex-limit ]; then
  # Board #66: the provider's request-body limit, measured with UNBILLED requests: a body of N
  # bytes naming a model no provider serves is refused 404 model_not_found when the gateway takes
  # it, 413 when the body is over its limit; the limit is bisected to 64 KiB. Nothing is generated.
  # Only those two answers are measurements (round 1, validator's note 11: a 502 had been counted
  # as taken); any other status fails the run.
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
  # 404 (taken: the model was looked up) or 413 (refused for size), else the run fails.
  measured() {
    case "$1:$(cat /tmp/limit-out)" in
      404:*model_not_found*) echo taken ;; 413:*) echo over ;;
      *) echo "live-check: codex-limit: FAIL ($2 bytes -> $1, neither the 404 model_not_found nor a 413: $(head -c 160 /tmp/limit-out))" >&2; echo none ;;
    esac
  }
  s=$(status $lo); echo "live-check: codex-limit: $lo bytes -> $s $(head -c 160 /tmp/limit-out)"
  [ "$(measured "$s" $lo)" = taken ] || { echo "live-check: codex-limit: FAIL (1 MiB not taken)"; exit 1; }
  s=$(status $hi); echo "live-check: codex-limit: $hi bytes -> $s $(head -c 160 /tmp/limit-out)"
  case "$(measured "$s" $hi)" in over) ;; taken) echo "live-check: codex-limit: no 413 up to 64 MiB"; honoured ;; *) exit 1 ;; esac
  while [ $((hi - lo)) -gt 65536 ]; do
    mid=$(((lo + hi) / 2)); s=$(status $mid)
    echo "live-check: codex-limit: $mid bytes -> $s"
    case "$(measured "$s" $mid)" in over) hi=$mid ;; taken) lo=$mid ;; *) exit 1 ;; esac
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
