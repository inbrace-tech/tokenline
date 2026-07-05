# Rust tokenline core binary (v1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `tokenline` Rust binary that reads the host CLI's stdin JSON and prints the redesigned **PULSE+** statusline, at logic-parity with `tokenline.sh` and correct on Linux/macOS/Windows.

**Architecture:** A single binary crate under `rust/`. `main()` is a thin, never-panics shell (read stdin, get `now`, resolve cache dir, `catch_unwind`, print, `exit(0)`). All work is a pure function `render(input, now, cache_dir, density) -> String` split across focused modules: `input` (serde structs), `fmt` (palette + number formatting), `epoch` (ISO→epoch), `economics` + `ratelimits` (pure compute), `cache` + `cachetimer` (stateful), `render` (PULSE+ composition). Correctness comes from a **logic-value oracle** (computed values asserted against the current bash output) plus **render golden fixtures** (PULSE+ output regression).

**Tech Stack:** Rust (edition 2021, stable), `serde` + `serde_json` only; `std` for time (`SystemTime`), file mtime (`fs::metadata`), and cross-platform dirs. No `chrono`, no `jq`, no coreutils.

## Global Constraints

- **Never crash the host.** `main()` always exits 0. No `.unwrap()`/`.expect()`/`?` may escape `main`; a `panic::set_hook` + `catch_unwind` turn any panic into empty output + `exit(0)`. `panic = "unwind"` (never `abort`).
- **Never write session input to disk.** Only the tiny per-turn cache persists, under a `0700` dir (`#[cfg(unix)]`) in `$XDG_RUNTIME_DIR` (Unix) / `%LOCALAPPDATA%` (Windows).
- **Dependencies:** `serde`, `serde_json` only. `std` for everything else.
- **Glyphs:** universal Unicode/emoji only (no nerd-font). Truecolor (24-bit) ANSI.
- **Logic parity, not layout parity:** the *computed values* (eq, saving %, ctx %, ttl, rate-limit %) must match `tokenline.sh`; the *rendered layout* is the new PULSE+ design.
- **Crate location:** `rust/` at repo root, single binary crate `tokenline`. The TS installer under `src/` is untouched.
- **Version:** `0.1.0` (earns `1.0.0` at parity + Windows-verified).
- **`render` takes a `density` argument from day one; v1 implements only `Density::Normal` (PULSE+).** `Compact`/`Verbose` fall back to `Normal` for now (no separate renderer built).
- **Multipliers (from `tokenline.sh:398-418`), verbatim:**
  - Anthropic: read `0.1`, write `1.25` (→ `2.0` when the cache window is `1h`), new `1`, output `5`.
  - Gemini: read `0.25`, write `1.0`, new `1`, output `4`.
  - `eq = cread*read + cwrite*write + cinput*new + coutput*output`
  - `uncached_eq = (cread + cwrite + cinput)*new + coutput*output`  ← the "vs N full" denominator
  - `saving% = floor(100*(uncached_eq - eq)/uncached_eq)`, or `0` if `uncached_eq == 0`.
- **Cache TTL (from `tokenline.sh:231-250`):** Gemini → `300`/`"5m"`. Anthropic → `1h`/`3600` if `ephemeral_1h > 0`, else `5m`/`300` if `ephemeral_5m > 0`, else the previously-cached ttl, else `5m`/`300`.

---

## File Structure

```
rust/
  Cargo.toml
  src/
    main.rs         — thin shell; never panics; exit 0
    lib.rs          — module wiring + `pub fn render(&Input, now, &Path, Density) -> String`
    input.rs        — serde structs (RawInput) + derived `Session`
    fmt.rs          — truecolor palette (Role), Style, paint(); fmt_k, fmt_eta
    epoch.rs        — iso8601_to_epoch(&str) -> Option<i64>
    economics.rs    — Economics { eq, uncached_eq, saving_pct, tiers } + compute
    ratelimits.rs   — RlWindow compute (pct, eta, pace) + bar()
    cache.rs        — runtime_dir(), CacheFile read/write (consolidated), turn detection
    cachetimer.rs   — ttl determination + transcript last-turn read + CacheInfo
    render.rs       — Density enum + PULSE+ (Normal) line composition
  tests/
    fixtures/       — *.json inputs + *.values.json expected computed values
    logic_oracle.rs — assert computed values match bash reference
    golden.rs       — assert PULSE+ rendered output matches committed .txt (ANSI-stripped)
```

Each module below is introduced by the task that creates it. `lib.rs` grows as modules land; `render.rs` and `main.rs` come last.

---

### Task 1: Crate scaffold + input parsing + tracer

**Files:**
- Create: `rust/Cargo.toml`, `rust/src/main.rs`, `rust/src/lib.rs`, `rust/src/input.rs`
- Test: `rust/src/input.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Produces: `RawInput` (serde struct of the stdin JSON), `Session::from_raw(RawInput) -> Session` with derived fields `model, used_pct: Option<f64>, tokens_limit: Option<u64>, transcript_path: String, session_id: String, rl_5h/7d: Option<RlRaw>, cur_input/output/cwrite/cread: u64, tokens_used: u64, cli_client: Client, is_gemini: bool`.

- [ ] **Step 1: Write the failing test**

In `rust/src/input.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "model": {"display_name": "Opus 4.8"},
      "context_window": {
        "used_percentage": 9.0, "context_window_size": 1000000,
        "current_usage": {"input_tokens": 2, "output_tokens": 2000,
          "cache_creation_input_tokens": 2200, "cache_read_input_tokens": 86600}
      },
      "transcript_path": "/home/u/.claude/projects/p/abc.jsonl",
      "session_id": "abc",
      "rate_limits": {
        "five_hour": {"used_percentage": 12.0, "resets_at": "2026-07-05T18:00:00Z"},
        "seven_day": {"used_percentage": 64.0, "resets_at": "2026-07-06T12:00:00Z"}
      }
    }"#;

    #[test]
    fn parses_and_derives() {
        let raw: RawInput = serde_json::from_str(SAMPLE).unwrap();
        let s = Session::from_raw(raw);
        assert_eq!(s.model, "Opus 4.8");
        assert_eq!(s.tokens_limit, Some(1_000_000));
        assert_eq!(s.cur_cread, 86_600);
        assert_eq!(s.tokens_used, 2 + 2200 + 86600); // input + cwrite + cread
        assert_eq!(s.session_id, "abc");
        assert!(!s.is_gemini);
        assert_eq!(s.cli_client, Client::ClaudeCode);
    }

    #[test]
    fn missing_fields_default_gracefully() {
        let raw: RawInput = serde_json::from_str("{}").unwrap();
        let s = Session::from_raw(raw);
        assert_eq!(s.model, "");
        assert_eq!(s.tokens_limit, None);
        assert_eq!(s.tokens_used, 0);
    }

    #[test]
    fn detects_gemini_and_antigravity() {
        let raw: RawInput = serde_json::from_str(
            r#"{"model":{"display_name":"Gemini 2.5 Pro"},
                "transcript_path":"/x/antigravity/y/z.jsonl"}"#).unwrap();
        let s = Session::from_raw(raw);
        assert!(s.is_gemini);
        assert_eq!(s.cli_client, Client::Antigravity);
        assert!(s.transcript_path.contains("/antigravity-cli/"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd rust && cargo test input`
Expected: FAIL — `RawInput`/`Session` not defined.

- [ ] **Step 3: Write `Cargo.toml`**

```toml
[package]
name = "tokenline"
version = "0.1.0"
edition = "2021"
description = "A cache-aware statusline for AI coding CLIs"
license = "MIT"

[[bin]]
name = "tokenline"
path = "src/main.rs"

[lib]
name = "tokenline"
path = "src/lib.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"

[profile.release]
opt-level = "z"
lto = true
strip = true
panic = "unwind"   # catch_unwind MUST work; abort would be a non-zero exit
```

- [ ] **Step 4: Write `rust/src/input.rs`**

```rust
use serde::Deserialize;

#[derive(Deserialize, Default)]
pub struct RawInput {
    #[serde(default)] pub model: Model,
    #[serde(default)] pub context_window: ContextWindow,
    #[serde(default)] pub transcript_path: String,
    #[serde(default)] pub session_id: String,
    #[serde(default)] pub rate_limits: RateLimits,
}

#[derive(Deserialize, Default)]
pub struct Model { #[serde(default)] pub display_name: String }

#[derive(Deserialize, Default)]
pub struct ContextWindow {
    #[serde(default)] pub used_percentage: Option<f64>,
    #[serde(default)] pub context_window_size: Option<u64>,
    #[serde(default)] pub current_usage: Usage,
}

#[derive(Deserialize, Default)]
pub struct Usage {
    #[serde(default)] pub input_tokens: u64,
    #[serde(default)] pub output_tokens: u64,
    #[serde(default)] pub cache_creation_input_tokens: u64,
    #[serde(default)] pub cache_read_input_tokens: u64,
}

#[derive(Deserialize, Default)]
pub struct RateLimits {
    #[serde(default)] pub five_hour: Option<RlRaw>,
    #[serde(default)] pub seven_day: Option<RlRaw>,
}

#[derive(Deserialize, Default, Clone)]
pub struct RlRaw {
    #[serde(default)] pub used_percentage: Option<f64>,
    #[serde(default)] pub resets_at: Option<String>,
}

#[derive(PartialEq, Debug)]
pub enum Client { ClaudeCode, Antigravity }

pub struct Session {
    pub model: String,
    pub used_pct: Option<f64>,
    pub tokens_limit: Option<u64>,
    pub transcript_path: String,
    pub session_id: String,
    pub rl_5h: Option<RlRaw>,
    pub rl_7d: Option<RlRaw>,
    pub cur_input: u64,
    pub cur_output: u64,
    pub cur_cwrite: u64,
    pub cur_cread: u64,
    pub tokens_used: u64,
    pub cli_client: Client,
    pub is_gemini: bool,
}

impl Session {
    pub fn from_raw(r: RawInput) -> Session {
        let u = r.context_window.current_usage;
        let tokens_used = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;

        // Subagent transcript -> parent session (tokenline.sh:123-125)
        let mut transcript_path = r.transcript_path;
        if transcript_path.contains("/subagents/") {
            if let Some(parent) = std::path::Path::new(&transcript_path)
                .parent().and_then(|p| p.parent())
            {
                transcript_path = format!("{}.jsonl", parent.display());
            }
        }

        // Client + antigravity path correction (tokenline.sh:127-136)
        let cli_client = if transcript_path.contains("/antigravity") {
            Client::Antigravity
        } else {
            Client::ClaudeCode
        };
        if cli_client == Client::Antigravity && transcript_path.contains("/antigravity/") {
            transcript_path = transcript_path.replace("/antigravity/", "/antigravity-cli/");
        }

        let is_gemini = r.model.display_name.to_lowercase().contains("gemini");

        Session {
            model: r.model.display_name,
            used_pct: r.context_window.used_percentage,
            tokens_limit: r.context_window.context_window_size,
            transcript_path,
            session_id: r.session_id,
            rl_5h: r.rate_limits.five_hour,
            rl_7d: r.rate_limits.seven_day,
            cur_input: u.input_tokens,
            cur_output: u.output_tokens,
            cur_cwrite: u.cache_creation_input_tokens,
            cur_cread: u.cache_read_input_tokens,
            tokens_used,
            cli_client,
            is_gemini,
        }
    }
}
```

Create `rust/src/lib.rs`:
```rust
pub mod input;
```

Create `rust/src/main.rs` (tracer; hardened in Task 9):
```rust
use std::io::Read;
use tokenline::input::{RawInput, Session};

fn main() {
    let mut buf = String::new();
    if std::io::stdin().read_to_string(&mut buf).is_err() { return; }
    match serde_json::from_str::<RawInput>(&buf) {
        Ok(raw) => println!("{}", Session::from_raw(raw).model),
        Err(_) => {} // silent no-op on malformed input
    }
}
```

- [ ] **Step 5: Run test + tracer**

Run: `cd rust && cargo test input`
Expected: PASS (3 tests).
Run: `echo '{"model":{"display_name":"Opus 4.8"}}' | cargo run -q`
Expected: prints `Opus 4.8`.

- [ ] **Step 6: Commit**

```bash
git add rust/Cargo.toml rust/src/input.rs rust/src/lib.rs rust/src/main.rs
git commit -m "feat(rust): scaffold crate, parse stdin JSON into Session"
```

---

### Task 2: `fmt` — truecolor palette + number formatting

**Files:**
- Create: `rust/src/fmt.rs`
- Modify: `rust/src/lib.rs` (add `pub mod fmt;`)
- Test: `rust/src/fmt.rs` inline

**Interfaces:**
- Produces:
  - `enum Role { Ink, Muted, Faint, Good, Warn, Caution, Critical, Cache, Accent, Read, New, Write, Output }`
  - `struct Style { role: Role, bold: bool, blink: bool }` with `Role::paint(text, bold, blink) -> String` (emits truecolor ANSI, always resets).
  - `fn fmt_k(v: u64) -> String` (1_500_000 → "1.5M", 25_600 → "25.6k", 900 → "900").
  - `fn fmt_eta(secs: i64) -> String` (0→"now", 90→"1m", 3600→"1h", 5400→"1h30m", 90000→"1d1h").

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fmt_k_scales() {
        assert_eq!(fmt_k(1_500_000), "1.5M");
        assert_eq!(fmt_k(25_600), "25.6k");
        assert_eq!(fmt_k(86_600), "86.6k");
        assert_eq!(fmt_k(900), "900");
        assert_eq!(fmt_k(0), "0");
    }
    #[test]
    fn fmt_eta_buckets() {
        assert_eq!(fmt_eta(0), "now");
        assert_eq!(fmt_eta(-5), "now");
        assert_eq!(fmt_eta(90), "1m");
        assert_eq!(fmt_eta(3600), "1h");
        assert_eq!(fmt_eta(5400), "1h30m");
        assert_eq!(fmt_eta(90_000), "1d1h");
        assert_eq!(fmt_eta(86_400), "1d");
    }
    #[test]
    fn paint_wraps_and_resets() {
        let s = Role::Good.paint("hi", false, false);
        assert!(s.starts_with("\x1b[38;2;63;185;80m"));
        assert!(s.ends_with("\x1b[0m"));
        assert!(s.contains("hi"));
    }
    #[test]
    fn paint_bold_and_blink() {
        let s = Role::Critical.paint("x", true, true);
        assert!(s.contains("\x1b[1m"));
        assert!(s.contains("\x1b[5m"));
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo test fmt`
Expected: FAIL — module/functions not defined.

- [ ] **Step 3: Write `rust/src/fmt.rs`**

```rust
#[derive(Clone, Copy)]
pub enum Role {
    Ink, Muted, Faint, Good, Warn, Caution, Critical, Cache, Accent,
    Read, New, Write, Output,
}

impl Role {
    // PULSE+ refined truecolor palette (24-bit).
    fn rgb(self) -> (u8, u8, u8) {
        match self {
            Role::Ink      => (0xe6, 0xed, 0xf3),
            Role::Muted    => (0x8b, 0x94, 0x9e),
            Role::Faint    => (0x5b, 0x66, 0x73),
            Role::Good     => (0x3f, 0xb9, 0x50),
            Role::Warn     => (0xd2, 0x99, 0x22),
            Role::Caution  => (0xdb, 0x6d, 0x28),
            Role::Critical => (0xf0, 0x50, 0x3c),
            Role::Cache    => (0x3f, 0xb9, 0x50),
            Role::Accent   => (0x58, 0xa6, 0xff),
            Role::Read     => (0x45, 0xc4, 0xa8),
            Role::New      => (0x6c, 0x9e, 0xff),
            Role::Write    => (0xe0, 0xa4, 0x58),
            Role::Output   => (0xd1, 0x8a, 0xc9),
        }
    }
    pub fn paint(self, text: &str, bold: bool, blink: bool) -> String {
        let (r, g, b) = self.rgb();
        let mut s = String::new();
        s.push_str(&format!("\x1b[38;2;{};{};{}m", r, g, b));
        if bold { s.push_str("\x1b[1m"); }
        if blink { s.push_str("\x1b[5m"); }
        s.push_str(text);
        s.push_str("\x1b[0m");
        s
    }
}

/// 1_500_000 -> "1.5M", 25_600 -> "25.6k", 900 -> "900".
/// Mirrors tokenline.sh fmt_k (awk %.1f).
pub fn fmt_k(v: u64) -> String {
    if v >= 1_000_000 {
        format!("{:.1}M", v as f64 / 1_000_000.0)
    } else if v >= 1_000 {
        format!("{:.1}k", v as f64 / 1_000.0)
    } else {
        v.to_string()
    }
}

/// Mirrors tokenline.sh fmt_eta.
pub fn fmt_eta(secs: i64) -> String {
    if secs <= 0 { return "now".to_string(); }
    if secs < 3600 { return format!("{}m", secs / 60); }
    if secs < 86_400 {
        let (h, m) = (secs / 3600, (secs % 3600) / 60);
        return if m > 0 { format!("{}h{}m", h, m) } else { format!("{}h", h) };
    }
    let (d, h) = (secs / 86_400, (secs % 86_400) / 3600);
    if h > 0 { format!("{}d{}h", d, h) } else { format!("{}d", d) }
}
```

Add to `rust/src/lib.rs`: `pub mod fmt;`

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test fmt`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/src/fmt.rs rust/src/lib.rs
git commit -m "feat(rust): truecolor palette + fmt_k/fmt_eta"
```

---

### Task 3: `epoch` — ISO-8601 → epoch (hand-rolled)

**Files:**
- Create: `rust/src/epoch.rs`
- Modify: `rust/src/lib.rs` (`pub mod epoch;`)
- Test: `rust/src/epoch.rs` inline

**Interfaces:**
- Produces: `fn iso8601_to_epoch(iso: &str) -> Option<i64>` — parses the first 19 chars `YYYY-MM-DDTHH:MM:SS` as UTC (transcripts are always UTC, matching `tokenline.sh:54`). Returns `None` on malformed input.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn epoch_unix_zero() {
        assert_eq!(iso8601_to_epoch("1970-01-01T00:00:00Z"), Some(0));
    }
    #[test]
    fn epoch_known_instant() {
        // 2026-07-05T18:00:00Z == 1783274400
        assert_eq!(iso8601_to_epoch("2026-07-05T18:00:00Z"), Some(1_783_274_400));
    }
    #[test]
    fn epoch_ignores_fractional_and_offset_suffix() {
        assert_eq!(iso8601_to_epoch("2026-07-05T18:00:00.123456Z"), Some(1_783_274_400));
    }
    #[test]
    fn epoch_leap_day() {
        // 2024-02-29T00:00:00Z == 1709164800
        assert_eq!(iso8601_to_epoch("2024-02-29T00:00:00Z"), Some(1_709_164_800));
    }
    #[test]
    fn epoch_rejects_garbage() {
        assert_eq!(iso8601_to_epoch("not-a-date"), None);
        assert_eq!(iso8601_to_epoch(""), None);
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo test epoch`
Expected: FAIL — not defined.

- [ ] **Step 3: Write `rust/src/epoch.rs`**

```rust
/// Days from civil date to days-since-1970 (Howard Hinnant's algorithm).
/// Correct across leap years; no external date library needed.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;                         // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// Parse `YYYY-MM-DDTHH:MM:SS` (first 19 chars, UTC) -> epoch seconds.
pub fn iso8601_to_epoch(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 19 { return None; }
    let num = |lo: usize, hi: usize| -> Option<i64> {
        std::str::from_utf8(&b[lo..hi]).ok()?.parse::<i64>().ok()
    };
    // Positions: 0123-56-89 T 11:14:17
    if b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ')
        || b[13] != b':' || b[16] != b':' { return None; }
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let min = num(14, 16)?;
    let sec = num(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day)
        || hour > 23 || min > 59 || sec > 60 { return None; }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3600 + min * 60 + sec)
}
```

Add to `lib.rs`: `pub mod epoch;`

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test epoch`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add rust/src/epoch.rs rust/src/lib.rs
git commit -m "feat(rust): hand-rolled ISO-8601 UTC to epoch"
```

---

### Task 4: `economics` — per-turn cost, eq, saving

**Files:**
- Create: `rust/src/economics.rs`
- Modify: `rust/src/lib.rs` (`pub mod economics;`)
- Test: `rust/src/economics.rs` inline (the logic oracle)

**Interfaces:**
- Consumes: `Session` fields `cur_cread/cwrite/input/output`, `is_gemini`.
- Produces:
  - `struct Tier { role: fmt::Role, tokens: u64, eq_contrib: f64 }`  (roles Read, New, Write, Output — thermometer order)
  - `struct Economics { eq: u64, uncached_eq: u64, saving_pct: i64, tiers: [Tier; 4], any_activity: bool }`
  - `fn economics(s: &Session, cache_is_1h: bool) -> Economics`

- [ ] **Step 1: Write the failing test (oracle values)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{RawInput, Session};

    fn sess(json: &str) -> Session { Session::from_raw(serde_json::from_str(json).unwrap()) }

    #[test]
    fn anthropic_1h_matches_bash() {
        // read 86.6k, write 2.2k, new 2, output 2.0k, cache=1h
        // eq   = 86600*0.1 + 2200*2 + 2*1 + 2000*5 = 8660 + 4400 + 2 + 10000 = 23062
        // unc  = (86600+2200+2)*1 + 2000*5 = 88802 + 10000 = 98802
        // save = floor(100*(98802-23062)/98802) = 76
        let s = sess(r#"{"model":{"display_name":"Opus 4.8"},"context_window":{"current_usage":
            {"input_tokens":2,"output_tokens":2000,"cache_creation_input_tokens":2200,
             "cache_read_input_tokens":86600}}}"#);
        let e = economics(&s, true);
        assert_eq!(e.eq, 23_062);
        assert_eq!(e.uncached_eq, 98_802);
        assert_eq!(e.saving_pct, 76);
        assert!(e.any_activity);
        assert_eq!(e.tiers[0].role as u8, fmt::Role::Read as u8); // thermometer order
    }

    #[test]
    fn anthropic_5m_uses_1_25_write() {
        // write mult 1.25 when cache window is 5m
        let s = sess(r#"{"context_window":{"current_usage":
            {"cache_creation_input_tokens":1000,"output_tokens":0,
             "input_tokens":0,"cache_read_input_tokens":0}}}"#);
        let e = economics(&s, false);
        assert_eq!(e.eq, 1250); // 1000 * 1.25
    }

    #[test]
    fn gemini_multipliers() {
        // read 0.25, write 1.0, new 1, output 4
        let s = sess(r#"{"model":{"display_name":"Gemini 2.5 Pro"},"context_window":{"current_usage":
            {"cache_read_input_tokens":1000,"cache_creation_input_tokens":1000,
             "input_tokens":1000,"output_tokens":1000}}}"#);
        let e = economics(&s, false);
        // eq = 250 + 1000 + 1000 + 4000 = 6250
        assert_eq!(e.eq, 6250);
    }

    #[test]
    fn zero_activity() {
        let s = sess("{}");
        let e = economics(&s, false);
        assert!(!e.any_activity);
        assert_eq!(e.saving_pct, 0);
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo test economics`
Expected: FAIL — not defined.

- [ ] **Step 3: Write `rust/src/economics.rs`**

```rust
use crate::fmt::Role;
use crate::input::Session;

pub struct Tier { pub role: Role, pub tokens: u64, pub eq_contrib: f64 }

pub struct Economics {
    pub eq: u64,
    pub uncached_eq: u64,
    pub saving_pct: i64,
    pub tiers: [Tier; 4],
    pub any_activity: bool,
}

pub fn economics(s: &Session, cache_is_1h: bool) -> Economics {
    let (read_m, write_m, new_m, out_m) = if s.is_gemini {
        (0.25_f64, 1.0, 1.0, 4.0)
    } else {
        (0.1_f64, if cache_is_1h { 2.0 } else { 1.25 }, 1.0, 5.0)
    };

    let read_eq  = s.cur_cread  as f64 * read_m;
    let write_eq = s.cur_cwrite as f64 * write_m;
    let new_eq   = s.cur_input  as f64 * new_m;
    let out_eq   = s.cur_output as f64 * out_m;

    // Match bash awk `printf "%d"` (truncation toward zero).
    let eq = (read_eq + write_eq + new_eq + out_eq) as u64;
    let uncached_eq =
        ((s.cur_cread + s.cur_cwrite + s.cur_input) as f64 * new_m + out_eq) as u64;

    let saving_pct = if uncached_eq > 0 {
        (100.0 * (uncached_eq as f64 - eq as f64) / uncached_eq as f64) as i64
    } else { 0 };

    // Thermometer order: cheap -> dear (read, new, write, output).
    let tiers = [
        Tier { role: Role::Read,   tokens: s.cur_cread,  eq_contrib: read_eq },
        Tier { role: Role::New,    tokens: s.cur_input,  eq_contrib: new_eq },
        Tier { role: Role::Write,  tokens: s.cur_cwrite, eq_contrib: write_eq },
        Tier { role: Role::Output, tokens: s.cur_output, eq_contrib: out_eq },
    ];

    let any_activity =
        s.cur_cread > 0 || s.cur_cwrite > 0 || s.cur_input > 0 || s.cur_output > 0;

    Economics { eq, uncached_eq, saving_pct, tiers, any_activity }
}
```

Add to `lib.rs`: `pub mod economics;`. (The test references `fmt::Role as u8`; add `#[derive(Clone, Copy)]` already present — also derive nothing extra; `as u8` works on the fieldless enum. Ensure `Role` has no explicit discriminants so ordering is stable.)

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test economics`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add rust/src/economics.rs rust/src/lib.rs
git commit -m "feat(rust): per-turn economics (eq, saving) at bash logic parity"
```

---

### Task 5: `ratelimits` — pct, ETA, pace heuristic, bar

**Files:**
- Create: `rust/src/ratelimits.rs`
- Modify: `rust/src/lib.rs` (`pub mod ratelimits;`)
- Test: `rust/src/ratelimits.rs` inline

**Interfaces:**
- Consumes: `input::RlRaw`, `now: i64`, `epoch::iso8601_to_epoch`.
- Produces:
  - `enum Pace { None, Fast, VeryFast }`
  - `struct RlWindow { pct: i64, eta_secs: i64, pace: Pace }`
  - `fn rl_window(raw: &RlRaw, window_secs: i64, now: i64) -> Option<RlWindow>` (None when pct absent)
  - `fn rl_bar(pct: i64, width: usize) -> (usize /*filled*/, usize /*empty*/)`
  - `fn rl_role(pct: i64) -> (fmt::Role, bool /*blink*/)` (green<25 / yellow<50 / orange<75 / red<90 / blink-red≥90)

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::RlRaw;

    fn raw(pct: f64, reset: &str) -> RlRaw {
        RlRaw { used_percentage: Some(pct), resets_at: Some(reset.into()) }
    }

    #[test]
    fn pct_and_eta() {
        let now = 1_783_000_000;
        // reset 3600s in the future
        let w = rl_window(&raw(12.0, "x"), 18000, now).unwrap();
        assert_eq!(w.pct, 12);
        assert_eq!(w.eta_secs, 0); // "x" is unparseable -> eta 0
    }

    #[test]
    fn pace_flags_fast_burn() {
        // window 18000s, 50% used, elapsed 3600s (10% of window)
        // pace = (50 * 18000) / (3600 * 100) = 2.5 -> VeryFast
        let now = 1_000_000;
        let reset = crate::epoch_str(now + 14_400); // 4h left => 4h elapsed of 5h
        let w = rl_window(&raw(50.0, &reset), 18000, now).unwrap();
        assert!(matches!(w.pace, Pace::VeryFast));
    }

    #[test]
    fn bar_geometry() {
        assert_eq!(rl_bar(0, 10), (0, 10));
        assert_eq!(rl_bar(50, 10), (5, 5));
        assert_eq!(rl_bar(100, 10), (10, 0));
        assert_eq!(rl_bar(250, 10), (10, 0)); // clamped
    }

    #[test]
    fn color_thresholds() {
        assert!(matches!(rl_role(10).0, fmt::Role::Good));
        assert!(matches!(rl_role(30).0, fmt::Role::Warn));
        assert!(matches!(rl_role(60).0, fmt::Role::Caution));
        assert!(matches!(rl_role(80).0, fmt::Role::Critical));
        assert_eq!(rl_role(95).1, true); // blink
    }
}
```

Add a tiny test helper to `lib.rs` (test-only): re-export a formatter so the pace test can build a reset string:
```rust
#[cfg(test)]
pub fn epoch_str(_e: i64) -> String { "unused".into() }
```
> NOTE: the pace test builds `reset` from an epoch but `rl_window` parses ISO. To keep the test hermetic, change the pace test to pass `eta` directly. Rewrite `pace_flags_fast_burn` to call the internal `pace_of(pct_int, eta_secs, window_secs)` helper (see Step 3) instead of `rl_window`. Replace the test body with:
```rust
    #[test]
    fn pace_flags_fast_burn() {
        // 50% used, 14400s to reset in an 18000s window => elapsed 3600s
        assert!(matches!(pace_of(50, 14_400, 18_000), Pace::VeryFast));
        assert!(matches!(pace_of(30, 15_000, 18_000), Pace::Fast));   // pace ~1.28
        assert!(matches!(pace_of(10, 1_000, 18_000), Pace::None));    // under 20% -> none
    }
```
and delete the `epoch_str` helper.

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo test ratelimits`
Expected: FAIL — not defined.

- [ ] **Step 3: Write `rust/src/ratelimits.rs`**

```rust
use crate::fmt::Role;
use crate::input::RlRaw;
use crate::epoch::iso8601_to_epoch;

#[derive(Debug)]
pub enum Pace { None, Fast, VeryFast }

pub struct RlWindow { pub pct: i64, pub eta_secs: i64, pub pace: Pace }

/// tokenline.sh:345-363 pace heuristic, extracted for testability.
pub fn pace_of(pct_int: i64, eta_secs: i64, window_secs: i64) -> Pace {
    if pct_int < 20 || eta_secs <= 0 || window_secs <= 0 { return Pace::None; }
    let mut elapsed = window_secs - eta_secs;
    if elapsed < 0 { elapsed = 0; }
    if elapsed < window_secs / 10 { return Pace::None; } // need >=10% elapsed
    let pace = (pct_int as f64 * window_secs as f64) / (elapsed as f64 * 100.0);
    if pace >= 1.5 { Pace::VeryFast } else if pace >= 1.25 { Pace::Fast } else { Pace::None }
}

pub fn rl_window(raw: &RlRaw, window_secs: i64, now: i64) -> Option<RlWindow> {
    let pct = raw.used_percentage?; // None => no segment
    let pct_int = pct.round() as i64;
    let eta_secs = raw.resets_at.as_deref()
        .and_then(iso8601_to_epoch)
        .map(|r| (r - now).max(0))
        .unwrap_or(0);
    Some(RlWindow { pct: pct_int, eta_secs, pace: pace_of(pct_int, eta_secs, window_secs) })
}

pub fn rl_bar(pct: i64, width: usize) -> (usize, usize) {
    let mut filled = (pct.max(0) as usize * width) / 100;
    if filled > width { filled = width; }
    (filled, width - filled)
}

pub fn rl_role(pct: i64) -> (Role, bool) {
    if pct >= 90 { (Role::Critical, true) }
    else if pct >= 75 { (Role::Critical, false) }
    else if pct >= 50 { (Role::Caution, false) }
    else if pct >= 25 { (Role::Warn, false) }
    else { (Role::Good, false) }
}
```

Add to `lib.rs`: `pub mod ratelimits;`

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test ratelimits`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/src/ratelimits.rs rust/src/lib.rs
git commit -m "feat(rust): rate-limit pct/eta/pace/bar at bash logic parity"
```

---

### Task 6: `cache` — cross-platform runtime dir + consolidated per-session file

**Files:**
- Create: `rust/src/cache.rs`
- Modify: `rust/src/lib.rs` (`pub mod cache;`)
- Test: `rust/src/cache.rs` inline (uses `std::env::temp_dir` + a unique subdir; no external tempdir crate)

**Interfaces:**
- Produces:
  - `fn runtime_dir() -> std::path::PathBuf` — Unix `$XDG_RUNTIME_DIR/tokenline-$UID` (fallback `/tmp/tokenline-$UID`), Windows `%LOCALAPPDATA%\tokenline` (fallback `env::temp_dir()/tokenline`). Creates it; `0700` on Unix.
  - `struct CacheState { last_ts: Option<i64>, ttl: i64, ttl_label: String, last_tokens: u64 }`
  - `fn load(dir: &Path, session_id: &str) -> CacheState` (missing/corrupt file → defaults, never errors)
  - `fn store(dir: &Path, session_id: &str, st: &CacheState)` (best-effort; ignores I/O errors)

Consolidated file format (one line, space-separated, replaces the bash 3-file scheme):
`<last_ts> <ttl> <ttl_label> <last_tokens>` e.g. `1783274400 3600 1h 88802`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        let mut d = std::env::temp_dir();
        // unique-ish without rand/time crates: process id
        d.push(format!("tokenline-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn roundtrip() {
        let dir = scratch();
        let st = CacheState { last_ts: Some(1_783_274_400), ttl: 3600,
            ttl_label: "1h".into(), last_tokens: 88_802 };
        store(&dir, "sess1", &st);
        let got = load(&dir, "sess1");
        assert_eq!(got.last_ts, Some(1_783_274_400));
        assert_eq!(got.ttl, 3600);
        assert_eq!(got.ttl_label, "1h");
        assert_eq!(got.last_tokens, 88_802);
    }

    #[test]
    fn missing_file_defaults() {
        let dir = scratch();
        let got = load(&dir, "does-not-exist");
        assert_eq!(got.last_ts, None);
        assert_eq!(got.ttl_label, "5m"); // default window
    }

    #[test]
    fn runtime_dir_exists() {
        let d = runtime_dir();
        assert!(d.exists());
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo test cache`
Expected: FAIL — not defined.

- [ ] **Step 3: Write `rust/src/cache.rs`**

```rust
use std::path::{Path, PathBuf};

pub struct CacheState {
    pub last_ts: Option<i64>,
    pub ttl: i64,
    pub ttl_label: String,
    pub last_tokens: u64,
}

impl Default for CacheState {
    fn default() -> Self {
        CacheState { last_ts: None, ttl: 300, ttl_label: "5m".into(), last_tokens: 0 }
    }
}

pub fn runtime_dir() -> PathBuf {
    let base = platform_base();
    let _ = std::fs::create_dir_all(&base);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700));
    }
    if base.is_dir() { base } else { std::env::temp_dir() }
}

#[cfg(unix)]
fn platform_base() -> PathBuf {
    let uid = std::env::var("UID").unwrap_or_default(); // often unset; fall through below
    let uid = if uid.is_empty() { unix_uid() } else { uid };
    let root = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(root).join(format!("tokenline-{}", uid))
}

#[cfg(unix)]
fn unix_uid() -> String {
    // SAFETY: getuid() is always safe and never fails.
    (unsafe { libc_getuid() }).to_string()
}
#[cfg(unix)]
extern "C" { #[link_name = "getuid"] fn libc_getuid() -> u32; }

#[cfg(windows)]
fn platform_base() -> PathBuf {
    let root = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    root.join("tokenline")
}

fn file_for(dir: &Path, session_id: &str) -> PathBuf {
    let id = if session_id.is_empty() { "default" } else { session_id };
    dir.join(format!("session-{}", id))
}

pub fn load(dir: &Path, session_id: &str) -> CacheState {
    let mut st = CacheState::default();
    let Ok(raw) = std::fs::read_to_string(file_for(dir, session_id)) else { return st; };
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.len() >= 4 {
        st.last_ts = parts[0].parse::<i64>().ok();
        if let Ok(t) = parts[1].parse::<i64>() { st.ttl = t; }
        st.ttl_label = parts[2].to_string();
        if let Ok(tk) = parts[3].parse::<u64>() { st.last_tokens = tk; }
    }
    st
}

pub fn store(dir: &Path, session_id: &str, st: &CacheState) {
    let line = format!("{} {} {} {}",
        st.last_ts.unwrap_or(0), st.ttl, st.ttl_label, st.last_tokens);
    let _ = std::fs::write(file_for(dir, session_id), line); // best-effort
}
```

> **Dependency note:** the `extern "C" { getuid }` avoids a `libc` crate dependency and links against the system libc that `std` already links. Confirm the compat matrix build still links; if any target objects, replace `unix_uid()` with reading `/proc/self/loginuid` is NOT portable — instead fall back to `std::env::var("USER")` hashed, but prefer the `getuid` extern which is the smallest correct option.

Add to `lib.rs`: `pub mod cache;`

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test cache`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add rust/src/cache.rs rust/src/lib.rs
git commit -m "feat(rust): cross-platform runtime dir + consolidated session cache"
```

---

### Task 7: `cachetimer` — TTL window + transcript last-turn + remaining state

**Files:**
- Create: `rust/src/cachetimer.rs`
- Modify: `rust/src/lib.rs` (`pub mod cachetimer;`)
- Test: `rust/src/cachetimer.rs` inline (temp dir + temp transcript file + injected `now`)

**Interfaces:**
- Consumes: `Session`, `now`, cache dir, `cache::{load,store}`, `epoch`.
- Produces:
  - `enum Warmth { Warm, Cooling, Cold }`
  - `struct CacheInfo { ttl_label: String, remaining_secs: i64, warmth: Warmth, is_1h: bool }`
  - `fn cache_info(s: &Session, now: i64, dir: &Path) -> CacheInfo` — the full stateful pipeline (turn detection + transcript read + fallbacks + TTL determination + persist).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{RawInput, Session};

    fn scratch() -> std::path::PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("tl-ct-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn sess(json: &str) -> Session { Session::from_raw(serde_json::from_str(json).unwrap()) }

    #[test]
    fn fresh_session_starts_warm_at_full_ttl() {
        let dir = scratch();
        // no transcript, no cache => last_ts defaults to now => remaining == ttl
        let s = sess(r#"{"session_id":"warm1","context_window":{"current_usage":
            {"cache_read_input_tokens":100}}}"#);
        let now = 1_783_000_000;
        let ci = cache_info(&s, now, &dir);
        assert_eq!(ci.ttl_label, "5m");           // no ephemeral fields => default 5m
        assert!(ci.remaining_secs > 290 && ci.remaining_secs <= 300);
        assert!(matches!(ci.warmth, Warmth::Warm));
    }

    #[test]
    fn transcript_1h_window_and_countdown() {
        let dir = scratch();
        // transcript whose last assistant turn is 100s ago and has ephemeral_1h > 0
        let tp = dir.join("t1.jsonl");
        std::fs::write(&tp, format!(
            "{}\n",
            r#"{"type":"assistant","timestamp":"2026-07-05T00:00:00Z",
                "message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":10,
                "ephemeral_5m_input_tokens":0}}}}"#
        )).unwrap();
        let turn_epoch = crate::epoch::iso8601_to_epoch("2026-07-05T00:00:00Z").unwrap();
        let now = turn_epoch + 100; // 100s after the turn
        let s = sess(&format!(r#"{{"session_id":"h1","transcript_path":"{}",
            "context_window":{{"current_usage":{{"cache_read_input_tokens":100}}}}}}"#,
            tp.display()));
        let ci = cache_info(&s, now, &dir);
        assert_eq!(ci.ttl_label, "1h");
        assert!(ci.is_1h);
        assert!((ci.remaining_secs - 3500).abs() <= 2); // 3600 - 100
        assert!(matches!(ci.warmth, Warmth::Warm));
    }

    #[test]
    fn expired_is_cold() {
        let dir = scratch();
        let s = sess(r#"{"session_id":"cold1","context_window":{"current_usage":
            {"cache_read_input_tokens":100}}}"#);
        // Prime the cache with an old timestamp + 5m ttl
        crate::cache::store(&dir, "cold1", &crate::cache::CacheState{
            last_ts: Some(1_000_000), ttl: 300, ttl_label: "5m".into(), last_tokens: 100 });
        let now = 1_000_000 + 400; // 400s later, ttl 300 => expired
        let ci = cache_info(&s, now, &dir);
        assert!(ci.remaining_secs <= 0);
        assert!(matches!(ci.warmth, Warmth::Cold));
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo test cachetimer`
Expected: FAIL — not defined.

- [ ] **Step 3: Write `rust/src/cachetimer.rs`**

```rust
use std::path::Path;
use crate::cache::{self, CacheState};
use crate::epoch::iso8601_to_epoch;
use crate::input::Session;

#[derive(Debug)]
pub enum Warmth { Warm, Cooling, Cold }

pub struct CacheInfo {
    pub ttl_label: String,
    pub remaining_secs: i64,
    pub warmth: Warmth,
    pub is_1h: bool,
}

/// Read the last assistant/PLANNER turn's (timestamp, ephemeral_5m, ephemeral_1h)
/// from the tail of the transcript. Returns (last_ts, e5m, e1h).
fn scan_transcript(path: &str) -> (Option<i64>, u64, u64) {
    let Ok(content) = std::fs::read_to_string(path) else { return (None, 0, 0); };
    // Tail ~200 lines (tokenline.sh:199). Scan from the end for the last match.
    for line in content.lines().rev().take(200) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue; };
        let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if t != "assistant" && t != "PLANNER_RESPONSE" { continue; }
        let iso = v.get("timestamp").and_then(|x| x.as_str())
            .or_else(|| v.get("created_at").and_then(|x| x.as_str()));
        let cc = v.pointer("/message/usage/cache_creation");
        let e5m = cc.and_then(|c| c.get("ephemeral_5m_input_tokens")).and_then(|x| x.as_u64()).unwrap_or(0);
        let e1h = cc.and_then(|c| c.get("ephemeral_1h_input_tokens")).and_then(|x| x.as_u64()).unwrap_or(0);
        return (iso.and_then(iso8601_to_epoch), e5m, e1h);
    }
    (None, 0, 0)
}

fn file_mtime(path: &str) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let mt = meta.modified().ok()?;
    let secs = mt.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    Some(secs as i64)
}

pub fn cache_info(s: &Session, now: i64, dir: &Path) -> CacheInfo {
    let mut state = cache::load(dir, &s.session_id);

    // Turn detection: token count changed => stamp `now` (tokenline.sh:182-188)
    if s.tokens_used != state.last_tokens {
        state.last_ts = Some(now);
        state.last_tokens = s.tokens_used;
    }

    // Transcript last-turn timestamp + ephemeral flags (tokenline.sh:195-214)
    let (mut last_ts, e5m, e1h) = if !s.transcript_path.is_empty() {
        let (ts, a, b) = scan_transcript(&s.transcript_path);
        let ts = ts.or_else(|| file_mtime(&s.transcript_path)); // mtime fallback
        (ts, a, b)
    } else { (None, 0, 0) };

    // Prefer cached ts if newer or transcript ts missing (tokenline.sh:216-223)
    if let Some(cached) = state.last_ts {
        if last_ts.map_or(true, |t| cached > t) { last_ts = Some(cached); }
    }
    // Always have a timestamp (tokenline.sh:225-229)
    let last_ts = last_ts.unwrap_or(now);
    state.last_ts = Some(last_ts);

    // TTL window determination (tokenline.sh:231-250)
    let (ttl, ttl_label) = if s.is_gemini {
        (300, "5m")
    } else if e1h > 0 {
        (3600, "1h")
    } else if e5m > 0 {
        (300, "5m")
    } else {
        // fall back to previously-determined session ttl
        (state.ttl, if state.ttl == 3600 { "1h" } else { "5m" })
    };
    state.ttl = ttl;
    state.ttl_label = ttl_label.to_string();
    cache::store(dir, &s.session_id, &state);

    let elapsed = now - last_ts;
    let remaining = ttl - elapsed;
    // pct10 == remaining*10/ttl (tokenline.sh:260)
    let pct10 = if ttl > 0 { remaining * 10 / ttl } else { 0 };
    let warmth = if remaining <= 0 { Warmth::Cold }
        else if pct10 < 2 { Warmth::Cooling }   // < 20% left
        else { Warmth::Warm };

    CacheInfo { ttl_label: ttl_label.to_string(), remaining_secs: remaining, warmth, is_1h: ttl == 3600 }
}
```

Add to `lib.rs`: `pub mod cachetimer;`

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo test cachetimer`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add rust/src/cachetimer.rs rust/src/lib.rs
git commit -m "feat(rust): cache TTL/countdown timer with transcript read"
```

---

### Task 8: `render` — PULSE+ (Normal density) + golden fixtures

**Files:**
- Create: `rust/src/render.rs`, `rust/tests/golden.rs`, `rust/tests/fixtures/*.json`, `rust/tests/fixtures/*.txt`
- Modify: `rust/src/lib.rs` (add `pub mod render;` + `pub fn render(...)`)
- Test: `rust/tests/golden.rs`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `enum Density { Compact, Normal, Verbose }`
  - `pub fn render(input: &input::RawInput, now: i64, cache_dir: &Path, density: Density) -> String` — v1 always renders `Normal` (PULSE+). Reads all state; returns the full multi-line string (with trailing `\n` per line, no trailing blank).
  - Helper `fn strip_ansi(s: &str) -> String` in the test for stable golden comparison.

- [ ] **Step 1: Write the failing golden test**

`rust/tests/golden.rs`:
```rust
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
    let out = render(&raw, now, &cache_scratch(), Density::Normal);
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
    let out = strip_ansi(&render(&raw, 1_783_000_000, &cache_scratch(), Density::Normal));
    assert!(!out.contains("5h"), "Gemini has no rate limits");
    assert!(!out.contains("7d"));
}

#[test]
fn no_activity_hides_cost_line() {
    let raw: RawInput = serde_json::from_str(
        r#"{"model":{"display_name":"Opus 4.8"},
            "context_window":{"used_percentage":1.0}}"#).unwrap();
    let out = strip_ansi(&render(&raw, 1_783_000_000, &cache_scratch(), Density::Normal));
    assert!(!out.contains("cost "), "no turn => no cost line");
}
```

- [ ] **Step 2: Create the input fixture (no expected output yet)**

`rust/tests/fixtures/healthy_claude.json`:
```json
{
  "model": {"display_name": "Opus 4.8"},
  "context_window": {
    "used_percentage": 9.0, "context_window_size": 1000000,
    "current_usage": {"input_tokens": 2, "output_tokens": 2000,
      "cache_creation_input_tokens": 2200, "cache_read_input_tokens": 86600}
  },
  "transcript_path": "", "session_id": "golden-healthy",
  "rate_limits": {
    "five_hour": {"used_percentage": 12.0, "resets_at": "2026-07-05T18:00:00Z"},
    "seven_day": {"used_percentage": 64.0, "resets_at": "2026-07-06T12:00:00Z"}
  }
}
```
Create an empty `rust/tests/fixtures/healthy_claude.txt` for now.

- [ ] **Step 3: Run to verify fail**

Run: `cd rust && cargo test --test golden`
Expected: FAIL — `render`/`Density` not defined (and the golden mismatch).

- [ ] **Step 4: Write `rust/src/render.rs`**

```rust
use std::path::Path;
use crate::input::{RawInput, Session, Client};
use crate::fmt::{Role, fmt_k, fmt_eta};
use crate::economics::economics;
use crate::ratelimits::{rl_window, rl_bar, rl_role, Pace, RlWindow};
use crate::cachetimer::{cache_info, Warmth};

#[derive(Clone, Copy)]
pub enum Density { Compact, Normal, Verbose }

struct Buf(String);
impl Buf {
    fn new() -> Self { Buf(String::new()) }
    fn seg(&mut self, role: Role, text: &str, bold: bool, blink: bool) {
        self.0.push_str(&role.paint(text, bold, blink));
    }
    fn raw(&mut self, s: &str) { self.0.push_str(s); }
    fn take(self) -> String { self.0 }
}

/// Public entry. v1: always renders Normal (PULSE+); other densities fall back.
pub fn render(input: &RawInput, now: i64, cache_dir: &Path, _density: Density) -> String {
    // RawInput is not Clone; rebuild Session from a fresh parse is avoided by
    // moving fields — but render borrows, so clone the small owned bits we need.
    let s = Session::from_raw(clone_raw(input));
    render_normal(&s, now, cache_dir)
}

fn render_normal(s: &Session, now: i64, cache_dir: &Path) -> String {
    let ci = cache_info(s, now, cache_dir);
    let eco = economics(s, ci.is_1h);
    let mut out = String::new();

    // ---- Line 1: model · ctx · cache -------------------------------------
    let mut l1 = Buf::new();
    // model (with Antigravity brand)
    if s.cli_client == Client::Antigravity {
        l1.seg(Role::Accent, "🌌 Antigravity", false, false);
        l1.seg(Role::Muted, &format!(" ({})", s.model), false, false);
    } else {
        l1.seg(Role::Muted, &s.model, false, false);
    }
    // ctx (sparkline + %)
    if let Some(pct) = s.used_pct {
        let pct = pct.round() as i64;
        let (role, bold) = ctx_role(pct);
        l1.seg(Role::Faint, "  ·  ", false, false);
        l1.seg(Role::Muted, "ctx ", false, false);
        l1.seg(role, &spark(pct), bold, false);
        l1.seg(role, &format!(" {}%", pct), bold, false);
    }
    // cache (heartbeat + countdown + drain bar + word)
    l1.seg(Role::Faint, "  ·  ", false, false);
    let (cache_role, blink, word) = warmth_style(&ci.warmth);
    l1.seg(cache_role, "♥ ", false, blink);
    l1.seg(Role::Muted, "cache ", false, false);
    l1.seg(cache_role, &clock(ci.remaining_secs), true, blink);
    l1.seg(cache_role, &format!(" {} ", drain_bar(ci.remaining_secs, ttl_of(&ci))), false, false);
    l1.seg(cache_role, word, blink, blink);
    out.push_str(&l1.take()); out.push('\n');

    // ---- Line 2: cost thermometer (only when a turn happened) ------------
    if eco.any_activity {
        let mut l2 = Buf::new();
        l2.seg(Role::Muted, "cost ", false, false);
        for (glyph, role) in thermometer(&eco) {
            l2.seg(role, &glyph, false, false);
        }
        l2.seg(Role::Accent, &format!("  {}", fmt_k(eco.eq)), true, false);
        l2.seg(Role::Faint, &format!(" / {} full", fmt_k(eco.uncached_eq)), false, false);
        l2.seg(Role::Faint, " · ", false, false);
        let save_role = save_role(eco.saving_pct);
        l2.seg(save_role, &format!("↓{}% saved", eco.saving_pct), true, false);
        out.push_str(&l2.take()); out.push('\n');
    }

    // ---- Line 3: rate limits (Anthropic only) ----------------------------
    if !s.is_gemini {
        let w5 = s.rl_5h.as_ref().and_then(|r| rl_window(r, 18_000, now));
        let w7 = s.rl_7d.as_ref().and_then(|r| rl_window(r, 604_800, now));
        if w5.is_some() || w7.is_some() {
            let mut l3 = Buf::new();
            if let Some(w) = &w5 { rl_segment(&mut l3, "5h", w); }
            if let Some(w) = &w7 {
                if w5.is_some() { l3.seg(Role::Faint, "   ", false, false); }
                rl_segment(&mut l3, "7d", w);
            }
            out.push_str(&l3.take()); out.push('\n');
        }
    }

    out
}

fn rl_segment(b: &mut Buf, label: &str, w: &RlWindow) {
    let (role, blink) = rl_role(w.pct);
    let marker = if matches!(w.pace, Pace::VeryFast) || w.pct >= 75 { "▲ " } else { "▸ " };
    b.seg(role, marker, false, blink);
    b.seg(role, &format!("{} ", label), false, false);
    let (filled, empty) = rl_bar(w.pct, 10);
    b.seg(role, &"█".repeat(filled), false, false);
    b.seg(Role::Faint, &"░".repeat(empty), false, false);
    b.seg(role, &format!(" {}% ", w.pct), false, blink);
    match w.pace {
        Pace::VeryFast => b.seg(role, &format!("⚡ pace · empties {} ", fmt_eta(w.eta_secs)), false, false),
        Pace::Fast => b.seg(role, "⚡ pace ", false, false),
        Pace::None => {}
    }
    if w.eta_secs > 0 {
        b.seg(Role::Faint, &format!("· {} left", fmt_eta(w.eta_secs)), false, false);
    }
}

// ---- small helpers ------------------------------------------------------
fn ctx_role(pct: i64) -> (Role, bool) {
    if pct >= 80 { (Role::Critical, true) }
    else if pct >= 50 { (Role::Warn, false) }
    else { (Role::Good, false) }
}
fn spark(pct: i64) -> String {
    // 2-cell rising meter: ▁▂▃▄▅▆▇█ picked by 8ths.
    let blocks = ['▁','▂','▃','▄','▅','▆','▇','█'];
    let idx = ((pct.clamp(0, 100) * 8) / 100).clamp(0, 7) as usize;
    format!("{}{}", blocks[idx], blocks[idx.min(7)])
}
fn warmth_style(w: &Warmth) -> (Role, bool, &'static str) {
    match w {
        Warmth::Warm => (Role::Cache, false, "warm"),
        Warmth::Cooling => (Role::Warn, false, "cooling"),
        Warmth::Cold => (Role::Critical, true, "COLD"),
    }
}
fn clock(remaining: i64) -> String {
    let r = remaining.max(0);
    format!("{}:{:02}", r / 60, r % 60)
}
fn ttl_of(ci: &crate::cachetimer::CacheInfo) -> i64 { if ci.is_1h { 3600 } else { 300 } }
fn drain_bar(remaining: i64, ttl: i64) -> String {
    let filled = if ttl > 0 { (remaining.max(0) * 10 / ttl).clamp(0, 10) as usize } else { 0 };
    format!("{}{}", "█".repeat(filled), "░".repeat(10 - filled))
}
fn save_role(pct: i64) -> Role {
    if pct >= 70 { Role::Good } else if pct >= 50 { Role::Warn } else { Role::Caution }
}
/// Stacked cost thermometer: widths ∝ eq-contribution over ~11 cells, order read·new·write·output.
fn thermometer(eco: &crate::economics::Economics) -> Vec<(String, Role)> {
    let total: f64 = eco.tiers.iter().map(|t| t.eq_contrib).sum::<f64>().max(1.0);
    let cells = 11.0;
    eco.tiers.iter().map(|t| {
        let n = (t.eq_contrib / total * cells).round() as usize;
        let glyph = if n == 0 && t.eq_contrib > 0.0 { "·".to_string() } else { "▉".repeat(n) };
        (glyph, t.role)
    }).collect()
}

fn clone_raw(r: &RawInput) -> RawInput {
    // RawInput derives Deserialize+Default; add Clone via serde round-trip to avoid
    // threading ownership. Cheap: the payload is tiny.
    serde_json::from_str(&serde_json::to_string(r).unwrap_or_default()).unwrap_or_default()
}
```

> Add `#[derive(Serialize)]` to the `RawInput` structs in `input.rs` (and `use serde::Serialize;`) so `clone_raw` round-trips — OR simpler: change `render`'s signature to take `Session` and move the `Session::from_raw` call into `main`/`lib`. **Chosen: change the signature.** In `render.rs` make `pub fn render(input: RawInput, ...)` consume by value and call `Session::from_raw(input)` directly; delete `clone_raw`. Update `lib.rs` re-export and `golden.rs`/`main.rs` call sites to pass ownership. (This keeps `input.rs` free of `Serialize`.)

Update `rust/src/lib.rs`:
```rust
pub mod input;
pub mod fmt;
pub mod epoch;
pub mod economics;
pub mod ratelimits;
pub mod cache;
pub mod cachetimer;
pub mod render;

pub use render::{render, Density};
```
Adjust `render` to consume `RawInput` by value:
```rust
pub fn render(input: RawInput, now: i64, cache_dir: &Path, _density: Density) -> String {
    let s = Session::from_raw(input);
    render_normal(&s, now, cache_dir)
}
```
Update `golden.rs` calls to `render(raw, ...)` (pass by value).

- [ ] **Step 5: Generate + eyeball the golden output, then freeze it**

Run: `cd rust && cargo test --test golden 2>&1 | sed -n '/--- got ---/,/--- want ---/p'`
Copy the `got` block, **eyeball it against the PULSE+ mockup** (`scratchpad/tokenline-redesign.html`), and if correct write it verbatim to `rust/tests/fixtures/healthy_claude.txt`.
Expected first line (ANSI-stripped), for reference:
```
Opus 4.8  ·  ctx ▁▁ 9%  ·  ♥ cache 0:00 ██████████ warm
```
> NOTE: with `transcript_path:""` and a fresh cache, `remaining == ttl == 300` → clock shows `5:00` and a full drain bar. Confirm the frozen `.txt` reflects the deterministic `now`/empty-cache path, not the mockup's `59:16` (which assumed a 1h transcript). The mockup is the *visual language* reference; the fixture is the *exact deterministic bytes*.

- [ ] **Step 6: Run to verify pass**

Run: `cd rust && cargo test --test golden`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add rust/src/render.rs rust/src/lib.rs rust/tests/golden.rs rust/tests/fixtures/
git commit -m "feat(rust): PULSE+ render (Normal density) + golden fixtures"
```

---

### Task 9: `main` never-crash hardening + end-to-end

**Files:**
- Modify: `rust/src/main.rs`
- Test: `rust/tests/never_crash.rs`

**Interfaces:**
- Consumes: `tokenline::{render, Density}`, `cache::runtime_dir`.
- Produces: a `main()` that reads stdin, computes `now`, resolves the cache dir, renders under `catch_unwind`, prints, and **always `exit(0)`** with empty output on any failure.

- [ ] **Step 1: Write the failing test**

`rust/tests/never_crash.rs`:
```rust
use std::io::Write;
use std::process::{Command, Stdio};

fn run(stdin: &str) -> (i32, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tokenline"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().unwrap();
    child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned())
}

#[test]
fn malformed_json_exits_zero_silently() {
    let (code, out) = run("this is not json");
    assert_eq!(code, 0);
    assert!(out.trim().is_empty());
}

#[test]
fn empty_stdin_exits_zero() {
    let (code, out) = run("");
    assert_eq!(code, 0);
    assert!(out.trim().is_empty());
}

#[test]
fn valid_input_renders_and_exits_zero() {
    let (code, out) = run(r#"{"model":{"display_name":"Opus 4.8"},
        "context_window":{"used_percentage":9.0}}"#);
    assert_eq!(code, 0);
    assert!(out.contains("Opus 4.8"));
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo test --test never_crash`
Expected: FAIL — current `main` prints only the model name / no render; the render assertion and silence-on-garbage need the hardened main.

- [ ] **Step 3: Write the hardened `rust/src/main.rs`**

```rust
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
```

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo build && cargo test --test never_crash`
Expected: PASS (3 tests).
Run the full suite: `cd rust && cargo test`
Expected: all green.

- [ ] **Step 5: End-to-end smoke against the real sample**

Run:
```bash
cd rust && cargo build --release
cat tests/fixtures/healthy_claude.json | ./target/release/tokenline | cat -v | head
```
Expected: the PULSE+ statusline with visible `\033[38;2;...` truecolor escapes (via `cat -v`), model `Opus 4.8`, a `cost ` line, and a `5h`/`7d` line.

- [ ] **Step 6: Commit**

```bash
git add rust/src/main.rs rust/tests/never_crash.rs
git commit -m "feat(rust): never-crash main (catch_unwind, silent exit 0)"
```

---

## Self-Review

**1. Spec coverage.** Locked decisions (see memory `rust-rewrite-plan`, `tokenline-ui-redesign`):
- Rust crate under `rust/`, single binary → Task 1. ✅
- `serde_json` + std only, hand-rolled ISO → Tasks 1, 3. ✅
- Logic parity (eq/saving/ctx/ttl/rl) → Tasks 4, 5, 7 (oracle values from bash formulas). ✅
- Consolidated single cache file, cross-platform dir, `#[cfg(unix)]` chmod → Task 6. ✅
- Pure-function core `render(input, now, cache_dir, density)` + golden fixtures → Task 8. ✅
- Never-crash (`Result`/`catch_unwind`/exit 0/silent) → Task 9. ✅
- PULSE+ default; `density` arg present, only `Normal` implemented → Task 8. ✅
- Windows-ready code (paths behind `#[cfg]`, no unix assumptions leaking) → Task 6 (verified in CI in Plan 2). ✅
- **Deferred to Plan 2 (distribution):** cargo-dist, CI matrix, Windows *execution* test, musl targets. **Deferred to Plan 3:** npm binary delivery. Not in this plan by design.

**2. Placeholder scan.** No "TODO/handle edge cases/similar to Task N". Two design forks are resolved inline (the `render` signature note in Task 8 chooses "consume `RawInput` by value"; the `getuid` extern in Task 6 states the chosen approach + fallback). Resolve them as written.

**3. Type consistency.** `Session` fields (Task 1) are consumed with the same names in Tasks 4/5/7. `economics()` returns `Economics{eq,uncached_eq,saving_pct,tiers,any_activity}` used verbatim in Task 8. `cache_info()` returns `CacheInfo{ttl_label,remaining_secs,warmth,is_1h}` used in Task 8. `render(raw: RawInput, now, dir, Density)` signature is identical across Task 8, `lib.rs`, `golden.rs`, and `main.rs`. `rl_window`/`rl_bar`/`rl_role`/`pace_of` signatures match between Task 5 and Task 8. ✅

**Known follow-ups (not defects):** the golden `.txt` is frozen from the deterministic empty-transcript path (Task 8, Step 5) — when Plan 2 adds real-transcript fixtures, freeze those under a fixed `now` too. The cost-thermometer "learn teal=cheap" onboarding gap is a product decision tracked in `tokenline-ui-redesign`, addressed by `--verbose` (a later density mode), not this plan.
