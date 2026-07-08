use crate::fmt::iso8601_to_epoch;
use crate::input::{RlRaw, Session};

/// Pure compute for the rate-limit windows (tokenline.sh `rl_segment` /
/// `compute_rate_limits`, lines ~302-386). No color/ANSI here — that's
/// render.rs's job; this only exposes the severity bucket and pace flag as
/// enums for render.rs to map to color/blink.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pace {
    None,
    Fast,
    VeryFast,
}

/// Severity bucket by `pct_int`, matching bash's `rl_color_for_pct` tiers.
/// `>=90` is also blinking in bash — carried separately as `RateLimit::blink`
/// rather than a 5th variant, since render.rs needs that as an orthogonal bit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Good,     // <25
    Warn,     // >=25
    Caution,  // >=50
    Critical, // >=75 (blink additionally when pct >= 90)
}

pub struct RateLimit {
    pub label: &'static str,
    pub pct: i64,
    pub eta_secs: i64,
    pub bar_filled: usize,
    pub bar_empty: usize,
    pub severity: Severity,
    pub blink: bool,
    pub pace: Pace,
}

const BAR_WIDTH: usize = 10;

fn severity_of(pct: i64) -> (Severity, bool) {
    if pct >= 90 {
        (Severity::Critical, true)
    } else if pct >= 75 {
        (Severity::Critical, false)
    } else if pct >= 50 {
        (Severity::Caution, false)
    } else if pct >= 25 {
        (Severity::Warn, false)
    } else {
        (Severity::Good, false)
    }
}

fn bar_of(pct: i64) -> (usize, usize) {
    let mut filled = ((pct.max(0) as usize) * BAR_WIDTH) / 100;
    filled = filled.min(BAR_WIDTH);
    (filled, BAR_WIDTH - filled)
}

fn pace_of(pct_int: i64, eta_secs: i64, window_secs: i64) -> Pace {
    if pct_int < 20 || eta_secs <= 0 || window_secs <= 0 {
        return Pace::None;
    }
    let elapsed = (window_secs - eta_secs).max(0);
    if elapsed < window_secs / 10 {
        return Pace::None;
    }
    let pace = (pct_int as f64 * window_secs as f64) / (elapsed as f64 * 100.0);
    if pace >= 1.5 {
        Pace::VeryFast
    } else if pace >= 1.25 {
        Pace::Fast
    } else {
        Pace::None
    }
}

/// One window's worth of `rl_segment`. Returns `None` when `used_percentage`
/// is absent (bash's `[ -z "$pct" ] && return`).
fn rate_limit(label: &'static str, raw: &RlRaw, window_secs: i64, now: i64) -> Option<RateLimit> {
    let pct = raw.used_percentage?;
    // bash `printf '%.0f'`: round half away from zero. pct is never negative
    // here in practice, so floor(pct + 0.5) matches.
    let pct_int = (pct + 0.5).floor() as i64;

    let eta_secs = raw
        .resets_at
        .as_deref()
        .and_then(iso8601_to_epoch)
        .map(|reset| (reset - now).max(0))
        .unwrap_or(0);

    let (severity, blink) = severity_of(pct_int);
    let (bar_filled, bar_empty) = bar_of(pct_int);

    Some(RateLimit {
        label,
        pct: pct_int,
        eta_secs,
        bar_filled,
        bar_empty,
        severity,
        blink,
        pace: pace_of(pct_int, eta_secs, window_secs),
    })
}

/// tokenline.sh `compute_rate_limits`: Gemini has no rate-limit windows at
/// all; each window is independently absent when its pct is missing.
pub fn compute(s: &Session, now: i64) -> Vec<RateLimit> {
    if s.is_gemini {
        return Vec::new();
    }
    [
        s.rl_5h
            .as_ref()
            .and_then(|raw| rate_limit("5h", raw, 18_000, now)),
        s.rl_7d
            .as_ref()
            .and_then(|raw| rate_limit("7d", raw, 604_800, now)),
    ]
    .into_iter()
    .flatten()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::Client;

    fn session(rl_5h: Option<RlRaw>, rl_7d: Option<RlRaw>, is_gemini: bool) -> Session {
        Session {
            model: "test".into(),
            used_pct: None,
            tokens_limit: None,
            transcript_path: String::new(),
            session_id: String::new(),
            rl_5h,
            rl_7d,
            cur_input: 0,
            cur_output: 0,
            cur_cwrite: 0,
            cur_cread: 0,
            tokens_used: 0,
            cli_client: Client::ClaudeCode,
            is_gemini,
        }
    }

    #[test]
    fn golden_case() {
        let now = 1_783_000_000;
        let s = session(
            Some(RlRaw {
                used_percentage: Some(12.0),
                resets_at: Some("2026-07-05T18:00:00Z".into()),
            }),
            Some(RlRaw {
                used_percentage: Some(64.0),
                resets_at: Some("2026-07-06T12:00:00Z".into()),
            }),
            false,
        );

        let windows = compute(&s, now);
        assert_eq!(windows.len(), 2);

        let five_h = &windows[0];
        assert_eq!(five_h.label, "5h");
        assert_eq!(five_h.pct, 12);
        assert_eq!(five_h.eta_secs, 274_400);
        assert_eq!(five_h.bar_filled, 1);
        assert_eq!(five_h.bar_empty, 9);
        assert_eq!(five_h.severity, Severity::Good);
        assert!(!five_h.blink);
        assert_eq!(five_h.pace, Pace::None); // pct < 20

        let seven_d = &windows[1];
        assert_eq!(seven_d.label, "7d");
        assert_eq!(seven_d.pct, 64);
        assert_eq!(seven_d.eta_secs, 339_200);
        assert_eq!(seven_d.bar_filled, 6);
        assert_eq!(seven_d.bar_empty, 4);
        assert_eq!(seven_d.severity, Severity::Caution);
        assert!(!seven_d.blink);
        // elapsed = 604800 - 339200 = 265600, >= window/10 (60480): pace
        // = (64 * 604800) / (265600 * 100) = 1.457... -> below 1.5, above 1.25
        assert_eq!(seven_d.pace, Pace::Fast);
    }

    #[test]
    fn gemini_has_no_windows() {
        let s = session(
            Some(RlRaw {
                used_percentage: Some(50.0),
                resets_at: None,
            }),
            None,
            true,
        );
        assert!(compute(&s, 0).is_empty());
    }

    #[test]
    fn missing_pct_is_absent() {
        let s = session(
            Some(RlRaw {
                used_percentage: None,
                resets_at: Some("2026-07-05T18:00:00Z".into()),
            }),
            None,
            false,
        );
        assert!(compute(&s, 0).is_empty());
    }

    #[test]
    fn pace_thresholds_and_bar_clamp() {
        assert_eq!(pace_of(50, 14_400, 18_000), Pace::VeryFast); // pace 2.5
        assert_eq!(pace_of(30, 14_000, 18_000), Pace::Fast); // pace 1.35
        assert_eq!(pace_of(10, 1_000, 18_000), Pace::None); // pct < 20
        assert_eq!(pace_of(50, 0, 18_000), Pace::None); // eta <= 0

        assert_eq!(bar_of(0), (0, 10));
        assert_eq!(bar_of(50), (5, 5));
        assert_eq!(bar_of(100), (10, 0));
        assert_eq!(bar_of(250), (10, 0)); // clamped
    }

    #[test]
    fn severity_thresholds() {
        assert_eq!(severity_of(10).0, Severity::Good);
        assert_eq!(severity_of(30).0, Severity::Warn);
        assert_eq!(severity_of(60).0, Severity::Caution);
        assert_eq!(severity_of(80).0, Severity::Critical);
        assert!(severity_of(95).1); // blink
    }
}
