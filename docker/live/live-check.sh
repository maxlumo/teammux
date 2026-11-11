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
#   live-check codex-start   board #113: eight fresh codex agents, each sent one line at a chosen
#                      moment of its start (pane created, pre-session placeholder, footer, idle),
#                      most under busy loops on every core: each line is one prompt its hook
#                      reports, confirmed and answered; then a line sent to a busy queue-mode codex
#                      waits for the turn and arrives once. A failing round prints its frames.
#   live-check write-guard   board #117: codex, claude, pi and omp are each sent a long line (800
#                      characters) and a three-line line through the guarded write (if-shell -F on
#                      the observed server, pane and process): each arrives once and whole, its row
#                      settled by the CLI's own prompt hook, with no unconfirmed report; then a
#                      steer-mode codex gets a long line steered into its running turn, once. dsh
#                      answers through the dsh-tools stand-in (text only, a fake key, no model calls).
#                      claude also gets a native slash command (/cost) through the same write.
#                      Not run here (said, not omitted): kiro and kimi (not installed); a slash
#                      command to dsh (its /model, /effort, /new are run by the app; codex-picker,
#                      pi-paste and omp-tools type them for codex, pi and omp); a busy queue line to
#                      claude, omp or dsh (no queue mode offered; codex-start and pi-paste cover it).
#   live-check pi      board #71: a managed pi 1.5.0 agent end to end. The rig writes ~/.pi/agent
#                      in the owner's provider shape (ust anthropic-messages + ust-openai
#                      openai-responses, apiKey $UST_API_KEY; orchestrator, #71 note 6); nothing of
#                      the host's ~/.pi. Spawned with a model and effort, a turn answered through
#                      the telemetry, /model and /thinking from the room, a restart that resumes
#                      the conversation, the user's auth.json and models.json still linked.
#   live-check pi-tools   board #86: a managed pi runs two bash calls; the activity log holds one
#                      tool row per call, each with its command, and no blank (argument-less) row.
#   live-check asks    board #106: a managed pi asks the person with `tmm ask` (its own tool call);
#                      the person's answer goes in over the gateway's WebSocket as the app sends it
#                      (hub_ask_answer, plain token auth); the pi receives it as a chat line quoting
#                      the ask and says which option it got; a retried answer is refused and typed
#                      nothing.
#   live-check pi-paste  board #85: five lines carrying `#81` and ending in `"..."`. typed into a
#                      BUSY pi, then into an idle one, each arrive as their own user message with no
#                      inserted text and no unconfirmed report; a /command stays a command, and a
#                      two-line delivery keeps its break.
#   live-check pi-start  board #88: ten fresh pi agents, each sent one line the moment its pane
#                      exists (before pi's footer, while its tools download): each line is held
#                      until pi's SessionStart, then arrives as its own user message, confirmed,
#                      and is answered; then the tenth, after a 150-line answer, is restarted
#                      with a line sent during the restart, which arrives once, alone.
#   live-check dsh-tools  board #87: a managed dsh 0.2.0-rc.2 against a scripted loopback stand-in
#                      for the Messages API (a fake key, zero model calls, #412's precedent): two
#                      sequential bash calls, two bash calls in ONE step (dsh runs bash exclusively),
#                      then two `read` calls in one step (concurrency-safe: dsh starts both before
#                      either result, and commits results in model order). dsh's own tool/call and
#                      tool/result events are printed from its session log, and the activity log
#                      must hold one row per call, each with its command, and no bare result row.
#   live-check codex-limit   board #66: the provider's request-body limit, bisected with unbilled
#                      requests (a model nobody serves: 404 under the limit, 413 over it), and that
#                      codex takes `model_auto_compact_token_limit` from a profile file.
#   live-check codex-picker  board #66: the footers of codex's menus are printed; a person opens
#                      /new's picker in a git repo, then /experimental; a delivery sent while each is
#                      open is held (the menu stays open, no worktree), and is typed and answered once
#                      Escape closes it.
set -euo pipefail
check="${1:-smoke}"
case "$check" in smoke|codex-models|codex-provider|codex-start|write-guard|pi|pi-tools|asks|pi-paste|pi-start|dsh-tools|omp-tools|codex-limit|codex-picker) ;; *) echo "live-check: unknown check '$check' (known: smoke, codex-models, codex-provider, codex-start, write-guard, pi, pi-tools, asks, pi-paste, pi-start, dsh-tools, omp-tools, codex-limit, codex-picker)" >&2; exit 2 ;; esac

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
for c in claude codex omp bun pi dsh; do printf 'live-check: %s --version: %s\n' "$c" "$($c --version 2>&1 | head -1)"; done

if [ "$check" = dsh-tools ] || [ "$check" = write-guard ]; then
  # The stand-in answers the n-th Messages request with step n of the script: a tool_use block per
  # call (two blocks in one message = two calls in one step), then the text done-87. It starts
  # before the gateway, so every pane the gateway's tmux opens inherits the fake key and its URL.
  cat > /work/stand-in.mjs <<'JS'
import { createServer } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
const steps = process.env.STAND_IN_STEPS === 'none' ? [] : [[['bash', { command: 'echo first-87' }]], [['bash', { command: 'echo second-87' }]],
  [['bash', { command: 'echo par-a-87' }], ['bash', { command: 'echo par-b-87' }]],
  [['read', { file_path: '/work/live/a87.txt' }], ['read', { file_path: '/work/live/b87.txt' }]]];
let n = 0;
const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
const srv = createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
    const k = n++;
    appendFileSync('/work/stand-in.log', `${req.method} ${req.url} step ${k}\n`);
    const out = [ev('message_start', { type: 'message_start', message: { id: `m${k}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })];
    const calls = steps[k];
    if (calls) calls.forEach(([name, input], i) => out.push(
      ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: `call_${k}_${i}`, name, input: {} } }),
      ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
      ev('content_block_stop', { type: 'content_block_stop', index: i })));
    else out.push(ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done-87' } }),
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }));
    out.push(ev('message_delta', { type: 'message_delta', delta: { stop_reason: calls ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 1 } }), ev('message_stop', { type: 'message_stop' }));
    const sse = out.join('');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': Buffer.byteLength(sse), connection: 'close' });
    res.end(sse);
  });
});
srv.listen(0, '127.0.0.1', () => writeFileSync('/work/stand-in.port', String(srv.address().port)));
JS
  # write-guard (#117) needs only text answers for dsh: no tool steps.
  steps=""; [ "$check" = write-guard ] && steps=none
  STAND_IN_STEPS=$steps node /work/stand-in.mjs & for _ in $(seq 1 50); do [ -s /work/stand-in.port ] && break; sleep 0.1; done
  export DEEPSEEK_API_KEY=not-a-key DEEPSEEK_BASE_URL="http://127.0.0.1:$(cat /work/stand-in.port)"
fi
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

if [ "$check" = asks ]; then
  pi_user
  rc=0
  tmm registry save --name lask --backend pi --model ust/claude-haiku-5-5 --effort low --system "Live check agent. Do exactly what you are asked." >/dev/null
  tmm spawn lask --project live >/dev/null
  pane() { tmux list-panes -a -F '#{pane_id} #{window_name}' | awk '$2=="lask"{print $1; exit}'; }
  ready() { p=$(pane); [ -n "$p" ] && tmux capture-pane -p -t "$p" | grep -qE '%/[0-9]+k'; }
  for _ in $(seq 1 120); do ready && break; sleep 0.5; done
  ready && echo "live-check: asks: pi is ready" || { echo "live-check: asks: FAIL (pi's footer never painted in 60 s)"; exit 1; }
  tmm send --project live "@lask Run exactly this one shell command and nothing else: tmm ask \"Live check 106: pick one\" --option A=alpha --option B=beta --recommend A
Then reply with the single word asked. Later a chat line from human will answer that ask: when it does, reply with received- followed by the option KEY it names (for example received-A), nothing else." >/dev/null
  timeout 180 bash -c "until tmm log --project live --limit 40 | grep -q '] lask: asked'; do sleep 2; done" || { echo "live-check: asks: FAIL (pi never said asked)"; rc=1; }
  list=$(tmm ask list --project live --output json)
  echo "live-check: asks: tmm ask list: $list"
  seq=$(printf '%s' "$list" | python3 -c 'import json,sys; a=json.load(sys.stdin)["asks"]; print(a[0]["seq"] if a and a[0]["asker"]=="lask" and a[0]["question"]=="Live check 106: pick one" and [o["key"] for o in a[0]["options"]]==["A","B"] and a[0]["recommend"]=="A" else "")')
  [ -n "$seq" ] || { echo "live-check: asks: FAIL (no open ask by lask with its options)"; exit 1; }
  echo "live-check: asks: pi's own tool call opened ask #$seq"
  answer() { node -e '
const [tok, seq, opt] = process.argv.slice(1);
const ws = new WebSocket("ws://127.0.0.1:9899/");
let step = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (step === 0) { step = 1; ws.send(JSON.stringify({ method: "auth", params: { token: tok } })); return; }
  if (step === 1) { if (!m.result?.caps?.includes("asks")) { console.log("NO-CAP " + e.data); process.exit(1); } step = 2;
    ws.send(JSON.stringify({ id: 2, method: "hub_ask_answer", params: { session: "live", seq: Number(seq), option: opt, text: "live-106" } })); return; }
  if (m.id === 2) { console.log(JSON.stringify(m.result ?? m.error)); ws.close(); process.exit(0); }
};
setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 15000);
' "$(sed -n 's/^token *= *"\(.*\)"/\1/p' "$cfg/config.toml")" "$1" "$2"; }
  r=$(answer "$seq" B)
  echo "live-check: asks: hub_ask_answer: $r"
  printf '%s' "$r" | python3 -c 'import json,sys; r=json.load(sys.stdin); a=r["ask"]; sys.exit(0 if r["applied"] and a["state"]=="answered" and a["answer_key"]=="B" and a["delivery"]=="found" else 1)' \
    || { echo "live-check: asks: FAIL (the answer did not apply and reach the pane)"; rc=1; }
  timeout 180 bash -c "until tmm log --project live --limit 40 | grep -q '] lask: received-B'; do sleep 2; done" \
    && echo "live-check: asks: pi received the answer and named option B" || { echo "live-check: asks: FAIL (pi never said received-B)"; rc=1; }
  typed=$(tmux capture-pane -p -S -200 -t "$(pane)" | grep -c 'B · beta — live-106' || true)
  r2=$(answer "$seq" A)
  echo "live-check: asks: retried answer: $r2"
  printf '%s' "$r2" | python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(0 if not r["applied"] and r["ask"]["answer_key"]=="B" and r["refused"].startswith("already answered") else 1)' \
    || { echo "live-check: asks: FAIL (a retry was not refused with the winner)"; rc=1; }
  sleep 5
  typed2=$(tmux capture-pane -p -S -200 -t "$(pane)" | grep -c 'B · beta — live-106' || true)
  [ "$typed" = "$typed2" ] && ! tmux capture-pane -p -S -200 -t "$(pane)" | grep -q 'A · alpha — live-106' \
    && echo "live-check: asks: the retry typed nothing (answer lines in the pane: $typed2)" || { echo "live-check: asks: FAIL (the retry typed something)"; rc=1; }
  echo "live-check: asks: tmm ask list --all:"; tmm ask list --project live --all | sed 's/^/    /'
  if [ $rc = 0 ]; then echo "live-check: asks: PASS"; fi
  exit $rc
fi

if [ "$check" = dsh-tools ]; then
  rc=0
  printf 'a\n' > /work/live/a87.txt; printf 'b\n' > /work/live/b87.txt
  tmm registry save --name ld87 --backend dsh --system "Live check agent." >/dev/null
  tmm spawn ld87 --project live >/dev/null
  pane() { tmux list-panes -a -F '#{pane_id} #{window_name}' | awk '$2=="ld87"{print $1; exit}'; }
  # Ready = the managed shell's own prompt `dsh ›` (its ready marker, #38/#53), polled with a deadline.
  ready() { p=$(pane); [ -n "$p" ] && tmux capture-pane -p -t "$p" | grep -q 'dsh ›'; }
  for _ in $(seq 1 120); do ready && break; sleep 0.5; done
  ready && echo "live-check: dsh-tools: dsh is ready (its prompt is painted)" || { echo "live-check: dsh-tools: FAIL (no dsh prompt in 60 s)"; tmux capture-pane -p -t "$(pane)" | tail -5 | sed 's/^/    /'; exit 1; }
  tmm send --project live "@ld87 run the scripted calls" >/dev/null
  timeout 120 bash -c "until tmm log --project live --limit 40 | grep -q '] ld87: done-87'; do sleep 1; done" || { echo "live-check: dsh-tools: FAIL (no answer)"; rc=1; tmux capture-pane -p -t "$(pane)" | tail -8 | sed 's/^/    /'; }
  echo "live-check: dsh-tools: stand-in requests:"; sed 's/^/    /' /work/stand-in.log
  # AC1: dsh's own events, from its session log (zstd-compressed JSON lines, read with node's zlib):
  # the keys of each tool/call and tool/result, and the ids that pair them.
  echo "live-check: dsh-tools: dsh's own tool events (session log):"
  node - /work/live/.tmm/agents/ld87/dsh/sessions <<'JS' | sed 's/^/    /' || { echo "live-check: dsh-tools: FAIL (the session log could not be read)"; rc=1; }
const { readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { zstdDecompressSync } = require('node:zlib');
// The log is a run of zstd frames (one per flush); each is decompressed on its own.
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const text = (buf) => {
  const out = [];
  for (let at = buf.indexOf(MAGIC); at >= 0;) {
    const next = buf.indexOf(MAGIC, at + 4);
    try { out.push(zstdDecompressSync(buf.subarray(at, next < 0 ? buf.length : next)).toString()); } catch {}
    at = next;
  }
  return out.join('');
};
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
let found = 0;
for (const f of walk(process.argv[2]).filter((f) => f.endsWith('.jsonl.zstd'))) {
  for (const line of text(readFileSync(f)).split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const t = e?.type ?? e?.event?.type; const d = e?.data ?? e?.event?.data;
    if ((t === 'tool/call' || t === 'tool/result') && d && typeof d === 'object') {
      found++;
      console.log(JSON.stringify({ type: t, keys: Object.keys(d).sort(), step: d.step, callId: d.callId, name: d.name, arguments: d.arguments, 'message.keys': d.message ? Object.keys(d.message).sort() : undefined, 'message.toolCallId': d.message?.toolCallId }));
    }
  }
}
if (!found) { console.log('no tool events found'); process.exit(1); }
JS
  rows_now() { python3 - "$HOME/.config/teammux/state.db" <<'PY'
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
for tool, text, w in db.execute("SELECT tool, text, win FROM activity WHERE kind = 'tool' ORDER BY id"):
    print(json.dumps({"window": w, "tool": tool, "text": text}))
PY
  }
  want="echo first-87|echo second-87|echo par-a-87|echo par-b-87|/work/live/a87.txt|/work/live/b87.txt"
  expected() {
    [ "$(printf '%s\n' "$1" | grep -c '"window": "ld87"' || true)" = 6 ] || return 1
    printf '%s\n' "$1" | grep -q '"text": ""' && return 1
    local IFS='|'; for c in $want; do printf '%s\n' "$1" | grep -qF "\"text\": \"$c\"" || return 1; done
  }
  # Poll the exact expected state with a deadline (the hook inbox is read asynchronously).
  for _ in $(seq 1 60); do rows=$(rows_now); expected "$rows" && break; sleep 0.5; done
  echo "live-check: dsh-tools: tool rows in the activity log:"; printf '%s\n' "$rows" | sed 's/^/    /'
  expected "$rows" || { echo "live-check: dsh-tools: FAIL (expected one row per call, each with its command, and no bare row)"; rc=1; }
  if [ $rc = 0 ]; then echo "live-check: dsh-tools: PASS"; fi
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

if [ "$check" = pi-start ]; then
  # Board #88: pi paints its footer before startup ends, and an Enter while its managed tools
  # download is refused ("Startup is still in progress"); the next line then joins the parked one.
  # A line sent at launch must wait for pi's ready edge. Every wait polls with a deadline.
  pi_user
  rc=0
  ok() { echo "live-check: pi-start: $1"; }; bad() { echo "live-check: pi-start: FAIL ($1)"; rc=1; }
  until_ok() { local t=$1 what=$2; shift 2; local end=$((SECONDS + t)); until "$@"; do [ $SECONDS -ge $end ] && { bad "timed out after ${t}s: $what"; return 1; }; sleep 0.2; done; }
  pane() { tmux list-panes -a -F '#{pane_id} #{window_name}' | awk -v w="$1" '$2==w{print $1; exit}'; }
  has_pane() { [ -n "$(pane "$1")" ]; }
  users() { { cat /work/live/.tmm/agents/"$1"/sessions/*/*.jsonl 2>/dev/null || true; } | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{for(const l of t.split("\n")){if(!l.trim())continue;let e;try{e=JSON.parse(l)}catch{continue}const m=e.message;if(e.type!=="message"||!m||m.role!=="user")continue;const c=typeof m.content==="string"?m.content:(m.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("");console.log(JSON.stringify(c))}})'; }
  pending() { node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("SELECT count(*) AS n FROM deliveries WHERE win = ?").get(process.argv[2]).n)' "$cfg/state.db" "$1"; }
  settled() { [ "$(pending "$1")" = 0 ]; }
  # A reply row from $1 whose whole body (not the log's first line) holds the word $2.
  answered() { tmm log --project live --limit 80 --output json | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{const j=JSON.parse(t);const rows=Array.isArray(j)?j:(j.messages||[]);process.exit(rows.some(m=>m.from===process.argv[1]&&new RegExp("\\b"+process.argv[2]+"\\b").test(m.body||""))?0:1)})' "$1" "$2"; }
  for i in 1 2 3 4 5 6 7 8 9 10; do
    w=ps$i
    tmm registry save --name "$w" --backend pi --model ust/claude-haiku-5-5 --effort low --system "Live check agent. Answer in one short line." >/dev/null
    tmm spawn "$w" --project live >/dev/null & sp=$!
    until_ok 30 "$w's pane" has_pane "$w" || true
    screen=$(tmux capture-pane -p -t "$(pane "$w")" 2>/dev/null | grep -c '%/[0-9]*k' || true)
    tmm send --project live "@$w reply with the single word start$i" >/dev/null
    wait "$sp"
    ok "$w: sent at launch (footer painted then: $screen), $(pending "$w") row pending"
    until_ok 200 "$w's line confirmed" settled "$w" || true
    until_ok 180 "$w's answer" answered "$w" "start$i" && ok "$w: answered start$i" || true
    u=$(users "$w")
    n=$(printf '%s\n' "$u" | grep -c . || true)
    if [ "$n" = 1 ] && printf '%s\n' "$u" | grep -q "single word start$i\"$"; then ok "$w: one user message, the line alone"; else
      bad "$w: user messages: $u"
      echo "live-check: pi-start: --- $w's screen:"; tmux capture-pane -p -S -60 -t "$(pane "$w")" | grep -v '^\s*$' | tail -25 | sed 's/^/    |/'
      tmm log --project live --limit 40 | grep -E "$w|ready" | sed 's/^/    log|/'
    fi
    if tmux capture-pane -p -S -200 -t "$(pane "$w")" | grep -q 'Startup is still in progress'; then bad "$w: pi refused an Enter during startup"; fi
    tmm log --project live --limit 80 | grep -q "\[tmm\] unconfirmed $w" && bad "$w: unconfirmed" || true
    [ $i = 10 ] || tmm agent remove "$w" --project live >/dev/null   # the project's cap is 8 agents (spawn::SPAWN_CAP)
  done
  # A restart into a session longer than one screen (#88 note 21: pi then shows neither its header
  # nor its resource listing, and keeps no history), with a line sent while it restarts.
  w=ps10
  tmm send --project live "@$w print the numbers 1 to 150, one per line, with no other text" >/dev/null
  until_ok 240 "$w's long answer" answered "$w" "150" || true
  before=$(users "$w" | grep -c . || true)
  tmm agent restart "$w" --project live >/dev/null & sp=$!
  until_ok 30 "$w restarting" bash -c "[ -f /work/live/.tmm/agents/$w/starting ]" || true
  tmm send --project live "@$w reply with the single word restarted" >/dev/null
  ok "$w: sent during the restart, $(pending "$w") row pending"
  wait "$sp"
  until_ok 200 "$w's line confirmed after the restart" settled "$w" || true
  until_ok 180 "$w's answer after the restart" answered "$w" "restarted" && ok "$w: answered restarted" || true
  lines=$(tmux capture-pane -p -S - -t "$(pane "$w")" | wc -l); ok "$w: pane history after the restart: $lines lines; [Extensions] on it: $(tmux capture-pane -p -S - -t "$(pane "$w")" | grep -c '^\[Extensions\]' || true)"
  after=$(users "$w")
  n=$(printf '%s\n' "$after" | grep -c "single word restarted\"$" || true)
  [ "$n" = 1 ] && [ "$(printf '%s\n' "$after" | grep -c . || true)" = $((before + 1)) ] && ok "$w: the line arrived once, as its own message" || bad "$w: after the restart: $after"
  tmm log --project live --limit 80 | grep -q "\[tmm\] unconfirmed $w" && bad "$w: unconfirmed" || true
  [ $rc = 0 ] && echo "live-check: pi-start: PASS"
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
  # Busy is pi's own paint of the running tool (reviewer, #88 note 6), and the bootstrap is its own
  # user message, before any b-line is sent; `running` is a receipt only.
  tool_shown() { tmux capture-pane -p -t "$(pane)" | grep -qE '^ *\$ sleep 40'; }
  until_ok 120 "pi paints the running sleep 40" tool_shown && ok "busy: pi shows '$ sleep 40' running; lpi is $(state)"
  [ "$(users | grep -c .)" = 1 ] && users | grep -q "then reply with the single word slept\"$" && ok "busy: the bootstrap is its own user message" || bad "busy: the bootstrap is not alone: $(users)"
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

if [ "$check" = write-guard ]; then
  # Board #117: every ordinary write runs under the native guard of one observation (if-shell -F
  # on the server, the pane and its process). Each installed real CLI is sent a long line and a
  # three-line line; each must arrive once and whole: its row settled by the CLI's own prompt hook
  # (the server matches the WHOLE line), one prompt row naming its marker, no unconfirmed report.
  [ -f "$HOME/.codex/config.toml" ] || { echo "live-check: write-guard: skipped: ~/.codex/config.toml not staged"; exit 2; }
  pi_user
  rc=0
  ok() { echo "live-check: write-guard: $1"; }; bad() { echo "live-check: write-guard: FAIL ($1)"; rc=1; }
  until_ok() { local t=$1 what=$2; shift 2; local end=$((SECONDS + t)); until "$@"; do [ $SECONDS -ge $end ] && { bad "timed out after ${t}s: $what"; return 1; }; sleep 0.5; done; }
  pending() { node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("SELECT count(*) AS n FROM deliveries WHERE win = ?").get(process.argv[2]).n)' "$cfg/state.db" "$1"; }
  prompts() { node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("SELECT count(*) AS n FROM activity WHERE win = ? AND kind = ? AND instr(text, ?) > 0").get(process.argv[2],"prompt",process.argv[3]).n)' "$cfg/state.db" "$1" "$2"; }
  idle() { tmm agent list --project live | grep -q "$1 \[[a-z]*\] idle"; }
  # Ready to be typed into: idle, its start released (no start mark: the backend's own ready
  # edge where it has one), and its screen settled (two reads 1 s apart are the same).
  gpane() { tmux list-panes -a -F '#{pane_id} #{window_name}' | awk -v w="$1" '$2==w{print $1; exit}'; }
  settled_screen() { local a b; a=$(tmux capture-pane -p -t "$(gpane "$1")" 2>/dev/null); sleep 1; b=$(tmux capture-pane -p -t "$(gpane "$1")" 2>/dev/null); [ -n "$a" ] && [ "$a" = "$b" ]; }
  ready() { idle "$1" && [ ! -e "/work/live/.tmm/agents/$1/starting" ] && settled_screen "$1"; }
  # A typed slash command's arrival (AC4: once and whole): its echo, a line that is the command
  # alone after an optional prompt glyph, EXACTLY once; and an answer line the echo cannot be:
  # a dollar amount. Pinned below by validator-2's two bad transcripts, which must fail.
  slash_counts() { printf '%s\n' "$2" | awk -v c="$1" '{ t=$0; sub(/^[[:space:]]*(>|❯|›)?[[:space:]]*/, "", t); sub(/[[:space:]]+$/, "", t); if (t == c) e++; if ($0 ~ /\$[0-9]+\.[0-9]+/) a++ } END { printf "echo=%d answer=%d", e+0, a+0 }'; }
  slash_once() { case "$(slash_counts "$1" "$2")" in "echo=1 answer="[1-9]*) true ;; *) false ;; esac; }
  slash_answered() { slash_counts "$1" "$(tmux capture-pane -p -S -300 -t "$(gpane "$2")")" | grep -q 'answer=[1-9]'; }
  good=$(printf '❯ /cost\n  Usage by model:\n  write ($0.1053)\n'); dup=$(printf '> /cost\n> /cost\n  write ($0.1053)\n'); bare=$(printf '> /cost\n  Esc to cancel\n')
  if slash_once /cost "$good" && ! slash_once /cost "$dup" && ! slash_once /cost "$bare"; then ok "the slash predicate passes one answered echo and fails a duplicate and an echo with no answer"; else bad "the slash predicate's own controls"; fi
  # Pacing only (omp's turn may not end in this rig): waits, never fails, says the state.
  pace() { local end=$((SECONDS + 120)); until idle "$1" || [ $SECONDS -ge $end ]; do sleep 0.5; done; ok "$1 is $(tmm agent list --project live | grep -o "$1 \[[a-z]*\] [a-z]*" | awk '{print $3}') before the next line"; }
  long=$(for i in $(seq 1 160); do printf 'w%03d ' "$i"; done)
  for b in codex claude pi omp dsh; do
    w=g$b; extra=""; [ $b = pi ] && extra="--model ust/claude-haiku-5-5 --effort low"
    tmm registry save --name "$w" --backend "$b" $extra --system "Live check agent. Answer in one short line." >/dev/null
    tmm spawn "$w" --project live >/dev/null
    until_ok 120 "$w ready" ready "$w" || true
    tmm send --project live "@$w LONG-$b-117 reply with the single word long. $long" >/dev/null
    until_ok 120 "$w's long line settled" bash -c "[ \"\$(node --no-warnings -e 'const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare(\"SELECT count(*) AS n FROM deliveries WHERE win = ?\").get(process.argv[2]).n)' $cfg/state.db $w)\" = 0 ]" || true
    pace "$w"
    printf -v multi '@%s MULTI-%s-117 first of three\nsecond of three\nreply with the single word multi' "$w" "$b"
    tmm send --project live "$multi" >/dev/null
    until_ok 120 "$w's multi-line settled" bash -c "[ \"\$(node --no-warnings -e 'const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare(\"SELECT count(*) AS n FROM deliveries WHERE win = ?\").get(process.argv[2]).n)' $cfg/state.db $w)\" = 0 ]" || true
    pace "$w"
    a=$(prompts "$w" "LONG-$b-117"); m=$(prompts "$w" "MULTI-$b-117")
    if [ "$a" = 1 ] && [ "$m" = 1 ] && [ "$(pending "$w")" = 0 ]; then ok "$b: the long line and the three-line line each arrived once, settled"; else bad "$b: prompts long=$a multi=$m, $(pending "$w") rows pending"; fi
    if tmm log --project live --limit 80 | grep -q "\[tmm\] unconfirmed $w"; then bad "$b: unconfirmed"; fi
    if tmm log --project live --limit 80 | grep -q "undelivered"; then bad "$b: undelivered: $(tmm log --project live --limit 80 | grep undelivered | tail -2)"; fi
    if [ $b = claude ]; then
      # A native slash command, typed verbatim through the same guarded write (hub_command):
      # its echo is on the pane EXACTLY once, and claude's answer is there, recognised by a
      # line the echo cannot match (a dollar amount of the cost breakdown).
      tmm send --project live "@$w /cost" >/dev/null
      until_ok 60 "claude's /cost answer" slash_answered "/cost" "$w" || true
      shown=$(tmux capture-pane -p -S -300 -t "$(gpane "$w")")
      echo "live-check: write-guard: --- $w after /cost:"; printf '%s\n' "$shown" | grep -v '^\s*$' | tail -12 | sed 's/^/    |/'
      if slash_once "/cost" "$shown"; then ok "claude: /cost reached the CLI once and was answered"; else bad "claude: /cost: $(slash_counts "/cost" "$shown")"; fi
    fi
    tmm agent remove "$w" --project live >/dev/null || true
  done
  # A STEER line through the guard (codex, the installed backend that offers steer): typed into
  # the RUNNING turn, recorded as a steered event with no pending row, and taken by codex once
  # (its prompt hook fires inside the turn, codex.rs SWITCHES_INPUT_MODE).
  w=gsteer
  tmm registry save --name "$w" --backend codex --input-mode steer --system "Follow the requested shell command exactly; answer in one short line." >/dev/null
  tmm spawn "$w" --project live >/dev/null
  until_ok 120 "$w ready" ready "$w" || true
  tmm send --project live "@$w Run the shell command: sleep 25. Then reply with the single word slept" >/dev/null
  until_ok 60 "$w working" bash -c "tmm agent list --project live | grep -q '$w \[codex\] running'" || true
  tmm send --project live "@$w STEER-codex-117 also say the word steered. $long" >/dev/null
  steered() { node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("SELECT count(*) AS n FROM activity WHERE win = ? AND kind = ? AND instr(text, ?) > 0").get(process.argv[2],"steered",process.argv[3]).n)' "$cfg/state.db" "$1" "$2"; }
  until_ok 60 "$w's steered event" bash -c "[ \"\$(node --no-warnings -e 'const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare(\"SELECT count(*) AS n FROM activity WHERE win = ? AND kind = ? AND instr(text, ?) > 0\").get(process.argv[2],\"steered\",\"STEER-codex-117\").n)' $cfg/state.db $w)\" = 1 ]" || true
  until_ok 180 "$w's prompt hook took the steer line" bash -c "[ \"\$(node --no-warnings -e 'const {DatabaseSync}=require(\"node:sqlite\");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare(\"SELECT count(*) AS n FROM activity WHERE win = ? AND kind = ? AND instr(text, ?) > 0\").get(process.argv[2],\"prompt\",\"STEER-codex-117\").n)' $cfg/state.db $w)\" -ge 1 ]" || true
  pace "$w"
  st=$(steered "$w" "STEER-codex-117"); pr=$(prompts "$w" "STEER-codex-117")
  if [ "$st" = 1 ] && [ "$pr" = 1 ] && [ "$(pending "$w")" = 0 ]; then ok "codex steer: the line steered into the running turn once (steered 1, prompt 1, nothing pending)"; else bad "codex steer: steered=$st prompt=$pr pending=$(pending "$w")"; fi
  if tmm log --project live --limit 80 | grep -q "\[tmm\] unconfirmed $w"; then bad "codex steer: unconfirmed"; fi
  echo "live-check: write-guard: --- $w's last lines:"; tmux capture-pane -p -t "$(tmux list-panes -a -F '#{pane_id} #{window_name}' | awk -v w=$w '$2==w{print $1; exit}')" | grep -v '^\s*$' | tail -12 | sed 's/^/    |/'
  [ $rc = 0 ] && echo "live-check: write-guard: PASS"
  exit $rc
fi

if [ "$check" = codex-start ]; then
  # Board #113: a fresh codex left the first delivered line whole in its composer, unsubmitted:
  # its placeholder paints before its session is configured, and a queue-mode Enter typed then is
  # dropped. Each round spawns one fresh codex and sends one line at a moment of its start. Every
  # frame of the pane is recorded from the spawn, so a failing round shows what codex painted
  # when the line was typed. Every wait polls with a deadline.
  [ -f "$HOME/.codex/config.toml" ] || { echo "live-check: codex-start: skipped: ~/.codex/config.toml not staged"; exit 2; }
  rc=0; rounds=${CODEX_START_ROUNDS:-8}
  ok() { echo "live-check: codex-start: $1"; }; bad() { echo "live-check: codex-start: FAIL ($1)"; rc=1; }
  until_ok() { local t=$1 what=$2; shift 2; local end=$((SECONDS + t)); until "$@"; do [ $SECONDS -ge $end ] && { bad "timed out after ${t}s: $what"; return 1; }; sleep 0.1; done; }
  pane() { tmux list-panes -a -F '#{pane_id} #{window_name}' | awk -v w="$1" '$2==w{print $1; exit}'; }
  has_pane() { [ -n "$(pane "$1")" ]; }
  footer() { tmux capture-pane -p -t "$(pane "$1")" 2>/dev/null | grep -qE 'Context [0-9]+% (used|left)'; }
  pending() { node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("SELECT count(*) AS n FROM deliveries WHERE win = ?").get(process.argv[2]).n)' "$cfg/state.db" "$1"; }
  settled() { [ "$(pending "$1")" = 0 ]; }
  answered() { tmm log --project live --limit 80 | grep -q "] $1: .*$2"; }
  # The user prompts codex itself recorded (its rollout's user_message events).
  # The prompts the CLI's own hook reported for this window (userPromptSubmit), holding $2.
  prompts() { node --no-warnings -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare("SELECT count(*) AS n FROM activity WHERE win = ? AND kind = ? AND instr(text, ?) > 0").get(process.argv[2],"prompt",process.argv[3]).n)' "$cfg/state.db" "$1" "$2"; }
  placeholder() { local f; f=$(tmux capture-pane -p -t "$(pane "$1")" 2>/dev/null) && [[ $f == *"Ask Codex to do anything"* ]] && [[ $f != *"Context "* ]]; }
  # Every distinct frame, stamped in ms since the spawn, until the file /tmp/stop-$1 exists.
  record() { local w=$1 t0=$2 last="" f; until [ -f "/tmp/stop-$w" ]; do
      p=$(pane "$w"); [ -n "$p" ] && f=$(tmux capture-pane -p -t "$p" 2>/dev/null | grep -v '^\s*$') && [ "$f" != "$last" ] && { echo "=== +$(( $(date +%s%3N) - t0 )) ms"; echo "$f"; last=$f; }
      sleep 0.05; done > "/tmp/frames-$w"; }
  for i in $(seq 1 "$rounds"); do
    w=cs$i; mode=queue; [ $((i % 4)) = 0 ] && mode=steer
    # The plan, one round each: when the line is sent, and how long it is. The long line is the
    # validator's #106 bootstrap (262 characters, codex wraps it to four rows).
    plan=${CODEX_START_PLAN:-placeholder:long:load launch:long:load placeholder:short:load placeholder:long:load footer:long:load placeholder:short:load idle:short placeholder:long}
    step=$(echo $plan | cut -d' ' -f$(( (i - 1) % $(echo $plan | wc -w) + 1 )))
    when=$(echo "$step" | cut -d: -f1); size=$(echo "$step" | cut -d: -f2); load=$(echo "$step" | cut -d: -f3)
    # load: busy loops on every core while codex starts (the validator's rig ran its Rust gates
    # beside it), stopped once the round is judged.
    burners=""; if [ "$load" = load ]; then for _ in $(seq 1 $(( $(nproc) * 2 ))); do (while :; do :; done) & burners="$burners $!"; done; fi
    tmm registry save --name "$w" --backend codex --input-mode "$mode" --system "Follow the requested shell command exactly; answer in one short line." >/dev/null
    t0=$(date +%s%3N); record "$w" "$t0" & rec=$!
    tmm spawn "$w" --project live >/dev/null & sp=$!
    case $when in
      launch) until_ok 30 "$w's pane" has_pane "$w" || true ;;
      footer) until_ok 120 "$w's footer" footer "$w" || true ;;
      idle) until_ok 120 "$w's footer" footer "$w" || true; sleep 10 ;;
      # The placeholder painted before the footer, the validator's #106 poll (/Ask Codex/).
      placeholder) until_ok 60 "$w's placeholder" placeholder "$w" || true ;;
    esac
    if [ $size = long ]; then line="Execute this shell command: touch /work/live/start$i; while ! test -f /work/live/start$i; do sleep 1; done; echo gate-open. Then reply with the single word start$i. When you subsequently receive an answer to an ask, reply BUSY-B only."
    else line="Run the shell command: echo start$i. Then reply with the single word start$i"; fi
    tmm send --project live "@$w $line" >/dev/null
    ok "$w ($mode, $size line, sent at $when${load:+, under load}, +$(( $(date +%s%3N) - t0 )) ms): $(pending "$w") row pending"
    wait "$sp" || true; rc0=$rc
    until_ok 60 "$w's line confirmed" settled "$w" || true
    until_ok 120 "$w's answer" answered "$w" "start$i" && ok "$w: answered start$i" || true
    touch "/tmp/stop-$w"; wait "$rec" || true
    [ -z "$burners" ] || kill $burners 2>/dev/null || true
    n=$(prompts "$w" "single word start$i")
    if [ "$n" = 1 ]; then ok "$w: its hook reported the line as one prompt"; else bad "$w: its hook reported the line $n times"; fi
    if tmm log --project live --limit 80 | grep -q "\[tmm\] unconfirmed $w"; then bad "$w: unconfirmed"; fi
    if [ $rc != $rc0 ] || [ $i = 1 ]; then echo "live-check: codex-start: --- $w's frames from the spawn:"; sed 's/^/    |/' "/tmp/frames-$w" | tail -400; fi
    tmm agent remove "$w" --project live >/dev/null || true   # the project's cap is 8 agents (spawn::SPAWN_CAP)
  done
  # The busy queue (#257) is unchanged: a line sent while a queue-mode codex works waits for the
  # turn's end and becomes its own prompt, once.
  w=csq; tmm registry save --name "$w" --backend codex --input-mode queue --system "Follow the requested shell command exactly; answer in one short line." >/dev/null
  tmm spawn "$w" --project live >/dev/null
  until_ok 120 "$w's footer" footer "$w" || true
  tmm send --project live "@$w Run the shell command: sleep 20. Then reply with the single word busy-a" >/dev/null
  until_ok 60 "$w working" bash -c "tmm agent list --project live | grep -q '$w \[codex\] running'" || true
  tmm send --project live "@$w Reply with the single word busy-b" >/dev/null
  ok "$w: busy-b sent while $w is $(tmm agent list --project live | grep -o "$w \[codex\] [a-z]*" | awk '{print $3}'), $(pending "$w") row pending"
  until_ok 180 "$w's busy-a" answered "$w" busy-a && until_ok 120 "$w's busy-b" answered "$w" busy-b && ok "$w: answered busy-a, then busy-b" || true
  until_ok 60 "$w's lines confirmed" settled "$w" || true
  a=$(prompts "$w" "single word busy-a"); b=$(prompts "$w" "single word busy-b")
  if [ "$a" = 1 ] && [ "$b" = 1 ]; then ok "$w: each line reported as one prompt"; else bad "$w: prompts busy-a $a, busy-b $b"; fi
  if tmm log --project live --limit 80 | grep -q "\[tmm\] unconfirmed $w"; then bad "$w: unconfirmed"; fi
  [ $rc = 0 ] && echo "live-check: codex-start: PASS"
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
