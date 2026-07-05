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
        // 50% used, 14400s to reset in an 18000s window => elapsed 3600s
        // pace = (50 * 18000) / (3600 * 100) = 2.5 -> VeryFast
        assert!(matches!(pace_of(50, 14_400, 18_000), Pace::VeryFast));
        // 30% used, 14000s to reset => elapsed 4000s
        // pace = (30 * 18000) / (4000 * 100) = 1.35 -> Fast
        // (brief's original numbers here, eta=15_000, actually yield elapsed=3000s
        // and pace=1.8 -> VeryFast; corrected to genuinely land in the Fast band)
        assert!(matches!(pace_of(30, 14_000, 18_000), Pace::Fast));
        assert!(matches!(pace_of(10, 1_000, 18_000), Pace::None));    // under 20% -> none
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
        assert!(matches!(rl_role(10).0, Role::Good));
        assert!(matches!(rl_role(30).0, Role::Warn));
        assert!(matches!(rl_role(60).0, Role::Caution));
        assert!(matches!(rl_role(80).0, Role::Critical));
        assert!(rl_role(95).1); // blink
    }
}
