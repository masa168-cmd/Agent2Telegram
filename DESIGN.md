# 多 Agent Telegram 接入设计（草案，待审阅）

状态：阶段 0、1、2、3、4a 已完成（Claude Code 经网关接入、多目录共用 Bot，已真机验收）；下一步 4b。日期：2026-11-02。

## 1. 目标与约束

- 以 `pi-telegram-plus-ex` 现有行为为标准，把同样的 Telegram 使用体验扩展到 **Codex** 和 **Claude Code**。
- 标准体验的核心：Telegram 与终端里**同一个**正在运行的会话同步；一个启动目录对应一个论坛话题；能发任务、看最终答案、中断、答复审批和选择框、执行常用命令；「正在输入…」表示仍在工作。
- 每个 Agent 用**自己的 Bot**，并且**各用各的论坛群**。不同 Agent 之间不共用 Bot，也不共用群。

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

### 2.3 Claude Code（本机 2.1.316；依据其自带 mods 类型定义、官方文档与实测）

| 方式 | 能否接入终端里运行中的同一会话 | 结论 |
|---|---|---|
| **mods**（插件里的 JS 钩子，运行在 Claude Code 进程内，v2.1.287 起默认开启） | 能 | 推荐。最接近 Pi 扩展 |
| channels（MCP 推送消息进会话，官方已有 Telegram 插件） | 能，但只能推消息进去 | 不推荐作为基础：研究预览、需白名单或开发参数、回复要靠模型调用工具发出 |
| Remote Control | 能，但只能用 Anthropic 自家 App | 不可用 |
| Agent SDK / `claude -p` | 另开会话 | 不符合同步要求 |

mods 提供的相关能力（2.1.316 自带类型定义 `claude-code.d.ts` 与 `plugins/mods/*` 文档）：

- 发任务：`$.prompt.submit({ text })`，会话空闲后作为新回合执行；中断：`$.turn.abort({ turnId })`，`turnId` 取自 `turn.start`。
- 最终答案：`turn.complete` 的 `answer`（另有 `isAborted`、`durationMs`）；`session.start` 给出 `cwd`，`$.session.id()` 给出会话 ID。
- 审批与选择框：`tool.call` 钩子可以挂起工具调用，等结果后再 `next(e)` 放行或返回 `{ deny }`；也可以不调用 `next`、直接返回结果自行作答（`AskUserQuestion` 可用此方式由 Telegram 作答）。`tool.check` 可查询或给出 allow/ask/deny。
- 命令：`$.command.run` 等同用户手打 `/命令`，`$.command.list` 含内置命令；`$.command.register` 注册新命令。
- 本机通信：`$.http.fetch` 可走 Unix socket（`socketPath`），**单次最长 30 秒**（实测，超时中止），挂起等待不计入钩子预算。`$.process.spawn` 起的子进程随会话或模块重载结束；实测 Claude Code 退出时会结束它启动的全部进程（detached 也不例外）。
- 会话：`session.end` 在 `/exit` 时触发；`/clear` 也触发且之后没有 `session.start`。`$.process.run(['sh','-c','echo $PPID'])` 得到 Claude Code 主进程号，`$.env.get('TMUX_PANE')` 得到窗格；`/exit` 后 `--resume <会话 ID>` 续上同一会话（实测）。
- 定时与存储：`$.clock.every/after`、`$.store`（跨会话）、`$.fs`。
- 限制：钩子模块里没有 Node API；单个钩子预算 10 秒，等待 `next` 或 `$` 调用的时间不计入，`$.clock.sleep` 和自己的 promise 计入。

验证结论：

| 项目 | 结论 |
|---|---|
| 远程审批先答先得 | **实测可行**（11-01）：`classic.PermissionRequest` 钩子等待期间终端对话框照常显示；钩子返回 allow/deny 后对话框关闭；终端先答时钩子的 `next.signal` 中止，可收回 Telegram 按钮。 |
| `$.command.run` 执行内置命令 | 文档确认可以；实测 `/usage` 返回空并在终端弹出面板，打开交互界面的命令不适合从 Telegram 执行（`/usage` 改读 `$.session.usage()`）。 |
| 多个会话共用一个 Bot | 已实现：改用每个 Bot 一个常驻网关（见 4.1），不用选主。 |
| 选择框转到 Telegram | **实测可行**：`tool.call` 钩子先 `next(e)` 打开终端选择框，Telegram 先答时直接返回结果，终端选择框关闭。 |

其他：本机 Node 22.22 未编译 TypeScript 支持，不能直接运行 `.ts`，网关用 `tsc` 编译成 JS（`npm run build:claude` → `dist/`）运行；mod 由 Claude Code 加载，不受影响。

## 3. 三种 Agent 对比

| 项目 | Pi | Codex | Claude Code |
|---|---|---|---|
| 插件运行位置 | Agent 进程内 | Agent 进程外（连接常驻 app-server） | Agent 进程内（mod）+ 每个 Bot 一个常驻网关 |
| 接入同一会话 | 是 | 是（经 `thread/resume`） | 是（mod 本身就在会话里） |
| 审批先答先得 | 已实现 | 协议原生支持 | 已实现（`classic.PermissionRequest`） |
| 命令 | 宿主命令基本可用 | 需逐个映射到 RPC | `$.command.run` 可用；交互型（如 `/usage`）需改用数据接口 |
| 选择框和菜单 | 已实现（`lib/tui/`） | 要按 app-server 的请求类型重做 | 要按 mod 事件重做 |
| 多目录共用 Bot | `instance-coordinator` 选主 | 一个 bridge 进程即可服务全部目录 | 常驻网关按话题分发（已实现） |
| 主要风险 | 依赖 Pi 内部实现，升级易坏 | 接口标记为 experimental | mods 为早期接口，随版本变化 |

## 4. 架构方案

### 4.1 进程模型

- 每个 Agent 一个 Bot、一个论坛群，互不影响；**不需要跨 Agent 的总网关**。
- 同一个 Agent 在多个目录运行时，共用这个 Agent 的 Bot，仍需要「一个进程接收消息，再按话题分发」。
  - Pi：沿用 `instance-coordinator`。
  - Codex：所有会话都在同一个常驻 app-server 里，用**一个常驻 bridge 进程**连接 app-server，按 thread 的 `cwd` 对应话题即可，不需要选主。
  - Claude Code（阶段 4a 实现）：**每个 Bot 一个常驻网关**（`lib/claude/gateway/`，systemd --user 服务 `claude-telegram-gateway`，需 linger），它是该 Bot 唯一的拉取者，按启动目录建话题、按话题把消息分给会话。每个会话的 mod 经 Unix socket `~/.claude-telegram/gateway.sock` 直连网关：登记（`/open`，带 mod 每次加载生成的连接编号、目录、Claude 会话 ID、进程号、tmux 窗格）→ 反复挂起 20 秒取消息（`/poll`）→ 退出时注销（`/close`，`/clear` 不注销）。在线判断全在网关内存：取消息超时 60 秒或进程已不存在即移除；不用心跳文件、不用选主，自己的进程之间不会出现 409。同一目录同时只接一个会话。网关重启后会话自动重新登记（实测 2 秒内）。`/restart` 由网关起辅助程序（不在 Claude Code 进程树里），读 `/proc/<pid>/cmdline` 保留原参数，向同一 tmux 窗格输入 `claude … --resume <会话 ID>`。
  - 选型理由（11-02 与用户确认）：照搬 Pi 的文件锁选主要把复杂的交接逻辑再写一遍，交接慢且交接期会有 409；网关常驻约 26–95 MB、CPU 近零，会话不再各起一个约 95 MB 的 sidecar。Pi 暂不迁移，4b 再评估。
  - 代码：`lib/claude/mod/`（插件名 `agent2telegram`）与 `lib/claude/gateway/`；数据目录 `~/.claude-telegram/`；开发期别名 `ctg`（`claude --plugin-dir …/lib/claude/mod`）。

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
adapters/claude/        mod（钩子模块）+ 常驻网关（Node，systemd --user）
```

阶段 1 已完成第一步拆分：`lib/core/`（与 Agent 无关，24 个源文件；`core-boundary.test.ts` 禁止它引用 Pi 包或 `lib/core` 以外的文件）和 `lib/pi/`（Pi 专用，含 `tui/`、`commands/`、`context-budget/`）。数据目录统一由 `lib/core/data-dir.ts` 提供，Pi 默认仍是 `~/.pi/agent`。`forum-session`、`forum-transport`、`history-replay`、`menu-commands`、`attachments` 仍有 Pi 依赖，留在 `lib/pi/`，阶段 4 定型接口时再拆。

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

接口只在第二个适配器（Claude Code）落地时一起定型，避免只凭 Pi 一家抽象。

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
2. 一个 Bot 只给一个 Agent 用。**Claude 侧已实现（4a）**：网关启动时在 `~/.agent2telegram/bots/<token 哈希>.json` 登记归属，归属其他 Agent 或 Pi 运行目录里有存活实例在用这个 Bot 时拒绝接入；网关是唯一拉取者，第一次 409 视为交接 5 秒后重试，持续冲突则通知各会话并每分钟重试。**Pi 侧尚未登记与检查**，放到 4b。
3. `controller.ts` 职责混杂。
4. 路径写死：`/tg-setup` 入口指向 `/home/ubuntu/pi-telegram-plus-ex`，配置固定在 `~/.pi/agent`。
5. `context-budget` 放在 tg 插件里。
6. 关闭功能用的常量 `PROCESS_MESSAGES_ENABLED`、`STREAM_PREVIEW_ENABLED`，旧代码仍在，应改成配置项或删除。
7. 界面中英文混用。
8. 遗留：`scripts/e2e` 仍断言旧 `/quit`；`forum-multiprocess.test.ts` 偶发失败。

## 7. 分阶段计划（每阶段单独确认）

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | 修配对：过期、次数上限、仅私聊 | 离线测试；现有 1194 项不回退 |
| 1 | 在本仓库内整理目录：`lib/core/` 与 `lib/pi/`，不改行为；`config` 路径参数化；移出 `context-budget` | 离线测试全部通过；Pi 真机行为不变 |
| 2 | Claude Code 最小原型：mod + sidecar，单目录、单话题，完成发任务、最终答案、中断、正在输入 | **已完成**（a1954ca；sidecar 已在 4a 由网关取代） |
| 3 | Claude Code 补齐审批、命令、选择框（先答先得）、`/restart` | **已完成**（真机验收） |
| 4a | Claude Code 多目录共用 Bot：常驻网关（systemd --user）、mod 直连网关、Bot 归属登记与 409 处理 | **已完成**（11-02 真机两目录验收） |
| 4b | 定型 `AgentAdapter` 接口（Pi + Claude Code），Pi 改为实现该接口；Pi 侧 Bot 归属；评估 Pi 迁到网关 | 两个 Agent 都通过离线测试与真机验收 |
| 5 | Codex 适配器 | 用 Codex 专用 Bot 和新群真机验收 |
| 6 | 拆成独立包（core / pi / codex / claude），迁入 `~/plugins/Agent2Telegram` | 发布前另行确认 |

顺序调整（2026-11-01 用户确认）：原计划先做 Codex；Claude Code 已在本机安装、可以实测，改为先做 Claude Code，Codex 后移。

## 8. 需要决定的事项

1. 第 4 节架构：Claude Code 部分已确认并实现（mod + 常驻网关，TypeScript）；Codex 部分到阶段 5 再定。
2. 阶段顺序：已确认，见第 7 节。
3. 本机已安装 Claude Code 2.1.316，此项无需再决定。
4. Codex 和 Claude Code 的 Bot 与论坛群由你创建；Token 只在 SSH 中录入。

## 附：资料来源

- Codex：本机 `codex app-server generate-ts` 输出；`https://github.com/openai/codex`（main 分支）`codex-rs/app-server-daemon/README.md`、`codex-rs/app-server/README.md`、`codex-rs/app-server/src/thread_state.rs`、`codex-rs/app-server/src/outgoing_message.rs`、`codex-rs/app-server/src/request_processors/thread_processor.rs`。
- Claude Code：`https://code.claude.com/docs/en/` 下的 `channels`、`channels-reference`、`plugins/mods/overview`、`plugins/mods/reference`、`plugins/mods/api`、`plugins/mods/events`、`hooks`、`remote-control`、`headless`。
- 下载的原文保存在 `~/.cache/pi-telegram/scratch/`。
