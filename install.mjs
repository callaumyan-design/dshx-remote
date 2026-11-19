// Install dshx-remote into the desktop DSH profile.
//
//   node install.mjs            install / update
//   node install.mjs --dry-run  show what would change
//
// Performs the three registration points F:\ds\dsh\dshx-plugins\MAINTENANCE.md
// requires (copy into node_modules, package.json dependency + bundles entry,
// explicit cordis.patch.yml row). Every changed file is backed up first.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const DRY = process.argv.includes('--dry-run')
const PLUGIN = 'dshx-remote'
const SOURCE = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const TARGET = path.join(PROFILE, 'node_modules', PLUGIN)
const PKG = path.join(PROFILE, 'package.json')
const PATCH = path.join(PROFILE, 'cordis.patch.yml')
const SUFFIX = '.bak-install-dshx-remote'
const PAYLOAD = ['package.json', 'index.js', 'auth.js', 'transcript.js', 'client.js', 'cordis.patch.yml', 'README.md', 'vendor/qrcode.cjs', 'mobile/index.html', 'mobile/app.js', 'mobile/app.css', 'mobile/sw.js', 'mobile/manifest.webmanifest', 'mobile/icon.png']

const step = (m) => console.log('  ' + m)
const fail = (m) => { console.error('\nERROR: ' + m); process.exit(1) }
const hasBom = (b) => b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf

console.log('\nInstalling ' + PLUGIN + (DRY ? ' (dry run)' : ''))
console.log('  source:  ' + SOURCE)
console.log('  profile: ' + PROFILE)
for (const f of [PKG, PATCH]) await fs.access(f).catch(() => fail('missing ' + f))

// 1. copy
step('1/3 copy package -> ' + TARGET)
for (const rel of PAYLOAD) {
  const from = path.join(SOURCE, rel)
  await fs.access(from).catch(() => fail('missing payload file ' + rel))
  if (!DRY) {
    await fs.mkdir(path.dirname(path.join(TARGET, rel)), { recursive: true })
    await fs.copyFile(from, path.join(TARGET, rel))
  }
}
step('    ' + PAYLOAD.length + ' files')

// 2. package.json
step('2/3 package.json')
const pkgRaw = await fs.readFile(PKG)
const pkg = JSON.parse((hasBom(pkgRaw) ? pkgRaw.subarray(3) : pkgRaw).toString('utf8'))
const wanted = 'file:' + SOURCE.replace(/\\/g, '/')
pkg.dependencies ??= {}
const before = pkg.dependencies[PLUGIN]
pkg.dependencies[PLUGIN] = wanted
pkg.dsh ??= {}; pkg.dsh.profile ??= {}; pkg.dsh.profile.bundles ??= []
const hadBundle = pkg.dsh.profile.bundles.includes(PLUGIN)
if (!hadBundle) pkg.dsh.profile.bundles.push(PLUGIN)
step('    dependency: ' + (before ?? '(new)') + ' -> ' + wanted + '; bundle ' + (hadBundle ? 'present' : 'added'))
if (!DRY && (before !== wanted || !hadBundle)) {
  await fs.copyFile(PKG, PKG + SUFFIX)
  await fs.writeFile(PKG, JSON.stringify(pkg, null, 2) + '\n')
  const after = await fs.readFile(PKG)
  if (hasBom(after)) fail('package.json has a BOM after writing')
  JSON.parse(after.toString('utf8'))
  step('    written + re-parsed OK (no BOM)')
}

// 3. cordis.patch.yml
step('3/3 cordis.patch.yml')
let yaml = null
try { yaml = require(path.join(PROFILE, 'node_modules', 'js-yaml')) } catch { yaml = null }
const raw = await fs.readFile(PATCH, 'utf8')
const rows = yaml ? yaml.load(raw) : null
if (rows !== null && !Array.isArray(rows)) fail('cordis.patch.yml is not a top-level array')
const present = rows ? rows.some((r) => r && r.id === PLUGIN) : raw.includes('id: ' + PLUGIN)
if (present) step('    mount row already present')
else if (!DRY) {
  await fs.copyFile(PATCH, PATCH + SUFFIX)
  await fs.appendFile(PATCH, '\n- id: ' + PLUGIN + '\n  name: ' + PLUGIN + '\n')
  step('    appended mount row')
}
if (yaml && !DRY) {
  const verify = yaml.load(await fs.readFile(PATCH, 'utf8'))
  const matches = verify.filter((r) => r && r.id === PLUGIN)
  if (matches.length !== 1 || matches[0].disabled === true) fail('expected exactly 1 enabled mount row, found ' + matches.length)
  step('    verified: exactly 1 enabled mount row')
}

console.log('\nDone. Next:')
console.log('  1. Restart DSH (tray -> exit, then reopen).')
console.log('  2. DSH Settings -> 远程控制 -> 配对新设备, scan the QR with your phone.')
console.log('  3. If the phone cannot open the page, allow the port once (admin PowerShell):')
console.log('     New-NetFirewallRule -DisplayName "DSH Remote (dshx-remote)" -Direction Inbound -Protocol TCP -LocalPort 19388 -Action Allow -Profile Private')
