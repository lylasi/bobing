/**
 * 开发启动器：一条 `npm run dev` 同时起 Vite（5173）与后端（3001）。
 *
 * 不引入额外依赖：用 child_process 起两个进程，统一前缀输出，
 * 任意一个退出或收到 Ctrl-C 时一起收尾，避免留下孤儿进程。
 */

import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const tasks = [
  { name: 'web', color: '\u001b[36m', args: ['run', 'dev:web'] },
  { name: 'api', color: '\u001b[35m', args: ['run', 'dev:server'] },
];

const reset = '\u001b[0m';
const children = [];
let shuttingDown = false;

function prefixStream(stream, name, color) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      process.stdout.write(`${color}[${name}]${reset} ${line}\n`);
    }
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(isWindows ? undefined : 'SIGTERM');
    }
  }
  setTimeout(() => process.exit(code), 200).unref?.();
}

for (const task of tasks) {
  const child = spawn(npmCmd, task.args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  children.push(child);
  prefixStream(child.stdout, task.name, task.color);
  prefixStream(child.stderr, task.name, task.color);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.log(`${task.color}[${task.name}]${reset} 已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}），正在停止另一个进程…`);
      shutdown(code ?? 0);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] 前端 http://localhost:5173 ，后端 http://localhost:3001 （/api 与 /socket.io 由 Vite 代理）');
