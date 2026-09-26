import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Playwright 端到端用例由 npm run test:e2e 运行，不能被 Vitest 收走
    exclude: ['node_modules/**', 'dist/**', 'dist-server/**', 'tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 服务端测试使用真实 SQLite 文件与真实 HTTP/Socket 端口，串行更稳定
    fileParallelism: false,
  },
});
