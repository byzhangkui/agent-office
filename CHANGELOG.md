# 更新日志

本文件记录 Agent Office 的重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [未发布]

### 新增
- **接入 Claude Code Agent**：Agent Office 现在可同时可视化 Codex 与 Claude Code 的活动。
  - 新增 Claude hook 适配器 `packages/hook-adapter/src/claude-hook-adapter.mjs`，将 Claude 的 `UserPromptSubmit` / `Notification` / `Stop` / `SubagentStop` / `SessionStart` / `PreCompact` 映射为办公室事件。
  - 新增 Claude hook 安装器 `packages/hook-adapter/src/install-claude-hooks.mjs`，写入 `~/.claude/settings.json`（其 `hooks` 结构不同于 Codex 的 `~/.codex/hooks.json`，故独立实现）。
  - 协议层新增 `claudeSourceAgentId`、`claudeIdentityKey`、`defaultClaudeProfile`（工位 `desk-2`、配色 `#c96442`）以及 `officeAgentSources` 源注册表。
  - 新增 `fixtures/claude/*.json` 样例载荷，以及 `hook:claude:test`、`hook:install:claude`、`hook:install:claude:dry-run` 脚本。
- **工作台桌签 hover 提示**：当桌签的姓名或任务标题被截断（`...`）时，鼠标悬停在桌签上显示完整内容。
- **求助姿势**：处于 `waiting`（需要输入 / 需要授权）或 `blocked`（任务阻塞 / 压缩上下文）的小人改为举手并轻微挥动，头顶弹出「老板」对话气泡；该状态下不再显示工作进度条。

### 变更
- 事件 `details` 的身份信封改为源无关的中性键 `agentSourceId` / `agentSessionId` / `agentIdentityKey`（原为 `codexSourceAgentId` 等）。桌面后端校验改为 `KNOWN_AGENT_SOURCES`（接受 `codex` 与 `claude`），前端渲染同样读取中性键，新增源无需改动读取方。

### 文档
- README、PROGRESS 更新 Claude Code 接入说明与多源（Codex / Claude）架构。
