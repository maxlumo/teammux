//! Asks (board #106; docs/design-docs/features/asks.md): the doors, the one
//! body function, and the asker's lifetime identity. The store holds the rows
//! (`store::asks`); the RPC glue and the delivery after the commit live in
//! `server::hub_rpc`.

use super::store::asks::{AskRow, ASK_ANSWERED};

/// The most options an ask may carry.
pub const MAX_OPTIONS: usize = 6;
/// A key is 1 to this many ASCII letters or digits.
pub const MAX_KEY: usize = 8;
pub const MAX_LABEL: usize = 200;
pub const MAX_QUESTION: usize = 4000;
pub const MAX_WHY: usize = 1000;

/// The file inside a managed home that names its lifetime.
pub const HOME_ID_FILE: &str = "home-id";

/// The lifetime identity of the managed home at `dir`: the uuid in its
/// `home-id` file, written once (create-new, so two readers cannot both
/// write) the first time it is asked for. A restart and a config refresh
/// keep the directory and so the id; a removed and re-created home, and a
/// fork (a fresh home, `spawn::fork`), get a new one.
pub fn home_id_at(dir: &std::path::Path) -> Result<String, String> {
    let file = dir.join(HOME_ID_FILE);
    if let Some(id) = read_home_id(&file)? {
        return Ok(id);
    }
    // Publish it COMPLETE (validator F4: a create-then-write let a racing
    // reader see the file empty): write a private temp file, then link it
    // into place, which never replaces. The winner's id is the home's; a
    // loser removes its temp file and reads the winner's. A writer killed
    // between the two steps leaves only a temp file, never a partial id, and
    // the next writer removes it.
    let id = uuid::Uuid::new_v4().to_string();
    let tmp = dir.join(format!("{HOME_ID_FILE}.{id}.tmp"));
    std::fs::write(&tmp, id.as_bytes()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    let linked = std::fs::hard_link(&tmp, &file);
    let _ = std::fs::remove_file(&tmp);
    remove_stale_temps(dir);
    match linked {
        Ok(()) => Ok(id),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read_home_id(&file)?.ok_or_else(|| format!("{}: empty", file.display())),
        Err(e) => Err(format!("{}: {e}", file.display())),
    }
}

fn read_home_id(file: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(file) {
        Ok(s) if !s.trim().is_empty() => Ok(Some(s.trim().to_string())),
        // Only a file this function did not publish can be empty: treated as
        // absent would let two writers disagree, so it is an error.
        Ok(_) => Err(format!("{}: empty", file.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", file.display())),
    }
}

/// Temp files a killed writer left behind (`home-id.<uuid>.tmp`), older than
/// a minute so a live writer's own is never taken from under it.
fn remove_stale_temps(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.starts_with(&format!("{HOME_ID_FILE}.")) && name.ends_with(".tmp")) {
            continue;
        }
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() >= 60);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// The ONE definition of "this window's managed home, as a lifetime" (beside
/// `managed::managed_home`): `Ok(None)` when the window has no managed home in
/// the session's project, `Err` when it could not be read.
pub fn home_id(session: &str, window: &str) -> Result<Option<String>, String> {
    let Some(project) = super::project_for_session(session)? else { return Ok(None) };
    match super::managed::managed_state(&project.path, window) {
        super::managed::ManagedState::Managed => {}
        super::managed::ManagedState::Plain => return Ok(None),
        super::managed::ManagedState::Unknown(e) => return Err(e),
    }
    let Some(dir) = super::agents::home_dir(&project.path, window) else { return Ok(None) };
    home_id_at(&dir).map(Some)
}

/// An ask as the door accepted it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AskInput {
    pub question: String,
    pub options: Vec<(String, String)>,
    pub recommend: Option<String>,
    pub issue: Option<i64>,
}

/// Validate an ask once, at the door. `issue_exists` answers for this
/// session's board. Every refusal names what is wrong.
pub fn validate(
    question: &str,
    options: &[(String, String)],
    recommend: Option<&str>,
    issue: Option<i64>,
    issue_exists: &dyn Fn(i64) -> Result<bool, String>,
) -> Result<AskInput, String> {
    let question = question.trim();
    if question.is_empty() {
        return Err("an ask needs a question".into());
    }
    if question.chars().count() > MAX_QUESTION {
        return Err(format!("the question is longer than {MAX_QUESTION} characters"));
    }
    if options.len() > MAX_OPTIONS {
        return Err(format!("an ask has at most {MAX_OPTIONS} options, not {}", options.len()));
    }
    let mut seen: Vec<String> = Vec::new();
    let mut clean = Vec::new();
    for (key, label) in options {
        let key = key.trim();
        if key.is_empty() || key.chars().count() > MAX_KEY || !key.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(format!("option key '{key}' must be 1-{MAX_KEY} letters or digits"));
        }
        if seen.iter().any(|k| k.eq_ignore_ascii_case(key)) {
            return Err(format!("option key '{key}' is given twice"));
        }
        let label = label.trim();
        if label.is_empty() || label.chars().count() > MAX_LABEL {
            return Err(format!("option '{key}' needs a label of 1-{MAX_LABEL} characters"));
        }
        seen.push(key.to_string());
        clean.push((key.to_string(), label.to_string()));
    }
    let recommend = match recommend.map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => Some(seen.iter().find(|k| k.eq_ignore_ascii_case(r)).cloned().ok_or_else(|| format!("the recommendation '{r}' is not one of the options"))?),
        None => None,
    };
    if let Some(n) = issue {
        if !issue_exists(n)? {
            return Err(format!("there is no issue #{n} on this project's board"));
        }
    }
    Ok(AskInput { question: question.to_string(), options: clean, recommend, issue })
}

/// The body an older client and `tmm log` print: composed from the
/// structure by this ONE function. It begins with `@human`, so today's bell
/// reads it as addressed to the person.
pub fn compose_ask_body(a: &AskInput) -> String {
    let mut body = format!("@human [ask] {}", a.question);
    for (key, label) in &a.options {
        let star = if a.recommend.as_deref() == Some(key.as_str()) { " (recommended)" } else { "" };
        body.push_str(&format!("\n{key} · {label}{star}"));
    }
    if let Some(n) = a.issue {
        body.push_str(&format!("\n(#{n})"));
    }
    body
}

/// What the person's answer says: the option (`KEY · label`) and/or the text.
pub fn answer_text(ask: &AskRow, key: Option<&str>, text: &str) -> Result<(Option<String>, String), String> {
    let text = text.trim();
    let chosen = match key.map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => Some(ask.options.iter().find(|(o, _)| o.eq_ignore_ascii_case(k)).cloned().ok_or_else(|| format!("'{k}' is not an option of ask {}", ask.seq))?),
        None => None,
    };
    let said = match (&chosen, text.is_empty()) {
        (None, true) => return Err("an answer needs an option or some text".into()),
        (Some((k, l)), true) => format!("{k} · {l}"),
        (Some((k, l)), false) => format!("{k} · {l} — {text}"),
        (None, false) => text.to_string(),
    };
    Ok((chosen.map(|(k, _)| k), said))
}

/// The state a closed ask is refused with, for the caller's message.
pub fn closed_words(ask: &AskRow) -> String {
    let when = ask.closed_at.and_then(chrono::DateTime::from_timestamp_millis).map(|t| t.with_timezone(&chrono::Local).format("%H:%M").to_string()).unwrap_or_default();
    match ask.state.as_str() {
        ASK_ANSWERED => format!("already answered at {when}"),
        s => format!("already {s} at {when}"),
    }
}

/// The JSON shape of an ask on the wire (`hub_ask_*`, `tmm ask list`).
pub fn ask_json(a: &AskRow, closing_body: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "seq": a.seq,
        "room": a.room,
        "ts": a.ts,
        "asker": a.asker,
        "question": a.question,
        "options": a.options.iter().map(|(k, l)| serde_json::json!({ "key": k, "label": l })).collect::<Vec<_>>(),
        "recommend": a.recommend,
        "issue": a.issue,
        "state": a.state,
        "closed_seq": a.closed_seq,
        "closed_at": a.closed_at,
        "answer_key": a.answer_key,
        "said": a.said,
        "closing": closing_body,
        "delivery": a.delivery,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, l)| (k.to_string(), l.to_string())).collect()
    }

    fn no_issue(_: i64) -> Result<bool, String> {
        Ok(false)
    }

    /// R2-R6: every malformed ask is refused with its reason.
    #[test]
    fn the_door_refuses_every_malformed_ask() {
        let seven: Vec<(String, String)> = (0..7).map(|i| (format!("K{i}"), "x".to_string())).collect();
        let cases: Vec<(&str, Vec<(String, String)>, Option<&str>, Option<i64>, &str)> = vec![
            ("  ", vec![], None, None, "needs a question"),
            ("q", seven, None, None, "at most 6 options"),
            ("q", o(&[("A", "x"), ("a", "y")]), None, None, "given twice"),
            ("q", o(&[("TOOLONGKEY", "x")]), None, None, "1-8 letters or digits"),
            ("q", o(&[("A-1", "x")]), None, None, "1-8 letters or digits"),
            ("q", o(&[("A", " ")]), None, None, "needs a label"),
            ("q", o(&[("A", "x")]), Some("B"), None, "not one of the options"),
            ("q", vec![], None, Some(999), "no issue #999"),
        ];
        for (q, opts, rec, issue, want) in cases {
            let err = validate(q, &opts, rec, issue, &no_issue).unwrap_err();
            assert!(err.contains(want), "{q:?} {opts:?}: {err}");
        }
        let long = "x".repeat(MAX_QUESTION + 1);
        assert!(validate(&long, &[], None, None, &no_issue).unwrap_err().contains("longer than"));
    }

    #[test]
    fn a_valid_ask_is_trimmed_and_its_recommendation_takes_the_key_s_spelling() {
        let a = validate("  which?  ", &o(&[(" A ", " own row "), ("B", "disk")]), Some("a"), Some(103), &|n| Ok(n == 103)).unwrap();
        assert_eq!(a, AskInput { question: "which?".into(), options: o(&[("A", "own row"), ("B", "disk")]), recommend: Some("A".into()), issue: Some(103) });
        assert!(validate("free text only", &[], None, None, &no_issue).is_ok(), "options are optional");
    }

    /// C1: the body old clients print, pinned by literal.
    #[test]
    fn the_composed_body_is_pinned() {
        let a = AskInput { question: "Desktop Aggregate: name on its own row?".into(), options: o(&[("A", "own row, 48 px"), ("B", "DISK to the card")]), recommend: Some("A".into()), issue: Some(103) };
        assert_eq!(compose_ask_body(&a), "@human [ask] Desktop Aggregate: name on its own row?\nA · own row, 48 px (recommended)\nB · DISK to the card\n(#103)");
        let bare = AskInput { question: "ok?".into(), options: vec![], recommend: None, issue: None };
        assert_eq!(compose_ask_body(&bare), "@human [ask] ok?");
    }

    fn row(opts: &[(&str, &str)]) -> AskRow {
        AskRow { seq: 7, room: "proj:a".into(), ts: 0, asker: "leader".into(), asker_home: "h".into(), question: "q".into(), options: o(opts), recommend: None, issue: None, state: "open".into(), closed_seq: None, closed_at: None, answer_key: None, delivery: None, said: None }
    }

    /// R7/R8 and the answer's words.
    #[test]
    fn an_answer_names_its_option_or_its_text_and_never_an_unknown_key() {
        let r = row(&[("A", "own row"), ("B", "disk")]);
        assert_eq!(answer_text(&r, Some("a"), "").unwrap(), (Some("A".into()), "A · own row".into()));
        assert_eq!(answer_text(&r, Some("B"), " and keep 24px ").unwrap(), (Some("B".into()), "B · disk — and keep 24px".into()));
        assert_eq!(answer_text(&r, None, "neither").unwrap(), (None, "neither".into()));
        assert!(answer_text(&r, None, "  ").unwrap_err().contains("an option or some text"));
        assert!(answer_text(&r, Some("C"), "").unwrap_err().contains("not an option"));
    }

    /// W2 + G1 + validator F4: first readers released together by a barrier,
    /// over many rounds, each get the one id, and never an empty or partial
    /// file; a same-name replacement has another.
    #[test]
    fn a_home_s_id_is_published_whole_once_and_a_new_home_has_another() {
        let ws = crate::config::test_scratch("tmm-home-id");
        for round in 0..200 {
            let dir = ws.join(format!(".tmm/agents/dev{round}"));
            std::fs::create_dir_all(&dir).unwrap();
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
            let handles: Vec<_> = (0..8).map(|_| { let (d, b) = (dir.clone(), barrier.clone()); std::thread::spawn(move || { b.wait(); home_id_at(&d) }) }).collect();
            let ids: Vec<Result<String, String>> = handles.into_iter().map(|h| h.join().unwrap()).collect();
            let first = ids[0].clone().unwrap_or_else(|e| panic!("round {round}: {e}"));
            assert!(ids.iter().all(|i| i.as_ref() == Ok(&first)), "round {round}: one id for all: {ids:?}");
            assert_eq!(std::fs::read_to_string(dir.join(HOME_ID_FILE)).unwrap(), first);
            let temps = std::fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp")).count();
            assert_eq!(temps, 0, "round {round}: no temp file left");
        }
        let dir = ws.join(".tmm/agents/dev0");
        let id = home_id_at(&dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        assert_ne!(home_id_at(&dir).unwrap(), id, "a same-name replacement is somebody else");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// A writer killed between the temp file and the link leaves only the temp
    /// file: it is not an id, the next reader publishes one, and an old temp
    /// is removed (a fresh one, a live writer's, is left alone).
    #[test]
    fn a_leftover_temp_file_is_ignored_and_an_old_one_cleaned_up() {
        let ws = crate::config::test_scratch("tmm-home-id-tmp");
        let dir = ws.join(".tmm/agents/dev");
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join(format!("{HOME_ID_FILE}.dead-writer.tmp"));
        std::fs::write(&old, "11111111-dead").unwrap();
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(past).unwrap();
        let live = dir.join(format!("{HOME_ID_FILE}.live-writer.tmp"));
        std::fs::write(&live, "22222222-live").unwrap();
        let id = home_id_at(&dir).unwrap();
        assert!(id != "11111111-dead" && id != "22222222-live", "a temp file is never the id: {id}");
        assert!(!old.exists(), "the dead writer's temp is removed");
        assert!(live.exists(), "a fresh temp is left to its writer");
        assert_eq!(home_id_at(&dir).unwrap(), id);
        // An EMPTY id file (not ours) is an error, never silently replaced.
        std::fs::write(dir.join(HOME_ID_FILE), "").unwrap();
        assert!(home_id_at(&dir).unwrap_err().contains("empty"));
        let _ = std::fs::remove_dir_all(&ws);
    }
}

// ─── The store, through the one connection ─────────────────────────────────

/// Record a new ask (its message and its row, one transaction) and push the
/// message to the clients after the commit.
pub fn open(room: &str, asker: &str, asker_home: &str, input: &AskInput) -> Result<AskRow, String> {
    let body = compose_ask_body(input);
    let id = uuid::Uuid::new_v4().to_string();
    let ts = super::rooms::now_ms();
    let (msg, row) = super::with_store(|s| {
        s.ask_open(
            &super::store::asks::NewAsk { room, id: &id, asker, asker_home, question: &input.question, options: &input.options, recommend: input.recommend.as_deref(), issue: input.issue, body: &body },
            ts,
        )
    })?;
    super::rooms::push_stored(&[msg]);
    Ok(row)
}

pub fn get(seq: i64) -> Result<Option<AskRow>, String> {
    super::with_store(|s| s.ask_get(seq))
}

pub fn list(room: &str, all: bool) -> Result<Vec<AskRow>, String> {
    super::with_store(|s| s.ask_list(room, all))
}

/// Close it (see `Store::ask_close`); an applied close's message is pushed
/// here, after the commit. Delivery is the caller's, after this returns.
pub fn close(c: &super::store::asks::AskClose<'_>) -> Result<super::store::asks::AskClosed, String> {
    let ts = super::rooms::now_ms();
    let out = super::with_store(|s| s.ask_close(c, ts))?;
    if let Some(m) = &out.message {
        super::rooms::push_stored(std::slice::from_ref(m));
    }
    Ok(out)
}

/// Every room's open-ask count, one grouped read (board #108).
pub fn open_counts() -> Result<Vec<(String, i64)>, String> {
    super::with_store(|s| s.ask_open_counts())
}

pub fn set_delivery(seq: i64, delivery: &str) -> Result<(), String> {
    super::with_store(|s| s.ask_set_delivery(seq, delivery))
}

/// The body of a room message by its seq, for an ask's closing line.
pub fn body_of(room: &str, seq: i64) -> Option<String> {
    super::rooms::message_by_ref(room, &seq.to_string()).and_then(|m| m["body"].as_str().map(str::to_string))
}

/// `tmm ask`'s own logic (leader note 20: out of `bin/tmm.rs`, which keeps
/// only the verb dispatch): the params each verb sends, and the lines it
/// prints. No I/O here.
pub mod cli {
    use serde_json::{json, Value};

    /// `tmm ask "q" [--option KEY=label]… [--recommend KEY] [--issue N]`.
    /// `Err` is a usage error: nothing is sent.
    pub fn ask_params(session: &str, from: &str, rest: &[String], options: &[&str], recommend: Option<&str>, issue: Option<&str>) -> Result<Value, String> {
        let question = rest.join(" ");
        if question.trim().is_empty() {
            return Err("ask \"question\" [--option KEY=label]… [--recommend KEY] [--issue N]".into());
        }
        let options = options
            .iter()
            .map(|v| v.split_once('=').map(|(k, l)| json!({ "key": k.trim(), "label": l.trim() })).ok_or_else(|| format!("--option {v}: write it KEY=label")))
            .collect::<Result<Vec<_>, _>>()?;
        let issue = match issue {
            Some(n) => Some(n.trim_start_matches('#').parse::<i64>().map_err(|_| format!("--issue {n}: a board number"))?),
            None => None,
        };
        Ok(json!({ "session": session, "from": from, "question": question, "options": options, "recommend": recommend, "issue": issue }))
    }

    /// `tmm ask close <id> "why" [--re <seq>]`: the id and the params.
    pub fn close_params(session: &str, from: &str, rest: &[String], re: Option<&str>) -> Result<(i64, Value), String> {
        let seq = rest.get(1).and_then(|s| s.trim_start_matches('#').parse::<i64>().ok()).ok_or("ask close <id> \"why\" [--re <seq>]  (the id from tmm ask list)")?;
        let why = rest.get(2..).map(|w| w.join(" ")).unwrap_or_default();
        if why.trim().is_empty() {
            return Err("ask close <id> \"why\": say why you withdraw it".into());
        }
        let re = re.filter(|r| !r.trim().is_empty());
        Ok((seq, json!({ "session": session, "seq": seq, "from": from, "why": why, "re": re })))
    }

    /// One ask as `tmm ask list` prints it: id, state, asker, the question's
    /// first line, its options, and for a closed one the closing act in its
    /// own words, whole (validator F3: an excerpt of the closing body spent
    /// itself on the quote of a long question and hid the answer). An older
    /// server without `said` still gets the closing body.
    /// The asker is shown by its current label (`names`, from the answer's
    /// `labels`), as `tmm board list` shows an assignee.
    pub fn ask_line(a: &Value, names: &crate::address::Names) -> String {
        let q: String = a["question"].as_str().unwrap_or("").lines().next().unwrap_or("").chars().take(70).collect();
        let mut line = format!("#{:<5} {:<9} {}: {q}", a["seq"].as_i64().unwrap_or(0), a["state"].as_str().unwrap_or(""), names.shown(a["asker"].as_str().unwrap_or("")));
        let opts: Vec<String> = a["options"].as_array().into_iter().flatten().map(|o| {
            let k = o["key"].as_str().unwrap_or("");
            let star = if a["recommend"].as_str() == Some(k) { "*" } else { "" };
            format!("{k}{star}={}", o["label"].as_str().unwrap_or(""))
        }).collect();
        if !opts.is_empty() {
            line.push_str(&format!("  [{}]", opts.join(" | ")));
        }
        if let Some(c) = a["said"].as_str().or_else(|| a["closing"].as_str()) {
            line.push_str(&format!("\n        -> {c}"));
            if let Some(d) = a["delivery"].as_str() {
                line.push_str(&format!("  (delivery: {d})"));
            }
        }
        line
    }

    /// A close's answer: `Ok` when it applied, else the refusal to print, with
    /// the state the winner left.
    pub fn outcome(r: &Value) -> Result<(), String> {
        if r["applied"].as_bool() == Some(true) {
            return Ok(());
        }
        let why = r["refused"].as_str().unwrap_or("not applied");
        let names = crate::address::Names::from_json(r.get("labels").unwrap_or(&Value::Null));
        Err(format!("ask #{}: {why}; nothing was written\n{}", r["ask"]["seq"], ask_line(&r["ask"], &names)))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn s(v: &[&str]) -> Vec<String> {
            v.iter().map(|x| x.to_string()).collect()
        }

        #[test]
        fn the_params_each_verb_sends_and_its_usage_refusals() {
            let p = ask_params("p", "dev", &s(&["which", "one?"]), &["A=own row", " B = disk "], Some("A"), Some("#103")).unwrap();
            assert_eq!(p, json!({ "session": "p", "from": "dev", "question": "which one?", "options": [{ "key": "A", "label": "own row" }, { "key": "B", "label": "disk" }], "recommend": "A", "issue": 103 }));
            assert!(ask_params("p", "dev", &[], &[], None, None).is_err());
            assert!(ask_params("p", "dev", &s(&["q"]), &["no-equals"], None, None).unwrap_err().contains("KEY=label"));
            assert!(ask_params("p", "dev", &s(&["q"]), &[], None, Some("x")).unwrap_err().contains("a board number"));
            let (seq, c) = close_params("p", "dev", &s(&["close", "#41", "answered", "in", "chat"]), Some("5120")).unwrap();
            assert_eq!((seq, c["why"].as_str(), c["re"].as_str()), (41, Some("answered in chat"), Some("5120")));
            assert!(close_params("p", "dev", &s(&["close", "41"]), None).unwrap_err().contains("say why"));
            assert!(close_params("p", "dev", &s(&["close", "x", "why"]), None).is_err());
        }
    }
}
