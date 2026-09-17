/**
 * 把本地 SVG 渲染成 PNG 截图（用本机 Chrome --headless=new --screenshot，不需要 CDP）。
 * 运行：node tools/svg2png.mjs <输入.svg> <输出.png> [宽 高]
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const [input, output, width = '648', height = '532'] = process.argv.slice(2)
if (!input || !output) {
  console.error('用法: node tools/svg2png.mjs <输入.svg> <输出.png> [宽 高]')
  process.exit(1)
}
if (!existsSync(input)) {
  console.error(`找不到文件: ${input}`)
  process.exit(1)
}

const userDataDir = `${process.env.TEMP}\\dsh-svg2png`
rmSync(userDataDir, { recursive: true, force: true })

const child = spawn(
  CHROME,
  [
    '--headless=new',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    `--window-size=${width},${height}`,
    `--screenshot=${output}`,
    pathToFileURL(input).href,
  ],
  { stdio: 'ignore' },
)

child.on('exit', (code) => {
  console.log(code === 0 && existsSync(output) ? `已生成 ${output}` : `渲染失败，退出码 ${code}`)
  process.exitCode = code === 0 ? 0 : 1
})
