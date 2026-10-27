# TUI 对等重构：阶段 3–5 任务清单

本文是 `docs/tui-parity-refactor-plan.md`（下称"方案"）§6 阶段 3、4、5 的任务拆分。方案讲**做成什么样、为什么**；本文讲**按什么顺序做、做到什么程度算完**。两者冲突时以方案为准，并在方案 §9 追加决定记录。

阶段 2 的拆分等阶段 2 完成后再补。

---

## 0. 使用规则

1. **一个任务一个提交**（或一组连续提交），提交后在下面的状态栏打勾，并填写提交号。不要把多个任务的改动混在一个工作区里不提交。
2. **按编号顺序做**；"依赖"一栏为空的任务可以提前做。
3. **每个任务的完成标准都必须满足**，才能开始下一个任务。完成标准里写的测试是最低要求。
4. **"不做"一栏的内容不要顺手做**，它们属于别的任务。
5. 遇到文档没写清楚的地方，按方案 §2 的原则自己决定，在方案 §9 末尾追加一行决定记录，然后继续。只有下面三种情况停下来问：
   - 要违反方案 §2 的某条原则；
   - 要改某个阶段的验收标准，或某个任务的完成标准；
   - 要改模块之间的接口（方案 §4 的类型定义和模块职责）。
6. **每个提交都要通过的检查**（下文"通用检查"）：`npm run typecheck`、`npm test` 全绿；`tuiBridge: off` 的现有测试不受影响。
7. 每个阶段结束时汇报一次：最后一个提交号、每个任务的完成标准逐条对照、新增的 §9 决定。

### 通用检查

- 新适配器都要有真实组件契约测试（方案 §7.1），放在 `lib/__tests__/tui-adapters.contract.test.ts` 或同名前缀的新文件中。实在无法实例化的组件，测字段形状，并在测试里写明原因。
- 新增的 E2E 断言要检查**正文或宿主状态**，不能只检查 ack。
- OMP 上无法读取字段的对话框一律走快照（方案 §9 决定 18），**不要**解析渲染文本伪造列表。

---

## 阶段 3 拆分（v6，2026-10-25）

阶段 3 按依赖拆成 5 个小阶段，顺序固定（用户 2026-10-25 确定：拆分，3C OMP 先）。每个小阶段（以及 3A 内的每个检查点）结束时，主控向用户汇报：提交列表、验收结果、新增决定。

| 小阶段 | 内容 | 包含的任务 | 验收 |
|---|---|---|---|
| 3A 清理与对齐 | 删除旧路径；对齐 pi 1.4.0 | 见下方检查点 | 代码里只剩新架构；pi 1.4.0 与 OMP 18.12.x 的 E2E 无回归；"待迁移"清单列全现有缺口 |
| 3B 扩展对话框 | 扩展 UI 竞答（select、confirm、input、editor、ask、approve）；custom 明确告知，pi-goal 走例外一 | S25 可行性验证及后续任务（取代 T3.2a–T3.2c） | dialogs 套件两个宿主全绿且走竞答路径；对应条目移出清单 |
| 3C OMP 内置选择器 | TSP 适配器；删除 OMP 画面读取代码；`/fork`、`/clone` 交给宿主，选择器走 TSP（决定 52） | T3.2d–T3.2g | OMP 的 `/model`、`/settings`、`/login`、`/resume`、`/tree`、`/agents`、`/fork`、`/clone` 在 Telegram 显示原生列表并能完成操作，结果与终端一致 |
| 3D pi 内置选择器 | 读字段的适配器（pi 1.4.0）；`/fork`、`/clone` 交给宿主，选择器用 `UserMessageSelectorComponent` 适配器，之后删除插件自带的消息列表（决定 52） | T3.3–T3.10，含 1.4 新增 `/thinking`、`/trust` | pi 同组命令（含 `/fork`、`/clone`）达到同样效果 |
| 3E 收尾验收 | 只有输出的命令逐个验证；阶段 3 总验收 | T3.2（剩余）、T3.12、T3.13 | 两个宿主全量 E2E 通过；清单中属于阶段 3 的条目清空；README 中已过时的说明（`/tg-*`、`tuiBridge`、屏幕镜像）由主控改写 |

**3E 待核对**（主控 2026-10-25 读 OMP 源码发现）：OMP 内置工具（bash 等）的审批经工具自己的 UI 对象（`ToolContextStore`）调用 `ui.approve`，插件目前只给 `ask` 工具的 `execute` 做了 Telegram 路由，所以 Telegram 发起的回合里这类审批可能不会出现在 Telegram。3E 用 E2E 确认；属实则另开任务。

**3E 验收记录**（2026-10-25，主控跑 E2E、Qwen 修复）：

| 修复 | 问题 | 提交 |
|---|---|---|
| F1 | OMP 选择器/设置页带 `signal` 字段被判为 progress，broker 不建会话 | `e35eb14` |
| F2 | `!` 命令推送了"Running…"帧，作用域在命令完成前结束 | `d8024b0` |
| F3 | E2E 仍按已删的插件路径断言（`/model`、`/scoped-models`、`/agents`、断开项目、`!` 输出格式、parity 默认点第一项） | `f0c11e9` |
| F4 | pi 设置页不支持搜索，文字落成提示词 | `d6893ba` |
| F5 | OMP 模型面板选中后的"用途"选项条未建模 | `d608010` |
| F6 | OMP bash 组件类名被压缩，按方法识别；TSP 操作后请求重绘 | `88e0ce6` |
| F7 | E2E：OMP 用途选未分配项；设置页每次点击后比较画面 | `a967ad7` |
| F8 | 对话框开着且不收文字时，普通文字不当提示词（决定 54） | `7589384` |
| F9 | D2 回归：宿主命令交给 gateway 前没有先关掉本聊天的对话框 | `a4a2dbe` |

最终结果：基本收发（pi、OMP）、dialogs（两宿主）、commands（pi 75/75、OMP 136/136）、tui-bridge（两宿主）全部通过；待迁移清单清空；单测 697/697、0 skip。

遗留处理（2026-10-25）：提示措辞已统一、对话框内容每秒同步（R1 `f812ee1`）；OMP 内置工具审批经 `runner.getUIContext()`，E2E 已证实能在 Telegram 上作答（R2 `9bdcf75`、R3 `370949f`，dialogs 新增 "tool approval answered from Telegram"）。剩余：模拟模型的裸 `PROBE_APPROVAL` 暗号仍匹配整段历史，可能在同会话后续步骤多触发一次审批（目前没有步骤受影响）。

**3E 分工**（用户 2026-10-25）：主控跑全量 E2E、逐条分析失败原因并写修复任务书；**代码修改仍由 Qwen 执行**。

3A 检查点（用户 2026-10-25：3A 仍太大，再拆）：

| 检查点 | 内容 | 任务 |
|---|---|---|
| 3A-1 只剩新架构 ☑ | 删除 `off`/`tuiBridge`；删除 `/tg-*`（T4.10 提前）；修复宿主模式下的跨聊天通知串台 | D1（`6096014`）、T4.10（`86e3e81`）、串台修复 S26（`c0b3f36`）——2026-10-25 完成，单测 630/630、0 skip；E2E 推迟到 3E |
| 3A-2 删除旧镜像 | 删除 `runTuiCommand`、`tui-selector.ts`、`tgplus:tui:` 回调；gateway 接管所有宿主命令 | D2 |
| 3A-3 删除原生实现 | 删除重做宿主功能的原生实现与 `custom-dialogs.ts`；识别不了的对话框明确告知；`!` 命令改由宿主执行（决定 51） | D3、D3b、D4 |
| 3A-4 对齐 pi 1.4.0 | 升级依赖，修正 4 处接口差异，更新文档引用，删除多版本测试矩阵 | A2（A1 已由主控完成） |

**E2E 策略**（用户 2026-10-25："不要每次都跑 e2e，太耗时了"；"整个 3 阶段做完再 e2e，减小时间成本"）：阶段 3 内的任务和检查点只跑 `npm run typecheck` + `npm test`；**整个阶段 3 完成后，在 3E 统一跑一次全量 E2E**；可行性验证需要 E2E 作证据时只跑最小范围。各小阶段和检查点的"验收"中涉及 E2E 的部分，统一推迟到 3E 检查。


## v6 前置：删除旧路径与对齐 pi 1.4.0（先于阶段 3 剩余任务）

方案 §0.1、决定 46–50。顺序固定：先删旧路径（D1–D4），再对齐 pi 1.4.0（A1–A2），然后继续阶段 3 的迁移任务。

| # | 任务 | 依赖 | 状态 | 提交 |
|---|---|---|---|---|
| D0 | E2E"待迁移"清单机制 | — | ☑ | `21f6592` |
| D1 | 删除 `off` 模式与 `tuiBridge` 配置项；桥接不可用时启动报错 | D0 | ☑ | `6096014`（跨聊天串台用例 skip，待 3A-1 修复） |
| D2 | 删除旧屏幕镜像（`runTuiCommand`、`tui-selector.ts`、`tgplus:tui:` 回调） | D1 | ☑ | `07b5df6`；pi 的 `/debug` 改由插件处理（同名冲突，待定） |
| D3 | 删除插件重做宿主功能的原生实现（`lib/commands/` 对应部分、`telegram-ui.ts` 对应原生流程、`custom-dialogs.ts`） | D2 | ☑ | `857cd4a`；`pi-compat.ts` 的模型/认证兼容层已无调用方，并入 A2 清理 |
| D3b | `!`/`!!` 命令改由宿主执行，保留 `bashConfirm` 确认（决定 51） | D3 | ☑ | `e9a4d89`；bash 输出按构造器名 `BashExecutionComponent` 截获，OMP 编译产物若改名则截不到，3E 用 E2E 核对 |
| D4 | `SnapshotAdapter` 改为 `UnsupportedAdapter`（明确告知 + 取消） | D2 | ☑ | `5fc9d8b`；3A-2、3A-3 检查点完成 |
| A1 | 开发依赖升级到 pi `1.4.0`；按 1.4.0 源码核对剩余代码依赖的宿主接口，输出"需要改"清单 | D1–D4 | ☑（核对部分由主控完成；升级依赖并入 A2） | 4 处需要改：捕获补丁点 `initHooksAndCustomTools` 已改名；入口改挂 `pushExtensionDialog`/`removeExtensionDialog`；命令目录只用 `autocompleteProvider`；内置命令新增 `/bug`、`/thinking`、`/trust` |
| A2 | 按 A1 清单修正 pi 侧代码（入口改用 1.4.0 的对话框栈 `pushExtensionDialog`/`removeExtensionDialog` 等）；更新方案中的 0.81.1 引用；删除多版本测试矩阵 | A1 | ☑ | `cecf115`；矩阵工具与 E2E 多版本循环拆到 A3 |
| A3 | 删除多版本兼容矩阵工具（`gen-compat-matrix.mjs`、`compat:*`、发布流程检查）；E2E 只测 `node_modules` 里的 pi 1.4.0 | A2 | ☑ | `c3b893f`；README 兼容性一节、`docs/compatibility.md` 已改写，`compat-results.json` 已删除 |
| A4 | 启动时检查宿主版本（pi `1.4.0`、OMP `18.12.x`），不符或读不到即停止工作，并在状态栏与 Telegram 说明原因（§0.1 第 1 条） | A3 | ☑ | `2bd8469`；3A-4 检查点完成，**3A 全部完成**（2026-10-25，单测 548/548、0 skip） |

每个任务的完成标准：`npm run typecheck`、`npm test` 全绿；E2E 只允许"待迁移"清单内的步骤失败；删除的代码相关测试同步删除或改写。每个任务由主控拆成单独的任务书派发。

## 阶段 3：列表、设置、登录

前置条件：阶段 2 已验收。OMP 的 broker 开关已放开（方案 §9 决定 27 作废，`hostOwnsPrompts` 对两个宿主同等生效），所以 T3.0 已完成，见其完成记录。

| # | 任务 | 依赖 | 状态 | 提交 |
|---|---|---|---|---|
| T3.0 | OMP 对话框分类与读取（条件任务） | — | ☑ | `558d574`（版本限制）及之前各提交，见下方完成记录 |
| T3.1 | OMP 只读面板截获 | T3.0（如需要） | ☑ | 已由 `4f0e87e`、`7e6a84f`、`4767c02`、`ceb40a5` 完成（面板入口、`showCommandReport` 截获） |
| T3.2 | OMP 只有输出的命令接入 Gateway | T3.1 | ☑ | D2 `07b5df6` 起所有宿主命令都经 gateway |
| ~~T3.2a–c~~ | ~~OMP collab 桥接~~：由 3B 扩展 UI 竞答取代（决定 53） | — | 作废 | |
| S25 | 可行性验证：扩展 UI 竞答（两个宿主） | 3A | ☑ | 无提交（S25、S25b 2026-10-25：两个宿主证实；pi confirm 失败查明为测试脚本双击 Escape 打开 Session Tree） |
| B0 | 测试脚本：E2E 用的 pi agent 设置写 `doubleEscapeAction: "none"`，避免 `clearDialog()` 打开 Session Tree | S25 | ☑ | `81a9dea` |
| B1 | 竞答核心 + `select`（两个宿主）：按调用参数建 broker 会话，先答者生效，另一方关闭；竞答占用的组件不再由焦点路径建会话 | B0 | ☑ | `eb08ade`；会话仍由焦点打开，按钮经入口上的竞答句柄作答（方案 §4.12 第 2–6 步） |
| B2 | 竞答：`confirm`、`input`（两个宿主） | B1 | ☑ | `d9923f8` |
| B3a | 竞答：OMP 的 `editor`、`approve`（pi 的 `editor` 不接受 signal，不竞答） | B2 | ☑ | `71597ba` |
| B3b | 竞答：OMP 的 `askDialog`（ask 工具：插件按 Telegram 的选择拼出 `{ kind: "submit", results }`，含自定义答案） | B3a | ☑ | `5e7e5a6`；**3B 编码完成**（2026-10-25，单测 594/594、0 skip），E2E 在 3E |
| ~~B4~~ | ~~删除被竞答取代的按键路径~~：并入 T3.2g。没有竞答句柄的对话框（宿主内部的确认框、pi 的 `editor`、内置工具审批）仍需按键路径；要删的只有 OMP 上读画面的部分 | — | 并入 T3.2g | |
| T3.2d | OMP TSP 适配器：读取 + 操作（内置选择器与 `custom` 的基础） | 3B | ☑ | `7d8369f`；先做 picker（`activate`/`close` 事件） |
| T3.2e | OMP TSP 适配器：内置选择器与仪表盘（`/model`、`/settings`、`/login`、`/resume`、`/tree`、`/agents`） | T3.2d | 部分（后续） | picker 与 prefs 已覆盖（T3.2d、T3.2e-1）；其余选择器的实际描述结构在 3E 用 E2E 看，有缺口再开修复任务 |
| T3.2e-1 | TSP：OMP 设置页（prefs：换页、switch、choice）；带竞答句柄的对话框 TSP 不接管 | T3.2d | ☑ | `3b40a58` |
| T3.2f | OMP TSP 文本输入：验证 `edit` 事件（仅内置对话框里的输入框；扩展 `input` 已走竞答） | T3.2d | 后续 | 需要在真实 OMP 上看到内置输入框的描述结构才能设计，3E 一并核对 |
| T3.2g | 删除 OMP 上的画面读取与按键注入代码（例外二；含原 B4） | B3b、T3.2e、T3.2f | ☑ | `d3a3e56`；提前完成（不依赖 T3.2e/f 的剩余部分）。没有可读字段又没有竞答句柄的 OMP 对话框不再靠画面发键 |
| C1 | `/fork`、`/clone` 交给宿主（决定 52）；gateway 提交前保存消息进度，防止替换会话后重复执行 | T3.2g | ☑ | `194fbc4` |
**3D 重新拆分**（主控 2026-10-25，依据 pi 1.4.0 源码与 parity 审计 `.tmp/parity-pi.json`；下面的 T3.3–T3.10 旧描述写于 v6 之前，含"退回快照""保留原生 /fork"等已作废的做法，以本表为准）：

| # | 任务 | 依赖 | 状态 | 提交 |
|---|---|---|---|---|
| P1 | pi 内置列表选择器：`/model`、`/scoped-models`、`/login`/`/logout` 提供方、`/trust`、`/fork`/`/clone` 消息列表（按构造器名读字段） | 3C | ☑ | `4eef2dd` |
| P2 | pi `/settings`（`SettingsList`：当前值、切换、子菜单） | P1 | ☑ | `8230047` |
| P3 | pi `/resume`（`SessionSelectorComponent`） | P1 | ☑ | `2b2bd41`；切换范围后列表异步加载，broker 是否会重绘留到 3E 核对 |
| P4 | pi `/tree`（`TreeSelectorComponent`） | P1 | ☑ | `9a964e3` |
| P5 | pi 登录对话框（`LoginDialog`：API key 输入按 secret 处理） | P1 | ☑ | `0106164`；**3D 编码完成**（2026-10-25，单测 664/664、0 skip） |

| T3.3 | pi `SelectListAdapter` | — | 由 P1–P5 取代 | |
| T3.4 | pi `SettingsListAdapter` 主列表 | T3.3 | 由 P2 取代 | |
| T3.5 | pi `/settings` 子菜单 | T3.4 | 由 P2 取代 | |
| T3.6 | 通用 `FilteredListAdapter`：搜索与翻页 | T3.3 | 由 P1–P4、F4 取代 | |
| T3.7 | pi `/model`、`/scoped-models` | T3.6 | 由 P1 取代 | |
| T3.8 | pi `/resume` | T3.6 | 由 P3 取代 | |
| T3.9 | pi `/tree`、`/fork` | T3.6 | 由 P1、P4、C1 取代 | |
| T3.10 | pi `/login`、`/logout` | T3.3 | 由 P1、P5 取代 | |
| T3.11 | ~~OMP 选择器走快照~~ | — | 作废 | 方案 §9 决定 34:读不到字段的屏幕交回屏幕镜像,broker 不建会话、不发假键盘 |
| T3.12 | 所有命令切到 Gateway，删除三个命令集合 | T3.2–T3.11 | ☑ | 由 D2（`07b5df6`）完成 |
| T3.13 | 阶段 3 验收 | T3.12 | ☑ | 见下方"3E 验收记录" |

### T3.0 OMP 对话框分类与读取（条件任务）

- **背景（阶段 2 收尾复测更正）**：OMP 的 hook 对话框**会**切换焦点——`docs/host-probe/omp-18.12.5.json` 的 `focusEvents` 里，`select`/`confirm`/`input` 入口调用之后紧接 `via:"setFocus"`，焦点组件是只有 `children` 的容器（`QT`、`FD`、`Fy`）；`askDialog` 的组件带 `callbacks`+`options`（`Ej`）；扩展自定义对话框是带 `render`/`handleInput` 的普通对象。原先记录的"不调用 `setFocus`"来自插件绕过宿主 gate 自行渲染时采到的场景，不成立。真正的缺口有两个：① OMP 把行标签放在私有字段里（行组件 own keys 为空），`lib/tui/focus.ts` 的 `classify` 形状判定全部落空、构造函数名又是压缩产物，于是对话框被分成 `"progress"`；② 现有适配器按 `items`/`filtered*`/`selectedIndex` 字段读条目，这类组件读不到。
- **要做**：
  - 分类：焦点组件绑定或紧邻一条**未结束**的入口条目即判为 `dialog`。pi 侧 `EntrySpec.componentField` 已经把组件直接绑上（`FocusTracker.entryFor`）；OMP 的 UI 上下文入口没有组件字段，用"入口调用之后、Promise 结束之前"的待决条目关联（probe 的 `recentEntries` 就是这个时序）；两种情况都不再依赖类名或形状猜测；
  - 读取：新增按帧读取的适配器——用 `render(80)` 去色文本解析标题、行（`❯`/`>` 标当前行）与页脚按键；`conclusions.dialogFrames` 记录了每种组件形状的真实帧，`Ej` 这类带 `options`/`callbacks` 的组件仍优先读字段；
  - 操作：继续走 `act()` 的按键注入（上下移动 + `Enter`，取消 `Esc`），不要求宿主暴露私有字段；
  - 关闭：以入口调用的 Promise 结束为准；焦点回到编辑器只作为需要持续 1.5 秒的兜底信号；
  - 放开 `hostOwnsPrompts` 对 OMP 的限制——broker 与它是同一个开关（方案 §9 决定 27），去掉后 broker 同时在 OMP 打开。
- **不是接口变更**：方案 §4.1.3"按焦点识别对话框"保持，改的是判定条件（形状 → 是否有入口条目）；按规则 5 仍需在 §9 记一条决定。
- **完成标准**：OMP 上扩展 `select/input` 和 `ask` 多问题从 Telegram 作答走 broker 方言（`tgplus:dlg:`），并且终端先作答时 Telegram 键盘被撤销；`npm run test:e2e:dialogs` OMP 部分全绿；打开 OMP 的 broker 后，`run-e2e-commands.mjs --host omp` 不得低于阶段 1 基线 132/132（方案 §9 决定 27）。
- **不做**：OMP 内置选择器（T3.11）。

- **完成记录（OMP 18.12.5）**：
  - 分类：`lib/tui/entry.ts` 的入口条目活到宿主 Promise 结束（`entryCallDepth` 判嵌套、thenable 决定回收时机），`FocusTracker` 见到未结束条目即判 `dialog`，不再猜类名与形状；焦点被交给 overlay 容器时换按键目标不换会话（方案 §9 决定 29）。
  - 读取：`extensionSelectAdapter` 先读组件字段，读不到就解析 `render(80)` 的帧（`frameRows` 给出行、高亮行与可见顺序）；方向键步数按帧上真正显示的行计（决定 36）；选项串两边去掉缩进与当前值标记后再比（决定 35）。
  - 操作：仍走 `act()` 的按键注入；`ask` 由 `omp-ask` 适配器出问卷模型，多问题的"下一题/提交全部"照常出按钮。
  - 关闭：入口 Promise 结束、焦点回编辑器（250ms 确认）或换到别的对话框；progress 抢焦点不算关闭（决定 30）。
  - 键盘有效期：generation 只在"用户能按的按钮"变化时递增（决定 37），终端移动光标不再让聊天里的键盘失效。
  - 命令侧：命令开作用域时替用户关掉遗留的未答对话框（决定 31）；host 模式下命令上下文改用路由 UI，只发通知的命令重新回到聊天（决定 38）。
  - 验收：`npm run test:e2e:dialogs -- --host omp` 全绿（`DIALOGS_ACCEPTANCE=0`，含 select/confirm/input/secret/custom、`ask` 单题与多题、终端先作答撤销键盘）；`run-e2e-commands.mjs --host omp --phase main` 139/139（`COMMANDS_ACCEPTANCE=0`），高于阶段 1 基线 132。
  - 键盘与重绘：重绘失败不再顺手摘键盘（决定 39）；`classify` 先判 loader/signal 再认 entry，转圈面板不会带走问题的身份（决定 40）。
  - 测试基础设施：五个 e2e 套件启动前都先探测 mock Bot API / provider 端口，被占用就直接报错退出。此前 `--keep` 留下的旧宿主继续轮询同一端口，后跑的套件读到的是**前一个宿主**的聊天，制造过两轮假失败（`Bot not found: e2e-extra`、"This prompt is no longer active"、`/copy` 的回执显示上一条命令）；`run-e2e-omp.mjs` 的默认端口也从 9950/9951 挪到 9980/9981，不再与 commands 套件撞端口。命令步骤 `dispatch` 支持按内容匹配自己的回执，免得把"已关闭未回答的对话框"这类善后通知当成命令答复。
  - 版本限制（`558d574`）：按帧读取只在 OMP `18.12.x` 上启用（`lib/tui/adapters/utils.ts` 的 `OMP_FRAME_VERSIONS`，版本取自 `@oh-my-pi/pi-utils` 的 `VERSION`），其他版本或读不到版本时 select/confirm 退回快照、`approve` 不识别；方案 §4.6.6 例外二。
  - 稳定性复核（2026-10-24）：`run-e2e-commands.mjs --host omp` 连续 5 轮干净运行，main 阶段 4 轮全过、1 轮仅 `settings mirror` 失败（已记入方案 §10）；`test:e2e:dialogs --host omp` 11/11。

### T3.1 OMP 只读面板截获

- **文件**：`lib/tui/adapters/panel.ts`、`lib/tui/output.ts`，必要时 `lib/tui/entry.ts`。
- **要做**：按方案 §4.6.5 #12，以入口语义白名单识别 OMP 的 `showCommandReport`、`showDebugSelector`、`showUsageDashboard`、`showExtensionsDashboard`、`showAgentsDashboard`；`render(80)` 去色、脱敏后作为只读正文发到 Telegram，按钮只有"关闭"（发 Esc）。
- **完成标准**：
  - 单测：用 `docs/host-probe/omp-18.12.5.json` 里记录的入口参数构造调用，断言识别为 `info` 模型、按钮只有"关闭"；
  - E2E（OMP）：从 Telegram 发 `/status`、`/usage`，收到的消息里有面板正文（至少断言一个面板里一定出现的字段），点"关闭"后终端面板消失。
- **不做**：把命令加入白名单（T3.2）。

### T3.2 OMP 只有输出的命令接入 Gateway

- **文件**：`lib/tui/gateway.ts`（OMP 白名单），方案附录 A 或 §4.8 的 OMP 表。
- **要做**：把方案 §4.8 OMP 表第一行的 18 个命令（`/help`、`/status`、`/usage`、`/stats`、`/context`、`/changelog`、`/debug`、`/skills`、`/plugins`、`/extensions`、`/tools`、`/agents`、`/mcp`、`/plan`、`/session`、`/jobs`、`/todo`、`/memory`）加入 OMP 的 Gateway 白名单。
- **完成标准**：E2E（OMP）对这 18 个命令逐个断言：不进入 `runTuiCommand`（返回的不是旧镜像键盘）、收到的正文非空且不只是 ack。任何一个命令只回 ack，就从白名单中移除，并在 §9 记录原因。
- **不做**：选择器类命令（T3.11）。

### T3.2a–T3.2g OMP 结构化通道（方案 §4.11 v5；扩展对话框部分由 §4.12 竞答取代）

- 设计见方案 §4.11、§4.12 与决定 41–45、53；每个子任务由主控拆成单独的任务书派发，完成标准以 E2E 为准：
  - T3.2a–c：作废，由 3B 扩展 UI 竞答取代（方案 §4.12、决定 53）。3B 各任务（B0–B4）的验收：dialogs 套件两个宿主的 select、confirm、input、ask 步骤走竞答路径通过；终端先答时 Telegram 键盘撤销；本地发起的对话框不推到 Telegram。E2E 按阶段 3 策略在 3E 统一跑。
  - T3.2d：`TspAdapter` 单测覆盖 picker/卡片/只读三种转换。
  - T3.2e：`/model` 在 Telegram 上显示原生列表并能切换模型，结果与终端一致；其余内置选择器至少能读出列表并选择/关闭。
  - T3.2f：input 经 TSP 完成文本输入与提交，或证明 `edit` 事件不可用并保留现有输入路径（写入 §9）。
  - T3.2g：OMP 路径上不再调用 `frameRows`/`frameCursor`/`parseLegend`，删除"版本不符退回快照"的代码，改为 §4.11.4 的启动报错；dialogs 与 commands 套件 OMP 全绿。

### T3.3 pi `SelectListAdapter`

- **文件**：`lib/tui/adapters/`（新增 `select-list.ts`），注册到 `adapters/index.ts`。
- **要做**：方案 §4.6.5 #6。`findShape(F, isSelectList)` 命中后读 `filteredItems` 的 `value/label/description` 和 `selectedIndex`；操作按方案 §4.6.4：设置 `selectedIndex`，然后向 `inputTargetOf(F)` 发 `\r`。
- **完成标准**：
  - 契约测试：用真实的 `ThemeSelectorComponent`、`ShowImagesSelectorComponent` 和思考档位选择器，断言 `read()` 返回的选项与组件完整列表一致、当前值标记正确、`act()` 后组件回调收到目标值；
  - E2E（pi）：从 Telegram 发 `/settings` 以外任意一个使用 SelectList 的命令（例如切换思考档位），点选后宿主状态改变，并与终端操作的结果一致。
- **不做**：搜索、翻页（T3.6）。

### T3.4 pi `SettingsListAdapter` 主列表

- **要做**：方案 §4.6.5 #5 的主列表部分：读 `items`/`filteredItems`、`selectedIndex`、每项的 `currentValue`/`values`；cycle 按 `(indexOf(目标) − indexOf(当前) + n) % n` 算按键次数；操作后重新读取，确认 `currentValue` 已变。`currentValue` 不在 `values` 里时返回 `false`，退回快照。
- **完成标准**：
  - 契约测试：真实 `SettingsSelectorComponent`（焦点是 `getSettingsList()`）的主列表读取和一次 cycle；
  - E2E（pi）：从 Telegram 修改一个 cycle 类设置，settings 文件对应字段与终端操作的结果一致。
- **不做**：子菜单（T3.5）。

### T3.5 pi `/settings` 子菜单

- **要做**：`submenuComponent` 非空时，对它用 `findShape` 找 SelectList，生成 `submenu.model`；操作仍发给 `F`（方案 §4.6.5 #5）。`ThemeSubmenu` 这类不是 SelectList 的子菜单降级为快照，只提供 ↑↓/Enter/Esc。
- **完成标准**：
  - 单测：打开子菜单、选择、返回主列表，全程是同一个 broker 会话（不是新对话框），Telegram 复用同一条消息；
  - E2E（pi）：通过子菜单修改一个设置，结果与终端一致；进入主题子菜单时 Telegram 显示快照和按键。
- **不做**：无。

### T3.6 通用 `FilteredListAdapter`：搜索与翻页

- **文件**：`lib/tui/adapters/`（新增 `filtered-list.ts`）、`lib/tui/render-telegram.ts`（翻页布局）、broker 的文本路由（搜索输入）。
- **要做**：
  - 方案 §4.6.5 #7：标签依次取 `label ?? name ?? title ?? id ?? String(x)`；当前值比较组件上的 `current*` 字段；
  - Telegram 翻页：选项超过一屏时分页，翻页按钮的回调数据不超过 64 字节；
  - 搜索：用户发一条文字时，按方案 §4.5.1 的"搜索"类型路由，把文字写入组件的搜索输入，重新读取列表后重绘。
  - 用 `registerExternalInput` 把"插件原生提示等待文本"与"镜像/broker 对话框等待文本"两张表合成一张（方案 §9 决定 26）：合成后由单表的"最新流优先"给出排序，控制器里 `resolveInput` 先于 broker 的临时排序随之删除。
- **完成标准**：
  - 单测：翻页回调编码 ≤ 64 字节；搜索后列表变短；选中第 2 页的某一项，`act()` 定位正确；
  - 契约测试：至少一个真实组件（例如 oauth provider 列表）；
  - 单测：同一个 chat 同时有插件原生提示与镜像对话框在等文本时，答案给最新那条流，且每条流只消费一次（方案 §9 决定 26）。
- **不做**：模型、会话的专用字段（T3.7、T3.8）。

### T3.7 pi `/model`、`/scoped-models`

- **要做**：方案 §4.6.5 #8 的 `ModelSelectorAdapter`：选项显示 `provider/id`，标出当前模型；作用域切换键作为额外按钮。
- **完成标准**：E2E（pi）：从 Telegram 搜索一个模型、翻页、选中，之后宿主当前模型与终端执行相同操作的结果一致；当前模型在 Telegram 列表里有标记；`/scoped-models` 的勾选结果写入的文件与终端一致。
- **不做**：OMP 模型选择器（T3.11）。

### T3.8 pi `/resume`

- **要做**：`SessionSelectorAdapter`：数据在嵌套的 `sessionList` 里（`sessionList.filteredSessions`）；显示会话名或第一条消息加时间；删除、排序、按名称筛选作为 `extraActions`。
- **完成标准**：E2E（pi）：准备两个会话，从 Telegram 发 `/resume` 选中较早的那个，之后 `/session` 显示的会话文件就是它；删除操作会先二次确认。
- **不做**：无。

### T3.9 pi `/tree`、`/fork`

- **背景**：`/fork` 保留原生处理器（方案 §9 决定 21），只有其中选择器的步骤交给 broker。
- **要做**：`/tree` 和 `/fork` 的消息列表（焦点 `selector.getMessageList()`）走 `FilteredListAdapter` 或专用适配器；`/fork` 选中后宿主写入编辑器的文本按方案 §4.2.4 处理：作为一条消息发到 Telegram，然后恢复本地草稿。
- **完成标准**：
  - E2E（pi）：`/fork` 选中第 N 条消息后，新会话的消息数与终端执行相同操作的结果一致；Telegram 收到"已放入编辑器的文本"；终端原有的草稿还在；
  - `/tree` 跳转后的当前节点与终端一致。
- **不做**：OMP 的 `/tree`、`/fork`（T3.11）。

### T3.10 pi `/login`、`/logout`

- **要做**：方案 §4.6.5 #9 的 `LoginDialogAdapter`：输入一律 `secret: true`；**禁止**对登录对话框截图；用户回复后立即删除该 Telegram 消息；原文登记到 `SecretStore`。`/logout` 走 provider 选择列表。
- **完成标准**：
  - E2E（pi）：从 Telegram 完成"选择 API key 登录 → 输入 key"，认证文件中出现该 provider；整个过程中 mock Telegram 收到的所有消息（包括编辑后的消息）都不包含 key 的明文；用户发 key 的那条消息已被删除；
  - `/logout` 后认证文件中该 provider 被移除。
- **不做**：OMP 登录（T3.11）。

### T3.11 OMP 选择器走快照

- **要做**：OMP 的 model/settings/session/tree/oauth/login 选择器（方案 §4.8 OMP 表第二行的命令）没有可读字段，统一由 `SnapshotAdapter` 提供 ↑↓/Enter/Esc 和"输入文字"按钮，标题标明"未适配的对话框"；**不**解析渲染文本伪造列表（方案 §9 决定 18）。
- **完成标准**：E2E（OMP）：从 Telegram 用按键在 `/model` 中切换模型，在 `/settings` 中修改一项，结果与终端一致；`/login` 列表能用按键选择并能取消。
- **不做**：OMP 字段适配器。

### T3.12 所有命令切到 Gateway，删除三个命令集合

- **文件**：`lib/controller.ts`、`index.ts`。
- **要做**：
  - `on` 模式下所有宿主命令都经过方案 §4.2.2 的分发顺序，不再进入 `runTuiCommand`；
  - 删除 `TUI_NATIVE_SELECTOR_COMMANDS`、`MIRROR_FIRST_COMMANDS`、`HOST_CAPABILITY_COMMANDS`（`lib/controller.ts`），并检查 `index.ts` 的 `TUI_VISIBLE_COMMANDS` 是否还需要；
  - `off` 模式继续使用 `lib/commands/model.ts`、`session.ts`、`settings.ts`、`auth.ts` 的原生实现（方案 §10：本次不清理）。
- **完成标准**：`grep` 不到这三个常量；`on` 模式的单测断言没有任何命令会进入 `runTuiCommand`；`off` 模式的现有测试全绿。
- **不做**：删除镜像代码本身（T5.4）。

### T3.13 阶段 3 验收

- 按方案 §6 阶段 3 的验收标准，在 pi 和 OMP 上各跑一次完整 E2E，报告逐条结果。
- 任何一条不通过，回到对应任务修复，不在本任务里修。

---

## 阶段 4：终端专属命令与收尾

| # | 任务 | 依赖 | 状态 | 提交 |
|---|---|---|---|---|
| T4.1 | `/copy` | — | ☑ | `37d4467` |
| T4.2 | `/hotkeys` | — | ☑ | `37d4467` |
| T4.3 | `/quit`、`/exit`、`/restart` 二次确认 | — | ☑ | `37d4467`（OMP 18.12.5 没有 `/restart`） |
| T4.4 | OMP `/export` 发送文件 | — | ☑ | `470ebee`（两个宿主，html 与 jsonl） |
| T4.5 | OMP 确认类与网络类命令 | — | 部分 | 无需新代码；`/cleanse` 输入框正常。空会话里 `/delete`、`/clear` 不弹确认，"点否后会话还在"未验证；网络类命令 E2E 改为跳过（`b82cbbe`） |
| T4.6 | ~~未知 custom 组件走快照~~ → 明确告知 + 取消 | — | ☑ | D4 `5fc9d8b`；E2E 步骤 `816f1b1` |
| T4.7 | 密钥脱敏覆盖三个发送源 | — | ☑ | `ea0498a`、`d7f6c4e` |
| T4.8 | Project 连接/断开：修复不生效，改为显示真实状态 | — | ☑ | `82ce98f`（断开持久化）、`982bec3`（按运行状态显示、断开时让出活跃实例） |
| T4.9 | `/tg` 菜单按附录 M 重整 | T4.8 | ☑ | `049d8a0`（Bots 子菜单、全局默认 Bot 单列、配对页）；`⬅️ Back` 保留英文 |
| T4.10 | 删除 `/tg-*` 命令，只保留 `/tg` 入口 | — | ☑ | 提前到 3A-1 完成：`86e3e81` |
| T4.11 | 阶段 4 验收 | T4.1–T4.10 | ☑ | 2026-10-25：五套 E2E 两宿主全过；用户要求全部改英文后（EN1 `648e37f`、EN2 `fb0b58e`、EN3 `b82cbbe`）再跑一次仍全过 |

**阶段 4 遗留（已处理，2026-10-25）**：OMP `/hub` 列表为空是真实状态（没有运行中的子代理），现显示宿主的空状态说明（L1 `3cb7f4d`）；OMP 18.12.5 的 `/delete`、`/clear` 本身没有确认框（任务清单 T4.5 描述有误），但它们"先清空聊天区再挂结果"导致结果提示被当成历史重建丢掉，已修（L2 `33dcc57`），空输出回执的多余空行一并修掉；OutputCapture 新增截获组件的调试日志。以前跑 E2E 时 OMP `/share` 曾把测试会话上传到 my.omp.sh（内容只有模拟对话），现已改为跳过。

**文字语言**（用户 2026-10-25）：插件发给用户的所有文字改为英文；`docs/` 下的方案与任务清单保留中文。

### T4.1 `/copy`

- **要做**：方案 §4.8：不提交给宿主；读取会话中最后一条 assistant 文本，直接作为 Telegram 消息发送（pi 和 OMP 都这样处理，OMP 不打开 `showCopySelector`）。没有 assistant 消息时回复"没有可复制的内容"。
- **完成标准**：单测：有/无 assistant 消息两种情况；E2E（pi、OMP 各一次）：收到的文本等于最后一条回复的原文，并且已经过 `SecretStore` 脱敏。

### T4.2 `/hotkeys`

- **要做**：不提交给宿主，发送插件生成的 Telegram 用法说明（包括对话框按钮、发送文字作为输入、`/stop`）。
- **完成标准**：单测断言说明里包含上述三项；终端上不打开快捷键面板。

### T4.3 `/quit`、`/exit`、`/restart` 二次确认

- **要做**：Telegram 上先显示"✅ 确认退出 / 取消"，确认后才提交给宿主；取消或超时则什么都不做。`/restart` 只有 OMP 有。
- **完成标准**：单测：确认、取消、超时三种路径；E2E（pi）：确认后宿主进程退出，取消后进程还在。现有的 `quit`/`exit` E2E 场景继续通过。

### T4.4 OMP `/export` 发送文件

- **要做**：方案 §9 决定 20：等 `exportToHtml` 的 Promise 解析，把解析出的路径作为文档发送；只在 scope 标签是 `/export` 时记录（`/share` 内部的临时文件不能发出去）。
- **完成标准**：E2E（OMP）：收到的文档文件名和导出路径一致，文件存在；`/share` 不会发出临时文件。

### T4.5 OMP 确认类与网络类命令

- **要做**：方案 §4.8 OMP 表中的两类命令：
  - 确认类（`/new`、`/fresh`、`/clear`、`/delete`、`/cleanse`、`/wt`、`/worktree`）：确认框按 `confirm` 模型渲染为"是/否"；
  - 网络类（`/share`、`/collab`、`/join`、`/leave`、`/hub`）：直接提交，输出回传；有进度条的按 `progress` 模型显示，完成后改为完成状态并去掉键盘。
- **完成标准**：E2E（OMP）：`/delete` 的确认在 Telegram 上点"否"后会话还在；`/share` 的输出正文回传到 Telegram。需要网络的命令在 mock 环境下无法完成时，只断言确认框或进度条的渲染，并在汇报里写明。

### T4.6 未知 custom 组件走快照

- **要做**：在 `scripts/e2e/probe-extension.ts`（或新建测试扩展）里加一个结构未知的 `custom()` 组件。
- **完成标准**：E2E（pi）：从 Telegram 触发该组件，收到快照（标题"未适配的对话框"）以及 ↑↓/Enter/Esc 按钮；点 Esc 后组件关闭，扩展收到取消结果；快照文本已脱敏。

### T4.7 密钥脱敏覆盖三个发送源

- **背景**：方案 §4.7.4 要求在 OutputCapture、Broker、`lib/renderer.ts` 三个发送源转换成 HTML 之前替换。阶段 2 可能已经完成一部分，本任务负责核对并补齐。
- **完成标准**：单测覆盖方案 §7.1"密钥"一条的全部用例：三个来源都被脱敏；含 `& < >` 的密钥替换后 HTML 结构完好；短于 8 个字符的不登记；`/new` 后清空；Telegram turn 中输入的密钥同样生效。已有的测试直接引用，不用重写。

### T4.8 Project 连接/断开：修复不生效，改为显示真实状态

- **背景**：现在 `/tg → Project → Enabled` 切换后，轮询和状态栏都没有真正改变。已核实的两个原因：
  1. **项目没有单独绑定、使用全局默认 Bot 时，"关闭"会被立刻撤销。** `disableProjectFlow`（`lib/commands/telegram-commands.ts`）先把内存配置设为 `telegramEnabled: false`，紧接着 `switchResolvedConfig(readResolvedTelegramConfig(...))` 重读配置；没有绑定文件时 `materializeTelegramConfig`（`lib/config.ts`）一律给出 `telegramEnabled = true`。读回来又是开启，后台每 2 秒一次的 `reconcileCoordinator` 随即重启轮询。菜单重新显示 `● on`，状态栏不变。
  2. **启动时强制改回开启。** `enableConfiguredTelegramOnStartup`（`lib/config.ts`，`index.ts` 启动流程调用）在有 Bot 时把 `telegramEnabled` 强制设为 `true` 并写回文件，断开状态在重启后丢失。
- **要做**（语义见附录 M.2）：
  - "断开"必须能持久记录，**包括没有单独绑定、使用全局默认 Bot 的项目**。做法：断开时写入项目绑定记录 `{ enabled: false }`，不写 `botId`，表示"仍用默认 Bot，但已断开"；`materializeTelegramConfig` 读到 `enabled: false` 时，不论有没有 `botId` 都给出 `telegramEnabled: false`。"连接"时如果该记录只有 `enabled` 这一项，就删除它，恢复成"没有绑定"；
  - 启动时不再覆盖用户的断开：`enableConfiguredTelegramOnStartup` 只在**没有显式断开记录**时补 `true`；
  - 连接、断开的结果以**实际运行状态**为准：操作后等待一次 `reconcileCoordinator` 完成，再刷新菜单和状态栏；
  - 断开时这个实例如果是当前活跃实例，要释放活跃记录，让同一个 Bot 的其他 pi 实例可以接管（不要等记录过期）。
- **完成标准**：
  - 单测：有绑定、无绑定两种项目，分别"断开 → 重读配置 → 模拟重启"，三步之后都还是断开；"连接"后无绑定项目恢复成没有绑定记录；
  - E2E（pi）：断开后 5 秒内，mock Telegram 不再收到 `getUpdates` 请求，状态栏显示 `disconnected`；在终端 `/tg` 中连接后，轮询恢复，状态栏恢复为已连接；重启 pi 后保持上一次的状态；
  - 从 Telegram 断开：先出现二次确认，确认后 Telegram 收到"已断开，只能在终端重新连接"的提示，之后不再响应。
- **不做**：菜单结构调整（T4.9）。

### T4.9 `/tg` 菜单按附录 M 重整

- **文件**：`lib/commands/tg-menu.ts`，必要时 `lib/commands/telegram-commands.ts`、`lib/pairing.ts`。
- **要做**：按附录 M.1 的结构调整 Bots 和 Project 两个子菜单：
  - Bots：全局默认 Bot 从单个 Bot 的详情页提出来，成为 Bots 下的独立一项；新增配对入口；
  - Project：`Enabled: ● on / ○ off` 改为连接状态加操作按钮（附录 M.2）；
  - 复用现有业务函数（`addBotFlow`、`updateBotFlow`、`removeBotFlow`、`setBotDefaultFlow`、`clearBotDefaultFlow`、`bindProjectFlow`、`unbindProjectFlow`），只改菜单层；T4.8 改过的连接/断开函数直接调用。
- **完成标准**：
  - 单测：菜单每一层的选项文字和顺序与附录 M.1 一致；
  - 单测：配对页在"未配对""已配对"两种状态下显示正确；解除配对后 `allowedUserId` 被清除，并生成新的配对码；
  - 单测：Project 页的连接状态来自运行状态（轮询是否运行、是否为活跃实例），不是配置字段；其他实例正在使用同一个 Bot 时显示"其他实例使用中"；
  - E2E（pi）：从 Telegram 走一遍"Bots → 全局默认 Bot → 设置"和"Project → 绑定 Bot → 选择"，配置文件结果正确。
- **不做**：删除 `/tg-*`（T4.10）。

### T4.10 删除 `/tg-*` 命令，只保留 `/tg` 入口

- **背景**（用户决定，2026-10-24）：插件自身的管理功能只通过 `/tg` 菜单进入。T4.9 完成后，`/tg` 菜单覆盖全部 `/tg-*` 功能。
- **要删除的命令**：`/tg-bot-add`、`/tg-bot-list`、`/tg-bot-update`、`/tg-bot-remove`、`/tg-bot-default`、`/tg-bind-cwd`、`/tg-unbind-cwd`、`/tg-cwd-connect`、`/tg-cwd-disconnect`。
- **要做**：
  - 删除 `lib/commands/telegram-commands.ts` 中这些命令的 `registerCommand` 注册；菜单调用的业务函数保留（菜单靠它们工作）；
  - 删除 `lib/menu-commands.ts` 中对应的菜单项；
  - 所有提示文字中出现的 `/tg-xxx`，改成菜单路径，例如"/tg → Bots → Add bot"（`telegram-commands.ts` 的 `notify` 文本、`lib/config.ts`、`index.ts` 中的引用）；
  - 测试：`lib/__tests__/telegram-commands.test.ts`、`menu-commands.test.ts` 改为测菜单路径或业务函数；`scripts/e2e/run-e2e-commands.mjs`、`audit-parity.mjs` 中用到 `/tg-*` 的步骤改为走 `/tg` 菜单；
  - 文档：`README.md`、`docs/compatibility.md` 中的命令说明改成菜单路径；CHANGELOG 以"行为变更"列出被删除的命令和对应的菜单路径；
  - 在方案 §9 追加一条决定记录。
- **完成标准**：
  - 除 CHANGELOG 的变更说明外，仓库中 `grep` 不到 `tg-bot-`、`tg-bind-cwd`、`tg-unbind-cwd`、`tg-cwd-connect`、`tg-cwd-disconnect`；
  - 在 Telegram 发被删除的命令时，提示"未知命令，请使用 /tg"，不会转发给宿主；
  - E2E：从 Telegram 和终端各用 `/tg` 菜单完成一次"添加 Bot → 设为默认 → 绑定当前项目 → 断开 → 重新连接"，配置文件结果与原 `/tg-*` 命令一致；
  - 终端里 `/tg` 仍然可用（项目断开 Telegram 后只能从终端重新连接）。
- **不做**：`/status`、`/debug` 与宿主命令重名的问题、`/tg` 菜单里仿造宿主功能的 Thinking level 选项（另行处理，需在方案 §10 待办中补记，本任务不动）。

### T4.11 阶段 4 验收

- 按方案 §6 阶段 4 的验收标准逐条报告，加上 T4.8–T4.10 的完成标准。

---

## 阶段 5：清理

顺序很重要：**先建好状态等价测试，再删旧代码**，删完再跑一遍，用测试证明删除没有造成回归。

| # | 任务 | 依赖 | 状态 | 提交 |
|---|---|---|---|---|
| T5.1 | ~~配置取值迁移与菜单~~ | — | 作废 | `tuiBridge` 配置项已在 D1 删除，读到旧值只记警告 |
| T5.2 | 状态等价 E2E 框架 | — | ☑ | S1 `14c8c46`：`npm run test:e2e:state`，pi 的 `/name`、`/model`、`/settings` Auto-compact 三例；`--self-test` 证明比较有效 |
| T5.3 | 状态等价 E2E 覆盖全部命令 | T5.2 | ☑ | S2 `6a0721a`：再加 pi `/scoped-models`、OMP `/model` 分配用途、OMP `/settings`（mock 环境两侧都不落盘，跳过）；pi/OMP `/model` 选项集合检查。P6 `53a1654` 修了换列表不回第 1 页 |
| T5.4 | 删除 controller 中的镜像代码 | T5.3 | ☑ | 已由 D2 `07b5df6` 完成 |
| T5.5 | 删除 `tui-selector.ts`、`tui-bridge.ts` | T5.4 | ☑（修订） | `tui-selector.ts` 已由 D2 删除；`tui-bridge.ts` 现在是新架构连接宿主的核心，保留（主控 2026-10-25 定，用户同意阶段 5 拆分） |
| T5.6 | 旧回调前缀改为"已过期" | T5.4 | ☑ | 已由 D2 `07b5df6` 完成 |
| T5.7 | 文档更新 | T5.1–T5.6 | ☑ | 主控：兼容性文档加对话框支持矩阵与密钥脱敏说明、状态等价套件；旧方案文档标注已取代；README 补状态等价与密钥链接 |
| T5.8 | 最终验收 | T5.7 | ☑ | 2026-10-25：pi 1.4.0 与 OMP 18.12.5 六套 E2E 全过（基本收发、dialogs、commands pi 76/76 · OMP 135/135、tui-bridge、状态等价 5 例一致 1 例跳过）；单测 767/767、0 skip。**重构完成** |

### T5.1 配置取值迁移与菜单

- **文件**：`lib/config.ts`、`lib/types.ts`、`lib/commands/tg-menu.ts`、`lib/commands/tg-config.ts`。
- **要做**：方案 §4.10：读取配置时把未设置、`commands`、`full` 映射成 `on`，不改写配置文件；`/tg → Config` 菜单只保留 `on`/`off`。
- **完成标准**：单测：四种旧值（未设置、`commands`、`full`、`off`）读取结果正确，配置文件内容不变；菜单只显示两个选项；`off` 模式的现有测试全绿。CHANGELOG 中以"行为变更"单独说明。

### T5.2 状态等价 E2E 框架

- **文件**：`scripts/e2e/audit-parity.mjs`。
- **要做**：方案 §7.2 的第 1–3 步：每个用例启动两个全新的隔离宿主，A 用 tmux 在终端操作，B 从 mock Telegram 操作；执行后导出状态快照（当前模型、思考档位、会话文件、settings 文件、认证文件中的相关字段），比较 A 和 B 是否一致。
- **完成标准**：先用 3 个命令（`/name`、`/model`、`/settings` 中的一项）跑通；故意让 B 少一步操作时测试失败（证明比较有效）。保留现有的 Bot API 契约校验。

### T5.3 状态等价 E2E 覆盖全部命令

- **要做**：把方案附录 A 中所有会改变状态的 pi 命令，以及 OMP 中能在 mock 环境下运行的命令，都加进 T5.2 的框架；补上方案 §7.2 第 4 步："Telegram 上列出的选项集合等于组件的完整列表"。
- **完成标准**：pi 和 OMP 全绿；mock 环境下跑不了的命令列出清单并写明原因。

### T5.4 删除 controller 中的镜像代码

- **要做**：删除方案 §5"修改"表中 `lib/controller.ts` 一行列出的函数（`TuiMirror`、`refreshTuiMirror`、`startPromptMirror`、`promptMirrorHook`、`runTuiCommand`、`runTuiCommandInner`、`buildSelectorKeyboard`、`formatSelectorMessage`、`tuiKeyRows`、`advertisedKeys`、`formatTuiSnapshot`、`trimScreenChrome`、`snapshotLinks`、`hasInputPrompt`、`handleTuiCallback`）。
- **完成标准**：`grep` 不到这些名字；T5.3 的状态等价 E2E 删除前后都全绿；`off` 模式的测试全绿（`off` 用的是 Telegram 原生实现，不依赖镜像）。

### T5.5 删除 `tui-selector.ts`、`tui-bridge.ts`

- **要做**：`lib/tui-bridge.ts` 中仍被使用的导出迁移到 `lib/tui/host.ts`、`lib/tui/snapshot.ts`（快照渲染从 `renderScreen` 迁移过来），调用方改为从新位置导入；然后删除 `lib/tui-bridge.ts`、`lib/tui-selector.ts`、`lib/__tests__/tui-selector.test.ts`。
- **完成标准**：两个文件不存在；`npm run typecheck`、`npm test`、T5.3 全绿。

### T5.6 旧回调前缀改为"已过期"

- **要做**：收到 `tgplus:tui:` 回调（升级前发出的旧消息）时，回复"此按钮已过期"，并移除那条消息的键盘；不执行任何按键。
- **完成标准**：单测：旧前缀的回调不会触发任何宿主输入，并且会回复过期提示。

### T5.7 文档更新

- **要做**：方案 §5"修改"表中的文档项：
  - `README.md`：改写 "Interactive modals are Telegram-only during a Telegram turn" 和 "Mirrored dialogs arrive as one Telegram message" 两段，并补上密钥脱敏的局限；
  - `CHANGELOG.md`：汇总行为变更；
  - `docs/telegram-interactions-plan.md` 顶部注明原则 1 已被新方案取代；
  - `docs/compatibility.md`：更新 pi/OMP 支持矩阵（哪些对话框是结构化的，哪些是快照）。
- **完成标准**：README 中不再出现"镜像"作为当前行为的描述；兼容性矩阵与 T5.3 的测试结果一致。

### T5.8 最终验收

- 方案 §6 阶段 5 的验收标准：§7.2 的状态等价测试在 `npm run test:pi-versions` 覆盖的全部 pi 版本和 OMP 上通过。
- 汇报：每个版本的结果；不通过的版本单独列出原因，并说明是修复还是在兼容性矩阵中标为不支持（后者属于改验收标准，按规则 5 先问）。

---

## 附录 M：`/tg` 菜单方案（2026-10-24 用户确定，T4.8–T4.10 实施）

### M.1 菜单结构

原则：**Bots 管 Bot 本身（全局）**，**Project 管当前目录（本地）**。两边不交叉：全局默认 Bot 只在 Bots 里设置，连接/断开只在 Project 里操作。

```
/tg
├─ 🤖 Bots                          全局，影响所有目录
│   ├─ ➕ 添加 Bot
│   ├─ Bot 列表 → 选一个 Bot
│   │    ├─ 更新（名称、token）
│   │    ├─ 配对 → 见 M.3
│   │    └─ 删除
│   ├─ ⭐ 全局默认 Bot：<名称 或 未设置>
│   │    └─ 选择一个 Bot 设为默认 / 清除默认
│   └─ ⬅️ 返回
│
├─ 📁 Project                       只影响当前目录
│   ├─ 绑定 Bot：<名称> 或 <名称>（全局默认）
│   │    └─ 选择一个 Bot 绑定 / 解绑（改用全局默认）
│   ├─ 🟢 已连接 → [断开]          或   ⚪ 已断开 → [连接]
│   └─ ⬅️ 返回
│
├─ ⌨️ Commands、⚙️ Config、Switch instance    本次不动
└─ ⬅️ 返回
```

- Bot 列表中，每项标出"⭐ 默认"和配对状态（"已配对"/"未配对"）。
- 当前目录没有任何可用 Bot（没有绑定，也没有全局默认）时，Project 页只显示"绑定 Bot：未设置"，不显示连接按钮。

### M.2 连接 / 断开

| 项目 | 规定 |
|---|---|
| 含义 | 当前目录的 pi 是否通过 Telegram 收发消息。只影响当前目录，不影响 Bot 本身，也不影响其他目录 |
| 显示 | 按**实际运行状态**显示，不按配置字段：🟢 已连接（本实例正在轮询）；🟡 其他实例使用中（同一个 Bot 正由另一个 pi 实例服务）；⚪ 已断开（用户手动断开） |
| 持久化 | **断开在重启后保持**，需要手动连接才恢复。没有单独绑定、用全局默认 Bot 的目录同样可以断开（T4.8 的记录方式） |
| 从 Telegram 断开 | **允许**，必须二次确认，确认框写明"断开后 Telegram 将不再响应，只能在终端用 /tg 重新连接" |
| 从 Telegram 连接 | 不可能（已断开时 Telegram 收不到消息），菜单里不需要处理 |
| 操作之后 | 等实际状态切换完成，再刷新菜单和状态栏；状态栏与菜单显示必须一致 |
| 旧命名 | `Enabled: ● on / ○ off` 不再使用；配置文件中的 `enabled` 字段名可以保留，只改菜单显示和语义 |

以上"持久化"和"从 Telegram 断开"两条，是在用户未明确选择时按建议默认值写入的，用户改变决定时只需改这两行和 T4.8 的对应完成标准。

### M.3 配对

| 状态 | 显示 | 操作 |
|---|---|---|
| 未配对 | 配对码和步骤（复用 `formatPairingInstructions`） | 重新生成配对码 |
| 已配对 | 已配对的 Telegram 用户（`allowedUserId`，有用户名时一并显示） | 解除配对：二次确认后清除 `allowedUserId` 并生成新的配对码；如果是在 Telegram 上操作，提示"解除后当前聊天将无法继续使用，需要重新配对" |

- 配对本身仍由 Telegram 侧的 `/pair <配对码>` 完成，菜单只负责显示和重置。
