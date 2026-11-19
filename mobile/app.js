// dshx-remote mobile app — vanilla JS, no build step, no external requests.
'use strict'
;(function () {
  const TOKEN_KEY = 'dshx-remote.token'
  const NAME_KEY = 'dshx-remote.device'
  const app = document.getElementById('app')

  // ---------------------------------------------------------------------------
  // icons (inline SVG, stroke = currentColor)
  // ---------------------------------------------------------------------------
  const ICONS = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    send: '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    down: '<path d="M12 5v14M5.5 12.5L12 19l6.5-6.5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
    model: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
    logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 8l-4 4 4 4M6 12h10"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  }
  function icon(name, cls) {
    const span = document.createElement('span')
    span.style.display = 'contents'
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"' + (cls ? ' class="' + cls + '"' : '') + '>' + ICONS[name] + '</svg>'
    return span.firstChild
  }

  // ---------------------------------------------------------------------------
  // tiny DOM helper (text only — never innerHTML with server data)
  // ---------------------------------------------------------------------------
  function h(tag, props, ...children) {
    const el = document.createElement(tag)
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') el.className = value
        else if (key === 'text') el.textContent = value
        else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
        else if (key === 'style') el.style.cssText = value
        else el.setAttribute(key, value === true ? '' : value)
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue
      el.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return el
  }

  let toastEl = null
  function toast(text, ms) {
    if (toastEl) toastEl.remove()
    toastEl = h('div', { class: 'toast', text })
    document.body.append(toastEl)
    const el = toastEl
    setTimeout(() => { el.remove(); if (toastEl === el) toastEl = null }, ms || 2200)
  }

  function haptic(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern || 8) } catch { /* ignore */ } }

  function relTime(ms) {
    if (!ms) return ''
    const diff = Date.now() - ms
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
    const d = new Date(ms)
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes())
    const y = new Date(now); y.setDate(now.getDate() - 1)
    if (d.toDateString() === y.toDateString()) return '昨天'
    if (diff < 6 * 86_400_000) return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
    return (d.getMonth() + 1) + '/' + d.getDate()
  }

  function dayBucket(ms) {
    const d = new Date(ms)
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    if (ms >= start) return '今天'
    if (ms >= start - 86_400_000) return '昨天'
    if (ms >= start - 6 * 86_400_000) return '本周'
    if (d.getFullYear() === now.getFullYear()) return (d.getMonth() + 1) + ' 月'
    return d.getFullYear() + ' 年'
  }

  function baseName(p) {
    if (!p) return ''
    const parts = String(p).split(/[\\/]+/).filter(Boolean)
    return parts[parts.length - 1] || p
  }

  const AVATAR_COLORS = ['#4d6bfe', '#8b5cf6', '#0ea5a4', '#e3803a', '#d14d8a', '#3b82f6', '#16a34a', '#a16207']
  function avatarFor(cwd) {
    const name = baseName(cwd) || '·'
    let hash = 0
    for (const ch of String(cwd || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
    const letter = (name.match(/[A-Za-z0-9\u4e00-\u9fff]/) || ['·'])[0].toUpperCase()
    return { letter, color: AVATAR_COLORS[hash % AVATAR_COLORS.length] }
  }

  // ---------------------------------------------------------------------------
  // safe markdown → DOM (text nodes only)
  // ---------------------------------------------------------------------------
  function inline(text) {
    const out = []
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?，。；：！？）])/g
    let last = 0
    let m
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index))
      if (m[1]) out.push(h('code', { text: m[1].slice(1, -1) }))
      else if (m[2]) out.push(h('strong', { text: m[2].slice(2, -2) }))
      else if (m[3]) out.push(h('a', { href: m[4], target: '_blank', rel: 'noopener noreferrer', text: m[3].slice(1, m[3].indexOf('](')) }))
      else if (m[5]) out.push(h('a', { href: m[5], target: '_blank', rel: 'noopener noreferrer', text: m[5] }))
      last = re.lastIndex
    }
    if (last < text.length) out.push(text.slice(last))
    return out
  }

  function codeBlock(lang, body) {
    const copy = h('button', { text: '复制' })
    copy.addEventListener('click', () => copyText(body).then(() => { copy.textContent = '已复制'; setTimeout(() => { copy.textContent = '复制' }, 1400) }))
    return h('div', { class: 'codeblock' }, h('div', { class: 'ch' }, h('span', { text: lang || 'code' }), copy), h('pre', null, h('code', { text: body })))
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
    // http:// fallback
    const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0' })
    ta.value = text
    document.body.append(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    ta.remove()
    return Promise.resolve()
  }

  function table(lines) {
    const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    const head = rows[0]
    const body = rows.slice(2)
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, head.map((c) => h('th', null, ...inline(c))))),
      h('tbody', null, body.map((r) => h('tr', null, r.map((c) => h('td', null, ...inline(c)))))),
    ))
  }

  function markdown(src) {
    const root = h('div')
    const lines = String(src || '').split('\n')
    let i = 0
    let para = []
    const flush = () => {
      if (!para.length) return
      const p = h('p')
      para.forEach((line, idx) => { if (idx) p.append(h('br')); p.append(...inline(line)) })
      root.append(p)
      para = []
    }
    while (i < lines.length) {
      const line = lines[i]
      const fence = /^\s*```\s*([\w+-]*)/.exec(line)
      if (fence) {
        flush()
        const body = []
        i += 1
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1 }
        i += 1
        root.append(codeBlock(fence[1], body.join('\n')))
        continue
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flush()
        const block = []
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { block.push(lines[i]); i += 1 }
        root.append(table(block))
        continue
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading) { flush(); root.append(h('h3', null, ...inline(heading[2]))); i += 1; continue }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flush(); root.append(h('hr')); i += 1; continue }
      if (/^\s*>\s?/.test(line)) {
        flush()
        const quote = []
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i += 1 }
        root.append(h('blockquote', null, markdown(quote.join('\n'))))
        continue
      }
      const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
      if (bullet) {
        flush()
        const ordered = /\d/.test(bullet[1])
        const list = h(ordered ? 'ol' : 'ul')
        while (i < lines.length) {
          const b = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
          if (!b) break
          list.append(h('li', null, ...inline(b[2].replace(/^\[( |x)\]\s*/i, (_, x) => (x.trim() ? '☑ ' : '☐ ')))))
          i += 1
        }
        root.append(list)
        continue
      }
      if (line.trim() === '') { flush(); i += 1; continue }
      para.push(line)
      i += 1
    }
    flush()
    return root
  }

  // ---------------------------------------------------------------------------
  // state & API
  // ---------------------------------------------------------------------------
  const state = {
    token: localStorage.getItem(TOKEN_KEY),
    view: 'list',
    sessions: null,
    approvals: [],
    questions: [],
    current: null,
    transcript: null,
    events: null,
    connected: false,
    filter: '',
    scope: 'all',
    catalog: null,
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { authorization: 'Bearer ' + state.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    })
    let data = null
    try { data = await res.json() } catch { data = null }
    if (res.status === 401) {
      logout(data && data.error)
      throw new Error((data && data.error) || '未授权')
    }
    if (!res.ok) throw new Error((data && data.error) || ('请求失败 ' + res.status))
    return data
  }

  function logout(reason) {
    localStorage.removeItem(TOKEN_KEY)
    state.token = null
    closeEvents()
    renderPair(reason)
  }

  async function loadCatalog(force) {
    if (state.catalog && !force) return state.catalog
    const data = await api('GET', '/api/models' + (force ? '?force=1' : ''))
    state.catalog = data
    return data
  }

  // ---------------------------------------------------------------------------
  // live events (SSE). EventSource can't send headers, so the token rides in
  // the query string of this one same-origin request.
  // ---------------------------------------------------------------------------
  function openEvents() {
    closeEvents()
    if (!state.token) return
    const params = new URLSearchParams({ token: state.token })
    if (state.view === 'session' && state.current) params.set('session', state.current)
    const es = new EventSource('/api/events?' + params.toString())
    state.events = es
    es.addEventListener('hello', (e) => {
      state.connected = true
      clearTimeout(state.connTimer)
      const data = JSON.parse(e.data)
      state.approvals = data.approvals || []
      state.questions = data.questions || []
      renderConnection()
      renderApprovalBanner()
      if (state.view === 'session') refreshSession()
      else refreshList()
    })
    es.addEventListener('session', (e) => {
      const data = JSON.parse(e.data)
      if (state.view === 'session' && data.sessionId === state.current) scheduleRefresh()
    })
    es.addEventListener('list', () => { if (state.view === 'list') scheduleListRefresh() })
    es.addEventListener('status', (e) => {
      const data = JSON.parse(e.data)
      const row = (state.sessions || []).find((s) => s.sessionId === data.sessionId)
      if (row) row.running = data.running
      if (state.view === 'list') renderList()
      if (state.view === 'session' && data.sessionId === state.current && state.transcript) {
        state.transcript.running = data.running
        if (!data.running) state.transcript.streaming = null
        renderComposerState()
        renderStreaming()
        scheduleRefresh()
      }
    })
    es.addEventListener('stream', (e) => {
      const data = JSON.parse(e.data)
      if (state.view !== 'session' || data.sessionId !== state.current || !state.transcript) return
      state.transcript.streaming = data.text === null ? null : { text: data.text, reasoning: data.reasoning }
      renderStreaming()
    })
    es.addEventListener('approval', (e) => {
      const data = JSON.parse(e.data)
      if (!state.approvals.some((a) => a.id === data.id)) state.approvals.push(data)
      renderApprovalBanner()
      notify('需要审批：' + data.toolName, data.reason)
      if (state.view === 'session' && data.sessionId === state.current) renderTranscript()
      if (state.view === 'list') renderList()
      haptic([120, 60, 120])
    })
    es.addEventListener('approval-done', (e) => {
      const data = JSON.parse(e.data)
      state.approvals = state.approvals.filter((a) => a.id !== data.id)
      renderApprovalBanner()
      if (state.view === 'list') renderList()
      if (state.view === 'session' && data.sessionId === state.current) scheduleRefresh()
    })
    es.addEventListener('question', (e) => {
      const data = JSON.parse(e.data)
      if (!state.questions.some((q) => q.id === data.id)) state.questions.push(data)
      renderApprovalBanner()
      notify('模型在提问', (data.questions[0] && data.questions[0].question) || '')
      if (state.view === 'session' && data.sessionId === state.current) renderTranscript()
      if (state.view === 'list') renderList()
      haptic([80, 50, 80])
    })
    es.addEventListener('question-done', (e) => {
      const data = JSON.parse(e.data)
      state.questions = state.questions.filter((q) => q.id !== data.id)
      renderApprovalBanner()
      if (state.view === 'list') renderList()
      if (state.view === 'session' && data.sessionId === state.current) scheduleRefresh()
    })
    es.onerror = () => {
      state.connected = false
      // Only surface the banner if the outage lasts (avoids flashing on blips).
      clearTimeout(state.connTimer)
      state.connTimer = setTimeout(renderConnection, 3000)
      if (listEls || sessionEls) {
        const dot = (listEls && listEls.status) || (sessionEls && sessionEls.status)
        if (dot) dot.className = 'dot'
      }
      fetch('/api/ping', { headers: { authorization: 'Bearer ' + state.token } }).then((r) => { if (r.status === 401) logout('该设备已被电脑移除，请重新配对') }).catch(() => {})
    }
  }

  function closeEvents() {
    if (state.events) { state.events.close(); state.events = null }
    state.connected = false
  }

  function notify(title, body) {
    try {
      if (document.visibilityState === 'visible') return
      if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body: (body || '').slice(0, 140), icon: '/icon.png' })
    } catch { /* ignore */ }
  }

  let refreshTimer = null
  function scheduleRefresh() {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshSession() }, 300)
  }
  let listTimer = null
  function scheduleListRefresh() {
    if (listTimer) return
    listTimer = setTimeout(() => { listTimer = null; refreshList() }, 500)
  }

  // ---------------------------------------------------------------------------
  // sheets
  // ---------------------------------------------------------------------------
  function openSheet(title, build) {
    const bg = h('div', { class: 'sheet-bg' })
    const close = () => { bg.remove(); document.removeEventListener('keydown', onKey) }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    bg.addEventListener('click', (e) => { if (e.target === bg) close() })
    const sheet = h('div', { class: 'sheet' }, h('div', { class: 'grab' }), h('h3', null, h('span', { text: title }), h('button', { class: 'icon-btn x', onclick: close }, icon('close'))))
    bg.append(sheet)
    build(sheet, close)
    document.body.append(bg)
    return close
  }

  function menu(title, items) {
    openSheet(title, (sheet, close) => {
      sheet.append(h('div', { class: 'sheet-body' }, items.map((item) => h('div', { class: 'menu-row' + (item.danger ? ' danger' : ''), onclick: () => { close(); item.run() } }, item.icon ? icon(item.icon) : null, h('span', { text: item.label })))))
    })
  }

  // ---------------------------------------------------------------------------
  // model picker
  // ---------------------------------------------------------------------------
  function modelLabel(sel) {
    if (!sel) return '选择模型'
    return sel.modelName || sel.model
  }

  /**
   * Open the model picker.
   * @param current - current selection ({provider, model, reasoningEffort}) or null.
   * @param onPick - async (selection) => void; throw to keep the sheet open.
   */
  function pickModel(current, onPick, opts) {
    openSheet((opts && opts.title) || '切换模型', async (sheet, close) => {
      const body = h('div', { class: 'sheet-body' }, h('div', { class: 'empty' }, h('div', { class: 'typing' }, h('i'), h('i'), h('i'))))
      sheet.append(body)
      let catalog
      try { catalog = await loadCatalog(false) } catch (error) { body.replaceChildren(h('div', { class: 'empty', text: error.message })); return }
      let expanded = current ? current.provider + '\u0000' + current.model : null
      let query = ''
      const search = h('input', { type: 'search', placeholder: '搜索模型', autocomplete: 'off' })
      const listEl = h('div')
      search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); draw() })
      body.replaceChildren(h('div', { class: 'msearch' }, h('div', { class: 'search', style: 'padding:0' }, h('label', null, icon('search'), search))), listEl)

      async function choose(group, model, effort) {
        haptic()
        try {
          await onPick({ provider: group.id, model: model.id, ...(effort ? { reasoningEffort: effort } : {}), providerName: group.name, modelName: model.name, ...(effort ? { effortName: (model.efforts.find((e) => e.id === effort) || {}).name || effort } : {}) })
          close()
        } catch (error) { toast(error.message, 3200) }
      }

      function draw() {
        const nodes = []
        for (const group of catalog.groups) {
          const models = group.models.filter((m) => !query || (m.name || '').toLowerCase().includes(query) || m.id.toLowerCase().includes(query) || (group.name || '').toLowerCase().includes(query))
          if (!models.length) continue
          nodes.push(h('div', { class: 'mgroup-h', text: group.name }))
          for (const model of models) {
            const key = group.id + '\u0000' + model.id
            const selected = current && current.provider === group.id && current.model === model.id
            const efforts = model.efforts || []
            const row = h('div', { class: 'mopt' + (selected ? ' sel' : '') },
              h('div', { class: 'mo-main' }, h('div', { class: 'mo-name', text: model.name || model.id }), model.name && model.name !== model.id ? h('div', { class: 'mo-id', text: model.id }) : null),
              efforts.length ? h('span', { class: 'mo-id', text: efforts.length + ' 档推理' }) : null,
              selected ? h('span', { class: 'check' }, icon('check')) : null,
            )
            row.addEventListener('click', () => {
              if (efforts.length) { expanded = expanded === key ? null : key; draw() } else choose(group, model)
            })
            nodes.push(row)
            if (efforts.length && expanded === key) {
              const active = selected ? (current.reasoningEffort || model.defaultEffort) : model.defaultEffort
              nodes.push(h('div', { class: 'efforts' }, efforts.map((e) => h('button', { class: 'chip' + (e.id === active ? ' on' : ''), text: e.name || e.id, onclick: () => choose(group, model, e.id) }))))
            }
          }
        }
        if (!nodes.length) nodes.push(h('div', { class: 'empty', text: query ? '没有匹配的模型' : '没有可用的模型' }))
        for (const f of catalog.failures || []) nodes.push(h('div', { class: 'mfail', text: '⚠ ' + f.name + '：' + f.message.slice(0, 120) }))
        nodes.push(h('div', { class: 'note', text: (opts && opts.note) || '切换后从下一次请求开始生效；正在运行的这一步不受影响。和电脑端一样，所选模型也会成为新会话的默认模型。' }))
        listEl.replaceChildren(...nodes)
      }
      draw()
      if (expanded) requestAnimationFrame(() => { const sel = listEl.querySelector('.mopt.sel'); if (sel) sel.scrollIntoView({ block: 'center' }) })
      loadCatalog(true).then((fresh) => { catalog = fresh; draw() }).catch(() => {})
    })
  }

  // ---------------------------------------------------------------------------
  // pairing
  // ---------------------------------------------------------------------------
  function renderPair(reason, presetCode) {
    state.view = 'pair'
    const code = h('input', { class: 'code-input', inputmode: 'text', autocomplete: 'one-time-code', autocapitalize: 'characters', maxlength: '12', placeholder: 'XXXX-XXXX', value: presetCode || '' })
    const name = h('input', { value: localStorage.getItem(NAME_KEY) || guessDeviceName(), maxlength: '40' })
    const err = h('div', { class: 'err', text: reason || '' })
    const btn = h('button', { class: 'btn primary', text: '配对', style: 'width:100%' })
    async function submit() {
      btn.disabled = true
      err.textContent = ''
      try {
        const res = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.value, name: name.value }) })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || ('配对失败 ' + res.status))
        localStorage.setItem(TOKEN_KEY, data.token)
        localStorage.setItem(NAME_KEY, name.value)
        state.token = data.token
        history.replaceState(null, '', '/')
        haptic(20)
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {})
        showList()
      } catch (error) {
        err.textContent = error.message
        btn.disabled = false
      }
    }
    btn.addEventListener('click', submit)
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit() })
    app.replaceChildren(h('div', { class: 'view' }, h('div', { class: 'scroll' }, h('div', { class: 'pair' },
      h('img', { src: '/icon.png', alt: '' }),
      h('h2', { text: '连接到 DeepSeek Harness' }),
      h('p', { text: '在电脑 DSH 的「设置 → 远程控制」里点「配对新设备」，扫描二维码或输入配对码。' }),
      h('label', { class: 'field' }, h('span', { text: '配对码' }), code),
      h('label', { class: 'field' }, h('span', { text: '这台设备的名称' }), name),
      err,
      btn,
    ))))
    if (presetCode) setTimeout(() => btn.focus(), 50)
  }

  function guessDeviceName() {
    const ua = navigator.userAgent
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/iPad/.test(ua)) return 'iPad'
    const m = /Android [\d.]+; ([^;)]+)/.exec(ua)
    if (m && !/^K$/.test(m[1].trim())) return m[1].trim().slice(0, 40)
    if (/Android/.test(ua)) return 'Android 手机'
    return '手机'
  }

  // ---------------------------------------------------------------------------
  // session list
  // ---------------------------------------------------------------------------
  let listEls = null

  function showList(back) {
    state.view = 'list'
    state.current = null
    state.transcript = null
    sessionEls = null
    if (location.hash) history.replaceState(null, '', '/')
    const status = h('span', { class: 'dot' })
    const search = h('input', { type: 'search', placeholder: '搜索会话或目录', value: state.filter, autocomplete: 'off' })
    search.addEventListener('input', () => { state.filter = search.value; renderList() })
    const chips = h('div', { class: 'chips' })
    const body = h('div', { class: 'scroll' })
    const ptr = { y: 0, active: false }
    body.addEventListener('touchstart', (e) => { ptr.active = body.scrollTop <= 0; ptr.y = e.touches[0].clientY }, { passive: true })
    body.addEventListener('touchend', (e) => { if (ptr.active && e.changedTouches[0].clientY - ptr.y > 90) { haptic(); refreshList(true) } ptr.active = false }, { passive: true })
    app.replaceChildren(h('div', { class: 'view' + (back ? ' back' : '') },
      h('div', { class: 'bar' },
        h('div', { class: 'titles', style: 'padding-left:10px' }, h('h1', null, h('span', { text: 'DSH 远程' }), status)),
        h('button', { class: 'icon-btn', title: '更多', onclick: showMenu }, icon('more')),
      ),
      h('div', { id: 'conn-banner', class: 'banner conn hidden', text: '连接中断，正在重连…' }),
      h('div', { id: 'approval-banner', class: 'approval-banner hidden' }),
      h('div', { class: 'search' }, h('label', null, icon('search'), search)),
      chips,
      body,
      h('button', { class: 'fab', onclick: showCreate }, icon('plus'), '新会话'),
    ))
    listEls = { status, body, chips }
    renderConnection()
    renderApprovalBanner()
    renderList()
    openEvents()
  }

  async function refreshList(manual) {
    try {
      const data = await api('GET', '/api/sessions')
      state.sessions = data.sessions || []
      state.approvals = data.approvals || state.approvals
      state.questions = data.questions || state.questions
      renderList()
      renderApprovalBanner()
      if (manual) toast('已刷新', 900)
    } catch (error) {
      if (state.token) toast(error.message)
    }
  }

  function renderList() {
    if (state.view !== 'list' || !listEls) return
    const all = state.sessions
    if (all === null) {
      listEls.body.replaceChildren(h('div', { class: 'group', text: '加载中' }), h('div', { class: 'card-list' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })))
      return
    }
    // scope chips: 全部 / 运行中 / per project
    const projects = new Map()
    for (const s of all) if (s.cwd && !s.blank) projects.set(s.cwd, (projects.get(s.cwd) || 0) + 1)
    const topProjects = [...projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p]) => p)
    const runningCount = all.filter((s) => s.running).length
    const chipDefs = [{ id: 'all', label: '全部' }]
    if (runningCount) chipDefs.push({ id: 'running', label: '运行中 ' + runningCount })
    for (const p of topProjects) chipDefs.push({ id: 'cwd:' + p, label: baseName(p) })
    if (!chipDefs.some((c) => c.id === state.scope)) state.scope = 'all'
    listEls.chips.replaceChildren(...chipDefs.map((c) => h('button', { class: 'chip' + (state.scope === c.id ? ' on' : ''), text: c.label, onclick: () => { state.scope = c.id; renderList() } })))
    listEls.chips.classList.toggle('hidden', chipDefs.length < 2)

    const q = state.filter.trim().toLowerCase()
    const pending = new Map()
    for (const a of state.approvals) pending.set(a.sessionId, (pending.get(a.sessionId) || 0) + 1)
    const asking = new Set(state.questions.map((q) => q.sessionId))
    for (const s of all) if (s.pendingQuestions) asking.add(s.sessionId)
    const rows = all
      .filter((s) => !s.blank || s.running)
      .filter((s) => state.scope === 'all' || (state.scope === 'running' ? s.running : s.cwd === state.scope.slice(4)))
      .filter((s) => !q || (s.title || '').toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q))

    const renderRow = (s) => {
      const av = avatarFor(s.cwd)
      return h('div', { class: 'row', onclick: () => openSession(s.sessionId) },
        h('div', { class: 'avatar', style: 'background:' + av.color }, av.letter, h('span', { class: 'dot' + (s.running ? ' run' : s.live ? ' on' : ''), style: s.running || s.live ? '' : 'display:none' })),
        h('div', { class: 'main' },
          h('div', { class: 'title' },
            h('span', { text: s.title || '（未命名会话）' }),
            pending.get(s.sessionId) ? h('span', { class: 'badge', text: '待审批' }) : asking.has(s.sessionId) ? h('span', { class: 'badge ask', text: '待回答' }) : s.running ? h('span', { class: 'badge run', text: '运行中' }) : null),
          h('div', { class: 'meta', text: s.cwd || '' }),
        ),
        h('span', { class: 'time', text: relTime(s.updatedAt) }),
      )
    }

    const children = []
    const hot = (s) => s.running || pending.get(s.sessionId) || asking.has(s.sessionId)
    const pinned = rows.filter(hot)
    const rest = rows.filter((s) => !hot(s))
    if (pinned.length) children.push(h('div', { class: 'group', text: '进行中' }), h('div', { class: 'card-list' }, pinned.map(renderRow)))
    let bucket = null
    let card = null
    for (const s of rest.slice(0, 300)) {
      const b = dayBucket(s.updatedAt)
      if (b !== bucket) {
        bucket = b
        card = h('div', { class: 'card-list' })
        children.push(h('div', { class: 'group', text: b }), card)
      }
      card.append(renderRow(s))
    }
    if (!rows.length) children.push(h('div', { class: 'empty' }, h('div', { class: 'big', text: q ? '🔍' : '💬' }), q ? '没有匹配的会话' : '还没有会话，点右下角新建一个'))
    children.push(h('div', { class: 'list-bottom' }))
    listEls.body.replaceChildren(...children)
  }

  function renderConnection() {
    const dot = state.view === 'list' ? listEls && listEls.status : sessionEls && sessionEls.status
    if (dot) { dot.className = 'dot' + (state.connected ? ' on' : ''); dot.title = state.connected ? '已连接' : '连接中断，正在重连' }
    const banner = document.getElementById('conn-banner')
    if (banner) banner.classList.toggle('hidden', state.connected || !state.events)
  }

  function renderApprovalBanner() {
    const el = document.getElementById('approval-banner')
    if (!el) return
    const elsewhere = (x) => state.view !== 'session' || x.sessionId !== state.current
    const others = state.approvals.filter(elsewhere)
    const asks = state.questions.filter(elsewhere)
    el.classList.toggle('hidden', others.length + asks.length === 0)
    el.classList.toggle('ask', others.length === 0 && asks.length > 0)
    if (others.length || asks.length) {
      const parts = []
      if (others.length) parts.push(others.length + ' 个审批请求')
      if (asks.length) parts.push(asks.length + ' 个问题')
      el.textContent = (others.length ? '⚠ ' : '❓ ') + parts.join('、') + '等待处理'
      el.onclick = () => openSession((others[0] || asks[0]).sessionId)
    }
  }

  function showMenu() {
    menu('更多', [
      { icon: 'refresh', label: '刷新', run: () => refreshList(true) },
      { icon: 'bell', label: '开启通知（审批提醒）', run: () => { if ('Notification' in window && window.isSecureContext) Notification.requestPermission().then((p) => toast(p === 'granted' ? '已开启' : '未授权')); else toast('当前是 http 连接，浏览器不允许通知；打开页面时仍会震动提醒', 3500) } },
      { icon: 'logout', label: '退出此设备', danger: true, run: () => { if (confirm('退出后需要重新配对，确定吗？')) logout('已退出') } },
    ])
  }

  function showCreate() {
    openSheet('新建会话', async (sheet, close) => {
      const dirs = new Map()
      let cwd = ''
      let selection = null
      const dirBtn = h('button', { class: 'pick' }, icon('folder'), h('span', { text: '默认目录' }), icon('chev'))
      const modelBtn = h('button', { class: 'pick' }, icon('model'), h('span', { text: '默认模型' }), icon('chev'))
      const custom = h('input', { placeholder: '或输入绝对路径，如 F:\\ds\\projects\\xxx', autocomplete: 'off' })
      const prompt = h('textarea', { rows: '4', placeholder: '第一条指令（可选）' })
      const err = h('div', { class: 'err' })
      const go = h('button', { class: 'btn primary', text: '创建' })
      dirBtn.addEventListener('click', () => {
        menu('工作目录', [{ label: '默认目录', run: () => { cwd = ''; dirBtn.children[1].textContent = '默认目录' } }].concat([...dirs].map(([p, label]) => ({ icon: 'folder', label: label + '  ·  ' + p, run: () => { cwd = p; custom.value = ''; dirBtn.children[1].textContent = label } }))))
      })
      modelBtn.addEventListener('click', () => pickModel(selection, async (sel) => { selection = sel; modelBtn.children[1].textContent = sel.modelName + (sel.effortName ? ' · ' + sel.effortName : '') }, { title: '新会话使用的模型', note: '不选则使用电脑上的默认模型。' }))
      go.addEventListener('click', async () => {
        go.disabled = true
        err.textContent = ''
        try {
          const dir = custom.value.trim() || cwd || undefined
          const data = await api('POST', '/api/create', { cwd: dir, text: prompt.value, ...(selection ? { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort } : {}) })
          close()
          haptic(15)
          openSession(data.sessionId)
        } catch (error) {
          err.textContent = error.message
          go.disabled = false
        }
      })
      sheet.append(
        h('div', { class: 'sheet-body' },
          h('label', { class: 'field' }, h('span', { text: '工作目录' }), dirBtn),
          h('label', { class: 'field' }, custom),
          h('label', { class: 'field' }, h('span', { text: '模型' }), modelBtn),
          h('label', { class: 'field' }, h('span', { text: '第一条指令' }), prompt),
          err),
        h('div', { class: 'sheet-foot' }, h('div', { class: 'btns' }, h('button', { class: 'btn ghost', text: '取消', onclick: close }), go)),
      )
      try {
        const data = await api('GET', '/api/workspaces')
        for (const w of data.workspaces || []) dirs.set(w.path, w.title || baseName(w.path))
      } catch { /* optional */ }
      for (const s of state.sessions || []) if (s.cwd && !dirs.has(s.cwd)) dirs.set(s.cwd, baseName(s.cwd))
    })
  }

  // ---------------------------------------------------------------------------
  // session view
  // ---------------------------------------------------------------------------
  let sessionEls = null
  let stick = true

  function openSession(id, push) {
    state.view = 'session'
    state.current = id
    state.transcript = null
    listEls = null
    if (push !== false) history.pushState({ session: id }, '', '#s=' + encodeURIComponent(id))
    const status = h('span', { class: 'dot' })
    const titleText = h('span', { text: ((state.sessions || []).find((s) => s.sessionId === id) || {}).title || '加载中…' })
    const sub = h('span', { class: 'sub' })
    const chat = h('div', { class: 'chat' }, h('div', { class: 'empty' }, h('div', { class: 'typing' }, h('i'), h('i'), h('i'))))
    const scroller = h('div', { class: 'scroll' }, chat)
    const jump = h('button', { class: 'jump hidden', title: '回到底部' }, icon('down'))
    jump.addEventListener('click', () => { stick = true; scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }) })
    scroller.addEventListener('scroll', () => {
      stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
      jump.classList.toggle('hidden', stick)
    }, { passive: true })
    const input = h('textarea', { rows: '1', placeholder: '给 DSH 发指令…', enterkeyhint: 'send' })
    const send = h('button', { class: 'send', title: '发送' }, icon('send'))
    const chip = h('button', { class: 'model-chip', title: '切换模型' }, icon('model'), h('span', { class: 'mname', text: '模型' }))
    const hint = h('span', { class: 'hint hidden' })
    input.addEventListener('input', () => { autosize(input); renderComposerState() })
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSend() } })
    send.addEventListener('click', () => onSend())
    chip.addEventListener('click', () => {
      const t = state.transcript
      pickModel(t && t.model, async (sel) => {
        const data = await api('POST', '/api/model', { sessionId: state.current, provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort })
        if (state.transcript) state.transcript.model = Object.assign({}, data.model || sel, { pending: true })
        renderModelChip()
        toast('已切换到 ' + modelLabel(data.model || sel))
      })
    })
    app.replaceChildren(h('div', { class: 'view' },
      h('div', { class: 'bar' },
        h('button', { class: 'icon-btn', title: '返回', onclick: () => { if (history.state && history.state.session) history.back(); else showList(true) } }, icon('back')),
        h('div', { class: 'titles' }, h('h1', null, titleText, status), sub),
        h('button', { class: 'icon-btn', title: '更多', onclick: sessionMenu }, icon('more')),
      ),
      h('div', { id: 'conn-banner', class: 'banner conn hidden', text: '连接中断，正在重连…' }),
      h('div', { id: 'approval-banner', class: 'approval-banner hidden' }),
      h('div', { class: 'chat-wrap' }, scroller, jump),
      h('div', { class: 'composer' }, h('div', { class: 'box' }, input, h('div', { class: 'tools' }, chip, hint, send))),
    ))
    sessionEls = { status, titleText, sub, chat, scroller, input, send, chip, hint, streamEl: null }
    stick = true
    renderConnection()
    renderApprovalBanner()
    renderComposerState()
    openEvents()
  }

  function sessionMenu() {
    const t = state.transcript
    menu('会话', [
      { icon: 'model', label: '切换模型' + (t && t.model ? '（当前：' + modelLabel(t.model) + '）' : ''), run: () => sessionEls && sessionEls.chip.click() },
      { icon: 'refresh', label: '刷新', run: () => refreshSession(true) },
      t && t.cwd ? { icon: 'folder', label: '复制工作目录', run: () => copyText(t.cwd).then(() => toast('已复制')) } : null,
      t && t.running ? { icon: 'stop', label: '停止当前任务', danger: true, run: () => stopTask() } : null,
    ].filter(Boolean))
  }

  function autosize(el) {
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.38) + 'px'
  }

  async function refreshSession(force) {
    if (state.view !== 'session' || !state.current) return
    const id = state.current
    try {
      const limit = state.transcript && state.transcript.expanded ? state.transcript.expanded : 150
      const data = await api('GET', '/api/session?id=' + encodeURIComponent(id) + '&limit=' + limit)
      if (state.current !== id) return
      const prev = state.transcript
      // Keep a just-picked model until the server reflects it.
      if (prev && prev.model && prev.model.pending && data.model && (data.model.provider !== prev.model.provider || data.model.model !== prev.model.model)) data.model = prev.model
      state.transcript = Object.assign(data, { expanded: prev && prev.expanded, openSteps: (prev && prev.openSteps) || new Set() })
      for (const a of data.approvals || []) if (!state.approvals.some((x) => x.id === a.id)) state.approvals.push(a)
      state.questions = state.questions.filter((q) => q.sessionId !== id).concat(data.questions || [])
      renderApprovalBanner()
      renderTranscript()
      if (force) toast('已刷新', 900)
    } catch (error) {
      toast(error.message)
    }
  }

  /** Group consecutive tool items into one collapsible "steps" block. */
  function groupItems(items) {
    const out = []
    for (const item of items) {
      const last = out[out.length - 1]
      if (item.kind === 'tool') {
        if (last && last.kind === 'steps') last.tools.push(item)
        else out.push({ kind: 'steps', seq: item.seq, tools: [item] })
      } else out.push(item)
    }
    return out
  }

  function renderTranscript() {
    if (!sessionEls || !state.transcript) return
    const t = state.transcript
    const row = (state.sessions || []).find((s) => s.sessionId === state.current)
    sessionEls.titleText.textContent = t.title || (row && row.title) || '（未命名会话）'
    sessionEls.sub.textContent = t.cwd || ''
    const nodes = []
    if (t.hasMore) nodes.push(h('button', { class: 'more', text: '加载更早的消息', onclick: () => { t.expanded = (t.expanded || 150) + 150; stick = false; refreshSession() } }))
    const grouped = groupItems(t.items)
    grouped.forEach((item, index) => nodes.push(renderItem(item, index === grouped.length - 1)))
    const live = state.approvals.filter((a) => a.sessionId === state.current)
    const shownLive = t.items.some((i) => i.kind === 'approval' && i.outcome === null)
    if (!shownLive) for (const a of live) nodes.push(approvalCard({ toolName: a.toolName, reason: a.reason, outcome: null }, a))
    for (const q of state.questions.filter((x) => x.sessionId === state.current)) {
      if (!t.items.some((i) => i.kind === 'question' && i.callId && i.callId === q.callId)) nodes.push(questionCard({ questions: q.questions, state: 'open', callId: q.callId }, q))
    }
    const streamEl = h('div', { class: 'msg assistant hidden' }, h('div', { class: 'ai' }), h('div', { class: 'body' }))
    nodes.push(streamEl)
    if (!t.items.length && !t.running) nodes.push(h('div', { class: 'empty' }, h('div', { class: 'big', text: '💬' }), '还没有消息，发一条开始吧'))
    sessionEls.chat.replaceChildren(...nodes)
    sessionEls.streamEl = streamEl
    renderStreaming()
    renderComposerState()
    renderModelChip()
    if (stick) requestAnimationFrame(() => { if (sessionEls) sessionEls.scroller.scrollTop = sessionEls.scroller.scrollHeight })
  }

  function renderStreaming() {
    if (!sessionEls || !sessionEls.streamEl || !state.transcript) return
    const s = state.transcript.streaming
    const el = sessionEls.streamEl
    const body = el.lastChild
    if (!state.transcript.running && !s) { el.classList.add('hidden'); return }
    el.classList.remove('hidden')
    if (!s || (!s.text && !s.reasoning)) {
      body.replaceChildren(h('div', { class: 'typing' }, h('i'), h('i'), h('i')))
    } else if (s.text) {
      const md = markdown(s.text)
      md.classList.add('cursor')
      body.replaceChildren(md)
    } else {
      body.replaceChildren(h('div', { class: 'think' }, h('div', { class: 'reasoning cursor', text: s.reasoning.slice(-900) })))
    }
    if (stick) sessionEls.scroller.scrollTop = sessionEls.scroller.scrollHeight
  }

  function renderItem(item, isLast) {
    switch (item.kind) {
      case 'user': {
        const el = h('div', { class: 'msg user', text: item.text })
        if (item.text.length > 600 || item.text.split('\n').length > 12) {
          el.classList.add('long')
          el.addEventListener('click', () => el.classList.remove('long'), { once: true })
        }
        return el
      }
      case 'assistant': {
        const body = h('div', { class: 'body' })
        if (item.reasoning) body.append(h('details', { class: 'think' }, h('summary', null, '💭 思考过程'), h('div', { class: 'reasoning', text: item.reasoning })))
        if (item.text) body.append(markdown(item.text))
        return h('div', { class: 'msg assistant' }, h('div', { class: 'ai' }), body)
      }
      case 'steps': {
        const tools = item.tools
        const running = tools.filter((x) => x.status === 'running').length
        const failed = tools.filter((x) => x.status === 'error').length
        const key = 'steps:' + item.seq
        const open = state.transcript.openSteps.has(key) || (isLast && running > 0)
        const label = running ? '正在执行 ' + (tools.find((x) => x.status === 'running').summary || tools.find((x) => x.status === 'running').name) : tools.length + ' 个步骤' + (failed ? '，' + failed + ' 个失败' : '')
        const status = running ? 'running' : failed ? 'error' : 'done'
        const details = h('details', { class: 'steps' },
          h('summary', { class: 'st-' + status }, h('span', { class: 'ticon' }), h('span', { text: label }), icon('chev', 'chev')),
          h('div', { class: 'slist' }, tools.map(renderTool)),
        )
        if (open) details.open = true
        details.addEventListener('toggle', () => {
          if (!state.transcript) return
          if (details.open) state.transcript.openSteps.add(key); else state.transcript.openSteps.delete(key)
        })
        return details
      }
      case 'approval': {
        const mine = state.approvals.filter((a) => a.sessionId === state.current)
        const live = item.outcome === null ? (mine.find((a) => item.callId && a.callId === item.callId) || mine[0] || null) : null
        return approvalCard(item, live)
      }
      case 'question': {
        const live = state.questions.find((q) => q.sessionId === state.current && q.callId === item.callId) || null
        return questionCard(item, live)
      }
      case 'notice': return h('div', { class: 'notice' + (item.level === 'warn' ? ' warn' : ''), text: item.text + (item.detail ? '：' + item.detail.slice(0, 200) : '') })
      default: return h('div')
    }
  }

  function renderTool(item) {
    const el = h('details', { class: 'tool st-' + item.status },
      h('summary', null, h('span', { class: 'ticon' }), h('span', { class: 'tname', text: item.name }), h('span', { class: 'tsum', text: item.summary })),
      h('div', { class: 'tbody' },
        item.args ? [h('div', { class: 'tlabel', text: '参数' }), h('pre', { text: item.args })] : null,
        item.result ? [h('div', { class: 'tlabel', text: item.status === 'error' ? '错误' : '结果' }), h('pre', { text: item.result })] : null,
      ),
    )
    return el
  }

  function approvalCard(item, live) {
    const outcomeText = { 'allowed-once': '✓ 已允许', rejected: '✕ 已拒绝', cancelled: '已取消', unavailable: '无人处理，已拒绝' }[item.outcome] || ''
    const card = h('div', { class: 'approval-card' + (live ? ' live' : '') },
      h('div', { class: 'ah' }, '⚠️ ', h('span', null, '工具 ', h('code', { text: item.toolName }), ' 请求越权执行')),
      item.reason ? h('div', { class: 'reason', text: item.reason }) : null,
    )
    if (item.outcome) card.append(h('div', { class: 'done', text: outcomeText }))
    else if (live) {
      const allow = h('button', { class: 'btn primary', text: '允许一次' })
      const reject = h('button', { class: 'btn ghost', text: '拒绝' })
      const answer = async (decision) => {
        allow.disabled = reject.disabled = true
        haptic(15)
        try {
          await api('POST', '/api/approval', { id: live.id, decision })
          state.approvals = state.approvals.filter((a) => a.id !== live.id)
          renderApprovalBanner()
          toast(decision === 'allow' ? '已允许' : '已拒绝')
          scheduleRefresh()
        } catch (error) {
          toast(error.message)
          allow.disabled = reject.disabled = false
        }
      }
      allow.addEventListener('click', () => answer('allow'))
      reject.addEventListener('click', () => answer('reject'))
      card.append(h('div', { class: 'btns' }, reject, allow))
    } else card.append(h('div', { class: 'done', text: '等待电脑端处理…' }))
    return card
  }

  /**
   * One ask_user_question batch. Interactive while a live request is pending
   * (answer goes straight back as the tool result) or when a timed question
   * already returned "pending" (answer is sent as a late reply).
   */
  function questionCard(item, live) {
    const late = !live && item.state === 'pending' && item.callId
    const editable = !!live || late
    const card = h('div', { class: 'question-card' + (editable ? ' live' : '') },
      h('div', { class: 'qh' }, '❓ ', h('span', { text: editable ? 'DSH 在问你' : '模型的提问' }), late ? h('span', { class: 'qtag', text: '已超时，仍可回答' }) : null))
    const answers = new Map()
    for (const a of item.answers || []) answers.set(a.id, a)
    const draft = new Map()
    for (const q of item.questions) {
      const box = h('div', { class: 'qitem' })
      if (q.header) box.append(h('div', { class: 'qheader', text: q.header }))
      box.append(h('div', { class: 'qtext' }, ...inline(q.question)))
      if (q.detail) box.append(h('details', { class: 'qdetail' }, h('summary', null, '详情'), markdown(q.detail)))
      const opts = q.options || []
      if (!editable) {
        const a = answers.get(q.id)
        const text = a ? [...(a.selected || []), a.custom].filter(Boolean).join('、') : ''
        box.append(h('div', { class: 'qanswer' + (text ? '' : ' none'), text: a ? (text ? '→ ' + text : '（跳过）') : item.state === 'failed' ? '（未回答，已中断）' : item.state === 'open' ? '等待电脑端回答…' : '' }))
        card.append(box)
        continue
      }
      const d = { selected: new Set(), custom: '' }
      draft.set(q.id, d)
      const optEls = []
      const sync = () => optEls.forEach(([el, label]) => el.classList.toggle('on', d.selected.has(label)))
      for (const o of opts) {
        const el = h('button', { class: 'qopt' + (q.multiSelect ? ' multi' : '') }, h('span', { class: 'qmark' }), h('span', { class: 'qbody' }, h('span', { class: 'qlabel', text: o.label }), o.description ? h('span', { class: 'qdesc', text: o.description }) : null))
        el.addEventListener('click', () => {
          haptic(6)
          if (q.multiSelect) { if (d.selected.has(o.label)) d.selected.delete(o.label); else d.selected.add(o.label) }
          else { const was = d.selected.has(o.label); d.selected.clear(); if (!was) d.selected.add(o.label) }
          sync()
        })
        optEls.push([el, o.label])
        box.append(el)
      }
      const other = h('textarea', { class: 'qcustom', rows: '1', placeholder: opts.length ? '其他（可选，自己输入）' : '输入你的回答' })
      other.addEventListener('input', () => { d.custom = other.value; autosize(other) })
      box.append(other)
      card.append(box)
    }
    if (editable) {
      const err = h('div', { class: 'err', style: 'text-align:left;margin:4px 0 0' })
      const submit = h('button', { class: 'btn primary', text: '提交回答' })
      submit.addEventListener('click', async () => {
        const list = item.questions.map((q) => { const d = draft.get(q.id); return { id: q.id, selected: [...d.selected], ...(d.custom.trim() ? { custom: d.custom } : {}) } })
        if (list.every((a) => !a.selected.length && !a.custom) && !confirm('所有问题都没有作答，确定要以「跳过」提交吗？')) return
        submit.disabled = true
        err.textContent = ''
        haptic(15)
        try {
          await api('POST', '/api/answer', live ? { id: live.id, answers: list } : { sessionId: state.current, callId: item.callId, answers: list })
          if (live) state.questions = state.questions.filter((q) => q.id !== live.id)
          renderApprovalBanner()
          toast('已提交')
          scheduleRefresh()
        } catch (error) {
          err.textContent = error.message
          submit.disabled = false
        }
      })
      card.append(err, h('div', { class: 'btns' }, submit))
    } else if (item.late) card.append(h('div', { class: 'done', text: '已在超时后补答' }))
    return card
  }

  function renderModelChip() {
    if (!sessionEls) return
    const m = state.transcript && state.transcript.model
    const chip = sessionEls.chip
    chip.replaceChildren(icon('model'), h('span', { class: 'mname', text: modelLabel(m) }), m && m.effortName ? h('span', { class: 'eff', text: '· ' + m.effortName }) : null)
    chip.title = m ? (m.providerName || m.provider) + ' / ' + (m.modelName || m.model) : '切换模型'
  }

  function renderComposerState() {
    if (!sessionEls) return
    const running = !!(state.transcript && state.transcript.running)
    const hasText = sessionEls.input.value.trim() !== ''
    const send = sessionEls.send
    if (running && !hasText) {
      send.className = 'send stop'
      send.replaceChildren(icon('stop'))
      send.title = '停止'
      send.disabled = false
    } else {
      send.className = 'send'
      send.replaceChildren(icon('send'))
      send.title = running ? '插话（下一步生效）' : '发送'
      send.disabled = !hasText
    }
    sessionEls.hint.classList.toggle('hidden', !(running && hasText))
    sessionEls.hint.textContent = '运行中：将作为插话发送'
    sessionEls.chip.classList.toggle('hidden', running && hasText)
  }

  async function stopTask() {
    try {
      haptic(15)
      await api('POST', '/api/cancel', { sessionId: state.current })
      toast('已请求停止')
    } catch (error) { toast(error.message) }
  }

  async function onSend() {
    if (!sessionEls) return
    const running = !!(state.transcript && state.transcript.running)
    const text = sessionEls.input.value
    if (running && text.trim() === '') {
      if (confirm('停止当前正在运行的任务？')) stopTask()
      return
    }
    if (text.trim() === '') return
    sessionEls.send.disabled = true
    try {
      await api('POST', '/api/prompt', {
        sessionId: state.current,
        text,
        mode: running ? 'steer' : 'followup',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
      haptic(10)
      sessionEls.input.value = ''
      autosize(sessionEls.input)
      stick = true
      if (state.transcript) {
        // Optimistic echo until the log catches up.
        if (!running) state.transcript.items.push({ kind: 'user', seq: Infinity, text })
        state.transcript.running = true
        renderTranscript()
      }
      scheduleRefresh()
    } catch (error) {
      toast(error.message, 3500)
    } finally {
      renderComposerState()
    }
  }

  // ---------------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------------
  window.addEventListener('popstate', () => {
    if (!state.token) return
    const m = /^#s=(.+)$/.exec(location.hash)
    if (m) { if (state.current !== decodeURIComponent(m[1])) openSession(decodeURIComponent(m[1]), false) }
    else showList(true)
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.token) return
    if (!state.events || state.events.readyState === 2) openEvents()
    else if (state.view === 'session') refreshSession()
    else refreshList()
  })

  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {})

  const pair = /^#pair=([A-Za-z0-9-]+)$/.exec(location.hash)
  if (pair) {
    renderPair(state.token ? '这台设备已配对过；再次配对会新增一个设备记录' : '', pair[1])
  } else if (!state.token) {
    renderPair()
  } else {
    const m = /^#s=(.+)$/.exec(location.hash)
    if (m) {
      const id = decodeURIComponent(m[1])
      history.replaceState(null, '', '/')
      showList()
      openSession(id)
    } else showList()
  }
})()
