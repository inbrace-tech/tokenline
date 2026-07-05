use crate::fmt::Role;
use crate::input::Session;

pub struct Tier {
    pub role: Role,
    pub tokens: u64,
    pub eq_contrib: f64,
}

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

    let read_eq = s.cur_cread as f64 * read_m;
    let write_eq = s.cur_cwrite as f64 * write_m;
    let new_eq = s.cur_input as f64 * new_m;
    let out_eq = s.cur_output as f64 * out_m;

    // Match bash awk `printf "%d"` (truncation toward zero).
    let eq = (read_eq + write_eq + new_eq + out_eq) as u64;
    let uncached_eq = ((s.cur_cread + s.cur_cwrite + s.cur_input) as f64 * new_m + out_eq) as u64;

    let saving_pct = if uncached_eq > 0 {
        (100.0 * (uncached_eq as f64 - eq as f64) / uncached_eq as f64) as i64
    } else {
        0
    };

    // Thermometer order: cheap -> dear (read, new, write, output).
    let tiers = [
        Tier {
            role: Role::Read,
            tokens: s.cur_cread,
            eq_contrib: read_eq,
        },
        Tier {
            role: Role::New,
            tokens: s.cur_input,
            eq_contrib: new_eq,
        },
        Tier {
            role: Role::Write,
            tokens: s.cur_cwrite,
            eq_contrib: write_eq,
        },
        Tier {
            role: Role::Output,
            tokens: s.cur_output,
            eq_contrib: out_eq,
        },
    ];

    let any_activity = s.cur_cread > 0 || s.cur_cwrite > 0 || s.cur_input > 0 || s.cur_output > 0;

    Economics {
        eq,
        uncached_eq,
        saving_pct,
        tiers,
        any_activity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::Session;

    fn sess(json: &str) -> Session {
        Session::from_raw(serde_json::from_str(json).unwrap())
    }

    #[test]
    fn anthropic_1h_matches_bash() {
        // read 86.6k, write 2.2k, new 2, output 2.0k, cache=1h
        // eq   = 86600*0.1 + 2200*2 + 2*1 + 2000*5 = 8660 + 4400 + 2 + 10000 = 23062
        // unc  = (86600+2200+2)*1 + 2000*5 = 88802 + 10000 = 98802
        // save = floor(100*(98802-23062)/98802) = 76
        let s = sess(
            r#"{"model":{"display_name":"Opus 4.8"},"context_window":{"current_usage":
            {"input_tokens":2,"output_tokens":2000,"cache_creation_input_tokens":2200,
             "cache_read_input_tokens":86600}}}"#,
        );
        let e = economics(&s, true);
        assert_eq!(e.eq, 23_062);
        assert_eq!(e.uncached_eq, 98_802);
        assert_eq!(e.saving_pct, 76);
        assert!(e.any_activity);
        assert_eq!(e.tiers[0].role as u8, Role::Read as u8); // thermometer order
    }

    #[test]
    fn anthropic_5m_uses_1_25_write() {
        // write mult 1.25 when cache window is 5m
        let s = sess(
            r#"{"context_window":{"current_usage":
            {"cache_creation_input_tokens":1000,"output_tokens":0,
             "input_tokens":0,"cache_read_input_tokens":0}}}"#,
        );
        let e = economics(&s, false);
        assert_eq!(e.eq, 1250); // 1000 * 1.25
    }

    #[test]
    fn gemini_multipliers() {
        // read 0.25, write 1.0, new 1, output 4
        let s = sess(
            r#"{"model":{"display_name":"Gemini 2.5 Pro"},"context_window":{"current_usage":
            {"cache_read_input_tokens":1000,"cache_creation_input_tokens":1000,
             "input_tokens":1000,"output_tokens":1000}}}"#,
        );
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
