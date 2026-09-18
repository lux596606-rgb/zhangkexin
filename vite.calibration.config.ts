/**
 * 手势自测校准页（calibration.html）的**独立构建配置**。
 *
 * 为什么单独一份而不是把 calibration.html 塞进主 vite.config.ts 的 rollupOptions.input：
 *   多入口会让 Rollup 把两个页面共用的模块（MediaPipe + gestureRecognition）抽成 shared chunk，
 *   于是**产品页的入口 chunk 改名、且多出一个 modulepreload 请求**。产品页必须一动不动，
 *   所以主配置保持单入口，校准页用这份配置单独构建。
 *
 * 用法：npm run build:calibration  →  dist-calibration/（校准页专用产物，可丢到任意静态目录）
 * 日常调试不需要它：dev server 直接访问 /calibration.html 即可（Vite 原生支持项目根目录下的多 HTML）。
 *
 * 校准页与产品页**不共享任何产物**：校准页的技术栈（React + TS + MediaPipe）与产品页相同，
 * 但代码路径完全独立 —— 产品页 bundle 里没有校准页的代码，反之亦然。
 *
 * publicDir: false —— 校准页要复用的是 dist/ 里那份自托管的 mediapipe 资源（部署时同一目录），
 * 这里不再复制一遍（wasm + 模型共约 20MB），只构建 HTML/JS/CSS。
 */
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  base: './',
  publicDir: false,
  build: {
    outDir: 'dist-calibration',
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL('./calibration.html', import.meta.url)),
    },
  },
})
