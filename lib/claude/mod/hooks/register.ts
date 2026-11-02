// Claude Code side of the Telegram bridge (one directory, one topic).
// Starts the sidecar at session start. Telegram text becomes a prompt; /stop,
// /compact, /clear and /usage run here; each main-loop turn's final answer goes
// back. Permission dialogs and AskUserQuestion are also shown in Telegram:
// whichever side answers first wins, and the other side's question goes away.
import type { EngineInterface, Register } from 'claude-code'

type SidecarEvent =
  | { type: 'prompt'; text: string }
  | { type: 'abort' }
  | { type: 'command'; name: 'compact' | 'clear' }
  | { type: 'usage' }
  | { type: 'restart' }
  | { type: 'log'; text: string }

type PendingResult = { answer: string } | { cancelled: true } | { pending: true }

const ALLOW = '✅ 允许'
const DENY = '❌ 拒绝'
// The dialog's own extra rows: "Type something." and "Chat about this".
const CUSTOM = '✏️ 自定义输入'
const CHAT = '💬 先聊聊'
const CHAT_REASON = '用户选择先就这些问题聊一聊，暂不作答。请停下来，等待用户的下一条消息。'
// Tools whose dialog is a question for the person, not a yes/no approval: their
// permission request is not relayed (AskUserQuestion has its own relay below).
const PERSON_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

// Module state: starts over when the module reloads; the sidecar is restarted then too.
let socketPath: string | undefined
let runningTurn: string | undefined
let promptChain: Promise<unknown> = Promise.resolve()
let idCounter = 0

function newId(): string {
  idCounter += 1
  return `${Date.now().toString(36)}${idCounter.toString(36)}`
}

/** POST to the sidecar; the parsed JSON reply, or undefined when it is not reachable. */
async function call($: EngineInterface, path: string, body: unknown): Promise<unknown> {
  if (!socketPath) return undefined
  try {
    const res = await $.http.fetch(`http://sidecar${path}`, {
      method: 'POST',
      socketPath,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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

async function handle($: EngineInterface, event: SidecarEvent) {
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
    // The sidecar starts a helper that waits for this process to exit and then
    // types `claude --resume <this session>` into the same tmux pane.
    const sessionId = await $.session.id()
    const prepared = await call($, '/restart-prepare', { sessionId, modDir: $.plugin.root }) as { ok?: boolean } | undefined
    if (!prepared?.ok) return
    if (runningTurn) await $.turn.abort({ turnId: runningTurn }).catch(() => undefined)
    void $.command.run({ command: 'exit' }).catch(error => {
      $.ui.log(`agent2telegram: /restart 退出失败：${String(error)}`)
    })
  } else if (event.type === 'usage') {
    const text = await usageText($).catch(error => `读取用量失败：${String(error)}`)
    await call($, '/notice', { text })
  } else $.ui.log(event.text)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    if (!e.isInteractive) return started
    const dataDir = (await $.env.get('CLAUDE_TELEGRAM_DIR')) ?? `${await $.env.get('HOME')}/.claude-telegram`
    const id = (await $.session.id()).replace(/[^\w-]/g, '').slice(0, 16)
    socketPath = `${dataDir}/run/${id}.sock`
    const entry = `${$.plugin.root}/../../../dist/lib/claude/sidecar/main.js`
    const sock = socketPath
    void (async () => {
      let buffered = ''
      try {
        const child = $.process.spawn({ argv: ['node', entry, '--cwd', e.cwd, '--socket', sock] })
        for await (const { stream, text } of child) {
          if (stream === 'stderr') { $.ui.log(`agent2telegram: ${text}`, { to: 'debug' }); continue }
          buffered += text
          let newline = buffered.indexOf('\n')
          while (newline >= 0) {
            const line = buffered.slice(0, newline).trim()
            buffered = buffered.slice(newline + 1)
            newline = buffered.indexOf('\n')
            if (!line) continue
            try { await handle($, JSON.parse(line) as SidecarEvent) } catch (error) {
              $.ui.log(`agent2telegram: ${String(error)}`, { to: 'debug' })
            }
          }
        }
      } catch (error) {
        $.ui.log(`agent2telegram: sidecar 无法启动：${String(error)}`)
      }
      socketPath = undefined
    })()
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    runningTurn = e.turnId
    void call($, '/turn-start', {})
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
    if (!socketPath || PERSON_TOOLS.has(e.tool_name)) return next(e)
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
    if (!socketPath || !relayable) return next(e)
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
