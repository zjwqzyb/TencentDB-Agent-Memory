import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // 与 web/vite.config.ts 的 `@` → `web/src` 别名保持一致：
    // 直接 import 前端运行时模块的测试（不只 import type）需要同一套解析。
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup-browser-stubs.ts'],
  },
});
