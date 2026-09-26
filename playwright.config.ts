import { defineConfig, devices } from '@playwright/test';

const PORT = Number.parseInt(process.env.E2E_PORT ?? '3210', 10);
/** 指向一个已经在运行的真实部署（例如容器）：E2E_BASE_URL=http://127.0.0.1:3401 npm run test:e2e */
const EXTERNAL_BASE_URL = process.env.E2E_BASE_URL;

/**
 * Playwright 配置：
 *  - 默认自己拉起单进程真实服务（生产构建产物）+ 独立 SQLite 数据目录；
 *  - 设置 E2E_BASE_URL 时不启动本地服务，直接对已有部署跑用例；
 *  - 串行执行，避免多个用例互相抢限流额度与房间码；
 *  - 失败保留 trace 与截图，成功的截图由用例写入 docs/screenshots。
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: EXTERNAL_BASE_URL ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: EXTERNAL_BASE_URL
    ? undefined
    : {
        command: 'node scripts/e2e-server.mjs',
        url: `http://127.0.0.1:${PORT}/api/health`,
        timeout: 240_000,
        reuseExistingServer: false,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
