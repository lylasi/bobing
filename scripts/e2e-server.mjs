/**
 * E2E 启动器：先用生产构建（Vite 前端 + tsc 后端）产出 dist / dist-server，
 * 再用独立数据目录启动真实单实例服务，供 Playwright 的 webServer 使用。
 *
 * 关键点：
 *  - 不使用任何测试专用作弊接口，跑的就是 `npm start` 会跑的那份产物；
 *  - 每次运行前清空 E2E 数据目录，保证房间码、凭证、奖池都从零开始；
 *  - 设置 PUBLIC_BASE_URL=http://localhost:<port>，因此分享链接必须由 /api/config 生效
 *    （页面 origin 是 127.0.0.1，链接 host 是 localhost，两者都能访问同一实例）。
 */

import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const port = process.env.E2E_PORT ?? '3210';
const dataDir = resolve('.e2e-data');
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

rmSync(dataDir, { recursive: true, force: true });

const build = spawnSync(npmCmd, ['run', 'build'], { stdio: 'inherit', env: process.env });
if (build.status !== 0) {
  console.error('[e2e] 生产构建失败，无法启动 E2E 服务');
  process.exit(build.status ?? 1);
}

const child = spawn(process.execPath, ['dist-server/server/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: port,
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    PUBLIC_BASE_URL: `http://localhost:${port}`,
    TRUST_PROXY: '0',
  },
});

child.on('exit', (code, signal) => {
  console.log(`[e2e] 服务退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`);
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
