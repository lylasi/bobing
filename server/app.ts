/**
 * HTTP 路由与输入校验。
 *
 * 所有写接口只接受 `application/json`，body 上限 16KiB，并显式验证对象类型与字段。
 * 错误统一为 `{error:{code,message}}`，状态码来自 shared/types 的 ERROR_HTTP_STATUS。
 * 处理函数保持同步：状态读取、校验、更新与 SQLite 事务之间不 await，
 * 因此单进程内并发请求不会交错修改同一个 turnId。
 */

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { ERROR_MESSAGES } from '../shared/types.js';
import type { Action, ErrorCode, LobbyQuery, RoomAccess, RoomConfig, RoomPacing } from '../shared/types.js';
import { RoomService, ServiceError, isUuid } from './room-service.js';

export const MAX_BODY_BYTES = 16 * 1024;

/** 大厅分页默认值与上限。 */
export const LOBBY_DEFAULT_LIMIT = 20;
export const LOBBY_MAX_LIMIT = 50;
const LOBBY_FILTERS = ['joinable', 'all', 'playing'] as const;

export interface AppOptions {
  /** 生产环境下 Express 提供构建后的静态文件与 SPA 回退；测试不传。 */
  staticDir?: string | null;
  /** 前置反向代理时按 X-Forwarded-For 取客户端 IP。 */
  trustProxy?: boolean;
  /** 运行时公开分享地址（无凭证）；未配置为 null，前端回退到当前 origin。 */
  publicBaseUrl?: string | null;
}

export interface ConfigResponse {
  publicBaseUrl: string | null;
}

/**
 * 校验 `PUBLIC_BASE_URL`：只允许 http(s)、不含用户名/密码、查询串与片段。
 * 目的是让运行时配置与构建时配置不混淆：非法值直接退化为 null（前端用当前 origin），
 * 而不是生成一个看起来可用却指向错误主机的邀请链接。
 */
export function normalizePublicBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof ServiceError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  console.error('[bobing] 未预期的服务端错误', error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: ERROR_MESSAGES.INTERNAL_ERROR } });
}

function fail(code: ErrorCode, message?: string): never {
  throw new ServiceError(code, message);
}

/** 只接受 JSON 对象；数组、字符串、null 都按输入错误处理。 */
function requireObjectBody(req: Request): Record<string, unknown> {
  if (!req.is('application/json')) fail('INVALID_INPUT', '请求必须使用 application/json');
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail('INVALID_INPUT', '请求体必须是 JSON 对象');
  }
  return body as Record<string, unknown>;
}

function bearerToken(req: Request): string {
  const header = req.get('authorization');
  if (!header) fail('INVALID_TOKEN');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) fail('INVALID_TOKEN');
  return match[1];
}

/**
 * 解析并校验 Action。未知字段（例如客户端擅自提交的 dice、points）一律忽略，
 * 服务端永远不会读取客户端的骰子点数。
 * `update-config` 只在这里做形状检查，完整配置校验由服务层的 normalizeRoomConfig 完成
 * （非法值统一映射为 INVALID_INPUT）。
 */
export function parseAction(body: Record<string, unknown>): Action {
  const type = body.type;
  switch (type) {
    case 'ready': {
      if (typeof body.ready !== 'boolean') fail('INVALID_INPUT', 'ready 必须是布尔值');
      return { type: 'ready', ready: body.ready };
    }
    case 'start':
      return { type: 'start' };
    case 'roll': {
      if (!isUuid(body.requestId)) fail('INVALID_INPUT', 'requestId 必须是 UUID');
      if (!isUuid(body.expectedTurnId)) fail('INVALID_INPUT', 'expectedTurnId 必须是 UUID');
      return { type: 'roll', requestId: body.requestId, expectedTurnId: body.expectedTurnId };
    }
    case 'leave':
      return { type: 'leave' };
    case 'end':
      return { type: 'end' };
    case 'rematch':
      return { type: 'rematch' };
    case 'update-config': {
      const config = body.config;
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        fail('INVALID_INPUT', 'config 必须是房间配置对象');
      }
      return { type: 'update-config', config: config as RoomConfig };
    }
    case 'update-pacing': {
      // 完整校验交给 shared/presentation.normalizeRoomPacing（省略与非法显式配置分开处理）
      if (typeof body.pacing !== 'object' || body.pacing === null || Array.isArray(body.pacing)) {
        fail('INVALID_INPUT', 'pacing 必须是房间节奏对象');
      }
      return { type: 'update-pacing', pacing: body.pacing as RoomPacing };
    }
    case 'update-access': {
      if (typeof body.access !== 'object' || body.access === null || Array.isArray(body.access)) {
        fail('INVALID_INPUT', 'access 必须是房间访问设置对象');
      }
      return { type: 'update-access', access: body.access as RoomAccess };
    }
    default:
      fail('INVALID_INPUT', '未知的操作类型');
  }
}

/**
 * 解析大厅查询参数：filter 默认 joinable，limit 默认 20（1–50），cursor 默认 null。
 * 除空字符串以外的非法 cursor（非 base64url、字段不合法）由服务层按 INVALID_INPUT 拒绝。
 */
export function parseLobbyQuery(query: Request['query']): LobbyQuery {
  const rawFilter = query.filter;
  const rawLimit = query.limit;
  const rawCursor = query.cursor;

  let filter: LobbyQuery['filter'] = 'joinable';
  if (rawFilter !== undefined) {
    if (typeof rawFilter !== 'string' || !(LOBBY_FILTERS as readonly string[]).includes(rawFilter)) {
      fail('INVALID_INPUT', 'filter 只能是 joinable、all 或 playing');
    }
    filter = rawFilter as LobbyQuery['filter'];
  }

  let limit = LOBBY_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^[0-9]+$/.test(rawLimit)) {
      fail('INVALID_INPUT', 'limit 必须是 1–50 的整数');
    }
    limit = Number.parseInt(rawLimit, 10);
    if (limit < 1 || limit > LOBBY_MAX_LIMIT) fail('INVALID_INPUT', 'limit 必须是 1–50 的整数');
  }

  let cursor: string | null = null;
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== 'string') fail('INVALID_INPUT', 'cursor 必须是字符串');
    cursor = rawCursor.length === 0 ? null : rawCursor;
  }

  return { filter, limit, cursor };
}

export function createApp(service: RoomService, options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', 1);

  app.use(
    express.json({
      limit: MAX_BODY_BYTES,
      type: ['application/json', 'application/*+json'],
    }),
  );

  const clientIp = (req: Request): string => req.ip ?? req.socket.remoteAddress ?? 'unknown';

  // 运行时公开配置：只返回分享用的对外地址，不含任何凭证或内部实现细节
  const publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);

  app.get('/api/health', (_req, res) => {
    const ok = service.health();
    res.status(ok ? 200 : 500).json(ok ? { ok: true } : { error: { code: 'INTERNAL_ERROR', message: '数据库不可用' } });
  });

  app.get('/api/config', (_req, res) => {
    const body: ConfigResponse = { publicBaseUrl };
    res.status(200).json(body);
  });

  app.post('/api/rooms', (req, res) => {
    try {
      const body = requireObjectBody(req);
      const created = service.create(
        {
          nickname: body.nickname,
          name: body.name,
          maxPlayers: body.maxPlayers,
          config: body.config,
          maxRounds: body.maxRounds,
          pacing: body.pacing,
          access: body.access,
        },
        clientIp(req),
      );
      res.status(201).json(created);
    } catch (error) {
      sendError(res, error);
    }
  });

  // 大厅列表：默认 filter=joinable、limit=20；只列公开、未过期、waiting／playing 的房间
  app.get('/api/rooms', (req, res) => {
    try {
      res.status(200).json(service.listLobby(parseLobbyQuery(req.query)));
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/rooms/:code', (req, res) => {
    try {
      res.status(200).json(service.preview(String(req.params.code ?? '')));
    } catch (error) {
      sendError(res, error);
    }
  });

  // 只读旁观入口：不需要成员凭证，不改变任何成员在线状态或到期时间
  app.get('/api/rooms/:code/watch', (req, res) => {
    try {
      res.status(200).json({ room: service.watch(String(req.params.code ?? '')) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/rooms/:code/join', (req, res) => {
    try {
      const body = requireObjectBody(req);
      const joined = service.join(String(req.params.code ?? ''), body.nickname, clientIp(req));
      res.status(201).json(joined);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/rooms/:code/state', (req, res) => {
    try {
      const state = service.state(String(req.params.code ?? ''), bearerToken(req));
      res.status(200).json(state);
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/rooms/:code/actions', (req, res) => {
    try {
      const body = requireObjectBody(req);
      const action = parseAction(body);
      res.status(200).json(service.action(String(req.params.code ?? ''), bearerToken(req), action));
    } catch (error) {
      sendError(res, error);
    }
  });

  // 未匹配的 /api 路径：按房间未找到处理，避免落到 SPA 回退
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'ROOM_NOT_FOUND', message: '接口不存在' } });
  });

  if (options.staticDir) {
    const staticDir = options.staticDir;
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    // SPA 回退：深链刷新不 404，但不接管 /api、socket.io，也不接管带扩展名的静态资源请求
    // （构建产物文件名带哈希，缺失时应给出干净的 404，而不是把 index.html 当成 JS/CSS 返回）
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
      const lastSegment = req.path.slice(req.path.lastIndexOf('/') + 1);
      if (lastSegment.includes('.')) {
        res.status(404).type('text/plain').send('Not Found');
        return;
      }
      res.sendFile('index.html', { root: staticDir }, (error) => {
        if (error) next(error);
      });
    });
  }

  // JSON 解析错误（含超过 16KiB）与兜底错误处理
  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof ServiceError) return sendError(res, error);
    const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500;
    if (status === 400 || status === 413) {
      return sendError(res, new ServiceError('INVALID_INPUT'));
    }
    sendError(res, error);
  });

  return app;
}
