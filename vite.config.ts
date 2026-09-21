import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  /**
   * 显式绑定 IPv4 回环。
   * Vite 默认 host 是 'localhost'，Node 会优先解析到 IPv6 的 ::1，只监听 ::1。
   * 本机（以及部分 Windows 环境）IPv6 回环不可用，于是 dev server 明明打印
   * "ready"，浏览器却连不上（连接超时 / 拒绝连接）。
   * 绑到 127.0.0.1 后 http://127.0.0.1:5173/ 可正常访问；
   * 命令行仍可覆盖：npm run dev -- --host 0.0.0.0（局域网共享时用）。
   */
  server: {
    host: '127.0.0.1',
  },
  /**
   * 相对路径产出：JS/CSS/字体/MediaPipe 资源全部以文档 URL 为基准解析，
   * 因此网站放在域名根路径（https://域名/）或任意子路径（https://域名/kexin/）
   * 都能正常加载，不需要知道最终部署位置。
   * 注意：dev server 下 Vite 会把相对 base 归一成 '/'，行为与改动前一致。
   */
  base: './',
})
