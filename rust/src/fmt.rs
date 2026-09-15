//! Formatting helpers, byte-for-byte parity with `tokenline.sh`.
//!
//! This slice carries `fmt_k` / `fmt_eta`; the 256-color palette and the
//! ISO-8601 → epoch parser land in the next two slices.

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
