pub mod agent_notifications;
pub mod build_info;
pub mod config;
pub mod downloads;
pub mod fs;
pub mod pptx;
pub mod server;
pub mod backends;
pub mod shell;
pub mod address;
pub mod mcp_cli;
pub mod tasks;
pub mod tmux;

// Declarative projects (state.db). Desktop-only for the same reason as team:
// the phone is a client of a desktop server, so it never needs SQLite. The gate
// matches the rusqlite dependency gate in Cargo.toml exactly.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod projects;

/// The gateway (board #323): the one start path, the local probe and the
/// per-user service. Desktop-gated like `projects`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod gateway;

/// Server system vitals (board #56). Desktop-gated like `projects`: only the
/// desktop server answers `system_status` — a phone is a client of one, so
/// compiling a sampler into the mobile shell would be dead weight.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod system_status;

#[cfg(all(desktop, feature = "gui"))]
use config::Config;

// Everything from here to the end of `run()` is the Tauri shell: the IPC
// commands the webview calls and the app entry point. Gated on the `gui`
// feature so a headless build (`npm run build:server`) drops the webview
// dependency chain entirely — see src-tauri/Cargo.toml.
#[cfg(feature = "gui")]
#[derive(serde::Serialize)]
struct DownloadEntry {
    name: String,
    modified: u64,
}

#[cfg(feature = "gui")]
#[tauri::command]
fn get_local_config() -> serde_json::Value {
    config::get_config_json()
}

/// Where this desktop app's server is (board #323): `embedded` (started
/// in-process because nothing answered), `gateway` (a running gateway proven
/// ours was reused), `occupied` (something unproven holds the port, so no
/// server was started; `reason` is the probe's own text, never peer text),
/// `starting` (embedded, not yet listening) or `failed` (the embedded server stopped with an error — the bind lost a race
/// after the probe, a TLS file did not load; `reason` is our own error).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ServerMode {
    pub mode: &'static str,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The one decision from a probe verdict (pure, tested).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn server_mode_of(v: &gateway::probe::Verdict, local_url: &str) -> ServerMode {
    use gateway::probe::Verdict;
    match v {
        Verdict::Ours { url, .. } => ServerMode { mode: "gateway", url: url.clone(), reason: None },
        Verdict::None => ServerMode { mode: "embedded", url: local_url.to_string(), reason: None },
        Verdict::Occupied(r) => ServerMode { mode: "occupied", url: local_url.to_string(), reason: Some(r.clone()) },
    }
}

/// One transition of the local server's mode (board #323 review), pure: the
/// state is `(start generation, mode)`. A new generation (a start decision)
/// always applies; within one generation `embedded` applies only over
/// `starting` (a late ready never revives `failed`), and `failed` is
/// terminal. Returns the new state, or None when the transition is refused.
pub fn advance_mode(cur: Option<&(u64, ServerMode)>, gen: u64, next: ServerMode) -> Option<(u64, ServerMode)> {
    match cur {
        Some((g, _)) if *g > gen => None,
        Some((g, m)) if *g == gen => match (m.mode, next.mode) {
            ("starting", "embedded") | ("starting", "failed") | ("embedded", "failed") => Some((gen, next)),
            _ => None,
        },
        _ => Some((gen, next)),
    }
}

/// What crosses to the webview, by `server_mode` and by every
/// `server_mode_changed` event alike: the mode, its start generation, and
/// `seq`, minted in the write lock for each APPLIED transition, so the
/// frontend keeps only a strictly newer `seq` whatever order the read and
/// the events arrive in (board #323 review).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ModeSnapshot {
    #[serde(flatten)]
    pub mode: ServerMode,
    pub gen: u64,
    pub seq: u64,
}

/// The locked state: the current `(gen, mode)` and the last `seq` minted.
#[derive(Default)]
pub struct ModeState {
    cur: Option<(u64, ServerMode)>,
    seq: u64,
}

impl ModeState {
    /// Apply a transition (`advance_mode`) and return the snapshot to
    /// publish, or None when refused. The caller publishes while it still
    /// holds the lock, so publication order is seq order.
    pub fn apply(&mut self, gen: u64, next: ServerMode) -> Option<ModeSnapshot> {
        let (g, m) = advance_mode(self.cur.as_ref(), gen, next)?;
        self.seq += 1;
        self.cur = Some((g, m.clone()));
        Some(ModeSnapshot { mode: m, gen: g, seq: self.seq })
    }
    pub fn snapshot(&self) -> Option<ModeSnapshot> {
        self.cur.as_ref().map(|(g, m)| ModeSnapshot { mode: m.clone(), gen: *g, seq: self.seq })
    }
}

#[cfg(feature = "gui")]
static SERVER_MODE: std::sync::Mutex<ModeState> = std::sync::Mutex::new(ModeState { cur: None, seq: 0 });
#[cfg(feature = "gui")]
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Apply a transition and, when it applied, tell the webview
/// (`server_mode_changed`, payload = the snapshot) INSIDE the lock, so no
/// older snapshot can be published after a newer one. Before the window
/// exists there is no one to tell; the frontend's first read covers it.
#[cfg(all(feature = "gui", desktop))]
fn set_server_mode(gen: u64, m: ServerMode) {
    let Ok(mut st) = SERVER_MODE.lock() else { return };
    if let (Some(snap), Some(app)) = (st.apply(gen, m), APP_HANDLE.get()) {
        use tauri::Emitter;
        let _ = app.emit("server_mode_changed", snap);
    }
}

/// The frontend's read: the current snapshot (same shape and seq as the
/// events); `null` where there is none (mobile).
#[cfg(feature = "gui")]
#[tauri::command]
fn server_mode() -> Option<ModeSnapshot> {
    SERVER_MODE.lock().ok().and_then(|st| st.snapshot())
}

#[cfg(feature = "gui")]
use downloads::sanitize_filename;

// Native downloads are written in pieces and resume across sessions
// (board #305, downloads.rs). The part files live in the Android Downloads
// folder (hidden by their prefix) or, on the desktop, in the app cache until
// the save dialog names a destination.
#[cfg(feature = "gui")]
fn part_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "android")]
    { let _ = app; Ok(std::path::PathBuf::from(downloads::ANDROID_DIR)) }
    #[cfg(not(target_os = "android"))]
    {
        use tauri::Manager;
        app.path().app_cache_dir().map(|d| d.join("downloads")).map_err(|e| e.to_string())
    }
}

#[cfg(feature = "gui")]
#[tauri::command]
fn download_open(app: tauri::AppHandle, id: String) -> Result<downloads::PartInfo, String> {
    downloads::open_part(&part_dir(&app)?, &id)
}

#[cfg(feature = "gui")]
#[tauri::command]
fn download_reset(app: tauri::AppHandle, id: String, etag: Option<String>, about: Option<downloads::About>) -> Result<(), String> {
    downloads::reset_part(&part_dir(&app)?, &id, etag.as_deref(), about.as_ref())
}

/// Unfinished downloads for the Downloads view (board #308).
#[cfg(feature = "gui")]
#[tauri::command]
fn download_list_parts(app: tauri::AppHandle) -> Result<Vec<downloads::PartListing>, String> {
    Ok(downloads::list_parts(&part_dir(&app)?))
}

#[cfg(feature = "gui")]
#[tauri::command]
fn download_chunk(app: tauri::AppHandle, id: String, data: String) -> Result<(), String> {
    downloads::append_part(&part_dir(&app)?, &id, &data)
}

/// Android saves as `<Downloads>/TmuxMobile/<name>`; the desktop passes the
/// path its save dialog returned. The dialog plugin grants exactly that file
/// to the fs scope, so a path the user did not pick is refused: the webview
/// talks to a possibly remote server and must not choose a local file to
/// overwrite (validator #305 P2).
#[cfg(feature = "gui")]
#[tauri::command]
fn download_finish(app: tauri::AppHandle, id: String, name: String, dest: Option<String>) -> Result<String, String> {
    let dir = part_dir(&app)?;
    let target = if cfg!(target_os = "android") {
        dir.join(sanitize_filename(&name)?)
    } else {
        use tauri_plugin_fs::FsExt;
        let dest = downloads::checked_dest(dest.as_deref().ok_or("no save location")?)?;
        if !app.fs_scope().is_allowed(&dest) { return Err("save location was not chosen in the dialog".into()); }
        dest
    };
    downloads::finish_part(&dir, &id, &target).map(|p| p.to_string_lossy().to_string())
}

#[cfg(feature = "gui")]
#[tauri::command]
fn download_abort(app: tauri::AppHandle, id: String) -> Result<(), String> {
    downloads::abort_part(&part_dir(&app)?, &id)
}

/// The page starts: claims from a previous page in this process are dead.
#[cfg(feature = "gui")]
#[tauri::command]
fn download_release_all() {
    downloads::release_all();
}

/// The writer gave up on the network and keeps its part for a later resume.
#[cfg(feature = "gui")]
#[tauri::command]
fn download_release(app: tauri::AppHandle, id: String) -> Result<(), String> {
    downloads::release_part(&part_dir(&app)?, &id)
}

#[cfg(feature = "gui")]
#[tauri::command]
fn list_downloads() -> Result<Vec<DownloadEntry>, String> {
    let dir = std::path::PathBuf::from(downloads::ANDROID_DIR);
    std::fs::create_dir_all(&dir).ok();
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                if let Some(name) = entry.file_name().to_str() {
                    // An unfinished download is not a file yet (#305).
                    if name.starts_with(downloads::PART_PREFIX) { continue; }
                    let modified = entry
                        .metadata()
                        .ok()
                        .and_then(|meta| meta.modified().ok())
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis() as u64)
                        .unwrap_or(0);
                    files.push(DownloadEntry {
                        name: name.to_string(),
                        modified,
                    });
                }
            }
        }
    }
    files.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(files)
}

#[cfg(feature = "gui")]
#[tauri::command]
fn delete_download(name: String) -> Result<(), String> {
    let safe_name = sanitize_filename(&name)?;
    let path = std::path::PathBuf::from(downloads::ANDROID_DIR).join(&safe_name);
    std::fs::remove_file(&path).map_err(|e| format!("delete: {}", e))
}

#[cfg(feature = "gui")]
#[tauri::command]
fn get_download_path(name: String) -> Result<String, String> {
    let safe_name = sanitize_filename(&name)?;
    Ok(format!("{}/{}", downloads::ANDROID_DIR, safe_name))
}

#[cfg(feature = "gui")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    {
        // Reuse a running gateway (board #323): probe once, with tmm's own
        // rules, before anything is started. Only a refused connection starts
        // the embedded server; a port held by something unproven starts
        // nothing (never a second server). Decided once at start.
        let cfg = Config::load();
        tmux::set_scrollback(cfg.scrollback);
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let verdict = rt.block_on(gateway::probe::probe(&cfg));
        let mode = server_mode_of(&verdict, &cfg.local_url());
        // One line on stderr per transition, so a launch can be checked from
        // outside: the start DECISION here (`starting` for an embedded start
        // — only the later "listening" line, and a real listener, prove it).
        let decided = if mode.mode == "embedded" { "starting" } else { mode.mode };
        eprintln!("tmux-mobile: local server decision {decided} at {}{}", mode.url, mode.reason.as_deref().map(|r| format!(" ({r})")).unwrap_or_default());
        if mode.mode == "embedded" {
            // `starting` until the listener is bound: the app says
            // `embedded` only for a server that is really listening. A
            // failure before or after (the port taken between the probe and
            // the bind, a TLS file that does not load) is `failed`, with our
            // own error as the reason.
            // One start per process today: generation 1.
            const GEN: u64 = 1;
            let url = mode.url.clone();
            set_server_mode(GEN, ServerMode { mode: "starting", url: url.clone(), reason: None });
            std::thread::spawn(move || {
                rt.block_on(async {
                    let (tx, rx) = tokio::sync::oneshot::channel();
                    let ready_url = url.clone();
                    tokio::spawn(async move {
                        if rx.await.is_ok() {
                            eprintln!("tmux-mobile: local server embedded at {ready_url} (listening)");
                            set_server_mode(GEN, ServerMode { mode: "embedded", url: ready_url, reason: None });
                        }
                    });
                    if let Err(e) = gateway::start_ready(cfg, Some(tx)).await {
                        eprintln!("Server error: {}", e);
                        set_server_mode(GEN, ServerMode { mode: "failed", url, reason: Some(e) });
                    }
                });
            });
        } else {
            set_server_mode(1, mode);
        }
    }

    let builder = tauri::Builder::default();
    // The QR scan reads the camera natively on a phone (board #403); a desktop
    // build never compiles the plugin, and its webview scans through getUserMedia.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // Native message notifications (board #72): the Android and macOS
        // webviews have no Web Notification API, so the chat's "someone
        // finished something" alert reaches the system tray only through
        // this plugin. The JS side (`hub/notifications.ts`) picks it when it
        // runs inside Tauri and keeps the browser path otherwise.
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![get_local_config, server_mode, download_open, download_reset, download_chunk, download_finish, download_abort, download_release, download_release_all, download_list_parts, list_downloads, delete_download, get_download_path])
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            // Desktop: build a custom menu WITHOUT the default View → Zoom
            // items.
            //
            // Tauri's default macOS menu includes Zoom entries bound to ⌘+/⌘-
            // that drive WKWebView's NATIVE magnification (scales the whole
            // page — nav/tab bar included). That runs at the AppKit level, so
            // a JS keydown preventDefault can't stop it, and it fights the
            // app's own font-size shortcut (you'd get both at once). We can't
            // remove just that item from the auto-generated menu, so we
            // rebuild a minimal menu that keeps the essentials (copy / paste /
            // cut / select-all / undo / redo / quit + window controls) but
            // omits Zoom. ⌘+/⌘-/⌘0 then reach only the frontend, which
            // applies one persisted native WebView scale and refits xterm to
            // the resulting container without changing terminal font size.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, Submenu, PredefinedMenuItem as P};
                let pkg = &app.package_info().name;
                let app_menu = Submenu::with_items(app, pkg, true, &[
                    &P::about(app, None, None)?,
                    &P::separator(app)?,
                    &P::services(app, None)?,
                    &P::separator(app)?,
                    &P::hide(app, None)?,
                    &P::hide_others(app, None)?,
                    &P::show_all(app, None)?,
                    &P::separator(app)?,
                    &P::quit(app, None)?,
                ])?;
                let edit_menu = Submenu::with_items(app, "Edit", true, &[
                    &P::undo(app, None)?,
                    &P::redo(app, None)?,
                    &P::separator(app)?,
                    &P::cut(app, None)?,
                    &P::copy(app, None)?,
                    &P::paste(app, None)?,
                    &P::select_all(app, None)?,
                ])?;
                let window_menu = Submenu::with_items(app, "Window", true, &[
                    &P::minimize(app, None)?,
                    &P::maximize(app, None)?,
                    &P::separator(app)?,
                    &P::close_window(app, None)?,
                ])?;
                let menu = Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])?;
                app.set_menu(menu)?;
            }
            // Non-macOS desktop: an empty menu bar is fine (zoom accelerators
            // there come from the menu too; copy/paste work without it).
            #[cfg(all(desktop, not(target_os = "macos")))]
            {
                use tauri::menu::Menu;
                app.set_menu(Menu::new(app)?)?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod server_mode_tests {
    use super::*;
    use gateway::probe::Verdict;

    /// Board #323: only a refused connection starts the embedded server; a
    /// gateway proven ours is reused at ITS url; anything unproven starts
    /// nothing and says why.
    #[test]
    fn the_probe_verdict_decides_the_server_mode() {
        let local = "ws://127.0.0.1:19977";
        let ours = server_mode_of(&Verdict::Ours { machine_id: "m".into(), url: "ws://127.0.0.1:19977".into(), build: None }, local);
        assert_eq!((ours.mode, ours.url.as_str(), ours.reason.is_none()), ("gateway", "ws://127.0.0.1:19977", true));
        let none = server_mode_of(&Verdict::None, local);
        assert_eq!((none.mode, none.url.as_str()), ("embedded", local));
        let busy = server_mode_of(&Verdict::Occupied("ws://127.0.0.1:19977 is another machine's gateway".into()), local);
        assert_eq!(busy.mode, "occupied");
        assert_eq!(busy.reason.as_deref(), Some("ws://127.0.0.1:19977 is another machine's gateway"));
        assert_eq!(serde_json::to_value(&none).unwrap(), serde_json::json!({ "mode": "embedded", "url": local }), "no reason field unless occupied");
    }

    /// Board #323 review P1-a: ready advances only `starting` of its own
    /// generation; `failed` is terminal, so a ready that lands after the
    /// failure (sent, but its task ran late) cannot revive the mode.
    #[test]
    fn a_late_ready_never_revives_a_failed_start() {
        let m = |mode: &'static str| ServerMode { mode, url: "u".into(), reason: None };
        let starting = advance_mode(None, 1, m("starting")).unwrap();
        // Normal: ready, then a later failure still shows.
        let up = advance_mode(Some(&starting), 1, m("embedded")).unwrap();
        assert_eq!(up.1.mode, "embedded");
        assert_eq!(advance_mode(Some(&up), 1, m("failed")).unwrap().1.mode, "failed", "a failure after ready is shown");
        // The race: failure applied first, the ready lands after.
        let failed = advance_mode(Some(&starting), 1, m("failed")).unwrap();
        assert!(advance_mode(Some(&failed), 1, m("embedded")).is_none(), "the late ready is refused");
        assert!(advance_mode(Some(&failed), 1, m("starting")).is_none(), "failed is terminal for its generation");
        // The locked state mints one seq per APPLIED transition; a refused
        // one mints none, and the snapshot carries the same seq.
        let mut st = ModeState::default();
        let s1 = st.apply(1, m("starting")).unwrap();
        let s2 = st.apply(1, m("failed")).unwrap();
        assert!(st.apply(1, m("embedded")).is_none(), "the late ready publishes nothing");
        assert_eq!((s1.seq, s2.seq), (1, 2));
        assert_eq!(st.snapshot().unwrap(), s2, "the read is the last published snapshot");
        assert_eq!(serde_json::to_value(&s2).unwrap(), serde_json::json!({ "mode": "failed", "url": "u", "gen": 1, "seq": 2 }));
        // An older generation never overwrites a newer one; a newer one always applies.
        assert!(advance_mode(Some(&(2, m("starting"))), 1, m("embedded")).is_none());
        assert_eq!(advance_mode(Some(&failed), 2, m("starting")).unwrap().0, 2);
    }
}
