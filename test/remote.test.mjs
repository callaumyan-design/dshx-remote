// End-to-end test of dshx-remote's host half with a stubbed DSH context.
// Runs the REAL HTTP server, pairing, auth, SSE, prompt/cancel routing and
// the approval waterfall race. Run: node --test test/
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import { EventEmitter } from 'node:events'

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'dshx-remote-test-'))
process.env.USERPROFILE = HOME
process.env.HOME = HOME
const { apply, Config } = await import('../index.js')
const { buildTranscript } = await import('../transcript.js')
const { HUMAN_HOOK, AI_HANDOFF, validateAnswers } = await import('../index.js')
const { classifyAddress, DeviceStore, RateLimiter } = await import('../auth.js')

const SID = 'session-11111111-2222-4333-8444-555555555555'
const SID2 = 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SID_ARCHIVED = 'session-99999999-8888-4777-8666-555555555555'

// ---------------------------------------------------------------------------
// stub host context
// ---------------------------------------------------------------------------
function makeCtx() {
  const listeners = new Map()
  const knobs = { preset: 'default' }
  const effects = []
  const routes = new Map()
  const calls = { prompt: [], cancel: [], create: [], selectModel: [], answer: [] }
  const events = [
    { seq: 0, type: 'session/title', data: { title: '测试会话' }, time: 1 },
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } },
    { seq: 3, type: 'assistant/message', data: { message: { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: '**你好**，我来跑命令' }, { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"Get-Date","description":"Show date"}' }] } } },
    { seq: 4, type: 'tool/call', data: { callId: 'c1', name: 'pwsh' } },
    { seq: 5, type: 'tool/result', data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: '2026-10-12' }], isError: false } } },
    { seq: 6, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 7, type: 'request/header', data: { header: { config: { provider: 'claude', model: 'claude-opus-5-5' } } } },
  ]
  const agent = {
    id: SID,
    status: 'idle',
    session: { id: SID },
    cancel(reason, opts) { calls.cancel.push({ reason, opts }); this.status = 'idle' },
  }
  const ctx = {
    logger: () => ({ info() {}, warn() {} }),
    on(name, fn, opts) {
      const list = listeners.get(name) ?? []
      if (opts?.prepend) list.unshift(fn); else list.push(fn)
      listeners.set(name, list)
      return () => {}
    },
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } },
    sessions: { get: (id) => (id === SID ? { id: SID, header: { cwd: 'F:\\ds' }, snapshotEvents: () => events } : undefined) },
    agents: { get: (id) => (id === SID ? agent : undefined) },
    get(name) {
      if (name === 'sessionController') return controller
      if (name === 'workspaceRegistry') return { list: () => [{ path: 'F:\\ds', title: 'ds' }], archivedSessionIds: [SID_ARCHIVED] }
      if (name === 'permissionPresets') return { current: () => knobs.preset }
      if (name === 'userQuestions') return { answer: (a, callId, answer) => { calls.answer.push({ agent: a, callId, answer }); return true } }
      return undefined
    },
  }
  const controller = {
    async list() {
      return { items: [
        { sessionId: SID, updatedAt: 2, running: false, blank: false, cwd: 'F:\\ds', projections: { values: { title: '测试会话' } } },
        { sessionId: SID2, updatedAt: 1, running: false, blank: false, cwd: 'F:\\ds', origin: 'subagent' },
        { sessionId: SID_ARCHIVED, updatedAt: 3, running: false, blank: false, cwd: 'F:\\ds', projections: { values: { title: '已归档' } } },
      ] }
    },
    async inspect() { return { meta: {}, events: [] } },
    async prompt(req) { calls.prompt.push(req); return { accepted: true } },
    async create(req) { calls.create.push(req); return { sessionId: SID2 } },
    cancel(req) { calls.cancel.push(req); agent.status = 'idle'; return { accepted: true } },
    async modelCatalog() {
      return {
        default: { provider: 'codex', model: 'gpt-6.1-sol' },
        groups: [
          { id: 'claude', name: 'Claude', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: { efforts: [{ id: 'low', name: '低' }, { id: 'high', name: '高' }], defaultEffort: 'high' } }] },
          { id: 'codex', name: 'Codex', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] },
        ],
        failures: [{ id: 'xai', name: 'xAI', message: 'no key' }],
      }
    },
    async selectModel(req) {
      calls.selectModel.push(req)
      events.push({ seq: events.length, type: 'model/selection', data: { provider: req.provider, model: req.model, ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}) } })
      return { selected: { provider: req.provider, model: req.model, ...(req.reasoningEffort ? { reasoningEffort: req.reasoningEffort } : {}) } }
    },
  }
  // waterfall dispatch like cordis: listeners outermost-first, inner = default
  function waterfall(name, req, inner) {
    const cbs = [...(listeners.get(name) ?? [])]
    const next = () => (cbs.shift() ?? inner)(req, next)
    return next()
  }
  function emit(name, ...args) { for (const fn of listeners.get(name) ?? []) fn(...args) }
  return { ctx, knobs, listeners, routes, calls, agent, events, waterfall, emit, dispose: () => effects.forEach((d) => typeof d === 'function' && d()) }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
let PORT
function request(method, p, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(raw) } catch { json = null }
        resolve({ status: res.statusCode, json, raw, headers: res.headers })
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

/** Call a route registered on the stub DSH webServer (admin page). */
function admin(routes, method, body) {
  return new Promise((resolve) => {
    const route = routes.get('/dshx-remote/admin')
    const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
    const req = Object.assign(new EventEmitter(), { method, headers: { origin: 'http://127.0.0.1:19387' } })
    const res = {
      headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true },
      end(text) { resolve({ status: this.status, json: JSON.parse(text) }) },
    }
    route.handler(req, res)
    queueMicrotask(() => { for (const c of chunks) req.emit('data', c); req.emit('end') })
  })
}

function sse(p, token) {
  const frames = []
  let res
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p + (p.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) }, (r) => {
    res = r
    let buf = ''
    r.on('data', (c) => {
      buf += c
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const ev = /event: (.*)/.exec(block)?.[1]
        const data = /data: (.*)/.exec(block)?.[1]
        if (ev) frames.push({ event: ev, data: data ? JSON.parse(data) : null })
      }
    })
  })
  return { frames, close: () => { req.destroy(); res?.destroy() }, status: () => res?.statusCode }
}
const until = async (fn, ms = 3000) => {
  const start = Date.now()
  while (Date.now() - start < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error('timeout waiting for condition')
}

// ---------------------------------------------------------------------------
let host
let token

before(async () => {
  host = makeCtx()
  apply(host.ctx, Config({ port: 0, host: '127.0.0.1' }))
  // find the bound port through the admin state
  for (let i = 0; i < 100 && !PORT; i += 1) {
    const s = await admin(host.routes, 'GET')
    if (s.json.server.listening && s.json.server.port) PORT = s.json.server.port
    else await new Promise((r) => setTimeout(r, 20))
  }
  assert.ok(PORT, 'server should listen')
})

after(async () => {
  host.dispose()
  await fs.rm(HOME, { recursive: true, force: true })
})

test('static shell is served without auth, with CSP', async () => {
  const res = await request('GET', '/')
  assert.equal(res.status, 200)
  assert.match(res.headers['content-security-policy'], /default-src 'self'/)
  assert.match(res.raw, /<script src="\/app.js">/)
  const js = await request('GET', '/app.js')
  assert.equal(js.status, 200)
})

test('API refuses requests without a paired token', async () => {
  const res = await request('GET', '/api/sessions')
  assert.equal(res.status, 401)
  const bad = await request('GET', '/api/sessions', { token: 'x'.repeat(43) })
  assert.equal(bad.status, 401)
})

test('pairing: no code -> rejected; wrong code -> rejected; right code -> token, single use', async () => {
  let res = await request('POST', '/api/pair', { body: { code: 'AAAAAAAA', name: 'phone' } })
  assert.equal(res.status, 403)
  const started = await admin(host.routes, 'POST', { action: 'pair' })
  const code = started.json.pairing.code
  assert.equal(code.length, 8)
  res = await request('POST', '/api/pair', { body: { code: 'WRONG123', name: 'phone' } })
  assert.equal(res.status, 403)
  res = await request('POST', '/api/pair', { body: { code: code.slice(0, 4) + '-' + code.slice(4).toLowerCase(), name: '测试手机' } })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  token = res.json.token
  assert.ok(token.length >= 40)
  const again = await request('POST', '/api/pair', { body: { code, name: 'x' } })
  assert.equal(again.status, 403, 'code is single-use')
  const st = await admin(host.routes, 'GET')
  assert.equal(st.json.devices.length, 1)
  assert.equal(st.json.devices[0].name, '测试手机')
  const stored = JSON.parse(await fs.readFile(path.join(HOME, '.dsh', 'dshx-remote', 'devices.json'), 'utf8'))
  assert.ok(!JSON.stringify(stored).includes(token), 'raw token never persisted')
})

test('session list hides subagent and archived sessions', async () => {
  const res = await request('GET', '/api/sessions', { token })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.sessions.map((s) => s.sessionId), [SID])
  assert.equal(res.json.sessions[0].title, '测试会话')
})

test('transcript endpoint projects messages and tools', async () => {
  const res = await request('GET', '/api/session?id=' + SID, { token })
  assert.equal(res.status, 200)
  const kinds = res.json.items.map((i) => i.kind)
  assert.deepEqual(kinds, ['user', 'assistant', 'tool'])
  const tool = res.json.items[2]
  assert.equal(tool.status, 'done')
  assert.equal(tool.summary, 'Show date')
  assert.equal(tool.result, '2026-10-12')
  assert.equal(res.json.title, '测试会话')
  const bad = await request('GET', '/api/session?id=../../etc', { token })
  assert.equal(bad.status, 400)
})

test('prompt goes through sessionController.prompt with followup / steer', async () => {
  let res = await request('POST', '/api/prompt', { token, body: { sessionId: SID, text: '继续' } })
  assert.equal(res.status, 200)
  assert.equal(host.calls.prompt.at(-1).content[0].text, '继续')
  assert.equal(host.calls.prompt.at(-1).mode, undefined)
  res = await request('POST', '/api/prompt', { token, body: { sessionId: SID, text: '插话', mode: 'steer' } })
  assert.equal(host.calls.prompt.at(-1).mode, 'steer')
  res = await request('POST', '/api/prompt', { token, body: { sessionId: SID, text: '   ' } })
  assert.equal(res.status, 400)
})

test('cancel only acts on a running agent', async () => {
  let res = await request('POST', '/api/cancel', { token, body: { sessionId: SID } })
  assert.equal(res.json.cancelled, false)
  host.agent.status = 'running'
  res = await request('POST', '/api/cancel', { token, body: { sessionId: SID } })
  assert.equal(res.json.cancelled, true)
  assert.deepEqual(host.calls.cancel.at(-1), { sessionId: SID })
})

test('create validates cwd and sends first prompt', async () => {
  let res = await request('POST', '/api/create', { token, body: { cwd: 'relative/path' } })
  assert.equal(res.status, 400)
  res = await request('POST', '/api/create', { token, body: { cwd: HOME, text: '开始' } })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.equal(res.json.sessionId, SID2)
  assert.deepEqual(host.calls.create.at(-1), { cwd: HOME })
  assert.equal(host.calls.prompt.at(-1).sessionId, SID2)
})

test('SSE delivers status, coalesced session updates and stream text', async () => {
  const stream = sse('/api/events?session=' + SID, token)
  await until(() => stream.frames.some((f) => f.event === 'hello'))
  host.emit('agent/status', { agent: host.agent, status: 'running' })
  host.emit('session/event', { id: SID }, { seq: 7, type: 'step/start' })
  host.emit('session/event', { id: SID }, { seq: 8, type: 'step/end' })
  host.emit('agent/assistant-stream', { agent: host.agent, frame: { type: 'start', attemptId: 'x' } })
  host.emit('agent/assistant-stream', { agent: host.agent, frame: { type: 'chunk', attemptId: 'x', chunk: { type: 'text-delta', text: '流式' } } })
  host.emit('agent/assistant-stream', { agent: host.agent, frame: { type: 'chunk', attemptId: 'x', chunk: { type: 'text-delta', text: '输出' } } })
  await until(() => stream.frames.some((f) => f.event === 'stream' && f.data.text === '流式输出'))
  const sessionFrames = await until(() => { const s = stream.frames.filter((f) => f.event === 'session'); return s.length ? s : null })
  assert.equal(sessionFrames.length, 1, 'bursts are coalesced')
  assert.equal(sessionFrames[0].data.seq, 8)
  assert.ok(stream.frames.some((f) => f.event === 'status' && f.data.running === true))
  stream.close()
})

test('approval: phone answer wins the race and withdraws the desktop prompt', async () => {
  const stream = sse('/api/events', token)
  await until(() => stream.frames.some((f) => f.event === 'hello'))
  let desktopSignal
  // The "desktop" listener: registered after ours (not prepended), never answers on its own.
  host.ctx.on('approval/request', (req) => new Promise((resolve) => {
    desktopSignal = req.signal
    req.signal.addEventListener('abort', () => resolve('cancelled'))
  }))
  const hostSignal = new AbortController()
  const outcome = host.waterfall('approval/request', { agent: { id: SID, session: { id: SID } }, toolName: 'pwsh', reason: '写入 C:\\Windows', signal: hostSignal.signal }, () => Promise.resolve('unavailable'))
  const asked = await until(() => stream.frames.find((f) => f.event === 'approval'))
  assert.equal(asked.data.toolName, 'pwsh')
  const list = await request('GET', '/api/sessions', { token })
  assert.equal(list.json.approvals.length, 1)
  const res = await request('POST', '/api/approval', { token, body: { id: asked.data.id, decision: 'allow' } })
  assert.equal(res.status, 200)
  assert.equal(await outcome, 'allowed-once')
  assert.equal(desktopSignal.aborted, true, 'desktop prompt withdrawn')
  assert.equal(hostSignal.signal.aborted, false, 'host signal untouched')
  await until(() => stream.frames.some((f) => f.event === 'approval-done'))
  const twice = await request('POST', '/api/approval', { token, body: { id: asked.data.id, decision: 'reject' } })
  assert.equal(twice.status, 409)
  stream.close()
})

test('approval: desktop answer wins when it comes first', async () => {
  const h2 = makeCtx()
  // pair a device so the listener engages
  apply(h2.ctx, Config({ port: 0, host: '127.0.0.1' }))
  // h2 shares the devices.json written above (same HOME) — wait for load
  await new Promise((r) => setTimeout(r, 50))
  h2.ctx.on('approval/request', () => Promise.resolve('rejected'))
  const outcome = await h2.waterfall('approval/request', { agent: { id: SID, session: { id: SID } }, toolName: 'pwsh', reason: 'x' }, () => Promise.resolve('unavailable'))
  assert.equal(outcome, 'rejected')
  h2.dispose()
})

test('approval: no desktop answerer → waits for the phone instead of failing closed', async () => {
  const stream = sse('/api/events', token)
  await until(() => stream.frames.some((f) => f.event === 'hello'))
  const h3 = makeCtx()
  apply(h3.ctx, Config({ port: 0, host: '127.0.0.1' }))
  await new Promise((r) => setTimeout(r, 50))
  // nothing else registered → chain default returns 'unavailable'
  const outcome = h3.waterfall('approval/request', { agent: { id: SID, session: { id: SID } }, toolName: 'edit', reason: 'y' }, () => Promise.resolve('unavailable'))
  let settled = false
  outcome.then(() => { settled = true })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(settled, false, 'still waiting for the phone')
  h3.dispose() // plugin unload cancels pending approvals
  assert.equal(await outcome, 'cancelled')
  stream.close()
})

test('ai-approval sessions are never routed to the phone', async () => {
  const h4 = makeCtx()
  const get = h4.ctx.get
  h4.ctx.get = (name) => (name === 'permissionPresets' ? { current: () => 'ai-approval' } : get(name))
  apply(h4.ctx, Config({ port: 0, host: '127.0.0.1' }))
  await new Promise((r) => setTimeout(r, 50))
  const outcome = await h4.waterfall('approval/request', { agent: { id: SID, session: { id: SID } }, toolName: 'pwsh' }, () => Promise.resolve('rejected'))
  assert.equal(outcome, 'rejected')
  h4.dispose()
})

test('model catalog is exposed with efforts and failures', async () => {
  const res = await request('GET', '/api/models', { token })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.groups.map((g) => g.id), ['claude', 'codex'])
  assert.deepEqual(res.json.groups[0].models[0].efforts.map((e) => e.id), ['low', 'high'])
  assert.equal(res.json.failures[0].id, 'xai')
})

test('session reports its current model, folded from the log', async () => {
  const res = await request('GET', '/api/session?id=' + SID, { token })
  assert.equal(res.json.model.provider, 'claude')
  assert.equal(res.json.model.modelName, 'Claude Opus 5.5')
})

test('switching model validates against the catalog and calls selectModel', async () => {
  let res = await request('POST', '/api/model', { token, body: { sessionId: SID, provider: 'nope', model: 'x' } })
  assert.equal(res.status, 400)
  res = await request('POST', '/api/model', { token, body: { sessionId: SID, provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'ultra' } })
  assert.equal(res.status, 400, 'unknown effort rejected')
  res = await request('POST', '/api/model', { token, body: { sessionId: SID, provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low' } })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.deepEqual(host.calls.selectModel.at(-1), { sessionId: SID, provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low' })
  assert.equal(res.json.model.effortName, '低')
  res = await request('POST', '/api/model', { token, body: { sessionId: SID, provider: 'codex', model: 'gpt-6.1-sol' } })
  assert.equal(res.status, 200)
  const after = await request('GET', '/api/session?id=' + SID, { token })
  assert.equal(after.json.model.model, 'gpt-6.1-sol', 'pending selection wins over last request header')
  assert.equal(after.json.model.modelName, 'GPT-6.1 Sol')
})

test('create can pick a model for the new session', async () => {
  const res = await request('POST', '/api/create', { token, body: { cwd: HOME, provider: 'codex', model: 'gpt-6.1-sol' } })
  assert.equal(res.status, 200)
  assert.deepEqual(host.calls.selectModel.at(-1), { sessionId: SID2, provider: 'codex', model: 'gpt-6.1-sol' })
})

test('admin route rejects foreign origins', async () => {
  const route = host.routes.get('/dshx-remote/admin')
  const req = Object.assign(new EventEmitter(), { method: 'POST', headers: { origin: 'http://evil.example' } })
  const result = await new Promise((resolve) => {
    route.handler(req, { headersSent: false, writeHead(s) { this.s = s }, end(t) { resolve({ s: this.s, t }) } })
    queueMicrotask(() => { req.emit('data', Buffer.from('{"action":"pair"}')); req.emit('end') })
  })
  assert.equal(result.s, 403)
})

test('revoking a device cuts its access immediately', async () => {
  const st = await admin(host.routes, 'GET')
  await admin(host.routes, 'POST', { action: 'revoke', id: st.json.devices[0].id })
  const res = await request('GET', '/api/sessions', { token })
  assert.equal(res.status, 401)
})

// ---------------------------------------------------------------------------
// pure units
// ---------------------------------------------------------------------------
test('address classification', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback')
  assert.equal(classifyAddress('::ffff:192.168.1.20'), 'lan')
  assert.equal(classifyAddress('10.0.0.5'), 'lan')
  assert.equal(classifyAddress('172.20.1.1'), 'lan')
  assert.equal(classifyAddress('172.32.1.1'), 'public')
  assert.equal(classifyAddress('100.101.102.103'), 'tailscale')
  assert.equal(classifyAddress('fd7a:115c:a1e0::1'), 'tailscale')
  assert.equal(classifyAddress('8.8.8.8'), 'public')
  assert.equal(classifyAddress('2001:db8::1'), 'public')
})

test('rate limiter locks out after N failures', () => {
  let t = 0
  const rl = new RateLimiter(3, 1000, () => t)
  rl.fail('a'); rl.fail('a')
  assert.equal(rl.blocked('a'), false)
  rl.fail('a')
  assert.equal(rl.blocked('a'), true)
  t = 1500
  assert.equal(rl.blocked('a'), false)
})

test('pairing code expires and is burned after too many attempts', async () => {
  let t = 0
  const store = new DeviceStore(path.join(HOME, 'x.json'), () => t)
  const { code } = store.startPairing()
  for (let i = 0; i < 10; i += 1) await store.redeem('ZZZZZZZZ', 'p', '1.1.1.1')
  assert.equal((await store.redeem(code, 'p', '1.1.1.1')).ok, false, 'burned')
  const second = store.startPairing()
  t = 6 * 60_000
  assert.equal((await store.redeem(second.code, 'p', '1.1.1.1')).ok, false, 'expired')
})

test('transcript hides withdrawn prompts, applies overrides, marks interrupted tools', () => {
  const events = [
    { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', content: [{ type: 'text', text: 'old' }], source: { kind: 'user' } } },
    { seq: 1, type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'text', text: 'orig' }, { type: 'tool-call', id: 't1', name: 'read', arguments: '{"file_path":"a.txt"}' }] } } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } },
    { seq: 3, type: 'user/message', data: { id: 'n', content: [], source: { kind: 'dshx-message-edit' } }, sourceEventSeqs: [0] },
    { seq: 4, type: 'user/message', surfaceOp: 'append', data: { id: 'u2', content: [{ type: 'text', text: 'new' }], source: { kind: 'user' } } },
    { seq: 5, type: 'assistant/message', data: { message: { id: 'a2', content: [{ type: 'text', text: 'v1' }] } } },
    { seq: 6, type: 'dshx-message-edit/override', data: { messageId: 'a2', text: 'v2', targetSeq: 5 } },
    { seq: 7, type: 'approval/asked', data: { id: 'p1', toolName: 'pwsh', reason: 'r' } },
    { seq: 8, type: 'approval/decided', data: { id: 'p1', outcome: 'rejected' } },
  ]
  const t = buildTranscript(events)
  assert.deepEqual(t.items.map((i) => i.kind + ':' + (i.text ?? i.status ?? i.outcome)), [
    'assistant:orig', 'tool:interrupted', 'notice:已停止', 'user:new', 'assistant:v2', 'approval:rejected',
  ])
  const paged = buildTranscript(events, { limit: 2 })
  assert.equal(paged.items.length, 2)
  assert.equal(paged.hasMore, true)
})

// ---------------------------------------------------------------------------
// ask_user_question + AI-review hand-off (re-pair: the device above was revoked)
// ---------------------------------------------------------------------------
async function pairAgain() {
  const started = await admin(host.routes, 'POST', { action: 'pair' })
  const res = await request('POST', '/api/pair', { body: { code: started.json.pairing.code, name: '手机2' } })
  assert.equal(res.status, 200)
  token = res.json.token
}

const QS = [
  { id: 'mode', question: '用哪种模式？', header: '模式', options: [{ label: '快速', description: '少检查' }, { label: '稳妥' }] },
  { id: 'extra', question: '还有什么要求？', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true },
]

test('question: phone answer wins, is validated, and withdraws the desktop card', async () => {
  await pairAgain()
  const stream = sse('/api/events', token)
  await until(() => stream.frames.some((f) => f.event === 'hello'))
  let desktopSignal
  const off = host.ctx.on('user-questions/request', (req) => new Promise((resolve, reject) => {
    desktopSignal = req.signal
    req.signal.addEventListener('abort', () => reject(new Error('withdrawn')))
  }))
  const hostSignal = new AbortController()
  const answer = host.waterfall('user-questions/request', { agent: { id: SID, session: { id: SID } }, questions: QS, signal: hostSignal.signal, wait: { callId: 'q1', timed: true } }, () => Promise.reject(Object.assign(new Error('none'), { code: 'NO_PROVIDER' })))
  const asked = await until(() => stream.frames.find((f) => f.event === 'question'))
  assert.equal(asked.data.callId, 'q1')
  assert.equal(asked.data.questions[1].multiSelect, true)
  const view = await request('GET', '/api/session?id=' + SID, { token })
  assert.equal(view.json.questions.length, 1)
  const res = await request('POST', '/api/answer', { token, body: { id: asked.data.id, answers: [
    { id: 'mode', selected: ['快速', '稳妥', '伪造'] },
    { id: 'extra', selected: ['A', 'B'], custom: '要快' },
  ] } })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.deepEqual(await answer, { answers: [
    { id: 'mode', selected: ['快速'] },
    { id: 'extra', selected: ['A', 'B'], custom: '要快' },
  ] })
  assert.equal(desktopSignal.aborted, true, 'desktop card withdrawn')
  assert.equal(hostSignal.signal.aborted, false)
  await until(() => stream.frames.some((f) => f.event === 'question-done'))
  const twice = await request('POST', '/api/answer', { token, body: { id: asked.data.id, answers: [] } })
  assert.equal(twice.status, 409)
  stream.close()
})

test('question: desktop answer wins when it comes first; its timeout error passes through', async () => {
  const h5 = makeCtx()
  apply(h5.ctx, Config({ port: 0, host: '127.0.0.1' }))
  await new Promise((r) => setTimeout(r, 50))
  h5.ctx.on('user-questions/request', () => Promise.resolve({ answers: [{ id: 'mode', selected: ['稳妥'] }] }))
  const out = await h5.waterfall('user-questions/request', { agent: { id: SID, session: { id: SID } }, questions: QS }, () => Promise.reject(new Error('unreached')))
  assert.deepEqual(out.answers[0].selected, ['稳妥'])
  h5.dispose()
  const h6 = makeCtx()
  apply(h6.ctx, Config({ port: 0, host: '127.0.0.1' }))
  await new Promise((r) => setTimeout(r, 50))
  h6.ctx.on('user-questions/request', () => Promise.reject(Object.assign(new Error('t'), { code: 'ASK_TIMED_OUT' })))
  await assert.rejects(h6.waterfall('user-questions/request', { agent: { id: SID, session: { id: SID } }, questions: QS }, () => Promise.resolve(null)), (e) => e.code === 'ASK_TIMED_OUT')
  h6.dispose()
})

test('question: no desktop answerer → waits for the phone', async () => {
  const stream = sse('/api/events', token)
  await until(() => stream.frames.some((f) => f.event === 'hello'))
  const answer = host.waterfall('user-questions/request', { agent: { id: SID, session: { id: SID } }, questions: [QS[0]] }, () => Promise.reject(Object.assign(new Error('none'), { code: 'NO_PROVIDER' })))
  const asked = await until(() => stream.frames.find((f) => f.event === 'question'))
  await new Promise((r) => setTimeout(r, 50))
  const res = await request('POST', '/api/answer', { token, body: { id: asked.data.id, answers: [{ id: 'mode', selected: [], custom: '都行' }] } })
  assert.equal(res.status, 200)
  assert.deepEqual(await answer, { answers: [{ id: 'mode', selected: [], custom: '都行' }] })
  stream.close()
})

test('question: late answer to a pending timed question goes through userQuestions.answer', async () => {
  const n = host.events.length
  host.events.push(
    { seq: n, type: 'request/header', data: { header: { tools: [{ name: 'ask_user_question', parameters: { properties: { questions: {}, timeout: {} } } }] } } },
    { seq: n + 1, type: 'turn/start', data: { turn: 9 } },
    { seq: n + 2, type: 'assistant/message', data: { message: { id: 'aq', content: [{ type: 'tool-call', id: 'late1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'mode', question: '选？', options: [{ label: '快速' }, { label: '稳妥' }] }] }) }] } } },
    { seq: n + 3, type: 'tool/result', data: { message: { toolCallId: 'late1', content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: 'late1', message: 'x' }) }] } } },
  )
  const view = await request('GET', '/api/session?id=' + SID + '&limit=400', { token })
  const q = view.json.items.find((i) => i.kind === 'question')
  assert.equal(q.state, 'pending')
  assert.ok(!view.json.items.some((i) => i.kind === 'tool' && i.callId === 'late1'), 'not shown as a plain tool')
  const res = await request('POST', '/api/answer', { token, body: { sessionId: SID, callId: 'late1', answers: [{ id: 'mode', selected: ['稳妥'] }] } })
  assert.equal(res.status, 200, JSON.stringify(res.json))
  assert.equal(res.json.mode, 'late')
  assert.deepEqual(host.calls.answer.at(-1).answer, { answers: [{ id: 'mode', selected: ['稳妥'] }] })
  assert.equal(host.calls.answer.at(-1).agent, host.agent)
  const unknown = await request('POST', '/api/answer', { token, body: { sessionId: SID, callId: 'nope', answers: [] } })
  assert.equal(unknown.status, 409)
})

test('ai-approval preset: phone joins only after the AI hands off', async () => {
  host.knobs.preset = 'ai-approval'
  const stream = sse('/api/events', token)
  await until(() => stream.frames.some((f) => f.event === 'hello'))
  let aiDecision = 'allowed-once'
  // Stand-in for dshx-ai-approval, AFTER dshx-remote in the chain.
  const ai = async (req, next) => {
    if (aiDecision === 'allowed-once') return 'allowed-once'
    const hook = req[HUMAN_HOOK]
    req[AI_HANDOFF] = aiDecision
    return typeof hook === 'function' ? hook(next) : next()
  }
  const agent = { id: SID, session: { id: SID } }
  // The remote's own listener is the first (prepended) one registered by apply().
  const remote = host.listeners.get('approval/request')[0]
  const chain = (fns, req) => {
    const cbs = [...fns]
    const next = () => (cbs.shift() ?? (() => Promise.resolve('unavailable')))(req, next)
    return next()
  }
  let order = [remote, ai]
  const run = (extra) => chain(order, { agent, toolName: 'pwsh', ...extra })
  try {
    assert.equal(await run({}), 'allowed-once')
    assert.ok(!stream.frames.some((f) => f.event === 'approval'), 'AI allow never reaches the phone')
    aiDecision = 'rejected'
    const pending = run({ reason: 'AI 拒绝后转人工' })
    const asked = await until(() => stream.frames.find((f) => f.event === 'approval' && f.data.reason === 'AI 拒绝后转人工'))
    const res = await request('POST', '/api/approval', { token, body: { id: asked.data.id, decision: 'allow' } })
    assert.equal(res.status, 200)
    assert.equal(await pending, 'allowed-once', 'human on the phone overrides the AI deny')
    // Order 2: AI reviewer BEFORE dshx-remote.
    order = [ai, remote]
    const p2 = run({ reason: '顺序二' })
    const a2 = await until(() => stream.frames.find((f) => f.event === 'approval' && f.data.reason === '顺序二'))
    await request('POST', '/api/approval', { token, body: { id: a2.data.id, decision: 'reject' } })
    assert.equal(await p2, 'rejected')
    aiDecision = 'allowed-once'
    assert.equal(await run({ reason: '顺序二允许' }), 'allowed-once')
    assert.ok(!stream.frames.some((f) => f.event === 'approval' && f.data.reason === '顺序二允许'))
  } finally {
    host.knobs.preset = 'default'
    stream.close()
  }
})

test('ai-approval preset: an absent phone never blocks the desktop decision', async () => {
  // Regression: engaged() only requires a PAIRED device, so a phone that is
  // asleep or closed used to take over the human stage anyway. The reviewer
  // then called the hook instead of next(), the desktop card never became
  // usable, and the request hung until the turn was killed (an 18-minute
  // "cancelled" in the real log). With no live SSE stream the phone must stay
  // out of it and the desktop chain must answer.
  host.knobs.preset = 'ai-approval'
  const agent = { id: SID, session: { id: SID } }
  const remote = host.listeners.get('approval/request')[0]
  const chain = (fns, req) => {
    const cbs = [...fns]
    const next = () => (cbs.shift() ?? (() => Promise.resolve('unavailable')))(req, next)
    return next()
  }
  let desktopAsked = false
  const desktop = async () => { desktopAsked = true; return 'allowed-once' }
  // Stand-in reviewer: hands off to the human stage exactly like the plugin.
  const ai = async (req, next) => {
    const hook = req[HUMAN_HOOK]
    req[AI_HANDOFF] = 'rejected'
    return typeof hook === 'function' ? hook(next) : next()
  }
  try {
    // The previous test closed its SSE stream, but the server drops the client
    // when the socket's close event fires, which lands a tick later. Give the
    // hang-up time to be observed so this test really runs with no phone online.
    await new Promise((r) => setTimeout(r, 60))
    // Order 1: remote first. No phone is connected, so it must not install a hook.
    const req = { agent, toolName: 'pwsh', reason: '手机不在线' }
    assert.equal(await chain([remote, ai, desktop], req), 'allowed-once')
    assert.equal(req[HUMAN_HOOK], undefined, 'no hand-off hook without a live phone')
    assert.equal(desktopAsked, true, 'the desktop chain owns the decision')

    // Order 2: reviewer first. It marks the hand-off; remote must step aside.
    desktopAsked = false
    const req2 = { agent, toolName: 'pwsh', reason: '手机不在线-顺序二' }
    assert.equal(await chain([ai, remote, desktop], req2), 'allowed-once')
    assert.equal(desktopAsked, true, 'remote must not race an absent phone')
  } finally {
    host.knobs.preset = 'default'
  }
})

test('validateAnswers fills skipped questions and drops unknown labels', () => {
  const out = validateAnswers([{ id: 'a', options: [{ label: 'x' }], multiSelect: false }, { id: 'b', options: [] }], [{ id: 'a', selected: ['y', 'x'] }])
  assert.deepEqual(out, [{ id: 'a', selected: ['x'] }, { id: 'b', selected: [] }])
  assert.throws(() => validateAnswers([], 'x'))
})

test('transcript projects blocking questions: answered, and interrupted when the turn ends', () => {
  const ev = [
    { seq: 0, type: 'assistant/message', data: { message: { id: 'm', content: [{ type: 'tool-call', id: 'k1', name: 'ask_user_question', arguments: '{"questions":[{"id":"a","question":"Q?","options":[{"label":"x"}]}]}' }, { type: 'tool-call', id: 'k2', name: 'ask_user_question', arguments: '{"questions":[{"id":"b","question":"R?"}]}' }] } } },
    { seq: 1, type: 'tool/result', data: { message: { toolCallId: 'k1', content: [{ type: 'text', text: '{"answers":[{"id":"a","selected":["x"]}]}' }] } } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } },
  ]
  const t = buildTranscript(ev)
  const qs = t.items.filter((i) => i.kind === 'question')
  assert.deepEqual(qs.map((q) => q.state), ['answered', 'failed'])
  assert.deepEqual(qs[0].answers, [{ id: 'a', selected: ['x'] }])
})
