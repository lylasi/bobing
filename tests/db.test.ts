/**
 * 数据层测试：可空到期时间的真实迁移、独立归档的保留语义，
 * 以及旧快照归一化（旧房间、旧完成对局、新格式损坏）。
 *
 * 这些用例直接操作临时 SQLite 文件，覆盖“从旧 schema 升级”的真实路径：
 * 旧 rooms.expires_at 是 NOT NULL，活跃对局需要保存 null。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppDatabase } from '../server/db.js';
import { RoomService, toPublicRoom } from '../server/room-service.js';
import { CORRUPTED_ROOM_MESSAGE, normalizeStoredRoom } from '../server/room-migrations.js';
import type { InternalRoom } from '../server/game.js';
import {
  applyRoll,
  completeResultPresentation,
  createInternalRoom,
  finishGame,
  skipExpiredTurn,
  startGame,
} from '../server/game.js';
import { DEFAULT_RESULT_HOLD_SECONDS } from '../shared/presentation.js';
import { createDefaultRoomConfig, poolFromConfig } from '../shared/room-config.js';
import { emptyAwards } from '../shared/rules.js';
import type { Membership } from '../shared/types.js';

const T0 = 1_800_000_000_000;
const DAY_MS = 24 * 3600 * 1000;
const NONE = [1, 1, 2, 2, 3, 3];
const DUITANG = [1, 2, 3, 4, 5, 6];
const WUHONG = [4, 4, 4, 4, 4, 6];

const dirs: string[] = [];
const opened: AppDatabase[] = [];

afterEach(() => {
  while (opened.length > 0) opened.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bobing-db-'));
  dirs.push(dir);
  return join(dir, 'bobing.sqlite');
}

function openDb(file: string): AppDatabase {
  const db = new AppDatabase(file);
  opened.push(db);
  return db;
}

/** 新格式的完整内部快照（打完一手后结束），用于往返测试。 */
function playedRoom(): InternalRoom {
  const room = createInternalRoom({
    code: 'ABCDEF',
    name: '中秋团圆局',
    maxPlayers: 3,
    config: createDefaultRoomConfig(),
    hostId: 'p0',
    hostNickname: '玩家0',
    hostTokenHash: 'hash-0',
    now: T0,
    expiresAt: null,
    turnDurationMs: 30_000,
  });
  for (let i = 1; i < 3; i++) {
    room.players.push({
      id: `p${i}`,
      nickname: `玩家${i}`,
      seat: i,
      ready: true,
      online: true,
      left: false,
      awards: emptyAwards(),
      best: null,
      rollCount: 0,
      timeoutCount: 0,
      lastRoll: null,
      tokenHash: `hash-${i}`,
      lastSeenAt: T0,
    });
  }
  startGame(room, T0, 0);
  applyRoll(room, 'p0', WUHONG, T0); // 状元 + 登顶事件
  completePresentation(room);
  applyRoll(room, 'p1', DUITANG, T0 + 1_000);
  completePresentation(room);
  skipExpiredTurn(room, room.deadline ?? 0); // 超时记录
  completePresentation(room);
  finishGame(room, 'host-ended', T0 + 31_000); // 结算并追加 settled 事件
  return room;
}

/** 读完当前结果展示（这些用例只关心存档往返，不关心展示时长）。 */
function completePresentation(room: InternalRoom): void {
  const until = room.presentation?.until ?? 0;
  expect(completeResultPresentation(room, until)).toBe(true);
}

/** 旧版本（固定轮数时代）的房间快照：没有 config/ruleset/initialPool，带 pendingFinish。 */
function legacyRoomSnapshot(): Record<string, unknown> {
  const pool = { zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 30 };
  return {
    code: 'LEGACY',
    name: '旧局',
    maxPlayers: 2,
    maxRounds: 10,
    rulesVersion: 'unified-v1',
    status: 'playing',
    hostId: 'p0',
    revision: 7,
    players: [
      {
        id: 'p0',
        nickname: '玩家0',
        seat: 0,
        ready: true,
        online: true,
        left: false,
        awards: { zhuangyuan: 0, duitang: 1, sanhong: 0, sijin: 0, erju: 0, yixiu: 2 },
        best: { code: 'duitang', label: '对堂', prize: 'duitang', rankKey: [6, 0, 0] },
        tokenHash: 'hash-0',
        lastSeenAt: T0,
      },
      {
        id: 'p1',
        nickname: '玩家1',
        seat: 1,
        ready: true,
        online: false,
        left: false,
        awards: { zhuangyuan: 0, duitang: 0, sanhong: 0, sijin: 0, erju: 0, yixiu: 0 },
        best: null,
        tokenHash: 'hash-1',
        lastSeenAt: T0,
      },
    ],
    gameNumber: 2,
    round: 4,
    turnPlayerId: 'p1',
    turnId: '11111111-1111-4111-8111-111111111111',
    deadline: T0 + 30_000,
    paused: false,
    pool,
    champion: null,
    history: [
      { id: 'r1', playerId: 'p0', nickname: '玩家0', round: 1, turnId: 'a', dice: DUITANG, result: null, awarded: 'duitang', reason: 'rolled', at: T0 },
      { id: 'r2', playerId: 'p1', nickname: '玩家1', round: 1, turnId: 'b', dice: NONE, result: null, awarded: null, reason: 'timeout', at: T0 + 1 },
      { id: 'r3', playerId: 'p0', nickname: '玩家0', round: 2, turnId: 'c', dice: [4, 1, 2, 3, 5, 5], result: null, awarded: 'yixiu', reason: 'rolled', at: T0 + 2 },
      { id: 'r4', playerId: 'p0', nickname: '玩家0', round: 3, turnId: 'd', dice: [4, 1, 2, 3, 5, 5], result: null, awarded: 'yixiu', reason: 'rolled', at: T0 + 3 },
    ],
    pendingFinish: null,
    finishedReason: null,
    createdAt: T0 - DAY_MS,
  };
}

function saveRawRoom(db: AppDatabase, code: string, state: unknown, expiresAt: number | null): void {
  db.saveRoom({ code, stateJson: JSON.stringify(state), expiresAt, revision: 1 });
}

describe('可空到期时间与归档保留', () => {
  it('活跃房间保存 null 到期时间，过期查询只看非 null，删除房间保留归档', () => {
    const db = openDb(tempFile());
    const now = T0;
    const state = { code: 'ABCDEF', players: [] };

    db.saveRoom({ code: 'ABCDEF', stateJson: JSON.stringify(state), expiresAt: null, revision: 1 });
    const loaded = db.getRoom('ABCDEF');
    expect(loaded?.expiresAt).toBeNull();
    expect(loaded?.revision).toBe(1);
    expect(db.listRoomCodes(now)).toContain('ABCDEF');
    expect(db.listExpiredCodes(now)).not.toContain('ABCDEF');
    expect(db.listExpiredCodes(now + 100 * DAY_MS)).not.toContain('ABCDEF');

    db.saveArchive({
      code: 'ABCDEF',
      roomCreatedAt: now,
      gameNumber: 1,
      stateJson: JSON.stringify(state),
      archivedAt: now,
      reason: 'round-limit',
      incomplete: false,
    });
    expect(db.listArchives('ABCDEF', now)).toHaveLength(1);

    db.deleteRoom('ABCDEF');
    expect(db.getRoom('ABCDEF')).toBeNull();
    expect(db.listArchives('ABCDEF', now)).toHaveLength(1);
    expect(db.listArchives('ABCDEF', now)[0]!.reason).toBe('round-limit');
  });

  it('归档按 (房码, 建房时间, 局号) 区分，跨局与重建房间互不覆盖', () => {
    const db = openDb(tempFile());
    const write = (roomCreatedAt: number, gameNumber: number, reason: string): void => {
      db.saveArchive({
        code: 'ABCDEF',
        roomCreatedAt,
        gameNumber,
        stateJson: JSON.stringify({ gameNumber }),
        archivedAt: roomCreatedAt + gameNumber,
        reason,
        incomplete: false,
      });
    };
    write(T0, 2, 'round-limit');
    write(T0, 1, 'pool-empty');
    // 同一房码在另一个时间重建：是另一个房间的历史，独立保存
    write(T0 + DAY_MS, 1, 'host-ended');

    const first = db.listArchives('ABCDEF', T0);
    expect(first.map((row) => row.gameNumber)).toEqual([1, 2]); // 按局号排序
    expect(first[0]!.reason).toBe('pool-empty');
    expect(db.listArchives('ABCDEF', T0 + DAY_MS)).toHaveLength(1);
    expect(db.listArchives('ABCDEF', T0 + 2 * DAY_MS)).toHaveLength(0);

    // keepExisting：旧完成对局迁入时不覆盖已有归档
    write(T0, 1, 'offline-expired');
    expect(db.listArchives('ABCDEF', T0)[0]!.reason).toBe('offline-expired');
    db.saveArchive(
      { code: 'ABCDEF', roomCreatedAt: T0, gameNumber: 1, stateJson: '{}', archivedAt: T0, reason: 'all-left', incomplete: true },
      { keepExisting: true },
    );
    expect(db.listArchives('ABCDEF', T0)[0]!.reason).toBe('offline-expired');
  });

  it('counts 反映归档与过期墓碑，deleteRoom 不删除旧的 completed_games', () => {
    const db = openDb(tempFile());
    saveRawRoom(db, 'ABCDEF', { code: 'ABCDEF' }, T0 + DAY_MS);
    db.saveReceipt({ roomCode: 'ABCDEF', gameNumber: 1, playerId: 'p0', requestId: 'r', resultJson: '{}', createdAt: T0 });
    db.saveCompletedGame('ABCDEF', 1, '{}', T0);
    db.saveArchive({ code: 'ABCDEF', roomCreatedAt: T0, gameNumber: 1, stateJson: '{}', archivedAt: T0, reason: 'round-limit', incomplete: false });
    expect(db.counts()).toEqual({ rooms: 1, receipts: 1, completedGames: 1, archives: 1, expiredRooms: 0 });

    db.deleteRoom('ABCDEF');
    expect(db.counts()).toEqual({ rooms: 0, receipts: 0, completedGames: 1, archives: 1, expiredRooms: 0 });
    expect(db.getCompletedGame('ABCDEF', 1)).not.toBeNull();
  });
});

describe('旧 schema 迁移', () => {
  /** 建立旧版本数据库：rooms.expires_at 为 NOT NULL，并塞入一行旧房间。 */
  function buildLegacyDb(file: string, rows: Array<{ code: string; stateJson: string; expiresAt: number; revision: number }>): void {
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE rooms (
        code        TEXT PRIMARY KEY,
        state_json  TEXT NOT NULL,
        expires_at  INTEGER NOT NULL,
        revision    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_rooms_expires_at ON rooms (expires_at);
      CREATE TABLE receipts (
        room_code   TEXT NOT NULL,
        game_number INTEGER NOT NULL,
        player_id   TEXT NOT NULL,
        request_id  TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        PRIMARY KEY (room_code, game_number, player_id, request_id)
      );
      CREATE TABLE completed_games (
        room_code   TEXT NOT NULL,
        game_number INTEGER NOT NULL,
        state_json  TEXT NOT NULL,
        finished_at INTEGER NOT NULL,
        PRIMARY KEY (room_code, game_number)
      );
      CREATE TABLE expired_rooms (
        code        TEXT PRIMARY KEY,
        expired_at  INTEGER NOT NULL
      );
    `);
    const insert = raw.prepare('INSERT INTO rooms (code, state_json, expires_at, revision) VALUES (?, ?, ?, ?)');
    for (const row of rows) insert.run(row.code, row.stateJson, row.expiresAt, row.revision);
    const receipts = raw.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?)');
    receipts.run('LEGACY', 2, 'p0', 'req-1', '{"id":"r1"}', T0);
    raw.close();
  }

  it('把 NOT NULL 的 expires_at 升级为可空结构，且旧行、回执、旧完成表全部保留', () => {
    const file = tempFile();
    const legacy = legacyRoomSnapshot();
    buildLegacyDb(file, [{ code: 'LEGACY', stateJson: JSON.stringify(legacy), expiresAt: T0 + DAY_MS, revision: 7 }]);

    const db = openDb(file);
    const row = db.getRoom('LEGACY');
    expect(row).not.toBeNull();
    expect(row!.expiresAt).toBe(T0 + DAY_MS);
    expect(row!.revision).toBe(7);
    expect(JSON.parse(row!.stateJson)).toEqual(legacy);
    expect(db.findReceipt('LEGACY', 2, 'p0', 'req-1')).not.toBeNull();
    expect(db.listRoomCodes(T0)).toEqual(['LEGACY']);
    expect(db.listExpiredCodes(T0)).toEqual([]);

    // 迁移后可保存 null（旧结构会因 NOT NULL 失败）
    db.saveRoom({ code: 'LEGACY', stateJson: row!.stateJson, expiresAt: null, revision: 8 });
    expect(db.getRoom('LEGACY')!.expiresAt).toBeNull();
    expect(db.listRoomCodes(T0)).toEqual(['LEGACY']);
    expect(db.listExpiredCodes(T0 + 10 * DAY_MS)).toEqual([]);
  });

  it('重复打开数据库时二次迁移幂等，不做多余重建', () => {
    const file = tempFile();
    buildLegacyDb(file, [{ code: 'LEGACY', stateJson: JSON.stringify(legacyRoomSnapshot()), expiresAt: T0 + DAY_MS, revision: 7 }]);
    const first = openDb(file);
    saveRawRoom(first, 'SECOND', { code: 'SECOND' }, null);
    first.close();
    opened.pop();

    const second = openDb(file);
    expect(second.getRoom('LEGACY')?.revision).toBe(7);
    expect(second.getRoom('SECOND')?.expiresAt).toBeNull();
    const columns = new DatabaseSync(file);
    const info = columns.prepare('PRAGMA table_info(rooms)').all() as unknown as Array<{ name: string; notnull: number }>;
    columns.close();
    expect(info.find((column) => column.name === 'expires_at')!.notnull).toBe(0);
  });

  it('旧 completed_games 在启动时迁入独立归档，房间清理后仍可读取（且不含凭证）', () => {
    const file = tempFile();
    const legacy = legacyRoomSnapshot();
    legacy.status = 'finished';
    legacy.finishedReason = 'round-limit';
    legacy.pendingFinish = null;
    buildLegacyDb(file, [{ code: 'LEGACY', stateJson: JSON.stringify(legacy), expiresAt: T0 - 1, revision: 7 }]);
    // 同一张兼容表里还可能有当前代码“再开一局”写入的公共快照：没有 turnOrder／tokenHash 等内部字段
    const publicSnapshot = toPublicRoom(playedRoom());
    const publicJson = JSON.stringify(publicSnapshot);
    const raw = new DatabaseSync(file);
    raw.prepare('INSERT INTO completed_games (room_code, game_number, state_json, finished_at) VALUES (?, ?, ?, ?)').run(
      'LEGACY',
      2,
      JSON.stringify(legacy),
      T0 + 500,
    );
    raw
      .prepare('INSERT INTO completed_games (room_code, game_number, state_json, finished_at) VALUES (?, ?, ?, ?)')
      .run(publicSnapshot.code, 1, publicJson, T0 + 600);
    raw.close();

    const db = openDb(file);
    const service = new RoomService({ db, now: () => T0 });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 房间已过期的旧行不会出现在待恢复列表里，但旧完成对局照常迁入
    expect(service.onBoot(T0)).toBe(0);
    // 两种格式都必须迁入，且都不能被对方的读取器误判成损坏
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();

    const archives = db.listArchives('LEGACY', legacy.createdAt as number);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.gameNumber).toBe(2);
    expect(archives[0]!.reason).toBe('round-limit');
    expect(archives[0]!.incomplete).toBe(false); // 旧轮数上限属于正常完成
    expect(archives[0]!.stateJson).not.toContain('tokenHash');
    expect(archives[0]!.stateJson).toContain('"maxRounds"'); // 规则快照按本局配置保存
    expect(db.listLegacyCompletedGames()).toHaveLength(2);

    // 公共快照行按公共白名单原样归档，不经过 InternalRoom 读取器
    const publicArchives = db.listArchives(publicSnapshot.code, publicSnapshot.createdAt);
    expect(publicArchives).toHaveLength(1);
    expect(publicArchives[0]!.gameNumber).toBe(1);
    expect(publicArchives[0]!.reason).toBe('host-ended');
    expect(publicArchives[0]!.incomplete).toBe(true);
    expect(publicArchives[0]!.stateJson).toBe(publicJson);
    expect(publicArchives[0]!.stateJson).not.toContain('tokenHash');

    // 房间被清理后归档仍可读
    db.markExpired('LEGACY', T0);
    db.deleteRoom('LEGACY');
    expect(db.listArchives('LEGACY', legacy.createdAt as number)).toHaveLength(1);

    // 重复启动不会重复插入或改写：两种格式都已归档，直接跳过，不再重新解析
    const again = new RoomService({ db, now: () => T0 });
    const secondBootErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
    again.onBoot(T0);
    expect(secondBootErrors).not.toHaveBeenCalled();
    secondBootErrors.mockRestore();
    expect(db.listArchives('LEGACY', legacy.createdAt as number)).toHaveLength(1);
    expect(db.listArchives('LEGACY', legacy.createdAt as number)[0]!.stateJson).toBe(archives[0]!.stateJson);
    expect(db.listArchives(publicSnapshot.code, publicSnapshot.createdAt)).toHaveLength(1);
    expect(db.counts().archives).toBe(2);
  });
});

describe('旧快照归一化', () => {
  it('旧固定轮数房间按原轮数补成配置，库存与计数独立重建', () => {
    const room = normalizeStoredRoom(legacyRoomSnapshot());
    expect(room.config.rulesetId).toBe('continuous');
    expect(room.config.endCondition).toEqual({ mode: 'rounds', maxRounds: 10 });
    expect(room.ruleset.id).toBe('continuous');
    expect(room.ruleset.version).toBe(1);
    expect(room.initialPool).toEqual(poolFromConfig(room.config));
    // 旧快照缺的那两份一秀不补齐，库存原样保留
    expect(room.pool.yixiu).toBe(30);
    expect(room.pool.duitang).toBe(2);
    expect(room.closingRound).toBeNull();
    expect(room.incomplete).toBe(false);
    expect(room.allOfflineSince).toBeNull();
    // 旧快照没有到期时间字段：单独归一化时为 null，加载房间时回退到数据库行的 expires_at
    expect(room.expiresAt).toBeNull();
    expect(normalizeStoredRoom(legacyRoomSnapshot(), { fallbackExpiresAt: T0 + DAY_MS }).expiresAt).toBe(T0 + DAY_MS);
    expect(room.champion).toBeNull();
    // 累计计数从历史重建，而不是当 0
    expect(room.players.find((player) => player.id === 'p0')!.rollCount).toBe(3);
    expect(room.players.find((player) => player.id === 'p0')!.timeoutCount).toBe(0);
    expect(room.players.find((player) => player.id === 'p1')!.rollCount).toBe(0);
    expect(room.players.find((player) => player.id === 'p1')!.timeoutCount).toBe(1);
    expect(room.players.every((player) => player.tokenHash.length > 0)).toBe(true);
  });

  it('旧快照的 pendingFinish 转成收尾轮次（且只在已有状元时），关闭的中止局标记为未完成', () => {
    const withPending = legacyRoomSnapshot();
    withPending.pendingFinish = true;
    // 旧数据可能在还没有状元时就写下这个标记；新规则要求“普通奖发完且已有人夺魁”才收尾，
    // 因此没有状元时不迁移，避免把仍在继续的对局错误地按“奖品发完”结算
    expect(normalizeStoredRoom(withPending).closingRound).toBeNull();

    const withChampion = legacyRoomSnapshot();
    withChampion.pendingFinish = 'pool-empty';
    withChampion.champion = {
      playerId: 'p0',
      result: { code: 'wuhong', label: '五红', prize: 'zhuangyuan', rankKey: [8, 6, 0] },
      dice: [4, 4, 4, 4, 4, 6],
      at: T0,
    };
    expect(normalizeStoredRoom(withChampion).closingRound).toBe(4);

    const closed = legacyRoomSnapshot();
    closed.status = 'closed';
    closed.pendingFinish = null;
    closed.finishedReason = null;
    const room = normalizeStoredRoom(closed);
    expect(room.incomplete).toBe(true);
    expect(room.closingRound).toBeNull();
  });

  it('新格式快照往返保持一致，存储的规则快照原样保留（不按注册表改判）', () => {
    const original = playedRoom();
    const roundTripped = normalizeStoredRoom(JSON.parse(JSON.stringify(original)));
    expect(roundTripped.config).toEqual(original.config);
    expect(roundTripped.ruleset).toEqual(original.ruleset);
    expect(roundTripped.pool).toEqual(original.pool);
    expect(roundTripped.initialPool).toEqual(original.initialPool);
    expect(roundTripped.status).toBe('finished');
    expect(roundTripped.finishedReason).toBe('host-ended');
    expect(roundTripped.incomplete).toBe(true);
    expect(roundTripped.players.map((player) => [player.rollCount, player.timeoutCount])).toEqual(
      original.players.map((player) => [player.rollCount, player.timeoutCount]),
    );
    expect(roundTripped.history).toEqual(original.history);
    // 新字段必须逐项往返：节奏、访问设置、登顶事实与个人最后结果
    expect(roundTripped.pacing).toEqual(original.pacing);
    expect(roundTripped.access).toEqual(original.access);
    expect(roundTripped.championEvents).toEqual(original.championEvents);
    expect(roundTripped.championEvents.map((event) => event.kind)).toEqual(['first', 'settled']);
    expect(roundTripped.championHistoryComplete).toBe(true);
    expect(roundTripped.presentation).toEqual(original.presentation);
    expect(roundTripped.players.map((player) => player.lastRoll)).toEqual(original.players.map((player) => player.lastRoll));
    expect(roundTripped.players.find((player) => player.id === 'p0')!.lastRoll?.championOutcome?.kind).toBe('first');

    // 历史规则快照被原样保留：即使与当前注册表不同也不改判
    const stale = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    const ruleset = stale.ruleset as Record<string, unknown>;
    ruleset.rulesetVersionNote = '历史版本';
    ruleset.name = '旧版持续顶状元';
    const normalized = normalizeStoredRoom(stale);
    expect(normalized.ruleset.name).toBe('旧版持续顶状元');
    expect(normalized.config.rulesetId).toBe(normalized.ruleset.id);
  });

  it('新格式损坏时报错，不会被当成旧数据静默兜底', () => {
    const snapshot = JSON.parse(JSON.stringify(playedRoom())) as Record<string, unknown>;
    const cases: Array<[string, () => unknown]> = [
      ['缺少 config', () => { const s = { ...snapshot }; delete s.config; return s; }],
      ['缺少 ruleset', () => { const s = { ...snapshot }; delete s.ruleset; return s; }],
      ['缺少 closingRound', () => { const s = { ...snapshot }; delete s.closingRound; return s; }],
      ['奖池份数为负', () => ({ ...snapshot, pool: { ...(snapshot.pool as object), yixiu: -1 } })],
      ['奖池份数为小数', () => ({ ...snapshot, pool: { ...(snapshot.pool as object), yixiu: 1.5 } })],
      ['玩家缺少累计投掷', () => ({ ...snapshot, players: [(snapshot.players as Array<Record<string, unknown>>)[0]!].map(({ rollCount, ...rest }) => rest), } as unknown)],
      ['状元锁定字段缺失', () => ({ ...snapshot, champion: { playerId: 'p0', result: null, dice: [], at: T0 } })],
      ['规则快照与配置不一致', () => ({ ...snapshot, ruleset: { ...(snapshot.ruleset as object), id: 'high-tier-lock' } })],
      ['状态不是已知值', () => ({ ...snapshot, status: 'paused' })],
      ['结果停留越界', () => ({ ...snapshot, pacing: { resultHoldSeconds: 11 } })],
      ['结果停留是小数', () => ({ ...snapshot, pacing: { resultHoldSeconds: 0.5 } })],
      ['访问可见性不是已知值', () => ({ ...snapshot, access: { visibility: 'secret', allowSpectators: true } })],
      ['旁观开关不是布尔值', () => ({ ...snapshot, access: { visibility: 'public', allowSpectators: 'yes' } })],
      ['展示阶段记录缺失', () => ({ ...snapshot, presentation: { until: T0 } })],
      ['登顶事件类型未知', () => ({ ...snapshot, championEvents: [{ id: 'e1', recordId: null, kind: 'once-more', playerId: 'p0', nickname: '玩家0', previousPlayerId: null, previousNickname: null, round: 1, at: T0, dice: WUHONG, awardedCount: 0, locked: false }] })],
      ['登顶事实类型未知', () => ({ ...snapshot, history: [(snapshot.history as Array<Record<string, unknown>>).map((record, index) => index === 0 ? { ...record, championOutcome: { kind: 'nope', previousPlayerId: null, currentPlayerId: null, locked: false } } : record)] })],
      ['既不是旧格式也不是新格式', () => ({ code: 'ABCDEF', players: [] })],
    ];
    for (const [label, build] of cases) {
      expect(() => normalizeStoredRoom(build()), label).toThrow(CORRUPTED_ROOM_MESSAGE);
    }
    // 非法轮数不属于旧格式
    expect(() => normalizeStoredRoom({ ...legacyRoomSnapshot(), maxRounds: 7 })).toThrow(CORRUPTED_ROOM_MESSAGE);
  });

  it('旧房间不伪造登顶事实：事件为空、完整性标记为假，最后结果标成 legacy-unknown', () => {
    const legacy = legacyRoomSnapshot();
    const history = legacy.history as Array<Record<string, unknown>>;
    history.push({
      id: 'r5',
      playerId: 'p0',
      nickname: '玩家0',
      round: 4,
      turnId: 'e',
      dice: WUHONG,
      result: { code: 'wuhong', label: '五红', prize: 'zhuangyuan', rankKey: [8, 6, 0] },
      awarded: null,
      reason: 'rolled',
      at: T0 + 4,
    });
    const room = normalizeStoredRoom(legacy);
    // 旧数据无法区分“投出状元牌型”和“真的登顶过”，因此不补事件、标记不完整
    expect(room.championEvents).toEqual([]);
    expect(room.championHistoryComplete).toBe(false);
    expect(room.champion).toBeNull();
    expect(room.players.find((player) => player.id === 'p0')!.best).not.toBeNull(); // 个人最佳不等于登顶证据
    // 个人最后结果从幸存历史回退，并标成 legacy-unknown
    const lastRoll = room.players.find((player) => player.id === 'p0')!.lastRoll;
    expect(lastRoll?.id).toBe('r5');
    expect(lastRoll?.championOutcome?.kind).toBe('legacy-unknown');
    expect(room.history.at(-1)?.championOutcome?.kind).toBe('legacy-unknown');
    // 普通奖记录不会被错误标成曾登顶
    expect(room.history.find((record) => record.id === 'r1')?.championOutcome).toBeNull();
  });

  it('旧房间迁移后仅邀请且关闭旁观，节奏取默认 1 秒，不自动放开可见性', () => {
    const room = normalizeStoredRoom(legacyRoomSnapshot());
    expect(room.pacing).toEqual({ resultHoldSeconds: DEFAULT_RESULT_HOLD_SECONDS });
    expect(room.access).toEqual({ visibility: 'invite', allowSpectators: false });
    expect(room.presentation).toBeNull();
    expect(room.presentationRemainingMs).toBeNull();
    // 缺失新字段属于旧数据；只要出现但损坏就按损坏处理（见“新格式损坏时报错”）
    expect(() => normalizeStoredRoom({ ...legacyRoomSnapshot(), access: { visibility: 'public' } })).toThrow(CORRUPTED_ROOM_MESSAGE);
  });

  it('上一版房间（有 config 但缺本轮新字段）迁移为仅邀请、默认 1 秒，并恢复个人最后结果', () => {
    // 这是升级路径上最常见的一种：房间由上一版（有 config、有 240 条历史）写入，
    // 但没有本轮的 pacing／access／presentation／championEvents／lastRoll／championOutcome。
    const snapshot = JSON.parse(JSON.stringify(playedRoom())) as Record<string, unknown>;
    for (const key of ['pacing', 'access', 'presentation', 'presentationRemainingMs', 'championEvents', 'championHistoryComplete']) {
      delete snapshot[key];
    }
    for (const player of snapshot.players as Array<Record<string, unknown>>) delete player.lastRoll;
    for (const record of snapshot.history as Array<Record<string, unknown>>) delete record.championOutcome;

    const room = normalizeStoredRoom(snapshot);
    // 节奏取默认 1 秒；旧数据的可见性不因为新房默认公开而放开
    expect(room.pacing).toEqual({ resultHoldSeconds: DEFAULT_RESULT_HOLD_SECONDS });
    expect(room.access).toEqual({ visibility: 'invite', allowSpectators: false });
    expect(room.presentation).toBeNull();
    expect(room.presentationRemainingMs).toBeNull();
    // 不伪造历程：事件为空、完整性为假；已经保存的状元归属事实原样保留
    expect(room.championEvents).toEqual([]);
    expect(room.championHistoryComplete).toBe(false);
    expect(room.champion?.playerId).toBe('p0');
    // 个人最后结果按玩家从幸存历史恢复：状元牌型标成 legacy-unknown，其余保持 null
    expect(room.players.map((player) => player.lastRoll?.reason)).toEqual(['rolled', 'rolled', 'timeout']);
    expect(room.players.find((player) => player.id === 'p0')?.lastRoll?.championOutcome?.kind).toBe('legacy-unknown');
    expect(room.players.find((player) => player.id === 'p1')?.lastRoll?.result?.code).toBe('duitang');
    expect(room.players.find((player) => player.id === 'p1')?.lastRoll?.championOutcome).toBeNull();
    // 公开快照与归档共用同一份事实：迁移后仍然不完整，事件为空
    const publicSnapshot = toPublicRoom(room);
    expect(publicSnapshot.championHistoryComplete).toBe(false);
    expect(publicSnapshot.championEvents).toEqual([]);
    expect(publicSnapshot.players.find((player) => player.id === 'p0')?.lastRoll?.id).toBe(room.players[0]?.lastRoll?.id);
  });

  it('旧快照里未知房规字段一律忽略，只按 maxRounds 推导', () => {
    const legacy = legacyRoomSnapshot();
    legacy.rulesetId = 'high-tier-lock';
    legacy.ruleset = { id: 'high-tier-lock' };
    const room = normalizeStoredRoom(legacy);
    expect(room.config.rulesetId).toBe('continuous');
    expect(room.ruleset.id).toBe('continuous');
    expect(room.config.endCondition).toEqual({ mode: 'rounds', maxRounds: 10 });
  });

  it('initialPool 由配置推导，缺失或损坏都不会破坏库存', () => {
    const snapshot = JSON.parse(JSON.stringify(playedRoom())) as Record<string, unknown>;
    delete snapshot.initialPool;
    const normalized = normalizeStoredRoom(snapshot);
    expect(normalized.initialPool).toEqual(poolFromConfig(normalized.config));

    // 两套格式的标志字段同时出现属于混写损坏
    expect(() => normalizeStoredRoom({ ...legacyRoomSnapshot(), config: createDefaultRoomConfig() })).toThrow(CORRUPTED_ROOM_MESSAGE);
  });

  it('旧快照缺失奖池时按默认配置补齐，仍保留原轮数', () => {
    const legacy = legacyRoomSnapshot();
    delete legacy.pool;
    const room = normalizeStoredRoom(legacy);
    expect(room.pool).toEqual(poolFromConfig(room.config));
    expect(room.maxPlayers).toBe(2);
    expect(room.config.endCondition).toEqual({ mode: 'rounds', maxRounds: 10 });
  });
});

/**
 * 跨流程回归：兼容表 completed_games 里的行由当前代码在“再开一局”时写入，
 * 内容是白名单公共快照。它必须能被启动迁移按公共格式认出来，
 * 而不是被 InternalRoom 读取器当成损坏；真正的旧 InternalRoom 归档仍走原迁移。
 */
describe('completed_games 与独立归档的格式衔接', () => {
  interface Table {
    service: RoomService;
    db: AppDatabase;
    code: string;
    host: Membership;
    guest: Membership;
  }

  function startTable(db: AppDatabase, clock: { now: number }, dice: number[][]): Table {
    const service = new RoomService({
      db,
      now: () => clock.now,
      rollDice: () => dice.shift() ?? NONE,
      pickStartSeat: () => 0,
    });
    const created = service.create(
      { nickname: '阿月', name: '中秋团圆局', maxPlayers: 2, config: createDefaultRoomConfig() },
      'ip',
    );
    const code = created.membership.roomCode;
    const joined = service.join(code, '阿桂', 'ip');
    service.connectMember(code, created.membership.token);
    service.connectMember(code, joined.membership.token);
    return { service, db, code, host: created.membership, guest: joined.membership };
  }

  /** 开一局、掷一手、房主中止再开一局；返回本局写入兼容表的公共快照 JSON。 */
  function playGameAndRematch(table: Table, clock: { now: number }): string {
    const gameNumber = table.service.getSnapshot(table.code)!.gameNumber;
    table.service.action(table.code, table.guest.token, { type: 'ready', ready: true });
    const started = table.service.action(table.code, table.host.token, { type: 'start' });
    clock.now += 1_000;
    table.service.action(table.code, table.host.token, {
      type: 'roll',
      requestId: crypto.randomUUID(),
      expectedTurnId: started.room.turnId!,
    });
    clock.now += 1_000;
    table.service.action(table.code, table.host.token, { type: 'end' });
    clock.now += 1_000;
    table.service.action(table.code, table.host.token, { type: 'rematch' });
    const row = table.db.getCompletedGame(table.code, gameNumber);
    if (!row) throw new Error('再开一局后兼容表里应有本局的公共快照');
    return row.stateJson;
  }

  it('正常完成→再开一局→重启：兼容表里的公共快照不再被当成损坏重新解析', () => {
    const db = openDb(tempFile());
    const clock = { now: T0 };
    const table = startTable(db, clock, [WUHONG, NONE]);
    const firstPublic = playGameAndRematch(table, clock);
    const secondPublic = playGameAndRematch(table, clock);

    // 兼容表里两局都在，内容都是白名单公共快照
    expect(db.listLegacyCompletedGames().map((row) => row.gameNumber)).toEqual([1, 2]);
    expect(db.listLegacyCompletedGames().map((row) => row.stateJson)).toEqual([firstPublic, secondPublic]);
    for (const publicJson of [firstPublic, secondPublic]) {
      expect(publicJson).not.toContain('tokenHash');
      expect(publicJson).not.toContain('lastSeenAt');
      expect(publicJson).not.toContain('turnOrder');
      // 这正是需要格式衔接的原因：内部读取器按定义读不懂公共快照
      expect(() => normalizeStoredRoom(JSON.parse(publicJson))).toThrow(CORRUPTED_ROOM_MESSAGE);
    }

    const archivesBefore = db.listArchives(table.code, T0);
    expect(archivesBefore.map((row) => row.gameNumber)).toEqual([1, 2]);
    expect(archivesBefore[0]!.stateJson).toBe(firstPublic); // 归档与兼容表保存同一份公共快照
    expect(archivesBefore[1]!.stateJson).toBe(secondPublic);

    // 重启：同一 (房码, 建房时间, 局号) 已归档，直接跳过，不换格式重新解析、不改动归档内容
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restarted = new RoomService({ db, now: () => clock.now });
    expect(restarted.onBoot(clock.now)).toBe(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();

    expect(db.listArchives(table.code, T0)).toEqual(archivesBefore);
    expect(db.listLegacyCompletedGames()).toHaveLength(2); // 旧行保留不删除
    expect(db.counts().archives).toBe(2);
  });

  it('兼容表里缺归档行的公共快照按原样补写归档：不丢历史、不含凭证', () => {
    const file = tempFile();
    const db = openDb(file);
    const clock = { now: T0 };
    const table = startTable(db, clock, [WUHONG]);
    const publicJson = playGameAndRematch(table, clock);
    expect(db.counts().archives).toBe(1);
    db.close();
    opened.pop();

    // 模拟只有兼容表保留下来、独立归档缺失的库（归档只补写，不覆盖）
    const raw = new DatabaseSync(file);
    raw.exec('DELETE FROM room_archives;');
    raw.close();

    const reopened = openDb(file);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const restarted = new RoomService({ db: reopened, now: () => clock.now });
    restarted.onBoot(clock.now);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();

    const archives = reopened.listArchives(table.code, T0);
    expect(archives).toHaveLength(1);
    expect(archives[0]!.gameNumber).toBe(1);
    expect(archives[0]!.roomCreatedAt).toBe(T0);
    expect(archives[0]!.reason).toBe('host-ended');
    expect(archives[0]!.incomplete).toBe(true);
    expect(archives[0]!.stateJson).toBe(publicJson); // 原样补写，不重新解释格式
    expect(archives[0]!.stateJson).not.toContain('tokenHash');
    expect(reopened.listLegacyCompletedGames()).toHaveLength(1);
  });
});
