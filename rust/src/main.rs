// tokenline — a cache-aware statusline for AI coding CLIs.
//
// The imperative shell: read the host's JSON from stdin, stamp `now`, resolve
// the runtime cache dir, render, write, exit(0). It runs once per second inside
// the host CLI, so the one hard rule is *never disturb the host*: any panic
// anywhere is swallowed to empty output + exit(0), and writes go through
// `write_all` (not `print!`) so a closed pipe can't raise.
use std::io::{Read, Write};
use std::time::{SystemTime, UNIX_EPOCH};
use tokenline::cache::runtime_dir;
use tokenline::input::RawInput;
use tokenline::render;

fn main() {
    std::panic::set_hook(Box::new(|_| {})); // no backtrace to the host's stderr
    let line = std::panic::catch_unwind(run).unwrap_or_default();
    if !line.is_empty() {
        let mut out = std::io::stdout();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }
    std::process::exit(0);
}

// Returns the rendered statusline, or an empty string on any handled failure
// (unreadable stdin, malformed JSON) — the caller prints nothing in that case.
fn run() -> String {
    let mut buf = String::new();
    if std::io::stdin().read_to_string(&mut buf).is_err() {
        return String::new();
    }
    let raw: RawInput = match serde_json::from_str(&buf) {
        Ok(r) => r,
        Err(_) => return String::new(),
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    render(raw, now, &runtime_dir())
}
