# Agent2Telegram 设计

状态：阶段 0、1、2、3、4a 与「打包与安装」已完成（Claude Code 经网关接入、多目录共用 Bot、一行命令安装，均已真机验收，已推送 masa168-cmd/Agent2Telegram）；下一步 4b。日期：2026-11-02。

## 1. 目标与约束

- 以 `pi-telegram-plus-ex` 现有行为为标准，把同样的 Telegram 使用体验扩展到 **Codex** 和 **Claude Code**。
- 标准体验的核心：Telegram 与终端里**同一个**正在运行的会话同步；一个启动目录对应一个论坛话题；能发任务、看最终答案、中断、答复审批和选择框、执行常用命令；「正在输入…」表示仍在工作。
- 每个 Agent 用**自己的 Bot**，并且**各用各的论坛群**。不同 Agent 之间不共用 Bot，也不共用群。

## 2. 调查结论

### 2.1 Pi（现状，基准）

插件作为 Pi 扩展运行在 Pi 进程内，直接操作会话、命令和终端界面（`lib/pi/session-capture.ts`、`lib/pi/tui/`）。同一个 Bot 被多个目录的 Pi 共用时，由 `lib/core/instance-coordinator.ts` 选出一个进程接收消息并转发给对应话题的进程。各目录经 `a2t enable pi` 写入一行入口 `<目录>/.pi/extensions/agent2telegram.ts`（指向 `~/.agent2telegram/app/index.ts`）。

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

11-02 只读调查补充（codex-cli 0.166.0）：

- 共享 app-server 的控制 socket 在 `~/.codex/app-server-control/app-server-control.sock`（指向 `/tmp/codex-daemon-1000/…`），**协议是 Unix socket 上的 WebSocket**（HTTP Upgrade 后每条 JSON-RPC 一帧），不是逐行 JSON；`codex app-server proxy` 只转发字节。实测：`initialize`（`clientInfo`、`capabilities.experimentalApi`）→ `initialized` 通知 → `thread/loaded/list`、`thread/list`、`thread/read`（`includeTurns:false`）均可用；连接后会收到 `remoteControl/status/changed`、`account/updated`。
- 调查时没有已加载的会话（`thread/loaded/list` 为空）。最近 5 个会话都是 `source: vscode`（目录 `~/codex-main`、`~/CPA`）：`thread/list` 读的是磁盘上的记录，不说明 VS Code 插件的活会话是否跑在共享 app-server 里（VS Code 插件可能自带 stdio app-server）。**能否看到并加入 VS Code / 终端里正在运行的会话，需要真机确认。**
- 审批：官方 README 说审批只发给「有能力的客户端」，无人能答时命令被拒；断线重连会重放待答审批。是否同时发给终端与网关（先答先得）仍需真机确认。
- 斜杠命令可映射的 RPC：`turn/interrupt`（/stop）、`thread/compact/start`（/compact）、`model/list` 与 `thread/resume` 的 `model` 覆盖（/model）、`account/rateLimits/read`（用量）、`turn/steer`（插话）。
- 本机早期自制插件 `codex-telegram-bridge`（用第三个 Bot、自起 stdio app-server）已于 11-02 经用户批准停止并删除；`~/.codex/config.toml` 只删其两段配置（备份在 `~/.agent2telegram/backup/`）。

11-02 真机确认（用户在 tmux 里于 `~/main-codex` 运行 `codex`）：

- 终端会话跑在共享 app-server 里：`thread/loaded/list` 能看到，`thread/read` 给出正确 `cwd`（`source` 显示为 `vscode`，不能用来区分终端与 VS Code）。
- 外部连接 `turn/start` 发「只回复 OK」：Codex 约 3 秒回复 `OK`，**终端同步显示了这条输入和回复**；`turn/interrupt` 有效（turn 状态 `interrupted`），终端也显示。
- **新会话还没对话过时 `thread/resume` 报 `no rollout found`**（尚未落盘），收不到事件；但 `turn/start` 照样成功，回合结束后用 `thread/read`（`includeTurns:true`）可取到最终回复。落盘后 `thread/resume` 成功，能收到 `turn/started`、`item/*`、`turn/completed`。
- 未订阅时也能收到 `thread/status/changed`、`thread/started`、`thread/closed`；Codex 起名字时会临时加载一个同目录的辅助 thread（约 60 秒后 `thread/closed`），发现会话时需过滤。
- 该会话 `approvalPolicy: never`、`sandbox: dangerFullAccess`：没有协议审批。用户的审批写在 `~/.codex/AGENTS.md`（先出计划、等确认），即**在对话里用文字审批**，Telegram 回复文字即可，第一版不做审批按钮。

未确认：

- `thread/started` 是否对所有连接都广播（实测收到过一次，但当时本连接刚发过 `turn/start`）；实现时以轮询 `thread/loaded/list` 为准。
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

### 4.1 进程模型（4b 起：一个网关服务所有 Agent）

- 每个 Agent 一个 Bot、一个论坛群，互不影响；同一个 Agent 在多个目录运行时共用这个 Bot，每个目录一个话题。
- **一个常驻网关进程** `lib/gateway/main.ts`（systemd --user 服务 `agent2telegram-gateway`，需 linger）为每个已配置的 Agent 各开一个收件循环和一个 Unix socket `<该 Agent 数据目录>/gateway.sock`。它是各 Bot 唯一的拉取者，按启动目录建话题、按话题把消息分给在线会话；话题对照表与收件游标按 Agent 分开保存（Pi：`pi/tg-runtime/<tokenHash>/`；Claude：`claude/runtime/`）。
- 会话与网关的协议（即 4b 定型的「适配器接口」，见 4.4）：登记 `/open`（连接编号、目录、会话 ID、进程号、tmux 窗格）→ 反复挂起 20 秒取消息 `/poll` → 退出注销 `/close`。在线判断全在网关内存：取消息超时 60 秒或进程已不存在即移除；同一目录只接一个会话，同一会话重新登记会顶替旧连接；网关重启后会话自动重新登记。不用心跳文件、不用选主，自己的进程之间不会出现 409。
- 两种接入方式（`BotGateway` 的 `mode`）：
  - **thin（Claude Code）**：网关解析消息与按钮，向会话发 `prompt / abort / command / usage / restart` 等事件；回复、审批、选择框经 `/turn-complete`、`/prompt`、`/wait` 等由网关代发。只有 `a2t enable claude` 开启过的目录才登记成功。`/restart` 由网关起辅助程序，读 `/proc/<pid>/cmdline` 保留原参数，向同一 tmux 窗格输入 `claude … --resume <会话 ID>`。
  - **rich（Pi）**：网关只校验群与用户，把话题内的原始 update 原样交给 Pi（`{type:"update"}`），Pi 沿用原有处理并**自己直接发送**；按钮回调按话题或 Pi 上报的按钮消息 ID 路由。私聊不操作 Agent，只回一句提示。
- Codex（阶段 5，2026-11-02 实现）：所有终端会话都在 Codex 的共享 app-server 里。网关自己当客户端（`lib/gateway/codex.ts`），不往 Codex 里装东西：每 5 秒 `thread/loaded/list`，跳过 `ephemeral` 或带 `parentThreadId` 的辅助 thread；已开启目录（`~/.agent2telegram/codex/projects.json`）的 thread 用 thin 模式 `open` 进 BotGateway，`thread/resume` 订阅事件。话题文字 → `turn/start`（忙时 `turn/steer`）；`/stop` → `turn/interrupt`，`/compact` → `thread/compact/start`，`/usage` → `account/rateLimits/read`；`turn/started` → 正在输入，`turn/completed` → 最终回复（终端发起的回合也发）。未落盘的新 thread 无法订阅：发出 `turn/start` 后等 `thread/status/changed` 变 idle，再 `thread/read` 取结果并重试订阅。thread 卸载或 `thread/closed` → 关闭会话；app-server 断开 → 关闭全部会话，5 秒后重连。不做协议审批（终端处理）；`/clear`、`/restart`、`/model` 不支持。
- 选型理由（11-02 与用户确认）：文件锁选主要写复杂的交接逻辑，交接慢且交接期会有 409；网关常驻约 26–95 MB、空闲时 CPU 近零。4b 把 Pi 从「实例间选主 + 本机转发」改为接入同一网关，删除了 `instance-coordinator`、`forum-router`、`polling`、历史回放与 Pi 私聊模式。
- 代码：`lib/gateway/`（通用网关）、`lib/claude/mod/`（Claude 插件 `agent2telegram`）、`lib/pi/gateway-client.ts` 与 `lib/pi/forum-session.ts`（Pi 客户端）。

### 4.2 安装与目录（2026-11-02 实现）

- 一行安装或升级：`curl -fsSL https://raw.githubusercontent.com/masa168-cmd/Agent2Telegram/main/install.sh | bash`。脚本下载源码到暂存目录，`npm ci` 并编译（`npm run build:claude`），原子替换 `~/.agent2telegram/app`，链接 `~/.local/bin/a2t`，再交给 `a2t post-install`（Claude 插件、网关服务 `agent2telegram-gateway`，并移除旧服务 `agent2telegram-claude`、`claude-telegram-gateway`）。不经手 Token。`A2T_SOURCE` 可从本地源码安装，`A2T_SKIP_SYSTEMD=1` 跳过服务（沙盒测试用，systemd --user 按用户而非 HOME 生效）。
- 全部配置与数据集中在 `~/.agent2telegram/`（`$AGENT2TELEGRAM_DIR` 可改）：`app/`、`bin/`、`bots/`（Bot 归属）、`pi/`（tg.json、tg-runtime、`projects/<目录哈希>.json` 目录绑定、logs、gateway.sock）、`claude/`（tg.json、runtime、projects.json 已开启目录、gateway.sock）、`cache/`（附件）、`backup/`。Pi 自己的会话仍在 `~/.pi/agent`。
- Pi 数据目录优先级：显式 `PI_CODING_AGENT_DIR` > `$AGENT2TELEGRAM_DIR/pi` > `~/.agent2telegram/pi`；未迁移时若只有旧 `~/.pi/agent/tg.json` 则继续用旧目录，目录绑定也先读新位置、再读旧 `.pi/telegram.json`，只写新位置，保证升级不掉线。
- `a2t`：`status`、`setup <pi|claude>`（终端交互，从 /dev/tty 读）、`enable|disable <pi|claude> [目录]`、`gateway <restart|status|logs>`、`migrate [--apply]`（先列清单；Pi 或网关在运行时拒绝；tar 备份；不覆盖；主目录旧入口等列为待定）、`uninstall`（保留数据）。
- 宿主只认固定位置的入口保留为指向 app 的链接或一行入口：Pi 的 `.pi/extensions/agent2telegram.ts`、Claude 插件登记、`~/.config/systemd/user/agent2telegram-gateway.service`、`~/.local/bin/a2t`。
- 包名、插件名统一为 `agent2telegram`；会话记录里的内部类型名（如 `pi-telegram-plus-ex.forum-binding`）保持不变，以便读取旧记录。

### 4.3 代码分层

```text
telegram-core/          与 Agent 无关
  telegram-api, markdown, text-split, rich-message,
  forum-transport, forum-binding, config（路径可配置）, logger,
  heartbeat, callback-protocol, menu 键盘, attachments 收发
gateway/                网关（4b：polling、话题、路由都在这里），接口见 4.4
adapters/pi/            现有 session-capture、tui/、命令、renderer 的 Pi 部分
adapters/codex/         app-server 客户端 + 事件映射 + 命令映射
adapters/claude/        mod（钩子模块）+ 常驻网关（Node，systemd --user）
```

阶段 1 已完成第一步拆分：`lib/core/`（与 Agent 无关，24 个源文件；`core-boundary.test.ts` 禁止它引用 Pi 包或 `lib/core` 以外的文件）和 `lib/pi/`（Pi 专用，含 `tui/`、`commands/`、`context-budget/`）。数据目录统一由 `lib/core/data-dir.ts` 提供，Pi 默认仍是 `~/.pi/agent`。`forum-session`、`forum-transport`、`menu-commands`、`attachments` 仍有 Pi 依赖，留在 `lib/pi/`。4b 新增 `lib/gateway/`，原 `lib/claude/gateway/` 移入。

拆分前的调查结论：`lib/` 顶层约 26 个文件、4,500 行不直接依赖 Pi，是 `telegram-core` 的候选。但其中 `config.ts` 写死了 `~/.pi/agent`，`forum-policy.ts` 引用了 Pi 的对话框模型，需要先改。`controller.ts`（1,882 行）同时负责消息路由、命令分发和 Pi 界面路由，是拆分的主要工作量。`lib/context-budget/` 与 Telegram 无关，应移出（11-03 决定保留，见第 6 节第 5 条）。

### 4.4 适配器接口

4b 定型（11-02）：**接口就是 4.1 的网关 socket 协议**，不再做进程内的 `AgentAdapter` 抽象。thin 接入用网关解析好的事件，rich 接入拿原始 update 自己处理，新 Agent 按能力选一种。以下为最初草案，仅作对照：

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


## 5. 配对与授权

4c（11-02）起不再配对：`a2t setup` 必填你的 Telegram 用户 ID（`allowedUserId`），网关和 Agent 只认这个账号。用户 ID 不是秘密，但别人无法以你的账号发消息，所以直接填写与配对同样安全；填错的后果是谁都无法操作，重新 `a2t setup` 即可。没有用户 ID 时网关不收该 Bot 的消息。配对码、`/pair`、`lib/core/pairing.ts` 已删除（阶段 0 的配对加固随之不再适用）。尚未做：多用户。

## 6. 现有插件中需要处理的设计问题

按风险从高到低：

1. 依赖 Pi 内部实现（`session-capture` 替换退出处理、`tui/` 读组件内部字段）。拆分改变不了，靠契约测试和版本检查兜底。
2. 一个 Bot 只给一个 Agent 用。**Claude 侧已实现（4a）**：网关启动时在 `~/.agent2telegram/bots/<token 哈希>.json` 登记归属，归属其他 Agent 或 Pi 运行目录里有存活实例在用这个 Bot 时拒绝接入；网关是唯一拉取者，第一次 409 视为交接 5 秒后重试，持续冲突则通知各会话并每分钟重试。4b 起网关对每个 Agent 都做同样的登记与检查（Pi 也一样）。
3. `controller.ts` 职责混杂。
4. ~~路径写死~~：已解决（打包与安装）。入口由 `a2t enable` 生成并指向安装目录，配置集中到 `~/.agent2telegram/`。
5. `context-budget` 放在 tg 插件里：11-03 决定保留、不移出。它借用插件捕获的 Pi 会话和 Telegram 操作核对来改压缩阈值，且是 Pi 1.4.0 的版本专用适配；移出需另做会话捕获并重新真机验收，功能上没有收益。
6. ~~关闭功能用的常量 `PROCESS_MESSAGES_ENABLED`、`STREAM_PREVIEW_ENABLED`，旧代码仍在~~：已解决（11-03）。两个常量连同「⚙️ 过程」合并消息、流式预览的发送/编辑/删除一并删除，合并重复的 `agent_start` 处理；保留「最终答案发送租约」（回复首次流出文本时记录，结束时核对）。删除前先补行为测试。
7. 界面中英文混用。
8. 遗留：`scripts/e2e/run-e2e-commands.mjs` 已改为检查 Telegram 拒绝 `/quit`、`/exit`（该脚本需真实 Pi，未运行）。`forum-multiprocess.test.ts` 随 4b 删除多实例选主一并删除。
9. 4b 收尾（11-02）：会话接入时网关先「重开」记录的话题——已关闭的重开，已删除的新建一次，其他错误（如网络）沿用原话题、不阻止接入；Pi 与 Claude 共用。一个 Agent 只能有一个 Bot：`addBot` 已有 Bot 时拒绝，Pi 的 `/tg → Bots` 只在没有 Bot 时显示「添加」，删除「默认 Bot」选择与清除、目录绑定到其他 Bot 的流程；目录绑定里旧的 `botId` 被忽略，Pi 与网关用同一规则选 Bot（默认，否则第一个）。
10. 4c（11-02）：Bot、用户 ID 只由 `a2t setup` 管，目录接入只由 `a2t enable/disable` 管。Pi 的 `/tg` 删除 Bots、Project 两项及相关流程，只保留 Commands、Config、Online sessions、Debug info；目录绑定里旧的 `enabled:false` 被忽略。`a2t disable` 后网关在取消息或每 10 秒检查时断开该目录的会话并在话题提示，`a2t enable` 后会话约 5 秒内自动重新登记（被拒绝的会话每 5 秒重试）（Pi 按目录及上级目录是否有入口判断，Claude 按已开启列表）。

## 7. 分阶段计划（每阶段单独确认）

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | 修配对：过期、次数上限、仅私聊 | 离线测试；现有 1194 项不回退 |
| 1 | 在本仓库内整理目录：`lib/core/` 与 `lib/pi/`，不改行为；`config` 路径参数化；移出 `context-budget`（11-03 决定不移出） | 离线测试全部通过；Pi 真机行为不变 |
| 2 | Claude Code 最小原型：mod + sidecar，单目录、单话题，完成发任务、最终答案、中断、正在输入 | **已完成**（a1954ca；sidecar 已在 4a 由网关取代） |
| 3 | Claude Code 补齐审批、命令、选择框（先答先得）、`/restart` | **已完成**（真机验收） |
| 4a | Claude Code 多目录共用 Bot：常驻网关（systemd --user）、mod 直连网关、Bot 归属登记与 409 处理 | **已完成**（11-02 真机两目录验收） |
| 4b | Pi 接入同一网关（rich），一个网关进程服务所有 Agent；接口定为网关协议；删除 Pi 选主、本机转发、历史回放、私聊模式 | **已完成**（11-02 本机切换，Pi 与 Claude 真机收发、`/restart` 通过） |
| 5 | Codex 适配器 | 用 Codex 专用 Bot 和新群真机验收 |
| P | 打包与安装（提前于 4b 完成）：`~/.agent2telegram/`、`a2t`、`install.sh`、数据迁移、改名 agent2telegram、迁入 `~/plugins/Agent2Telegram` 并推送 | **已完成**（11-02 本机切换与一行安装真机验收） |
| 6 | 拆成独立包（core / pi / codex / claude） | 发布前另行确认 |

顺序调整（2026-11-01 用户确认）：原计划先做 Codex；Claude Code 已在本机安装、可以实测，改为先做 Claude Code，Codex 后移。

## 8. 需要决定的事项

1. 第 4 节架构：Claude Code 部分已确认并实现（mod + 常驻网关，TypeScript）；Codex 部分 2026-11-02 确认并实现（网关直连共享 app-server，见 4.1）。
2. 阶段顺序：已确认，见第 7 节。
3. 本机已安装 Claude Code 2.1.316，此项无需再决定。
4. Codex 和 Claude Code 的 Bot 与论坛群由你创建；Token 只在 SSH 中录入。

## 附：资料来源

- Codex：本机 `codex app-server generate-ts` 输出；`https://github.com/openai/codex`（main 分支）`codex-rs/app-server-daemon/README.md`、`codex-rs/app-server/README.md`、`codex-rs/app-server/src/thread_state.rs`、`codex-rs/app-server/src/outgoing_message.rs`、`codex-rs/app-server/src/request_processors/thread_processor.rs`。
- Claude Code：`https://code.claude.com/docs/en/` 下的 `channels`、`channels-reference`、`plugins/mods/overview`、`plugins/mods/reference`、`plugins/mods/api`、`plugins/mods/events`、`hooks`、`remote-control`、`headless`。
- 下载的原文保存在 `~/.agent2telegram/cache/scratch/`。
