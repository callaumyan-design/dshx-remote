// dshx-remote — remote-control DSH from a phone (host half).
//
// WHAT IT DOES
//   A second, plugin-owned HTTP server (default port 19388) that a phone can
//   reach over the LAN or Tailscale. It serves a mobile web app (PWA) and a
//   small JSON + SSE API for: listing sessions, reading a transcript, sending
//   a prompt, creating a session, stopping a turn, and answering sandbox
//   approval requests. DSH's own Web server stays on 127.0.0.1 untouched.
//
// SECURITY MODEL
//   * Off-host access is refused unless the peer is loopback / private LAN /
//     Tailscale CGNAT (configurable `allowPublic`, default false).
//   * Every API call needs a device bearer token. Tokens are obtained once by
//     redeeming a short-lived single-use pairing code shown in DSH Settings
//     (which itself sits behind DSH's own browser auth). Only token hashes are
//     stored, in ~/.dsh/dshx-remote/devices.json. Devices can be revoked.
//   * Failed pairing / auth attempts are rate-limited per address.
//   * The bearer token is sent in a header (never a cookie), so cross-site
//     requests cannot ride on it; CORS is not enabled.
//
// HOST CONTRACTS (verified against DSH 0.2.0-rc.2 sources, not guessed):
//   * ctx.sessionController.list / inspect / create / prompt / cancel — the
//     same facade the desktop UI's /api uses (dsh-api-session-controller).
//     prompt() resumes a cold session itself; cancel() needs a live agent.
//   * Approval: the host runs `ctx.waterfall(agentScope, 'approval/request',
//     req, …)` (dsh-user-approval). The desktop UI answers through a
//     Remote-event forwarder; this plugin registers a PREPENDED listener that
//     races a phone answer against the rest of the chain, so whichever of
//     desktop / phone answers first wins. dshx-ai-approval (also prepended,
//     registered earlier) keeps owning sessions in its AI preset.
//   * Live updates: `session/event` (every durable append), `agent/status`,
//     and `agent/assistant-stream` (in-flight text deltas), all global events.

import { createServer } from 'node:http'
import { promises as fs, createReadStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { DeviceStore, RateLimiter, addressAllowed, classifyAddress } from './auth.js'
import { buildTranscript, textOf } from './transcript.js'

export const name = 'dshx-remote'
export const inject = ['webServer', 'sessions', 'agents']

export const Config = z.object({
  port: z.natural().max(65535).default(19388),
  host: z.string().default('0.0.0.0'),
  allowPublic: z.boolean().default(false),
  approvalTimeoutSeconds: z.natural().max(86400).default(0),
})

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MOBILE_DIR = path.join(HERE, 'mobile')
const DATA_DIR = path.join(os.homedir(), '.dsh', 'dshx-remote')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY = 256 * 1024
const MAX_PROMPT_CHARS = 100_000
// Cross-plugin hand-off with dshx-ai-approval (registry symbols, so the two
// packages need no import of each other):
//   HUMAN_HOOK  — set by us on an AI-preset request when we run first; the AI
//                 reviewer calls `req[HUMAN_HOOK](next)` instead of `next()`
//                 when it hands the decision to a human.
//   AI_HANDOFF  — set by the AI reviewer before it calls `next()` for a human,
//                 so that when we run after it we know the human stage began.
export const HUMAN_HOOK = Symbol.for('dshx.approval.human')
export const AI_HANDOFF = Symbol.for('dshx.approval.ai-handoff')
const require = createRequire(import.meta.url)
const qrcode = require('./vendor/qrcode.cjs')

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon.png': ['icon.png', 'image/png'],
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}
const PAGE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function describeError(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/** Accept `session-<uuid>` or a bare uuid; return the canonical prefixed id. */
export function canonicalId(sessionId) {
  if (typeof sessionId !== 'string') return null
  const bare = sessionId.startsWith('session-') ? sessionId.slice(8) : sessionId
  return UUID.test(bare) ? 'session-' + bare.toLowerCase() : null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch { reject(Object.assign(new Error('请求体不是 JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  if (res.headersSent) return
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Unwrap a RemoteError-ish failure into a readable message. */
function remoteMessage(error) {
  const code = error?.code
  const message = describeError(error)
  if (code === 'session/model-unavailable') return '当前没有可用的模型，请先在电脑上选择模型'
  if (code === 'session/not-found') return '会话不存在或未载入'
  if (code === 'session/writer-held') return '该会话正被另一个 DSH 进程占用'
  return message
}

/** LAN / Tailscale IPv4 addresses for the pairing URL. */
export function reachableAddresses() {
  const out = []
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      const kind = classifyAddress(iface.address)
      if (kind === 'lan' || kind === 'tailscale') out.push({ address: iface.address, kind, interface: ifname })
    }
  }
  // Prefer Tailscale (works off-site), then 192.168.*, then the rest.
  const rank = (entry) => entry.kind === 'tailscale' ? 0 : entry.address.startsWith('192.168.') ? 1 : entry.address.startsWith('169.254.') ? 3 : 2
  return out.sort((a, b) => rank(a) - rank(b))
}

/** Wire-safe copy of a question batch (labels/descriptions as plain strings). */
export function normalizeQuestions(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((q) => ({
    id: String(q?.id ?? ''),
    question: String(q?.question ?? '').slice(0, 4000),
    ...(typeof q?.header === 'string' ? { header: q.header.slice(0, 200) } : {}),
    ...(typeof q?.detail === 'string' ? { detail: q.detail.slice(0, 20000) } : {}),
    ...(Array.isArray(q?.options) ? { options: q.options.slice(0, 30).map((o) => ({ label: String(o?.label ?? ''), ...(typeof o?.description === 'string' ? { description: o.description.slice(0, 1000) } : {}) })) } : {}),
    multiSelect: q?.multiSelect === true || q?.multi_select === true,
  }))
}

/**
 * Validate a phone-submitted answer batch against the asked questions: one
 * item per question id, selected labels limited to the offered options.
 */
export function validateAnswers(asked, raw) {
  if (!Array.isArray(raw)) throw Object.assign(new Error('answers 必须是数组'), { status: 400 })
  const byId = new Map(raw.map((a) => [String(a?.id ?? ''), a]))
  return asked.map((q) => {
    const a = byId.get(q.id) ?? {}
    const labels = new Set((q.options ?? []).map((o) => o.label))
    let selected = Array.isArray(a.selected) ? [...new Set(a.selected.map(String))].filter((l) => labels.has(l)) : []
    if (!q.multiSelect) selected = selected.slice(0, 1)
    const custom = typeof a.custom === 'string' && a.custom.trim() !== '' ? a.custom.slice(0, 20000) : undefined
    return { id: q.id, selected, ...(custom !== undefined ? { custom } : {}) }
  })
}

function qrSvg(text) {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const settings = {
    port: Number.isSafeInteger(config.port) ? config.port : 19388,
    host: typeof config.host === 'string' && config.host !== '' ? config.host : '0.0.0.0',
    allowPublic: config.allowPublic === true,
    approvalTimeoutMs: Number.isSafeInteger(config.approvalTimeoutSeconds) ? config.approvalTimeoutSeconds * 1000 : 0,
  }
  const log = (() => {
    try { return typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger } catch { return undefined }
  })()
  const controller = () => {
    try { return ctx.get?.('sessionController') } catch { return undefined }
  }

  const store = new DeviceStore(path.join(DATA_DIR, 'devices.json'))
  const ready = store.load().catch((error) => { log?.warn?.('device store load failed: %s', describeError(error)) })
  const pairLimiter = new RateLimiter(8, 10 * 60_000)
  const authLimiter = new RateLimiter(30, 10 * 60_000)
  const serverState = { listening: false, error: null, port: settings.port }

  // -------------------------------------------------------------------------
  // live event fan-out (SSE)
  // -------------------------------------------------------------------------

  /** @type {Set<{ res, device, sessionId: string|null }>} */
  const clients = new Set()
  /** sessionId -> { attemptId, text, reasoning } for in-flight assistant text */
  const streams = new Map()

  function broadcast(event, data, filter) {
    const frame = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'
    for (const client of clients) {
      if (filter && !filter(client)) continue
      try { client.res.write(frame) } catch { /* closed; cleaned on 'close' */ }
    }
  }

  const sessionDirty = new Map()
  function markSessionDirty(sessionId, seq) {
    if (clients.size === 0) return
    // Coalesce bursts (a tool step can append dozens of events at once).
    if (sessionDirty.has(sessionId)) { sessionDirty.get(sessionId).seq = seq; return }
    const entry = { seq }
    sessionDirty.set(sessionId, entry)
    setTimeout(() => {
      sessionDirty.delete(sessionId)
      broadcast('session', { sessionId, seq: entry.seq }, (c) => c.sessionId === sessionId)
    }, 250)
  }

  ctx.on('session/event', (session, event) => {
    if (!session || typeof session.id !== 'string') return
    markSessionDirty(session.id, event?.seq)
    if (event?.type === 'assistant/message') {
      streams.delete(session.id)
    }
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      broadcast('list', { sessionId: session.id })
    }
    if (event?.type === 'session/title') broadcast('list', { sessionId: session.id })
  })

  ctx.on('agent/status', (payload) => {
    const agent = payload?.agent
    if (!agent || typeof agent.id !== 'string') return
    const running = payload.status === 'running'
    if (!running) streams.delete(agent.id)
    broadcast('status', { sessionId: agent.id, running })
  })

  ctx.on('agent/assistant-stream', (payload) => {
    const agent = payload?.agent
    const frame = payload?.frame
    if (!agent || !frame || clients.size === 0) return
    const sessionId = agent.session?.id ?? agent.id
    if (frame.type === 'start') {
      streams.set(sessionId, { attemptId: frame.attemptId, text: '', reasoning: '', pending: false })
      return
    }
    const stream = streams.get(sessionId)
    if (!stream || stream.attemptId !== frame.attemptId) return
    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') stream.text += chunk.text
      else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') stream.reasoning += chunk.text
      else return
      if (stream.pending) return
      stream.pending = true
      setTimeout(() => {
        stream.pending = false
        if (streams.get(sessionId) !== stream) return
        broadcast('stream', { sessionId, text: stream.text.slice(-20000), reasoning: stream.reasoning.slice(-4000) }, (c) => c.sessionId === sessionId)
      }, 200)
      return
    }
    if (frame.type === 'end') {
      streams.delete(sessionId)
      broadcast('stream', { sessionId, text: null }, (c) => c.sessionId === sessionId)
    }
  })

  // -------------------------------------------------------------------------
  // remote approvals
  // -------------------------------------------------------------------------

  /** id -> pending approval */
  const approvals = new Map()

  function publicApproval(entry) {
    return { id: entry.id, sessionId: entry.sessionId, toolName: entry.toolName, callId: entry.callId, reason: entry.reason, askedAt: entry.askedAt }
  }

  /** Whether remote control is on and at least one phone is paired. */
  function engaged(sessionId) {
    return store.enabled && store.state.devices.length > 0 && typeof sessionId === 'string'
  }

  /**
   * Whether a phone is actually connected right now (an open /api/events SSE
   * stream), optionally narrowed to one session.
   *
   * Pairing is durable, presence is not: `engaged()` stays true while the phone
   * is asleep, out of the app, or off the network. Racing approvals against
   * such a phone blocks the desktop card until the turn is killed — the reason
   * a denied request could hang for 18 minutes with nothing on screen. Only a
   * live stream can answer, so only a live stream may take part.
   */
  /**
   * Whether a phone is actually connected right now (an open /api/events SSE
   * stream), optionally narrowed to one session.
   *
   * Pairing is durable, presence is not: `engaged()` stays true while the phone
   * is asleep, out of the app, or off the network. Racing approvals against
   * such a phone blocks the desktop card until the turn is killed — the reason
   * a denied request could hang for 18 minutes with nothing on screen. Only a
   * live stream can answer, so only a live stream may take part.
   *
   * A stream that names no session subscribes to every session, and
   * canonicalId('') yields null (not undefined), so both must count as "all".
   */
  function phoneOnline(sessionId) {
    for (const client of clients) {
      const res = client?.res
      if (res === undefined || res.writableEnded || res.destroyed) continue
      if (client.sessionId === undefined || client.sessionId === null || client.sessionId === sessionId) return true
    }
    return false
  }

  function inAiPreset(agent) {
    try { return ctx.get?.('permissionPresets')?.current?.(agent.session) === 'ai-approval' } catch { return false }
  }

  ctx.on('approval/request', function (req, next) {
    const agent = req?.agent
    const sessionId = agent?.session?.id ?? agent?.id
    // Nobody paired / remote disabled: stay out of the way entirely.
    if (!engaged(sessionId)) return next()
    // Sessions in dshx-ai-approval's preset are first decided by the AI
    // reviewer. Only when it hands the request to a human (AI denied or could
    // not decide) does the phone join in. The hand-off works in either chain
    // order: if the reviewer runs after us it calls the hook we leave on the
    // request; if it runs before us it marks the request as handed off.
    if (inAiPreset(agent) && req[AI_HANDOFF] === undefined) {
      // Leave the hand-off hook only while a phone is really listening.
      // Installing it against a paired-but-absent phone made the reviewer hand
      // the decision to a race that waited forever while the desktop card
      // never became usable. When no phone is live the reviewer calls next()
      // directly and the desktop UI owns the decision.
      if (phoneOnline(sessionId)) {
        try { req[HUMAN_HOOK] = (human) => raceApproval(req, sessionId, human) } catch { /* frozen request */ }
      }
      return next()
    }
    // Handed off by the reviewer: race the phone only if it is actually online;
    // otherwise the human stage is the desktop chain alone.
    if (req[AI_HANDOFF] !== undefined && !phoneOnline(sessionId)) return next()
    return raceApproval(req, sessionId, next)
  }, { prepend: true })

  function raceApproval(req, sessionId, next) {
    // Give the rest of the chain a signal we can abort, so that when the phone
    // answers first the desktop approval panel is withdrawn instead of staying
    // open (the gateway cancels a forwarded request when its signal aborts).
    const withdraw = new AbortController()
    const original = req.signal
    try {
      req.signal = original ? AbortSignal.any([original, withdraw.signal]) : withdraw.signal
    } catch { /* frozen request: the desktop panel may linger until the turn ends */ }

    const id = randomUUID()
    let settle
    const phone = new Promise((resolve) => { settle = resolve })
    const entry = {
      id,
      sessionId,
      toolName: String(req.toolName ?? ''),
      callId: typeof req.callId === 'string' ? req.callId : null,
      reason: String(req.displayReason ?? req.reason ?? '').slice(0, 4000),
      askedAt: Date.now(),
      settle,
      done: false,
    }
    approvals.set(id, entry)
    broadcast('approval', publicApproval(entry))

    const finish = () => {
      if (entry.done) return
      entry.done = true
      approvals.delete(id)
      broadcast('approval-done', { id, sessionId })
    }

    // Run the rest of the chain (desktop UI, ACP, …) concurrently. If it
    // settles first its answer wins; if the phone answers first, the desktop
    // prompt stays open until the host's signal aborts the request — the
    // approval service resolves on our value regardless.
    const desktop = Promise.resolve().then(() => next()).then(
      (outcome) => ({ from: 'desktop', outcome }),
      (error) => ({ from: 'desktop', error }),
    )
    const racers = [desktop, phone.then((outcome) => ({ from: 'phone', outcome }))]
    if (original) {
      racers.push(new Promise((resolve) => {
        if (original.aborted) return resolve({ from: 'signal', outcome: 'cancelled' })
        original.addEventListener('abort', () => resolve({ from: 'signal', outcome: 'cancelled' }), { once: true })
      }))
    }
    // A configured timeout guards the case where NO interactive surface is
    // answering — it must never cut short a desktop card the user is looking
    // at, so it only applies once the desktop chain reports it has no answerer
    // (see the desktopGaveUp branch below). While a desktop card is on screen
    // the user may take as long as they need.
    const noAnswererTimeout = () => settings.approvalTimeoutMs > 0
      ? new Promise((resolve) => {
        const timer = setTimeout(() => resolve('rejected'), settings.approvalTimeoutMs)
        timer.unref?.()
      })
      : null
    return Promise.race(racers).then((result) => {
      const desktopGaveUp = result.from === 'desktop' && (result.error !== undefined || result.outcome === 'unavailable')
      if (desktopGaveUp) {
        // The desktop chain had no answerer (no GUI attached): keep waiting
        // for the phone instead of failing closed immediately, but never past
        // the configured timeout.
        const waiting = [phone, ...racers.slice(2).map((p) => p.then((r) => r.outcome))]
        const guard = noAnswererTimeout()
        if (guard) waiting.push(guard)
        return Promise.race(waiting).finally(() => {
          finish()
          withdraw.abort(new Error('answered from dshx-remote'))
        })
      }
      finish()
      if (result.from !== 'desktop') withdraw.abort(new Error('answered from dshx-remote'))
      if (result.from === 'phone') log?.info?.('approval %s for %s answered from phone: %s', id, entry.toolName, result.outcome)
      return result.outcome
    })
  }

  // -------------------------------------------------------------------------
  // remote answers to ask_user_question
  // -------------------------------------------------------------------------

  /** id -> pending question batch (a live `user-questions/request`) */
  const questions = new Map()

  function publicQuestion(entry) {
    return { id: entry.id, sessionId: entry.sessionId, callId: entry.callId, timed: entry.timed, questions: entry.questions, askedAt: entry.askedAt }
  }

  ctx.on('user-questions/request', function (request, next) {
    const agent = request?.agent
    const sessionId = agent?.session?.id ?? agent?.id
    if (!engaged(sessionId) || !Array.isArray(request?.questions) || request.questions.length === 0) return next()

    // Same withdrawal trick as approvals: aborting this signal makes the
    // desktop drop its question card once the phone has answered.
    const withdraw = new AbortController()
    const original = request.signal
    try {
      request.signal = original ? AbortSignal.any([original, withdraw.signal]) : withdraw.signal
    } catch { /* frozen request */ }

    const id = randomUUID()
    let settle
    const phone = new Promise((resolve) => { settle = resolve })
    const entry = {
      id,
      sessionId,
      callId: typeof request.wait?.callId === 'string' ? request.wait.callId : null,
      timed: request.wait?.timed === true,
      questions: normalizeQuestions(request.questions),
      askedAt: Date.now(),
      settle,
      done: false,
    }
    questions.set(id, entry)
    broadcast('question', publicQuestion(entry))

    const finish = () => {
      if (entry.done) return
      entry.done = true
      questions.delete(id)
      broadcast('question-done', { id, sessionId, callId: entry.callId })
      withdraw.abort(new Error('answered from dshx-remote'))
    }

    const fromPhone = phone.then((value) => ({ from: 'phone', value }))
    const aborted = original ? new Promise((resolve) => {
      if (original.aborted) return resolve({ from: 'signal', error: original.reason })
      original.addEventListener('abort', () => resolve({ from: 'signal', error: original.reason }), { once: true })
    }) : null
    const desktop = Promise.resolve().then(() => next()).then(
      (value) => ({ from: 'desktop', value }),
      (error) => ({ from: 'desktop', error }),
    )
    const unwrap = (result) => {
      if (result.error !== undefined) throw result.error
      if (result.from === 'phone') log?.info?.('question batch %s answered from phone', id)
      return result.value
    }
    const others = aborted ? [fromPhone, aborted] : [fromPhone]
    return Promise.race([desktop, ...others]).then((result) => {
      // No desktop answerer (no GUI attached): keep waiting for the phone.
      // Any other desktop failure (e.g. its countdown timing out) stands.
      if (result.from === 'desktop' && result.error?.code === 'NO_PROVIDER') return Promise.race(others).then(unwrap)
      return unwrap(result)
    }).finally(finish)
  }, { prepend: true })

  /** Answer a timed question that already went pending (continued). */
  function answerContinued(sessionId, callId, answers) {
    const service = ctx.get?.('userQuestions')
    if (!service || typeof service.answer !== 'function') throw Object.assign(new Error('当前 DSH 未提供补答接口'), { status: 409 })
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw Object.assign(new Error('会话未在运行，无法补答；请在电脑上打开该会话'), { status: 409 })
    let accepted
    try {
      accepted = service.answer(agent, callId, { answers })
    } catch (error) {
      if (error?.code === 'REPLY_QUEUED') throw Object.assign(new Error('这个问题已经提交过回答，正在等待模型读取'), { status: 409 })
      if (error?.code === 'BAD_ANSWER') throw Object.assign(new Error('回答和问题不匹配，请刷新后重试'), { status: 400 })
      throw error
    }
    if (!accepted) throw Object.assign(new Error('这个问题已结束或不可再回答'), { status: 409 })
  }

  // -------------------------------------------------------------------------
  // session operations
  // -------------------------------------------------------------------------

  function liveSummary(id) {
    const agent = ctx.agents.get(id)
    return { live: agent !== undefined, running: agent?.status === 'running' }
  }

  function titleOf(item) {
    const values = item?.projections?.values
    const title = values?.title
    if (typeof title === 'string' && title.trim() !== '') return title
    const first = values?.titleInput?.first?.text
    if (typeof first === 'string' && first.trim() !== '') return first.slice(0, 80)
    return null
  }

  /**
   * Archived session ids, read from the same registry the desktop sidebar
   * uses. `sessionController.list` returns every log on disk, archived or
   * not, so without this filter archived (and "deleted") conversations would
   * keep showing up on the phone. Registry unavailable: no filtering.
   */
  function archivedIds() {
    try {
      const ids = ctx.get?.('workspaceRegistry')?.archivedSessionIds
      return new Set(Array.isArray(ids) ? ids.map(String) : [])
    } catch { return new Set() }
  }

  async function listSessions() {
    const facade = controller()
    if (!facade || typeof facade.list !== 'function') throw new Error('当前 DSH 未提供会话列表接口')
    const { items } = await facade.list({}, new AbortController().signal)
    const archived = archivedIds()
    return items
      .filter((item) => item.origin !== 'subagent' && !archived.has(item.sessionId))
      .map((item) => {
        const live = liveSummary(item.sessionId)
        return {
          sessionId: item.sessionId,
          title: titleOf(item),
          cwd: item.cwd ?? null,
          updatedAt: item.updatedAt,
          blank: item.blank === true,
          live: live.live,
          running: item.running === true || live.running,
          pendingApprovals: [...approvals.values()].filter((a) => a.sessionId === item.sessionId).length,
          pendingQuestions: [...questions.values()].filter((q) => q.sessionId === item.sessionId).length,
        }
      })
  }

  async function readEvents(sessionId) {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) {
      if (typeof live.snapshotEvents === 'function') return live.snapshotEvents()
      return [...live.log]
    }
    const facade = controller()
    if (!facade || typeof facade.inspect !== 'function') throw new Error('当前 DSH 未提供会话读取接口')
    const inspected = await facade.inspect(sessionId, new AbortController().signal)
    return Array.isArray(inspected?.events) ? inspected.events : []
  }

  async function readMeta(sessionId) {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) return live.header ?? {}
    try { return (await controller()?.inspect?.(sessionId, new AbortController().signal))?.meta ?? {} } catch { return {} }
  }

  // -------------------------------------------------------------------------
  // models
  // -------------------------------------------------------------------------

  /** Deployment default selection, or null when the service is absent. */
  function defaultSelection() {
    try {
      const current = ctx.get?.('agentDefaultModel')?.currentSelection?.()
      return current && typeof current.provider === 'string' ? { provider: current.provider, model: current.model, ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}) } : null
    } catch { return null }
  }

  /**
   * The model a session will use for its next request, folded from the log
   * exactly like the host's `modelSelection` projection: the last
   * `model/selection` not yet consumed by a matching `request/header`, else the
   * last request header, else the deployment default.
   */
  function selectionFromEvents(events) {
    let lastUsed = null
    let pending = null
    for (const event of events) {
      if (event?.type === 'model/selection' && typeof event.data?.provider === 'string') {
        pending = { provider: event.data.provider, model: event.data.model, ...(event.data.reasoningEffort ? { reasoningEffort: String(event.data.reasoningEffort) } : {}) }
      } else if (event?.type === 'request/header') {
        const config = event.data?.header?.config
        if (config && typeof config.provider === 'string') {
          lastUsed = { provider: config.provider, model: config.model, ...(config.reasoningEffort !== undefined ? { reasoningEffort: String(config.reasoningEffort) } : {}) }
          if (pending && pending.provider === lastUsed.provider && pending.model === lastUsed.model && pending.reasoningEffort === lastUsed.reasoningEffort) pending = null
        }
      }
    }
    return pending ?? lastUsed ?? defaultSelection()
  }

  let catalogCache = null
  async function modelCatalog(force) {
    if (!force && catalogCache && Date.now() - catalogCache.at < 60_000) return catalogCache.value
    const facade = controller()
    if (!facade || typeof facade.modelCatalog !== 'function') throw new Error('当前 DSH 未提供模型目录接口')
    const raw = await facade.modelCatalog()
    const value = {
      default: raw?.default ?? null,
      groups: (raw?.groups ?? []).map((group) => ({
        id: group.id,
        name: group.name ?? group.id,
        models: (group.models ?? []).map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          ...(model.reasoning ? { efforts: (model.reasoning.efforts ?? []).map((e) => ({ id: e.id, name: e.name ?? e.id })), defaultEffort: model.reasoning.defaultEffort ?? null } : {}),
        })),
      })),
      failures: (raw?.failures ?? []).map((f) => ({ id: f.id, name: f.name ?? f.id, message: String(f.message ?? '') })),
    }
    catalogCache = { at: Date.now(), value }
    return value
  }

  /** Display name for a selection, looked up in the cached catalog. */
  function selectionLabel(selection) {
    if (!selection) return null
    const group = catalogCache?.value.groups.find((g) => g.id === selection.provider)
    const model = group?.models.find((m) => m.id === selection.model)
    const effort = model?.efforts?.find((e) => e.id === selection.reasoningEffort)
    return {
      ...selection,
      providerName: group?.name ?? selection.provider,
      modelName: model?.name ?? selection.model,
      ...(selection.reasoningEffort ? { effortName: effort?.name ?? selection.reasoningEffort } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // HTTP server
  // -------------------------------------------------------------------------

  function peerAddress(req) {
    return String(req.socket?.remoteAddress ?? '')
  }

  function bearer(req) {
    const header = req.headers.authorization
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
    return null
  }

  async function serveStatic(res, file, type) {
    try {
      const full = path.join(MOBILE_DIR, file)
      const stat = await fs.stat(full)
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': type,
        'content-length': stat.size,
        'cache-control': file === 'icon.png' ? 'public, max-age=86400' : 'no-cache',
        ...(type.startsWith('text/html') ? { 'content-security-policy': PAGE_CSP } : {}),
        ...(file === 'sw.js' ? { 'service-worker-allowed': '/' } : {}),
      })
      createReadStream(full).pipe(res)
    } catch {
      sendJson(res, 404, { error: 'not found' })
    }
  }

  const routes = {
    'GET /api/ping': async ({ device }) => ({ ok: true, device: { id: device.id, name: device.name }, host: os.hostname() }),

    'GET /api/sessions': async () => ({ ok: true, sessions: await listSessions(), approvals: [...approvals.values()].map(publicApproval), questions: [...questions.values()].map(publicQuestion) }),

    'GET /api/session': async ({ query }) => {
      const sessionId = canonicalId(query.id)
      if (!sessionId) throw Object.assign(new Error('缺少或非法的会话 id'), { status: 400 })
      const limit = Math.min(Number.parseInt(query.limit ?? '150', 10) || 150, 400)
      const before = query.before !== undefined ? Number.parseInt(query.before, 10) : undefined
      const events = await readEvents(sessionId)
      const meta = await readMeta(sessionId)
      const transcript = buildTranscript(events, { limit, before: Number.isSafeInteger(before) ? before : undefined })
      const stream = streams.get(sessionId)
      if (!catalogCache) await modelCatalog(false).catch(() => null)
      return {
        ok: true,
        sessionId,
        cwd: meta.cwd ?? null,
        model: selectionLabel(selectionFromEvents(events)),
        ...transcript,
        ...liveSummary(sessionId),
        streaming: stream ? { text: stream.text.slice(-20000), reasoning: stream.reasoning.slice(-4000) } : null,
        approvals: [...approvals.values()].filter((a) => a.sessionId === sessionId).map(publicApproval),
        questions: [...questions.values()].filter((q) => q.sessionId === sessionId).map(publicQuestion),
      }
    },

    'POST /api/prompt': async ({ body }) => {
      const sessionId = canonicalId(body.sessionId)
      if (!sessionId) throw Object.assign(new Error('缺少或非法的会话 id'), { status: 400 })
      const text = typeof body.text === 'string' ? body.text : ''
      if (text.trim() === '') throw Object.assign(new Error('内容不能为空'), { status: 400 })
      if (text.length > MAX_PROMPT_CHARS) throw Object.assign(new Error('内容过长'), { status: 413 })
      const mode = body.mode === 'steer' ? 'steer' : 'followup'
      const facade = controller()
      if (!facade || typeof facade.prompt !== 'function') throw new Error('当前 DSH 未提供发送接口')
      await facade.prompt({
        sessionId,
        content: [{ type: 'text', text }],
        requestId: randomUUID(),
        ...(typeof body.timeZone === 'string' ? { clientTimeZone: body.timeZone } : {}),
        ...(mode === 'steer' ? { mode: 'steer' } : {}),
      }, new AbortController().signal)
      return { ok: true }
    },

    'POST /api/create': async ({ body }) => {
      const facade = controller()
      if (!facade || typeof facade.create !== 'function') throw new Error('当前 DSH 未提供新建会话接口')
      const cwd = typeof body.cwd === 'string' && body.cwd.trim() !== '' ? body.cwd.trim() : undefined
      if (cwd !== undefined) {
        if (!path.isAbsolute(cwd)) throw Object.assign(new Error('目录必须是绝对路径'), { status: 400 })
        const stat = await fs.stat(cwd).catch(() => null)
        if (!stat?.isDirectory()) throw Object.assign(new Error('目录不存在：' + cwd), { status: 400 })
      }
      const created = await facade.create(cwd === undefined ? {} : { cwd })
      if (typeof body.provider === 'string' && typeof body.model === 'string' && typeof facade.selectModel === 'function') {
        const catalog = await modelCatalog(false)
        const entry = catalog.groups.find((g) => g.id === body.provider)?.models.find((m) => m.id === body.model)
        if (entry) {
          const effort = typeof body.reasoningEffort === 'string' && (entry.efforts ?? []).some((e) => e.id === body.reasoningEffort) ? body.reasoningEffort : undefined
          await facade.selectModel({ sessionId: created.sessionId, provider: body.provider, model: body.model, ...(effort ? { reasoningEffort: effort } : {}) })
        }
      }
      const text = typeof body.text === 'string' ? body.text : ''
      if (text.trim() !== '') {
        await facade.prompt({ sessionId: created.sessionId, content: [{ type: 'text', text: text.slice(0, MAX_PROMPT_CHARS) }], requestId: randomUUID() }, new AbortController().signal)
      }
      broadcast('list', { sessionId: created.sessionId })
      return { ok: true, sessionId: created.sessionId }
    },

    'POST /api/cancel': async ({ body }) => {
      const sessionId = canonicalId(body.sessionId)
      if (!sessionId) throw Object.assign(new Error('缺少或非法的会话 id'), { status: 400 })
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined || agent.status !== 'running') return { ok: true, cancelled: false }
      const facade = controller()
      if (facade && typeof facade.cancel === 'function') facade.cancel({ sessionId })
      else agent.cancel({ kind: 'user' }, { keepInbox: true })
      return { ok: true, cancelled: true }
    },

    'POST /api/approval': async ({ body, device }) => {
      const entry = approvals.get(String(body.id ?? ''))
      if (!entry || entry.done) throw Object.assign(new Error('该审批已结束或不存在'), { status: 409 })
      const outcome = body.decision === 'allow' ? 'allowed-once' : body.decision === 'reject' ? 'rejected' : null
      if (outcome === null) throw Object.assign(new Error('decision 必须是 allow 或 reject'), { status: 400 })
      log?.info?.('approval %s %s by device %s', entry.id, outcome, device.name)
      entry.settle(outcome)
      return { ok: true }
    },

    'POST /api/answer': async ({ body, device }) => {
      const id = typeof body.id === 'string' ? body.id : ''
      const entry = id ? questions.get(id) : undefined
      if (entry && !entry.done) {
        const answers = validateAnswers(entry.questions, body.answers)
        log?.info?.('question %s answered by device %s', entry.id, device.name)
        entry.settle({ answers })
        return { ok: true, mode: 'live' }
      }
      // Late answer to a timed question that already returned "pending".
      const sessionId = canonicalId(body.sessionId)
      const callId = typeof body.callId === 'string' && body.callId.length <= 200 ? body.callId : ''
      if (!sessionId || !callId) throw Object.assign(new Error('该问题已结束或不存在'), { status: 409 })
      const events = await readEvents(sessionId)
      const item = buildTranscript(events, { limit: 100000 }).items.find((i) => i.kind === 'question' && i.callId === callId)
      if (!item || item.state !== 'pending') throw Object.assign(new Error('该问题已结束或不可再回答'), { status: 409 })
      answerContinued(sessionId, callId, validateAnswers(item.questions, body.answers))
      broadcast('session', { sessionId, seq: null }, (c) => c.sessionId === sessionId)
      return { ok: true, mode: 'late' }
    },

    'GET /api/models': async ({ query }) => ({ ok: true, ...(await modelCatalog(query.force === '1')) }),

    'POST /api/model': async ({ body }) => {
      const sessionId = canonicalId(body.sessionId)
      if (!sessionId) throw Object.assign(new Error('缺少或非法的会话 id'), { status: 400 })
      const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
      const model = typeof body.model === 'string' ? body.model.trim() : ''
      if (!provider || !model || provider.length > 120 || model.length > 200) throw Object.assign(new Error('请选择模型'), { status: 400 })
      const reasoningEffort = typeof body.reasoningEffort === 'string' && body.reasoningEffort.trim() !== '' ? body.reasoningEffort.trim().slice(0, 40) : undefined
      // Only advertised models; the host re-validates and resolves the config.
      const catalog = await modelCatalog(false)
      const entry = catalog.groups.find((g) => g.id === provider)?.models.find((m) => m.id === model)
      if (!entry) throw Object.assign(new Error('该模型当前不可用'), { status: 400 })
      if (reasoningEffort !== undefined && !(entry.efforts ?? []).some((e) => e.id === reasoningEffort)) throw Object.assign(new Error('该模型不支持这个推理强度'), { status: 400 })
      const facade = controller()
      if (!facade || typeof facade.selectModel !== 'function') throw new Error('当前 DSH 未提供切换模型接口')
      // Same call the desktop picker makes: logs model/selection for the
      // session and also saves it as the default for new sessions.
      const result = await facade.selectModel({ sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) })
      broadcast('session', { sessionId, seq: null }, (c) => c.sessionId === sessionId)
      return { ok: true, model: selectionLabel(result?.selected ?? { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }) }
    },

    'GET /api/workspaces': async () => {
      const registry = ctx.get?.('workspaceRegistry')
      let list = []
      try { list = registry?.list?.() ?? [] } catch { list = [] }
      const seen = new Set()
      const out = []
      for (const ws of list) {
        if (typeof ws?.path !== 'string' || seen.has(ws.path)) continue
        seen.add(ws.path)
        out.push({ path: ws.path, title: ws.title ?? path.basename(ws.path) })
      }
      return { ok: true, workspaces: out }
    },
  }

  async function handle(req, res) {
    const address = peerAddress(req)
    if (!addressAllowed(address, settings.allowPublic)) {
      res.writeHead(403, SECURITY_HEADERS)
      res.end('forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://dshx-remote.local')
    const method = req.method ?? 'GET'

    if (method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]
      return serveStatic(res, file, type)
    }

    await ready

    if (url.pathname === '/api/pair' && method === 'POST') {
      if (pairLimiter.blocked(address)) return sendJson(res, 429, { error: '尝试次数过多，请稍后再试' })
      const body = await readBody(req)
      const result = await store.redeem(body.code, body.name, address)
      if (!result.ok) {
        pairLimiter.fail(address)
        return sendJson(res, 403, { error: result.error })
      }
      log?.info?.('paired new device %s from %s', result.device.name, address)
      broadcastAdmin()
      return sendJson(res, 200, { ok: true, token: result.token, device: result.device, host: os.hostname() })
    }

    if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' })

    if (authLimiter.blocked(address)) return sendJson(res, 429, { error: '认证失败次数过多，请稍后再试' })
    const device = store.authenticate(bearer(req) ?? (url.pathname === '/api/events' ? url.searchParams.get('token') : null), address)
    if (!device) {
      authLimiter.fail(address)
      return sendJson(res, 401, { error: store.enabled ? '设备未配对或已被移除' : '远程控制已在电脑上关闭' })
    }

    if (url.pathname === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const sessionId = canonicalId(url.searchParams.get('session') ?? '')
      const client = { res, device, sessionId }
      clients.add(client)
      res.write('retry: 3000\nevent: hello\ndata: ' + JSON.stringify({ approvals: [...approvals.values()].map(publicApproval), questions: [...questions.values()].map(publicQuestion) }) + '\n\n')
      const heartbeat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 20_000)
      req.on('close', () => { clearInterval(heartbeat); clients.delete(client) })
      return
    }

    const handler = routes[method + ' ' + url.pathname]
    if (!handler) return sendJson(res, 404, { error: 'not found' })
    const body = method === 'POST' ? await readBody(req) : {}
    const query = Object.fromEntries(url.searchParams)
    const result = await handler({ req, body, query, device })
    return sendJson(res, 200, result)
  }

  let server = null
  ctx.effect(() => {
    server = createServer((req, res) => {
      handle(req, res).catch((error) => {
        const status = Number.isSafeInteger(error?.status) ? error.status : 500
        if (status >= 500) log?.warn?.('request %s failed: %s', req.url, describeError(error))
        sendJson(res, status, { error: remoteMessage(error) })
      })
    })
    server.on('error', (error) => {
      serverState.listening = false
      serverState.error = error?.code === 'EADDRINUSE' ? `端口 ${settings.port} 已被占用` : describeError(error)
      log?.warn?.('remote server error: %s', serverState.error)
    })
    server.listen(settings.port, settings.host, () => {
      serverState.listening = true
      serverState.error = null
      serverState.port = server.address().port
      log?.info?.('remote control listening on %s:%d', settings.host, serverState.port)
    })
    return () => {
      for (const client of clients) { try { client.res.end() } catch { /* ignore */ } }
      clients.clear()
      for (const entry of approvals.values()) if (!entry.done) entry.settle('cancelled')
      approvals.clear()
      for (const entry of questions.values()) if (!entry.done) entry.settle(Promise.reject(Object.assign(new Error('dshx-remote unloaded'), { code: 'ASK_ABORTED' })))
      questions.clear()
      server.closeAllConnections?.()
      server.close()
    }
  }, name + ': remote server')

  // -------------------------------------------------------------------------
  // admin routes on DSH's own (authenticated, loopback) web server
  // -------------------------------------------------------------------------

  const ADMIN = '/dshx-remote/admin'
  function adminState() {
    const pairing = store.currentPairing()
    const addresses = reachableAddresses()
    const urls = addresses.map((a) => ({ ...a, url: `http://${a.address}:${serverState.port}/` }))
    const primary = urls[0]
    const pairUrl = primary && pairing ? `${primary.url}#pair=${pairing.code}` : null
    return {
      ok: true,
      enabled: store.enabled,
      server: { ...serverState, host: settings.host, allowPublic: settings.allowPublic },
      urls,
      pairing: pairing ? { code: pairing.code, expiresAt: pairing.expiresAt, url: pairUrl, qr: pairUrl ? qrSvg(pairUrl) : null } : null,
      devices: store.devices(),
      pendingApprovals: approvals.size,
      pendingQuestions: questions.size,
      connected: [...clients].map((c) => c.device.id),
    }
  }
  function broadcastAdmin() { /* admin page polls; hook kept for future push */ }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ADMIN,
    handler: async (req, res) => {
      try {
        await ready
        if ((req.method ?? 'GET') === 'GET') return sendJson(res, 200, adminState())
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        // Same-origin only: DSH's Web UI never sends a foreign Origin.
        const origin = req.headers.origin
        if (typeof origin === 'string' && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return sendJson(res, 403, { error: 'forbidden origin' })
        const body = await readBody(req)
        switch (body.action) {
          case 'pair': store.startPairing(); break
          case 'cancel-pair': store.cancelPairing(); break
          case 'enable': await store.setEnabled(true); break
          case 'disable':
            await store.setEnabled(false)
            for (const client of clients) { try { client.res.end() } catch { /* ignore */ } }
            clients.clear()
            break
          case 'revoke':
            await store.revoke(String(body.id ?? ''))
            for (const client of [...clients]) if (client.device.id === body.id) { try { client.res.end() } catch { /* ignore */ } clients.delete(client) }
            break
          case 'rename': await store.rename(String(body.id ?? ''), body.name); break
          default: return sendJson(res, 400, { error: 'unknown action' })
        }
        return sendJson(res, 200, adminState())
      } catch (error) {
        return sendJson(res, 500, { error: describeError(error) })
      }
    },
  }), name + ': admin route')
}

export { textOf }
