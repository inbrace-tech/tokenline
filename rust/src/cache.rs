use std::path::{Path, PathBuf};

pub struct CacheState {
    pub last_ts: Option<i64>,
    pub ttl: i64,
    pub ttl_label: String,
    pub last_tokens: u64,
}

impl Default for CacheState {
    fn default() -> Self {
        CacheState {
            last_ts: None,
            ttl: 300,
            ttl_label: "5m".into(),
            last_tokens: 0,
        }
    }
}

pub fn runtime_dir() -> PathBuf {
    let base = platform_base();
    let _ = std::fs::create_dir_all(&base);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700));
    }
    if base.is_dir() {
        base
    } else {
        std::env::temp_dir()
    }
}

#[cfg(unix)]
fn platform_base() -> PathBuf {
    let uid = std::env::var("UID").unwrap_or_default(); // often unset; fall through below
    let uid = if uid.is_empty() { unix_uid() } else { uid };
    let root = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(root).join(format!("tokenline-{}", uid))
}

#[cfg(unix)]
fn unix_uid() -> String {
    // SAFETY: getuid() is always safe and never fails.
    (unsafe { libc_getuid() }).to_string()
}
#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

#[cfg(windows)]
fn platform_base() -> PathBuf {
    let root = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    root.join("tokenline")
}

fn file_for(dir: &Path, session_id: &str) -> PathBuf {
    let id = if session_id.is_empty() {
        "default"
    } else {
        session_id
    };
    dir.join(format!("session-{}", id))
}

pub fn load(dir: &Path, session_id: &str) -> CacheState {
    let mut st = CacheState::default();
    let Ok(raw) = std::fs::read_to_string(file_for(dir, session_id)) else {
        return st;
    };
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.len() >= 4 {
        st.last_ts = parts[0].parse::<i64>().ok();
        if let Ok(t) = parts[1].parse::<i64>() {
            st.ttl = t;
        }
        st.ttl_label = parts[2].to_string();
        if let Ok(tk) = parts[3].parse::<u64>() {
            st.last_tokens = tk;
        }
    }
    st
}

pub fn store(dir: &Path, session_id: &str, st: &CacheState) {
    let line = format!(
        "{} {} {} {}",
        st.last_ts.unwrap_or(0),
        st.ttl,
        st.ttl_label,
        st.last_tokens
    );
    let _ = std::fs::write(file_for(dir, session_id), line); // best-effort
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        let mut d = std::env::temp_dir();
        // unique-ish without rand/time crates: process id
        d.push(format!("tokenline-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn roundtrip() {
        let dir = scratch();
        let st = CacheState {
            last_ts: Some(1_783_274_400),
            ttl: 3600,
            ttl_label: "1h".into(),
            last_tokens: 88_802,
        };
        store(&dir, "sess1", &st);
        let got = load(&dir, "sess1");
        assert_eq!(got.last_ts, Some(1_783_274_400));
        assert_eq!(got.ttl, 3600);
        assert_eq!(got.ttl_label, "1h");
        assert_eq!(got.last_tokens, 88_802);
    }

    #[test]
    fn missing_file_defaults() {
        let dir = scratch();
        let got = load(&dir, "does-not-exist");
        assert_eq!(got.last_ts, None);
        assert_eq!(got.ttl_label, "5m"); // default window
    }

    #[test]
    fn runtime_dir_exists() {
        let d = runtime_dir();
        assert!(d.exists());
    }
}
