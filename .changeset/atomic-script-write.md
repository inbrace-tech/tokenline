---
"@inbrace-tech/tokenline": patch
---

fix: `init` and `update` replace `tokenline.sh` atomically, so a refresh mid-update never runs a half-written script.
