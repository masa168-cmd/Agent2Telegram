# 兼容性、离线证据与待验收项

本文针对 `pi-telegram-plus-ex@0.1.0` 离线验证候选，不继承上游 README 对发布、OMP 或真实 E2E 的验收结论；源码提交或同步不代表 npm 发布、部署或真实运行验收。

## 版本边界

| 对象 | 当前结论 |
| --- | --- |
| Pi coding agent | 目标 `@earendil-works/pi-coding-agent` **1.4.0**；peer/dev 固定此版本 |
| Node.js | 清单要求 `>=22.19.0`；本机离线使用 22.22.1 |
| OMP | 保留上游 18.12.x 适配和测试源码；本 fork 的论坛生命周期、真实 UI 和运行未验收，**不声明支持** |
| 其他 Pi 版本 | 不声明兼容；必须重新核对宿主源码和测试 |
| Telegram / 模型 | 本轮只模拟接口，没有连接真实 Bot、模型、服务或运行中的 Pi |

### 本轮实际结果（D4，本地候选）

- 完整离线回归：**79 个测试文件 / 995 项测试通过**；`tsc --noEmit` 与 changelog 版本检查通过。
- 其中新增 D4 定向覆盖为 4 文件 / 16 项；不是 16 次真实 Bot 或真实 Pi 验收。
- npm 禁脚本、离线 dry-run 清单：**78 个文件**，源码/文档/来源声明齐全，未包含测试工作区、依赖、测试夹具、运行时数据、日志或进度记录；没有生成发布包或发布到 npm。
- 单独自检确认外部 fetch/socket 在连接前被阻止；最终全套检查没有外部连接拦截记录。没有装载现有 Pi，没有真实 Telegram/模型调用。

上游 TUI bridge 保留自己的版本门禁；“源码允许的版本”不等于“本 fork 完成了真实宿主验收”。入口保留同步工厂，宿主模块通过 type import 或受保护的动态解析加载。

### 上下文预算新增验证（本地源码，真实验收另行进行）

D1/D2 历史交付（2026-10-28）`npm run check:offline`：**82 个文件 / 1124 项通过**，类型与 changelog 检查通过；含既有 F1 回归及本功能新增 110 项。安装版 Pi 1.4.0 官方装载器在隔离进程中加载入口、验证命令/事件注册和缺失会话拒绝路径通过；未触发 `session_start`、创建真实 AgentSession/ModelRuntime、加载真实凭据或连接 Telegram/模型。两次最终检查的外网 guard 均无拦截记录，不等于 OS 沙箱或真实运行验收。

- `context-budget-config.test.ts`：合成项目中的精确 cwd、schema/整数、0600 原子保存、并发版本冲突、符号链接拒绝、锁/写入失败与运行回退；不读真实配置。
- `context-budget-runtime.test.ts`：真实 SDK **SettingsManager.inMemory** 和 `shouldCompact` 配合合成 Provider，验证严格阈值、多模型/类型/接口保留、实例级读取适配、普通设置保存后阈值保持、过期窗口拒绝、退出及重复装卸恢复。没有真实账号/模型请求，也没有在运行中 Pi 替换方法。
- `context-budget-command.test.ts`、`controller-command-routing.test.ts`、`forum-entry.test.ts`：共享菜单、取消/并发/忙碌/过期确认、恢复默认待重载、下划线命令归一、实际扩展入口配模拟 Telegram 的用户/话题隔离及回读通知。手机真实显示和输入体验仍未验收。
- 模型列表修正回归：真实 SDK 同步 `ModelRegistry` 外观配合虚构认证快照，验证只取可用聊天模型，不走异步认证/刷新；空列表不退回完整目录，当前模型仅在可用时前置，未列出规则保留并可单独删除，确认期间可用性变化拒绝写入，`status` 独立读取实际值。
- `context-budget-picker.test.ts`：真实 SDK `SelectList` 及 regular/fullscreen 两种 TUI 渲染器，使用虚构终端/主题数据测试 1000 项连续双向移动、小屏、缩放、首尾、中文/长名称和单次完成；现有 DialogBroker 配模拟 Telegram 测远端分页、错误话题/过期按钮、双端先答及取消。不是抓取真实终端画面，不发 Bot 请求。
- Pi 1.4.0 的普通 `ui.select()` 没有滚动窗口；预算长列表改用官方 `ui.custom()` + `SelectList`。组件显式提供现有适配器可读取的列表，Telegram 经同一组件按键路径回答；后续短动作/input/confirm 保持标准接口及既有竞答。没有修改 Pi 核心、通用桥接或 F1 文件；这不修复其他扩展的长选择框。
- 修正前的 `applyOverrides` 方案在真实 SDK 保存默认模型或主题后把预留量恢复为 16384，窗口却仍为 1050000；两个对应回归必须保持正确阈值，不能删掉断言或只测模拟模型 getter 切换。

**适配限制**：仅 Pi 1.4.0、捕获的当前会话实例；包装公开 `getCompactionReserveTokens(model)`，不改 prototype、私有字段、原生 settings 文件或 Pi 安装代码。核心 `getCompactionSettings(model)` 经该方法读取派生余量；`pi.getSettings()` 仍是原生快照。方法/Provider 所有权变化时拒绝覆盖，退出时不撤别人的包装；本包装即使被别人持有，停用后也只委托原方法。该机制不是官方扩展钩子的跨版本承诺。

本节记录离线证据。无 Bot 临时实例的原生试用暴露了完整目录和长列表问题，不能以历史 1124 项通过代替修正后的回归；修正版的原生续验与手机验收仍需完成。未切换开发 Pi 或恢复测试 A，未删除旧项目 settings/long-context。新旧实现需成对切换并单独验证加载与实际阈值；服务端是否接受指定长上下文不由离线测试或本地窗口声明证明。

## 本 fork 的离线检查如何运行

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check:offline
```

第一条仅准备项目依赖；检查命令不会安装软件。`scripts/offline-check.mjs` 对子进程使用最小环境，不继承 Token、代理、模型凭据或原有 NODE_OPTIONS；HOME、PI_CODING_AGENT_DIR、TMPDIR、npm 配置/缓存都在项目 `.test-work/`。`scripts/offline-network-guard.mjs` 阻止非 loopback 的 fetch/socket 连接并记录 `blocked-network.log`。临时测试数据只在自建目录内清理。

这是测试防误连措施，**不是针对恶意依赖或任意原生命令的操作系统网络沙箱**。不要给测试注入真实凭据或使用真实 agent 目录。两个 Node peer 使用现有 TypeScript devDependency 的专用 loader，不要求服务器 Node 编译了原生 TypeScript 支持，不启动 Pi CLI、tmux、守护进程或模型服务。

命令顺序为全套 Vitest → `tsc --noEmit` → changelog 版本检查；失败即退出。普通 `npm test` 是上游兼容入口，不自动提供同等环境隔离。打包清单须另外用禁脚本、离线的 `npm pack --dry-run --json --ignore-scripts --offline` 审查，不代表发布。

## 验证覆盖及其含义

| 覆盖 | 证据位置 | 能证明什么 / 不能证明什么 |
| --- | --- | --- |
| 绑定与会话分支 | `forum-binding.test.ts`、`forum-persistence.test.ts` | 使用真实公开 SessionManager 和虚构会话验证首条 user 消息落盘、reopen、tree/compact 保留、fork/clone/new 隔离、in-memory 不伪造文件；不运行真实模型或原生会话选择器 |
| 单 Bot、多在线会话 | `forum-coordinator.test.ts`、`forum-multiprocess.test.ts` | 两个独立 Node 测试进程，共享私有协调目录，经真实 loopback HTTP 路由；命令、模型/思考量、压缩计数、停止、文件、按钮与流式编辑各归各话题；宿主/model/Telegram 为模拟对象 |
| 退出和故障 | 同上及 `forum-session.test.ts` | 只终止自建测试子进程；剩余接收者重选，旧话题不启动新 Pi；覆盖重复占用、失效代次、过期租约、话题删除、创建未知和迟到结果 |
| 扩展入口联调 | `forum-entry.test.ts` | 真实 `index.ts` 接真实配置文件/游标、控制器、论坛层及模拟 fetch；从真实 polling batch 的 update 上下文 checkpoint，验证正文编辑、错误用户/话题、游标故障不转发、收件资格与发送资格分离 |
| 文件与下载 | 同上、`forum-transport.test.ts`、上游附件测试 | 虚构下载保存到捕获 cwd，随机清理文件名；退出后迟到下载不写文件、不提示模型；输出/编辑/图片/typing 的 thread 围栏；不证明真实 Telegram 文件大小、权限和移动端体验 |
| 助手正文流式 | `forum-streaming.test.ts` | token 路径不等待 Bot IO，1 秒限频、600 Unicode 字符预览、完整最终替换/长结果发送、secret-store 脱敏、旧消息不迁移到新代次；不证明真实网络的延迟或限流体验 |
| UI 与敏感边界 | `forum-controller.test.ts`、`tui-broker.test.ts`、`tg-menu.test.ts` 等 | 非敏感本地/远程交互、先回答者生效、旧回调、禁止群 Shell、登录留 SSH、分享/退出确认及在线话题链接；不证明任意第三方 custom TUI 可读或安全 |
| 上下文预算 | 上述 `context-budget-*.test.ts` 及命令/论坛入口测试 | 精确窗口/阈值与实例级方法恢复、普通设置保存后保持、持久数据和授权回归；不证明原生 TUI/真实 Telegram、账号容量或实际长输入 |
| 上游回归 | 其他 `lib/core/__tests__/*.test.ts`、`lib/pi/__tests__/*.test.ts` | 原有命令、队列、渲染、Markdown、TUI adapters 等模块回归；其中 OMP mock 用例通过不转化为本 fork 的 OMP 支持承诺 |

测试位于 `lib/core/__tests__/`（与 Agent 无关）和 `lib/pi/__tests__/`（Pi 专用）。测试 ACK、状态计数和 mock 断言只表示对应离线层级通过，不包装成“手机已验证”。

## UI 与秘密的限制

- 已识别的 select/confirm/input/editor、模型/会话选择器和适配的设置/审批，读取结构化模型并经宿主输入路径回答，不解析抓屏来猜操作。
- 本地非敏感弹窗只有在明确话题有效时才镜像；未知组件仅提示不支持，回 SSH 操作。凭据流程的标题、内容、URL 和预填不会作为论坛弹窗展示。
- 凭据识别依赖已知组件/标题/secret 元数据，不是任意内容的秘密扫描。上游 SecretStore 只追踪其显式登记的值，且有长度/寿命限制；普通聊天、模型或工具输出的秘密不保证被识别。论坛模式避免在手机上采集密钥，而不是宣称可以安全发送密钥。
- 私密群和用户白名单不能防止有读权限的成员看消息，也不能收回已经发送的内容。
- `/tg` 在论坛模式不提供 Bot/Project 全局维护入口；通过 SSH 改配置。禁止 `!`/`!!` 不影响模型按已有 Pi 权限使用 Bash。允许使用 Pi 不等于新增了强制工具审批系统。

## 持久化与投递语义

1. `pi.appendEntry()` 保留绑定于当前 SessionManager 的全部 custom entries。setup/custom-only 会话未落盘；第一条真实会话消息才写文件。`--no-session` 不承诺重启恢复，不调用私有强制写盘 API 保存论坛绑定。
2. 本机协调器按相同会话或相同群/话题进行原子占用；代次和短租约属于运行时，不持久继承给 fork/clone。心跳目录及随机 capability 必须保持当前用户私有。
3. 先保存更新游标，再交给目标会话。保存失败不转发；文件写入可能部分成功，或者保存完成后进程崩溃，因此仍可能“已消费但没执行”。不是持久化 exactly-once，也不是必达队列。
4. IPC ACK 代表接纳，不是模型完成。去重是进程内、含同进程 reload 共享，不是新增持久消息数据库。转发/创建结果未知时不自动重发；操作者先通过话题/SSH 查状态。
5. 结果未知、已删除的话题须 SSH 确认 retry，可能留孤立话题，不删除旧话题/会话/附件。无有效目标不回退最近 chat、General 或别人的会话；原处的拒绝提示不等于执行输出。
6. 论坛会话切换不重放历史、不复用父会话绑定、不迁移旧按钮。应查看新话题的上线通知；未知/过期按钮只能重新打开当前菜单。

## 明确未做与已知遗留项

- 未将扩展装载到当前 Pi，未执行真实 native TUI/手机/Bot/模型验收，未更改现有 Pi、SSH、tmux 或服务生命周期。
- 未跑继承的 `test:e2e*`。这些脚本可能创建 tmux、运行 Pi/OMP 或请求外部服务；`test:e2e:real` 会操作真实 Bot，必须另行审批。
- `/share` 的真实上传、`/quit` 的真实退出、外部协作命令及任何部署不属于离线证明。
- 继承的 `/cd` helper 含上游的私有 SessionManager `_rewriteFile` 调用，本轮未执行或验收它。论坛绑定自身不使用该私有接口；更换 cwd 建议通过 SSH 启动/恢复所需 Pi，不把该遗留 helper 宣称为公开 API 兼容保证。
- 原 plus 内部路径/日志环境变量、部分上游设计文档和适配标识有意保留，不做批量替换；根 README 和本文优先于历史材料。
- 本次源码同步不包含上游自动 npm 发布 workflow，原工作区留存版本已禁用；本仓库不提供自动发布流程。离线候选、代码同步、npm 发布与部署是不同状态，发布与部署须分别获得具体批准。

## 后续真实验收与回退（另批）

真实试运行计划必须明确指定 Pi 实例、私密测试群、操作者、Token 在 SSH 的配置方式、原消费者停用范围及恢复方法，再验证：Bot 管理话题/普通消息可见性、同 Bot 两个真实在线 Pi、手机按钮与本地竞答、模型/思考量/会话操作、文件图片、文本流式、重载/退出重选、断网/429/409、删除话题及未知结果恢复。

回退只停用本次获准的扩展并恢复原加载配置/固定版本；保留会话 JSONL、custom entries、论坛历史和附件，不清理其他实例，不强杀未纳入的任务。代码回退不能撤回已发送的工作内容或凭据。本轮没有上线，也没有执行线上回退。
