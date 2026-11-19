// dshx-remote — pure session-log → phone transcript projection.
//
// Kept free of host imports so it can be unit-tested against recorded logs.
// Event shapes verified against DSH 0.2.0-rc.2 (dsh-agent-loop, dsh-llm,
// dsh-user-approval, dshx-message-edit):
//
//   user/message       data = Message { id, role:'user', content[], source{kind} }
//   assistant/message  data = { message: Message { id, content[text|reasoning|tool-call] } }
//   tool/result        data = { turn, step, message: { toolCallId, content[], isError } }
//   approval/asked     data = { id, toolName, callId?, reason? }
//   approval/decided   data = { id, outcome }
//   turn/start|end     data = { turn } / { turn, reason: { kind, … } }
//   session/title      data = { title }

const MAX_TEXT = 60_000
const MAX_TOOL_RESULT = 4_000
const MAX_TOOL_ARGS = 1_500

/** Join the text blocks of a content array. */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片]')
  }
  return parts.join('\n')
}

function clip(text, max) {
  if (typeof text !== 'string') return ''
  return text.length > max ? text.slice(0, max) + `\n…（已截断，共 ${text.length} 字）` : text
}

/** One-line summary of a tool call's JSON arguments. */
export function summarizeArgs(name, raw) {
  let args = null
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw) } catch { args = null }
  } else if (raw !== null && typeof raw === 'object') args = raw
  if (args === null || typeof args !== 'object') return { summary: '', detail: clip(String(raw ?? ''), MAX_TOOL_ARGS) }
  const pick = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'objective']
  let summary = ''
  for (const key of pick) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') { summary = value.trim().split('\n')[0]; break }
    if (Array.isArray(value) && typeof value[0] === 'string') { summary = value.join(' · '); break }
  }
  let detail = ''
  try { detail = JSON.stringify(args, null, 2) } catch { detail = '' }
  return { summary: clip(summary, 200), detail: clip(detail, MAX_TOOL_ARGS) }
}

function jsonOf(text) {
  try { const v = JSON.parse(text); return v !== null && typeof v === 'object' ? v : null } catch { return null }
}

/** Questions of an `ask_user_question` call, in the service's vocabulary. */
export function questionsOfArgs(raw) {
  const args = typeof raw === 'string' ? jsonOf(raw) : raw
  if (!args || !Array.isArray(args.questions) || args.questions.length === 0) return null
  const out = []
  for (const q of args.questions.slice(0, 20)) {
    if (!q || typeof q.id !== 'string' || typeof q.question !== 'string') return null
    out.push({
      id: q.id,
      question: clip(q.question, 4000),
      ...(typeof q.header === 'string' ? { header: q.header.slice(0, 200) } : {}),
      ...(Array.isArray(q.options) ? { options: q.options.slice(0, 30).filter((o) => o && typeof o.label === 'string').map((o) => ({ label: o.label, ...(typeof o.description === 'string' ? { description: o.description.slice(0, 1000) } : {}) })) } : {}),
      multiSelect: q.multi_select === true || q.multiSelect === true,
    })
  }
  return out
}

const NOTICE_FOR_END = {
  error: '本轮出错',
  aborted: '已停止',
  blocked: '本轮被拦截',
  'max-tokens': '输出达到长度上限',
}

/**
 * Project a session log into phone transcript items.
 * @param events - complete session event array (live snapshot or cold read).
 * @param options - `{ limit, before }`: newest `limit` items with seq < before.
 * @returns `{ items, hasMore, title, lastSeq }`.
 */
export function buildTranscript(events, options = {}) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 150
  const before = Number.isSafeInteger(options.before) ? options.before : Infinity
  const list = Array.isArray(events) ? events : []

  // Prompts withdrawn by dshx-message-edit stay out of the phone transcript,
  // matching the desktop. Compaction replacements are NOT hidden: the user
  // still sees pre-compaction history on the desktop.
  const withdrawn = new Set()
  const overrides = new Map()
  for (const event of list) {
    if (event?.type === 'user/message' && event.data?.source?.kind === 'dshx-message-edit' && Array.isArray(event.sourceEventSeqs)) {
      for (const seq of event.sourceEventSeqs) withdrawn.add(seq)
    }
    if (event?.type === 'dshx-message-edit/override' && typeof event.data?.messageId === 'string' && typeof event.data?.text === 'string') {
      overrides.set(event.data.messageId, event.data.text)
    }
  }

  const items = []
  const tools = new Map()
  const approvals = new Map()
  const questionCalls = new Map()
  let timed = false
  let title = null
  let lastSeq = -1

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue
    const seq = Number.isSafeInteger(event.seq) ? event.seq : lastSeq + 1
    lastSeq = Math.max(lastSeq, seq)
    const time = typeof event.time === 'number' ? event.time : null
    switch (event.type) {
      case 'session/title':
        if (typeof event.data?.title === 'string') title = event.data.title
        break
      case 'user/message': {
        const data = event.data
        if (data?.source?.kind === 'user-question-reply') {
          const question = questionCalls.get(data.source.callId)
          if (question && question.state === 'pending') {
            question.state = 'answered'
            question.late = true
            question.answers = jsonOf(textOf(data.content))?.answers ?? []
          }
          break
        }
        if (data?.source?.kind !== 'user' || withdrawn.has(seq)) break
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') break
        items.push({ kind: 'user', seq, time, id: data.id, text: clip(textOf(data.content), MAX_TEXT) })
        break
      }
      case 'assistant/message': {
        const message = event.data?.message
        if (!message || withdrawn.has(seq)) break
        const content = Array.isArray(message.content) ? message.content : []
        const override = typeof message.id === 'string' ? overrides.get(message.id) : undefined
        const text = override ?? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        const reasoning = content.filter((b) => b?.type === 'reasoning' && typeof b.text === 'string').map((b) => b.text).join('\n')
        if (text.trim() !== '' || reasoning.trim() !== '') {
          items.push({ kind: 'assistant', seq, time, id: message.id, text: clip(text, MAX_TEXT), reasoning: clip(reasoning, 8000) })
        }
        for (const block of content) {
          if (block?.type !== 'tool-call') continue
          if (block.name === 'ask_user_question') {
            const asked = questionsOfArgs(block.arguments)
            if (asked) {
              const item = { kind: 'question', seq, time, callId: block.id, questions: asked, state: 'open', answers: null }
              questionCalls.set(block.id, item)
              items.push(item)
              continue
            }
          }
          const { summary, detail } = summarizeArgs(block.name, block.arguments)
          const item = { kind: 'tool', seq, time, callId: block.id, name: String(block.name ?? ''), summary, args: detail, status: 'running', result: '' }
          tools.set(block.id, item)
          items.push(item)
        }
        break
      }
      case 'request/header': {
        const list = event.data?.header?.tools
        timed = Array.isArray(list) && list.some((t) => t?.name === 'ask_user_question' && t.parameters?.properties && 'timeout' in t.parameters.properties)
        break
      }
      case 'tool/result': {
        const message = event.data?.message
        const question = questionCalls.get(message?.toolCallId)
        if (question) {
          const payload = jsonOf(textOf(message.content))
          if (payload?.pending === true || (timed && event.data?.error?.code === 'TOOL_OUTCOME_UNKNOWN')) question.state = 'pending'
          else if (event.data?.error === undefined && message.isError !== true && Array.isArray(payload?.answers)) { question.state = 'answered'; question.answers = payload.answers }
          else question.state = 'failed'
          break
        }
        const item = tools.get(message?.toolCallId)
        if (!item) break
        item.status = message.isError === true ? 'error' : 'done'
        item.result = clip(textOf(message.content), MAX_TOOL_RESULT)
        break
      }
      case 'approval/asked': {
        const data = event.data ?? {}
        const item = { kind: 'approval', seq, time, id: data.id, callId: typeof data.callId === 'string' ? data.callId : null, toolName: String(data.toolName ?? ''), reason: clip(String(data.reason ?? ''), 2000), outcome: null }
        approvals.set(data.id, item)
        items.push(item)
        break
      }
      case 'approval/decided': {
        const item = approvals.get(event.data?.id)
        if (item) item.outcome = String(event.data?.outcome ?? '')
        break
      }
      case 'turn/end': {
        const kind = event.data?.reason?.kind
        const label = NOTICE_FOR_END[kind]
        if (label) {
          const detail = kind === 'error' ? String(event.data?.reason?.error?.message ?? '') : ''
          items.push({ kind: 'notice', seq, time, level: kind === 'aborted' ? 'info' : 'warn', text: label, detail: clip(detail, 1000) })
        }
        // Tool calls left without a result when the turn ended were interrupted.
        for (const tool of tools.values()) if (tool.status === 'running') tool.status = 'interrupted'
        // A question still open when its turn ends was interrupted. A timed one
        // may later be repaired to pending (TOOL_OUTCOME_UNKNOWN result, above).
        for (const question of questionCalls.values()) if (question.state === 'open') question.state = 'failed'
        break
      }
      case 'compaction/summary':
        items.push({ kind: 'notice', seq, time, level: 'info', text: '上下文已压缩', detail: '' })
        break
      default:
        break
    }
  }

  const eligible = items.filter((item) => item.seq < before)
  const start = Math.max(0, eligible.length - limit)
  return { items: eligible.slice(start), hasMore: start > 0, title, lastSeq }
}
