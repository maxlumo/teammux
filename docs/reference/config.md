# Configuration reference

Runtime configuration of the WebSocket server and the Team feature. Build and dev-loop settings are in `../conventions/development.md`.

`tmm setup` writes the connection keys interactively (board #323; the first `tmm gateway` asks too when the file is absent), keeping every other key and comment and saving paths absolute; a file it cannot read or parse is left untouched and stops the command. File: `<config>/config.toml`, the configuration directory chosen as described under *Where the configuration lives* — token, host, port, tmux_socket, tls_cert, tls_key, scrollback, disconnect_grace_secs, kiro_engine, ui_dir, restore_on_start, trusted_proxies.

```toml
token = "auto-generated-uuid"  # written on first launch
host = "0.0.0.0"               # optional
port = 9899                    # optional
tmux_socket = ""               # optional, tmux -S path
tls_cert = ""                  # optional, PEM cert for wss://
tls_key = ""                   # optional, PEM private key for wss://
disconnect_grace_secs = 600    # optional
restore_on_start = true        # optional; board #422 (false turns the automatic start off)
ui_dir = ""                    # optional, absolute path of a built web UI (dist/)
trusted_proxies = []           # optional; board #441 (OFF: read the preconditions below first)
```

Env vars `TOKEN`, `HOST`, `PORT`, `TMUX_SOCKET`, `TLS_CERT`, `TLS_KEY`, `SCROLLBACK`, `DISCONNECT_GRACE_SECS` override config. **An installed gateway service does not use them** (board #323): it runs `tmm gateway start --service`, which loads `config.toml` ALONE, so neither the installing shell nor the user manager's environment can change its port, bind, token or TLS. `tmm gateway install|status` say so when any override is set in the calling shell, and `status` reads the same file-only view, read-only. Put a lasting change in `config.toml`, then `tmm gateway restart`. (The retired Team feature's `TEAM_*` keys are gone, board #100; `projects::rooms::import_legacy` still reads `TEAM_DB`/`team_db`/`crew_db`/`agora_db` once to locate a legacy team.db for the one-off chat-history import.)
Default scrollback: 500 lines.
`ui_dir` (config.toml only, absolute): a built web UI the gateway serves on its own port (board #323). Unset: the UI built into the binary (`--features embed-ui`, what `npm run build:server` builds), else none. A `ui_dir` without a readable `index.html` serves nothing — `tmm ui` says why. See tmm-cli.md § The web UI on the gateway's own port.
`<config>/AGENTS.md` — optional app-wide agent instructions, prepended to every managed agent's system prompt at spawn (`tmm prompt`, Settings → Agents). Absent = none. See `docs/design-docs/features/tmm-cli.md` § The app-wide instructions.
`state.db` must live in a directory only you can change: the default configuration directory is made 0700, and a custom `TMM_STATE_DB` directory must be yours and not group- or other-writable, under ancestors owned by root or you (sticky allowed), or the store refuses to open (board #448; agents-overview.md § A definition's secrets). Per-agent settings are not in this file: each registry definition (backend, model, effort, input mode `queue`|`steer`, prompt, skills, MCP) lives in `state.db` and is edited in Settings → Agents or with `tmm registry save`. The input mode is offered only for kiro and codex; see agents-overview.md § The input mode.
`kiro_engine` (default `v2`; env `KIRO_ENGINE`): the kiro-cli agent engine managed kiro agents launch with — `v2` (the CLI's default) or `v3` (kiro-cli 2.22.1's KAS engine). Read at spawn and at every refresh; an agent takes it at its next restart. Under `v3` each managed kiro agent also gets a symlink `<ws>/.kiro/agents/<name>.json` into its isolated home (see agents-overview.md § kiro 2.22.1). Board #207.

Default restore_on_start: true (since board #422 round 4's live acceptance, `scripts/restore-acceptance.sh`). A gateway start after a host reboot brings back the sessions and agents the last checkpoint saw live (`docs/design-docs/features/projects.md` § After a host reboot); `false` turns that off, and so does a config.toml that cannot be read or parsed (said on stderr by kind and line/column only, never the file's text, which holds the token: a person's opt-out is never lost to a torn file). The switch governs only the automatic start: `tmm project restore --run` is the person's door either way, and `tmm project restore` shows the switch's state.

`trusted_proxies` (config.toml only; default OFF): IPs or CIDRs whose `X-Forwarded-For` the auth lockout believes (board #441; websocket-server.md § The lockout key behind a trusted proxy). From a TCP peer inside the list, the lockout is keyed by the right-most `X-Forwarded-For` entry outside the list; any missing or unusable header keys by the peer, as when OFF. A wrong entry or shape turns the key off as a whole (said once, by position) and leaves the rest of the file loading. `tmm gateway status` shows what the running gateway does. **Read before setting it:**

- *What it trusts.* `trusted_proxies = ["127.0.0.1/32", "::1/128"]` trusts every program that can open a TCP connection to the gateway's port from this host without passing the proxy, and each can choose its own lockout key (dodge it, or lock someone else out). Two preconditions: (1) the reverse tunnel's far end binds loopback only. On tky, sshd's `GatewayPorts yes` makes the `-R 127.0.0.1:9899` and `:5173` forwards listen on 0.0.0.0, reachable without Caddy from the security groups' other sources; set `GatewayPorts clientspecified` (or `no`) and confirm with `ss -ltn` that they listen on 127.0.0.1 only. (2) This host's agents reach the gateway over the local socket (board #440), not TCP, and no other local program you do not trust talks to the TCP port.
- *What reaches the gateway today.* Caddy on tky, without its own `trusted_proxies`, replaces any incoming `X-Forwarded-For` with the CloudFront edge's address (measured, Caddy v2.11.4). Setting the key alone therefore keys by EDGE: a stranger on another edge can no longer lock the owner out, one on the owner's edge still can.
- *Keying by the viewer* (option B; every step is the owner's, in this order, against production). Placeholders: `<edge>` is the host that runs Caddy and is the reverse tunnel's far end; `<caddy-dir>` holds its compose file, `Caddyfile` (bind-mounted read-only into the container) and `proxy.env`; `<caddy-container>` and `<caddy-service>` are the container and its compose service; `<tunnel-unit>` is this host's user unit that opens the `-R 127.0.0.1:5173` and `-R 127.0.0.1:9899` forwards; `<distribution-id>` and `<distribution-domain>` are the CloudFront distribution's. This deployment's values, and the inventory of the edge's other reverse forwards, are on board #441. Every block below is bash and **fails closed**: it runs in a subshell with `set -eu -o pipefail` and checks its preconditions first. A line starting `stop, nothing published:` is a failed check before any write: the block can be rerun once the cause is fixed. A line starting `FAIL, may be partly applied:` comes after something was already applied (a file written, an update accepted, a service restarted): do not rerun; check the state and recover with the exact line it prints. A command that fails without its own message stops the block the same way; a failure before the block's first write changed nothing. The Caddyfile runs with `admin off`, so step 3 restarts the Caddy service, which drops every open connection through it, other sites' included.
  0. **An owner-only working directory** on the machine with the AWS profile, outside the repository: the distribution's config holds the origin's custom headers (an origin-verification secret among them), so no copy of it is ever readable by others, pasted into the room or committed. Keep it until the deployment is accepted or rolled back, then remove it (`rm -rf "$OP"`).
     ```bash
     umask 077; OP=$(mktemp -d "${TMPDIR:-/tmp}/trusted-proxies.XXXXXX") && export OP && echo "ok: $OP (mode $(stat -c %a "$OP"))"   # → mode 700
     ```
  1. **Close the direct path on `<edge>`** (precondition: a forward listening on `0.0.0.0` lets anything that reaches it set its own `X-Forwarded-For`). First decide the bind every OTHER reverse forward into `<edge>` needs: from the next reconnect, a forward whose `-R` names no address binds loopback only, so one meant to be reached on another interface must name it (`-R <that-interface's-address>:<port>:localhost:<port>`); list them with `ss -ltnpH | grep sshd`. Then, on `<edge>`:
     ```bash
     ( set -eu -o pipefail
       [ "$(sshd -T | grep -i '^gatewayports ')" = "gatewayports yes" ] || { echo "stop, nothing published: GatewayPorts is not 'yes' — re-read before changing"; exit 1; }
       [ "$(grep -c '^GatewayPorts yes$' /etc/ssh/sshd_config)" = 1 ] || { echo "stop, nothing published: not exactly one 'GatewayPorts yes' line in sshd_config"; exit 1; }
       cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.new
       sed -i 's/^GatewayPorts yes$/GatewayPorts clientspecified/' /etc/ssh/sshd_config.new
       { sshd -t -f /etc/ssh/sshd_config.new && [ "$(sshd -T -f /etc/ssh/sshd_config.new | grep -i '^gatewayports ')" = "gatewayports clientspecified" ]; } \
         || { echo "stop, nothing published: the edited copy does not check out"; rm /etc/ssh/sshd_config.new; exit 1; }
       BAK=/etc/ssh/sshd_config.bak-$(date +%Y%m%d-%H%M%S); cp -p /etc/ssh/sshd_config "$BAK"
       cat /etc/ssh/sshd_config.new > /etc/ssh/sshd_config || { echo "FAIL, may be partly applied: writing sshd_config failed and it may be partly written; do not reload; restore with: cat $BAK > /etc/ssh/sshd_config"; exit 1; }
       cmp -s /etc/ssh/sshd_config.new /etc/ssh/sshd_config && sshd -t || { echo "FAIL, may be partly applied: sshd_config is not the checked copy; do not reload; restore with: cat $BAK > /etc/ssh/sshd_config"; exit 1; }
       rm /etc/ssh/sshd_config.new
       systemctl reload ssh || { echo "FAIL, may be partly applied: reload failed with the new file in place; check: systemctl status ssh; to go back: cat $BAK > /etc/ssh/sshd_config && systemctl reload ssh"; exit 1; }   # or sshd, by distribution; open sessions and forwards stay as they are
       echo "ok: backup $BAK" )
     ```
     Existing forwards keep their old bind until their ssh connection is made again: on this host, `systemctl --user restart <tunnel-unit>` (remote clients drop and reconnect). **Check** on `<edge>`: `ss -ltnH '( sport = :9899 or sport = :5173 )'` lists `127.0.0.1:9899` and `127.0.0.1:5173` only, no `0.0.0.0` or `[::]`. Also confirm the second precondition: this host's agents reach the gateway over the local socket (#440), and nothing else here you do not trust talks to TCP `127.0.0.1:9899`.
  2. **Switch the origin request policy** of the tmux-mobile behavior(s) from Managed-AllViewer (`216adef6-5c7f-47e4-b989-5492eafa07d3`) to Managed-AllViewerAndCloudFrontHeaders-2022-06 (`33f36d7e-f396-46d9-90e0-52428a34d9dc`, [AWS managed policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html)), which adds `CloudFront-Viewer-Address` (the viewer's `ip:port`); when a policy adds that header, CloudFront overwrites a viewer-sent value of the same name ([Restrictions on Lambda@Edge, "CloudFront headers"](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-at-edge-function-restrictions.html)). Only the behaviors you name change, and only if each is on the old policy; the change is recorded in `$OP/changes.json`, which is all the rollback undoes. First list the behaviors and their policies, and choose (`default` is the default cache behavior, anything else a path pattern). This listing block is also the way to look at the distribution later: it keeps the config in `$OP` and prints only each behavior's policy, never the whole config (whose origin headers hold a secret):
     ```bash
     ( set -eu -o pipefail; umask 077; cd "${OP:?run step 0 first}"
       aws cloudfront get-distribution-config --id <distribution-id> > dist-list.json
       jq -r '.DistributionConfig | (.DefaultCacheBehavior | "default \(.OriginRequestPolicyId)"), (.CacheBehaviors.Items[]? | "\(.PathPattern) \(.OriginRequestPolicyId)")' dist-list.json )
     ```
     Then, with `TARGETS` set to the chosen behaviors:
     ```bash
     export TARGETS='default'   # space-separated: default and/or path patterns
     ( set -eu -o pipefail; umask 077; cd "${OP:?run step 0 first}"
       ID=<distribution-id> OLD=216adef6-5c7f-47e4-b989-5492eafa07d3 NEW=33f36d7e-f396-46d9-90e0-52428a34d9dc
       [ "$(aws cloudfront get-origin-request-policy --id "$NEW" --query OriginRequestPolicy.OriginRequestPolicyConfig.Name --output text)" = "Managed-AllViewerAndCloudFrontHeaders-2022-06" ] \
         || { echo "stop, nothing published: $NEW is not Managed-AllViewerAndCloudFrontHeaders-2022-06"; exit 1; }
       cat > flip.jq <<'JQ'
     def flip($t; $from; $to):
       if $t == "default" then
         if .DefaultCacheBehavior.OriginRequestPolicyId == $from then .DefaultCacheBehavior.OriginRequestPolicyId = $to
         else error("default: policy is \(.DefaultCacheBehavior.OriginRequestPolicyId), not \($from)") end
       else
         ([.CacheBehaviors.Items[]? | select(.PathPattern == $t)] | length) as $n
         | if $n != 1 then error("\($t): \($n) behaviors with that path pattern") else
             .CacheBehaviors.Items |= map(if .PathPattern != $t then .
               elif .OriginRequestPolicyId == $from then .OriginRequestPolicyId = $to
               else error("\($t): policy is \(.OriginRequestPolicyId), not \($from)") end)
           end
       end;
     .DistributionConfig | ($targets | split(" ") | map(select(. != ""))) as $ts
     | if ($ts | length) == 0 then error("no behavior named") else reduce $ts[] as $t (.; flip($t; $from; $to)) end
     JQ
       aws cloudfront get-distribution-config --id "$ID" > dist-before.json
       [ -n "${TARGETS//[[:space:]]/}" ] || { echo "stop, nothing published: TARGETS names no behavior"; exit 1; }
       jq --arg targets "$TARGETS" --arg from "$OLD" --arg to "$NEW" -f flip.jq dist-before.json > dist-after.json \
         || { echo "stop, nothing published: a named behavior is missing or not on $OLD (jq says which, above)"; exit 1; }
       cmp -s <(jq -S 'del(.. | .OriginRequestPolicyId?)' <(jq .DistributionConfig dist-before.json)) <(jq -S 'del(.. | .OriginRequestPolicyId?)' dist-after.json) \
         || { echo "stop, nothing published: more than OriginRequestPolicyId would change"; exit 1; }
       jq -n --arg id "$ID" --arg targets "$TARGETS" --arg old "$OLD" --arg new "$NEW" '{id: $id, targets: $targets, old: $old, new: $new}' > changes.json
       aws cloudfront update-distribution --id "$ID" --if-match "$(jq -r .ETag dist-before.json)" --distribution-config file://dist-after.json > /dev/null \
         || { echo "FAIL, may be partly applied: update-distribution failed; check with the listing block above (never a bare get-distribution-config); if a recorded behavior did change, run the rollback block (2)"; exit 1; }
       echo "ok: updated $TARGETS; waiting for Deployed"
       aws cloudfront wait distribution-deployed --id "$ID" && [ "$(aws cloudfront get-distribution --id "$ID" --query Distribution.Status --output text)" = Deployed ] \
         || { echo "FAIL, may be partly applied: the update was accepted but is not Deployed yet; do not rerun; check: aws cloudfront get-distribution --id $ID --query Distribution.Status"; exit 1; }
       echo "ok: Deployed" )
     ```
     **Do not go on until it says `ok: Deployed`**: an accepted update is not yet on every edge, and an edge on the old policy forwards a viewer-sent value.
  3. **Copy the header into `X-Forwarded-For` in Caddy**, on the three tmux-mobile `reverse_proxy` blocks (the exact `/{$BACKEND_PATH}`, the `/{$BACKEND_PATH}/*` prefix to `:9899`, and the default `handle` to `:5173`). On `<edge>`: the edit is made on a copy, which is published only if it adds exactly those three lines and nothing else and Caddy validates it with the running image:
     ```bash
     ( set -eu -o pipefail; cd <caddy-dir>
       LINE='header_up X-Forwarded-For {http.request.header.CloudFront-Viewer-Address}'
       [ "$(grep -cF "$LINE" Caddyfile || true)" = 0 ] || { echo "stop, nothing published: the line is already there"; exit 1; }
       cp -p Caddyfile Caddyfile.new
       sed -i 's/^\(\t*\)header_up Host localhost:\(9899\|5173\)$/&\n\1header_up X-Forwarded-For {http.request.header.CloudFront-Viewer-Address}/' Caddyfile.new
       [ "$(grep -cF "$LINE" Caddyfile.new || true)" = 3 ] || { echo "stop, nothing published: not three added lines"; rm Caddyfile.new; exit 1; }
       diff Caddyfile Caddyfile.new > Caddyfile.diff || true
       [ "$(grep -c '^[<>]' Caddyfile.diff || true)" = 3 ] && [ "$(grep '^>' Caddyfile.diff | grep -vcF "$LINE" || true)" = 0 ] \
         || { echo "stop, nothing published: the diff is not exactly the three added lines"; rm Caddyfile.new Caddyfile.diff; exit 1; }
       docker run --rm --env-file proxy.env -v "$PWD/Caddyfile.new:/etc/caddy/Caddyfile:ro" \
         "$(docker inspect -f '{{.Config.Image}}' <caddy-container>)" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null 2>&1 \
         || { echo "stop, nothing published: caddy validate failed"; rm Caddyfile.new Caddyfile.diff; exit 1; }
       BAK="Caddyfile.bak-$(date +%Y%m%d-%H%M%S)"; cp -p Caddyfile "$BAK"
       cat Caddyfile.new > Caddyfile || { echo "FAIL, may be partly applied: writing Caddyfile failed and it may be partly written; do not restart; restore with: cat $BAK > Caddyfile"; exit 1; }   # in place: the bind mount follows this file's inode
       cmp -s Caddyfile.new Caddyfile || { echo "FAIL, may be partly applied: Caddyfile is not the validated copy; do not restart; restore with: cat $BAK > Caddyfile"; exit 1; }
       rm Caddyfile.new Caddyfile.diff
       docker compose restart <caddy-service> || { echo "FAIL, may be partly applied: the new Caddyfile is in place but the restart failed; check: docker compose ps; to go back: cat $BAK > Caddyfile && docker compose restart <caddy-service>"; exit 1; }
       echo "ok: published; backup $BAK" )
     ```
     **Check**: `curl -sS -o /dev/null -w '%{http_code}\n' https://<distribution-domain>/` gives `200`, and the app reconnects. The gateway still ignores the header (step 4 has not happened).
  4. **Trust the tunnel.** On this host, add `trusted_proxies = ["127.0.0.1"]` at the top level of `~/.config/tmux-mobile/config.toml` (not inside a `[table]`), then `tmm gateway restart` (every client drops and reconnects). **Check**: `tmm gateway status` says `keyed by X-Forwarded-For behind 127.0.0.1…`. Anything else (`keyed by the TCP peer (trusted_proxies ignored: …)`) is the reason, by position; undo before going on.
  5. **The go-live check is an owner-authorized window, not a formality.** On this host (it reads the gateway's journal), with `BACKEND_PATH` set to the value in `<caddy-dir>/proxy.env` (never pasted into the room). One plain login per route with forged `CloudFront-Viewer-Address` and `X-Forwarded-For` and a wrong token: the route `/ws` (Vite), the exact `/$BACKEND_PATH` and the prefix `/$BACKEND_PATH/ws`. Each probe passes only on the server's `invalid token` answer within 10 s, and then only if the journal has exactly ONE new `Auth failed` line since the probe began, naming this host's address. Anything else is a failed check:
     ```bash
     ( set -eu -o pipefail; umask 077; cd "${OP:?run step 0 first}"
       : "${BACKEND_PATH:?set BACKEND_PATH from <caddy-dir>/proxy.env}"
       ME=$(curl -sS -4 --max-time 10 https://checkip.amazonaws.com); [ -n "$ME" ]
       cat > probe.mjs <<'JS'
     const [url, label] = process.argv.slice(2);
     const fail = (why) => { console.error(`FAIL ${label}: ${why}`); process.exit(1); };
     const timer = setTimeout(() => fail('no answer within 10 s'), 10_000);
     const ws = new WebSocket(url, { headers: { 'CloudFront-Viewer-Address': '192.0.2.1:1', 'X-Forwarded-For': '192.0.2.2' } });
     let asked = false;
     ws.onmessage = (m) => {
       let r; try { r = JSON.parse(String(m.data)); } catch { fail('an answer that is not JSON'); }
       if (!asked && typeof r?.server_nonce === 'string') { asked = true; ws.send(JSON.stringify({ method: 'auth', params: { token: 'wrong' } })); return; }
       if (asked && r?.error?.code === -32000 && r.error.message === 'invalid token') { clearTimeout(timer); console.log(`ok ${label}: invalid token`); process.exit(0); }
       fail('an unexpected answer');
     };
     ws.onerror = () => fail('connection error');
     ws.onclose = (e) => fail(`closed before the answer (code ${e.code})`);
     JS
       for route in ws "$BACKEND_PATH" "$BACKEND_PATH/ws"; do
         label=$([ "$route" = ws ] && echo /ws || echo "/<BACKEND_PATH>${route#"$BACKEND_PATH"}")
         MARK=$(date +%s); sleep 1
         NODE_OPTIONS=--dns-result-order=ipv4first node probe.mjs "wss://<distribution-domain>/$route" "$label"
         sleep 2
         NEW=$(journalctl --user -u tmux-mobile-gateway.service --since "@$MARK" --no-pager -o cat | grep 'Auth failed from' || true)
         [ "$(printf '%s' "$NEW" | grep -c . || true)" = 1 ] || { echo "FAIL $label: not exactly one new Auth failed line: $NEW"; exit 1; }
         case "$NEW" in *"Auth failed from $ME (via 127.0.0.1:"*) echo "ok $label: keyed by $ME";; *) echo "FAIL $label: $NEW"; exit 1;; esac
       done
       echo "ok: every route keys by the viewer" )
     ```
     On any `FAIL`, undo step 4 at once (then step 3) and treat the deployment as not done. The three wrong tokens count three of your address's five attempts; a correct login clears them, or they expire in 60 s.
- *Rolling back* — the reverse order, and the trust ALWAYS first, so there is never a window where the old policy forwards a viewer's own header while the gateway believes it (the gateway cannot detect a policy change). (4) remove `trusted_proxies`, `tmm gateway restart`, and confirm `tmm gateway status` says `keyed by the TCP peer`. (3) on `<edge>`, in `<caddy-dir>`: `cat Caddyfile.bak-<stamp> > Caddyfile && docker compose restart <caddy-service>`, with the backup step 3 printed. (2) only the behaviors `changes.json` recorded, and only while each is still on the new policy; one that has changed since stops the block for a human decision:
     ```bash
     ( set -eu -o pipefail; umask 077; cd "${OP:?run step 0 first}"
       ID=$(jq -r .id changes.json) TARGETS=$(jq -r .targets changes.json) OLD=$(jq -r .old changes.json) NEW=$(jq -r .new changes.json)
       aws cloudfront get-distribution-config --id "$ID" > dist-now.json
       jq --arg targets "$TARGETS" --arg from "$NEW" --arg to "$OLD" -f flip.jq dist-now.json > dist-revert.json \
         || { echo "stop, nothing published: a recorded behavior has changed since (jq says which, above); decide by hand"; exit 1; }
       cmp -s <(jq -S 'del(.. | .OriginRequestPolicyId?)' <(jq .DistributionConfig dist-now.json)) <(jq -S 'del(.. | .OriginRequestPolicyId?)' dist-revert.json) \
         || { echo "stop, nothing published: more than OriginRequestPolicyId would change"; exit 1; }
       aws cloudfront update-distribution --id "$ID" --if-match "$(jq -r .ETag dist-now.json)" --distribution-config file://dist-revert.json > /dev/null \
         || { echo "FAIL, may be partly applied: update-distribution failed; check with the listing block of step 2 (never a bare get-distribution-config)"; exit 1; }
       aws cloudfront wait distribution-deployed --id "$ID" || { echo "FAIL, may be partly applied: the revert was accepted but is not Deployed yet; do not rerun; check: aws cloudfront get-distribution --id $ID --query Distribution.Status"; exit 1; }
       echo "ok: $TARGETS back on $OLD" )
     ```
     (1) only if the wildcard binds are wanted back: restore the `sshd_config.bak-<stamp>` step 1 made, `sshd -t`, `systemctl reload ssh`, and reconnect the forwards. Then `rm -rf "$OP"`.
- *A known limit, IPv6:* a viewer's key is its full IPv6 address (/128), so one viewer can change addresses inside its own /64 and get a fresh counter each time (validator, #441). Against a 122-bit token this does not make guessing feasible; it means the lockout does not slow an IPv6 guesser. Keying IPv6 by /64 would close it and is not built.

Default disconnect_grace_secs: 600 (10 min). Delay before a disconnected client's tmux window is auto-resized back; set to 0 for legacy immediate restore. See `docs/design-docs/features/disconnect-grace.md`.

## Where the configuration lives (board #472)

The directory is `<base>/teammux`, where `<base>` is `$XDG_CONFIG_HOME` when it is absolute, else `~/.config`, taken exactly as the environment gives it (the gateway service records it). It is chosen ONCE per process, before anything is read, created or written, by looking at the two names under `<base>`:

| `teammux` | `tmux-mobile` | result |
|---|---|---|
| absent | absent | `teammux`, created on first use (a fresh install) |
| absent | a directory | `tmux-mobile`, for good: an install made before the rename keeps its directory, and nothing is renamed, linked or copied |
| a directory | absent | `teammux` |
| a directory | a directory reaching the SAME place | `teammux` (the other name is another way in; the base is still `<base>`, wherever the links lead) |
| a directory | a directory reaching a DIFFERENT place | refused before any write, whichever side is empty |
| anything that cannot be examined, a link that dangles or loops, a link owned by another user, a name that is not a directory | | refused; "absent" means not found and nothing else |

A refusal names both paths and says nothing was changed; the commands that read no configuration (`--help`, `claude-statusline`, a local `task`) still answer. `tmm gateway status` prints the directory in use and says when it is the old name. Limits: two processes starting at once on an empty base can each create a different name (an older build knows nothing of this rule), and the next start then refuses; a fresh `teammux` install followed by an older binary on the same base is an unsupported downgrade. Design and review: board #472.
