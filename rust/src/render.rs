//! Byte-for-byte composition of the statusline lines, mirroring
//! `tokenline.sh`'s `render_statusline` and its `*_info` builders
//! (tokenline.sh:258-480). This is the only module that touches color/ANSI
//! presentation for cache/ctx/economics/rate-limits — the compute modules
//! stay pure.

use crate::cachetimer::{self, CacheInfo};
use crate::economics::{self, Economics};
use crate::fmt::{color, fmt_eta, fmt_k};
use crate::input::{Client, RawInput, Session};
use crate::ratelimits::{self, Pace, RateLimit, Severity};
use std::path::Path;

/// Bold 16-color ctx value codes (tokenline.sh:287-289) — deliberately
/// distinct from the 256-color palette in `fmt::color`, so kept as inline
/// literals rather than added to that module.
const CTX_BOLD_RED: &str = "\x1b[01;31m";
const CTX_BOLD_YELLOW: &str = "\x1b[01;33m";
const CTX_BOLD_GREEN: &str = "\x1b[01;32m";

/// Extra cache-gradient tier (tokenline.sh:265) between GREEN and YELLOW; not
/// one of the named `COLOR_*` constants in bash either, so inline here too.
const CACHE_LIGHT_GREEN: &str = "\x1b[38;5;154m";

pub fn render(raw: RawInput, now: i64, cache_dir: &Path) -> String {
    let session = Session::from_raw(raw);
    let ci = cachetimer::cache_info(&session, now, cache_dir);
    let econ = economics::compute(&session, &ci.ttl_label);
    let rls = ratelimits::compute(&session, now);

    let mut lines = Vec::new();

    let mut line1 = match session.cli_client {
        Client::Antigravity => format!(
            "{}\u{1f30c} Antigravity{} ({})",
            color::CYAN,
            color::RESET,
            session.model
        ),
        Client::ClaudeCode => session.model.clone(),
    };
    if let Some(ctx) = build_ctx_info(&session) {
        line1.push_str(" | ");
        line1.push_str(&ctx);
    }
    line1.push_str(" | ");
    line1.push_str(&build_cache_info(&ci));
    lines.push(line1);

    if let Some(e) = econ {
        lines.push(build_economics_line(&e));
    }

    if !rls.is_empty() {
        lines.push(format!(
            "{}{}{}",
            color::DARK_GRAY,
            "\u{2500}".repeat(30),
            color::RESET
        ));
        let line_rl = rls
            .iter()
            .map(build_rl_segment)
            .collect::<Vec<_>>()
            .join("  ");
        lines.push(line_rl);
    }

    lines.join("\n")
}

/// `compute_context_info` (tokenline.sh:283-296).
fn build_ctx_info(s: &Session) -> Option<String> {
    let used_pct = s.used_pct?;
    // bash `printf '%.0f'`: round half away from zero (used_pct is >= 0 here).
    let pct = (used_pct + 0.5).floor() as i64;
    let ctx_color = if pct >= 80 {
        CTX_BOLD_RED
    } else if pct >= 50 {
        CTX_BOLD_YELLOW
    } else {
        CTX_BOLD_GREEN
    };
    let gray = color::GRAY;
    let reset = color::RESET;
    if s.tokens_used > 0 && s.tokens_limit.is_some_and(|l| l > 0) {
        let limit = s.tokens_limit.unwrap();
        Some(format!(
            "{gray}ctx: {reset}{ctx_color}{}/{} ({pct}%){reset}",
            fmt_k(s.tokens_used),
            fmt_k(limit)
        ))
    } else {
        Some(format!("{gray}ctx: {reset}{ctx_color}{pct}%{reset}"))
    }
}

/// `compute_cache_timer` display half (tokenline.sh:257-278). `CacheInfo`
/// only exposes 3 coarse `Warmth` buckets, which is too lossy for bash's
/// 5-tier color gradient — recompute `pct10` here from `remaining_secs` and
/// `is_1h` (which pins the ttl to 3600/300) to reproduce it exactly.
fn build_cache_info(ci: &CacheInfo) -> String {
    let gray = color::GRAY;
    let reset = color::RESET;
    if ci.remaining_secs > 0 {
        let ttl = if ci.is_1h { 3600 } else { 300 };
        let pct10 = ci.remaining_secs * 10 / ttl;
        let mins = ci.remaining_secs / 60;
        let secs = ci.remaining_secs % 60;
        let fg = if pct10 >= 8 {
            color::GREEN.to_string()
        } else if pct10 >= 6 {
            CACHE_LIGHT_GREEN.to_string()
        } else if pct10 >= 4 {
            color::YELLOW.to_string()
        } else if pct10 >= 2 {
            color::ORANGE.to_string()
        } else if pct10 >= 1 {
            color::RED.to_string()
        } else {
            format!("{}{}", color::RED, color::BLINK) // blinking red, tokenline.sh:269
        };
        let suffix = if pct10 < 1 { "HOT !" } else { "HOT" };
        format!(
            "{gray}[{}] cache: {fg}{mins}:{secs:02} {suffix}{reset}",
            ci.ttl_label
        )
    } else {
        // tokenline.sh:276 hardcodes BLINK before RED (reverse of the tier above).
        format!(
            "{gray}[{}] cache: {}{}COLD{reset}",
            ci.ttl_label,
            color::BLINK,
            color::RED
        )
    }
}

/// `compute_turn_breakdown` display half (tokenline.sh:432-439).
fn build_economics_line(e: &Economics) -> String {
    let gray = color::GRAY;
    let reset = color::RESET;
    let save_color = if e.saving_pct >= 90 {
        color::GREEN
    } else if e.saving_pct >= 70 {
        color::YELLOW
    } else if e.saving_pct >= 50 {
        color::ORANGE
    } else {
        color::RED
    };
    format!(
        "{gray}read({}): {}{}{reset} {gray}write({}): {}{}{reset} {gray}new({}): {}{}{reset} \
         {gray}output({}): {}{}{reset} {gray}eq: {}{}{reset} {gray}saving: {save_color}{}%{reset}",
        e.read_label,
        color::CYAN,
        fmt_k(e.read),
        e.write_label,
        color::YELLOW,
        fmt_k(e.write),
        e.new_label,
        color::MAGENTA,
        fmt_k(e.new),
        e.output_label,
        color::GREEN,
        fmt_k(e.output),
        color::ORANGE,
        fmt_k(e.eq),
        e.saving_pct,
    )
}

/// `rl_color_for_pct` (tokenline.sh:302-310): base color, with BLINK
/// appended (RED-then-BLINK order) when `blink` is set.
fn severity_color(sev: Severity, blink: bool) -> String {
    let base = match sev {
        Severity::Good => color::GREEN,
        Severity::Warn => color::YELLOW,
        Severity::Caution => color::ORANGE,
        Severity::Critical => color::RED,
    };
    if blink {
        format!("{base}{}", color::BLINK)
    } else {
        base.to_string()
    }
}

/// `rl_bar` (tokenline.sh:312-328).
fn build_bar(filled: usize, empty: usize, bar_color: &str) -> String {
    format!(
        "{bar_color}{}{}{}{}",
        "\u{2588}".repeat(filled),
        color::DARK_GRAY,
        "\u{2591}".repeat(empty),
        color::RESET
    )
}

/// `rl_segment` (tokenline.sh:330-376).
fn build_rl_segment(rl: &RateLimit) -> String {
    let gray = color::GRAY;
    let reset = color::RESET;
    let bar_color = severity_color(rl.severity, rl.blink);
    let bar = build_bar(rl.bar_filled, rl.bar_empty, &bar_color);
    let reset_str = if rl.eta_secs > 0 {
        format!(" ({} to reset)", fmt_eta(rl.eta_secs))
    } else {
        String::new()
    };
    let pace_suffix = match rl.pace {
        Pace::None => String::new(),
        Pace::Fast => format!(" {}!{reset}", color::ORANGE),
        Pace::VeryFast => format!(" {}{}!!{reset}", color::RED, color::BLINK),
    };
    format!(
        "{gray}{}: {reset}{bar} {bar_color}{}%{reset}{reset_str}{pace_suffix}",
        rl.label, rl.pct
    )
}
