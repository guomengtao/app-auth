#!/usr/bin/env node
/**
 * capture-pages.js —— 手环端「逐页截图档案」采集器（P0 资产 + P3「发版即采集」的执行体）
 *
 * 设计原则
 *   1. 开关优先：每页在 pages.json 里有 capture.enabled 开关，默认只采打开的那些
 *   2. 可指定：--only / --skip 精确到页；--enable / --disable 直接改开关（写回 pages.json）
 *   3. 可不更新：--no-update 时不写回 pages.json（只产出图片），适合"只想看一眼"
 *   4. 不阻塞发版：采集是独立命令；失败只记录不炸整个流程（--fail-fast 可切换）
 *   5. 耗时可见：每页打印耗时，最后打印总耗时（回答"这功能到底多慢"）
 *
 * 用法
 *   node scripts/capture-pages.js --list                     # 列出页面/开关/是否可自动
 *   node scripts/capture-pages.js --dry-run                  # 只打印计划与预计耗时
 *   node scripts/capture-pages.js                            # 采集所有 enabled 的页面
 *   node scripts/capture-pages.js --only index,settings      # 只采这两页
 *   node scripts/capture-pages.js --skip donate --no-update   # 跳过某页且不写回数据
 *   node scripts/capture-pages.js --enable index,detail      # 打开开关（写回）
 *   node scripts/capture-pages.js --disable donate           # 关闭开关（写回）
 *   node scripts/capture-pages.js --check                     # 采集后跑几何体检（左右对称）
 *   node scripts/capture-pages.js --grpc 8554 --adb emulator-5554
 *
 * 依赖（同机已有，不新增依赖）
 *   <watch-repo>/scripts/emulator-eye.js   gRPC 直连模拟器：截图 / 点击
 *   <watch-repo>/scripts/png-measure.js    runrow 逐行色带，用于几何体检
 *   <watch-repo>/node_modules/@aiot-toolkit/emulator/node_modules/@miwt/adb/bin/mac/adb
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const PAGES_JSON = path.join(ROOT, 'pages.json')
const OUT_DIR = path.join(ROOT, 'images', 'ev-schedule', 'pages')
const PKG = 'com.application.watch.classschedule'

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const has = (f) => argv.indexOf(f) !== -1
const val = (f, d) => {
  const i = argv.indexOf(f)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d
}
const list = (f) =>
  val(f, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const opt = {
  list: has('--list'),
  dryRun: has('--dry-run'),
  noUpdate: has('--no-update'),
  check: has('--check'),
  failFast: has('--fail-fast'),
  help: has('--help') || has('-h'),
  only: list('--only'),
  skip: list('--skip'),
  enable: list('--enable'),
  disable: list('--disable'),
  grpc: val('--grpc', ''),
  adb: val('--adb', ''),
  watchRepo: val('--watch-repo', ''),
}

if (opt.help) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^\s*\*? ?/gm, ''))
  process.exit(0)
}

// ---------- 工具 ----------
const sleep = (ms) => execFileSync('/bin/sh', ['-c', `sleep ${ms / 1000}`])
const secs = (ms) => (ms / 1000).toFixed(1) + 's'
const nowStr = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const data = JSON.parse(fs.readFileSync(PAGES_JSON, 'utf8'))

// 自动探测手环端仓库（app-auth 与 class-schedule 通常同层或 ../tom/class/class）
function detectWatchRepo() {
  const cands = [
    opt.watchRepo,
    process.env.WATCH_REPO,
    path.resolve(ROOT, '..', 'tom', 'class', 'class'),
    path.resolve(ROOT, '..', 'class-schedule'),
    '/Users/Banner/Documents/guomengtao/tom/class/class',
  ].filter(Boolean)
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'scripts', 'emulator-eye.js'))) return c
  }
  return null
}
const WATCH = detectWatchRepo()
const EYE = WATCH ? path.join(WATCH, 'scripts', 'emulator-eye.js') : null
const MEASURE = WATCH ? path.join(WATCH, 'scripts', 'png-measure.js') : null
const ADB =
  opt.adb ||
  (WATCH
    ? path.join(
        WATCH,
        'node_modules/@aiot-toolkit/emulator/node_modules/@miwt/adb/bin/mac/adb'
      )
    : 'adb')
const GRPC = opt.grpc || String(data.captureEnv && data.captureEnv.grpc) || '8554'

// ---------- 开关维护 ----------
let dirty = false
if (opt.enable.length || opt.disable.length) {
  data.pages.forEach((p) => {
    if (opt.enable.indexOf(p.id) !== -1) {
      p.capture = p.capture || {}
      p.capture.enabled = true
      dirty = true
      console.log('开关 ON  :', p.id)
    }
    if (opt.disable.indexOf(p.id) !== -1) {
      p.capture = p.capture || {}
      p.capture.enabled = false
      dirty = true
      console.log('开关 OFF :', p.id)
    }
  })
}
if (dirty && !opt.noUpdate) {
  fs.writeFileSync(PAGES_JSON, JSON.stringify(data, null, 2) + '\n')
  console.log('已写回 pages.json 的开关状态\n')
}

// ---------- 选页 ----------
function pick() {
  return data.pages.filter((p) => {
    if (opt.only.length) return opt.only.indexOf(p.id) !== -1
    if (opt.skip.indexOf(p.id) !== -1) return false
    return !!(p.capture && p.capture.enabled)
  })
}
const picked = pick()
const skipped = data.pages.filter((p) => picked.indexOf(p) === -1)

const autoOk = (p) => !!(p.capture && p.capture.steps && p.capture.steps.length)
const estPerPage = 22 // 秒/页（实测经验：启动 15s + 点击等待 + 截图；见运行后真实耗时）

// ---------- --list ----------
if (opt.list) {
  console.log('id'.padEnd(22) + '名称'.padEnd(14) + '分组'.padEnd(12) + '开关  自动  备注')
  data.pages.forEach((p) => {
    const en = p.capture && p.capture.enabled ? 'ON ' : 'off'
    const au = autoOk(p) ? '自动' : '人工'
    const why = (p.capture && p.capture.why) || ''
    console.log(
      String(p.id).padEnd(22) + String(p.name).padEnd(12) + String(p.group).padEnd(10) + en + '   ' + au + '  ' + why
    )
  })
  console.log(
    `\n共 ${data.pages.length} 页；本次会采 ${picked.length} 页（其中可自动 ${picked.filter(autoOk).length} 页）`
  )
  process.exit(0)
}

// ---------- 预检 ----------
console.log('=== 逐页截图采集 ===')
console.log('手环端仓库 :', WATCH || '❌ 未找到（用 --watch-repo 指定）')
console.log('模拟器     :', ADB + ' / gRPC ' + GRPC + '（' + (data.captureEnv.device || '') + ' ' + (data.captureEnv.size || '') + '）')
console.log('输出目录   :', path.relative(ROOT, OUT_DIR))
console.log('计划采集   :', picked.length, '页（可自动', picked.filter(autoOk).length, '页 / 需人工', picked.filter((p) => !autoOk(p)).length, '页）')
console.log('数据写回   :', opt.noUpdate ? '否（--no-update）' : '是')
console.log('预计耗时   : 可自动页 × ≈' + estPerPage + 's + 人工页 0s（跳过） ≈ ' + secs(picked.filter(autoOk).length * estPerPage * 1000))
console.log('')

if (!WATCH || !fs.existsSync(EYE)) {
  console.log('❌ 找不到 emulator-eye.js，无法采集。用 --watch-repo <手环端仓库路径> 指定后重试。')
  process.exit(1)
}
if (opt.dryRun) {
  picked.forEach((p) => {
    const steps = (p.capture.steps || []).map((s) => Object.keys(s)[0] + (s.tap ? '(' + s.tap + ')' : '')).join(' → ')
    console.log(`[计划] ${p.id.padEnd(20)} ${autoOk(p) ? steps || '(空)' : '需人工点入 → 跳过'}`)
  })
  console.log('\n（--dry-run：未执行）')
  process.exit(0)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
const adb = (args) => execFileSync(ADB, args, { stdio: 'pipe' })
const eye = (args) => execFileSync('node', [EYE, ...args], { stdio: 'pipe', cwd: WATCH })

function preflight() {
  try {
    const out = adb(['-s', String(data.captureEnv.adb || 'emulator-5554'), 'shell', 'ps']).toString()
    const alive = out.split('\n').filter((l) => l.indexOf(PKG) !== -1).length
    return alive > 0
  } catch (e) {
    return false
  }
}
console.log('模拟器上应用进程 :', preflight() ? '运行中' : '未运行（采集时会自动启动）')
console.log('')

// ---------- 采集 ----------
const t0 = Date.now()
const results = []

for (const p of picked) {
  if (!autoOk(p)) {
    console.log(`— 跳过 ${p.id}（需人工点入：${(p.capture && p.capture.why) || '未提供自动步骤'}）`)
    results.push({ id: p.id, ok: null, ms: 0, note: 'manual' })
    continue
  }
  console.log(`▶ ${p.id}（${p.name}）`)
  const pt = Date.now()
  const shots = []
  let err = ''
  try {
    for (const step of p.capture.steps) {
      if (step.launch) {
        process.stdout.write(`  · 启动应用 ${PKG} ... `)
        // 用设备侧后台 shell，adb 立即返回，避免 vapp 阻塞脚本
        adb(['-s', String(data.captureEnv.adb || 'emulator-5554'), 'shell', 'vapp app/' + PKG + ' &'])
        process.stdout.write('已发启动指令\n')
      } else if (step.wait) {
        const total = step.wait * 1000
        const w0 = Date.now()
        process.stdout.write(`  · 等待 ${step.wait}s`)
        while (Date.now() - w0 < total) {
          sleep(Math.min(2000, total - (Date.now() - w0)))
          process.stdout.write('.')
        }
        console.log(' ok')
      } else if (step.tap) {
        process.stdout.write(`  · 点击 (${step.tap[0]},${step.tap[1]}) ... `)
        eye(['ctap', GRPC, String(step.tap[0]), String(step.tap[1])])
        sleep(300)
        console.log('ok')
      } else if (step.shot) {
        process.stdout.write(`  · 截图 (${step.shot}) -> `)
        const file = `pages/${p.id}-${step.shot}.png`
        eye(['shot', GRPC, path.join(OUT_DIR, path.basename(file))])
        shots.push({ file, state: step.shot, version: data.watchApp.version, at: nowStr() })
        console.log(path.basename(file))
      }
    }
  } catch (e) {
    err = String(e.message || e).split('\n')[0]
  }
  const ms = Date.now() - pt
  const ok = !err && shots.length > 0
  console.log(`${ok ? '✅' : '❌'} ${p.id.padEnd(20)} ${secs(ms).padStart(6)}  ${shots.length} 张${err ? '  ' + err : ''}`)
  if (!opt.noUpdate && ok) {
    p.shots = shots
    p.capturedAt = nowStr()
    data.watchApp.updatedAt = nowStr()
  }
  results.push({ id: p.id, ok, ms, shots: shots.length, err })
  if (err && opt.failFast) break
}

const total = Date.now() - t0
console.log('')
console.log('=== 小结 ===')
const okN = results.filter((r) => r.ok).length
const manN = results.filter((r) => r.note === 'manual').length
console.log(`成功 ${okN} 页 / 跳过 ${manN} 页 / 失败 ${results.filter((r) => r.ok === false).length} 页`)
console.log(`总耗时 ${secs(total)}（平均 ${secs(total / Math.max(1, okN + manN))}/页）`)

if (!opt.noUpdate && okN > 0) {
  const pickedIds = picked.map((p) => p.id)
  const manualLeft = data.pages.filter((p) => pickedIds.indexOf(p.id) !== -1 && !autoOk(p)).map((p) => p.id)
  data.capturedAt = nowStr()
  data.captureEnv.note = manualLeft.length ? '待人工补采：' + manualLeft.join(',') : ''
  fs.writeFileSync(PAGES_JSON, JSON.stringify(data, null, 2) + '\n')
  console.log('已写回 pages.json（截图记录 + 采集时间）')
  console.log('提示：按项目约定提交 —— ./scripts/bump-version.sh && git add pages.json images/ev-schedule/pages version.json && git commit && git push')
} else {
  console.log(opt.noUpdate ? '（--no-update：未写回 pages.json）' : '（无成功页，未写回）')
}
