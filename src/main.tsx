/**
 * 前端入口。样式为单文件 Pi 设计规范（src/styles.css），不远程加载任何字体或图片。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少 #root 容器');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
