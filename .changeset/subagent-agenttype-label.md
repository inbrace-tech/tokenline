---
"@inbrace-tech/tokenline": patch
---

Subagent rows now label each subagent with its type (`Explore`, `code-reviewer`, …) from the task's `agentType` field, instead of the task kind `local_agent` that Claude Code reports in `type` for every subagent. Falls back to `name`, then `type`, on Claude Code versions that do not send `agentType`.
