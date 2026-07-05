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
        // Normalize Windows backslashes once, up front, so all contains()/replace()
        // logic below (written for forward slashes) works on both platforms.
        let mut transcript_path = r.transcript_path.replace('\\', "/");
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

    #[test]
    fn normalizes_windows_backslash_paths() {
        // Backslash subagent path resolves to the parent .jsonl, same as the unix case.
        let raw: RawInput = serde_json::from_str(
            r#"{"transcript_path":"C:\\Users\\x\\antigravity\\p\\subagents\\s\\t.jsonl"}"#).unwrap();
        let s = Session::from_raw(raw);
        assert_eq!(s.cli_client, Client::Antigravity);
        assert!(s.transcript_path.contains("/antigravity-cli/"));
        assert!(s.transcript_path.ends_with(".jsonl"));
        assert!(!s.transcript_path.contains("/subagents/"));
    }
}
