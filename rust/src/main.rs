use std::io::Read;
use tokenline::input::{RawInput, Session};

fn main() {
    let mut buf = String::new();
    if std::io::stdin().read_to_string(&mut buf).is_err() { return; }
    match serde_json::from_str::<RawInput>(&buf) {
        Ok(raw) => println!("{}", Session::from_raw(raw).model),
        Err(_) => {} // silent no-op on malformed input
    }
}
