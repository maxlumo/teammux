//! What an agent's name is, and how a chat body addresses one (board #248).
//! A LEAF module, no gated dependency, so the phone's server and the `tmm`
//! binary read addresses by the same rule as the desktop.
//!
//! `name_char` is the ONE definition of a name character: `projects::agents::
//! valid_name` builds names from it and `mention_names` reads addresses with
//! it, so a name can never hold a character the parser would cut, and the
//! parser can never read past a name (orchestrator, #248).

/// A character an agent name may contain: a letter or digit of any script
/// (a Chinese agent name is an ordinary name), `-` or `_`. No `.`: a name is
/// also a tmux target and an `@address`, where a dot is a separator/host.
pub fn name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '-' | '_')
}

/// The `@` addresses in a chat body — the ONE server reading of who a message
/// names (board #248). `deliver_mentions`, the room's stored `to`, and the
/// `tmm send` "has a recipient" check all use it; the client's
/// `mentionTokens` (hub.ts) mirrors it case for case.
///
/// Two edges, both from `name_char` — the same set `valid_name` admits:
///
/// * The `@` must START a word: at the start of the body, or after anything
///   that is not an email/host character (ASCII letter or digit, `_`, `.`,
///   `-`). So `me@bob.dev`, `a@bob` and `pkg@2.4.0` name nobody, while
///   `(@bob)`, `"@bob"`, `/@bob` and a CJK character right before it
///   (`请@bob`, which the owner writes) still address bob.
/// * The address is the run of name characters after it, so trailing
///   punctuation of any kind ends it: `(@bob)`, `@bob，`, `@bob。` and
///   `**@bob**` name bob. A run followed by `.` plus a name character, or by
///   another `@`, is a host or an address, not a name (`@bob.dev`, `@a@b`).
///
/// Before #248 every `@` split and the address ran to the next whitespace, so
/// `mail a@bob` typed into bob's pane while `(@bob)` and `@bob，` reached
/// nobody.
pub fn mention_names(body: &str) -> Vec<String> {
    let in_word = |c: char| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-');
    let mut out = Vec::new();
    for (i, _) in body.match_indices('@') {
        if body[..i].chars().next_back().is_some_and(in_word) {
            continue;
        }
        let rest = &body[i + 1..];
        let end = rest.find(|c: char| !name_char(c)).unwrap_or(rest.len());
        let mut after = rest[end..].chars();
        let host = match after.next() {
            Some('@') => true,
            Some('.') => after.next().is_some_and(name_char),
            _ => false,
        };
        if end > 0 && !host {
            out.push(rest[..end].to_string());
        }
    }
    out
}

/// A body that is a SLASH COMMAND for an agent's CLI (board #274): optionally
/// one leading `@name` (ASCII word characters, `.`, `-`) or `@all`, then a
/// first token `/word` — a letter, then letters, digits, `_` or `-` — ending
/// at whitespace or the end. `(to, command)`; `to` is empty when there is no
/// address. `None` for prose, a path (`/usr/bin`) or two addresses.
///
/// This is the composer's `slashCommand` (hub.ts), mirrored case for case:
/// `hub.test.ts` reads `a_slash_command_is_read_like_the_composer` out of
/// this file and runs the client over the same rows, so `tmm send` and the
/// composer cannot disagree about what `@bob /compact` is.
pub fn slash_command(text: &str) -> Option<(String, String)> {
    let body = text.trim();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let (to, rest) = match body.strip_prefix('@') {
        Some(after) if after.starts_with(word) => {
            let end = after.find(|c: char| !(word(c) || c == '.' || c == '-')).unwrap_or(after.len());
            let tail = &after[end..];
            if !tail.starts_with(char::is_whitespace) {
                return None;
            }
            (&after[..end], tail.trim())
        }
        _ => ("", body),
    };
    let cmd = rest.strip_prefix('/')?;
    if !cmd.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return None;
    }
    let end = cmd.find(|c: char| !(word(c) || c == '-')).unwrap_or(cmd.len());
    if !cmd[end..].is_empty() && !cmd[end..].starts_with(char::is_whitespace) {
        return None;
    }
    Some((to.to_string(), rest.to_string()))
}

/// A line as its producer typed it (board #279): `text` is what goes into
/// the pane, the one text its echo is matched against; `ask_at` is the byte
/// where the stamped line starts inside it — 0 when nothing leads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Typed {
    pub text: String,
    pub ask_at: usize,
}

/// Between a Team context block and the line it accompanies.
const CONTEXT_GAP: &str = "\n\n";

/// What a Team agent is TYPED (board #279, owner 2026-09-29 10:49: "把这个放在
/// 前面，然后把真正给 Agent 发送的最后的消息放到它的后面"): the room context
/// first, the stamped line it accompanies LAST, so the last thing the model
/// reads is what it must answer. The producer knows where the line starts,
/// so it says so (`ask_at`) — nothing later finds it by reading the text.
pub fn context_first(line: &str, context: Option<&str>) -> Typed {
    match context {
        Some(context) => Typed { text: format!("{context}{CONTEXT_GAP}{line}"), ask_at: context.len() + CONTEXT_GAP.len() },
        None => Typed { text: line.to_string(), ask_at: 0 },
    }
}

/// How a typed line is SHOWN (board #279): the ask first, then the context
/// that led it — the two parts `context_first` recorded, split at its own
/// `ask_at`, never parsed back out of the text (orchestrator 13:24). A stored
/// prompt is cut at 1024 chars while a context block runs to 12 KiB, so the
/// typed order would show only the context. An offset that does not split
/// `text` into those two parts (a stale row, a char boundary it misses) shows
/// the text as typed. Pure; the same bytes, reordered.
pub fn shown(text: &str, ask_at: usize) -> String {
    if ask_at == 0 {
        return text.to_string();
    }
    match (text.get(..ask_at).and_then(|c| c.strip_suffix(CONTEXT_GAP)), text.get(ask_at..)) {
        (Some(context), Some(ask)) if !context.is_empty() && !ask.is_empty() => format!("{ask}{CONTEXT_GAP}{context}"),
        _ => text.to_string(),
    }
}

/// Senders of the REQUESTS in a submitted prompt — the ONE reading of whom a
/// turn's final reply is addressed to (#256, #257). Every stamped line
/// `[tmm chat …] sender: body` counts once, in order; automatic `[reply]`
/// and legacy `[done]` deliveries are results, not requests. The reply edge
/// parses a live prompt with it, and the activity log stores its answer
/// beside the (display-truncated) prompt text, so recovery after a restart
/// reads the same senders even when a combined prompt of held lines runs
/// past the log's text limit.
///
/// The human is a requester too (board #289, owner 2026-09-30: filter the
/// room to what is addressed to me): a stamped `human:` line (the composer,
/// a human `tmm send`), and a prompt with no stamp at all, which only a
/// person typing into the pane produces — except a `/command` (the app types
/// those for any sender, #274) and the legacy spawn kick. The reply is
/// RECORDED to the human (`to`); it is never typed anywhere (`RoomPoster`).
pub fn requesters(prompt: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut stamped = false;
    for line in prompt.lines() {
        let Some(after_stamp) = line
            .strip_prefix("[tmm chat] ")
            .or_else(|| line.strip_prefix("[tmm chat ").and_then(|s| s.split_once("] ").map(|(_, rest)| rest)))
        else {
            continue;
        };
        stamped = true;
        let Some((sender, body)) = after_stamp.split_once(": ") else { continue };
        let sender = sender.trim();
        let body = body.trim_start();
        if sender.is_empty()
            || body.starts_with("[reply]")
            || body.starts_with("[done]")
            || targets.iter().any(|s| s == sender)
        {
            continue;
        }
        targets.push(sender.to_string());
    }
    if !stamped && typed_in_the_pane(prompt) {
        targets.push(HUMAN.to_string());
    }
    targets
}

/// A reply's quote token (board #290, owner 2026-09-30: 引用一条消息去回复，
/// 发给 Agent 时带上引用的内容). The quote rides IN the delivered line, so the
/// agent needs no lookup and the record is self-contained (reference by
/// content, not by index): `[re <sender> <HH:MM>: 「<excerpt>」] `. The
/// excerpt is the quoted body's first non-empty line, whitespace squashed,
/// cut to `QUOTE_CHARS` characters with `…`. Two characters are replaced
/// inside it, and only there: `@` → `＠`, because every mention parser (this
/// file's `mention_names`, the client's `mentionTokens`) reads ASCII `@`
/// only, so quoting "@lead please" never delivers to lead; `」` → `”`, so
/// the first `」]` always ends the token (`parseQuote`, hub.ts). The ONE
/// formatter: `hub_post`'s `re` builds it from the server's own row for the
/// composer and `tmm send --re` alike.
pub fn quote_token(sender: &str, hhmm: &str, body: &str) -> String {
    let first = body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let squashed: String = first.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut excerpt: String = squashed.chars().take(QUOTE_CHARS).collect();
    if squashed.chars().count() > QUOTE_CHARS {
        excerpt = format!("{}…", excerpt.trim_end());
    }
    let excerpt = unaddressed(&excerpt).replace('」', "”");
    format!("[re {sender} {hhmm}: 「{excerpt}」] ")
}

/// Text we QUOTE inside a line we are about to post carries no routing:
/// `@` → `＠`. Every mention parser reads ASCII `@` only (`mention_names`
/// here, `mentionTokens` on the client), so a quoted "@lead please" is read
/// by a human and delivered to nobody.
///
/// The ONE rule, in one place (board #290 for a reply's quote; board #367
/// review P1-A for a board hand-off, where an issue TITLE rides in the
/// delivered line: "修复 @all 的投递" would otherwise have typed a hand-off
/// meant for one agent into every pane in the project — quoted words must
/// never be an address).
pub fn unaddressed(text: &str) -> String {
    text.replace('@', "＠")
}

/// How much of the quoted line a reply carries.
pub const QUOTE_CHARS: usize = 120;

/// The human's identity in a room: no pane, never typed into.
pub const HUMAN: &str = "human";

/// An unstamped prompt a person typed into the pane: not empty, not a
/// `/command`, not a legacy spawn kick (`[YYYY-MM-DD HH:MM] (session start)`
/// or `[…] Start now: …`, the client's `isSessionStart`).
fn typed_in_the_pane(prompt: &str) -> bool {
    let t = prompt.trim();
    let kick = t.starts_with('[') && (t.ends_with("(session start)") || t.split_once("] ").is_some_and(|(_, r)| r.starts_with("Start now:")));
    !t.is_empty() && !t.starts_with('/') && !kick
}

/// The reply edge's targets that have a pane to type into (board #289): the
/// human is recorded as a recipient, never typed to.
pub fn pane_targets(reply_to: &[String]) -> impl Iterator<Item = &String> {
    reply_to.iter().filter(|t| *t != HUMAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Board #248: the ONE case table for both sides — `hub.test.ts` reads
    /// these rows out of this file and runs the client's `mentionTokens` over
    /// them, so keep each row on one line, `("<body>", vec![…]),`.
    #[test]
    fn an_address_must_start_a_word() {
        for (body, tokens) in [
            ("@bob look", vec!["bob"]),
            ("look @bob", vec!["bob"]),
            ("@bob: now, @alice.", vec!["bob", "alice"]),
            ("(@bob) and \"@alice\" and **@carol**", vec!["bob", "alice", "carol"]),
            ("mail me at a@bob.dev", vec![]),
            ("a@bob", vec![]),
            ("x.y@bob and first-last@bob", vec![]),
            ("npm i pkg@2.4.0", vec![]),
            ("see @bob.dev", vec![]),
            ("请@bob 看看，@alice，不急。@builder-2。", vec!["bob", "alice", "builder-2"]),
            ("@kiro/@claude", vec!["kiro", "claude"]),
            ("@a@b", vec![]),
            ("@ alone, @, @!", vec![]),
            ("line one\n@bob line two", vec!["bob"]),
            ("@all standup", vec!["all"]),
            // Unicode parity with the client (validator, #248): a non-BMP
            // letter after `.` is a host; a combining vowel sign is Alphabetic.
            ("@bob.𐐀", vec![]),
            ("see @bob.𐐀 and @राम, ok", vec!["राम"]),
            ("@𐐀𐐁 hi", vec!["𐐀𐐁"]),
            // U+0345 (combining ypogegrammeni) is Alphabetic but neither a
            // Letter nor a Number: a name character here and on the client.
            ("@bob.ͅ x", vec![]),
            ("@bobͅ hi", vec!["bobͅ"]),
        ] {
            assert_eq!(mention_names(body), tokens, "{body:?}");
        }
    }

    /// Board #290: the ONE quote case table. `hub.test.ts` reads these rows
    /// out of this file and runs `parseQuote` and `mentionTokens` over them,
    /// so both sides agree: keep each row on one line,
    /// `("<sender>", "<body>", "<token>"),`.
    #[test]
    fn a_quote_token_carries_the_first_line_and_addresses_nobody() {
        let cases: &[(&str, &str, &str)] = &[
            ("lead", "@lead please review #289\nsecond line", "[re lead 10:41: 「＠lead please review #289」] "),
            ("human", "\n\n  spaced   out  \n", "[re human 10:41: 「spaced out」] "),
            ("dev", "a 」] trick @all", "[re dev 10:41: 「a ”] trick ＠all」] "),
            ("dev", "", "[re dev 10:41: 「」] "),
            ("dev", "@builder-2 see mail a@b.dev", "[re dev 10:41: 「＠builder-2 see mail a＠b.dev」] "),
        ];
        let long = "字".repeat(130);
        assert_eq!(quote_token("dev", "10:41", &long), format!("[re dev 10:41: 「{}…」] ", "字".repeat(120)), "cut at QUOTE_CHARS with …");
        for (sender, body, want) in cases {
            let got = quote_token(sender, "10:41", body);
            assert_eq!(&got, want, "{body:?}");
            assert!(mention_names(&got).is_empty(), "a quote addresses nobody: {got}");
            assert_eq!(got.matches("」]").count(), 1, "one end: {got}");
        }
        // A reply's own addresses still work around the quote.
        let reply = format!("@builder {}which P1?", quote_token("lead", "10:41", "@lead ok"));
        assert_eq!(mention_names(&reply), vec!["builder".to_string()]);
    }

    /// Board #274: the ONE case table for `slash_command` and the composer's
    /// `slashCommand` — `hub.test.ts` reads these rows out of this file, so
    /// keep each on one line, `("<body>", "<to>", "<command>"),`; an empty
    /// command means "not a command".
    #[test]
    fn a_slash_command_is_read_like_the_composer() {
        for (body, to, command) in [
            ("@kiro /compact", "kiro", "/compact"),
            ("/compact", "", "/compact"),
            ("  @kiro   /compact  ", "kiro", "/compact"),
            ("@kiro /model claude-opus-5.5", "kiro", "/model claude-opus-5.5"),
            ("@all /compact", "all", "/compact"),
            ("@kiro-2 /clear", "kiro-2", "/clear"),
            ("@kiro /goal ship it\nthen stop", "kiro", "/goal ship it\nthen stop"),
            ("@kiro hi /compact", "", ""),
            ("@a @b /compact", "", ""),
            ("@kiro", "", ""),
            ("@kiro/compact", "", ""),
            ("/usr/bin/ls", "", ""),
            ("@kiro /usr/bin", "", ""),
            ("/7up", "", ""),
            ("/", "", ""),
            ("hello /compact", "", ""),
            ("@请 /compact", "", ""),
        ] {
            let want = (!command.is_empty()).then(|| (to.to_string(), command.to_string()));
            assert_eq!(slash_command(body), want, "{body:?}");
        }
    }

    /// Board #289: the human is a requester — a stamped `human:` line or an
    /// unstamped prompt (a person typing in the pane) — but never a pane
    /// target. A `/command`, a spawn kick, `[reply]` and `[done]` ask nothing.
    #[test]
    fn the_human_is_a_requester_but_never_a_pane_target() {
        let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(requesters("[tmm chat 2026-09-30 10:53] human: @dev ship it"), v(&["human"]));
        assert_eq!(requesters("fix the flaky test please"), v(&["human"]), "typed straight into the pane");
        assert_eq!(requesters("[tmm chat 2026-09-30 10:53] human: @dev a\n\n[tmm chat 2026-09-30 10:54] lead: @dev b"), v(&["human", "lead"]));
        assert_eq!(requesters("[tmm chat 2026-09-30 10:54] lead: @dev b"), v(&["lead"]));
        for none in ["/compact", "  ", "[2026-08-17 16:31] (session start)", "[2026-08-17 16:31] Start now: read the brief", "[tmm chat 2026-09-30 10:55] lead: [reply] done", "[tmm chat 2026-09-30 10:55] w: [done] old"] {
            assert!(requesters(none).is_empty(), "{none:?}");
        }
        let edge = v(&["human", "lead"]);
        assert_eq!(pane_targets(&edge).collect::<Vec<_>>(), vec!["lead"], "recorded to the human, typed only to lead");
    }

    /// Board #279 (orchestrator 13:24): the producer's parts in, the typed
    /// text and its display out. Typed: context first, the line last; shown:
    /// the line first, then its context — the same bytes, split where the
    /// producer said, whatever either part contains.
    #[test]
    fn a_team_line_is_typed_context_first_and_shown_ask_first() {
        let context = "[tmm team context — x]\n[09-29 10:41] lead -> writer: row\n[/tmm team context]";
        // An ask that quotes a whole block, blank lines, multibyte text.
        let line = format!("[tmm chat 2026-09-29 10:42] lead: @writer ask 中文\n\n{context}\n\nthird");
        let typed = context_first(&line, Some(context));
        assert_eq!(typed.text, format!("{context}\n\n{line}"));
        assert_eq!(&typed.text[typed.ask_at..], line, "ask_at is where the line starts");
        assert_eq!(shown(&typed.text, typed.ask_at), format!("{line}\n\n{context}"));
        assert_eq!(requesters(&typed.text), vec!["lead".to_string()]);
        // No context: typed and shown as is.
        let solo = context_first(&line, None);
        assert_eq!((solo.text.as_str(), solo.ask_at), (line.as_str(), 0));
        assert_eq!(shown(&solo.text, 0), line);
        // An offset that does not split the text into those two parts shows
        // the text as typed: past the end, inside a char, no gap before it.
        let at_han = line.find('中').unwrap() + 1;
        for bad in [typed.text.len() + 5, at_han, typed.ask_at - 1, typed.text.len()] {
            assert_eq!(shown(&typed.text, bad), typed.text, "ask_at {bad}");
        }
        assert_eq!(shown(&line, at_han), line, "inside a multibyte char: no panic, as typed");
    }
}
