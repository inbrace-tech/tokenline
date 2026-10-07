---
"@inbrace-tech/tokenline": patch
---

fix: bill cache reads at 0.05x on Claude Sonnet 5.5, so its per-turn `eq` and `saving %` match the official price; Claude Haiku 5.5 is confirmed at the standard 0.1x.
