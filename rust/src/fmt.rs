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
