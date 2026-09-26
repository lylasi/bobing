import { describe, expect, it } from 'vitest';
import {
  activePlayers,
  applyRoll,
  createInternalRoom,
  dropCurrentTurnIfPlayer,
  findPlayer,
  finishGame,
  isValidDice,
  pauseRoom,
  prepareRematch,
  resumeRoom,
  skipExpiredTurn,
  startGame,
  transferHost,
} from '../server/game.js';
import type { InternalPlayer, InternalRoom } from '../server/game.js';
import { emptyAwards } from '../shared/rules.js';

const T0 = 1_800_000_000_000;
const TURN_MS = 30_000;

// 判奖样例骰子（与 rules.test.ts 相同来源）
const NONE = [1, 1, 2, 2, 3, 3];
const YIXIU = [4, 1, 2, 3, 5, 5];
const ERJU = [4, 4, 1, 2, 3, 5];
const SIJIN = [2, 2, 2, 2, 4, 4];
const DUITANG = [1, 2, 3, 4, 5, 6];
const SIHONG = [4, 4, 4, 4, 2, 6];
const WUHONG = [4, 4, 4, 4, 4, 6];
const CHAJINHUA = [4, 4, 4, 4, 1, 1];

function makeRoom(playerCount = 2, overrides: { maxRounds?: 5 | 10 | 20; maxPlayers?: number; turnDurationMs?: number } = {}): InternalRoom {
  const room = createInternalRoom({
    code: 'ABCDEF',
    name: '中秋团圆局',
    maxPlayers: overrides.maxPlayers ?? Math.max(2, playerCount),
    maxRounds: overrides.maxRounds ?? 5,
    hostId: 'p0',
    hostNickname: '玩家0',
    hostTokenHash: 'hash-0',
    now: T0,
    expiresAt: T0 + 24 * 3600 * 1000,
    turnDurationMs: overrides.turnDurationMs ?? TURN_MS,
  });
  for (let i = 1; i < playerCount; i++) {
    room.players.push({
      id: `p${i}`,
      nickname: `玩家${i}`,
      seat: i,
      ready: true,
      online: true,
      left: false,
      awards: emptyAwards(),
      best: null,
      tokenHash: `hash-${i}`,
      lastSeenAt: T0,
    });
  }
  for (const player of room.players) player.online = true;
  return room;
}

function player(room: InternalRoom, id: string): InternalPlayer {
  const found = findPlayer(room, id);
  if (!found) throw new Error(`测试房间缺少玩家 ${id}`);
  return found;
}

function currentPlayerId(room: InternalRoom): string {
  const id = room.turnPlayerId;
  if (id === null) throw new Error('当前没有回合玩家');
  return id;
}

describe('startGame 开局', () => {
  it('随机起始位之后按入座顺序循环，轮转顺序在开局时固定', () => {
    const room = makeRoom(3);
    startGame(room, T0, 0);
    expect(room.turnOrder).toEqual(['p0', 'p1', 'p2']);
    expect(room.turnPlayerId).toBe('p0');

    const room2 = makeRoom(3);
    startGame(room2, T0, 2);
    expect(room2.turnOrder).toEqual(['p2', 'p0', 'p1']);
    expect(room2.turnPlayerId).toBe('p2');
  });

  it('开局状态：playing、第 1 轮、UUID turnId、30 秒 deadline、满额奖池', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    expect(room.status).toBe('playing');
    expect(room.round).toBe(1);
    expect(room.turnId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(room.deadline).toBe(T0 + TURN_MS);
    expect(room.pool).toEqual({ zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 32 });
    expect(room.history).toEqual([]);
    expect(room.champion).toBeNull();
  });

  it('从等待区带旧数据开局时清空上一局记录与奖项', () => {
    const room = makeRoom(2);
    room.history.push({
      id: 'old',
      playerId: 'p0',
      nickname: '玩家0',
      round: 1,
      turnId: 'old-turn',
      dice: NONE,
      result: null,
      awarded: null,
      reason: 'rolled',
      at: T0,
    });
    room.players[0].awards.duitang = 1;
    room.players[0].best = { code: 'yixiu', label: '一秀', prize: 'yixiu', rankKey: [1, 0, 0] };
    room.pool.duitang = 1;
    startGame(room, T0, 0);
    expect(room.history).toEqual([]);
    expect(room.players[0].awards.duitang).toBe(0);
    expect(room.players[0].best).toBeNull();
    expect(room.pool.duitang).toBe(2);
  });
});

describe('轮转与轮数上限', () => {
  it('2 人 5 轮：每人每轮恰好一次机会，第 10 手后按轮数上限结算', () => {
    const room = makeRoom(2, { maxRounds: 5 });
    startGame(room, T0, 0);
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      order.push(currentPlayerId(room));
      applyRoll(room, currentPlayerId(room), NONE, T0 + i);
    }
    expect(order).toEqual(['p0', 'p1', 'p0', 'p1', 'p0', 'p1', 'p0', 'p1', 'p0', 'p1']);
    expect(room.history).toHaveLength(10);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('round-limit');
    expect(room.round).toBe(5); // 第 6 轮从未开始，round 停在最后一轮
    expect(room.deadline).toBeNull();
  });

  it('12 人 20 轮最多 240 条记录，不超过历史上限', () => {
    const room = makeRoom(12, { maxRounds: 20 });
    startGame(room, T0, 0);
    for (let i = 0; i < 240; i++) applyRoll(room, currentPlayerId(room), NONE, T0 + i);
    expect(room.history).toHaveLength(240);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('round-limit');
    expect(new Set(room.history.map((record) => record.turnId)).size).toBe(240);
  });

  it('离开席位不重排顺序，轮数仍按完整顺序边界计算', () => {
    const room = makeRoom(3, { maxRounds: 5 });
    startGame(room, T0, 0);
    // p1 在当前回合离开（先被跳过）
    player(room, 'p1').left = true;
    expect(dropCurrentTurnIfPlayer(room, 'p1', T0)).toBe(false); // p1 不是当前玩家
    applyRoll(room, 'p0', NONE, T0);
    expect(room.turnPlayerId).toBe('p2'); // 跳过 p1
    applyRoll(room, 'p2', NONE, T0 + 1);
    expect(room.round).toBe(2); // 三人顺序跑完仍算一轮
    expect(room.turnPlayerId).toBe('p0');
  });
});

describe('奖池与发奖', () => {
  it('普通奖先到先得，库存为 0 时不降级、不补发', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    room.pool.duitang = 1; // 模拟只剩 1 份对堂

    const first = applyRoll(room, 'p0', DUITANG, T0);
    expect(first.awarded).toBe('duitang');
    expect(room.pool.duitang).toBe(0);

    const second = applyRoll(room, 'p1', DUITANG, T0 + 1);
    expect(second.awarded).toBeNull();
    expect(second.result?.code).toBe('duitang');
    expect(room.pool.duitang).toBe(0);
    expect(player(room, 'p1').awards.duitang).toBe(0);
  });

  it('一次投掷只判最高牌型：四进不兼得二举，插金花不额外领对堂', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    const sijin = applyRoll(room, 'p0', SIJIN, T0);
    expect(sijin.result?.code).toBe('sijin');
    expect(sijin.awarded).toBe('sijin');
    expect(player(room, 'p0').awards.erju).toBe(0);

    const cha = applyRoll(room, 'p1', CHAJINHUA, T0 + 1);
    expect(cha.result?.code).toBe('chajinhua');
    expect(cha.awarded).toBeNull(); // 状元整局结束时才发
    expect(room.pool.duitang).toBe(2); // 插金花不领对堂
  });

  it('普通奖全部领完时完成当前整轮后才结算，该轮其他人仍可掷', () => {
    const room = makeRoom(3, { maxRounds: 5 });
    startGame(room, T0, 0);
    for (const key of ['duitang', 'sanhong', 'sijin', 'erju'] as const) room.pool[key] = 0;
    room.pool.yixiu = 1;

    applyRoll(room, 'p0', YIXIU, T0); // 最后一份一秀
    expect(room.pool.yixiu).toBe(0);
    expect(room.status).toBe('playing'); // 本轮未结束

    applyRoll(room, 'p1', NONE, T0 + 1);
    expect(room.status).toBe('playing');

    applyRoll(room, 'p2', SIHONG, T0 + 2); // 本轮最后一人仍可争夺状元
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('pool-empty');
    expect(room.champion?.playerId).toBe('p2');
    expect(player(room, 'p2').awards.zhuangyuan).toBe(1);
    expect(room.pool.zhuangyuan).toBe(0);
  });
});

describe('状元比较', () => {
  it('超过当前领先者才替换，同分先到先得', () => {
    const room = makeRoom(3);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', SIHONG, T0); // [6,8,0]
    expect(room.champion?.playerId).toBe('p0');
    expect(room.champion?.result.rankKey).toEqual([6, 8, 0]);

    applyRoll(room, 'p1', [4, 4, 4, 4, 3, 5], T0 + 1); // 同为四红，和也是 8 → 同分保留 p0
    expect(room.champion?.playerId).toBe('p0');

    applyRoll(room, 'p2', WUHONG, T0 + 2); // 五红更高 → 替换
    expect(room.champion?.playerId).toBe('p2');
    expect(room.champion?.result.rankKey).toEqual([8, 6, 0]);

    // 每人保留自己的最佳状元成绩
    expect(player(room, 'p0').best?.rankKey).toEqual([6, 8, 0]);
    expect(player(room, 'p2').best?.rankKey).toEqual([8, 6, 0]);
  });

  it('先到先得：后来的同分不夺走领先者', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', SIHONG, T0);
    applyRoll(room, 'p1', SIHONG, T0 + 1);
    expect(room.champion?.playerId).toBe('p0');
    expect(room.champion?.at).toBe(T0);
  });
});

describe('结算幂等', () => {
  it('状元只发一次，重复 finishGame 不重复发奖', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', WUHONG, T0);
    finishGame(room, 'host-ended', T0 + 1);
    expect(room.status).toBe('finished');
    expect(room.pool.zhuangyuan).toBe(0);
    expect(player(room, 'p0').awards.zhuangyuan).toBe(1);

    finishGame(room, 'host-ended', T0 + 2);
    expect(player(room, 'p0').awards.zhuangyuan).toBe(1);
    expect(room.pool.zhuangyuan).toBe(0);
  });

  it('无人夺魁时状元空缺且库存保留 1', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', NONE, T0);
    finishGame(room, 'host-ended', T0 + 1);
    expect(room.champion).toBeNull();
    expect(room.pool.zhuangyuan).toBe(1);
  });

  it('轮数上限结算时把状元发给领先者', () => {
    const room = makeRoom(2, { maxRounds: 5 });
    startGame(room, T0, 0);
    applyRoll(room, 'p0', SIHONG, T0); // 状元候选
    applyRoll(room, 'p1', ERJU, T0 + 1); // 普通奖即时发放
    for (let i = 2; i < 9; i++) applyRoll(room, currentPlayerId(room), NONE, T0 + i);
    expect(room.status).toBe('playing');
    applyRoll(room, currentPlayerId(room), NONE, T0 + 9);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('round-limit');
    expect(room.champion?.playerId).toBe('p0');
    expect(player(room, 'p0').awards.zhuangyuan).toBe(1);
    expect(player(room, 'p1').awards.erju).toBe(1);
    expect(player(room, 'p0').awards.erju).toBe(0);
  });
});

describe('超时跳过', () => {
  it('到点只跳过 1 次，无骰子无奖，重复调用不再轮转', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);

    expect(skipExpiredTurn(room, T0 + TURN_MS - 1)).toBe(false);
    expect(skipExpiredTurn(room, T0 + TURN_MS)).toBe(true);
    const record = room.history[0];
    expect(record.reason).toBe('timeout');
    expect(record.dice).toEqual([]);
    expect(record.result).toBeNull();
    expect(record.awarded).toBeNull();
    expect(room.turnPlayerId).toBe('p1');
    expect(room.deadline).toBe(T0 + TURN_MS + TURN_MS);

    // 同一时刻重复 tick 不再产生第二条记录
    expect(skipExpiredTurn(room, T0 + TURN_MS)).toBe(false);
    expect(skipExpiredTurn(room, T0 + TURN_MS + 1)).toBe(false);
    expect(room.history).toHaveLength(1);
  });

  it('超时也消耗机会，与掷骰交错时不会重复轮转', () => {
    const room = makeRoom(2, { maxRounds: 5 });
    startGame(room, T0, 0);
    applyRoll(room, 'p0', NONE, T0 + 1);
    skipExpiredTurn(room, T0 + TURN_MS + 1);
    applyRoll(room, 'p0', NONE, T0 + TURN_MS + 2);
    expect(room.history.map((record) => record.reason)).toEqual(['rolled', 'timeout', 'rolled']);
    expect(room.round).toBe(2);
    expect(room.turnPlayerId).toBe('p1');
  });

  it('暂停期间不判超时', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    pauseRoom(room, T0 + 5_000);
    expect(room.paused).toBe(true);
    expect(room.deadline).toBeNull();
    expect(skipExpiredTurn(room, T0 + 10 * TURN_MS)).toBe(false);
    expect(room.history).toHaveLength(0);
  });
});

describe('暂停与恢复', () => {
  it('全员离线保留剩余毫秒，有人回来恢复 deadline', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    pauseRoom(room, T0 + 12_000);
    expect(room.pauseRemainingMs).toBe(18_000);
    expect(room.deadline).toBeNull();

    resumeRoom(room, T0 + 60_000);
    expect(room.paused).toBe(false);
    expect(room.deadline).toBe(T0 + 60_000 + 18_000);
    expect(room.pauseRemainingMs).toBeNull();
  });
});

describe('离开与人数不足', () => {
  it('对局中离开保留历史、跳过其回合，少于 2 人提前结算', () => {
    const room = makeRoom(3, { maxRounds: 5 });
    startGame(room, T0, 0);
    applyRoll(room, 'p0', NONE, T0);

    player(room, 'p1').left = true;
    expect(dropCurrentTurnIfPlayer(room, 'p1', T0 + 1)).toBe(true);
    expect(room.turnPlayerId).toBe('p2');
    expect(room.status).toBe('playing');
    expect(room.history).toHaveLength(1); // 历史保留

    player(room, 'p2').left = true;
    if (activePlayers(room).length < 2) finishGame(room, 'players-left', T0 + 2);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('players-left');
    expect(room.history).toHaveLength(1);
    expect(room.players).toHaveLength(3);
  });
});

describe('房主转交', () => {
  it('主动离开时交给最早入座的在线成员', () => {
    const room = makeRoom(3);
    player(room, 'p1').online = false;
    const next = transferHost(room, { excludePlayerId: 'p0' });
    expect(next).toBe('p2'); // p1 离线，优先在线
    expect(room.hostId).toBe('p2');
  });

  it('没有候选时不转交', () => {
    const room = makeRoom(1);
    expect(transferHost(room, { excludePlayerId: 'p0' })).toBeNull();
    expect(room.hostId).toBe('p0');
  });

  it('自动转交只考虑在线候选：全员离线时不转交', () => {
    const room = makeRoom(3);
    // 房主是后入座者，其余成员全部离线
    room.hostId = 'p2';
    player(room, 'p0').online = false;
    player(room, 'p1').online = false;
    player(room, 'p2').online = false;
    expect(transferHost(room, { onlineOnly: true })).toBeNull();
    expect(room.hostId).toBe('p2');

    // 有一位成员回来才转交给他
    player(room, 'p1').online = true;
    expect(transferHost(room, { onlineOnly: true })).toBe('p1');
    expect(room.hostId).toBe('p1');
  });

  it('转交不重置回合与奖池', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', ERJU, T0);
    room.pool.duitang = 1;
    const turnId = room.turnId;
    transferHost(room, { excludePlayerId: 'p0' });
    expect(room.hostId).toBe('p1');
    expect(room.turnId).toBe(turnId);
    expect(room.pool.duitang).toBe(1);
    expect(room.round).toBe(1);
  });
});

describe('再开一局重置', () => {
  it('房码与身份保留、离开者清理、奖品与记录重置、准备状态重置', () => {
    const room = makeRoom(3, { maxRounds: 5 });
    startGame(room, T0, 0);
    applyRoll(room, 'p0', DUITANG, T0);
    player(room, 'p2').left = true;
    finishGame(room, 'host-ended', T0 + 1);

    const code = room.code;
    prepareRematch(room, T0 + 2);
    expect(room.code).toBe(code);
    expect(room.gameNumber).toBe(2);
    expect(room.status).toBe('waiting');
    expect(room.round).toBe(0);
    expect(room.players.map((player) => player.id)).toEqual(['p0', 'p1']);
    expect(room.players[0].ready).toBe(true); // 房主默认准备
    expect(room.players[1].ready).toBe(false); // 非房主准备取消
    expect(room.players[0].awards).toEqual({ zhuangyuan: 0, duitang: 0, sanhong: 0, sijin: 0, erju: 0, yixiu: 0 });
    expect(room.pool.duitang).toBe(2);
    expect(room.history).toEqual([]);
    expect(room.champion).toBeNull();
    expect(room.finishedReason).toBeNull();
    expect(room.turnOrder).toEqual([]);
  });
});

describe('isValidDice', () => {
  it('只接受 6 个 1–6 整数', () => {
    expect(isValidDice([1, 2, 3, 4, 5, 6])).toBe(true);
    for (const value of [[], [1, 2, 3], [1, 2, 3, 4, 5, 7], [0, 1, 2, 3, 4, 5], [1, 2, 3, 4, 5, '6'], null, '123456', [1, 2, 3, 4, 5, 1.5]]) {
      expect(isValidDice(value)).toBe(false);
    }
  });
});
