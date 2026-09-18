/**
 * 手势自测校准页的入口。与产品页（index.html → src/main.tsx）完全独立：
 * 只被 calibration.html 引用，产品页的 bundle 不会包含这里的任何代码。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CalibrationPage } from './CalibrationPage'
import './calibration.css'

const container = document.getElementById('calibration-root')
if (!container) throw new Error('缺少 #calibration-root 容器')

createRoot(container).render(
  <StrictMode>
    <CalibrationPage />
  </StrictMode>,
)
