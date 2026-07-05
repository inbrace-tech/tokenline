use crate::cache;
use crate::epoch::iso8601_to_epoch;
use crate::input::Session;
use std::path::Path;

#[derive(Debug)]
pub enum Warmth {
    Warm,
    Cooling,
    Cold,
}

pub struct CacheInfo {
    pub ttl_label: String,
    pub remaining_secs: i64,
    pub warmth: Warmth,
    pub is_1h: bool,
}

/// Read the last assistant/PLANNER turn's (timestamp, ephemeral_5m, ephemeral_1h)
/// from the tail of the transcript. Returns (last_ts, e5m, e1h).
fn scan_transcript(path: &str) -> (Option<i64>, u64, u64) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return (None, 0, 0);
    };
    // Tail ~200 lines (tokenline.sh:199). Scan from the end for the last match.
    for line in content.lines().rev().take(200) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let t = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if t != "assistant" && t != "PLANNER_RESPONSE" {
            continue;
        }
        let iso = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .or_else(|| v.get("created_at").and_then(|x| x.as_str()));
        let cc = v.pointer("/message/usage/cache_creation");
        let e5m = cc
            .and_then(|c| c.get("ephemeral_5m_input_tokens"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        let e1h = cc
            .and_then(|c| c.get("ephemeral_1h_input_tokens"))
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
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
    } else {
        (None, 0, 0)
    };

    // Prefer cached ts if newer or transcript ts missing (tokenline.sh:216-223)
    if let Some(cached) = state.last_ts {
        if last_ts.is_none_or(|t| cached > t) {
            last_ts = Some(cached);
        }
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
    let warmth = if remaining <= 0 {
        Warmth::Cold
    } else if pct10 < 2 {
        Warmth::Cooling
    }
    // < 20% left
    else {
        Warmth::Warm
    };

    CacheInfo {
        ttl_label: ttl_label.to_string(),
        remaining_secs: remaining,
        warmth,
        is_1h: ttl == 3600,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::Session;

    fn scratch() -> std::path::PathBuf {
        let mut d = std::env::temp_dir();
        d.push(format!("tl-ct-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn sess(json: &str) -> Session {
        Session::from_raw(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn fresh_session_starts_warm_at_full_ttl() {
        let dir = scratch();
        // no transcript, no cache => last_ts defaults to now => remaining == ttl
        let s = sess(
            r#"{"session_id":"warm1","context_window":{"current_usage":
            {"cache_read_input_tokens":100}}}"#,
        );
        let now = 1_783_000_000;
        let ci = cache_info(&s, now, &dir);
        assert_eq!(ci.ttl_label, "5m"); // no ephemeral fields => default 5m
        assert!(ci.remaining_secs > 290 && ci.remaining_secs <= 300);
        assert!(matches!(ci.warmth, Warmth::Warm));
    }

    #[test]
    fn transcript_1h_window_and_countdown() {
        let dir = scratch();
        // transcript whose last assistant turn is 100s ago and has ephemeral_1h > 0
        let tp = dir.join("t1.jsonl");
        // Must be a single physical line: scan_transcript reads JSONL (one JSON object
        // per line), so a raw string spanning multiple source lines would embed real
        // newlines and split this into unparsable fragments.
        std::fs::write(&tp, format!(
            "{}\n",
            r#"{"type":"assistant","timestamp":"2026-07-05T00:00:00Z","message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":10,"ephemeral_5m_input_tokens":0}}}}"#
        )).unwrap();
        let turn_epoch = crate::epoch::iso8601_to_epoch("2026-07-05T00:00:00Z").unwrap();
        let now = turn_epoch + 100; // 100s after the turn
        let s = sess(&format!(
            r#"{{"session_id":"h1","transcript_path":"{}",
            "context_window":{{"current_usage":{{"cache_read_input_tokens":100}}}}}}"#,
            tp.display()
        ));
        // Prime last_tokens to match s.tokens_used so turn detection does NOT fire this
        // poll (tokenline.sh:185 fires on a *change*; a truly first-ever poll would stamp
        // `now` and clobber the transcript-derived ts, which is not what this test probes).
        // This models steady-state polling: no new turn since last render, so the last
        // real turn time must come from the transcript, not from "now".
        crate::cache::store(
            &dir,
            "h1",
            &crate::cache::CacheState {
                last_ts: None,
                ttl: 300,
                ttl_label: "5m".into(),
                last_tokens: 100,
            },
        );
        let ci = cache_info(&s, now, &dir);
        assert_eq!(ci.ttl_label, "1h");
        assert!(ci.is_1h);
        assert!((ci.remaining_secs - 3500).abs() <= 2); // 3600 - 100
        assert!(matches!(ci.warmth, Warmth::Warm));
    }

    #[test]
    fn expired_is_cold() {
        let dir = scratch();
        let s = sess(
            r#"{"session_id":"cold1","context_window":{"current_usage":
            {"cache_read_input_tokens":100}}}"#,
        );
        // Prime the cache with an old timestamp + 5m ttl
        crate::cache::store(
            &dir,
            "cold1",
            &crate::cache::CacheState {
                last_ts: Some(1_000_000),
                ttl: 300,
                ttl_label: "5m".into(),
                last_tokens: 100,
            },
        );
        let now = 1_000_000 + 400; // 400s later, ttl 300 => expired
        let ci = cache_info(&s, now, &dir);
        assert!(ci.remaining_secs <= 0);
        assert!(matches!(ci.warmth, Warmth::Cold));
    }
}
