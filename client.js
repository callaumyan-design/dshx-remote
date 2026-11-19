// dshx-remote — browser half: the 「远程控制」 Settings page.
//
// Talks only to the host half's admin route on DSH's own Web server
// (`/dshx-remote/admin`), which sits behind DSH's browser authentication.
window.__ModuleLoader__.load({
  id: 'dshx-remote',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const e = React.createElement
    const ADMIN = '/dshx-remote/admin'

    const card = { border: '1px solid rgba(127,127,127,0.22)', borderRadius: 10, padding: '14px 16px', background: 'rgba(127,127,127,0.07)' }
    const cardTitle = { fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.55, marginBottom: 10 }
    const muted = { fontSize: 12, opacity: 0.65, lineHeight: 1.6 }
    const errorText = { fontSize: 12, color: '#d9534f', lineHeight: 1.6 }
    const button = { border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit', borderRadius: 7, padding: '5px 12px', fontSize: 12.5, cursor: 'pointer' }
    const primary = Object.assign({}, button, { background: '#4d6bfe', borderColor: '#4d6bfe', color: '#fff' })
    const danger = Object.assign({}, button, { color: '#d9534f', borderColor: 'rgba(217,83,79,0.5)' })
    const mono = { fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }

    async function call(body) {
      const res = await fetch(ADMIN, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
        cache: 'no-store',
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || ('请求失败 ' + res.status))
      return data
    }

    function stamp(ms) {
      if (!ms) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    function Countdown(props) {
      const [now, setNow] = React.useState(Date.now())
      React.useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
      const left = Math.max(0, Math.round((props.until - now) / 1000))
      React.useEffect(() => { if (left === 0) props.onExpire() }, [left === 0])
      return e('span', null, Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0'))
    }

    function Panel() {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(() => {
        call().then((data) => { setState(data); setError('') }).catch((err) => setError(err.message))
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, 4000)
        return () => clearInterval(timer)
      }, [load])

      const act = (body, confirmText) => {
        if (confirmText && !window.confirm(confirmText)) return
        setBusy(true)
        call(body).then((data) => { setState(data); setError('') }).catch((err) => setError(err.message)).finally(() => setBusy(false))
      }

      if (state === null) return e('div', { style: { padding: 4 } }, error ? e('div', { style: errorText }, '读取失败：' + error) : e('div', { style: muted }, '加载中…'))

      const server = state.server || {}
      const pairing = state.pairing
      const urls = state.urls || []

      const statusLine = !state.enabled
        ? e('span', { style: { color: '#d29922' } }, '已关闭（手机端无法访问）')
        : server.listening
          ? e('span', { style: { color: '#2fb67c' } }, '运行中 · 端口 ' + server.port)
          : e('span', { style: { color: '#d9534f' } }, '未能启动：' + (server.error || '未知原因'))

      return e('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 760 } },
        e('div', { style: card },
          e('div', { style: cardTitle }, '远程控制'),
          e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            e('div', { style: { flex: 1, minWidth: 200 } }, statusLine),
            state.enabled
              ? e('button', { style: danger, disabled: busy, onClick: () => act({ action: 'disable' }, '关闭后所有已配对手机都会立即断开（配对记录保留），确定吗？') }, '关闭远程控制')
              : e('button', { style: primary, disabled: busy, onClick: () => act({ action: 'enable' }) }, '开启远程控制')),
          e('div', { style: Object.assign({}, muted, { marginTop: 10 }) },
            '让手机通过局域网或 Tailscale 查看会话、发送指令、停止任务、处理审批。手机必须先在这里配对；未配对的设备、以及公网地址都会被拒绝。'),
          urls.length > 0
            ? e('div', { style: Object.assign({}, muted, { marginTop: 8 }) },
                '手机访问地址：',
                urls.map((u, i) => e('span', { key: u.url }, i ? '，' : '', e('span', { style: mono }, u.url), u.kind === 'tailscale' ? '（Tailscale）' : '')))
            : e('div', { style: Object.assign({}, errorText, { marginTop: 8 }) }, '没有检测到局域网或 Tailscale 地址，请确认电脑已连网。'),
          error ? e('div', { style: Object.assign({}, errorText, { marginTop: 8 }) }, error) : null),

        state.enabled ? e('div', { style: card },
          e('div', { style: cardTitle }, '配对新设备'),
          pairing
            ? e('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' } },
                pairing.qr
                  ? e('div', { style: { width: 200, height: 200, background: '#fff', borderRadius: 8, padding: 6, flex: 'none' }, dangerouslySetInnerHTML: { __html: pairing.qr } })
                  : null,
                e('div', { style: { flex: 1, minWidth: 220 } },
                  e('div', { style: muted }, '用手机相机或浏览器扫码，或打开上面的地址后手动输入配对码：'),
                  e('div', { style: Object.assign({}, mono, { fontSize: 28, letterSpacing: '0.25em', margin: '8px 0' }) }, pairing.code.slice(0, 4) + '-' + pairing.code.slice(4)),
                  e('div', { style: muted }, '有效期剩余 ', e(Countdown, { until: pairing.expiresAt, onExpire: load }), '，只能使用一次。'),
                  e('div', { style: { marginTop: 10 } }, e('button', { style: button, disabled: busy, onClick: () => act({ action: 'cancel-pair' }) }, '取消'))))
            : e('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                e('button', { style: primary, disabled: busy || !server.listening, onClick: () => act({ action: 'pair' }) }, '配对新设备'),
                e('span', { style: muted }, '生成一次性二维码，5 分钟内有效。'))) : null,

        e('div', { style: card },
          e('div', { style: cardTitle }, '已配对设备（' + (state.devices || []).length + '）'),
          (state.devices || []).length === 0
            ? e('div', { style: muted }, '还没有配对任何设备。')
            : e('div', null, (state.devices || []).map((d) => e('div', { key: d.id, style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid rgba(127,127,127,0.15)' } },
                e('span', { style: { width: 8, height: 8, borderRadius: '50%', background: (state.connected || []).includes(d.id) ? '#2fb67c' : 'rgba(127,127,127,0.5)', flex: 'none' } }),
                e('div', { style: { flex: 1, minWidth: 0 } },
                  e('div', null, d.name),
                  e('div', { style: muted }, '配对于 ' + stamp(d.createdAt) + ' · 最近活动 ' + stamp(d.lastSeenAt) + (d.lastAddress ? ' · ' + d.lastAddress.replace(/^::ffff:/, '') : ''))),
                e('button', { style: button, disabled: busy, onClick: () => { const name = window.prompt('设备名称', d.name); if (name) act({ action: 'rename', id: d.id, name }) } }, '改名'),
                e('button', { style: danger, disabled: busy, onClick: () => act({ action: 'revoke', id: d.id }, '移除「' + d.name + '」？该设备将立即失去访问权限。') }, '移除'))))),

        e('div', { style: card },
          e('div', { style: cardTitle }, '说明'),
          e('div', { style: muted },
            e('div', null, '· 审批：会话需要越权执行时，电脑和手机同时收到请求，谁先处理以谁为准；「由 AI 审批」模式的会话不会推送到手机。'),
            e('div', null, '· 手机浏览器里选择「添加到主屏幕」即可像 App 一样使用。'),
            e('div', null, '· 出门在外要用时，电脑和手机都登录同一个 Tailscale 账号，用 Tailscale 地址访问。'),
            e('div', null, '· 如果手机打不开地址，多半是 Windows 防火墙拦截了端口 ' + server.port + '，需要放行一次（见插件 README）。'),
            e('div', null, '· 传输为局域网内的 HTTP 明文；请只在可信网络或 Tailscale（自带加密）下使用。'))),

        e('div', { style: { fontSize: 11, opacity: 0.4 } }, 'dshx-remote v1.0.0'))
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dshx-remote',
        order: 35,
        label: '远程控制',
      }, Panel))
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
