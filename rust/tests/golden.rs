use std::path::PathBuf;
use tokenline::{render, Density};
use tokenline::input::RawInput;

fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == 0x1b {
            while i < b.len() && b[i] != b'm' { i += 1; }
            i += 1; // skip 'm'
        } else { out.push(b[i] as char); i += 1; }
    }
    out
}

fn fixtures_dir() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures") }

fn cache_scratch() -> PathBuf {
    let d = std::env::temp_dir().join(format!("tl-golden-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn healthy_claude_matches_golden() {
    let raw: RawInput = serde_json::from_str(
        &std::fs::read_to_string(fixtures_dir().join("healthy_claude.json")).unwrap()).unwrap();
    // FIXED now so the cache countdown is deterministic.
    let now = 1_783_000_000;
    let out = render(raw, now, &cache_scratch(), Density::Normal);
    let got = strip_ansi(&out);
    let want = std::fs::read_to_string(fixtures_dir().join("healthy_claude.txt")).unwrap();
    assert_eq!(got, want, "\n--- got ---\n{}\n--- want ---\n{}", got, want);
}

#[test]
fn gemini_hides_rate_limits() {
    let raw: RawInput = serde_json::from_str(
        r#"{"model":{"display_name":"Gemini 2.5 Pro"},
            "context_window":{"used_percentage":9.0,"context_window_size":1000000,
              "current_usage":{"cache_read_input_tokens":100,"output_tokens":50}}}"#).unwrap();
    let out = strip_ansi(&render(raw, 1_783_000_000, &cache_scratch(), Density::Normal));
    assert!(!out.contains("5h"), "Gemini has no rate limits");
    assert!(!out.contains("7d"));
}

#[test]
fn no_activity_hides_cost_line() {
    let raw: RawInput = serde_json::from_str(
        r#"{"model":{"display_name":"Opus 4.8"},
            "context_window":{"used_percentage":1.0}}"#).unwrap();
    let out = strip_ansi(&render(raw, 1_783_000_000, &cache_scratch(), Density::Normal));
    assert!(!out.contains("cost "), "no turn => no cost line");
}

