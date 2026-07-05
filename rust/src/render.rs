use crate::cachetimer::{Warmth, cache_info};
use crate::economics::economics;
use crate::fmt::{Role, fmt_eta, fmt_k};
use crate::input::{Client, RawInput, Session};
use crate::ratelimits::{Pace, RlWindow, rl_bar, rl_role, rl_window};
use std::path::Path;

#[derive(Clone, Copy)]
pub enum Density {
    Compact,
    Normal,
    Verbose,
}

struct Buf(String);
impl Buf {
    fn new() -> Self {
        Buf(String::new())
    }
    fn seg(&mut self, role: Role, text: &str, bold: bool, blink: bool) {
        self.0.push_str(&role.paint(text, bold, blink));
    }
    fn take(self) -> String {
        self.0
    }
}

/// Public entry. v1: always renders Normal (PULSE+); other densities fall back.
pub fn render(input: RawInput, now: i64, cache_dir: &Path, _density: Density) -> String {
    let s = Session::from_raw(input);
    render_normal(&s, now, cache_dir)
}

fn render_normal(s: &Session, now: i64, cache_dir: &Path) -> String {
    let ci = cache_info(s, now, cache_dir);
    let eco = economics(s, ci.is_1h);
    let mut out = String::new();

    // ---- Line 1: model · ctx · cache -------------------------------------
    let mut l1 = Buf::new();
    // model (with Antigravity brand)
    if s.cli_client == Client::Antigravity {
        l1.seg(Role::Accent, "🌌 Antigravity", false, false);
        l1.seg(Role::Muted, &format!(" ({})", s.model), false, false);
    } else {
        l1.seg(Role::Muted, &s.model, false, false);
    }
    // ctx (sparkline + %)
    if let Some(pct) = s.used_pct {
        let pct = pct.round() as i64;
        let (role, bold) = ctx_role(pct);
        l1.seg(Role::Faint, "  ·  ", false, false);
        l1.seg(Role::Muted, "ctx ", false, false);
        l1.seg(role, &spark(pct), bold, false);
        l1.seg(role, &format!(" {}%", pct), bold, false);
    }
    // cache (heartbeat + countdown + drain bar + word)
    l1.seg(Role::Faint, "  ·  ", false, false);
    let (cache_role, blink, word) = warmth_style(&ci.warmth);
    l1.seg(cache_role, "♥ ", false, blink);
    l1.seg(Role::Muted, "cache ", false, false);
    l1.seg(cache_role, &clock(ci.remaining_secs), true, blink);
    l1.seg(
        cache_role,
        &format!(" {} ", drain_bar(ci.remaining_secs, ttl_of(&ci))),
        false,
        false,
    );
    l1.seg(cache_role, word, blink, blink);
    out.push_str(&l1.take());
    out.push('\n');

    // ---- Line 2: cost thermometer (only when a turn happened) ------------
    if eco.any_activity {
        let mut l2 = Buf::new();
        l2.seg(Role::Muted, "cost ", false, false);
        for (glyph, role) in thermometer(&eco) {
            l2.seg(role, &glyph, false, false);
        }
        l2.seg(Role::Accent, &format!("  {}", fmt_k(eco.eq)), true, false);
        l2.seg(
            Role::Faint,
            &format!(" / {} full", fmt_k(eco.uncached_eq)),
            false,
            false,
        );
        l2.seg(Role::Faint, " · ", false, false);
        let save_role = save_role(eco.saving_pct);
        l2.seg(
            save_role,
            &format!("↓{}% saved", eco.saving_pct),
            true,
            false,
        );
        out.push_str(&l2.take());
        out.push('\n');
    }

    // ---- Line 3: rate limits (Anthropic only) ----------------------------
    if !s.is_gemini {
        let w5 = s.rl_5h.as_ref().and_then(|r| rl_window(r, 18_000, now));
        let w7 = s.rl_7d.as_ref().and_then(|r| rl_window(r, 604_800, now));
        if w5.is_some() || w7.is_some() {
            let mut l3 = Buf::new();
            if let Some(w) = &w5 {
                rl_segment(&mut l3, "5h", w);
            }
            if let Some(w) = &w7 {
                if w5.is_some() {
                    l3.seg(Role::Faint, "   ", false, false);
                }
                rl_segment(&mut l3, "7d", w);
            }
            out.push_str(&l3.take());
            out.push('\n');
        }
    }

    out
}

fn rl_segment(b: &mut Buf, label: &str, w: &RlWindow) {
    let (role, blink) = rl_role(w.pct);
    let marker = if matches!(w.pace, Pace::VeryFast) || w.pct >= 75 {
        "▲ "
    } else {
        "▸ "
    };
    b.seg(role, marker, false, blink);
    b.seg(role, &format!("{} ", label), false, false);
    let (filled, empty) = rl_bar(w.pct, 10);
    b.seg(role, &"█".repeat(filled), false, false);
    b.seg(Role::Faint, &"░".repeat(empty), false, false);
    b.seg(role, &format!(" {}% ", w.pct), false, blink);
    match w.pace {
        Pace::VeryFast => b.seg(role, "⚡ pace!! ", false, false),
        Pace::Fast => b.seg(role, "⚡ pace ", false, false),
        Pace::None => {}
    }
    if w.eta_secs > 0 {
        b.seg(
            Role::Faint,
            &format!("· {} left", fmt_eta(w.eta_secs)),
            false,
            false,
        );
    }
}

// ---- small helpers ------------------------------------------------------
fn ctx_role(pct: i64) -> (Role, bool) {
    if pct >= 80 {
        (Role::Critical, true)
    } else if pct >= 50 {
        (Role::Warn, false)
    } else {
        (Role::Good, false)
    }
}
fn spark(pct: i64) -> String {
    // 2-cell rising meter: ▁▂▃▄▅▆▇█ picked by 8ths.
    let blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let idx = ((pct.clamp(0, 100) * 8) / 100).clamp(0, 7) as usize;
    format!("{}{}", blocks[idx], blocks[idx.min(7)])
}
fn warmth_style(w: &Warmth) -> (Role, bool, &'static str) {
    match w {
        Warmth::Warm => (Role::Cache, false, "warm"),
        Warmth::Cooling => (Role::Warn, false, "cooling"),
        Warmth::Cold => (Role::Critical, true, "COLD"),
    }
}
fn clock(remaining: i64) -> String {
    let r = remaining.max(0);
    format!("{}:{:02}", r / 60, r % 60)
}
fn ttl_of(ci: &crate::cachetimer::CacheInfo) -> i64 {
    if ci.is_1h { 3600 } else { 300 }
}
fn drain_bar(remaining: i64, ttl: i64) -> String {
    let filled = if ttl > 0 {
        (remaining.max(0) * 10 / ttl).clamp(0, 10) as usize
    } else {
        0
    };
    format!("{}{}", "█".repeat(filled), "░".repeat(10 - filled))
}
fn save_role(pct: i64) -> Role {
    if pct >= 70 {
        Role::Good
    } else if pct >= 50 {
        Role::Warn
    } else {
        Role::Caution
    }
}
/// Stacked cost thermometer: widths ∝ eq-contribution over ~11 cells, order read·new·write·output.
fn thermometer(eco: &crate::economics::Economics) -> Vec<(String, Role)> {
    let total: f64 = eco.tiers.iter().map(|t| t.eq_contrib).sum::<f64>().max(1.0);
    let cells = 11.0;
    eco.tiers
        .iter()
        .map(|t| {
            let n = (t.eq_contrib / total * cells).round() as usize;
            let glyph = if n == 0 && t.eq_contrib > 0.0 {
                "·".to_string()
            } else {
                "▉".repeat(n)
            };
            (glyph, t.role)
        })
        .collect()
}
