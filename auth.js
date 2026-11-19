// dshx-remote — pairing codes, device tokens, rate limits, address policy.
// Pure Node (no host imports) so it is unit-testable.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const CODE_LENGTH = 8
export const CODE_TTL_MS = 5 * 60_000
const CODE_MAX_ATTEMPTS = 10
export const MAX_DEVICES = 10

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

/** A fresh human-typeable pairing code (no 0/O/1/I/L). */
export function newPairingCode() {
  const bytes = randomBytes(CODE_LENGTH)
  let out = ''
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length]
  return out
}

/** Normalize user-typed code: upper-case, drop spaces and dashes. */
export function normalizeCode(code) {
  return typeof code === 'string' ? code.toUpperCase().replace(/[\s-]/g, '') : ''
}

// ---------------------------------------------------------------------------
// address policy
// ---------------------------------------------------------------------------

function ipv4Parts(address) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n <= 255) ? parts : null
}

/**
 * Classify a peer address.
 * @returns 'loopback' | 'lan' | 'tailscale' | 'public'
 */
export function classifyAddress(raw) {
  let address = String(raw ?? '').trim().toLowerCase()
  if (address.startsWith('::ffff:')) address = address.slice(7)
  const v4 = ipv4Parts(address)
  if (v4) {
    const [a, b] = v4
    if (a === 127) return 'loopback'
    if (a === 10) return 'lan'
    if (a === 172 && b >= 16 && b <= 31) return 'lan'
    if (a === 192 && b === 168) return 'lan'
    if (a === 169 && b === 254) return 'lan'
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale'
    return 'public'
  }
  if (address === '::1') return 'loopback'
  if (address.startsWith('fd7a:115c:a1e0:')) return 'tailscale'
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return 'lan'
  if (/^fe[89ab][0-9a-f]:/.test(address)) return 'lan'
  return 'public'
}

/** Whether a peer may reach the remote server at all. */
export function addressAllowed(address, allowPublic) {
  return allowPublic === true || classifyAddress(address) !== 'public'
}

// ---------------------------------------------------------------------------
// rate limiting (sliding window per key)
// ---------------------------------------------------------------------------

export class RateLimiter {
  constructor(limit, windowMs, now = () => Date.now()) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
    this.hits = new Map()
  }

  /** Record one failure for `key`. */
  fail(key) {
    const at = this.now()
    const list = (this.hits.get(key) ?? []).filter((t) => at - t < this.windowMs)
    list.push(at)
    this.hits.set(key, list)
  }

  /** Whether `key` is currently locked out. */
  blocked(key) {
    const at = this.now()
    const list = (this.hits.get(key) ?? []).filter((t) => at - t < this.windowMs)
    if (list.length === 0) this.hits.delete(key)
    else this.hits.set(key, list)
    return list.length >= this.limit
  }
}

// ---------------------------------------------------------------------------
// device store
// ---------------------------------------------------------------------------

/**
 * Paired devices persisted as `{ enabled, devices: [{ id, name, tokenHash,
 * createdAt, lastSeenAt, lastAddress }] }`. Tokens are only stored hashed.
 * The pairing code lives in memory only.
 */
export class DeviceStore {
  constructor(file, now = () => Date.now()) {
    this.file = file
    this.now = now
    this.state = { enabled: true, devices: [] }
    this.pairing = null
    this.saving = Promise.resolve()
    this.dirtyLastSeen = false
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        this.state.enabled = parsed.enabled !== false
        this.state.devices = Array.isArray(parsed.devices)
          ? parsed.devices.filter((d) => d && typeof d.id === 'string' && typeof d.tokenHash === 'string')
          : []
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return this
  }

  save() {
    const snapshot = JSON.stringify(this.state, null, 2)
    this.saving = this.saving.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = this.file + '.' + process.pid + '.tmp'
      await fs.writeFile(tmp, snapshot, { mode: 0o600 })
      await fs.rename(tmp, this.file)
    })
    return this.saving
  }

  get enabled() { return this.state.enabled }

  async setEnabled(value) {
    this.state.enabled = value === true
    if (!this.state.enabled) this.pairing = null
    await this.save()
  }

  /** Public device list (no hashes). */
  devices() {
    return this.state.devices.map(({ id, name, createdAt, lastSeenAt, lastAddress }) => ({ id, name, createdAt, lastSeenAt, lastAddress }))
  }

  /** Create (replacing any previous) pairing code. */
  startPairing() {
    this.pairing = { code: newPairingCode(), expiresAt: this.now() + CODE_TTL_MS, attempts: 0 }
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt }
  }

  cancelPairing() { this.pairing = null }

  /** Current pairing code if still valid. */
  currentPairing() {
    if (this.pairing === null) return null
    if (this.now() >= this.pairing.expiresAt) { this.pairing = null; return null }
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt }
  }

  /**
   * Redeem a pairing code for a new device token.
   * @returns `{ ok: true, token, device }` or `{ ok: false, error }`.
   */
  async redeem(code, name, address) {
    if (!this.state.enabled) return { ok: false, error: '远程控制已在电脑上关闭' }
    const current = this.currentPairing()
    if (current === null) return { ok: false, error: '没有有效的配对码，请在电脑上的「远程控制」设置页重新生成' }
    if (normalizeCode(code) !== current.code) {
      this.pairing.attempts += 1
      if (this.pairing.attempts >= CODE_MAX_ATTEMPTS) this.pairing = null
      return { ok: false, error: '配对码不正确' }
    }
    if (this.state.devices.length >= MAX_DEVICES) return { ok: false, error: '已配对设备过多，请先在电脑上移除旧设备' }
    this.pairing = null // single use
    const token = randomBytes(32).toString('base64url')
    const device = {
      id: randomUUID(),
      name: String(name ?? '').trim().slice(0, 40) || '手机',
      tokenHash: sha256(token),
      createdAt: this.now(),
      lastSeenAt: this.now(),
      lastAddress: String(address ?? ''),
    }
    this.state.devices.push(device)
    await this.save()
    return { ok: true, token, device: { id: device.id, name: device.name } }
  }

  /** Resolve a bearer token to its device, or null. */
  authenticate(token, address) {
    if (!this.state.enabled || typeof token !== 'string' || token.length < 20 || token.length > 200) return null
    const hash = sha256(token)
    const device = this.state.devices.find((d) => d.tokenHash === hash)
    if (!device) return null
    const at = this.now()
    if (at - (device.lastSeenAt ?? 0) > 60_000 || device.lastAddress !== address) {
      device.lastSeenAt = at
      device.lastAddress = String(address ?? '')
      this.save().catch(() => {})
    }
    return device
  }

  async revoke(id) {
    const before = this.state.devices.length
    this.state.devices = this.state.devices.filter((d) => d.id !== id)
    if (this.state.devices.length !== before) await this.save()
    return this.state.devices.length !== before
  }

  async rename(id, name) {
    const device = this.state.devices.find((d) => d.id === id)
    if (!device) return false
    device.name = String(name ?? '').trim().slice(0, 40) || device.name
    await this.save()
    return true
  }
}
