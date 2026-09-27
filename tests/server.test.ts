import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connectClient } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { createServerInstance } from '../server/index.js';
import type { ServerInstance } from '../server/index.js';
import { RoomService, hashToken } from '../server/room-service.js';
import type { RateLimitOptions } from '../server/room-service.js';
import { AppDatabase } from '../server/db.js';
import { createDefaultRoomConfig } from '../shared/room-config.js';
import { PRIZE_KEYS } from '../shared/rules.js';
import { DEFAULT_RESULT_HOLD_SECONDS, DICE_REVEAL_MS } from '../shared/presentation.js';
import { createDefaultRoomAccess } from '../shared/room-access.js';
import {
  SOCKET_EVENT_AUDIENCE,
  SOCKET_EVENT_ROOM_STATE,
  SOCKET_EVENT_WATCH_ENDED,
} from '../shared/types.js';
import type { AudienceState, LobbyRoomSummary, Membership, RoomConfig, RoomState, WatchEnded } from '../shared/types.js';

const NONE = [1, 1, 2, 2, 3, 3];
const YIXIU = [4, 1, 2, 3, 5, 5];
const ERJU = [4, 4, 1, 2, 3, 5];
const SIJIN = [2, 2, 2, 2, 4, 4];
const DUITANG = [1, 2, 3, 4, 5, 6];
const SANHONG = [4, 4, 4, 2, 2, 2];
const WUHONG = [4, 4, 4, 4, 4, 6];
const TURN_MS = 30_000;
const DAY_MS = 24 * 3600 * 1000;

interface ClockBox {
  now: number;
}

interface ApiResult {
  status: number;
  body: any;
}

interface TestEnv {
  instance: ServerInstance;
  base: string;
  dataDir: string;
  clock: ClockBox;
  dice: number[][];
  api: (method: string, path: string, options?: { body?: unknown; token?: string; rawBody?: string; contentType?: string }) => Promise<ApiResult>;
  roomState: (code: string, token: string) => Promise<RoomState>;
  close: () => Promise<void>;
}

interface StateLog {
  all: RoomState[];
  mark: () => number;
  wait: (predicate: (room: RoomState) => boolean, options?: { after?: number; timeoutMs?: number }) => Promise<RoomState>;
}

const opened: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (opened.length > 0) {
    const dispose = opened.pop();
    if (dispose) await dispose();
  }
});

async function startServer(
  options: {
    dataDir?: string;
    clock?: ClockBox;
    dice?: number[][];
    rateLimits?: Partial<RateLimitOptions>;
    pickStartSeat?: (playerCount: number) => number;
    createRoomCode?: () => string;
  } = {},
): Promise<TestEnv> {
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'bobing-test-'));
  const clock = options.clock ?? { now: 1_800_000_000_000 };
  const dice = options.dice ?? [];
  const instance = await createServerInstance({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    staticDir: null,
    clockIntervalMs: null,
    quiet: true,
    now: () => clock.now,
    rollDice: () => (dice.length > 0 ? dice.shift()! : [...NONE]),
    pickStartSeat: options.pickStartSeat ?? (() => 0),
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
    ...(options.createRoomCode ? { createRoomCode: options.createRoomCode } : {}),
  });

  const base = `http://127.0.0.1:${instance.port}`;
  const sockets: Socket[] = [];

  const api = async (
    method: string,
    path: string,
    requestOptions: { body?: unknown; token?: string; rawBody?: string; contentType?: string } = {},
  ): Promise<ApiResult> => {
    const headers: Record<string, string> = {};
    let payload: string | undefined;
    if (requestOptions.rawBody !== undefined) {
      payload = requestOptions.rawBody;
      headers['Content-Type'] = requestOptions.contentType ?? 'application/json';
    } else if (requestOptions.body !== undefined) {
      payload = JSON.stringify(requestOptions.body);
      headers['Content-Type'] = requestOptions.contentType ?? 'application/json';
    }
    if (requestOptions.token) headers.Authorization = `Bearer ${requestOptions.token}`;
    const response = await fetch(`${base}${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };

  const env: TestEnv = {
    instance,
    base,
    dataDir,
    clock,
    dice,
    api,
    roomState: async (code: string, token: string) => {
      const result = await api('GET', `/api/rooms/${code}/state`, { token });
      expect(result.status).toBe(200);
      return result.body.room as RoomState;
    },
    close: async () => {
      for (const socket of sockets) socket.close();
      await instance.close();
    },
  };
  opened.push(env.close);
  (env as TestEnv & { sockets: Socket[] }).sockets = sockets;
  return env;
}

function trackSocket(env: TestEnv, socket: Socket): void {
  (env as TestEnv & { sockets: Socket[] }).sockets.push(socket);
}

function createStateLog(socket: Socket): StateLog {
  const all: RoomState[] = [];
  const waiters: Array<{ predicate: (room: RoomState) => boolean; after: number; resolve: (room: RoomState) => void; timer: NodeJS.Timeout }> = [];

  socket.on(SOCKET_EVENT_ROOM_STATE, (room: RoomState) => {
    all.push(room);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (all.length - 1 >= waiter.after && waiter.predicate(room)) {
        clearTimeout(waiter.timer);
        waiters.splice(i, 1);
        waiter.resolve(room);
      }
    }
  });

  return {
    all,
    mark: () => all.length,
    wait: (predicate, options = {}) => {
      const after = options.after ?? 0;
      const timeoutMs = options.timeoutMs ?? 4000;
      for (let i = after; i < all.length; i++) {
        const candidate = all[i];
        if (candidate && predicate(candidate)) return Promise.resolve(candidate);
      }
      return new Promise<RoomState>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`等待 room:state 超时（收到 ${all.length} 条，最后 revision=${all[all.length - 1]?.revision ?? '-'}）`));
        }, timeoutMs);
        waiters.push({ predicate, after, resolve, timer });
      });
    },
  };
}

async function connectSocket(env: TestEnv, auth: Record<string, unknown>): Promise<{ socket: Socket; log: StateLog }> {
  const socket = connectClient(env.base, {
    auth,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: 4000,
  });
  trackSocket(env, socket);
  const log = createStateLog(socket);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket 连接超时')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { socket, log };
}

async function connectFailure(env: TestEnv, auth: Record<string, unknown>): Promise<{ message: string; data?: { code?: string; message?: string } }> {
  const socket = connectClient(env.base, { auth, transports: ['websocket'], reconnection: false, forceNew: true, timeout: 4000 });
  trackSocket(env, socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('既没有连接成功也没有 connect_error')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      reject(new Error('预期连接失败，但连接成功了'));
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      resolve(error as unknown as { message: string; data?: { code?: string } });
    });
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function createRoom(
  env: TestEnv,
  overrides: {
    nickname?: string;
    name?: string;
    maxPlayers?: number;
    maxRounds?: number;
    config?: RoomConfig;
    pacing?: unknown;
    access?: unknown;
  } = {},
): Promise<{ notification?: never; code: string; membership: Membership; room: RoomState }> {
  const body: Record<string, unknown> = {
    nickname: overrides.nickname ?? '阿月',
    name: overrides.name ?? '中秋团圆局',
    maxPlayers: overrides.maxPlayers ?? 2,
  };
  // 新客户端发送 config；未指定时沿用旧 maxRounds 请求（服务端显式映射为固定轮数）
  if (overrides.config !== undefined) body.config = overrides.config;
  else body.maxRounds = overrides.maxRounds ?? 5;
  if (overrides.pacing !== undefined) body.pacing = overrides.pacing;
  if (overrides.access !== undefined) body.access = overrides.access;
  const result = await env.api('POST', '/api/rooms', { body });
  expect(result.status).toBe(201);
  return { code: result.body.room.code, membership: result.body.membership, room: result.body.room };
}

async function updateConfig(env: TestEnv, code: string, token: string, config: unknown): Promise<ApiResult> {
  return env.api('POST', `/api/rooms/${code}/actions`, { body: { type: 'update-config', config }, token });
}

async function joinRoom(env: TestEnv, code: string, nickname: string): Promise<{ membership: Membership; room: RoomState }> {
  const result = await env.api('POST', `/api/rooms/${code}/join`, { body: { nickname } });
  expect(result.status).toBe(201);
  return { membership: result.body.membership, room: result.body.room };
}

/** 用服务端真实在线路径标记成员在线（与 Socket 层同一方法），开启一局 2 人游戏。 */
async function startTwoPlayerGame(
  env: TestEnv,
  overrides: { maxPlayers?: number; maxRounds?: number; config?: RoomConfig } = {},
): Promise<{ code: string; host: Membership; guest: Membership; room: RoomState }> {
  const created = await createRoom(env, {
    maxPlayers: overrides.maxPlayers ?? 2,
    ...(overrides.config ? { config: overrides.config } : { maxRounds: overrides.maxRounds ?? 5 }),
  });
  const joined = await joinRoom(env, created.code, '阿桂');
  env.instance.service.connectMember(created.code, created.membership.token);
  env.instance.service.connectMember(created.code, joined.membership.token);
  const ready = await env.api('POST', `/api/rooms/${created.code}/actions`, {
    body: { type: 'ready', ready: true },
    token: joined.membership.token,
  });
  expect(ready.status).toBe(200);
  const started = await env.api('POST', `/api/rooms/${created.code}/actions`, {
    body: { type: 'start' },
    token: created.membership.token,
  });
  expect(started.status).toBe(200);
  return { code: created.code, host: created.membership, guest: joined.membership, room: started.body.room };
}

/** 用真实 Socket 保持在线状态，避免测试预热 connectMember 造成的引用计数残留。 */
async function startTwoPlayerGameWithSockets(
  env: TestEnv,
  overrides: { maxPlayers?: number; maxRounds?: number; config?: RoomConfig } = {},
): Promise<{ code: string; host: Membership; guest: Membership; room: RoomState; hostSocket: { socket: Socket; log: StateLog }; guestSocket: { socket: Socket; log: StateLog } }> {
  const created = await createRoom(env, {
    maxPlayers: overrides.maxPlayers ?? 2,
    ...(overrides.config ? { config: overrides.config } : { maxRounds: overrides.maxRounds ?? 5 }),
  });
  const joined = await joinRoom(env, created.code, '阿桂');
  const hostSocket = await connectSocket(env, { roomCode: created.code, token: created.membership.token });
  const guestSocket = await connectSocket(env, { roomCode: created.code, token: joined.membership.token });
  await hostSocket.log.wait((room) => room.players.length === 2 && room.players.every((player) => player.online));

  const ready = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'ready', ready: true }, token: joined.membership.token });
  expect(ready.status).toBe(200);
  const started = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'start' }, token: created.membership.token });
  expect(started.status).toBe(200);
  return {
    code: created.code,
    host: created.membership,
    guest: joined.membership,
    room: started.body.room as RoomState,
    hostSocket,
    guestSocket,
  };
}

/** 等待室：房主 + 一位已在线并准备好的客人（人数与准备满足开局条件）。 */
async function waitingRoomWithReadyGuest(
  env: TestEnv,
  options: { maxPlayers?: number; config?: RoomConfig } = {},
): Promise<{ code: string; host: Membership; guest: Membership; room: RoomState }> {
  const created = await createRoom(env, {
    maxPlayers: options.maxPlayers ?? 4,
    ...(options.config ? { config: options.config } : {}),
  });
  const joined = await joinRoom(env, created.code, '阿桂');
  env.instance.service.connectMember(created.code, created.membership.token);
  env.instance.service.connectMember(created.code, joined.membership.token);
  const ready = await env.api('POST', `/api/rooms/${created.code}/actions`, {
    body: { type: 'ready', ready: true },
    token: joined.membership.token,
  });
  expect(ready.status).toBe(200);
  return { code: created.code, host: created.membership, guest: joined.membership, room: ready.body.room as RoomState };
}

async function rollOnce(env: TestEnv, code: string, token: string, expectedTurnId: string): Promise<ApiResult> {
  return env.api('POST', `/api/rooms/${code}/actions`, {
    body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId },
    token,
  });
}

/**
 * 读完当前结果展示：把时钟推到展示结束时刻再走真实服务端 tick，
 * 而不是绕过展示阶段直接推进回合。展示结束会结算最后一掷或轮到下一位。
 */
async function readThroughPresentation(env: TestEnv, code: string, token: string): Promise<RoomState> {
  const room = await env.roomState(code, token);
  if (!room.presentation) return room;
  const until = room.presentation.until;
  expect(until, '未暂停的房间必须给出展示结束时刻').not.toBeNull();
  env.clock.now = until as number;
  env.instance.service.tick(env.clock.now);
  return env.roomState(code, token);
}

/** 掷骰并读完结果展示，返回展示结束后的权威快照。 */
async function rollThrough(env: TestEnv, code: string, token: string, expectedTurnId: string): Promise<RoomState> {
  const rolled = await rollOnce(env, code, token, expectedTurnId);
  expect(rolled.status).toBe(200);
  return readThroughPresentation(env, code, token);
}

/** 观众连接（不需要成员凭证）：viewerId 只是浏览器自己生成的去重标识。 */
async function connectSpectator(
  env: TestEnv,
  roomCode: string,
  viewerId = crypto.randomUUID(),
): Promise<{ socket: Socket; log: StateLog; audience: AudienceState[]; ended: WatchEnded[]; viewerId: string }> {
  const audience: AudienceState[] = [];
  const ended: WatchEnded[] = [];
  const socket = connectClient(env.base, {
    auth: { role: 'spectator', roomCode, viewerId },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: 4000,
  });
  trackSocket(env, socket);
  const log = createStateLog(socket);
  socket.on(SOCKET_EVENT_AUDIENCE, (payload: AudienceState) => audience.push(payload));
  socket.on(SOCKET_EVENT_WATCH_ENDED, (payload: WatchEnded) => ended.push(payload));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('观众连接超时')), 5000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { socket, log, audience, ended, viewerId };
}

function assertNoSecrets(value: unknown, token: string): void {
  if (typeof value === 'string') {
    expect(value).not.toContain(token);
    expect(value.toLowerCase()).not.toContain('tokenhash');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecrets(item, token);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      expect(key.toLowerCase()).not.toContain('tokenhash');
      assertNoSecrets(item, token);
    }
  }
}

describe('健康检查与创建房间', () => {
  it('health 返回 ok', async () => {
    const env = await startServer();
    const result = await env.api('GET', '/api/health');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
  });

  it('创建返回 201、房主默认准备、6 位纯数字房码且新房默认公开并停留 1 秒', async () => {
    const env = await startServer();
    const created = await createRoom(env, { nickname: '阿月' });
    // 新房码是六位纯数字字符串，前导零必须保留（不能用 number 存储或展示）
    expect(created.code).toMatch(/^[0-9]{6}$/);
    expect(created.membership.token).toHaveLength(64); // 32 字节 token 的十六进制
    expect(created.membership.roomCode).toBe(created.code);
    expect(created.room.status).toBe('waiting');
    expect(created.room.hostId).toBe(created.membership.playerId);
    expect(created.room.players[0].ready).toBe(true);
    expect(created.room.players[0].online).toBe(false); // 建立 REST 连接不等于 Socket 在线
    expect(created.room.pool).toEqual({ zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 32 });
    expect(created.room.rulesVersion).toBe('unified-v1');
    expect(created.room.expiresAt! - created.room.createdAt).toBe(24 * 3600 * 1000);
    // 省略 pacing／access 时必须落到新房默认，而不是因为“缺字段”被拒绝
    expect(created.room.pacing).toEqual({ resultHoldSeconds: DEFAULT_RESULT_HOLD_SECONDS });
    expect(created.room.access).toEqual(createDefaultRoomAccess());
  });

  it('房码生成保留前导零，并沿用 50 次防碰撞重试与墓碑检查', async () => {
    // 生成器连续吐出同一个带前导零的码，第二次创建必须重试而不是覆盖已有房间
    const codes = ['028416', '028416', '000001'];
    const env = await startServer({ createRoomCode: () => codes.shift() ?? '999999' });
    const first = await createRoom(env, { nickname: '阿月' });
    expect(first.code).toBe('028416');
    const second = await createRoom(env, { nickname: '阿桂' });
    expect(second.code).toBe('000001');
    expect(first.code).not.toBe(second.code);

    const exhausted = await startServer({ createRoomCode: () => '028416' });
    await createRoom(exhausted, { nickname: '阿月' });
    const failed = await exhausted.api('POST', '/api/rooms', { body: { nickname: '阿桂', name: '中秋团圆局', maxPlayers: 2 } });
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('旧字符集房码仍可访问既有房间（L01 兼容）', async () => {
    const env = await startServer({ createRoomCode: () => 'ABC234' });
    const created = await createRoom(env, { nickname: '阿月' });
    expect(created.code).toBe('ABC234');
    // 旧码用文本输入，忽略空白并转大写
    const preview = await env.api('GET', `/api/rooms/%20${created.code.toLowerCase()}%20`);
    expect(preview.status).toBe(200);
    expect(preview.body.code).toBe(created.code);
    // 非法房码（长度不对或字符不在新旧字符集内）仍然拒绝
    for (const bad of ['12345', '1234567', 'ABCDE0', 'ABCDEI', 'AAAAA1']) {
      const result = await env.api('GET', `/api/rooms/${encodeURIComponent(bad)}`);
      expect(result.status, bad).toBe(400);
      expect(result.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('概况接口只暴露概况与配置，不含成员信息和凭证', async () => {
    const env = await startServer();
    const config = createDefaultRoomConfig();
    config.endCondition = { mode: 'rounds', maxRounds: 5 };
    const created = await createRoom(env, { config });
    const preview = await env.api('GET', `/api/rooms/${created.code}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({
      code: created.code,
      name: '中秋团圆局',
      playerCount: 1,
      maxPlayers: 2,
      config,
      // 节奏与访问设置与 config 分开，但都属于公开概况（持有房码者可见）
      pacing: { resultHoldSeconds: DEFAULT_RESULT_HOLD_SECONDS },
      access: createDefaultRoomAccess(),
      ruleset: created.room.ruleset,
      status: 'waiting',
      rulesVersion: 'unified-v1',
      canJoin: true,
      expiresAt: created.room.expiresAt,
    });
    expect(preview.body.maxRounds).toBeUndefined();
    assertNoSecrets(preview.body, created.membership.token);
  });

  it('房码忽略首尾空格并转大写', async () => {
    const env = await startServer();
    const created = await createRoom(env, {});
    const preview = await env.api('GET', `/api/rooms/${created.code.toLowerCase()}%20`);
    expect(preview.status).toBe(200);
    expect(preview.body.code).toBe(created.code);
  });
});

describe('身份恢复与凭证安全', () => {
  it('用原 token 取回同一成员身份，快照不含凭证或哈希', async () => {
    const env = await startServer();
    const created = await createRoom(env, {});
    const state = await env.api('GET', `/api/rooms/${created.code}/state`, { token: created.membership.token });
    expect(state.status).toBe(200);
    expect(state.body.playerId).toBe(created.membership.playerId);
    assertNoSecrets(state.body.room, created.membership.token);
    assertNoSecrets(state.body, created.membership.token);
  });

  it('无 token、错误 token、其他房间 token 都返回 401 INVALID_TOKEN', async () => {
    const env = await startServer();
    const first = await createRoom(env, {});
    const second = await createRoom(env, { nickname: '阿桂' });

    const missing = await env.api('GET', `/api/rooms/${first.code}/state`);
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('INVALID_TOKEN');

    const wrong = await env.api('GET', `/api/rooms/${first.code}/state`, { token: 'a'.repeat(64) });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_TOKEN');

    const otherRoom = await env.api('GET', `/api/rooms/${first.code}/state`, { token: second.membership.token });
    expect(otherRoom.status).toBe(401);
    expect(otherRoom.body.error.code).toBe('INVALID_TOKEN');

    const malformedHeader = await env.api('GET', `/api/rooms/${first.code}/state`, { token: '' });
    expect(malformedHeader.status).toBe(401);
  });
});

describe('加入房间', () => {
  it('加入成功并可重复恢复到同一身份', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 4 });
    const joined = await joinRoom(env, created.code, '阿桂');
    expect(joined.room.players).toHaveLength(2);
    expect(joined.room.players[1].ready).toBe(false);
    expect(joined.membership.playerId).toBe(joined.room.players[1].id);

    const restored = await env.api('GET', `/api/rooms/${created.code}/state`, { token: joined.membership.token });
    expect(restored.body.playerId).toBe(joined.membership.playerId);
  });

  it('重复昵称、满房、已开始、不存在的房间分别返回对应错误码', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 3 });
    await joinRoom(env, created.code, '阿桂');

    // 房间未满时先判昵称重复
    const duplicated = await env.api('POST', `/api/rooms/${created.code}/join`, { body: { nickname: '阿桂' } });
    expect(duplicated.status).toBe(409);
    expect(duplicated.body.error.code).toBe('NICKNAME_TAKEN');

    const third = await env.api('POST', `/api/rooms/${created.code}/join`, { body: { nickname: '阿明' } });
    expect(third.status).toBe(201);

    const full = await env.api('POST', `/api/rooms/${created.code}/join`, { body: { nickname: '阿华' } });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('ROOM_FULL');

    const missing = await env.api('POST', '/api/rooms/ZZZZZZ/join', { body: { nickname: '阿明' } });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ROOM_NOT_FOUND');

    const badCode = await env.api('POST', '/api/rooms/ABC/join', { body: { nickname: '阿明' } });
    expect(badCode.status).toBe(400);
    expect(badCode.body.error.code).toBe('INVALID_INPUT');
  });

  it('开局后不能再加入', async () => {
    const env = await startServer({ dice: [[1, 1, 2, 2, 3, 3]] });
    const game = await startTwoPlayerGame(env);
    const late = await env.api('POST', `/api/rooms/${game.code}/join`, { body: { nickname: '迟到的阿明' } });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ROOM_STARTED');
  });
});

describe('开始与掷骰权限', () => {
  it('非房主不能开始；人数或准备不满足时返回 NOT_READY', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 3 });
    const joined = await joinRoom(env, created.code, '阿桂');

    const byGuest = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'start' }, token: joined.membership.token });
    expect(byGuest.status).toBe(403);
    expect(byGuest.body.error.code).toBe('HOST_ONLY');

    env.instance.service.connectMember(created.code, created.membership.token);
    env.instance.service.connectMember(created.code, joined.membership.token);
    const notReady = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'start' }, token: created.membership.token });
    expect(notReady.status).toBe(409);
    expect(notReady.body.error.code).toBe('NOT_READY');
  });

  it('离线成员未准备时不能开始，全员在线准备后 start 随机起始位', async () => {
    const env = await startServer({ pickStartSeat: (count) => count - 1 });
    const created = await createRoom(env, { maxPlayers: 2 });
    const joined = await joinRoom(env, created.code, '阿桂');

    env.instance.service.connectMember(created.code, created.membership.token);
    await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'ready', ready: true }, token: joined.membership.token });

    const offlineGuest = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'start' }, token: created.membership.token });
    expect(offlineGuest.status).toBe(409);
    expect(offlineGuest.body.error.code).toBe('NOT_READY');

    env.instance.service.connectMember(created.code, joined.membership.token);
    const started = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'start' }, token: created.membership.token });
    expect(started.status).toBe(200);
    expect(started.body.room.status).toBe('playing');
    expect(started.body.room.round).toBe(1);
    expect(started.body.room.turnPlayerId).toBe(joined.membership.playerId);
    expect(started.body.room.deadline).toBe(env.clock.now + TURN_MS);
  });

  it('不是当前玩家或回合已过期时不能掷骰', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const turnId = game.room.turnId!;

    const notYourTurn = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: turnId },
      token: game.guest.token,
    });
    expect(notYourTurn.status).toBe(403);
    expect(notYourTurn.body.error.code).toBe('NOT_YOUR_TURN');

    const stale = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: crypto.randomUUID() },
      token: game.host.token,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_TURN');

    const badRequestId = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: 'not-a-uuid', expectedTurnId: turnId },
      token: game.host.token,
    });
    expect(badRequestId.status).toBe(400);
    expect(badRequestId.body.error.code).toBe('INVALID_INPUT');

    const unknownAction = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'cheat', points: 6 }, token: game.host.token });
    expect(unknownAction.status).toBe(400);
    expect(unknownAction.body.error.code).toBe('INVALID_INPUT');
  });

  it('请求体里的 dice 字段不会决定骰子点数', async () => {
    // 客户端伪造六杯红；服务端随机源给出的是无奖组合 [2,2,3,3,5,5]
    const env = await startServer({ dice: [[2, 2, 3, 3, 5, 5]] });
    const game = await startTwoPlayerGame(env);
    const rolled = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId, dice: [6, 6, 6, 6, 6, 6], points: 6 },
      token: game.host.token,
    });
    expect(rolled.status).toBe(200);
    expect(rolled.body.room.history[0].dice).toEqual([2, 2, 3, 3, 5, 5]);
    expect(rolled.body.room.history[0].result.code).toBe('none');
    expect(rolled.body.room.pool.zhuangyuan).toBe(1);
  });
});

describe('幂等与并发掷骰', () => {
  it('同一 requestId 并发两次只产生一条记录且都返回成功', async () => {
    const env = await startServer({ dice: [[1, 2, 3, 4, 5, 6]] });
    const game = await startTwoPlayerGame(env);
    const turnId = game.room.turnId!;
    const payload = { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: turnId };

    const send = () => env.api('POST', `/api/rooms/${game.code}/actions`, { body: payload, token: game.host.token });
    const [first, second] = await Promise.all([send(), send()]);
    expect([first.status, second.status]).toEqual([200, 200]);

    const room = await env.roomState(game.code, game.host.token);
    expect(room.history.filter((record) => record.turnId === turnId)).toHaveLength(1);
    expect(room.history).toHaveLength(1);
    expect(room.history[0].awarded).toBe('duitang');
    expect(room.pool.duitang).toBe(1);
  });

  it('同回合不同 requestId 并发时只有一个成功，另一个 RESULT_SHOWING', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const turnId = game.room.turnId!;
    const send = (requestId: string) =>
      env.api('POST', `/api/rooms/${game.code}/actions`, {
        body: { type: 'roll', requestId, expectedTurnId: turnId },
        token: game.host.token,
      });
    const results = await Promise.all([send(crypto.randomUUID()), send(crypto.randomUUID())]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual([200, 409]);
    const failed = results.find((result) => result.status === 409)!;
    // 第一次投掷已经进入结果展示阶段：第二次不同 requestId 的投掷必须被展示阶段挡下
    expect(failed.body.error.code).toBe('RESULT_SHOWING');

    const room = await env.roomState(game.code, game.host.token);
    expect(room.history.filter((record) => record.turnId === turnId)).toHaveLength(1);
    expect(room.players.find((player) => player.id === game.host.playerId)?.rollCount).toBe(1);
  });

  it('旧 turnId 配新 requestId 不能偷下一回合', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const oldTurnId = game.room.turnId!;
    const firstRoll = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: oldTurnId },
      token: game.host.token,
    });
    expect(firstRoll.status).toBe(200);
    // 展示期间仍保留本次上下文（turnId／turnPlayerId），下一位要等展示结束才接手
    expect((firstRoll.body.room as RoomState).turnId).toBe(oldTurnId);
    expect((firstRoll.body.room as RoomState).presentation).not.toBeNull();
    await readThroughPresentation(env, game.code, game.host.token);
    const handedOver = await env.roomState(game.code, game.host.token);
    expect(handedOver.turnPlayerId).toBe(game.guest.playerId);

    const replay = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: oldTurnId },
      token: game.host.token,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('STALE_TURN');

    const room = await env.roomState(game.code, game.host.token);
    expect(room.history).toHaveLength(1);
    expect(room.turnPlayerId).toBe(game.guest.playerId);
  });

  it('重复请求返回已提交状态且不消耗下一次机会', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const payload = { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId! };
    const first = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: payload, token: game.host.token });
    expect(first.status).toBe(200);
    // 展示期间的重复 requestId 仍走幂等回执：不是 RESULT_SHOWING
    const replay = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: payload, token: game.host.token });
    expect(replay.status).toBe(200);
    expect(replay.body.room.history).toHaveLength(first.body.room.history.length);
    expect(replay.body.room.turnId).toBe(first.body.room.turnId);
    expect(replay.body.room.presentation).toEqual(first.body.room.presentation);

    // 展示读完后才轮到下一位，且这一手没有额外消耗第二次机会
    const after = await readThroughPresentation(env, game.code, game.host.token);
    expect(after.turnPlayerId).toBe(game.guest.playerId);
    expect(after.history).toHaveLength(1);
    expect(after.players.find((player) => player.id === game.host.playerId)?.rollCount).toBe(1);
  });
});

describe('输入校验与限流', () => {
  it('非法创建参数返回 400 INVALID_INPUT', async () => {
    const env = await startServer();
    const cases: unknown[] = [
      { nickname: '', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5 },
      { nickname: '   ', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5 },
      { nickname: '一二三四五六七八九十十一十二三', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5 },
      { nickname: '阿\u0000月', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5 },
      { nickname: 123, name: '中秋团圆局', maxPlayers: 2, maxRounds: 5 },
      { nickname: '阿月', name: '', maxPlayers: 2, maxRounds: 5 },
      { nickname: '阿月', name: '中'.repeat(25), maxPlayers: 2, maxRounds: 5 },
      { nickname: '阿月', name: '中秋团圆局', maxPlayers: 1, maxRounds: 5 },
      { nickname: '阿月', name: '中秋团圆局', maxPlayers: 13, maxRounds: 5 },
      { nickname: '阿月', name: '中秋团圆局', maxPlayers: 2.5, maxRounds: 5 },
      { nickname: '阿月', name: '中秋团圆局', maxPlayers: '2', maxRounds: 5 },
      { nickname: '阿月', name: '中秋团圆局', maxPlayers: 2, maxRounds: 7 },
      { nickname: '阿月', name: '中秋团圆局', maxPlayers: 2, maxRounds: '5' },
      ['not-an-object'],
      'a string body',
    ];
    for (const body of cases) {
      const result = await env.api('POST', '/api/rooms', { body });
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(result.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('拒绝非 JSON、非法 JSON 与超过 16KiB 的请求体', async () => {
    const env = await startServer();
    const wrongType = await env.api('POST', '/api/rooms', {
      rawBody: 'nickname=阿月',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe('INVALID_INPUT');

    const broken = await env.api('POST', '/api/rooms', { rawBody: '{"nickname":', contentType: 'application/json' });
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('INVALID_INPUT');

    const huge = await env.api('POST', '/api/rooms', {
      rawBody: JSON.stringify({ nickname: '阿月', name: 'x'.repeat(17 * 1024), maxPlayers: 2, maxRounds: 5 }),
      contentType: 'application/json',
    });
    expect(huge.status).toBe(400);
    expect(huge.body.error.code).toBe('INVALID_INPUT');
  });

  it('未匹配的接口返回 404 JSON 而不是 HTML', async () => {
    const env = await startServer();
    const result = await env.api('GET', '/api/unknown');
    expect(result.status).toBe(404);
    expect(typeof result.body).toBe('object');
    expect(result.body.error.code).toBe('ROOM_NOT_FOUND');
  });

  it('创建/加入每 IP 每分钟超过上限返回 429', async () => {
    const env = await startServer({ rateLimits: { createJoinPerMinute: 2 } });
    expect((await env.api('POST', '/api/rooms', { body: { nickname: '甲', name: '局', maxPlayers: 2, maxRounds: 5 } })).status).toBe(201);
    expect((await env.api('POST', '/api/rooms', { body: { nickname: '乙', name: '局', maxPlayers: 2, maxRounds: 5 } })).status).toBe(201);
    const limited = await env.api('POST', '/api/rooms', { body: { nickname: '丙', name: '局', maxPlayers: 2, maxRounds: 5 } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('同一身份的其他写操作超过上限返回 429', async () => {
    const env = await startServer({ rateLimits: { actionPerMinute: 2 } });
    const created = await createRoom(env, { maxPlayers: 2 });
    const token = created.membership.token;
    expect((await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'ready', ready: true }, token })).status).toBe(200);
    expect((await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'ready', ready: false }, token })).status).toBe(200);
    const limited = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'ready', ready: true }, token });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('持久化与重启恢复', () => {
  it('关闭并重开数据库后用原 token 恢复同一成员与记录，且先暂停不判超时', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bobing-restart-'));
    const clock: ClockBox = { now: 1_800_000_000_000 };
    const dice = [[1, 2, 3, 4, 5, 6]];
    const first = await startServer({ dataDir, clock, dice });
    const game = await startTwoPlayerGame(first);
    const rolled = await first.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId },
      token: game.host.token,
    });
    expect(rolled.status).toBe(200);
    const before = rolled.body.room as RoomState;
    await first.close();

    const second = await startServer({ dataDir, clock, dice: [] });
    const restored = await second.roomState(game.code, game.host.token);
    expect(restored.players).toHaveLength(2);
    expect(restored.history).toHaveLength(1);
    expect(restored.history[0].dice).toEqual([1, 2, 3, 4, 5, 6]);
    expect(restored.pool).toEqual(before.pool);
    expect(restored.turnId).toBe(before.turnId);
    expect(restored.turnPlayerId).toBe(before.turnPlayerId);
    expect(restored.revision).toBeGreaterThanOrEqual(before.revision);
    expect(restored.players.every((player) => !player.online)).toBe(true);
    expect(restored.paused).toBe(true);
    expect(restored.deadline).toBeNull();

    // 重启后推进很久也不会把恢复前的回合判超时
    second.instance.service.tick(clock.now + 10 * TURN_MS);
    const stillPaused = await second.roomState(game.code, game.host.token);
    expect(stillPaused.history).toHaveLength(1);
    expect(stillPaused.paused).toBe(true);

    // 重启时展示阶段被暂停：保留剩余时长但不给绝对时刻
    expect(restored.presentation?.recordId).toBe(before.presentation?.recordId);
    expect(restored.presentation?.until).toBeNull();

    // 暂停期间不接受掷骰
    const whilePaused = await second.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: restored.turnId },
      token: game.guest.token,
    });
    expect(whilePaused.status).toBe(409);
    expect(whilePaused.body.error.code).toBe('INVALID_STATE');

    // 成员重新连接：展示继续剩余时长，不重播动画、也不倒退轮次
    second.instance.service.connectMember(game.code, game.guest.token);
    const resumed = await second.roomState(game.code, game.host.token);
    expect(resumed.paused).toBe(false);
    expect(resumed.presentation?.recordId).toBe(before.presentation?.recordId);
    expect(resumed.presentation?.until).toBeGreaterThan(clock.now);
    expect(resumed.turnId).toBe(before.turnId); // 展示期间仍保留本次上下文
    expect(resumed.turnPlayerId).toBe(before.turnPlayerId);

    // 展示未结束前，下一位不能抢先掷骰
    const tooEarly = await second.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: restored.turnId },
      token: game.guest.token,
    });
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.code).toBe('RESULT_SHOWING');

    // 展示读完后轮到下一位，并能从实际开放时刻继续掷骰
    const handedOver = await readThroughPresentation(second, game.code, game.host.token);
    expect(handedOver.turnPlayerId).toBe(game.guest.playerId);
    const afterRestart = await second.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: handedOver.turnId },
      token: game.guest.token,
    });
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body.room.history).toHaveLength(2);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('正常完成→再开一局→重启：兼容表里的公共归档不被当成损坏，迁移不再报错', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bobing-restart-rematch-'));
    const clock: ClockBox = { now: 1_800_000_000_000 };
    const first = await startServer({ dataDir, clock, dice: [WUHONG] });
    const game = await startTwoPlayerGame(first, { config: createDefaultRoomConfig() });
    const rolled = await rollOnce(first, game.code, game.host.token, game.room.turnId as string);
    expect(rolled.status).toBe(200);
    const ended = await first.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'end' }, token: game.host.token });
    expect(ended.status).toBe(200);
    const rematch = await first.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'rematch' }, token: game.host.token });
    expect(rematch.status).toBe(200);
    const waiting = rematch.body.room as RoomState;
    expect(waiting.gameNumber).toBe(2);
    // 再开一局时兼容表与独立归档写入的是同一份白名单公共快照
    const publicJson = first.instance.db.getCompletedGame(game.code, 1)!.stateJson;
    expect(publicJson).not.toContain('tokenHash');
    expect(publicJson).not.toContain('turnOrder');
    expect(first.instance.db.listArchives(game.code, waiting.createdAt)[0]!.stateJson).toBe(publicJson);
    await first.close();

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = await startServer({ dataDir, clock, dice: [] });
    expect(errors).not.toHaveBeenCalled(); // 重启不再把合法的公共归档报成“旧完成对局迁入归档失败”
    errors.mockRestore();

    const archives = second.instance.db.listArchives(game.code, waiting.createdAt);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.stateJson).toBe(publicJson);
    expect(second.instance.db.getCompletedGame(game.code, 1)!.stateJson).toBe(publicJson);
    const restored = await second.roomState(game.code, game.host.token);
    expect(restored.status).toBe('waiting');
    expect(restored.gameNumber).toBe(2);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('数据库文件落在 DATA_DIR 且包含房间行', async () => {
    const env = await startServer();
    const created = await createRoom(env, {});
    expect(env.dataDir).toContain('bobing-test-');
    expect(env.instance.db.counts().rooms).toBe(1);
    const state = await env.roomState(created.code, created.membership.token);
    expect(state.code).toBe(created.code);
  });
});

describe('过期与清理', () => {
  it('过期访问返回 410，tick 后清理房间与相关回执、归档', async () => {
    const env = await startServer({ dice: [[1, 2, 3, 4, 5, 6]] });
    const game = await startTwoPlayerGame(env, { maxRounds: 5 });
    const roll = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId },
      token: game.host.token,
    });
    expect(roll.status).toBe(200);
    const ended = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'end' }, token: game.host.token });
    expect(ended.status).toBe(200);
    const rematch = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'rematch' }, token: game.host.token });
    expect(rematch.status).toBe(200);
    expect(env.instance.db.counts().completedGames).toBe(1);
    expect(env.instance.db.counts().receipts).toBe(1);

    env.clock.now += 24 * 3600 * 1000 + 1;
    const expiredState = await env.api('GET', `/api/rooms/${game.code}/state`, { token: game.host.token });
    expect(expiredState.status).toBe(410);
    expect(expiredState.body.error.code).toBe('ROOM_EXPIRED');
    const expiredPreview = await env.api('GET', `/api/rooms/${game.code}`);
    expect(expiredPreview.status).toBe(410);
    const expiredJoin = await env.api('POST', `/api/rooms/${game.code}/join`, { body: { nickname: '阿明' } });
    expect(expiredJoin.status).toBe(410);
    expect(expiredJoin.body.error.code).toBe('ROOM_EXPIRED');

    env.instance.service.tick(env.clock.now);
    expect(env.instance.db.counts()).toEqual({ rooms: 0, receipts: 0, completedGames: 1, archives: 1, expiredRooms: 1 });
    // 房间清理不删除独立归档：本局的历史记录仍可读
    expect(env.instance.db.listArchives(game.code, rematch.body.room.createdAt)).toHaveLength(1);

    // 清理后保留轻量墓碑：原房码仍显示“已过期”而不是“不存在”
    const tombstoned = await env.api('GET', `/api/rooms/${game.code}/state`, { token: game.host.token });
    expect(tombstoned.status).toBe(410);
    expect(tombstoned.body.error.code).toBe('ROOM_EXPIRED');
    const tombstonedPreview = await env.api('GET', `/api/rooms/${game.code}`);
    expect(tombstonedPreview.status).toBe(410);

    // 墓碑超过保留期后被清理，此时才是“房间不存在”
    env.clock.now += 8 * 24 * 3600 * 1000;
    env.instance.service.tick(env.clock.now);
    expect(env.instance.db.counts().expiredRooms).toBe(0);
    const gone = await env.api('GET', `/api/rooms/${game.code}/state`, { token: game.host.token });
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe('ROOM_NOT_FOUND');
  });

  it('已过期房间的房码不会被新房间复用', async () => {
    const codes = ['AAAAA2', 'AAAAA2', 'AAAAA3'];
    const env = await startServer({ createRoomCode: () => codes.shift() ?? 'AAAAA4' });
    const first = await createRoom(env, {});
    expect(first.code).toBe('AAAAA2');

    env.clock.now += 24 * 3600 * 1000 + 1;
    env.instance.service.tick(env.clock.now);
    expect(env.instance.db.isExpiredCode('AAAAA2')).toBe(true);

    const second = await createRoom(env, { nickname: '阿桂' });
    expect(second.code).toBe('AAAAA3'); // 生成器再次给出旧码，被墓碑挡住后重试
  });
});

describe('结算、离开与再开一局', () => {
  it('2 人 5 轮打完按轮数上限结算，房主再开一局恢复等待区', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env, { maxRounds: 5 });
    let token = game.host.token;
    for (let i = 0; i < 10; i++) {
      const state = await env.roomState(game.code, game.host.token);
      const current = state.turnPlayerId;
      const playerToken = current === game.host.playerId ? game.host.token : game.guest.token;
      token = playerToken;
      const rolled = await rollOnce(env, game.code, playerToken, state.turnId as string);
      expect(rolled.status, `第 ${i + 1} 手`).toBe(200);
      // 每一手都要读完结果展示：最后一手也在此阶段结束后才结算
      await readThroughPresentation(env, game.code, game.host.token);
    }
    const finished = await env.roomState(game.code, token);
    expect(finished.status).toBe('finished');
    expect(finished.finishedReason).toBe('round-limit');
    expect(finished.history).toHaveLength(10);
    expect(finished.pool.zhuangyuan).toBe(1); // 无人夺魁，状元空缺

    const guestRematch = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'rematch' }, token: game.guest.token });
    expect(guestRematch.status).toBe(403);
    expect(guestRematch.body.error.code).toBe('HOST_ONLY');

    const rematch = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'rematch' }, token: game.host.token });
    expect(rematch.status).toBe(200);
    expect(rematch.body.room.status).toBe('waiting');
    expect(rematch.body.room.gameNumber).toBe(2);
    expect(rematch.body.room.history).toEqual([]);
    expect(rematch.body.room.pool.duitang).toBe(2);
    expect(rematch.body.room.players.find((player: { id: string }) => player.id === game.guest.playerId).ready).toBe(false);
    expect(env.instance.db.counts().completedGames).toBe(1);
  });

  it('房主提前结束保留已发奖品并结算状元', async () => {
    const env = await startServer({ dice: [WUHONG] });
    const game = await startTwoPlayerGame(env);
    const rolled = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId },
      token: game.host.token,
    });
    expect(rolled.status).toBe(200);

    const ended = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'end' }, token: game.host.token });
    expect(ended.status).toBe(200);
    const room = ended.body.room as RoomState;
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('host-ended');
    expect(room.champion?.playerId).toBe(game.host.playerId);
    expect(room.pool.zhuangyuan).toBe(0);
    expect(room.players.find((player) => player.id === game.host.playerId)?.awards.zhuangyuan).toBe(1);

    const again = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'end' }, token: game.host.token });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');
  });

  it('对局中只剩一位未离席成员仍可继续掷骰（A14）', async () => {
    const env = await startServer({ dice: [NONE] });
    const game = await startTwoPlayerGameWithSockets(env, { maxPlayers: 3 });
    const left = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'leave' }, token: game.guest.token });
    expect(left.status).toBe(200);
    const room = left.body.room as RoomState;
    expect(room.status).toBe('playing'); // 不再因人数少于两人自动结束
    expect(room.finishedReason).toBeNull();
    expect(room.players.find((player) => player.id === game.guest.playerId)?.left).toBe(true);
    expect(room.players).toHaveLength(2); // 席位、历史保留

    const rolled = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: room.turnId },
      token: game.host.token,
    });
    expect(rolled.status).toBe(200);
    expect(rolled.body.room.status).toBe('playing');
    expect(rolled.body.room.history).toHaveLength(1);

    // 离开后的凭证失效
    const afterLeave = await env.api('GET', `/api/rooms/${game.code}/state`, { token: game.guest.token });
    expect(afterLeave.status).toBe(401);
  });

  it('全员主动离席按未完成关闭并保存归档', async () => {
    const env = await startServer({ dice: [DUITANG] });
    const game = await startTwoPlayerGameWithSockets(env);
    const firstRoll = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId },
      token: game.host.token,
    });
    expect(firstRoll.status).toBe(200);
    expect(firstRoll.body.room.players.find((player: { id: string }) => player.id === game.host.playerId).awards.duitang).toBe(1);

    await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'leave' }, token: game.guest.token });
    const hostLeft = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'leave' }, token: game.host.token });
    expect(hostLeft.status).toBe(200);
    const room = hostLeft.body.room as RoomState;
    expect(room.status).toBe('closed');
    expect(room.finishedReason).toBe('all-left');
    expect(room.incomplete).toBe(true);

    const archives = env.instance.db.listArchives(game.code, room.createdAt);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.reason).toBe('all-left');
    expect(archives[0]!.incomplete).toBe(true);
    expect(archives[0]!.stateJson).toContain('"duitang":1'); // 已发奖品保留
    expect(archives[0]!.stateJson).not.toContain('tokenHash');
  });

  it('等待区全员离开后房间关闭', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 2 });
    const left = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'leave' }, token: created.membership.token });
    expect(left.status).toBe(200);
    expect(left.body.room.status).toBe('closed');
    const preview = await env.api('GET', `/api/rooms/${created.code}`);
    expect(preview.body.canJoin).toBe(false);
    const state = await env.api('GET', `/api/rooms/${created.code}/state`, { token: created.membership.token });
    expect(state.status).toBe(401);
  });

  it('旧局的 roll 请求不能影响新局', async () => {
    const env = await startServer({ dice: [[1, 2, 3, 4, 5, 6]] });
    const game = await startTwoPlayerGame(env);
    const oldTurnId = game.room.turnId!;
    const oldRequestId = crypto.randomUUID();
    const rolled = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: oldRequestId, expectedTurnId: oldTurnId },
      token: game.host.token,
    });
    expect(rolled.status).toBe(200);
    const ended = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'end' }, token: game.host.token });
    expect(ended.status).toBe(200);
    const rematch = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'rematch' }, token: game.host.token });
    expect(rematch.status).toBe(200);
    expect(rematch.body.room.gameNumber).toBe(2);

    // 旧局回执属于第 1 局，新局里既不能重放也不能掷骰
    const replay = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: oldRequestId, expectedTurnId: oldTurnId },
      token: game.host.token,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('INVALID_STATE');

    const fresh = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: oldTurnId },
      token: game.host.token,
    });
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe('INVALID_STATE');

    const room = await env.roomState(game.code, game.host.token);
    expect(room.history).toEqual([]);
    expect(room.status).toBe('waiting');
  });

  it('房主离开后转交给最早入座的未离开成员，新宿主默认准备', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 3 });
    const joined = await joinRoom(env, created.code, '阿桂');
    const third = await joinRoom(env, created.code, '阿明');

    const left = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'leave' }, token: created.membership.token });
    expect(left.status).toBe(200);
    const room = left.body.room as RoomState;
    expect(room.hostId).toBe(joined.membership.playerId);
    expect(room.players.find((player) => player.id === joined.membership.playerId)?.ready).toBe(true);
    expect(room.players.find((player) => player.id === third.membership.playerId)?.ready).toBe(false);
    // 离开者的凭证失效，且不能再操作
    const afterLeave = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'start' }, token: created.membership.token });
    expect(afterLeave.status).toBe(401);
  });
});

describe('超时与计时', () => {
  it('推进 30 秒只跳过 1 次，无骰子无奖，重复 tick 不重复轮转', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const changed = env.instance.service.tick(env.clock.now + TURN_MS);
    expect(changed).toEqual([game.code]);
    const room = await env.roomState(game.code, game.host.token);
    expect(room.history).toHaveLength(1);
    expect(room.history[0].reason).toBe('timeout');
    expect(room.history[0].dice).toEqual([]);
    expect(room.history[0].awarded).toBeNull();
    // 超时没有动画，先进入只含停留时长的结果展示：保留本次上下文、deadline 为空
    expect(room.presentation?.recordId).toBe(room.history[0].id);
    expect(room.presentation?.until).toBe(env.clock.now + TURN_MS + DEFAULT_RESULT_HOLD_SECONDS * 1000);
    expect(room.deadline).toBeNull();
    expect(room.turnPlayerId).toBe(game.host.playerId);

    // 同一时刻重复 tick 不重复跳过，也不提前推进
    expect(env.instance.service.tick(env.clock.now + TURN_MS)).toEqual([]);
    const after = await env.roomState(game.code, game.host.token);
    expect(after.history).toHaveLength(1);
    expect(after.turnPlayerId).toBe(game.host.playerId);

    // 展示读完才轮到下一位，且下一位是同一轮里的第二位
    const handedOver = await readThroughPresentation(env, game.code, game.host.token);
    expect(handedOver.history).toHaveLength(1);
    expect(handedOver.turnPlayerId).toBe(game.guest.playerId);
    expect(handedOver.round).toBe(1);
    // 下一位拿到完整三十秒（从实际开放时刻起算）
    expect(handedOver.deadline! - env.clock.now).toBe(TURN_MS);
  });

  it('到期与下一次 tick 之间迟到的掷骰：先按超时结算再返回 STALE_TURN', async () => {
    const env = await startServer({ dice: [[1, 2, 3, 4, 5, 6]] });
    const game = await startTwoPlayerGame(env);
    env.clock.now += TURN_MS; // 已到期，但 1 秒 tick 还没执行

    const late = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId },
      token: game.host.token,
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('STALE_TURN');

    const room = await env.roomState(game.code, game.host.token);
    expect(room.history).toHaveLength(1);
    expect(room.history[0].reason).toBe('timeout');
    expect(room.history[0].dice).toEqual([]);
    expect(room.history[0].awarded).toBeNull();
    // 迟到的掷骰不消耗机会：超时进入展示阶段，本次上下文仍是超时者
    expect(room.presentation?.recordId).toBe(room.history[0].id);
    expect(room.turnPlayerId).toBe(game.host.playerId);
    // 只推进一次：随后 tick 不再补跳
    expect(env.instance.service.tick(env.clock.now)).toEqual([]);
    const after = await env.roomState(game.code, game.host.token);
    expect(after.history).toHaveLength(1);

    // 展示读完才轮到下一位，且不会补掷这一手
    const handedOver = await readThroughPresentation(env, game.code, game.host.token);
    expect(handedOver.history).toHaveLength(1);
    expect(handedOver.turnPlayerId).toBe(game.guest.playerId);
    expect(handedOver.players.find((player) => player.id === game.host.playerId)?.rollCount).toBe(0);
  });

  it('掷骰与 tick 交错不会重复轮转', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const rolled = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId },
      token: game.host.token,
    });
    expect(rolled.status).toBe(200);
    // 展示阶段内的 tick 既不跳过回合，也不提前交给下一位
    expect(env.instance.service.tick(env.clock.now)).toEqual([]);
    expect(env.instance.service.tick(env.clock.now + 1_000)).toEqual([]);
    const room = await env.roomState(game.code, game.host.token);
    expect(room.history).toHaveLength(1);
    expect(room.presentation).not.toBeNull();
    expect(room.turnPlayerId).toBe(game.host.playerId);

    const handedOver = await readThroughPresentation(env, game.code, game.host.token);
    expect(handedOver.history).toHaveLength(1);
    expect(handedOver.turnPlayerId).toBe(game.guest.playerId);
    expect(handedOver.round).toBe(1);
  });
});

describe('写库失败的一致性', () => {
  it('掷骰写库失败时不留下未提交状态，也不广播，恢复后仍可正常掷骰', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bobing-dbfail-'));
    const clock: ClockBox = { now: 1_800_000_000_000 };
    const db = new AppDatabase(join(dataDir, 'bobing.sqlite'));
    const broadcasts: RoomState[] = [];
    const service = new RoomService({
      db,
      now: () => clock.now,
      rollDice: () => [1, 2, 3, 4, 5, 6],
      pickStartSeat: () => 0,
      onBroadcast: (room) => broadcasts.push(room),
    });

    const created = service.create({ nickname: '阿月', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5 }, '127.0.0.1');
    service.connectMember(created.room.code, created.membership.token);
    const joined = service.join(created.room.code, '阿桂', '127.0.0.1');
    service.connectMember(created.room.code, joined.membership.token);
    service.action(created.room.code, joined.membership.token, { type: 'ready', ready: true });
    const started = service.action(created.room.code, created.membership.token, { type: 'start' });
    const before = started.room;

    const originalSaveRoom = db.saveRoom.bind(db);
    let failNext = true;
    (db as unknown as { saveRoom: (row: unknown) => void }).saveRoom = (row: unknown) => {
      if (failNext) {
        failNext = false;
        throw new Error('注入的磁盘写失败');
      }
      (originalSaveRoom as unknown as (value: unknown) => void)(row);
    };
    const broadcastCountBefore = broadcasts.length;

    expect(() =>
      service.action(created.room.code, created.membership.token, {
        type: 'roll',
        requestId: crypto.randomUUID(),
        expectedTurnId: before.turnId!,
      }),
    ).toThrow(/注入的磁盘写失败/);

    const after = service.state(created.room.code, created.membership.token).room;
    expect(after.history).toEqual([]);
    expect(after.pool).toEqual(before.pool);
    expect(after.turnId).toBe(before.turnId);
    expect(after.turnPlayerId).toBe(before.turnPlayerId);
    expect(after.revision).toBe(before.revision);
    expect(db.counts().receipts).toBe(0);
    expect(broadcasts).toHaveLength(broadcastCountBefore); // 失败绝不广播
    const persisted = JSON.parse(db.getRoom(created.room.code)!.stateJson) as RoomState;
    expect(persisted.revision).toBe(after.revision);
    expect(persisted.history).toEqual([]);
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('创建时写库失败不留下虚假房间', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bobing-dbfail-create-'));
    const db = new AppDatabase(join(dataDir, 'bobing.sqlite'));
    const service = new RoomService({ db, now: () => 1_800_000_000_000 });
    (db as unknown as { saveRoom: (row: unknown) => void }).saveRoom = () => {
      throw new Error('注入的磁盘写失败');
    };

    expect(() => service.create({ nickname: '阿月', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5 }, '127.0.0.1')).toThrow();
    expect(service.loadedRoomCount()).toBe(0);
    expect(db.counts().rooms).toBe(0);
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('Socket 实时同步', () => {
  it('鉴权成功收到 room:state，两个客户端 revision 一致', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 4 });
    const host = await connectSocket(env, { roomCode: created.code, token: created.membership.token });
    const hostState = await host.log.wait(() => true);
    expect(hostState.code).toBe(created.code);
    assertNoSecrets(hostState, created.membership.token);

    const joined = await joinRoom(env, created.code, '阿桂');
    const guest = await connectSocket(env, { roomCode: created.code, token: joined.membership.token });

    const marker = host.log.mark();
    await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'ready', ready: true }, token: joined.membership.token });
    const hostAfter = await host.log.wait((room) => room.players.length === 2 && room.players[1]!.ready, { after: marker });
    const guestAfter = await guest.log.wait((room) => room.revision === hostAfter.revision);
    expect(guestAfter.revision).toBe(hostAfter.revision);
    expect(hostAfter.players.find((player) => player.id === joined.membership.playerId)?.online).toBe(true);
  });

  it('无 token、错误 token、其他房间 token 都拒绝连接并给出可读信息', async () => {
    const env = await startServer();
    const first = await createRoom(env, {});
    const second = await createRoom(env, { nickname: '阿桂' });

    const missing = await connectFailure(env, { roomCode: first.code });
    expect(missing.message).toContain('身份');
    expect(missing.data?.code).toBe('INVALID_TOKEN');

    const wrong = await connectFailure(env, { roomCode: first.code, token: 'b'.repeat(64) });
    expect(wrong.data?.code).toBe('INVALID_TOKEN');

    const otherRoom = await connectFailure(env, { roomCode: first.code, token: second.membership.token });
    expect(otherRoom.data?.code).toBe('INVALID_TOKEN');

    const badCode = await connectFailure(env, { roomCode: 'ABC', token: first.membership.token });
    expect(badCode.data?.code).toBe('INVALID_INPUT');

    const unknownRoom = await connectFailure(env, { roomCode: 'ZZZZZZ', token: first.membership.token });
    expect(unknownRoom.data?.code).toBe('ROOM_NOT_FOUND');
  });

  it('同一成员两个连接，关一个仍在线，全部关闭才离线', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 4 });
    const first = await connectSocket(env, { roomCode: created.code, token: created.membership.token });
    const second = await connectSocket(env, { roomCode: created.code, token: created.membership.token });

    const online = await env.roomState(created.code, created.membership.token);
    expect(online.players[0].online).toBe(true);

    const marker = second.log.mark();
    first.socket.close();
    await waitFor(async () => {
      const room = await env.roomState(created.code, created.membership.token);
      return room.players[0].online === true && room.revision >= online.revision;
    });

    second.socket.close();
    await waitFor(async () => {
      const room = await env.roomState(created.code, created.membership.token);
      return room.players[0].online === false;
    });
    expect(second.log.mark()).toBeGreaterThanOrEqual(marker); // 至少还收到过广播
  });

  it('掷骰后向房间内所有连接广播更高 revision', async () => {
    const env = await startServer({ dice: [[1, 2, 3, 4, 5, 6]] });
    const game = await startTwoPlayerGame(env);
    const hostSocket = await connectSocket(env, { roomCode: game.code, token: game.host.token });
    const guestSocket = await connectSocket(env, { roomCode: game.code, token: game.guest.token });
    const hostRevision = (await hostSocket.log.wait(() => true)).revision;
    const guestRevision = (await guestSocket.log.wait(() => true)).revision;
    expect(guestRevision).toBeGreaterThanOrEqual(hostRevision);

    const hostMarker = hostSocket.log.mark();
    const guestMarker = guestSocket.log.mark();
    const rolled = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId },
      token: game.host.token,
    });
    expect(rolled.status).toBe(200);

    const hostSeen = await hostSocket.log.wait((room) => room.history.length === 1, { after: hostMarker });
    const guestSeen = await guestSocket.log.wait((room) => room.history.length === 1, { after: guestMarker });
    expect(hostSeen.revision).toBe(guestSeen.revision);
    expect(hostSeen.revision).toBe(rolled.body.room.revision);
    expect(guestSeen.history[0].dice).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('全员离线暂停与恢复', () => {
  it('全员掉线暂停倒计时，有人回来恢复剩余时间', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGameWithSockets(env);
    const hostSocket = game.hostSocket;
    const guestSocket = game.guestSocket;

    hostSocket.socket.close();
    guestSocket.socket.close();
    await waitFor(async () => (await env.roomState(game.code, game.host.token)).paused);

    const paused = await env.roomState(game.code, game.host.token);
    expect(paused.paused).toBe(true);
    expect(paused.deadline).toBeNull();

    const whilePaused = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId },
      token: game.host.token,
    });
    expect(whilePaused.status).toBe(409);
    expect(whilePaused.body.error.code).toBe('INVALID_STATE');
    const untouched = await env.roomState(game.code, game.host.token);
    expect(untouched.history).toEqual([]);

    env.clock.now += 50_000; // 离线期间流逝的时间不计入回合
    const reconnected = await connectSocket(env, { roomCode: game.code, token: game.host.token });
    const resumed = await reconnected.log.wait((room) => room.paused === false);
    expect(resumed.deadline).not.toBeNull();
    expect(resumed.deadline!).toBeGreaterThan(env.clock.now);
    expect(resumed.deadline!).toBeLessThanOrEqual(env.clock.now + TURN_MS);
  });
});

describe('房主离线转交', () => {
  it('房主离线 60 秒后转交最早入座的在线成员，原房主回来不夺回', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 3 });
    const joined = await joinRoom(env, created.code, '阿桂');

    const hostSocket = await connectSocket(env, { roomCode: created.code, token: created.membership.token });
    const guestSocket = await connectSocket(env, { roomCode: created.code, token: joined.membership.token });
    await hostSocket.log.wait((room) => room.hostId === created.membership.playerId);

    hostSocket.socket.close();
    await waitFor(async () => {
      const room = await env.roomState(created.code, joined.membership.token);
      return room.players.find((player) => player.id === created.membership.playerId)?.online === false;
    });

    const guestMarker = guestSocket.log.mark();
    env.clock.now += 60_000;
    env.instance.service.tick(env.clock.now);
    const transferred = await guestSocket.log.wait((room) => room.hostId === joined.membership.playerId, { after: guestMarker });
    expect(transferred.hostId).toBe(joined.membership.playerId);

    const original = await connectSocket(env, { roomCode: created.code, token: created.membership.token });
    const afterReturn = await original.log.wait(() => true);
    expect(afterReturn.hostId).toBe(joined.membership.playerId); // 原房主回来不自动夺回
    expect(afterReturn.players.find((player) => player.id === created.membership.playerId)?.online).toBe(true);
  });

  it('没有在线成员时不转交', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 3 });
    const hostSocket = await connectSocket(env, { roomCode: created.code, token: created.membership.token });
    await hostSocket.log.wait(() => true);
    hostSocket.socket.close();
    await waitFor(async () => {
      const room = await env.roomState(created.code, created.membership.token);
      return room.players[0].online === false;
    });
    env.clock.now += 10 * 60_000;
    env.instance.service.tick(env.clock.now);
    const room = await env.roomState(created.code, created.membership.token);
    expect(room.hostId).toBe(created.membership.playerId);
  });
});

describe('房间配置：创建、校验与公开快照', () => {
  it('不传配置时按默认：持续顶状元＋奖品发完结束，六档共 63 份（A01）', async () => {
    const env = await startServer();
    const result = await env.api('POST', '/api/rooms', { body: { nickname: '阿月', name: '中秋团圆局', maxPlayers: 4 } });
    expect(result.status).toBe(201);
    const room = result.body.room as RoomState;
    expect(room.config).toEqual(createDefaultRoomConfig());
    expect(room.config.endCondition).toEqual({ mode: 'all-prizes' });
    expect(room.ruleset.id).toBe('continuous');
    expect(room.config.rulesetId).toBe('continuous');
    expect(room.initialPool).toEqual({ zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 32 });
    expect(room.pool).toEqual(room.initialPool);
    expect(room.closingRound).toBeNull();
    expect(room.incomplete).toBe(false);
    expect(Object.values(room.initialPool).reduce((sum, count) => sum + count, 0)).toBe(63);
    // 等待室从创建起 24 小时
    expect(room.expiresAt).toBe(room.createdAt + DAY_MS);
    assertNoSecrets(result.body.room, result.body.membership.token);
  });

  it('自定义配置与奖品内容进入公开快照和邀请概况，内容去首尾空格（A09）', async () => {
    const env = await startServer();
    const config = createDefaultRoomConfig();
    config.rulesetId = 'high-tier-lock';
    config.endCondition = { mode: 'rounds', maxRounds: 10 };
    config.prizes.zhuangyuan = { count: 3, content: '  大礼包  ' };
    config.prizes.yixiu = { count: 7, content: '月饼一盒' };
    const created = await createRoom(env, { maxPlayers: 6, config });
    expect(created.room.config.prizes.zhuangyuan).toEqual({ count: 3, content: '大礼包' });
    expect(created.room.config.prizes.yixiu).toEqual({ count: 7, content: '月饼一盒' });
    expect(created.room.config.endCondition).toEqual({ mode: 'rounds', maxRounds: 10 });
    expect(created.room.ruleset.id).toBe('high-tier-lock');
    expect(created.room.ruleset.championPolicy).toBe('lock-high-tier');
    expect(created.room.initialPool.zhuangyuan).toBe(3);
    expect(created.room.initialPool.yixiu).toBe(7);

    const preview = await env.api('GET', `/api/rooms/${created.code}`);
    expect(preview.status).toBe(200);
    expect(preview.body.config).toEqual(created.room.config);
    expect(preview.body.ruleset).toEqual(created.room.ruleset);
    expect(preview.body.canJoin).toBe(true);
    expect(preview.body.maxPlayers).toBe(6);
    expect(preview.body.expiresAt).toBe(created.room.expiresAt);
    expect(preview.body.maxRounds).toBeUndefined();
    assertNoSecrets(preview.body, created.membership.token);

    // 修改配置后邀请概况同步反映
    const changed = createDefaultRoomConfig();
    changed.prizes.sanhong = { count: 9, content: '茶叶' };
    const updated = await updateConfig(env, created.code, created.membership.token, changed);
    expect(updated.status).toBe(200);
    const afterUpdate = await env.api('GET', `/api/rooms/${created.code}`);
    expect(afterUpdate.body.config).toEqual(changed);
    expect(afterUpdate.body.ruleset.id).toBe('continuous');
  });

  it('非法配置一律 400 INVALID_INPUT，不静默补齐（A08）', async () => {
    const env = await startServer();
    const cases: Array<[string, unknown]> = [];
    const withPrize = (key: keyof RoomConfig['prizes'], patch: unknown): RoomConfig => {
      const config = createDefaultRoomConfig();
      (config.prizes as Record<string, unknown>)[key] = patch;
      return config;
    };
    cases.push(['份数为 0', withPrize('yixiu', { count: 0, content: '' })]);
    cases.push(['份数为负', withPrize('yixiu', { count: -1, content: '' })]);
    cases.push(['份数非整数', withPrize('yixiu', { count: 1.5, content: '' })]);
    cases.push(['份数为字符串', withPrize('yixiu', { count: '4', content: '' })]);
    cases.push(['份数为 null', withPrize('yixiu', { count: null, content: '' })]);
    cases.push(['内容非字符串', withPrize('sanhong', { count: 4, content: 5 })]);
    cases.push(['缺少 content', withPrize('erju', { count: 16 })]);
    const missing = createDefaultRoomConfig();
    delete (missing.prizes as Record<string, unknown>).erju;
    cases.push(['缺少某一档', missing]);
    cases.push(['未知房规', { ...createDefaultRoomConfig(), rulesetId: 'custom' }]);
    cases.push(['未知结束方式', { ...createDefaultRoomConfig(), endCondition: { mode: 'forever' } }]);
    cases.push(['非法轮数', { ...createDefaultRoomConfig(), endCondition: { mode: 'rounds', maxRounds: 7 } }]);
    cases.push(['结束方式缺失', { ...createDefaultRoomConfig(), endCondition: undefined }]);
    cases.push(['配置不是对象', 'all-prizes']);
    cases.push(['空对象', {}]);

    for (const [label, config] of cases) {
      const result = await env.api('POST', '/api/rooms', { body: { nickname: '阿月', name: '中秋团圆局', maxPlayers: 4, config } });
      expect(result.status, label).toBe(400);
      expect(result.body.error.code, label).toBe('INVALID_INPUT');
    }
  });

  it('配置只保留白名单字段：未知奖品档与其他字段不会进入快照', async () => {
    const env = await startServer();
    const config = createDefaultRoomConfig();
    const result = await env.api('POST', '/api/rooms', {
      body: {
        nickname: '阿月',
        name: '中秋团圆局',
        maxPlayers: 4,
        config: { ...config, prizes: { ...config.prizes, extra: { count: 1, content: '偷偷加的' } }, ruleset: { id: 'custom' } },
      },
    });
    expect(result.status).toBe(201);
    const room = result.body.room as RoomState;
    expect(Object.keys(room.config.prizes)).toEqual(['zhuangyuan', 'duitang', 'sanhong', 'sijin', 'erju', 'yixiu']);
    expect(Object.keys(room.config)).toEqual(['rulesetId', 'endCondition', 'prizes']);
    expect(room.ruleset.id).toBe('continuous');
  });

  it('config 与旧 maxRounds 同时出现时拒绝，避免两套结束规则冲突', async () => {
    const env = await startServer();
    const result = await env.api('POST', '/api/rooms', {
      body: { nickname: '阿月', name: '中秋团圆局', maxPlayers: 4, config: createDefaultRoomConfig(), maxRounds: 5 },
    });
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_INPUT');
  });

  it('旧客户端 maxRounds 显式映射为固定轮数，房间不会被静默改成无限（A20）', async () => {
    const env = await startServer();
    for (const maxRounds of [5, 10, 20]) {
      const created = await createRoom(env, { maxRounds });
      expect(created.room.config.rulesetId).toBe('continuous');
      expect(created.room.config.endCondition).toEqual({ mode: 'rounds', maxRounds });
      expect(created.room.initialPool).toEqual({ zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 32 });
      expect(created.room.ruleset.id).toBe('continuous');
    }
  });

  it('无限轮数局在真实 HTTP 流程中打到 21 轮以上仍在进行（A02）', async () => {
    const env = await startServer({ dice: Array.from({ length: 46 }, () => NONE) });
    const game = await startTwoPlayerGameWithSockets(env, { config: createDefaultRoomConfig() });
    let state = game.room;
    for (let i = 0; i < 44; i++) {
      const token = state.turnPlayerId === game.host.playerId ? game.host.token : game.guest.token;
      const rolled = await rollOnce(env, game.code, token, state.turnId as string);
      expect(rolled.status).toBe(200);
      // 每一手都读完结果展示再进入下一手，节奏不改变“无限轮数”的判定
      state = await readThroughPresentation(env, game.code, game.host.token);
    }
    expect(state.status).toBe('playing');
    expect(state.round).toBeGreaterThan(20);
    expect(state.champion).toBeNull();
    expect(state.closingRound).toBeNull();
    expect(state.history).toHaveLength(44);
    expect(state.players.reduce((sum, player) => sum + player.rollCount, 0)).toBe(44);
    expect(state.pool).toEqual(state.initialPool); // 全是散点，奖池原封不动
  });
});

describe('等待室改配置：权限、原子性与冻结', () => {
  it('房主改配置后按新配置重建满额库存，取消其他玩家准备但保留房主准备（A10）', async () => {
    const env = await startServer();
    const waiting = await waitingRoomWithReadyGuest(env);
    expect(waiting.room.players.find((player) => player.id === waiting.guest.playerId)?.ready).toBe(true);
    expect(waiting.room.players.find((player) => player.id === waiting.host.playerId)?.ready).toBe(true);

    const config = createDefaultRoomConfig();
    config.endCondition = { mode: 'rounds', maxRounds: 10 };
    config.prizes.duitang = { count: 5, content: '  礼盒  ' };
    const updated = await updateConfig(env, waiting.code, waiting.host.token, config);
    expect(updated.status).toBe(200);
    const room = updated.body.room as RoomState;
    expect(room.config.endCondition).toEqual({ mode: 'rounds', maxRounds: 10 });
    expect(room.config.prizes.duitang).toEqual({ count: 5, content: '礼盒' });
    expect(room.initialPool.duitang).toBe(5);
    expect(room.pool.duitang).toBe(5); // 满额重建
    expect(room.players.find((player) => player.id === waiting.host.playerId)?.ready).toBe(true);
    expect(room.players.find((player) => player.id === waiting.guest.playerId)?.ready).toBe(false);
    expect(room.revision).toBeGreaterThan(waiting.room.revision);
    // 重新准备后可以按新配置开局
    await env.api('POST', `/api/rooms/${waiting.code}/actions`, { body: { type: 'ready', ready: true }, token: waiting.guest.token });
    const started = await env.api('POST', `/api/rooms/${waiting.code}/actions`, { body: { type: 'start' }, token: waiting.host.token });
    expect(started.status).toBe(200);
    expect(started.body.room.status).toBe('playing');
    expect(started.body.room.config.endCondition).toEqual({ mode: 'rounds', maxRounds: 10 });
  });

  it('非房主改配置返回 403 HOST_ONLY', async () => {
    const env = await startServer();
    const waiting = await waitingRoomWithReadyGuest(env);
    const result = await updateConfig(env, waiting.code, waiting.guest.token, createDefaultRoomConfig());
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('HOST_ONLY');
  });

  it('开局后改配置返回 409 INVALID_STATE，配置与规则快照保持冻结', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGameWithSockets(env, { config: createDefaultRoomConfig() });
    const result = await updateConfig(env, game.code, game.host.token, { ...createDefaultRoomConfig(), rulesetId: 'high-tier-lock' });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('INVALID_STATE');
    const room = await env.roomState(game.code, game.host.token);
    expect(room.config.rulesetId).toBe('continuous');
    expect(room.ruleset.id).toBe('continuous');
    expect(room.revision).toBe(game.room.revision);
  });

  it('非法配置返回 400 且 revision、库存与准备状态都不变（原子性）（A10）', async () => {
    const env = await startServer();
    const waiting = await waitingRoomWithReadyGuest(env);
    const before = await env.roomState(waiting.code, waiting.host.token);
    const invalid = createDefaultRoomConfig();
    invalid.prizes.yixiu = { count: 0, content: '' };
    const result = await updateConfig(env, waiting.code, waiting.host.token, invalid);
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('INVALID_INPUT');
    const after = await env.roomState(waiting.code, waiting.host.token);
    expect(after).toEqual(before);
    expect(after.pool).toEqual(before.pool);
    expect(after.revision).toBe(before.revision);
    expect(after.players.find((player) => player.id === waiting.guest.playerId)?.ready).toBe(true);
  });

  it('配置没有实际变化时不算改动：不重置准备状态、不递增 revision', async () => {
    const env = await startServer();
    const config = createDefaultRoomConfig();
    config.prizes.yixiu = { count: 6, content: '月饼' };
    const waiting = await waitingRoomWithReadyGuest(env, { config });
    const before = await env.roomState(waiting.code, waiting.host.token);
    // 同样的配置（内容带首尾空格、档位顺序不同）仍视为没有变化
    const same = createDefaultRoomConfig();
    same.prizes.yixiu = { count: 6, content: ' 月饼 ' };
    const result = await updateConfig(env, waiting.code, waiting.host.token, same);
    expect(result.status).toBe(200);
    const after = result.body.room as RoomState;
    expect(after.revision).toBe(before.revision);
    expect(after.config.prizes.yixiu).toEqual({ count: 6, content: '月饼' });
    expect(after.players.find((player) => player.id === waiting.guest.playerId)?.ready).toBe(true);
  });

  it('改配置写库失败时回滚到已提交配置，不留下半成品（A10）', async () => {
    const env = await startServer();
    const waiting = await waitingRoomWithReadyGuest(env);
    const before = await env.roomState(waiting.code, waiting.host.token);
    const config = createDefaultRoomConfig();
    config.prizes.yixiu = { count: 7, content: '月饼一盒' };

    const db = env.instance.db;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = db.saveRoom.bind(db);
    (db as unknown as { saveRoom: () => void }).saveRoom = () => {
      throw new Error('注入的写库失败');
    };
    const failed = await updateConfig(env, waiting.code, waiting.host.token, config);
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('INTERNAL_ERROR');
    (db as unknown as { saveRoom: typeof original }).saveRoom = original;
    spy.mockRestore();

    // 失败后必须回到已提交状态：配置、库存、准备、revision 都不变
    const after = await env.roomState(waiting.code, waiting.host.token);
    expect(after.config).toEqual(before.config);
    expect(after.pool).toEqual(before.pool);
    expect(after.revision).toBe(before.revision);
    expect(after.players.find((player) => player.id === waiting.guest.playerId)?.ready).toBe(true);

    // 恢复后同一请求可以正常生效
    const ok = await updateConfig(env, waiting.code, waiting.host.token, config);
    expect(ok.status).toBe(200);
    expect((ok.body.room as RoomState).pool.yixiu).toBe(7);
    expect((ok.body.room as RoomState).players.find((player) => player.id === waiting.guest.playerId)?.ready).toBe(false);
  });

  it('切换房规会同时更新本房间规则快照（开局前）', async () => {
    const env = await startServer();
    const waiting = await waitingRoomWithReadyGuest(env);
    expect(waiting.room.ruleset.id).toBe('continuous');
    const locked = createDefaultRoomConfig();
    locked.rulesetId = 'high-tier-lock';
    const updated = await updateConfig(env, waiting.code, waiting.host.token, locked);
    expect((updated.body.room as RoomState).ruleset.id).toBe('high-tier-lock');
    expect((updated.body.room as RoomState).ruleset.lockCodes).toContain('wuhong');
    const reverted = await updateConfig(env, waiting.code, waiting.host.token, createDefaultRoomConfig());
    expect((reverted.body.room as RoomState).ruleset.id).toBe('continuous');
  });
});

describe('离线计时与过期归档', () => {
  it('活跃对局不受创建后 24 小时截断；全员离线起算 24 小时，重复 tick 与重连都不顺延（A12、A13）', async () => {
    const env = await startServer({ dice: [WUHONG, YIXIU] });
    const game = await startTwoPlayerGameWithSockets(env, { config: createDefaultRoomConfig() });

    // 一局真正的对局：状元候选（不发奖）＋一份普通奖（即时发放）
    const first = await rollOnce(env, game.code, game.host.token, game.room.turnId as string);
    expect(first.status).toBe(200);
    expect((first.body.room as RoomState).pool.zhuangyuan).toBe(1);
    // 结果展示读完才轮到客人，否则投掷会被展示阶段挡下
    const afterFirst = await readThroughPresentation(env, game.code, game.host.token);
    expect(afterFirst.turnPlayerId).toBe(game.guest.playerId);
    const second = await rollOnce(env, game.code, game.guest.token, afterFirst.turnId as string);
    expect(second.status).toBe(200);
    expect((second.body.room as RoomState).players.find((player) => player.id === game.guest.playerId)?.awards.yixiu).toBe(1);
    const afterSecond = second.body.room as RoomState;
    expect(afterSecond.presentation).not.toBeNull();

    // 全员离线：立刻暂停、保存剩余时间、开始 24 小时计时
    game.hostSocket.socket.close();
    game.guestSocket.socket.close();
    await waitFor(async () => (await env.roomState(game.code, game.host.token)).paused === true);
    const offline = await env.roomState(game.code, game.host.token);
    expect(offline.paused).toBe(true);
    expect(offline.allOfflineSince).toBe(env.clock.now);
    expect(offline.expiresAt).toBe(env.clock.now + DAY_MS);
    expect(offline.deadline).toBeNull();

    // 重复 tick 与重复断开都不刷新离线起点
    env.clock.now += 3600 * 1000;
    env.instance.service.tick(env.clock.now);
    const ticked = await env.roomState(game.code, game.host.token);
    expect(ticked.allOfflineSince).toBe(offline.allOfflineSince);
    expect(ticked.expiresAt).toBe(offline.expiresAt);

    // 离线 23 小时后第一位成员回来：取消到期并恢复剩余倒计时
    env.clock.now = offline.allOfflineSince! + 23 * 3600 * 1000;
    const reconnected = await connectSocket(env, { roomCode: game.code, token: game.host.token });
    const resumed = await reconnected.log.wait((room) => room.paused === false);
    expect(resumed.allOfflineSince).toBeNull();
    expect(resumed.expiresAt).toBeNull();
    expect(resumed.status).toBe('playing');
    // 恢复的是被暂停的那次结果展示：剩余时长大于零，且不重播（沿用同一条记录）
    expect(resumed.presentation?.recordId).toBe(afterSecond.presentation?.recordId);
    expect(resumed.presentation?.until).toBeGreaterThan(env.clock.now);
    expect(resumed.deadline).toBeNull();

    // 展示读完才轮到下一位，并给足完整三十秒
    const handedOver = await readThroughPresentation(env, game.code, game.host.token);
    expect(handedOver.turnPlayerId).toBe(game.host.playerId);
    expect(handedOver.deadline! - env.clock.now).toBe(TURN_MS);

    // 活跃对局远超创建后 24 小时仍可继续，且不会被 tick 清理
    env.clock.now += 2 * DAY_MS;
    env.instance.service.tick(env.clock.now);
    const stillActive = await env.roomState(game.code, game.host.token);
    expect(stillActive.status).toBe('playing');
    expect(stillActive.expiresAt).toBeNull();
    expect(env.instance.db.getRoom(game.code)).not.toBeNull();

    // 再次全员离线：从这次转换重新起算 24 小时
    const reofflineAt = env.clock.now;
    reconnected.socket.close();
    await waitFor(async () => (await env.roomState(game.code, game.host.token)).paused === true);
    const offlineAgain = await env.roomState(game.code, game.host.token);
    expect(offlineAgain.allOfflineSince).toBe(reofflineAt);
    expect(offlineAgain.expiresAt).toBe(reofflineAt + DAY_MS);
    expect(offlineAgain.expiresAt).not.toBe(offline.expiresAt);
  });

  it('离线中重启不顺延 24 小时；到期后按未完成归档已发奖品且不补发状元（A12、A13）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'bobing-offline-'));
    const clock: ClockBox = { now: 1_800_000_000_000 };
    const first = await startServer({ dataDir, clock, dice: [WUHONG, YIXIU] });
    const game = await startTwoPlayerGameWithSockets(first, { config: createDefaultRoomConfig() });
    const firstRoll = await rollOnce(first, game.code, game.host.token, game.room.turnId as string);
    expect(firstRoll.status).toBe(200);
    const afterFirst = await readThroughPresentation(first, game.code, game.host.token);
    await rollOnce(first, game.code, game.guest.token, afterFirst.turnId as string);
    game.hostSocket.socket.close();
    game.guestSocket.socket.close();
    await waitFor(async () => (await first.roomState(game.code, game.host.token)).paused === true);
    const offline = await first.roomState(game.code, game.host.token);
    const expiresAt = offline.expiresAt as number;
    const since = offline.allOfflineSince as number;
    await first.close();

    // 离线 10 小时后重启：起点与到期时间原样保留
    clock.now += 10 * 3600 * 1000;
    const restarted = await startServer({ dataDir, clock, dice: [] });
    const restored = await restarted.roomState(game.code, game.host.token);
    expect(restored.status).toBe('playing');
    expect(restored.paused).toBe(true);
    expect(restored.allOfflineSince).toBe(since);
    expect(restored.expiresAt).toBe(expiresAt);
    expect(restored.players.every((player) => player.online === false)).toBe(true);

    // 重复 tick 仍不续期
    restarted.instance.service.tick(clock.now + 3600 * 1000);
    expect((await restarted.roomState(game.code, game.host.token)).expiresAt).toBe(expiresAt);

    // 到期后清理：房间删除、墓碑生效、独立归档保留实际已发的奖品
    clock.now = expiresAt + 1;
    restarted.instance.service.tick(clock.now);
    expect(restarted.instance.db.getRoom(game.code)).toBeNull();
    expect(restarted.instance.db.isExpiredCode(game.code)).toBe(true);
    const expired = await restarted.api('GET', `/api/rooms/${game.code}/state`, { token: game.host.token });
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('ROOM_EXPIRED');

    const archives = restarted.instance.db.listArchives(game.code, restored.createdAt);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.reason).toBe('offline-expired');
    expect(archives[0]!.incomplete).toBe(true);
    const archived = JSON.parse(archives[0]!.stateJson) as RoomState;
    expect(archived.status).toBe('closed');
    expect(archived.finishedReason).toBe('offline-expired');
    expect(archived.players.find((player) => player.id === game.guest.playerId)?.awards.yixiu).toBe(1);
    expect(archived.players.find((player) => player.id === game.host.playerId)?.awards.zhuangyuan).toBe(0);
    expect(archived.champion?.playerId).toBe(game.host.playerId); // 候选保留但不结算
    expect(archived.pool.zhuangyuan).toBe(1);
    expect(archives[0]!.stateJson).not.toContain('tokenHash');
    // 归档里不能留下已经无意义的进行中状态：展示与回合都清空，离线起点保留为事实
    expect(archived.presentation).toBeNull();
    expect(archived.deadline).toBeNull();
    expect(archived.turnPlayerId).toBeNull();
    expect(archived.turnId).toBeNull();
    expect(archived.paused).toBe(false);
    expect(archived.allOfflineSince).toBe(since);
    // 过期不结算：历程保留投掷产生的事实，但不追加 settled，也不补发状元
    expect(archived.championHistoryComplete).toBe(true);
    expect(archived.championEvents.map((event) => event.kind)).toEqual(['first']);
    expect(archived.championEvents.some((event) => event.kind === 'settled')).toBe(false);
    // 个人最后结果随归档保留（独立于 240 条历史窗口）
    expect(archived.players.find((player) => player.id === game.host.playerId)?.lastRoll?.result?.code).toBe('wuhong');
    expect(archived.players.find((player) => player.id === game.guest.playerId)?.lastRoll?.result?.code).toBe('yixiu');
    expect(archived.players.every((player) => player.lastRoll !== null)).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('过期清理写库失败时不产生内存与数据库分裂', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env, { config: createDefaultRoomConfig() });
    env.instance.service.closeConnection(game.code, game.host.playerId);
    env.instance.service.closeConnection(game.code, game.guest.playerId);
    const offline = await env.roomState(game.code, game.host.token);
    expect(offline.expiresAt).toBe(env.clock.now + DAY_MS);

    const db = env.instance.db;
    // 清理失败会记录错误日志，这里静音以免干扰测试输出
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = db.saveArchive.bind(db);
    (db as unknown as { saveArchive: () => void }).saveArchive = () => {
      throw new Error('注入的归档写入失败');
    };
    env.clock.now = (offline.expiresAt as number) + 1;
    expect(() => env.instance.service.tick(env.clock.now)).not.toThrow();
    // 事务失败：房间仍在库里、缓存与墓碑都不变，等待下次 tick 重试
    expect(db.getRoom(game.code)).not.toBeNull();
    expect(db.isExpiredCode(game.code)).toBe(false);
    expect(env.instance.service.loadedRoomCount()).toBe(1);
    // 房间自身的到期时间已过，读接口仍按“已过期”回答；物理清理留到下次 tick 重试
    const stillThere = await env.api('GET', `/api/rooms/${game.code}/state`, { token: game.host.token });
    expect(stillThere.status).toBe(410);
    expect(env.instance.db.isExpiredCode(game.code)).toBe(false); // 墓碑尚未写入

    // 恢复后同一 tick 能正常清理，归档补齐
    (db as unknown as { saveArchive: typeof original }).saveArchive = original;
    env.instance.service.tick(env.clock.now);
    spy.mockRestore();
    expect(db.getRoom(game.code)).toBeNull();
    expect(db.isExpiredCode(game.code)).toBe(true);
    expect(db.listArchives(game.code, offline.createdAt)).toHaveLength(1);
  });

  it('完成或回到等待室后，从这次状态转换起重新计算 24 小时', async () => {
    const env = await startServer({ dice: [WUHONG] });
    const game = await startTwoPlayerGameWithSockets(env, { config: createDefaultRoomConfig() });
    await rollOnce(env, game.code, game.host.token, game.room.turnId as string);
    env.clock.now += 20 * 3600 * 1000; // 距创建已过 20 小时

    const ended = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'end' }, token: game.host.token });
    expect(ended.status).toBe(200);
    const finished = ended.body.room as RoomState;
    expect(finished.status).toBe('finished');
    expect(finished.finishedReason).toBe('host-ended');
    expect(finished.incomplete).toBe(true);
    expect(finished.expiresAt).toBe(env.clock.now + DAY_MS);
    expect(finished.players.find((player) => player.id === game.host.playerId)?.awards.zhuangyuan).toBe(1);

    const rematch = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'rematch' }, token: game.host.token });
    expect(rematch.status).toBe(200);
    const waiting = rematch.body.room as RoomState;
    expect(waiting.status).toBe('waiting');
    expect(waiting.incomplete).toBe(false);
    expect(waiting.finishedReason).toBeNull();
    expect(waiting.champion).toBeNull();
    expect(waiting.expiresAt).toBe(env.clock.now + DAY_MS);
    const defaults = createDefaultRoomConfig();
    expect(waiting.config).toEqual(defaults);
    expect(waiting.initialPool).toEqual({ zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 32 });
    expect(waiting.pool).toEqual(waiting.initialPool);

    // 再开一局沿用房间配置：客人重新准备后即可开局
    await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'ready', ready: true }, token: game.guest.token });
    const started = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'start' }, token: game.host.token });
    expect(started.status).toBe(200);
    expect((started.body.room as RoomState).expiresAt).toBeNull();
  });
});

describe('结束归档', () => {
  it('普通奖发完正常结束时写入独立归档，清理房间后归档仍可读（A01、A03）', async () => {
    const config = createDefaultRoomConfig();
    for (const key of PRIZE_KEYS) config.prizes[key] = { count: 1, content: '' };
    const env = await startServer({ dice: [DUITANG, SANHONG, SIJIN, ERJU, YIXIU, WUHONG] });
    const game = await startTwoPlayerGameWithSockets(env, { config });

    for (let i = 0; i < 6; i++) {
      const state = await env.roomState(game.code, game.host.token);
      const token = state.turnPlayerId === game.host.playerId ? game.host.token : game.guest.token;
      const rolled = await rollOnce(env, game.code, token, state.turnId as string);
      expect(rolled.status, `第 ${i + 1} 手`).toBe(200);
      // 最后一手同样要读完展示阶段才结算（结算页不能吞掉最后一次结果）
      await readThroughPresentation(env, game.code, game.host.token);
    }
    const finished = await env.roomState(game.code, game.host.token);
    expect(finished.status).toBe('finished');
    expect(finished.finishedReason).toBe('pool-empty');
    expect(finished.incomplete).toBe(false);
    expect(finished.champion?.playerId).toBe(game.guest.playerId);
    expect(finished.pool.zhuangyuan).toBe(0);
    expect(finished.players.find((player) => player.id === game.guest.playerId)?.awards.zhuangyuan).toBe(1);

    const archives = env.instance.db.listArchives(game.code, finished.createdAt);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.gameNumber).toBe(1);
    expect(archives[0]!.reason).toBe('pool-empty');
    expect(archives[0]!.incomplete).toBe(false);
    expect(archives[0]!.stateJson).toContain('"yixiu":1');
    expect(archives[0]!.stateJson).not.toContain('tokenHash');

    // 结束 24 小时后清理：房间行删除，归档与旧完成表都不受影响
    env.clock.now = (finished.expiresAt as number) + 1;
    env.instance.service.tick(env.clock.now);
    expect(env.instance.db.getRoom(game.code)).toBeNull();
    expect(env.instance.db.listArchives(game.code, finished.createdAt)).toHaveLength(1);
    const expiredState = await env.api('GET', `/api/rooms/${game.code}/state`, { token: game.host.token });
    expect(expiredState.status).toBe(410);
  });

  it('固定轮数局整局因超时结束（结算发生在 tick 内）也写入归档', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGameWithSockets(env, { maxRounds: 5 });
    for (let i = 0; i < 10; i++) {
      const state = await env.roomState(game.code, game.host.token);
      if (state.status !== 'playing') break;
      expect(state.deadline, `第 ${i + 1} 次超时前应处于回合计时中`).not.toBeNull();
      env.clock.now = state.deadline as number;
      env.instance.service.tick(env.clock.now);
      // 超时同样进入展示阶段：读完展示才算轮转/结算完成
      await readThroughPresentation(env, game.code, game.host.token);
    }
    const finished = await env.roomState(game.code, game.host.token);
    expect(finished.status).toBe('finished');
    expect(finished.finishedReason).toBe('round-limit');
    expect(finished.players.reduce((sum, player) => sum + player.timeoutCount, 0)).toBe(10);
    expect(finished.champion).toBeNull();
    // 最后一次超时同时完成结算：到期时间从结算时刻起算
    expect(finished.expiresAt).toBe(env.clock.now + DAY_MS);
    const archives = env.instance.db.listArchives(game.code, finished.createdAt);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.reason).toBe('round-limit');
    expect(archives[0]!.incomplete).toBe(false);
  });

  it('中止、全员离席与再开一局都各自留痕，且再开一局不重复归档同一局', async () => {
    const env = await startServer({ dice: [NONE] });
    const game = await startTwoPlayerGameWithSockets(env, { config: createDefaultRoomConfig() });
    await rollOnce(env, game.code, game.host.token, game.room.turnId as string);
    const ended = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'end' }, token: game.host.token });
    const finished = ended.body.room as RoomState;
    expect(env.instance.db.listArchives(game.code, finished.createdAt)).toHaveLength(1);

    const rematch = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'rematch' }, token: game.host.token });
    expect(rematch.status).toBe(200);
    const waiting = rematch.body.room as RoomState;
    const archives = env.instance.db.listArchives(game.code, waiting.createdAt);
    expect(archives).toHaveLength(1); // 同一局只归档一次
    expect(archives[0]!.reason).toBe('host-ended');
    expect(env.instance.db.counts().completedGames).toBe(1); // 旧表仍保留兼容记录
    expect(env.instance.db.counts().archives).toBe(1);
  });
});

/**
 * 以下为 2026-09-27「局内体验、数字房码与大厅旁观」的服务层验收：
 * 结果展示阶段、房间节奏／访问设置、大厅、只读旁观与旧数据迁移。
 */

/** 确定性数字房码序列（六位，含前导零场景由调用方自行构造）。 */
function numericCodeSequence(codes: string[]): () => string {
  let index = 0;
  return () => codes[index++] ?? codes[codes.length - 1]!;
}

const updatePacing = (env: TestEnv, code: string, token: string, pacing: unknown): Promise<ApiResult> =>
  env.api('POST', `/api/rooms/${code}/actions`, { body: { type: 'update-pacing', pacing }, token });

const updateAccess = (env: TestEnv, code: string, token: string, access: unknown): Promise<ApiResult> =>
  env.api('POST', `/api/rooms/${code}/actions`, { body: { type: 'update-access', access }, token });

describe('房间节奏与访问设置：默认、校验与权限（A03、L02）', () => {
  it('省略 pacing／access 落到新房默认；显式非法一律 400 且不创建房间（回归）', async () => {
    // 这条用例固定住一个真实缺陷：create 曾把“省略 access”当成非法配置直接返回 400。
    const env = await startServer({ rateLimits: { createJoinPerMinute: 500 } });
    const omitted = await env.api('POST', '/api/rooms', {
      body: { nickname: '阿月', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5 },
    });
    expect(omitted.status).toBe(201);
    const created = omitted.body.room as RoomState;
    expect(created.pacing).toEqual({ resultHoldSeconds: DEFAULT_RESULT_HOLD_SECONDS });
    expect(created.access).toEqual({ visibility: 'public', allowSpectators: true });
    // 省略 pacing 与省略 access 是独立的：只给一项时另一项仍要落默认
    const onlyPacing = await env.api('POST', '/api/rooms', {
      body: { nickname: '阿月', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5, pacing: { resultHoldSeconds: 0 } },
    });
    expect(onlyPacing.status).toBe(201);
    expect((onlyPacing.body.room as RoomState).pacing).toEqual({ resultHoldSeconds: 0 });
    expect((onlyPacing.body.room as RoomState).access).toEqual({ visibility: 'public', allowSpectators: true });
    const onlyAccess = await env.api('POST', '/api/rooms', {
      body: { nickname: '阿月', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5, access: { visibility: 'invite', allowSpectators: false } },
    });
    expect(onlyAccess.status).toBe(201);
    expect((onlyAccess.body.room as RoomState).pacing).toEqual({ resultHoldSeconds: DEFAULT_RESULT_HOLD_SECONDS });
    expect((onlyAccess.body.room as RoomState).access).toEqual({ visibility: 'invite', allowSpectators: false });

    const loadedBefore = env.instance.service.loadedRoomCount();
    const invalidAccess: unknown[] = [
      null,
      {},
      { visibility: 'public' },
      { allowSpectators: true },
      { visibility: 'secret', allowSpectators: true },
      { visibility: 'public', allowSpectators: 'yes' },
      { visibility: 'public', allowSpectators: 1 },
      [],
    ];
    for (const access of invalidAccess) {
      const result = await env.api('POST', '/api/rooms', {
        body: { nickname: '阿月', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5, access },
      });
      expect(result.status, `access=${JSON.stringify(access)}`).toBe(400);
      expect(result.body.error.code).toBe('INVALID_INPUT');
    }
    const invalidPacing: unknown[] = [
      null,
      {},
      { resultHoldSeconds: 11 },
      { resultHoldSeconds: -1 },
      { resultHoldSeconds: 1.5 },
      { resultHoldSeconds: '1' },
      { resultHoldSeconds: true },
      [],
    ];
    for (const pacing of invalidPacing) {
      const result = await env.api('POST', '/api/rooms', {
        body: { nickname: '阿月', name: '中秋团圆局', maxPlayers: 2, maxRounds: 5, pacing },
      });
      expect(result.status, `pacing=${JSON.stringify(pacing)}`).toBe(400);
      expect(result.body.error.code).toBe('INVALID_INPUT');
    }
    // 非法配置在生成房码之前就被拒绝：不留下半个房间
    expect(env.instance.service.loadedRoomCount()).toBe(loadedBefore);
  });

  it('显式合法的节奏与访问被接受，未知字段被丢弃', async () => {
    const env = await startServer();
    const created = await createRoom(env, {
      maxPlayers: 4,
      pacing: { resultHoldSeconds: 0, extra: 'ignored' },
      access: { visibility: 'invite', allowSpectators: true, extra: 'ignored' },
    });
    expect(created.room.pacing).toEqual({ resultHoldSeconds: 0 });
    expect(created.room.access).toEqual({ visibility: 'invite', allowSpectators: true });
    // 仅邀请不出现在大厅，但持有房码仍能访问概况与（允许时）旁观
    const lobby = await env.api('GET', '/api/rooms?filter=all&limit=50');
    expect((lobby.body.rooms as LobbyRoomSummary[]).map((room) => room.code)).not.toContain(created.code);
    const preview = await env.api('GET', `/api/rooms/${created.code}`);
    expect(preview.body.access).toEqual({ visibility: 'invite', allowSpectators: true });
    expect(preview.body.pacing).toEqual({ resultHoldSeconds: 0 });
    const watch = await env.api('GET', `/api/rooms/${created.code}/watch`);
    expect(watch.status).toBe(200);
  });

  it('只有未离席房主能改节奏与访问；无凭证 401、非房主 403、非法值不落盘', async () => {
    const env = await startServer();
    const waiting = await waitingRoomWithReadyGuest(env);
    const before = waiting.room;

    for (const result of [
      await updatePacing(env, waiting.code, waiting.guest.token, { resultHoldSeconds: 3 }),
      await updateAccess(env, waiting.code, waiting.guest.token, { visibility: 'invite', allowSpectators: false }),
    ]) {
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe('HOST_ONLY');
    }

    const noToken = await env.api('POST', `/api/rooms/${waiting.code}/actions`, {
      body: { type: 'update-pacing', pacing: { resultHoldSeconds: 2 } },
    });
    expect(noToken.status).toBe(401);
    expect(noToken.body.error.code).toBe('INVALID_TOKEN');

    for (const pacing of [{ resultHoldSeconds: 11 }, { resultHoldSeconds: 1.5 }, {}, null, undefined]) {
      const result = await updatePacing(env, waiting.code, waiting.host.token, pacing);
      expect(result.status, `pacing=${JSON.stringify(pacing)}`).toBe(400);
      expect(result.body.error.code).toBe('INVALID_INPUT');
    }
    for (const access of [{ visibility: 'public' }, { visibility: 'public', allowSpectators: 1 }, null, undefined]) {
      const result = await updateAccess(env, waiting.code, waiting.host.token, access);
      expect(result.status, `access=${JSON.stringify(access)}`).toBe(400);
      expect(result.body.error.code).toBe('INVALID_INPUT');
    }
    const unchanged = await env.roomState(waiting.code, waiting.host.token);
    expect(unchanged.revision).toBe(before.revision);
    expect(unchanged.pacing).toEqual(before.pacing);
    expect(unchanged.access).toEqual(before.access);

    // 没有实际变化不算改动：不递增 revision、不重置准备
    const same = await updatePacing(env, waiting.code, waiting.host.token, { resultHoldSeconds: before.pacing.resultHoldSeconds });
    expect(same.status).toBe(200);
    expect((same.body.room as RoomState).revision).toBe(before.revision);
    expect((same.body.room as RoomState).players.find((player) => player.id === waiting.guest.playerId)?.ready).toBe(true);
  });

  it('结束后（finished）房主仍可调整节奏与访问，供下一局沿用', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const ended = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'end' }, token: game.host.token });
    expect(ended.status).toBe(200);
    expect((ended.body.room as RoomState).status).toBe('finished');

    const pacing = await updatePacing(env, game.code, game.host.token, { resultHoldSeconds: 4 });
    expect(pacing.status).toBe(200);
    expect((pacing.body.room as RoomState).pacing).toEqual({ resultHoldSeconds: 4 });
    const access = await updateAccess(env, game.code, game.host.token, { visibility: 'invite', allowSpectators: false });
    expect(access.status).toBe(200);
    expect((access.body.room as RoomState).access).toEqual({ visibility: 'invite', allowSpectators: false });

    const rematch = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'rematch' }, token: game.host.token });
    expect(rematch.status).toBe(200);
    const waiting = rematch.body.room as RoomState;
    expect(waiting.status).toBe('waiting');
    expect(waiting.pacing).toEqual({ resultHoldSeconds: 4 });
    expect(waiting.access).toEqual({ visibility: 'invite', allowSpectators: false });
  });

  it('改节奏不重置准备、库存、到期时间与进行中的展示，且从下一条记录生效', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const rolled = await rollOnce(env, game.code, game.host.token, game.room.turnId as string);
    expect(rolled.status).toBe(200);
    const during = rolled.body.room as RoomState;
    expect(during.presentation?.until).toBe(env.clock.now + DICE_REVEAL_MS + DEFAULT_RESULT_HOLD_SECONDS * 1000);
    const poolBefore = during.pool;

    const updated = await updatePacing(env, game.code, game.host.token, { resultHoldSeconds: 5 });
    expect(updated.status).toBe(200);
    const after = updated.body.room as RoomState;
    expect(after.pacing).toEqual({ resultHoldSeconds: 5 });
    // 正在进行的结果展示原样保留：节奏只影响下一条记录
    expect(after.presentation).toEqual(during.presentation);
    expect(after.deadline).toBeNull();
    expect(after.expiresAt).toBeNull();
    expect(after.pool).toEqual(poolBefore);
    expect(after.history).toHaveLength(1);
    expect(after.players.find((player) => player.id === game.host.playerId)?.rollCount).toBe(1);

    // 展示仍按旧节奏结束，读完才轮到下一位
    const handedOver = await readThroughPresentation(env, game.code, game.host.token);
    expect(handedOver.turnPlayerId).toBe(game.guest.playerId);
    expect(handedOver.deadline! - env.clock.now).toBe(TURN_MS);

    // 下一条记录使用新节奏：动画 750ms + 5 秒停留
    const next = await rollOnce(env, game.code, game.guest.token, handedOver.turnId as string);
    expect(next.status).toBe(200);
    expect((next.body.room as RoomState).presentation?.until).toBe(env.clock.now + DICE_REVEAL_MS + 5_000);
  });

  it('改访问设置不重置准备、库存与回合；关闭旁观立即撤销旁观入口', async () => {
    const env = await startServer();
    const waiting = await waitingRoomWithReadyGuest(env);
    const before = waiting.room;
    const updated = await updateAccess(env, waiting.code, waiting.host.token, { visibility: 'invite', allowSpectators: false });
    expect(updated.status).toBe(200);
    const after = updated.body.room as RoomState;
    expect(after.access).toEqual({ visibility: 'invite', allowSpectators: false });
    expect(after.players.find((player) => player.id === waiting.guest.playerId)?.ready).toBe(true);
    expect(after.pool).toEqual(before.pool);
    expect(after.pacing).toEqual(before.pacing);
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.status).toBe('waiting');

    const watch = await env.api('GET', `/api/rooms/${waiting.code}/watch`);
    expect(watch.status).toBe(403);
    expect(watch.body.error.code).toBe('SPECTATING_DISABLED');
    const lobby = await env.api('GET', '/api/rooms?filter=all&limit=50');
    expect((lobby.body.rooms as LobbyRoomSummary[]).map((room) => room.code)).not.toContain(waiting.code);
    // 仅邀请只影响大厅：持有链接的人仍能看到概况
    expect((await env.api('GET', `/api/rooms/${waiting.code}`)).status).toBe(200);
  });
});

describe('游戏大厅（GET /api/rooms）', () => {
  it('默认只列可加入的公开房间，摘要不含成员信息与凭证', async () => {
    const env = await startServer();
    const open = await createRoom(env, { maxPlayers: 4 });
    await createRoom(env, { nickname: '阿桂', maxPlayers: 4, access: { visibility: 'invite', allowSpectators: true } });
    const full = await createRoom(env, { nickname: '阿明', maxPlayers: 2 });
    await joinRoom(env, full.code, '小满');
    const playing = await createRoom(env, { nickname: '小月', maxPlayers: 2 });
    const playingGuest = await joinRoom(env, playing.code, '小饼');
    env.instance.service.connectMember(playing.code, playing.membership.token);
    env.instance.service.connectMember(playing.code, playingGuest.membership.token);
    await env.api('POST', `/api/rooms/${playing.code}/actions`, { body: { type: 'ready', ready: true }, token: playingGuest.membership.token });
    const started = await env.api('POST', `/api/rooms/${playing.code}/actions`, { body: { type: 'start' }, token: playing.membership.token });
    expect(started.status).toBe(200);

    const joinable = await env.api('GET', '/api/rooms');
    expect(joinable.status).toBe(200);
    expect((joinable.body.rooms as LobbyRoomSummary[]).map((room) => room.code)).toEqual([open.code]);
    expect(joinable.body.nextCursor).toBeNull();
    expect(joinable.body.rooms[0]).toEqual({
      code: open.code,
      name: '中秋团圆局',
      status: 'waiting',
      playerCount: 1,
      onlinePlayerCount: 0,
      maxPlayers: 4,
      rulesetName: open.room.ruleset.name,
      endCondition: open.room.config.endCondition,
      canJoin: true,
      allowSpectators: true,
      createdAt: open.room.createdAt,
    });
    assertNoSecrets(joinable.body, open.membership.token);
    expect(JSON.stringify(joinable.body)).not.toContain('阿月'); // 不含玩家昵称
    expect(joinable.body.rooms[0].players).toBeUndefined(); // 不展开成员列表

    const all = await env.api('GET', '/api/rooms?filter=all&limit=50');
    expect((all.body.rooms as LobbyRoomSummary[]).map((room) => room.code).sort()).toEqual(
      [open.code, full.code, playing.code].sort(),
    );
    const playingOnly = await env.api('GET', '/api/rooms?filter=playing&limit=50');
    expect((playingOnly.body.rooms as LobbyRoomSummary[]).map((room) => room.code)).toEqual([playing.code]);
    expect(playingOnly.body.rooms[0].canJoin).toBe(false);
    expect(playingOnly.body.rooms[0].onlinePlayerCount).toBe(2);
  });

  it('finished／closed／过期房间不出现在大厅；重开后回到 waiting', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGameWithSockets(env);
    const ended = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'end' }, token: game.host.token });
    expect(ended.status).toBe(200);
    const afterEnd = await env.api('GET', '/api/rooms?filter=all&limit=50');
    expect((afterEnd.body.rooms as LobbyRoomSummary[]).map((room) => room.code)).not.toContain(game.code);

    const rematch = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'rematch' }, token: game.host.token });
    expect(rematch.status).toBe(200);
    const afterRematch = await env.api('GET', '/api/rooms?filter=all&limit=50');
    const listed = (afterRematch.body.rooms as LobbyRoomSummary[]).find((room) => room.code === game.code);
    expect(listed?.status).toBe('waiting');

    // 全员离开（等待室）会关闭房间，从大厅消失
    await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'leave' }, token: game.guest.token });
    const closed = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'leave' }, token: game.host.token });
    expect(closed.status).toBe(200);
    expect((closed.body.room as RoomState).status).toBe('closed');
    const afterClose = await env.api('GET', '/api/rooms?filter=all&limit=50');
    expect((afterClose.body.rooms as LobbyRoomSummary[]).map((room) => room.code)).not.toContain(game.code);

    // 已过期的房间也不列出
    env.clock.now += DAY_MS + 1;
    env.instance.service.tick(env.clock.now);
    const afterExpiry = await env.api('GET', '/api/rooms?filter=all&limit=50');
    expect(afterExpiry.body.rooms).toEqual([]);
    expect(afterExpiry.body.nextCursor).toBeNull();
  });

  it('默认 limit=20，cursor 为 {createdAt,code}：翻页不重叠、不遗漏', async () => {
    const env = await startServer({ createRoomCode: numericCodeSequence(Array.from({ length: 21 }, (_, i) => String(700000 + i))) });
    for (let i = 0; i < 21; i++) await createRoom(env, { nickname: '阿月', maxPlayers: 4 });

    const page1 = await env.api('GET', '/api/rooms?filter=all');
    expect(page1.body.rooms).toHaveLength(20);
    expect(page1.body.nextCursor).not.toBeNull();
    const page2 = await env.api('GET', `/api/rooms?filter=all&cursor=${encodeURIComponent(page1.body.nextCursor as string)}`);
    expect(page2.body.rooms).toHaveLength(1);
    expect(page2.body.nextCursor).toBeNull();
    const codes = [...page1.body.rooms, ...page2.body.rooms].map((room: LobbyRoomSummary) => room.code);
    expect(new Set(codes).size).toBe(21);
    // createdAt 相同时按 code 升序，顺序稳定
    expect(codes).toEqual([...codes].sort());

    // limit 用尽且没有更多结果时不给出 cursor
    const single = await env.api('GET', '/api/rooms?filter=all&limit=50');
    expect(single.body.rooms).toHaveLength(21);
    expect(single.body.nextCursor).toBeNull();
  });

  it('limit 与 filter 越界、cursor 不合法一律 400 INVALID_INPUT', async () => {
    const env = await startServer();
    await createRoom(env, { maxPlayers: 4 });
    const bad = [
      '?limit=0',
      '?limit=51',
      '?limit=abc',
      '?limit=2.5',
      '?filter=weird',
      '?filter=',
      '?cursor=bm90anNvbg', // base64url("notjson")
      '?cursor=%7B%22createdAt%22%3A1%2C%22code%22%3A%22ABC%22%7D',
    ];
    for (const query of bad) {
      const result = await env.api('GET', `/api/rooms${query}`);
      expect(result.status, query).toBe(400);
      expect(result.body.error.code).toBe('INVALID_INPUT');
    }
  });

  it('大厅遍历持久化目录而不是内存缓存，且不改变房间状态', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 4 });
    const before = await env.roomState(created.code, created.membership.token);

    // 另一个服务实例视角：同一数据库、空缓存
    const other = new RoomService({ db: env.instance.db, now: () => env.clock.now });
    const page = other.listLobby({ filter: 'all', limit: 20, cursor: null });
    expect(page.rooms.map((room) => room.code)).toEqual([created.code]);

    const after = await env.roomState(created.code, created.membership.token);
    expect(after.revision).toBe(before.revision);
    expect(after.expiresAt).toBe(before.expiresAt);
  });
});

describe('只读旁观入口（GET /api/rooms/:code/watch）', () => {
  it('不需要成员凭证，也不改变在线状态、到期时间或 revision', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 4 });
    const before = created.room;
    expect(before.access.allowSpectators).toBe(true);

    const watcher = await env.api('GET', `/api/rooms/${created.code}/watch`);
    expect(watcher.status).toBe(200);
    const watched = watcher.body.room as RoomState;
    expect(watched.code).toBe(created.code);
    expect(watched.revision).toBe(before.revision);
    expect(watched.players.every((player) => !player.online)).toBe(true);
    expect(watched.expiresAt).toBe(before.expiresAt);
    assertNoSecrets(watched, created.membership.token);

    // 多次旁观、切换角色都不会续期或改变离线起点
    env.clock.now += 3600 * 1000;
    await env.api('GET', `/api/rooms/${created.code}/watch`);
    const state = await env.roomState(created.code, created.membership.token);
    expect(state.expiresAt).toBe(before.expiresAt);
    expect(state.revision).toBe(before.revision);
  });

  it('关闭旁观 403、房间不存在 404、房码非法 400、已过期 410', async () => {
    const env = await startServer();
    const created = await createRoom(env, {
      maxPlayers: 4,
      access: { visibility: 'public', allowSpectators: false },
    });
    const disabled = await env.api('GET', `/api/rooms/${created.code}/watch`);
    expect(disabled.status).toBe(403);
    expect(disabled.body.error.code).toBe('SPECTATING_DISABLED');

    const unknown = await env.api('GET', '/api/rooms/654321/watch');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('ROOM_NOT_FOUND');

    const bad = await env.api('GET', '/api/rooms/ABCDE0/watch');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_INPUT');

    env.clock.now += DAY_MS + 1;
    const expired = await env.api('GET', `/api/rooms/${created.code}/watch`);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe('ROOM_EXPIRED');
  });

  it('已关闭的房间不允许旁观', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 4 });
    const left = await env.api('POST', `/api/rooms/${created.code}/actions`, { body: { type: 'leave' }, token: created.membership.token });
    expect((left.body.room as RoomState).status).toBe('closed');
    const watch = await env.api('GET', `/api/rooms/${created.code}/watch`);
    expect(watch.status).toBe(409);
    expect(watch.body.error.code).toBe('INVALID_STATE');
  });
});

describe('观众连接：只读、去重计数与撤销（L04、L05、L06）', () => {
  it('未知 role 被拒绝，成员凭证失败不会被降级成观众', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 4 });

    const unknownRole = await connectFailure(env, { role: 'moderator', roomCode: created.code });
    expect(unknownRole.data?.code).toBe('INVALID_INPUT');

    // 没有 role 且凭证错误：按成员处理并拒绝，不能悄悄变成只读观众
    const badToken = await connectFailure(env, { roomCode: created.code, token: 'c'.repeat(64) });
    expect(badToken.data?.code).toBe('INVALID_TOKEN');
    const explicitMember = await connectFailure(env, { role: 'member', roomCode: created.code, token: 'c'.repeat(64) });
    expect(explicitMember.data?.code).toBe('INVALID_TOKEN');
    const missingToken = await connectFailure(env, { role: 'member', roomCode: created.code });
    expect(missingToken.data?.code).toBe('INVALID_TOKEN');

    // 观众必须带 viewerId；未知房间也要拒绝
    const noViewer = await connectFailure(env, { role: 'spectator', roomCode: created.code });
    expect(noViewer.data?.code).toBe('INVALID_INPUT');
    const unknownRoom = await connectFailure(env, { role: 'spectator', roomCode: '654321', viewerId: crypto.randomUUID() });
    expect(unknownRoom.data?.code).toBe('ROOM_NOT_FOUND');

    // 关闭旁观的房间拒绝观众订阅
    const disabled = await createRoom(env, { nickname: '阿桂', access: { visibility: 'invite', allowSpectators: false } });
    const refused = await connectFailure(env, { role: 'spectator', roomCode: disabled.code, viewerId: crypto.randomUUID() });
    expect(refused.data?.code).toBe('SPECTATING_DISABLED');
  });

  it('同一 viewerId 的多连接只算一位访客，人数事件不改变游戏 revision', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 4 });
    const memberSocket = await connectSocket(env, { roomCode: created.code, token: created.membership.token });
    await memberSocket.log.wait((room) => room.players[0]?.online === true);
    const memberAudience: AudienceState[] = [];
    memberSocket.socket.on(SOCKET_EVENT_AUDIENCE, (payload: AudienceState) => memberAudience.push(payload));

    const before = await env.roomState(created.code, created.membership.token);
    const viewerId = crypto.randomUUID();
    const first = await connectSpectator(env, created.code, viewerId);
    await first.log.wait((room) => room.code === created.code);
    const second = await connectSpectator(env, created.code, viewerId);
    await second.log.wait((room) => room.code === created.code);
    const other = await connectSpectator(env, created.code);
    await other.log.wait((room) => room.code === created.code);

    await waitFor(() => env.instance.hub.audienceCount(created.code) === 2);
    await waitFor(() => first.audience.some((payload) => payload.viewerCount === 2));
    await waitFor(() => memberAudience.some((payload) => payload.viewerCount === 2));
    const audience = first.audience.at(-1);
    expect(audience).toEqual({ roomCode: created.code, viewerCount: 2 }); // 只含去重人数，没有身份信息

    // 观众连接不占席位、不改变游戏快照
    expect(await env.roomState(created.code, created.membership.token)).toEqual(before);
    expect(env.instance.hub.connectedCount(created.code)).toBe(1); // 成员频道里只有房主

    // 关掉同一访客的其中一个连接：人数不变
    second.socket.close();
    await waitFor(() => second.socket.connected === false);
    expect(env.instance.hub.audienceCount(created.code)).toBe(2);
    // 全部关掉后归零（在线的成员连接会收到最后一条人数事件）
    first.socket.close();
    other.socket.close();
    await waitFor(() => env.instance.hub.audienceCount(created.code) === 0);
    await waitFor(() => memberAudience.at(-1)?.viewerCount === 0);
  });

  it('观众标识不是成员凭证：不能读取成员状态或提交任何动作', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 4 });
    const spectator = await connectSpectator(env, created.code);
    await spectator.log.wait((room) => room.code === created.code);

    const state = await env.api('GET', `/api/rooms/${created.code}/state`, { token: spectator.viewerId });
    expect(state.status).toBe(401);
    expect(state.body.error.code).toBe('INVALID_TOKEN');

    for (const body of [{ type: 'ready', ready: true }, { type: 'start' }, { type: 'rematch' }, { type: 'end' }]) {
      const result = await env.api('POST', `/api/rooms/${created.code}/actions`, { body, token: spectator.viewerId });
      expect(result.status, JSON.stringify(body)).toBe(401);
      expect(result.body.error.code).toBe('INVALID_TOKEN');
    }
    // viewerId 也不是房码或凭证哈希：换一个房间同样无效
    const other = await createRoom(env, { nickname: '阿桂', maxPlayers: 4 });
    const crossRoom = await env.api('GET', `/api/rooms/${other.code}/state`, { token: spectator.viewerId });
    expect(crossRoom.status).toBe(401);

    const room = await env.roomState(created.code, created.membership.token);
    expect(room.players).toHaveLength(1);
    expect(room.players.every((player) => !player.online)).toBe(true);
  });

  it('观众在线不阻止全员离线暂停，也不延长到期时间；观众刷新不影响离线起点', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGameWithSockets(env);
    const spectator = await connectSpectator(env, game.code);
    await spectator.log.wait((room) => room.code === game.code);
    expect(env.instance.hub.audienceCount(game.code)).toBe(1);

    game.hostSocket.socket.close();
    game.guestSocket.socket.close();
    await waitFor(async () => (await env.roomState(game.code, game.host.token)).paused === true);
    const offline = await env.roomState(game.code, game.host.token);
    expect(offline.paused).toBe(true);
    expect(offline.allOfflineSince).toBe(env.clock.now);
    expect(offline.expiresAt).toBe(env.clock.now + DAY_MS);
    expect(offline.deadline).toBeNull();

    // 观众还在看：刷新连接不改变离线起点与到期时间
    spectator.socket.close();
    await waitFor(() => env.instance.hub.audienceCount(game.code) === 0);
    const again = await connectSpectator(env, game.code);
    await again.log.wait((room) => room.code === game.code);
    env.clock.now += 3600 * 1000;
    env.instance.service.tick(env.clock.now);
    const after = await env.roomState(game.code, game.host.token);
    expect(after.allOfflineSince).toBe(offline.allOfflineSince);
    expect(after.expiresAt).toBe(offline.expiresAt);
    expect(after.paused).toBe(true);
    expect(after.status).toBe('playing');
  });

  it('房主关闭旁观：先发 watch-ended 再断开观众，成员连接不受影响，之后不再推快照', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGameWithSockets(env);
    const spectator = await connectSpectator(env, game.code);
    await spectator.log.wait((room) => room.code === game.code);
    const guestMarker = game.guestSocket.log.mark();

    const updated = await updateAccess(env, game.code, game.host.token, { visibility: 'public', allowSpectators: false });
    expect(updated.status).toBe(200);
    await waitFor(() => spectator.ended.length === 1);
    expect(spectator.ended[0]?.code).toBe('SPECTATING_DISABLED');
    await waitFor(() => spectator.socket.connected === false);
    await waitFor(() => env.instance.hub.audienceCount(game.code) === 0);
    // 成员照常在线并收到新设置
    expect(game.hostSocket.socket.connected).toBe(true);
    expect(game.guestSocket.socket.connected).toBe(true);
    const memberRoom = await game.guestSocket.log.wait((room) => room.access.allowSpectators === false, { after: guestMarker });
    expect(memberRoom.access.visibility).toBe('public');

    // 撤销之后房间继续推进，也不再推给已断开的观众
    const spectatorSnapshots = spectator.log.all.length;
    const guestSnapshots = game.guestSocket.log.all.length;
    env.clock.now += TURN_MS;
    env.instance.service.tick(env.clock.now);
    await waitFor(async () => (await env.roomState(game.code, game.host.token)).history.length >= 1);
    expect(spectator.log.all.length).toBe(spectatorSnapshots);
    expect(game.guestSocket.log.all.length).toBeGreaterThan(guestSnapshots);
  });

  it('房间到期清理会先说明原因再断开观众连接', async () => {
    const env = await startServer();
    const created = await createRoom(env, { maxPlayers: 4 });
    const spectator = await connectSpectator(env, created.code);
    await spectator.log.wait((room) => room.code === created.code);

    env.clock.now += DAY_MS + 1;
    env.instance.service.tick(env.clock.now);
    await waitFor(() => spectator.ended.length === 1);
    expect(spectator.ended[0]?.code).toBe('ROOM_EXPIRED');
    await waitFor(() => spectator.socket.connected === false);
    expect(env.instance.hub.audienceCount(created.code)).toBe(0);
    expect(env.instance.db.getRoom(created.code)).toBeNull();
  });
});

describe('结果展示阶段的时序边界（E03、E04）', () => {
  it('0 秒停留：保留掷骰动画，动画结束后立即交给下一位；超时 0 秒同一 tick 内完成', async () => {
    const env = await startServer({ dice: [NONE] });
    const game = await startTwoPlayerGame(env);
    const set = await updatePacing(env, game.code, game.host.token, { resultHoldSeconds: 0 });
    expect(set.status).toBe(200);

    const rolled = await rollOnce(env, game.code, game.host.token, game.room.turnId as string);
    expect(rolled.status).toBe(200);
    expect((rolled.body.room as RoomState).presentation?.until).toBe(env.clock.now + DICE_REVEAL_MS);
    // 动画没走完就不能开下一手
    expect(env.instance.service.tick(env.clock.now + DICE_REVEAL_MS - 1)).toEqual([]);
    env.clock.now += DICE_REVEAL_MS;
    expect(env.instance.service.tick(env.clock.now)).toEqual([game.code]);
    const handedOver = await env.roomState(game.code, game.host.token);
    expect(handedOver.presentation).toBeNull();
    expect(handedOver.turnPlayerId).toBe(game.guest.playerId);
    expect(handedOver.deadline! - env.clock.now).toBe(TURN_MS);

    // 超时没有动画：0 秒停留允许在同一 tick 内完成展示并交给下一位
    env.clock.now = handedOver.deadline as number;
    expect(env.instance.service.tick(env.clock.now)).toEqual([game.code]);
    const afterTimeout = await env.roomState(game.code, game.host.token);
    expect(afterTimeout.history.filter((record) => record.reason === 'timeout')).toHaveLength(1);
    expect(afterTimeout.presentation).toBeNull();
    expect(afterTimeout.turnPlayerId).toBe(game.host.playerId);
    expect(afterTimeout.round).toBe(2);
    expect(afterTimeout.deadline! - env.clock.now).toBe(TURN_MS);
  });

  it('10 秒停留是上限：下一手在动画加停留之后才开放，且拿到完整三十秒', async () => {
    const env = await startServer({ dice: [NONE] });
    const game = await startTwoPlayerGame(env);
    expect((await updatePacing(env, game.code, game.host.token, { resultHoldSeconds: 10 })).status).toBe(200);

    const rolled = await rollOnce(env, game.code, game.host.token, game.room.turnId as string);
    expect(rolled.status).toBe(200);
    const until = (rolled.body.room as RoomState).presentation?.until as number;
    expect(until).toBe(env.clock.now + DICE_REVEAL_MS + 10_000);
    expect((await updatePacing(env, game.code, game.host.token, { resultHoldSeconds: 11 })).status).toBe(400);

    expect(env.instance.service.tick(until - 1)).toEqual([]);
    env.clock.now = until;
    expect(env.instance.service.tick(env.clock.now)).toEqual([game.code]);
    const handedOver = await env.roomState(game.code, game.host.token);
    expect(handedOver.turnPlayerId).toBe(game.guest.playerId);
    expect(handedOver.deadline! - env.clock.now).toBe(TURN_MS);
  });

  it('展示期间其他玩家不能抢先掷骰，读完后拿到新的 turnId', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const rolled = await rollOnce(env, game.code, game.host.token, game.room.turnId as string);
    expect(rolled.status).toBe(200);
    const during = rolled.body.room as RoomState;

    const early = await rollOnce(env, game.code, game.guest.token, during.turnId as string);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('RESULT_SHOWING');
    expect((await env.roomState(game.code, game.host.token)).history).toHaveLength(1);

    const handedOver = await readThroughPresentation(env, game.code, game.host.token);
    expect(handedOver.turnId).not.toBe(during.turnId);
    expect(handedOver.turnPlayerId).toBe(game.guest.playerId);
    const next = await rollThrough(env, game.code, game.guest.token, handedOver.turnId as string);
    expect(next.history).toHaveLength(2);
    expect(next.presentation).toBeNull();
    expect(next.round).toBe(2);
    expect(next.turnPlayerId).toBe(game.host.playerId);
    expect(next.deadline! - env.clock.now).toBe(TURN_MS);
  });

  it('公开快照与归档保留个人最后结果与完整状元历程，且不含凭证', async () => {
    const env = await startServer({ dice: [DUITANG, SANHONG, SIJIN, ERJU, YIXIU, WUHONG] });
    const config = createDefaultRoomConfig();
    for (const key of PRIZE_KEYS) config.prizes[key] = { count: 1, content: `奖品-${key}` };
    const game = await startTwoPlayerGameWithSockets(env, { config });
    for (let i = 0; i < 6; i++) {
      const state = await env.roomState(game.code, game.host.token);
      const token = state.turnPlayerId === game.host.playerId ? game.host.token : game.guest.token;
      expect((await rollOnce(env, game.code, token, state.turnId as string)).status, `第 ${i + 1} 手`).toBe(200);
      await readThroughPresentation(env, game.code, game.host.token);
    }
    const finished = await env.roomState(game.code, game.host.token);
    expect(finished.status).toBe('finished');
    expect(finished.championHistoryComplete).toBe(true);
    expect(finished.championEvents.map((event) => event.kind)).toEqual(['first', 'settled']);
    const settled = finished.championEvents.find((event) => event.kind === 'settled');
    expect(settled?.awardedCount).toBe(1);
    expect(settled?.recordId).toBeNull();
    // 每人的个人最后结果独立保留，最后一手是客人的状元记录
    const hostLast = finished.players.find((player) => player.id === game.host.playerId)?.lastRoll;
    const guestLast = finished.players.find((player) => player.id === game.guest.playerId)?.lastRoll;
    expect(hostLast?.result?.code).toBe('yixiu');
    expect(guestLast?.result?.code).toBe('wuhong');
    expect(guestLast?.championOutcome?.kind).toBe('first');
    assertNoSecrets(finished, game.host.token);

    const archives = env.instance.db.listArchives(game.code, finished.createdAt);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.stateJson).not.toContain('tokenHash');
    const archived = JSON.parse(archives[0]!.stateJson) as RoomState;
    expect(archived.presentation).toBeNull();
    expect(archived.deadline).toBeNull();
    expect(archived.championHistoryComplete).toBe(true);
    expect(archived.championEvents.map((event) => event.kind)).toEqual(['first', 'settled']);
    expect(archived.players.find((player) => player.id === game.guest.playerId)?.lastRoll?.result?.code).toBe('wuhong');
  });
});

describe('旧数据迁移在服务层的表现（L02 兼容）', () => {
  /** 旧格式（无 config、有 maxRounds）的房间快照：模拟升级前已经存在的房间。 */
  function legacyRoomSnapshot(token: string, at: number): Record<string, unknown> {
    return {
      code: 'LEGACY',
      name: '旧局',
      maxPlayers: 2,
      maxRounds: 10,
      rulesVersion: 'unified-v1',
      status: 'playing',
      hostId: 'legacy-host',
      revision: 7,
      players: [
        {
          id: 'legacy-host',
          nickname: '老房主',
          seat: 0,
          ready: true,
          online: true,
          left: false,
          awards: { zhuangyuan: 0, duitang: 1, sanhong: 0, sijin: 0, erju: 0, yixiu: 2 },
          best: { code: 'duitang', label: '对堂', prize: 'duitang', rankKey: [6, 0, 0] },
          tokenHash: hashToken(token),
          lastSeenAt: at,
        },
        {
          id: 'legacy-guest',
          nickname: '老客人',
          seat: 1,
          ready: true,
          online: false,
          left: false,
          awards: { zhuangyuan: 0, duitang: 0, sanhong: 0, sijin: 0, erju: 0, yixiu: 0 },
          best: null,
          tokenHash: hashToken('legacy-guest-token'),
          lastSeenAt: at,
        },
      ],
      gameNumber: 2,
      round: 4,
      turnPlayerId: 'legacy-guest',
      turnId: '11111111-1111-4111-8111-111111111111',
      deadline: at + TURN_MS,
      paused: false,
      pool: { zhuangyuan: 1, duitang: 1, sanhong: 4, sijin: 8, erju: 16, yixiu: 30 },
      champion: null,
      history: [
        { id: 'lr1', playerId: 'legacy-host', nickname: '老房主', round: 1, turnId: 'a', dice: DUITANG, result: null, awarded: 'duitang', reason: 'rolled', at: at - 3 },
        { id: 'lr2', playerId: 'legacy-guest', nickname: '老客人', round: 1, turnId: 'b', dice: NONE, result: null, awarded: null, reason: 'timeout', at: at - 2 },
        {
          id: 'lr3',
          playerId: 'legacy-host',
          nickname: '老房主',
          round: 3,
          turnId: 'c',
          dice: WUHONG,
          result: { code: 'wuhong', label: '五红', prize: 'zhuangyuan', rankKey: [8, 6, 0] },
          awarded: null,
          reason: 'rolled',
          at: at - 1,
        },
      ],
      pendingFinish: null,
      finishedReason: null,
      createdAt: at - DAY_MS,
      expiresAt: null,
    };
  }

  it('旧房间迁移为仅邀请并关闭旁观：不出现在大厅、不开放旁观、不伪造登顶事实', async () => {
    // 真实升级路径：旧行先落库，服务重启时由 onBoot 归一化并恢复
    const bootstrap = await startServer();
    const token = 'a'.repeat(64);
    bootstrap.instance.db.saveRoom({
      code: 'LEGACY',
      stateJson: JSON.stringify(legacyRoomSnapshot(token, bootstrap.clock.now)),
      expiresAt: null,
      revision: 7,
    });
    await bootstrap.close();

    const env = await startServer({ dataDir: bootstrap.dataDir, clock: bootstrap.clock });

    // 用原凭证仍能进入（迁移不破坏身份），但新字段一律按旧数据规则补齐
    const state = await env.roomState('LEGACY', token);
    expect(state.status).toBe('playing');
    expect(state.pacing).toEqual({ resultHoldSeconds: DEFAULT_RESULT_HOLD_SECONDS });
    expect(state.access).toEqual({ visibility: 'invite', allowSpectators: false });
    expect(state.presentation).toBeNull();
    expect(state.championHistoryComplete).toBe(false);
    expect(state.championEvents).toEqual([]);
    expect(state.champion).toBeNull();
    // 个人最佳不等于登顶证据：保留 best，但最后结果标成 legacy-unknown
    expect(state.players.find((player) => player.id === 'legacy-host')?.best?.code).toBe('duitang');
    expect(state.players.find((player) => player.id === 'legacy-host')?.lastRoll?.id).toBe('lr3');
    expect(state.players.find((player) => player.id === 'legacy-host')?.lastRoll?.championOutcome?.kind).toBe('legacy-unknown');
    // 整局重启后进入暂停，但离线起点只记一次
    expect(state.paused).toBe(true);
    expect(state.allOfflineSince).toBe(env.clock.now);
    expect(state.expiresAt).toBe(env.clock.now + DAY_MS);

    // 旧房间不会自动公开，也不会因为“允许旁观”默认值而开放观看
    const lobby = await env.api('GET', '/api/rooms?filter=all&limit=50');
    expect((lobby.body.rooms as LobbyRoomSummary[]).map((room) => room.code)).not.toContain('LEGACY');
    const watch = await env.api('GET', '/api/rooms/LEGACY/watch');
    expect(watch.status).toBe(403);
    expect(watch.body.error.code).toBe('SPECTATING_DISABLED');
    // 概况仍可读，便于老链接继续使用
    const preview = await env.api('GET', '/api/rooms/LEGACY');
    expect(preview.status).toBe(200);
    expect(preview.body.access).toEqual({ visibility: 'invite', allowSpectators: false });
  });
});
