use std::io::Read;
use std::time::{SystemTime, UNIX_EPOCH};
use tokenline::{render, Density};
use tokenline::cache::runtime_dir;
use tokenline::input::RawInput;

fn main() {
    // Any panic anywhere becomes empty output + exit(0). Never disturb the host.
    std::panic::set_hook(Box::new(|_| {})); // suppress backtrace to stderr
    let result = std::panic::catch_unwind(run);
    // run() returns the string to print (empty on any handled failure).
    let line = result.unwrap_or_default();
    if !line.is_empty() {
        print!("{}", line);
    }
    std::process::exit(0);
}

fn run() -> String {
    let mut buf = String::new();
    if std::io::stdin().read_to_string(&mut buf).is_err() { return String::new(); }
    let raw: RawInput = match serde_json::from_str(&buf) {
        Ok(r) => r,
        Err(_) => return String::new(), // malformed => silent no-op
    };
    let now = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64).unwrap_or(0);
    let dir = runtime_dir();
    render(raw, now, &dir, Density::Normal)
}
