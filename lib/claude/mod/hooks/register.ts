// Claude Code side of the Telegram bridge. Every session connects to the local
// gateway (a systemd --user service that alone polls the Bot) over a Unix
// socket, gets the forum topic of its launch directory, and long-polls for what
// Telegram sent there. Telegram text becomes a prompt; /stop, /status, /model,
// /effort, /commands, /compact, /clear, /usage and /restart run here; each
// main-loop turn's final answer goes back.
// Permission dialogs and AskUserQuestion are also shown in Telegram: whichever
// side answers first wins, and the other side's question goes away.
import type { EngineInterface, Register } from 'claude-code'

type GatewayEvent =
  | { type: 'prompt'; text: string }
  | { type: 'abort' }
  | { type: 'command'; name: 'compact' | 'clear' | 'status' | 'model' | 'effort' | 'commands' }
  | { type: 'usage' }
  | { type: 'restart' }
  | { type: 'log'; text: string }

type PendingResult = { answer: string } | { cancelled: true } | { pending: true }
type OpenResult = { ok: true; threadId?: number; notices?: string[] } | { ok: false; reason: string; quiet?: true }

const ALLOW = '✅ 允许'
const DENY = '❌ 拒绝'
// The dialog's own extra rows: "Type something." and "Chat about this".
const CUSTOM = '✏️ 自定义输入'
const CHAT = '💬 先聊聊'
const CANCEL = '✖️ 取消'
/** A menu nobody answers goes away after this. */
const MENU_TIMEOUT_MS = 5 * 60_000
const MODELS = [['Opus', 'opus'], ['Sonnet', 'sonnet'], ['Haiku', 'haiku']] as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const CHAT_REASON = '用户选择先就这些问题聊一聊，暂不作答。请停下来，等待用户的下一条消息。'
// Tools whose dialog is a question for the person, not a yes/no approval: their
// permission request is not relayed (AskUserQuestion has its own relay below).
const PERSON_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

// Module state: starts over when the module reloads (a new connection then).
const connId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
let socketPath: string | undefined
let connected = false
/** Set once Claude Code is exiting: stop polling and never register again. */
let closing = false
/** Bumped on every session start (/resume starts one too): an older poll loop stops. */
let generation = 0
let runningTurn: string | undefined
let promptChain: Promise<unknown> = Promise.resolve()
let idCounter = 0
let lastReason: string | undefined

function newId(): string {
  idCounter += 1
  return `${connId.slice(-6)}${idCounter.toString(36)}`
}

function later($: EngineInterface, ms: number): Promise<void> {
  return new Promise(done => { $.clock.after(ms, () => done()) })
}

/** POST to the gateway; the parsed JSON reply, or undefined when it is not reachable. */
async function call($: EngineInterface, path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  if (!socketPath) return undefined
  try {
    const res = await $.http.fetch(`http://gateway${path}`, {
      method: 'POST',
      socketPath,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connId, ...body }),
    })
    return res.ok && res.text ? JSON.parse(res.text) : undefined
  } catch (error) {
    $.ui.log(`agent2telegram: ${String(error)}`, { to: 'debug' })
    return undefined
  }
}

/**
 * Show a question with buttons in the topic and wait for the tap. Resolves
 * undefined when there is no topic, when `signal` aborts (the terminal answered
 * the dialog), or when `elsewhere` settles first; the buttons are taken back then.
 */
async function askTelegram(
  $: EngineInterface, signal: AbortSignal, title: string, body: string, labels: string[],
  elsewhere?: Promise<unknown>, textLabel?: string,
): Promise<string | undefined> {
  if (!connected) return undefined
  const id = newId()
  const shown = await call($, '/prompt', { id, title, body, labels, textLabel }) as { shown?: boolean } | undefined
  if (!shown?.shown) return undefined
  const stop = new Promise<'stop'>(resolve => {
    if (signal.aborted) resolve('stop')
    else signal.addEventListener('abort', () => resolve('stop'), { once: true })
    elsewhere?.then(() => resolve('stop'), () => resolve('stop'))
  })
  while (true) {
    const result = await Promise.race([call($, '/wait', { id }) as Promise<PendingResult | undefined>, stop])
    if (result === 'stop' || result === undefined) {
      void call($, '/resolve', { id })
      return undefined
    }
    if ('answer' in result) return result.answer
    if ('cancelled' in result) return undefined
  }
}

/** A card shows the start of a long input; the terminal dialog has all of it. */
const CARD_MAX_LINES = 8
const CARD_MAX_CHARS = 400

function clip(text: string): string {
  const lines = text.split('\n')
  const shown = lines.slice(0, CARD_MAX_LINES).join('\n').slice(0, CARD_MAX_CHARS)
  return shown.length < text.length ? `${shown}\n…（共 ${lines.length} 行，完整内容见终端）` : shown
}

function describeInput(tool: string, input: unknown): string {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  for (const key of ['command', 'file_path', 'url', 'path', 'pattern']) {
    if (typeof record[key] === 'string') return clip(String(record[key]))
  }
  try { return clip(JSON.stringify(input, null, 1)) } catch { return tool }
}

/** The tool's own one-line description of the call (Bash, Agent), when it has one. */
function describeCall(input: unknown): string {
  const description = (input && typeof input === 'object' ? (input as Record<string, unknown>).description : undefined)
  return typeof description === 'string' && description.trim() ? `：${description.trim().slice(0, 120)}` : ''
}

function formatReset(iso: string | undefined): string {
  const time = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(time)) return ''
  return `，${new Date(Math.round(time / 60_000) * 60_000).toISOString().slice(5, 16).replace('T', ' ')} UTC 重置`
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '当前 5 小时', seven_day: '本周（全部模型）', seven_day_sonnet: '本周（Sonnet）', seven_day_opus: '本周（Opus）',
}

/**
 * The plan's limit windows, read where the terminal's /usage reads them (an
 * undocumented endpoint; the engine adds the login, the plugin never sees it).
 * Undefined when it gives nothing usable.
 */
async function planLimits($: EngineInterface): Promise<string[] | undefined> {
  try {
    const auth = await $.session.authorize()
    if (auth?.kind !== 'bearer') return undefined
    const res = await $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
      auth: auth.handle, headers: { 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!res.ok) {
      $.ui.log(`agent2telegram: usage endpoint answered ${res.status}`, { to: 'debug' })
      return undefined
    }
    const body = JSON.parse(res.text) as Record<string, { utilization?: unknown; resets_at?: unknown } | null | undefined>
    const lines = Object.entries(LIMIT_NAMES).flatMap(([key, name]) => {
      const window = body[key]
      if (typeof window?.utilization !== 'number') return []
      const reset = typeof window.resets_at === 'string' ? window.resets_at : undefined
      return [`${name}：已用 ${Math.round(window.utilization)}%${formatReset(reset)}`]
    })
    return lines.length > 0 ? lines : undefined
  } catch (error) {
    $.ui.log(`agent2telegram: usage endpoint: ${String(error)}`, { to: 'debug' })
    return undefined
  }
}

async function usageText($: EngineInterface): Promise<string> {
  const [usage, plan] = await Promise.all([$.session.usage(), planLimits($)])
  const lines = plan ?? usage.rateLimits.map(l => `${LIMIT_NAMES[l.kind] ?? l.kind}：已用 ${l.percentUsed}%${formatReset(l.resetsAt)}`)
  if (lines.length === 0) lines.push('额度百分比暂时取不到，请在终端用 /usage 查看。')
  if (usage.cost) lines.push(`本会话花费：$${usage.cost.usd.toFixed(4)}`)
  return lines.join('\n')
}

function notice($: EngineInterface, text: string): Promise<unknown> {
  return call($, '/notice', { text })
}

/** Buttons in the topic plus Cancel; the chosen index, or undefined. */
async function menu($: EngineInterface, title: string, body: string, labels: string[]): Promise<number | undefined> {
  const stop = new AbortController()
  $.clock.after(MENU_TIMEOUT_MS, () => stop.abort())
  const answer = await askTelegram($, stop.signal, title, body, [...labels, CANCEL])
  const index = answer === undefined ? -1 : labels.indexOf(answer)
  return index >= 0 ? index : undefined
}

/** The effort Claude Code will use for `model`: its own setting, else the global one. */
async function currentEffort($: EngineInterface, model: string): Promise<string | undefined> {
  const perModel = await $.settings.read({ key: 'modelSettings' }).catch(() => undefined) as
    Record<string, { effortLevel?: string }> | undefined
  const global = await $.settings.read({ key: 'effortLevel' }).catch(() => undefined)
  const level = perModel?.[model]?.effortLevel ?? global
  return typeof level === 'string' ? level : undefined
}

async function statusText($: EngineInterface): Promise<string> {
  const [model, id, turns, cwd, usage] = await Promise.all([$.session.model(), $.session.id(), $.session.turns(),
    $.session.cwd(), $.session.usage()])
  const effort = await currentEffort($, model)
  const ctx = usage.context
  const context = ctx.percent !== undefined
    ? `已用 ${Math.round(ctx.percent)}%${ctx.tokens !== undefined ? `（${ctx.tokens.toLocaleString('en-US')} / ${ctx.window.toLocaleString('en-US')}）` : ''}`
    : `窗口 ${ctx.window.toLocaleString('en-US')}（发出第一条消息后才有占用）`
  return [
    `模型：${model}${effort ? `，强度 ${effort}` : ''}`,
    `目录：${cwd}`,
    `会话：${id}（已对话 ${turns} 轮）`,
    `上下文：${context}`,
    await usageText($),
  ].join('\n')
}

async function pickModel($: EngineInterface): Promise<void> {
  const model = await $.session.model()
  const labels = MODELS.map(([label, alias]) => (model.includes(alias) ? `✔ ${label}` : label))
  const index = await menu($, '切换模型', `当前：${model}\n切换后同时设为新会话的默认模型。`, labels)
  if (index === undefined) return
  await $.command.run({ command: 'model', args: MODELS[index]![1] })
  await notice($, `已切换到 ${await $.session.model()}（同时设为新会话默认）。`)
}

async function pickEffort($: EngineInterface): Promise<void> {
  const model = await $.session.model()
  const effort = await currentEffort($, model)
  const labels = EFFORTS.map(level => (level === effort ? `✔ ${level}` : level))
  const index = await menu($, '思考强度', `模型：${model}，当前：${effort ?? '未知'}\n切换后同时设为该模型新会话的默认强度；模型不支持的档位会自动降级。`, labels)
  if (index === undefined) return
  const out = await $.command.run({ command: 'effort', args: EFFORTS[index]! })
  await notice($, out.text?.trim() || `强度已设为 ${EFFORTS[index]}。`)
}

/** Your skills and plugin commands (built-ins mostly draw terminal panels). */
async function pickCommand($: EngineInterface): Promise<void> {
  const commands = (await $.command.list())
    .filter(c => (c.source === 'user' || c.source === 'plugin') && c.plugin !== 'agent2telegram')
    .slice(0, 40)
  if (commands.length === 0) { await notice($, '没有可用的自定义命令或技能。'); return }
  const body = commands.map(c => `/${c.name}${c.description ? `：${c.description.slice(0, 60)}` : ''}`).join('\n')
  const index = await menu($, '命令与技能', body, commands.map(c => `/${c.name}`))
  if (index === undefined) return
  const out = await $.command.run({ command: commands[index]!.name })
  if (out.text?.trim()) await notice($, out.text.trim())
}

async function handle($: EngineInterface, event: GatewayEvent) {
  if (event.type === 'prompt') {
    // A prompt waits until Claude is idle; keep order, but never block /stop behind it.
    const text = event.text
    promptChain = promptChain.then(() => $.prompt.submit({ text, asUser: true })).catch(error => {
      $.ui.log(`agent2telegram: ${String(error)}`, { to: 'debug' })
    })
  } else if (event.type === 'abort') {
    if (runningTurn) await $.turn.abort({ turnId: runningTurn }).catch(() => undefined)
  } else if (event.type === 'command') {
    const name = event.name
    void (async () => {
      try {
        if (name === 'status') await notice($, await statusText($))
        else if (name === 'model') await pickModel($)
        else if (name === 'effort') await pickEffort($)
        else if (name === 'commands') await pickCommand($)
        else {
          const out = await $.command.run({ command: name })
          await notice($, out.text?.trim() || `/${name} 已执行。`)
        }
      } catch (error) {
        await call($, '/notice', { text: `/${name} 执行失败：${String(error)}` })
      }
    })()
  } else if (event.type === 'restart') {
    // The gateway starts a helper that waits for this process to exit and then
    // types `claude … --resume <this session>` into the same tmux pane.
    const sessionId = await $.session.id()
    const prepared = await call($, '/restart-prepare', { sessionId }) as { ok?: boolean } | undefined
    if (!prepared?.ok) return
    if (runningTurn) await $.turn.abort({ turnId: runningTurn }).catch(() => undefined)
    void $.command.run({ command: 'exit' }).catch(error => {
      $.ui.log(`/restart 退出失败：${String(error)}`)
    })
  } else if (event.type === 'usage') {
    const text = await usageText($).catch(error => `读取用量失败：${String(error)}`)
    await call($, '/notice', { text })
  } else $.ui.log(event.text)
}

/** Register with the gateway. Says why once when it cannot (not running, not set up, directory taken). */
async function open($: EngineInterface, cwd: string): Promise<boolean> {
  const pid = Number((await $.process.run(['sh', '-c', 'echo $PPID']).catch(() => undefined))?.stdout.trim())
  const result = await call($, '/open', {
    cwd,
    claudeSessionId: await $.session.id(),
    ...(Number.isSafeInteger(pid) && pid > 1 ? { pid } : {}),
    pane: (await $.env.get('TMUX_PANE')) ?? '',
    modDir: $.plugin.root,
  }) as OpenResult | undefined
  const reason = result === undefined ? 'Telegram 网关未运行（a2t status）。' : result.ok ? undefined : result.reason
  if (reason !== undefined) {
    // A directory that is simply not enabled stays idle and says nothing.
    const quiet = result !== undefined && !result.ok && result.quiet === true
    if (reason !== lastReason && !quiet) $.ui.log(reason)
    lastReason = reason
    connected = false
    return false
  }
  if (result?.ok) {
    if (lastReason !== undefined || !connected) $.ui.log('Telegram 已接入。')
    for (const notice of result.notices ?? []) $.ui.log(notice)
  }
  lastReason = undefined
  connected = true
  return true
}

/** Connect, then long-poll the gateway for as long as the module lives. */
async function serve($: EngineInterface, cwd: string, mine: number) {
  while (!closing && mine === generation) {
    if (!connected && !(await open($, cwd))) {
      await later($, 5_000)
      continue
    }
    const reply = await call($, '/poll') as { events?: GatewayEvent[]; unknown?: true } | undefined
    if (reply === undefined) { connected = false; await later($, 5_000); continue }
    if (reply.unknown) { connected = false; continue } // the gateway restarted: register again
    for (const event of reply.events ?? []) {
      try { await handle($, event) } catch (error) { $.ui.log(`agent2telegram: ${String(error)}`, { to: 'debug' }) }
    }
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    // Same rule as the gateway: $CLAUDE_TELEGRAM_DIR, else <$AGENT2TELEGRAM_DIR or ~/.agent2telegram>/claude.
    const dataDir = (await $.env.get('CLAUDE_TELEGRAM_DIR'))
      ?? `${(await $.env.get('AGENT2TELEGRAM_DIR')) ?? `${await $.env.get('HOME')}/.agent2telegram`}/claude`
    socketPath = `${dataDir}/gateway.sock`
    // A new conversation in the same process (/resume): register again, so the
    // gateway knows the current session id, with one poll loop at a time.
    generation += 1
    closing = false
    connected = false
    void serve($, e.cwd, generation)
    return started
  })

  // /clear and /resume end a conversation, not Claude Code: only a real exit
  // says goodbye (a session killed without one is dropped by the gateway).
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear' && e.reason !== 'resume') {
      closing = true
      if (connected) await call($, '/close')
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    runningTurn = e.turnId
    void call($, '/turn-start')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    if (runningTurn === e.turnId) runningTurn = undefined
    await call($, '/turn-complete', { answer: e.answer, isAborted: e.isAborted })
    return result
  })

  // Permission dialog: the terminal dialog stays up while Telegram is asked too.
  // A Telegram tap answers it (the dialog closes); a terminal answer aborts this
  // hook, and the Telegram buttons are taken back.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!connected || PERSON_TOOLS.has(e.tool_name)) return next(e)
    const answer = await askTelegram($, next.signal, `Claude 请求使用 ${e.tool_name}${describeCall(e.tool_input)}`,
      describeInput(e.tool_name, e.tool_input), [ALLOW, DENY])
    if (answer === ALLOW) return { decision: { behavior: 'allow' } }
    if (answer === DENY) return { decision: { behavior: 'deny', message: '用户在 Telegram 中拒绝了这次操作。' } }
    return next(e)
  }).catch(($, e, next) => next(e)) // on failure, the terminal dialog alone decides

  // Single-choice questions (one or several): the terminal dialog opens as usual;
  // Telegram asks them one by one. Answering all of them there answers for the
  // person and closes the dialog; a terminal answer takes the buttons back.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const questions = e.questions
    // Text and number questions (a newer input shape) stay in the terminal.
    const relayable = questions.length > 0 && questions.every(q => {
      const kind = (q as { kind?: string }).kind
      return !q.multiSelect && (kind === undefined || kind === 'choice') && q.options?.length > 0
    })
    if (!connected || !relayable) return next(e)
    const engine = next(e)
    const answers: Record<string, string> = {}
    for (const [index, q] of questions.entries()) {
      const title = questions.length > 1 ? `(${index + 1}/${questions.length}) ${q.question}` : q.question
      const body = q.options.map(o => (o.description ? `${o.label}：${o.description}` : o.label)).join('\n')
      const labels = [...q.options.map(o => o.label), CUSTOM, CHAT]
      const answer = await askTelegram($, next.signal, title, body, labels, engine, CUSTOM)
      if (answer === undefined) return engine
      if (answer === CHAT) return { deny: CHAT_REASON }
      answers[q.question] = answer
    }
    return { result: { questions: e.questions, answers } }
  }).catch(($, e, next) => next(e)) // on failure, the terminal dialog alone answers
}
