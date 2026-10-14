---
'@inbrace-tech/tokenline': patch
---

fix: the update notice and subagent-row state now work when `XDG_RUNTIME_DIR` points to a missing dir (WSL2 without systemd), via a private `${TMPDIR:-/tmp}/tokenline-<uid>`.
