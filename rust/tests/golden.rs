//! Parity gate: `render` must reproduce `tokenline.sh` byte-for-byte.
//!
//! The healthy fixture is asserted against a golden captured from the (fixed)
//! bash oracle under a frozen clock; the branch cases assert the structural
//! decisions bash makes (Gemini hides rate limits, an idle turn hides the cost
//! line, a fast burn flags the pace and shows its ETA exactly once).
use std::path::PathBuf;
use tokenline::input::RawInput;
use tokenline::render;

/// A frozen clock so the cache countdown and rate-limit ETAs are deterministic.
const NOW: i64 = 1_783_000_000;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// A fresh empty cache dir per case, so the cache countdown starts at a full
/// window (first run) rather than reading a stale entry.
fn cache_scratch(label: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("tl-golden-{}-{}", std::process::id(), label));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn parse(json: &str) -> RawInput {
    serde_json::from_str(json).unwrap()
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for c2 in chars.by_ref() {
                if c2 == 'm' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[test]
fn healthy_claude_is_byte_exact() {
    let raw = parse(&std::fs::read_to_string(fixtures_dir().join("healthy_claude.json")).unwrap());
    let got = render(raw, NOW, &cache_scratch("healthy"));
    // The golden carries bash's trailing newline; render omits it (the binary
    // adds it back), so compare against the golden minus one trailing '\n'.
    let golden = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/healthy_claude.txt"),
    )
    .unwrap();
    assert_eq!(got, golden.strip_suffix('\n').unwrap_or(&golden));
}

#[test]
fn gemini_hides_rate_limits() {
    let raw = parse(
        r#"{"model":{"display_name":"Gemini 2.5 Pro"},
            "context_window":{"used_percentage":9.0,"context_window_size":1000000,
              "current_usage":{"cache_read_input_tokens":100,"output_tokens":50}}}"#,
    );
    let out = strip_ansi(&render(raw, NOW, &cache_scratch("gemini")));
    assert!(!out.contains("5h:"), "Gemini has no rate limits:\n{out}");
    assert!(!out.contains("7d:"), "Gemini has no rate limits:\n{out}");
}

#[test]
fn idle_turn_hides_cost_line() {
    let raw = parse(
        r#"{"model":{"display_name":"Opus 4.8"},
            "context_window":{"used_percentage":1.0}}"#,
    );
    let out = strip_ansi(&render(raw, NOW, &cache_scratch("idle")));
    assert!(
        !out.contains("read(0.1x)"),
        "no turn => no cost line:\n{out}"
    );
    assert!(!out.contains("eq:"), "no turn => no cost line:\n{out}");
}

#[test]
fn very_fast_pace_flags_once() {
    // resets_at = now + 9000s. window 18000s, elapsed 9000 (>=10%).
    // pace = 88*18000/(9000*100) = 1.76 -> VeryFast ("!!").
    let raw = parse(
        r#"{"model":{"display_name":"Opus 4.8"},
            "context_window":{"used_percentage":9.0},
            "rate_limits":{"five_hour":{"used_percentage":88.0,"resets_at":"2026-07-02T16:16:40Z"}}}"#,
    );
    let out = strip_ansi(&render(raw, NOW, &cache_scratch("pace")));
    assert!(out.contains("88%"), "expected the 5h pct:\n{out}");
    assert!(out.contains(" !!"), "expected the VeryFast marker:\n{out}");
    assert_eq!(
        out.matches("to reset").count(),
        1,
        "ETA must appear exactly once:\n{out}"
    );
}

// A manual hot-path timing check (this runs once per second inside the host).
// Not a CI gate — `cargo test --release -- --ignored bench_render` to see it.
#[test]
#[ignore = "manual benchmark; run with --release"]
fn bench_render_hot_path() {
    // The real per-second hot path is parse + render, so time both.
    let json = std::fs::read_to_string(fixtures_dir().join("healthy_claude.json")).unwrap();
    let dir = cache_scratch("bench");
    let iters = 50_000;
    let start = std::time::Instant::now();
    for _ in 0..iters {
        std::hint::black_box(render(parse(&json), NOW, &dir));
    }
    let per = start.elapsed() / iters;
    println!("parse+render hot path: {per:?}/iter over {iters} iters");
}
