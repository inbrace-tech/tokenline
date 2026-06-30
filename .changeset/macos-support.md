---
"@inbrace-tech/tokenline": minor
---

Add macOS support. `tokenline.sh` now abstracts `date`/`stat` over GNU vs BSD by
probing behavior once (`epoch_from_iso`, `file_mtime`), pins `LC_ALL=C` so a
comma-decimal locale renders identically, and the installer accepts macOS
(`brew install bash jq`). Closes #2.
