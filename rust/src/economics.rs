use crate::input::Session;

/// Pure compute for the per-turn token economics line (tokenline.sh
/// `compute_turn_breakdown`, lines ~388-441). No color/presentation here —
/// that's render.rs's job.
pub struct Economics {
    pub read: u64,
    pub write: u64,
    pub new: u64,
    pub output: u64,
    pub eq: u64,
    pub saving_pct: i64,
    pub read_label: String,
    pub write_label: String,
    pub new_label: String,
    pub output_label: String,
}

/// `ttl_label` is the cache TTL label ("5m" or "1h") driving the write
/// multiplier bump for non-Gemini models. Returns `None` when there's no
/// token activity at all (bash's no-cost-line guard).
pub fn compute(s: &Session, ttl_label: &str) -> Option<Economics> {
    if s.cur_cread == 0 && s.cur_cwrite == 0 && s.cur_input == 0 && s.cur_output == 0 {
        return None;
    }

    // Multiplier value + its bash-literal label string (not derived from the
    // float — bash assigns these as fixed strings, e.g. write_mult="2").
    let (read_mult, read_label, write_mult, write_label, new_mult, new_label, out_mult, out_label): (
        f64,
        &str,
        f64,
        &str,
        f64,
        &str,
        f64,
        &str,
    ) = if s.is_gemini {
        (0.25, "0.25", 1.0, "1.0", 1.0, "1", 4.0, "4")
    } else if ttl_label == "1h" {
        (0.1, "0.1", 2.0, "2", 1.0, "1", 5.0, "5")
    } else {
        (0.1, "0.1", 1.25, "1.25", 1.0, "1", 5.0, "5")
    };

    // Match bash awk `printf "%d"` (truncation toward zero).
    let eq = (s.cur_cread as f64 * read_mult
        + s.cur_cwrite as f64 * write_mult
        + s.cur_input as f64 * new_mult
        + s.cur_output as f64 * out_mult) as u64;

    let uncached_eq = ((s.cur_cread + s.cur_cwrite + s.cur_input) as f64 * new_mult
        + s.cur_output as f64 * out_mult) as u64;

    let saving_pct = if uncached_eq > 0 {
        (100.0 * (uncached_eq as f64 - eq as f64) / uncached_eq as f64) as i64
    } else {
        0
    };

    Some(Economics {
        read: s.cur_cread,
        write: s.cur_cwrite,
        new: s.cur_input,
        output: s.cur_output,
        eq,
        saving_pct,
        read_label: format!("{read_label}x"),
        write_label: format!("{write_label}x"),
        new_label: format!("{new_label}x"),
        output_label: format!("{out_label}x"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(json: &str) -> Session {
        Session::from_raw(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn golden_fixture_5m_matches_bash() {
        // read 86.6k, write 2.2k, new 2, output 2.0k, ttl 5m, non-Gemini
        // eq  = trunc(86600*0.1 + 2200*1.25 + 2*1 + 2000*5)
        //     = trunc(8660 + 2750 + 2 + 10000) = 21412
        // Wait: recompute precisely below via the fixture's actual numbers.
        let s = sess(
            r#"{"model":{"display_name":"Opus 4.8"},"context_window":{"current_usage":
            {"input_tokens":2,"output_tokens":2000,"cache_creation_input_tokens":2200,
             "cache_read_input_tokens":86600}}}"#,
        );
        let e = compute(&s, "5m").expect("activity present");
        assert_eq!(e.read, 86_600);
        assert_eq!(e.write, 2_200);
        assert_eq!(e.new, 2);
        assert_eq!(e.output, 2_000);
        assert_eq!(e.eq, 21_412);
        assert_eq!(e.saving_pct, 78);
        assert_eq!(e.read_label, "0.1x");
        assert_eq!(e.write_label, "1.25x");
        assert_eq!(e.new_label, "1x");
        assert_eq!(e.output_label, "5x");
    }

    #[test]
    fn write_mult_bumps_to_2x_on_1h_ttl() {
        let s = sess(
            r#"{"context_window":{"current_usage":
            {"cache_creation_input_tokens":1000,"output_tokens":0,
             "input_tokens":0,"cache_read_input_tokens":0}}}"#,
        );
        let e = compute(&s, "1h").expect("activity present");
        assert_eq!(e.eq, 2000); // 1000 * 2
        assert_eq!(e.write_label, "2x");
    }

    #[test]
    fn gemini_multipliers() {
        let s = sess(
            r#"{"model":{"display_name":"Gemini 2.5 Pro"},"context_window":{"current_usage":
            {"cache_read_input_tokens":1000,"cache_creation_input_tokens":1000,
             "input_tokens":1000,"output_tokens":1000}}}"#,
        );
        let e = compute(&s, "5m").expect("activity present");
        // eq = 250 + 1000 + 1000 + 4000 = 6250
        assert_eq!(e.eq, 6250);
        assert_eq!(e.read_label, "0.25x");
        assert_eq!(e.write_label, "1.0x");
    }

    #[test]
    fn zero_activity_returns_none() {
        let s = sess("{}");
        assert!(compute(&s, "5m").is_none());
    }
}
