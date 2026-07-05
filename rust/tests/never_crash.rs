use std::io::Write;
use std::process::{Command, Stdio};

fn run(stdin: &str) -> (i32, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tokenline"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
    )
}

#[test]
fn malformed_json_exits_zero_silently() {
    let (code, out) = run("this is not json");
    assert_eq!(code, 0);
    assert!(out.trim().is_empty());
}

#[test]
fn empty_stdin_exits_zero() {
    let (code, out) = run("");
    assert_eq!(code, 0);
    assert!(out.trim().is_empty());
}

#[test]
fn valid_input_renders_and_exits_zero() {
    let (code, out) = run(r#"{"model":{"display_name":"Opus 4.8"},
        "context_window":{"used_percentage":9.0,
            "current_usage":{"input_tokens":2,"output_tokens":2000,
                "cache_creation_input_tokens":2200,"cache_read_input_tokens":86600}}}"#);
    assert_eq!(code, 0);
    assert!(out.contains("Opus 4.8"));
    assert!(
        out.contains("cost "),
        "expected the full PULSE+ render (cost line), got: {}",
        out
    );
}
