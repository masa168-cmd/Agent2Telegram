# Agent2Telegram

在 Telegram 里操作本机正在运行的 AI 编程 Agent：**每个 Agent 一个 Bot、一个论坛群，每个工作目录一个话题**。Telegram 与终端里是**同一个**会话，两边都能发任务、看回复、中断、答复审批和选择题，先答的一方生效。

目前支持：

| Agent | 状态 | 接入方式 |
| --- | --- | --- |
| [Pi coding agent](https://pi.dev) 1.4.0 | 可用 | Pi 扩展 + 常驻网关 |
| [Claude Code](https://code.claude.com) 2.1.316+ | 可用 | Claude Code 插件（mod）+ 常驻网关 |
| Codex | 计划中 | — |

## 安装

需要 Linux、Node.js ≥ 22.19、npm、curl。

```bash
curl -fsSL https://raw.githubusercontent.com/masa168-cmd/Agent2Telegram/main/install.sh | bash
```

安装脚本会询问接入哪些 Agent（也可加参数：`… | bash -s -- --pi --claude`），然后：

- 把程序装到 `~/.agent2telegram/app`，在本机安装依赖并编译；
- 建立命令 `a2t`（`~/.local/bin/a2t`）；
- Claude Code：把插件装成本地插件（直接从 `~/.agent2telegram/app` 读取）；
- 安装用户级 systemd 服务 `agent2telegram-gateway`：一个常驻网关，替所有 Agent 的 Bot 收消息，再按话题分给对应会话（旧版本的 `agent2telegram-claude` 服务会被替换）。

**脚本不会询问或保存 Bot Token。** 重复运行同一条命令即是升级，配置和数据不受影响。

> 网关是 systemd 用户服务。要在 SSH 全部断开后仍然运行，需要开启 linger：`loginctl enable-linger $USER`。

## 配置

1. 在 [@BotFather](https://t.me/BotFather) 为每个 Agent 各建一个 Bot；各建一个**开启话题（Topics）的私密超级群**，把对应 Bot 设为管理员，并给「管理话题」权限。
2. 在终端运行（Token 只在这里输入，输入时不显示）：

   ```bash
   a2t setup pi        # 或
   a2t setup claude
   ```

   需要填：Bot Token、论坛群 ID（以 `-100` 开头：复制群里任意消息的链接 `t.me/c/<数字>/…`，在 `<数字>` 前加 `-100`）、你的 Telegram 用户 ID（必填，私聊 [@userinfobot](https://t.me/userinfobot) 可查到；只有这个账号能操作 Agent）。

   每个 Agent 只能有一个 Bot；重新运行 `a2t setup` 就是更换。Bot 只在这里配置，Agent 里不再管理 Bot。

3. 配置后重启网关：`a2t gateway restart`。

## 按目录开启

只有开启过的目录才会接入 Telegram（子目录跟随父目录）：

```bash
cd ~/my-project
a2t enable pi       # 之后在该目录启动的 pi 会接入
a2t enable claude   # 该目录的 Claude Code 会话约 30 秒内自动接入
```

`a2t disable pi|claude [目录]` 关闭：正在运行的会话约 10 秒内断开，话题里会提示；再 `a2t enable` 后约 30 秒内自动接回，不用重启。群里会为每个目录自动建一个话题，话题名是目录名；同一目录同时只接一个会话。

## 在 Telegram 里使用

在对应目录的话题里直接发文字，就是给 Agent 发任务；回合结束后最终回复发回话题，工作期间显示「正在输入…」。

**Claude Code** 话题里的 `/` 菜单：

| 命令 | 作用 |
| --- | --- |
| `/stop` | 中断当前回合 |
| `/compact` | 压缩上下文 |
| `/clear` | 清空对话 |
| `/usage` | 5 小时与每周用量、重置时间、本会话花费 |
| `/restart` | 重启 Claude Code 并接回同一会话，保留原启动参数（仅当它运行在 tmux 窗格里） |

- **审批**：Claude 请求权限时，话题里出现「✅ 允许 / ❌ 拒绝」；终端的审批框同时存在，先答的一方生效，另一边自动收回。
- **选择题**：按选项出按钮，另有「✏️ 自定义输入」（下一条文字即答案）和「💬 先聊聊」；多个问题逐题提问。
- 终端里来自 Telegram 的消息会标注 “Prompt from the agent2telegram plugin”，Claude 读到的是你的原话。

**Pi** 的命令、菜单与话题规则见 [docs/pi.md](docs/pi.md)。

## a2t 命令

| 命令 | 作用 |
| --- | --- |
| `a2t status` | 查看安装、网关、已开启的目录 |
| `a2t setup <pi\|claude>` | 配置 Bot |
| `a2t enable / disable <pi\|claude> [目录]` | 按目录开启 / 关闭 |
| `a2t gateway <restart\|status\|logs>` | 网关服务（Pi 与 Claude Code 共用） |
| `a2t migrate [--apply]` | 迁移旧版本数据（默认只列清单；执行前自动备份） |
| `a2t uninstall` | 卸载插件、服务；配置与数据保留 |

## 数据位置

全部在 `~/.agent2telegram/`（可用环境变量 `AGENT2TELEGRAM_DIR` 改位置）：

```text
~/.agent2telegram/
  app/       程序
  bin/a2t    命令行
  pi/        Pi 的 Bot 配置 tg.json、话题记录、目录绑定、日志、网关 socket
  claude/    Claude Code 的 Bot 配置、话题记录、已开启目录、网关 socket
  bots/      每个 Bot 归属哪个 Agent（同一个 Bot 不会被两个 Agent 同时使用）
  cache/     Telegram 发来的附件
  backup/    a2t migrate 的备份
```

宿主程序只认固定位置的东西都只是指向 `app` 的入口：Pi 的 `<目录>/.pi/extensions/agent2telegram.ts`、Claude Code 的插件登记、`~/.config/systemd/user/agent2telegram-gateway.service`、`~/.local/bin/a2t`。

## 安全须知

- **白名单只限制谁能操作，不限制谁能看。** 群里其他成员能看到回复和附件，请用只有你和 Bot 的私密群。
- Token 只存在本机配置文件里（权限 600），不要发到聊天里或提交到仓库。
- 插件以 Agent 进程的权限运行，不是沙箱。

## 开发

```bash
git clone https://github.com/masa168-cmd/Agent2Telegram.git && cd Agent2Telegram
npm ci
npm run check:offline        # 全部离线测试 + 类型检查（隔离 HOME，不连网）
A2T_SOURCE="$PWD" bash install.sh   # 从本地源码安装
```

设计与阶段计划见 [DESIGN.md](DESIGN.md)。

## 来源与许可

MIT。Pi 部分以 [pi-telegram-plus](https://github.com/jalyfeng/pi-telegram-plus)（jalyfeng）为基础，参考了 [pi-telegram-mux](https://github.com/hkfires/pi-telegram-mux) 的设计；详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
