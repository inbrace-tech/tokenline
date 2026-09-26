//! The one hard contract of the binary: whatever the host pipes in, tokenline
//! exits 0 and never disturbs the host. These drive the real compiled binary.
use std::io::Write;
use std::process::{Command, Stdio};

fn run_with(stdin: &str) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tokenline"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn tokenline");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().expect("wait tokenline")
}

#[test]
fn malformed_json_is_a_silent_noop() {
    let out = run_with("this is not json");
    assert!(out.status.success(), "exit 0 on garbage");
    assert!(out.stdout.is_empty(), "no output on garbage");
}

#[test]
fn empty_stdin_is_a_silent_noop() {
    let out = run_with("");
    assert!(out.status.success(), "exit 0 on empty stdin");
    assert!(out.stdout.is_empty(), "no output on empty stdin");
}
