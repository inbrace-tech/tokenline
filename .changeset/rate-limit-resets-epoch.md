---
"@inbrace-tech/tokenline": patch
---

fix: show the rate-limit reset ETA and pace markers again. Claude Code sends `rate_limits.*.resets_at` as Unix epoch seconds, but since 1.2.1 `tokenline.sh` passed the value to `date` as if it were ISO-8601. GNU and BSD `date` both reject a bare epoch, so the ETA and the `!` / `!!` markers disappeared. An integer `resets_at` is now used directly, and anything else still goes through the ISO-8601 parser.
