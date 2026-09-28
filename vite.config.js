// vite.config.js — Vite 5 构建配置
// 说明：`export default defineConfig(...)` 是 vite 工具链对配置文件的固定约定，
// 与 Vue SFC 的框架默认导出机制同类，不属于 AGENTS.md 禁止的业务代码默认导出。
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      // win32 安全：用 fileURLToPath(new URL(...)) 而非 path.join 拼相对路径
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  css: {
    preprocessorOptions: {
      // 用 sass modern API（legacy JS API 将在 Dart Sass 2.0 移除）；
      // 刻意不配 additionalData：组件在 scoped style 内按需相对路径 @use 变量文件，
      // 避免与 index.scss 的显式 @use 重复加载模块。
      scss: { api: 'modern' },
    },
  },
});
