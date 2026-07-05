// tokenline — a cache-aware statusline for AI coding CLIs.
//
// Slice 0: scaffold only. The real edge (stdin → now → cache_dir → render →
// print → exit(0), with catch_unwind so a panic never crashes the host) lands
// in the final slice; the pure domain modules land bottom-up before it.
fn main() {}
