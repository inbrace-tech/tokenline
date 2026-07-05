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
        || !(0..=23).contains(&hour) || !(0..=59).contains(&min) || !(0..=60).contains(&sec) { return None; }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3600 + min * 60 + sec)
}

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
    #[test]
    fn epoch_rejects_negative_time_fields() {
        assert_eq!(iso8601_to_epoch("1970-01-01T-1:00:00"), None);
        assert_eq!(iso8601_to_epoch("1970-01-01T00:-5:00"), None);
    }
}
