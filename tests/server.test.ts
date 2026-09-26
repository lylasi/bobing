import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connectClient } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { createServerInstance } from '../server/index.js';
import type { ServerInstance } from '../server/index.js';
import { RoomService } from '../server/room-service.js';
import type { RateLimitOptions } from '../server/room-service.js';
import { AppDatabase } from '../server/db.js';
import { SOCKET_EVENT_ROOM_STATE } from '../shared/types.js';
import type { Membership, RoomState } from '../shared/types.js';

const NONE = [1, 1, 2, 2, 3, 3];
const WUHONG = [4, 4, 4, 4, 4, 6];
const TURN_MS = 30_000;

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
  overrides: { nickname?: string; name?: string; maxPlayers?: number; maxRounds?: number } = {},
): Promise<{ notification?: never; code: string; membership: Membership; room: RoomState }> {
  const result = await env.api('POST', '/api/rooms', {
    body: {
      nickname: overrides.nickname ?? '阿月',
      name: overrides.name ?? '中秋团圆局',
      maxPlayers: overrides.maxPlayers ?? 2,
      maxRounds: overrides.maxRounds ?? 5,
    },
  });
  expect(result.status).toBe(201);
  return { code: result.body.room.code, membership: result.body.membership, room: result.body.room };
}

async function joinRoom(env: TestEnv, code: string, nickname: string): Promise<{ membership: Membership; room: RoomState }> {
  const result = await env.api('POST', `/api/rooms/${code}/join`, { body: { nickname } });
  expect(result.status).toBe(201);
  return { membership: result.body.membership, room: result.body.room };
}

/** 用服务端真实在线路径标记成员在线（与 Socket 层同一方法），开启一局 2 人游戏。 */
async function startTwoPlayerGame(
  env: TestEnv,
  overrides: { maxPlayers?: number; maxRounds?: number } = {},
): Promise<{ code: string; host: Membership; guest: Membership; room: RoomState }> {
  const created = await createRoom(env, { maxPlayers: overrides.maxPlayers ?? 2, maxRounds: overrides.maxRounds ?? 5 });
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
  overrides: { maxPlayers?: number; maxRounds?: number } = {},
): Promise<{ code: string; host: Membership; guest: Membership; room: RoomState; hostSocket: { socket: Socket; log: StateLog }; guestSocket: { socket: Socket; log: StateLog } }> {
  const created = await createRoom(env, { maxPlayers: overrides.maxPlayers ?? 2, maxRounds: overrides.maxRounds ?? 5 });
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

  it('创建返回 201、房主默认准备、6 位房码不含易混淆字符', async () => {
    const env = await startServer();
    const created = await createRoom(env, { nickname: '阿月' });
    expect(created.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(created.membership.token).toHaveLength(64); // 32 字节 token 的十六进制
    expect(created.membership.roomCode).toBe(created.code);
    expect(created.room.status).toBe('waiting');
    expect(created.room.hostId).toBe(created.membership.playerId);
    expect(created.room.players[0].ready).toBe(true);
    expect(created.room.players[0].online).toBe(false); // 建立 REST 连接不等于 Socket 在线
    expect(created.room.pool).toEqual({ zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 32 });
    expect(created.room.rulesVersion).toBe('unified-v1');
    expect(created.room.expiresAt - created.room.createdAt).toBe(24 * 3600 * 1000);
  });

  it('概况接口只暴露概况', async () => {
    const env = await startServer();
    const created = await createRoom(env, {});
    const preview = await env.api('GET', `/api/rooms/${created.code}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({
      code: created.code,
      name: '中秋团圆局',
      playerCount: 1,
      maxPlayers: 2,
      maxRounds: 5,
      status: 'waiting',
      rulesVersion: 'unified-v1',
      canJoin: true,
    });
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

  it('同回合不同 requestId 并发时只有一个成功，另一个 STALE_TURN', async () => {
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
    expect(failed.body.error.code).toBe('STALE_TURN');

    const room = await env.roomState(game.code, game.host.token);
    expect(room.history.filter((record) => record.turnId === turnId)).toHaveLength(1);
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
    expect(firstRoll.body.room.turnPlayerId).toBe(game.guest.playerId);

    const replay = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: oldTurnId },
      token: game.host.token,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('STALE_TURN');

    const room = await env.roomState(game.code, game.host.token);
    expect(room.history).toHaveLength(1);
  });

  it('重复请求返回已提交状态且不消耗下一次机会', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const payload = { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId! };
    const first = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: payload, token: game.host.token });
    expect(first.status).toBe(200);
    const replay = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: payload, token: game.host.token });
    expect(replay.status).toBe(200);
    expect(replay.body.room.history).toHaveLength(first.body.room.history.length);
    expect(replay.body.room.turnPlayerId).toBe(game.guest.playerId);
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
      { nickname: '阿月', name: '中秋团圆局', maxPlayers: 2 },
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

    // 暂停期间不接受掷骰
    const whilePaused = await second.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: restored.turnId },
      token: game.guest.token,
    });
    expect(whilePaused.status).toBe(409);
    expect(whilePaused.body.error.code).toBe('INVALID_STATE');

    // 成员重新连接恢复倒计时后仍能继续这一回合
    second.instance.service.connectMember(game.code, game.guest.token);
    const afterRestart = await second.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: restored.turnId },
      token: game.guest.token,
    });
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body.room.history).toHaveLength(2);
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
    expect(env.instance.db.counts()).toEqual({ rooms: 0, receipts: 0, completedGames: 0, expiredRooms: 1 });

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
      const rolled = await env.api('POST', `/api/rooms/${game.code}/actions`, {
        body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: state.turnId },
        token: playerToken,
      });
      expect(rolled.status, `第 ${i + 1} 手`).toBe(200);
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

  it('对局中离开保留席位与历史，剩 1 人时按人数不足结算', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env, { maxPlayers: 3 });
    const left = await env.api('POST', `/api/rooms/${game.code}/actions`, { body: { type: 'leave' }, token: game.guest.token });
    expect(left.status).toBe(200);
    const room = left.body.room as RoomState;
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('players-left');
    expect(room.players).toHaveLength(2);
    expect(room.players.find((player) => player.id === game.guest.playerId)?.left).toBe(true);

    // 离开后的凭证失效
    const afterLeave = await env.api('GET', `/api/rooms/${game.code}/state`, { token: game.guest.token });
    expect(afterLeave.status).toBe(401);
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
    expect(room.turnPlayerId).toBe(game.guest.playerId);
    expect(room.round).toBe(1);

    expect(env.instance.service.tick(env.clock.now + TURN_MS)).toEqual([]);
    const after = await env.roomState(game.code, game.host.token);
    expect(after.history).toHaveLength(1);
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
    expect(room.turnPlayerId).toBe(game.guest.playerId);
    // 只推进一次：随后 tick 不再补跳
    expect(env.instance.service.tick(env.clock.now)).toEqual([]);
    const after = await env.roomState(game.code, game.host.token);
    expect(after.history).toHaveLength(1);
  });

  it('掷骰与 tick 交错不会重复轮转', async () => {
    const env = await startServer();
    const game = await startTwoPlayerGame(env);
    const rolled = await env.api('POST', `/api/rooms/${game.code}/actions`, {
      body: { type: 'roll', requestId: crypto.randomUUID(), expectedTurnId: game.room.turnId },
      token: game.host.token,
    });
    expect(rolled.status).toBe(200);
    // deadline 已经推进到 +30 秒，用上一手的旧时间点 tick 不应再跳过
    expect(env.instance.service.tick(env.clock.now)).toEqual([]);
    expect(env.instance.service.tick(env.clock.now + 1_000)).toEqual([]);
    const room = await env.roomState(game.code, game.host.token);
    expect(room.history).toHaveLength(1);
    expect(room.turnPlayerId).toBe(game.guest.playerId);
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
