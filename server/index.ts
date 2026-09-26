/**
 * 服务入口：Express + Socket.IO + SQLite 单进程实例的生命周期。
 *
 * 生产环境由 Express 提供 vite 构建后的静态文件与 SPA 回退，
 * 监听 0.0.0.0 便于同一局域网访问；第一版只允许单实例（SQLite 数据目录必须挂载）。
 */

import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Express } from 'express';
import { AppDatabase } from './db.js';
import { createApp, normalizePublicBaseUrl } from './app.js';
import { RoomService } from './room-service.js';
import type { RateLimitOptions } from './room-service.js';
import { attachRealtime } from './realtime.js';
import type { RealtimeHub } from './realtime.js';
import { startClock } from './clock.js';
import type { Clock } from './clock.js';

export interface ServerInstanceOptions {
  dataDir: string;
  port?: number;
  host?: string;
  staticDir?: string | null;
  trustProxy?: boolean;
  /** 运行时分享地址，来自 PUBLIC_BASE_URL；非法或未设置时为 null。 */
  publicBaseUrl?: string | null;
  now?: () => number;
  rollDice?: () => number[];
  pickStartSeat?: (playerCount: number) => number;
  turnDurationMs?: number;
  hostTransferMs?: number;
  roomTtlMs?: number;
  rateLimits?: Partial<RateLimitOptions>;
  /** 仅供测试注入确定性房码，不通过 HTTP/Socket 暴露。 */
  createRoomCode?: () => string;
  /** 传 null 关闭自动时钟（测试用注入时钟推进）。 */
  clockIntervalMs?: number | null;
  quiet?: boolean;
}

export interface ServerInstance {
  app: Express;
  httpServer: HttpServer;
  hub: RealtimeHub;
  service: RoomService;
  db: AppDatabase;
  port: number;
  close(): Promise<void>;
}

export async function createServerInstance(options: ServerInstanceOptions): Promise<ServerInstance> {
  const dataDir = resolve(options.dataDir);
  const dbFile = resolve(dataDir, 'bobing.sqlite');
  const db = new AppDatabase(dbFile);

  const service = new RoomService({
    db,
    ...(options.now ? { now: options.now } : {}),
    ...(options.rollDice ? { rollDice: options.rollDice } : {}),
    ...(options.pickStartSeat ? { pickStartSeat: options.pickStartSeat } : {}),
    ...(options.turnDurationMs !== undefined ? { turnDurationMs: options.turnDurationMs } : {}),
    ...(options.hostTransferMs !== undefined ? { hostTransferMs: options.hostTransferMs } : {}),
    ...(options.roomTtlMs !== undefined ? { roomTtlMs: options.roomTtlMs } : {}),
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
    ...(options.createRoomCode ? { createRoomCode: options.createRoomCode } : {}),
  });

  // 重启恢复：所有连接先置离线，进行中的对局先暂停，避免立刻判超时
  service.onBoot();

  const staticDir = options.staticDir === undefined ? resolve('dist') : options.staticDir;
  const app = createApp(service, {
    staticDir: staticDir && existsSync(staticDir) ? staticDir : null,
    trustProxy: options.trustProxy ?? false,
    publicBaseUrl: options.publicBaseUrl ?? null,
  });

  const httpServer = createServer(app);
  const hub = attachRealtime(httpServer, service);
  service.setBroadcaster((room) => hub.broadcast(room));
  service.setPurgeHandler((code) => hub.disconnectRoom(code));

  const clock: Clock | null =
    options.clockIntervalMs === null ? null : startClock(service, options.clockIntervalMs ?? 1000);

  const port = options.port ?? 0;
  const host = options.host ?? '0.0.0.0';
  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolvePromise());
  });
  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  let closed = false;

  if (!options.quiet) {
    console.log(`[bobing] 服务已启动 http://localhost:${actualPort}（数据目录 ${dataDir}）`);
  }

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clock?.stop();
    await hub.close();
    if (httpServer.listening) {
      await new Promise<void>((resolvePromise) => httpServer.close(() => resolvePromise()));
    }
    db.close();
  };

  return { app, httpServer, hub, service, db, port: actualPort, close };
}

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '3001', 10);
  const dataDir = process.env.DATA_DIR ?? './data';
  const trustProxy = process.env.TRUST_PROXY === '1';
  const rawPublicBaseUrl = process.env.PUBLIC_BASE_URL ?? '';
  const publicBaseUrl = normalizePublicBaseUrl(rawPublicBaseUrl);
  if (rawPublicBaseUrl.trim().length > 0 && publicBaseUrl === null) {
    console.warn('[bobing] PUBLIC_BASE_URL 不是合法的 http(s) 地址（不得含用户名、密码、查询串或片段），已忽略，分享链接将使用访问者当前地址。');
  }

  const instance = await createServerInstance({
    dataDir,
    port: Number.isFinite(port) ? port : 3001,
    host: '0.0.0.0',
    trustProxy,
    publicBaseUrl,
  });

  if (publicBaseUrl) console.log(`[bobing] 分享地址：${publicBaseUrl}`);

  const shutdown = (signal: string): void => {
    console.log(`[bobing] 收到 ${signal}，正在关闭…`);
    void instance.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error('[bobing] 启动失败', error);
    process.exit(1);
  });
}
