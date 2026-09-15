---
"@inbrace-tech/tokenline": patch
---

fix: bill cache reads at 0.025x on Claude Fable 5.1 / Mythos 5.1. The per-turn economics line used a flat 0.1x cache-read multiplier for every Claude model, overstating `eq` and understating `saving %` on the models with the discounted cache-hit price. `tokenline.sh` now reads `model.id` and picks 0.025x for Fable 5.1 / Mythos 5.1; every other model keeps 0.1x.
