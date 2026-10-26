// The `server` binary is a thin alias of `tmm gateway start` (board #323):
// the dev watcher and existing service files still launch it by this name.
use tmux_mobile::{config::Config, gateway};

#[tokio::main]
async fn main() {
    // The configuration root is decided here, before Config::load reads or seeds anything (board #472).
    if let Err(e) = tmux_mobile::config::init_root() {
        eprintln!("❌ {e}");
        std::process::exit(1);
    }
    if let Err(e) = gateway::start(Config::load()).await {
        eprintln!("❌ Server error: {}", e);
        std::process::exit(1);
    }
}
