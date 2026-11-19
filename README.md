# dshx-remote：手机远程操控 DeepSeek Harness

和 ChatGPT 手机版操控 Codex 类似：DSH 在电脑上运行，手机通过局域网或 Tailscale 打开一个移动网页，可以：

- 查看所有会话（运行中的排在最前），看对话、工具调用进度，AI 回复实时流式显示；
- 给任意会话发指令；任务运行时发送的内容会作为「插话」，在下一步交给 AI；
- 新建会话（可选工作目录、模型和第一条指令）；
- **切换模型**：输入框左下角的模型按钮会显示当前模型和推理强度，点开可以搜索并切换，支持推理强度档位。底层调用和电脑端模型选择器相同（`sessionController.selectModel`），所以切换从下一次请求开始生效，同时会成为新会话的默认模型；
- 一键停止正在运行的任务；
- 处理沙箱越权审批：电脑和手机同时收到请求，谁先点以谁为准。页面打开时会震动提示，并在顶部显示红色横幅。
- **回答模型的提问**（`ask_user_question`）：单选、多选、「其他」自由输入、跳过都支持。同样是电脑和手机谁先提交以谁为准，手机先答时电脑上的问题卡片会自动收起。限时提问超时变成「仍可回答」后，也能在手机上补答（走 `userQuestions.answer`，和电脑端补答相同）。
- 「由 AI 审批」预设的会话：AI 直接放行的请求不会打扰手机；AI 拒绝或判断不了、转交人工时，手机会和电脑一起收到审批。

手机浏览器里选择「添加到主屏幕」，可以在桌面放一个图标。

> 局限：浏览器只在 HTTPS 下才允许系统通知、Service Worker 和完整的 PWA 安装。走局域网 `http://` 时，手机锁屏或页面在后台就收不到审批提醒，「添加到主屏幕」也只是一个快捷方式。用 Tailscale 的 HTTPS（`tailscale serve`）可以解决，这是后续的改进项。

## 安装

```powershell
node F:\ds\projects\dshx-remote\install.mjs
```

然后重启 DSH。

`install.mjs` 会按 `F:\ds\dsh\dshx-plugins\MAINTENANCE.md` 的要求完成三处登记：

1. 复制到 profile 的 `node_modules`；
2. 写入 `package.json` 的依赖和 bundles；
3. 在 `cordis.patch.yml` 里显式加一行。

改动前会备份为 `*.bak-install-dshx-remote`。

## 配对

1. 打开 DSH 的「设置 → 远程控制」，点「配对新设备」。
2. 用手机相机扫码，或在手机浏览器打开页面上列出的地址后手动输入 8 位配对码。配对码 5 分钟内有效，只能用一次。
3. 配对成功后，手机会保存一个设备令牌。在同一个设置页可以看到在线状态、给设备改名，或移除设备（移除后立即失效）。

## 网络

| 场景 | 做法 |
|---|---|
| 同一 Wi‑Fi | 直接用设置页列出的 `http://192.168.x.x:19388/` |
| 出门在外 | 电脑和手机都登录同一个 [Tailscale](https://tailscale.com) 账号，用 `100.x.x.x` 地址访问 |

如果手机打不开页面，通常是 Windows 防火墙拦截了端口。以管理员身份在 PowerShell 里执行一次：

```powershell
New-NetFirewallRule -DisplayName "DSH Remote (dshx-remote)" -Direction Inbound -Protocol TCP -LocalPort 19388 -Action Allow -Profile Private
```

如果你的 Wi‑Fi 在 Windows 里被标记为「公用网络」，就把 `-Profile Private` 改成 `-Profile Private,Public`，或者把网络改成「专用」。

## 安全设计

- DSH 自己的 Web 服务仍然只监听 `127.0.0.1`，不受任何影响。本插件另开一个端口（默认 19388）。
- 来自公网 IP 的请求一律拒绝，只接受本机、私有局域网和 Tailscale（100.64.0.0/10）地址。
- 除了静态页面和配对接口，每个请求都要带设备令牌。电脑上只保存令牌的 SHA‑256 哈希，存放位置是 `~/.dsh/dshx-remote/devices.json`。
- 配对码和令牌验证失败会按 IP 限流；同一个配对码输错 10 次就作废。
- 令牌放在 `Authorization` 头里，不用 Cookie，所以第三方网页无法借用。管理接口挂在 DSH 自己的服务上，受 DSH 登录保护，并且会校验 Origin。
- 处于「由 AI 审批」权限预设的会话先由 dshx-ai-approval 审核，只有它转交人工时才推送到手机。两个插件通过 `Symbol.for('dshx.approval.human')` / `Symbol.for('dshx.approval.ai-handoff')` 交接，互不 import；需要 dshx-ai-approval ≥ 1.5.0。
- 局域网里传输的是 HTTP 明文：同一 Wi‑Fi 下的其他人理论上可以抓包。请只在可信网络下使用，或者通过 Tailscale（WireGuard 加密）访问。

## 配置（可选）

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里：

```yaml
- id: dshx-remote
  name: dshx-remote
  config:
    port: 19388                 # 手机端口
    host: 0.0.0.0               # 监听地址；改成 Tailscale IP 可以只对 Tailscale 开放
    allowPublic: false          # 是否允许公网地址（不建议）
    approvalTimeoutSeconds: 0   # 审批超时自动拒绝；0 = 一直等
```

## 实现要点（基于 DSH 0.2.0-rc.2 源码核实）

- 会话的列表、读取、发送、新建和停止，都走 `ctx.sessionController` 的 `list / inspect / prompt / create / cancel`。这和 DSH 网页端 `/api` 用的是同一套接口。读取已关闭的会话不会唤醒它，发送时由 `prompt()` 自己负责恢复会话。
- 审批：在 `approval/request` waterfall 上加了一个 prepend 监听器。手机、电脑（后续的监听链）、宿主取消信号三方竞速，谁先给出结果就用谁的。手机先答时，会通过替换后的 `req.signal` 撤掉电脑上的审批面板。如果电脑端没有可用的应答者（返回 `unavailable`），就继续等手机，不会直接拒绝。
- 提问：在 `user-questions/request` waterfall 上加了同样的 prepend 监听器（三方竞速 + 替换 `req.signal` 撤掉电脑端卡片）。电脑端没有应答者（`NO_PROVIDER`）时继续等手机；电脑端倒计时到期（`ASK_TIMED_OUT`）原样传回，由宿主转成 pending。会话记录里的 `ask_user_question` 调用以问题卡片显示，不再显示成普通工具。
- 实时更新：全局监听 `session/event`、`agent/status`、`agent/assistant-stream`，经 SSE 推送给手机。连续的事件会合并成一次推送，避免手机端频繁刷新。

## 测试

```powershell
node --test-isolation=none --test test/remote.test.mjs
```

测试会启动真实的 HTTP 服务，只模拟 DSH 宿主上下文，共 30 项，覆盖配对、鉴权、撤销、会话接口、SSE 推送合并、审批三方竞速、AI 审批转人工交接、提问竞速/补答/答案校验、地址分类、限流和对话投影。

`node_modules/` 只是测试用的 schemastery 副本，不会被安装脚本复制。
