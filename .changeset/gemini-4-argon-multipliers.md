---
"@inbrace-tech/tokenline": patch
---

fix: bill cache reads at 0.05x and output at 5x on Gemini 4 Argon, so its per-turn `eq` and `saving %` match the official price; other Gemini models keep 0.25x / 4x.
