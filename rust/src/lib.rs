//! tokenline — a cache-aware statusline for AI coding CLIs.
//!
//! Pure domain (deterministic, golden-testable) and a thin stateful edge.
//! Modules land bottom-up, one slice per PR (see inbrace-tech/tokenline#27).

pub mod fmt;

pub mod input;
