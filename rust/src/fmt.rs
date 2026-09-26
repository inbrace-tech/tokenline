//! Formatting helpers, byte-for-byte parity with `tokenline.sh`.
//!
//! Carries `fmt_k` / `fmt_eta`, the 256-color palette, and the ISO-8601 → epoch
//! parser.

use jiff::Timestamp;

/// Parse an RFC 3339 / ISO-8601 UTC timestamp to epoch seconds, or `None` on a
/// malformed value. Replaces the bash `epoch_from_iso` (`date -d`): transcripts
/// and rate-limit resets are fixed-format UTC, so `jiff::Timestamp` covers them
/// without pulling a timezone database.
pub fn iso8601_to_epoch(iso: &str) -> Option<i64> {
    iso.parse::<Timestamp>().ok().map(|t| t.as_second())
}

/// 256-color SGR sequences, byte-identical to `tokenline.sh`'s `COLOR_*` /
/// `STYLE_*` constants (`tokenline.sh:21-30`). Byte parity matters: the golden
/// oracle diffs the raw escape sequences, so `RESET` is `[00m` (two digits),
/// not `[0m`, exactly as the bash emits.
pub mod color {
    pub const GRAY: &str = "\x1b[38;5;244m";
    pub const DARK_GRAY: &str = "\x1b[38;5;240m";
    pub const CYAN: &str = "\x1b[38;5;51m";
    pub const YELLOW: &str = "\x1b[38;5;226m";
    pub const MAGENTA: &str = "\x1b[38;5;201m";
    pub const ORANGE: &str = "\x1b[38;5;208m";
    pub const RED: &str = "\x1b[38;5;196m";
    pub const GREEN: &str = "\x1b[38;5;46m";
    pub const RESET: &str = "\x1b[00m";
    pub const BLINK: &str = "\x1b[1;5m";
}

/// Compact token count, mirroring the bash `fmt_k` (awk `%.1f`):
/// `1_500_000 -> "1.5M"`, `25_600 -> "25.6k"`, `900 -> "900"`.
pub fn fmt_k(v: u64) -> String {
    if v >= 1_000_000 {
        format!("{:.1}M", v as f64 / 1_000_000.0)
    } else if v >= 1_000 {
        format!("{:.1}k", v as f64 / 1_000.0)
    } else {
        v.to_string()
    }
}

/// Human ETA from raw seconds, mirroring the bash `fmt_eta`:
/// `<=0 -> "now"`, `<1h -> "%dm"`, `<1d -> "%dh%dm"/"%dh"`, else `"%dd%dh"/"%dd"`.
pub fn fmt_eta(secs: i64) -> String {
    if secs <= 0 {
        return "now".to_string();
    }
    if secs < 3600 {
        return format!("{}m", secs / 60);
    }
    if secs < 86_400 {
        let (h, m) = (secs / 3600, (secs % 3600) / 60);
        return if m > 0 {
            format!("{}h{}m", h, m)
        } else {
            format!("{}h", h)
        };
    }
    let (d, h) = (secs / 86_400, (secs % 86_400) / 3600);
    if h > 0 {
        format!("{}d{}h", d, h)
    } else {
        format!("{}d", d)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_k_tiers() {
        assert_eq!(fmt_k(0), "0");
        assert_eq!(fmt_k(900), "900");
        assert_eq!(fmt_k(999), "999");
        assert_eq!(fmt_k(1_000), "1.0k");
        assert_eq!(fmt_k(2_000), "2.0k");
        assert_eq!(fmt_k(2_200), "2.2k");
        assert_eq!(fmt_k(25_600), "25.6k");
        assert_eq!(fmt_k(86_600), "86.6k");
        assert_eq!(fmt_k(1_000_000), "1.0M");
        assert_eq!(fmt_k(1_500_000), "1.5M");
    }

    #[test]
    fn iso8601_to_epoch_parses_utc() {
        // Exact epochs (verified independently). now in the golden = 1_783_000_000.
        assert_eq!(
            iso8601_to_epoch("2026-07-05T18:00:00Z"),
            Some(1_783_274_400)
        );
        assert_eq!(
            iso8601_to_epoch("2026-07-06T12:00:00Z"),
            Some(1_783_339_200)
        );
        assert_eq!(
            iso8601_to_epoch("2026-07-05T00:00:00Z"),
            Some(1_783_209_600)
        );
    }

    #[test]
    fn iso8601_to_epoch_fractional_and_invalid() {
        // Sub-second precision truncates to the whole second.
        assert_eq!(
            iso8601_to_epoch("2026-07-05T18:00:00.500Z"),
            Some(1_783_274_400)
        );
        assert_eq!(iso8601_to_epoch("not a timestamp"), None);
        assert_eq!(iso8601_to_epoch(""), None);
    }

    #[test]
    fn palette_matches_bash_bytes() {
        // Exact bytes captured from `tokenline.sh` output (cat -v): ESC[38;5;Nm.
        assert_eq!(color::GRAY, "\x1b[38;5;244m");
        assert_eq!(color::CYAN, "\x1b[38;5;51m");
        assert_eq!(color::YELLOW, "\x1b[38;5;226m");
        assert_eq!(color::MAGENTA, "\x1b[38;5;201m");
        assert_eq!(color::ORANGE, "\x1b[38;5;208m");
        assert_eq!(color::GREEN, "\x1b[38;5;46m");
        assert_eq!(color::RED, "\x1b[38;5;196m");
        assert_eq!(color::DARK_GRAY, "\x1b[38;5;240m");
        // bash COLOR_RESET is [00m (two digits), STYLE_BLINK is [1;5m.
        assert_eq!(color::RESET, "\x1b[00m");
        assert_eq!(color::BLINK, "\x1b[1;5m");
    }

    #[test]
    fn fmt_eta_tiers() {
        assert_eq!(fmt_eta(-5), "now");
        assert_eq!(fmt_eta(0), "now");
        assert_eq!(fmt_eta(30), "0m"); // %dm with integer division, like bash
        assert_eq!(fmt_eta(90), "1m");
        assert_eq!(fmt_eta(3_600), "1h");
        assert_eq!(fmt_eta(3_660), "1h1m");
        assert_eq!(fmt_eta(86_400), "1d");
        assert_eq!(fmt_eta(90_000), "1d1h");
        assert_eq!(fmt_eta(273_600), "3d4h"); // 5h-window reset ETA in the golden
    }
}
