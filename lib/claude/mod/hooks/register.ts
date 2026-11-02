// Claude Code side of the Telegram bridge. Every session connects to the local
// gateway (a systemd --user service that alone polls the Bot) over a Unix
// socket, gets the forum topic of its launch directory, and long-polls for what
// Telegram sent there. Telegram text becomes a prompt; /stop, /compact, /clear,
// /usage and /restart run here; each main-loop turn's final answer goes back.
// Permission dialogs and AskUserQuestion are also shown in Telegram: whichever
// side answers first wins, and the other side's question goes away.
import type { EngineInterface, Register } from 'claude-code'

type GatewayEvent =
  | { type: 'prompt'; text: string }
  | { type: 'abort' }
  | { type: 'command'; name: 'compact' | 'clear' }
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

function describeInput(tool: string, input: unknown): string {
  const record = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  for (const key of ['command', 'file_path', 'url', 'path', 'pattern']) {
    if (typeof record[key] === 'string') return String(record[key])
  }
  try { return JSON.stringify(input, null, 1).slice(0, 800) } catch { return tool }
}

function formatReset(iso: string | undefined): string {
  return iso ? `，${iso.slice(5, 16).replace('T', ' ')} UTC 重置` : ''
}

async function usageText($: EngineInterface): Promise<string> {
  const usage = await $.session.usage()
  const names: Record<string, string> = { five_hour: '当前 5 小时', seven_day: '本周（全部模型）' }
  const lines = usage.rateLimits.map(l => `${names[l.kind] ?? l.kind}：已用 ${l.percentUsed}%${formatReset(l.resetsAt)}`)
  if (usage.cost) lines.push(`本会话花费：$${usage.cost.usd.toFixed(4)}`)
  return lines.length > 0 ? lines.join('\n') : '暂时没有用量数据（本会话发出第一条消息后才有）。'
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
        const out = await $.command.run({ command: name })
        await call($, '/notice', { text: out.text?.trim() || `/${name} 已执行。` })
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
async function serve($: EngineInterface, cwd: string) {
  while (!closing) {
    if (!connected && !(await open($, cwd))) {
      await later($, 30_000)
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
    void serve($, e.cwd)
    return started
  })

  // /clear ends the conversation but not the session's connection; only a real
  // exit says goodbye (a session killed without one is dropped after a minute).
  on('session.end', async ($, e, next) => {
    if (e.reason !== 'clear') {
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
    const answer = await askTelegram($, next.signal, `Claude 请求使用 ${e.tool_name}`,
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
