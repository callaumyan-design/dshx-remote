// Visual preview: serves the real mobile/ files with a mock API so the phone UI
// can be screenshotted in a headless browser. Not part of the plugin.
//   node test/preview-server.mjs <port>
import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile')
const PORT = Number(process.argv[2] || 19399)
const now = Date.now()
const SID = 'session-11111111-2222-4333-8444-555555555555'
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }

const sessions = [
  { sessionId: SID, title: '给 DSH 做手机远程控制插件', cwd: 'F:\\ds\\projects\\dshx-remote', updatedAt: now - 60_000, live: true, running: true },
  { sessionId: 'session-2', title: '背景插件新增轮换与播放列表', cwd: 'F:\\ds\\dsh\\dshx-plugins', updatedAt: now - 3 * 3600_000, live: true, running: false },
  { sessionId: 'session-3', title: '继续推进长生游戏项目开发', cwd: 'F:\\ds\\projects\\问长生', updatedAt: now - 26 * 3600_000, live: false, running: false },
  { sessionId: 'session-4', title: '修复插件安装目录缺失错误', cwd: 'F:\\ds', updatedAt: now - 30 * 3600_000, live: false, running: false },
  { sessionId: 'session-5', title: 'LLM 成本对比调研', cwd: 'F:\\ds\\docs', updatedAt: now - 4 * 86400_000, live: false, running: false },
  { sessionId: 'session-6', title: '德扑 roguelike 平衡性调整', cwd: 'F:\\ds\\projects\\rivers-end', updatedAt: now - 20 * 86400_000, live: false, running: false },
]
const approvals = [{ id: 'ap1', sessionId: SID, toolName: 'pwsh', reason: '需要写入 C:\\Users\\Callaum\\.dsh\\profiles\\desktop 安装插件（会先备份被改的文件）。', askedAt: now }]
const items = [
  { kind: 'user', seq: 1, text: '优化手机 UI 显示，并增加切换模型的功能。' },
  { kind: 'assistant', seq: 2, reasoning: '先看宿主的模型接口……', text: '好的。我先确认 DSH 宿主提供的 **模型目录** 与 `selectModel` 接口，然后改服务端和手机界面。' },
  { kind: 'tool', seq: 3, name: 'grep', summary: 'buildModelCatalog', status: 'done', args: '{\n  "pattern": "buildModelCatalog"\n}', result: 'index.js:500 async function buildModelCatalog' },
  { kind: 'tool', seq: 4, name: 'read', summary: 'dsh-api-session-controller/lib/index.js', status: 'done', args: '', result: '…' },
  { kind: 'tool', seq: 5, name: 'pwsh', summary: 'Run full test suite', status: 'error', args: '', result: 'exit code 1' },
  { kind: 'assistant', seq: 6, text: '接口确认完毕：\n\n| 接口 | 作用 |\n|---|---|\n| `modelCatalog()` | 列出可用模型 |\n| `selectModel()` | 切换会话模型 |\n\n```js\nawait facade.selectModel({ sessionId, provider, model })\n```\n\n- 切换从下一次请求生效\n- 同时成为新会话默认模型' },
  { kind: 'tool', seq: 7, name: 'edit', summary: 'mobile/app.js', status: 'done', args: '', result: '' },
  { kind: 'tool', seq: 8, name: 'pwsh', summary: 'Install plugin into desktop profile', status: 'running', args: '', result: '' },
  { kind: 'approval', seq: 9, toolName: 'pwsh', reason: approvals[0].reason, outcome: null },
]
const catalog = {
  default: { provider: 'claude', model: 'claude-opus-5-5' },
  groups: [
    { id: 'claude', name: 'Claude', models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }, { id: 'max', name: '最大' }], defaultEffort: 'high' }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }] },
    { id: 'codex', name: 'Codex', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' }, { id: 'gpt-6-astra', name: 'GPT-6 Astra' }] },
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }, { id: 'deepseek-flash', name: 'DeepSeek Flash' }] },
    { id: 'workbuddy-ai', name: 'WorkBuddy AI', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash · x0.25' }] },
  ],
  failures: [],
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
  if (url.pathname === '/api/events') {
    // Finite stream (headless screenshots wait for network idle); long retry.
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('retry: 600000\nevent: hello\ndata: ' + JSON.stringify({ approvals }) + '\n\n')
    setTimeout(() => {
      res.write('event: stream\ndata: ' + JSON.stringify({ sessionId: SID, text: '正在安装插件到 desktop profile，安装完成后需要**重启 DSH**', reasoning: '' }) + '\n\n')
      res.end()
    }, 300)
    return
  }
  if (url.pathname === '/api/sessions') return json({ ok: true, sessions, approvals })
  if (url.pathname === '/api/models') return json({ ok: true, ...catalog })
  if (url.pathname === '/api/session') return json({ ok: true, sessionId: SID, title: sessions[0].title, cwd: sessions[0].cwd, items, hasMore: true, running: true, live: true, streaming: null, approvals, model: { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', providerName: 'Claude', modelName: 'Claude Opus 5.5', effortName: '高' } })
  if (url.pathname === '/api/workspaces') return json({ ok: true, workspaces: [{ path: 'F:\\ds', title: 'ds' }] })
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  try {
    const body = await fs.readFile(path.join(ROOT, file))
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch { res.writeHead(404); res.end() }
}).listen(PORT, '127.0.0.1', () => console.log('preview on ' + PORT))
