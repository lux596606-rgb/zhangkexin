import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  /**
   * 相对路径产出：JS/CSS/字体/MediaPipe 资源全部以文档 URL 为基准解析，
   * 因此网站放在域名根路径（https://域名/）或任意子路径（https://域名/kexin/）
   * 都能正常加载，不需要知道最终部署位置。
   * 注意：dev server 下 Vite 会把相对 base 归一成 '/'，行为与改动前一致。
   */
  base: './',
})
