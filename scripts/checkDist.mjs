/**
 * 上线前产物完整性检查（任务 6）。
 * 运行：npm run check:dist   （等价于 node scripts/checkDist.mjs）
 *
 * 只读 dist/，不修改任何文件。退出码非 0 表示有阻断上线的项。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`)
}
const warn = (name, detail) => console.log(`WARN | ${name} | ${detail}`)

if (!existsSync(DIST)) {
  console.error('dist/ 不存在，请先执行 npm run build')
  process.exit(1)
}

/** 递归列文件（相对 dist 的 POSIX 风格路径 + 字节数）。 */
const walk = (dir) => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push({ path: relative(DIST, full).split('\\').join('/'), size: statSync(full).size })
  }
  return out
}

const files = walk(DIST)
const bytes = files.reduce((sum, file) => sum + file.size, 0)
console.log(`dist/ 共 ${files.length} 个文件，${(bytes / 1024 / 1024).toFixed(2)} MB\n`)

// 1. 必需文件（少一个就白屏或手势不可用）
const required = [
  'index.html',
  'mediapipe/gesture_recognizer.task',
  'mediapipe/LICENSE.txt',
  'mediapipe/wasm/vision_wasm_internal.js',
  'mediapipe/wasm/vision_wasm_internal.wasm',
]
for (const path of required) {
  const found = files.find((file) => file.path === path)
  check(`必需文件存在: ${path}`, Boolean(found), found ? `${(found.size / 1024).toFixed(1)} KB` : '缺失')
}

// 2. 已删除的 wasm 变体不应再出现在产物里（体积回归护栏）
const deadVariants = ['vision_wasm_module_internal', 'vision_wasm_nosimd_internal']
for (const variant of deadVariants) {
  const strays = files.filter((file) => file.path.includes(variant))
  check(
    `已裁剪的 wasm 变体未回流: ${variant}`,
    strays.length === 0,
    strays.length === 0 ? '无' : strays.map((file) => file.path).join(', '),
  )
}

// 3. index.html 必须用相对路径引用产物，否则子路径部署会 404 / 白屏
const html = readFileSync(join(DIST, 'index.html'), 'utf8')
const absoluteRefs = [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((match) => match[1]).filter((url) => !url.startsWith('//'))
check('index.html 未使用根绝对路径引用资源', absoluteRefs.length === 0, absoluteRefs.join(', ') || '无（子路径安全）')
check('index.html 引用了打包后的入口 JS', /src="\.\/assets\/[^"]+\.js"/.test(html), (html.match(/src="([^"]+\.js)"/) ?? [])[1] ?? '未找到')

// 4. 不能有任何外网依赖（字体/CDN）；本地字体必须已自托管
const textFiles = files.filter((file) => /\.(html|css|js|json|svg)$/.test(file.path))
const externalHits = []
for (const file of textFiles) {
  const content = readFileSync(join(DIST, file.path), 'utf8')
  for (const needle of ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com']) {
    if (content.includes(needle)) externalHits.push(`${file.path} → ${needle}`)
  }
}
check('产物内无外网字体 / CDN 引用', externalHits.length === 0, externalHits.join(', ') || '无')

const fonts = files.filter((file) => file.path.endsWith('.woff2'))
check('字体已自托管进 assets/', fonts.length >= 2, fonts.map((file) => file.path).join(', ') || '未找到 woff2')

// 5. 体积提示（仅参考，不阻断）
const heavy = [...files].sort((a, b) => b.size - a.size).slice(0, 5)
console.log('\n最大的 5 个文件（部署上传时间主要看它们）:')
for (const file of heavy) console.log(`  ${(file.size / 1024 / 1024).toFixed(2)} MB  ${file.path}`)

const failed = results.filter((item) => !item.ok)
console.log(`\n===== 产物检查: ${results.length - failed.length}/${results.length} 通过 =====`)
if (failed.length > 0) {
  console.log('失败项:')
  for (const item of failed) console.log(` - ${item.name}: ${item.detail}`)
  process.exitCode = 1
} else {
  warn('下一步', '把 dist/ 里的「内容」上传到网站根目录或子目录，HTTPS 配置见 DEPLOY.md')
}
