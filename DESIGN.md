# 多 Agent Telegram 接入设计（草案，待审阅）

状态：调查结论与方案草案，尚未开始改代码。日期：2026-11-01。

## 1. 目标与约束

- 以 `pi-telegram-plus-ex` 现有行为为标准，把同样的 Telegram 使用体验扩展到 **Codex** 和 **Claude Code**。
- 标准体验的核心：Telegram 与终端里**同一个**正在运行的会话同步；一个启动目录对应一个论坛话题；能发任务、看最终答案、中断、答复审批和选择框、执行常用命令；「正在输入…」表示仍在工作。
- 每个 Agent 用**自己的 Bot**，并且**各用各的论坛群**。不同 Agent 之间不共用 Bot，也不共用群。
- `codex-plugin`（`~/codex-plugin`）的现有代码不作为参考标准。

## 2. 调查结论

### 2.1 Pi（现状，基准）

插件作为 Pi 扩展运行在 Pi 进程内，直接操作会话、命令和终端界面（`lib/session-capture.ts`、`lib/tui/`）。同一个 Bot 被多个目录的 Pi 共用时，由 `lib/instance-coordinator.ts` 选出一个进程接收消息并转发给对应话题的进程。

### 2.2 Codex（本机 0.166.0 实测 + GitHub openai/codex 源码）

接入点是 Codex 的 **app-server**（JSON-RPC）。关键事实：

| 能力 | 结论 | 依据 |
|---|---|---|
| 共享常驻服务 | 本机有常驻 app-server（unix socket），终端 TUI 默认自动连它；连不上时 TUI 改用自带的内嵌 server | `codex-rs/app-server-daemon/README.md`；本机进程 `codex app-server --listen unix:// --managed-daemon` |
| 接入运行中的同一会话 | 支持。对运行中的 thread 调用 `thread/resume`，app-server 会重新加入该 thread 并订阅后续事件 | 本机生成的 `ThreadResumeParams.ts` 注释；`thread_state.rs` |
| 审批 | 发给所有订阅该 thread 的连接；任一方答复后广播 `serverRequest/resolved`，即先答先得 | `outgoing_message.rs` `send_request_to_connections`、`resolve_server_request` |
| 发任务 / 插话 / 中断 | `turn/start`、`turn/steer`、`turn/interrupt` | 本机生成的 `ClientRequest.ts` |
| 输出事件 | `item/agentMessage/delta`、`item/completed`、`turn/completed`、`thread/status/changed` 等 | `ServerNotification.ts` |
| 会话列表与目录 | `thread/loaded/list`、`thread/list`；Thread 对象带 `cwd`、`status`、`source` | `Thread.ts`、`ThreadLoadedListResponse.ts` |
| 其他控制 | `thread/compact/start`、`model/list`、`thread/name/set`、`thread/fork`、`thread/goal/*` | `ClientRequest.ts` |

未确认：

- `thread/started` 是否广播给所有连接。备选方案是轮询 `thread/loaded/list`。
- TUI 改用内嵌 server 时（例如设置了 `CODEX_EXEC_SERVER_URL`，或共享服务初始化失败），外部程序看不到这个会话，Telegram 无法接入。
- Codex 终端里的斜杠命令属于 TUI 本地功能，app-server 没有通用的「执行斜杠命令」接口，需要逐个映射到对应 RPC。

### 2.3 Claude Code（官方文档 code.claude.com/docs，本机未安装，未实测）

| 方式 | 能否接入终端里运行中的同一会话 | 结论 |
|---|---|---|
| **mods**（插件里的 JS 钩子，运行在 Claude Code 进程内，v2.1.287 起默认开启） | 能 | 推荐。最接近 Pi 扩展 |
| channels（MCP 推送消息进会话，官方已有 Telegram 插件） | 能，但只能推消息进去 | 不推荐作为基础：研究预览、需白名单或开发参数、回复要靠模型调用工具发出 |
| Remote Control | 能，但只能用 Anthropic 自家 App | 不可用 |
| Agent SDK / `claude -p` | 另开会话 | 不符合同步要求 |

mods 提供的相关能力（依据 `plugins/mods/reference.md`、`api.md`、`events.md`）：

- 发任务：`$.prompt.submit({ text, asUser: true })`；中断：`$.turn.abort`。
- 最终答案：`turn.complete` 事件的 `e.answer`；回合开始和结束：`turn.start`、`turn.complete`。
- 审批：`tool.call` 可以挂起工具调用等待结果，`tool.check` 可以直接给出 allow/ask/deny。
- 命令：`$.command.register`、`$.command.run`。
- 后台：`$.clock.every`、`$.process.spawn`、`$.http.fetch`（单次 30 秒）。
- 限制：钩子模块里没有 Node API；钩子本身限时 10 秒，等待 mods API 调用的时间不计入，等待自己的 promise 计入。

未确认（需要装好 Claude Code 后做原型验证）：

- 远程审批时，挂起的工具调用能否同时让终端也能答，做到先答先得。
- `$.command.run` 能否执行内置命令，如 `/model`、`/compact`。
- 多个 Claude Code 会话共用一个 Bot 时，sidecar 之间如何协调。
- 选择框（`AskUserQuestion`）能否转到 Telegram 作答。

## 3. 三种 Agent 对比

| 项目 | Pi | Codex | Claude Code |
|---|---|---|---|
| 插件运行位置 | Agent 进程内 | Agent 进程外（连接常驻 app-server） | Agent 进程内（mod）+ 一个 Node 辅助进程 |
| 接入同一会话 | 是 | 是（经 `thread/resume`） | 是（mod 本身就在会话里） |
| 审批先答先得 | 已实现 | 协议原生支持 | 待验证 |
| 命令 | 宿主命令基本可用 | 需逐个映射到 RPC | 待验证 `$.command.run` |
| 选择框和菜单 | 已实现（`lib/tui/`） | 要按 app-server 的请求类型重做 | 要按 mod 事件重做 |
| 多目录共用 Bot | `instance-coordinator` 选主 | 一个 bridge 进程即可服务全部目录 | 需要选主（同 Pi） |
| 主要风险 | 依赖 Pi 内部实现，升级易坏 | 接口标记为 experimental | mods 较新，变化快；未实测 |

## 4. 架构方案

### 4.1 进程模型

- 每个 Agent 一个 Bot、一个论坛群，互不影响，因此**不需要独立网关**。
- 同一个 Agent 在多个目录运行时，共用这个 Agent 的 Bot，仍需要「一个进程接收消息，再按话题分发」。
  - Pi：沿用 `instance-coordinator`。
  - Codex：所有会话都在同一个常驻 app-server 里，用**一个常驻 bridge 进程**连接 app-server，按 thread 的 `cwd` 对应话题即可，不需要选主。
  - Claude Code：每个会话一个 mod 加一个 sidecar，sidecar 之间复用 `instance-coordinator` 选主。

### 4.2 代码分层

```text
telegram-core/          与 Agent 无关
  telegram-api, polling, markdown, text-split, rich-message,
  forum-router, forum-transport, forum-session（话题对照表）,
  instance-coordinator, pairing, config（路径可配置）, logger,
  heartbeat, callback-protocol, menu 键盘, attachments 收发
agent-adapter 接口       见 4.3
adapters/pi/            现有 session-capture、tui/、命令、renderer 的 Pi 部分
adapters/codex/         app-server 客户端 + 事件映射 + 命令映射
adapters/claude/        mod（钩子模块）+ sidecar（Node）
```

阶段 1 已完成第一步拆分：`lib/core/`（与 Agent 无关，24 个源文件；`core-boundary.test.ts` 禁止它引用 Pi 包或 `lib/core` 以外的文件）和 `lib/pi/`（Pi 专用，含 `tui/`、`commands/`、`context-budget/`）。数据目录统一由 `lib/core/data-dir.ts` 提供，Pi 默认仍是 `~/.pi/agent`。`forum-session`、`forum-transport`、`history-replay`、`menu-commands`、`attachments` 仍有 Pi 依赖，留在 `lib/pi/`，阶段 3 定型接口时再拆。

拆分前的调查结论：`lib/` 顶层约 26 个文件、4,500 行不直接依赖 Pi，是 `telegram-core` 的候选。但其中 `config.ts` 写死了 `~/.pi/agent`，`forum-policy.ts` 引用了 Pi 的对话框模型，需要先改。`controller.ts`（1,882 行）同时负责消息路由、命令分发和 Pi 界面路由，是拆分的主要工作量。`lib/context-budget/` 与 Telegram 无关，应移出。

### 4.3 适配器接口草案

```ts
interface AgentAdapter {
  // 会话
  listSessions(): Promise<AgentSession[]>;          // { id, cwd, name?, busy }
  onSessionChange(cb: (s: AgentSession) => void): Unsubscribe;
  // 输入
  submit(sessionId: string, text: string, files?: LocalFile[]): Promise<void>;
  steer?(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  // 命令（各 Agent 自己声明能执行哪些）
  commands(sessionId: string): Promise<CommandSpec[]>;
  runCommand(sessionId: string, name: string, args: string): Promise<void>;
  // 输出
  onOutput(cb: (e: OutputEvent) => void): Unsubscribe;   // final | toolError | status
  // 需要用户答复的请求：审批、选择、输入
  onPrompt(cb: (p: PromptRequest) => void): Unsubscribe;
  answerPrompt(promptId: string, answer: PromptAnswer): Promise<void>;
  onPromptResolved(cb: (promptId: string) => void): Unsubscribe; // 对方先答时收回按钮
  // 状态（/status、正在输入）
  status(sessionId: string): Promise<AgentStatus>;
}
```

接口只在第二个适配器（Codex）落地时一起定型，避免只凭 Pi 一家抽象。

## 5. 配对与授权

现状（`lib/pairing.ts`、`index.ts:412`）：本地生成 6 位配对码，发 `/pair <码>` 后记录 `allowedUserId`；配对前一律拒绝。论坛模式要求已有 `allowedUserId`（`index.ts:546`），所以配对实际在私聊阶段完成（据代码推断，未实测）。

结论：`/pair` 和 `allowedUserId` 是配合关系，保留。需要补：

1. 配对码过期（建议 10 分钟）和失败次数上限。目前两者都没有。
2. 只接受私聊里的 `/pair`。
3. 支持在 SSH 中直接填写 `allowedUserId`。现有 Bots → Update 已能改这个字段，需写进文档。
4. 数据结构预留多用户（列表），界面暂时只支持一个。

## 6. 现有插件中需要处理的设计问题

按风险从高到低：

1. 依赖 Pi 内部实现（`session-capture` 替换退出处理、`tui/` 读组件内部字段）。拆分改变不了，靠契约测试和版本检查兜底。
2. `controller.ts` 职责混杂。
3. 路径写死：`/tg-setup` 入口指向 `/home/ubuntu/pi-telegram-plus-ex`，配置固定在 `~/.pi/agent`。
4. `context-budget` 放在 tg 插件里。
5. 关闭功能用的常量 `PROCESS_MESSAGES_ENABLED`、`STREAM_PREVIEW_ENABLED`，旧代码仍在，应改成配置项或删除。
6. 界面中英文混用。
7. 遗留：`scripts/e2e` 仍断言旧 `/quit`；`forum-multiprocess.test.ts` 偶发失败。

## 7. 分阶段计划（每阶段单独确认）

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | 修配对：过期、次数上限、仅私聊 | 离线测试；现有 1194 项不回退 |
| 1 | 在本仓库内整理目录：`lib/core/` 与 `lib/pi/`，不改行为；`config` 路径参数化；移出 `context-budget` | 离线测试全部通过；Pi 真机行为不变 |
| 2 | Codex 适配器原型：bridge 连接本机 app-server，单目录、单话题，完成发任务、最终答案、中断、审批 | 用新 Bot 和新群真机验收 |
| 3 | 定型 `AgentAdapter` 接口，把 Pi 改为实现该接口；Codex 补齐命令和多目录 | 两个 Agent 都通过离线测试与真机验收 |
| 4 | 安装 Claude Code，做 mod + sidecar 原型，先验证第 2.3 节的未确认项 | 原型报告；可行再进入完整实现 |
| 5 | 拆成独立包（core / pi / codex / claude） | 发布前另行确认 |

推荐先做 Codex：协议有文档、本机可实测、能做到同一会话同步。Claude Code 需要先安装并验证 mods 的关键能力。

## 8. 需要决定的事项

1. 是否同意第 4 节的架构（共享库 + 每 Agent 适配器；Codex 用常驻 bridge；Claude Code 用 mod + sidecar）。
2. 阶段顺序，尤其是否先做阶段 0（配对加固）。
3. 是否允许在本机安装 Claude Code（阶段 4 前需要）。
4. Codex 和 Claude Code 的 Bot 与论坛群由你创建；Token 只在 SSH 中录入。

## 附：资料来源

- Codex：本机 `codex app-server generate-ts` 输出；`https://github.com/openai/codex`（main 分支）`codex-rs/app-server-daemon/README.md`、`codex-rs/app-server/README.md`、`codex-rs/app-server/src/thread_state.rs`、`codex-rs/app-server/src/outgoing_message.rs`、`codex-rs/app-server/src/request_processors/thread_processor.rs`。
- Claude Code：`https://code.claude.com/docs/en/` 下的 `channels`、`channels-reference`、`plugins/mods/overview`、`plugins/mods/reference`、`plugins/mods/api`、`plugins/mods/events`、`hooks`、`remote-control`、`headless`。
- 下载的原文保存在 `~/.cache/pi-telegram/scratch/`。
