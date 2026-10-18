<!--
PR template. Sections marked "(optional)" can be deleted entirely when not
applicable — empty optional sections read as oversight, not intent.
-->

## Summary

<!-- One paragraph or 2–3 bullets: what changed and why.
     If this PR closes an issue, open with: Closes #<issue-number>. -->

- [ ] A new feature or behavior change links the issue where the approach was agreed (bug fixes and docs can skip this)
- [ ] The change sits where CONTRIBUTING.md › "Where does my change go?" puts it

## Test plan

- [ ] `shellcheck -s bash tokenline.sh install.sh` is clean
- [ ] Fed a sample payload and verified the rendered line(s)
- [ ] The statusline still degrades gracefully (never crashes the host CLI)
- [ ] No session input is written to disk

## Decisions worth noting (optional — delete if not applicable)

- <each decision: what was chosen + 1 line on the rejected alternative>

## Out of scope (optional — delete if not applicable)

- <file or feature deliberately not in this PR + 1 line on why>
