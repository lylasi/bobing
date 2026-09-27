import { describe, expect, it } from 'vitest';
import {
  activePlayers,
  applyRoll,
  completeResultPresentation,
  createInternalRoom,
  dropCurrentTurnIfPlayer,
  findPlayer,
  finishGame,
  isValidDice,
  maxRoundsOf,
  pauseRoom,
  prepareRematch,
  resumeRoom,
  skipExpiredTurn,
  startGame,
  transferHost,
} from '../server/game.js';
import type { InternalPlayer, InternalRoom } from '../server/game.js';
import { NORMAL_PRIZE_KEYS, emptyAwards } from '../shared/rules.js';
import { createDefaultRoomConfig, poolFromConfig } from '../shared/room-config.js';
import { createDefaultRoomAccess } from '../shared/room-access.js';
import { DEFAULT_RESULT_HOLD_SECONDS, DICE_REVEAL_MS } from '../shared/presentation.js';
import { snapshotRuleset } from '../shared/rulesets.js';
import type { RoomConfig } from '../shared/types.js';

const T0 = 1_800_000_000_000;
const TURN_MS = 30_000;
const DAY_MS = 24 * 3600 * 1000;

// 判奖样例骰子（与 rules.test.ts 相同来源）
const NONE = [1, 1, 2, 2, 3, 3];
const YIXIU = [4, 1, 2, 3, 5, 5];
const ERJU = [4, 4, 1, 2, 3, 5];
const SIJIN = [2, 2, 2, 2, 4, 4];
const DUITANG = [1, 2, 3, 4, 5, 6];
const SIHONG = [4, 4, 4, 4, 2, 6];
const WUZI = [2, 2, 2, 2, 2, 4];
const WUHONG = [4, 4, 4, 4, 4, 6];
const LIUHE = [6, 6, 6, 6, 6, 6];
const CHAJINHUA = [4, 4, 4, 4, 1, 1];

/** 旧客户端 maxRounds 请求的等价配置，供未关心结束方式的用例复用。 */
function roundsConfig(maxRounds: 5 | 10 | 20): RoomConfig {
  return { ...createDefaultRoomConfig(), endCondition: { mode: 'rounds', maxRounds } };
}

function makeRoom(
  playerCount = 2,
  overrides: { maxRounds?: 5 | 10 | 20; config?: RoomConfig; maxPlayers?: number; turnDurationMs?: number } = {},
): InternalRoom {
  const config = overrides.config ?? roundsConfig(overrides.maxRounds ?? 5);
  const room = createInternalRoom({
    code: 'ABCDEF',
    name: '中秋团圆局',
    maxPlayers: overrides.maxPlayers ?? Math.max(2, playerCount),
    config,
    hostId: 'p0',
    hostNickname: '玩家0',
    hostTokenHash: 'hash-0',
    now: T0,
    expiresAt: T0 + DAY_MS,
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
      rollCount: 0,
      timeoutCount: 0,
      lastRoll: null,
      tokenHash: `hash-${i}`,
      lastSeenAt: T0,
    });
  }
  for (const player of room.players) player.online = true;
  return room;
}

/** 指定配置的房间：ruleset／initialPool／pool 全部由 config 派生。 */
function configuredRoom(playerCount: number, config: RoomConfig = createDefaultRoomConfig()): InternalRoom {
  return makeRoom(playerCount, { config });
}

function player(room: InternalRoom, id: string): InternalPlayer {
  const found = findPlayer(room, id);
  if (!found) throw new Error(`测试房间缺少玩家 ${id}`);
  return found;
}

/**
 * 仅供“不关心展示时长”的原有游戏测试显式调用：把当前结果展示读完并推进到下一手。
 * 新阶段测试直接使用 applyRoll + completeResultPresentation 的原始时序，不经过这里的包装。
 * 返回展示结束（= 下一位实际开放）的时刻，便于断言“下一位拿到完整 30 秒”。
 */
function finishDisplayedResult(room: InternalRoom): number {
  const until = room.presentation?.until;
  if (until === null || until === undefined) throw new Error('缺少待展示结果');
  expect(completeResultPresentation(room, until)).toBe(true);
  return until;
}

/** 投掷并立即读完结果展示（等价于本轮之前的“即时推进”行为）。 */
function rollThrough(room: InternalRoom, playerId: string, dice: readonly number[], now: number): number {
  applyRoll(room, playerId, dice, now);
  return finishDisplayedResult(room);
}

/** 超时并立即读完结果展示。 */
function timeoutThrough(room: InternalRoom, now: number): void {
  expect(skipExpiredTurn(room, now)).toBe(true);
  finishDisplayedResult(room);
}

function currentPlayerId(room: InternalRoom): string {
  const id = room.turnPlayerId;
  if (id === null) throw new Error('当前没有回合玩家');
  return id;
}

function lockConfig(): RoomConfig {
  return { ...createDefaultRoomConfig(), rulesetId: 'high-tier-lock' };
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

  it('开局状态：playing、第 1 轮、UUID turnId、30 秒 deadline、按 config 满额奖池', () => {
    const config = createDefaultRoomConfig();
    config.prizes.yixiu = { count: 7, content: '月饼一盒' };
    const room = configuredRoom(2, config);
    startGame(room, T0, 0);
    expect(room.status).toBe('playing');
    expect(room.round).toBe(1);
    expect(room.turnId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(room.deadline).toBe(T0 + TURN_MS);
    expect(room.pool).toEqual({ zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 7 });
    expect(room.initialPool.yixiu).toBe(7);
    expect(room.history).toEqual([]);
    expect(room.champion).toBeNull();
    expect(room.closingRound).toBeNull();
    expect(room.incomplete).toBe(false);
    expect(room.ruleset.name).toBe('持续顶状元');
    // 新房默认：结果停留 1 秒、公开且允许旁观
    expect(room.pacing).toEqual({ resultHoldSeconds: DEFAULT_RESULT_HOLD_SECONDS });
    expect(room.access).toEqual(createDefaultRoomAccess());
    expect(room.presentation).toBeNull();
  });

  it('活跃对局的到期时间为 null，不受创建后 24 小时截断', () => {
    const room = makeRoom(2);
    expect(room.expiresAt).toBe(T0 + DAY_MS);
    startGame(room, T0, 0);
    expect(room.expiresAt).toBeNull();
    applyRoll(room, 'p0', NONE, T0 + 1);
    expect(room.expiresAt).toBeNull();
  });

  it('从等待区带旧数据开局时清空上一局记录、奖项与累计统计', () => {
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
      championOutcome: null,
    });
    room.players[0].awards.duitang = 1;
    room.players[0].best = { code: 'yixiu', label: '一秀', prize: 'yixiu', rankKey: [1, 0, 0] };
    room.players[0].rollCount = 9;
    room.players[0].timeoutCount = 3;
    room.pool.duitang = 1;
    startGame(room, T0, 0);
    expect(room.history).toEqual([]);
    expect(room.players[0].awards.duitang).toBe(0);
    expect(room.players[0].best).toBeNull();
    expect(room.players[0].rollCount).toBe(0);
    expect(room.players[0].timeoutCount).toBe(0);
    expect(room.players[0].lastRoll).toBeNull();
    expect(room.championEvents).toEqual([]);
    expect(room.championHistoryComplete).toBe(true);
    expect(room.presentation).toBeNull();
    expect(room.pool.duitang).toBe(2);
  });
});

describe('轮转与结束方式', () => {
  it('2 人 5 轮：每人每轮恰好一次机会，第 10 手后按轮数上限结算', () => {
    const room = makeRoom(2, { maxRounds: 5 });
    startGame(room, T0, 0);
    const order: string[] = [];
    for (let i = 0; i < 10; i++) {
      order.push(currentPlayerId(room));
      rollThrough(room, currentPlayerId(room), NONE, T0 + i);
    }
    expect(order).toEqual(['p0', 'p1', 'p0', 'p1', 'p0', 'p1', 'p0', 'p1', 'p0', 'p1']);
    expect(room.history).toHaveLength(10);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('round-limit');
    expect(room.incomplete).toBe(false);
    expect(room.round).toBe(5); // 第 6 轮从未开始，round 停在最后一轮
    expect(room.deadline).toBeNull();
  });

  it('固定轮数达到上限时剩余奖品与空缺照常保留，不冒称奖品发完', () => {
    const room = makeRoom(2, { maxRounds: 5 });
    startGame(room, T0, 0);
    for (let i = 0; i < 10; i++) rollThrough(room, currentPlayerId(room), YIXIU, T0 + i);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('round-limit');
    expect(room.incomplete).toBe(false);
    expect(room.champion).toBeNull();
    expect(room.pool.zhuangyuan).toBe(1); // 无人夺魁，状元空缺
    expect(room.pool.yixiu).toBe(22); // 32 份发出 10 份，剩余照常展示
  });

  it('无限轮数：连续 300 手仍在进行，远超旧 20 轮上限', () => {
    const room = configuredRoom(2);
    startGame(room, T0, 0);
    for (let i = 0; i < 300; i++) rollThrough(room, currentPlayerId(room), NONE, T0 + i);
    expect(room.status).toBe('playing');
    expect(room.round).toBe(151);
    expect(room.champion).toBeNull();
  });

  it('12 人 20 轮最多 240 条记录，不超过历史上限，累计投掷独立保存', () => {
    const room = makeRoom(12, { maxRounds: 20 });
    startGame(room, T0, 0);
    for (let i = 0; i < 240; i++) rollThrough(room, currentPlayerId(room), NONE, T0 + i);
    expect(room.history).toHaveLength(240);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('round-limit');
    expect(new Set(room.history.map((record) => record.turnId)).size).toBe(240);
    expect(room.players.reduce((sum, candidate) => sum + candidate.rollCount, 0)).toBe(240);
  });

  it('超过历史窗口仍准确累计投掷次数（A16）', () => {
    const room = configuredRoom(2);
    startGame(room, T0, 0);
    for (let i = 0; i < 300; i++) {
      rollThrough(room, currentPlayerId(room), NONE, T0 + i);
      if (i % 10 === 0) timeoutThrough(room, room.deadline ?? 0);
    }
    expect(room.history).toHaveLength(240);
    const rolls = room.players.reduce((sum, candidate) => sum + candidate.rollCount, 0);
    const timeouts = room.players.reduce((sum, candidate) => sum + candidate.timeoutCount, 0);
    expect(rolls + timeouts).toBeGreaterThan(300);
    expect(rolls).toBe(300);
    expect(timeouts).toBeGreaterThan(0);
    expect(room.status).toBe('playing');
  });

  it('离开席位不重排顺序，轮数仍按完整顺序边界计算', () => {
    const room = makeRoom(3, { maxRounds: 5 });
    startGame(room, T0, 0);
    // p1 在当前回合离开（先被跳过）
    player(room, 'p1').left = true;
    expect(dropCurrentTurnIfPlayer(room, 'p1', T0)).toBe(false); // p1 不是当前玩家
    applyRoll(room, 'p0', NONE, T0);
    expect(room.presentation?.recordId).toBe(room.history[0]?.id); // 展示期间保留本次上下文
    finishDisplayedResult(room);
    expect(room.turnPlayerId).toBe('p2'); // 跳过 p1
    rollThrough(room, 'p2', NONE, T0 + 1);
    expect(room.round).toBe(2); // 三人顺序跑完仍算一轮
    expect(room.turnPlayerId).toBe('p0');
  });

  it('maxRoundsOf 只对固定轮数模式返回上限', () => {
    expect(maxRoundsOf(configuredRoom(2))).toBeNull();
    expect(maxRoundsOf(makeRoom(2, { maxRounds: 10 }))).toBe(10);
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
    finishDisplayedResult(room);

    const second = applyRoll(room, 'p1', DUITANG, T0 + 1);
    expect(second.awarded).toBeNull();
    expect(second.result?.code).toBe('duitang');
    expect(room.pool.duitang).toBe(0);
    expect(player(room, 'p1').awards.duitang).toBe(0);
  });

  it('一次投掷只判最高牌型：四进不兼得二举，插金花不额外领对堂，六红不清空奖池（A19）', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    const sijin = applyRoll(room, 'p0', SIJIN, T0);
    expect(sijin.result?.code).toBe('sijin');
    expect(sijin.awarded).toBe('sijin');
    expect(player(room, 'p0').awards.erju).toBe(0);
    expect(player(room, 'p0').awards.yixiu).toBe(0);
    finishDisplayedResult(room);

    const cha = applyRoll(room, 'p1', CHAJINHUA, T0 + 1);
    expect(cha.result?.code).toBe('chajinhua');
    expect(cha.awarded).toBeNull(); // 状元整局结束时才发
    expect(room.pool.duitang).toBe(2); // 插金花不领对堂

    player(room, 'p0').awards.duitang = 1;
    room.pool.duitang = 1;
    finishDisplayedResult(room);
    applyRoll(room, 'p0', LIUHE, T0 + 2);
    expect(player(room, 'p0').awards.duitang).toBe(1); // 六红不追回普通奖
    expect(room.pool.duitang).toBe(1);
  });
});

describe('收尾（奖品发完结束）', () => {
  it('普通奖空缺状元时继续轮转，产生状元后收完当轮并发全部状元份数', () => {
    const config = createDefaultRoomConfig();
    config.prizes.zhuangyuan.count = 3;
    const room = configuredRoom(3, config);
    startGame(room, T0, 0);
    for (const key of NORMAL_PRIZE_KEYS) room.pool[key] = 0;
    for (let i = 0; i < 3; i++) rollThrough(room, currentPlayerId(room), NONE, T0 + i);
    expect(room.status).toBe('playing');
    expect(room.champion).toBeNull();
    expect(room.closingRound).toBeNull(); // 普通奖空但无人状元 → 不进入收尾

    rollThrough(room, 'p0', SIHONG, T0 + 3);
    expect(room.closingRound).toBe(2);

    rollThrough(room, 'p1', NONE, T0 + 4);
    expect(room.status).toBe('playing'); // 本轮尚未结束

    applyRoll(room, 'p2', WUHONG, T0 + 5);
    finishDisplayedResult(room);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('pool-empty');
    expect(room.incomplete).toBe(false);
    expect(player(room, 'p2').awards.zhuangyuan).toBe(3);
    expect(room.pool.zhuangyuan).toBe(0);

    finishGame(room, 'pool-empty', T0 + 6);
    expect(player(room, 'p2').awards.zhuangyuan).toBe(3); // 重复结算不重复发奖
  });

  it('收尾不多打一轮：本轮最后一人收尾后立即结算', () => {
    const room = configuredRoom(4);
    startGame(room, T0, 0);
    for (const key of NORMAL_PRIZE_KEYS) room.pool[key] = 0;
    applyRoll(room, 'p0', SIHONG, T0);
    expect(room.closingRound).toBe(1);
    finishDisplayedResult(room);
    rollThrough(room, 'p1', NONE, T0 + 1);
    applyRoll(room, 'p2', WUHONG, T0 + 2); // 持续版严格更大 → 顶替
    expect(room.champion?.playerId).toBe('p2');
    expect(room.status).toBe('playing');
    finishDisplayedResult(room);
    applyRoll(room, 'p3', NONE, T0 + 3);
    finishDisplayedResult(room);
    expect(room.status).toBe('finished');
    expect(room.history).toHaveLength(4); // 只完成当前整轮，第 2 轮从未开始
    expect(room.closingRound).toBe(1);
    expect(player(room, 'p2').awards.zhuangyuan).toBe(1);
    expect(player(room, 'p0').awards.zhuangyuan).toBe(0);
  });

  it('收尾标记残留但没有状元时不按“奖品发完”结算，也不会一直挂着（防御旧数据）', () => {
    const room = configuredRoom(2);
    startGame(room, T0, 0);
    for (const key of NORMAL_PRIZE_KEYS) room.pool[key] = 0;
    room.closingRound = room.round; // 模拟旧数据留下的收尾标记
    expect(room.champion).toBeNull();

    rollThrough(room, 'p0', NONE, T0);
    applyRoll(room, 'p1', NONE, T0 + 1); // 走到轮末
    finishDisplayedResult(room);
    expect(room.status).toBe('playing');
    expect(room.finishedReason).toBeNull();
    expect(room.closingRound).toBeNull(); // 条件不成立时标记被清掉
    expect(room.pool.zhuangyuan).toBe(1);

    // 之后出现状元才正常收尾
    applyRoll(room, 'p0', WUHONG, T0 + 2);
    expect(room.closingRound).toBe(2);
    finishDisplayedResult(room);
    applyRoll(room, 'p1', NONE, T0 + 3);
    finishDisplayedResult(room);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('pool-empty');
    expect(player(room, 'p0').awards.zhuangyuan).toBe(1);
  });

  it('固定轮数末轮同时满足收尾与上限时，按实际剩余奖品报告 pool-empty', () => {
    const room = makeRoom(2, { maxRounds: 5 });
    startGame(room, T0, 0);
    for (const key of NORMAL_PRIZE_KEYS) room.pool[key] = 0;
    for (let i = 0; i < 9; i++) rollThrough(room, currentPlayerId(room), NONE, T0 + i);
    expect(room.status).toBe('playing');
    expect(room.round).toBe(5);
    applyRoll(room, currentPlayerId(room), WUHONG, T0 + 9);
    finishDisplayedResult(room);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('pool-empty');
    expect(player(room, 'p1').awards.zhuangyuan).toBe(1);
  });
});

describe('状元比较与锁定', () => {
  it('超过当前领先者才替换，同分先到先得，持续版永不锁定', () => {
    const room = makeRoom(3);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', SIHONG, T0); // [6,8,0]
    expect(room.champion?.playerId).toBe('p0');
    expect(room.championEvents.map((event) => event.kind)).toEqual(['first']);
    finishDisplayedResult(room);
    expect(room.champion?.result.rankKey).toEqual([6, 8, 0]);
    expect(room.champion?.locked).toBe(false);
    expect(room.champion?.lockedBy).toBeNull();

    applyRoll(room, 'p1', [4, 4, 4, 4, 3, 5], T0 + 1); // 同为四红，和也是 8 → 同分保留 p0
    expect(room.champion?.playerId).toBe('p0');
    expect(room.history[1]?.championOutcome?.kind).toBe('tied');
    finishDisplayedResult(room);

    applyRoll(room, 'p2', WUHONG, T0 + 2); // 五红更高 → 替换
    expect(room.championEvents.map((event) => event.kind)).toEqual(['first', 'takeover']);
    finishDisplayedResult(room);
    expect(room.champion?.playerId).toBe('p2');
    expect(room.champion?.result.rankKey).toEqual([8, 6, 0]);
    expect(room.champion?.locked).toBe(false);

    // 每人保留自己的最佳状元成绩
    expect(player(room, 'p0').best?.rankKey).toEqual([6, 8, 0]);
    expect(player(room, 'p2').best?.rankKey).toEqual([8, 6, 0]);
  });

  it('先到先得：后来的同分不夺走领先者', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', SIHONG, T0);
    finishDisplayedResult(room);
    applyRoll(room, 'p1', SIHONG, T0 + 1);
    expect(room.champion?.playerId).toBe('p0');
    expect(room.champion?.at).toBe(T0);
  });

  it('五子登科比相同点数再比剩余一颗（A20）', () => {
    const room = makeRoom(3);
    startGame(room, T0, 0);
    rollThrough(room, 'p0', [2, 2, 2, 2, 2, 4], T0); // [7,2,4]
    applyRoll(room, 'p1', [2, 2, 2, 2, 2, 1], T0 + 1); // [7,2,1] → 更小，不替换
    expect(room.champion?.playerId).toBe('p0');
    expect(room.history[1]?.championOutcome?.kind).toBe('lower');
    finishDisplayedResult(room);
    applyRoll(room, 'p2', [3, 3, 3, 3, 3, 1], T0 + 2); // [7,3,1] → 相同点数更大 → 替换
    expect(room.champion?.playerId).toBe('p2');
  });

  it('高阶锁定：先五红后插金花不能换人，普通奖未空仍继续（A05、A06）', () => {
    const room = configuredRoom(3, lockConfig());
    startGame(room, T0, 0);
    applyRoll(room, 'p0', WUHONG, T0);
    expect(room.champion?.playerId).toBe('p0');
    expect(room.champion?.locked).toBe(true);
    expect(room.champion?.lockedBy).toBe('wuhong');
    expect(room.championEvents[0]?.locked).toBe(true); // 这次登顶同时触发锁定
    finishDisplayedResult(room);

    applyRoll(room, 'p1', CHAJINHUA, T0 + 1);
    expect(room.champion?.playerId).toBe('p0'); // 更大的插金花也不能换人
    expect(room.history[1]?.championOutcome).toEqual({ kind: 'locked', previousPlayerId: null, currentPlayerId: 'p0', locked: true });
    expect(room.status).toBe('playing'); // 锁定不提前结束整局
    expect(room.closingRound).toBeNull();
  });

  it('高阶锁定：四红、五子仍可争夺，六黑出现后锁定', () => {
    const room = configuredRoom(3, lockConfig());
    startGame(room, T0, 0);
    rollThrough(room, 'p0', SIHONG, T0);
    expect(room.champion?.locked).toBe(false);
    rollThrough(room, 'p1', WUZI, T0 + 1); // 五子 [7,2,4] > 四红 [6,8,0]
    expect(room.champion?.playerId).toBe('p1');
    expect(room.champion?.locked).toBe(false);
    applyRoll(room, 'p2', LIUHE, T0 + 2); // 六黑 [9,6,0] → 锁定
    expect(room.champion?.playerId).toBe('p2');
    expect(room.champion?.locked).toBe(true);
    expect(room.champion?.lockedBy).toBe('liuhe');
    finishDisplayedResult(room);
    applyRoll(room, 'p0', CHAJINHUA, T0 + 3);
    expect(room.champion?.playerId).toBe('p2'); // 锁定后更大也不能换人
  });

  it('状元候选离席保留资格，最终仍归原得主', () => {
    const room = makeRoom(3);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', WUHONG, T0);
    player(room, 'p0').left = true;
    finishGame(room, 'host-ended', T0 + 1);
    expect(player(room, 'p0').awards.zhuangyuan).toBe(1);
    expect(room.pool.zhuangyuan).toBe(0);
  });
});

describe('当次状元事实与个人最后结果', () => {
  it('被顶替仍保留登顶经历，个人最后结果与实际奖品分别保存，结算只发一次状元', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    const first = applyRoll(room, 'p0', SIHONG, T0 + 1);
    finishDisplayedResult(room);
    const second = applyRoll(room, 'p1', WUZI, T0 + 2);
    expect(room.championEvents.map((event) => event.kind)).toEqual(['first', 'takeover']);
    expect(second.championOutcome?.previousPlayerId).toBe('p0');
    expect(second.championOutcome?.currentPlayerId).toBe('p1');
    expect(player(room, 'p0').lastRoll?.id).toBe(first.id);
    expect(player(room, 'p0').awards.zhuangyuan).toBe(0); // 未结算不发状元

    finishGame(room, 'host-ended', T0 + 3);
    finishGame(room, 'host-ended', T0 + 4);
    expect(room.championEvents.filter((event) => event.kind === 'settled')).toHaveLength(1);
    const settled = room.championEvents.find((event) => event.kind === 'settled');
    expect(settled?.recordId).toBeNull();
    expect(settled?.awardedCount).toBe(room.initialPool.zhuangyuan);
    expect(settled?.dice).toEqual(WUZI);
    expect(player(room, 'p1').awards.zhuangyuan).toBe(room.initialPool.zhuangyuan);
  });

  it('同分、较低不算登顶；本人提高成绩记 improved，登顶次数只算 first 与 takeover', () => {
    const room = configuredRoom(3);
    startGame(room, T0, 0);
    rollThrough(room, 'p0', WUZI, T0); // [7,2,4]
    expect(room.championEvents.map((event) => event.kind)).toEqual(['first']);

    rollThrough(room, 'p1', WUZI, T0 + 1); // 同分先到先得
    expect(room.history[1]?.championOutcome?.kind).toBe('tied');
    rollThrough(room, 'p2', SIHONG, T0 + 2); // 四红 [6,8,0] 低于五子
    expect(room.history[2]?.championOutcome?.kind).toBe('lower');
    rollThrough(room, 'p0', YIXIU, T0 + 3); // 非状元牌型不记录状元判定
    expect(room.history[3]?.championOutcome).toBeNull();
    expect(room.championEvents.map((event) => event.kind)).toEqual(['first']); // 不产生虚假登顶

    rollThrough(room, 'p1', ERJU, T0 + 4);
    rollThrough(room, 'p2', DUITANG, T0 + 5);
    rollThrough(room, 'p0', WUHONG, T0 + 6); // 领先者自己提高成绩：improved，不算再次登顶
    expect(room.history[6]?.championOutcome).toEqual({
      kind: 'improved',
      previousPlayerId: 'p0',
      currentPlayerId: 'p0',
      locked: false,
    });
    expect(room.champion?.result.code).toBe('wuhong');

    rollThrough(room, 'p1', CHAJINHUA, T0 + 7); // 换人顶替
    expect(room.history[7]?.championOutcome?.kind).toBe('takeover');
    expect(room.championEvents.map((event) => event.kind)).toEqual(['first', 'improved', 'takeover']);
    expect(room.championEvents.filter((event) => event.kind === 'first' || event.kind === 'takeover')).toHaveLength(2);
  });

  it('锁定得主挡下更大的牌型：记为 locked，不产生登顶事件', () => {
    const room = configuredRoom(3, lockConfig());
    startGame(room, T0, 0);
    rollThrough(room, 'p0', WUHONG, T0);
    expect(room.championEvents[0]?.locked).toBe(true);
    rollThrough(room, 'p1', CHAJINHUA, T0 + 1);
    expect(room.history[1]?.championOutcome).toEqual({
      kind: 'locked',
      previousPlayerId: null,
      currentPlayerId: 'p0',
      locked: true,
    });
    expect(room.championEvents).toHaveLength(1);
    expect(room.champion?.playerId).toBe('p0');
  });

  it('状元事件与个人最后结果不受 240 条历史窗口裁剪', () => {
    const room = configuredRoom(2);
    startGame(room, T0, 0);
    rollThrough(room, 'p0', WUHONG, T0);
    for (let i = 0; i < 300; i++) rollThrough(room, currentPlayerId(room), NONE, T0 + 1 + i);

    expect(room.history).toHaveLength(240);
    expect(room.championEvents.map((event) => event.kind)).toEqual(['first']);
    const lastP0 = player(room, 'p0').lastRoll;
    const lastP1 = player(room, 'p1').lastRoll;
    expect(lastP0?.playerId).toBe('p0');
    expect(lastP1?.playerId).toBe('p1');
    // 个人最后结果各归其主，不会被其他人的最新记录覆盖
    expect(lastP1?.id).toBe(room.history.filter((record) => record.playerId === 'p1').at(-1)?.id);
    expect(player(room, 'p0').best?.code).toBe('wuhong');
    expect(room.champion?.playerId).toBe('p0');
  });

  it('超时也保存个人最后结果，且不产生状元判定', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    expect(skipExpiredTurn(room, T0 + TURN_MS)).toBe(true);
    const record = room.history[0];
    expect(player(room, 'p0').lastRoll?.id).toBe(record?.id);
    expect(player(room, 'p0').lastRoll?.reason).toBe('timeout');
    expect(player(room, 'p0').lastRoll?.championOutcome).toBeNull();
  });
});

describe('结果展示阶段', () => {
  it('结果读完才轮到下一位，下一位拿到完整三十秒', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    const record = applyRoll(room, 'p0', YIXIU, T0 + 100);
    expect(room.presentation?.recordId).toBe(record.id);
    expect(room.deadline).toBeNull();
    expect(room.turnPlayerId).toBe('p0'); // 展示期间保留本次 turnId／turnPlayerId 作为上下文
    expect(room.presentation?.until).toBe(T0 + 100 + DICE_REVEAL_MS + DEFAULT_RESULT_HOLD_SECONDS * 1000);
    expect(completeResultPresentation(room, T0 + 1849)).toBe(false);
    expect(completeResultPresentation(room, T0 + 1850)).toBe(true);
    expect(room.turnPlayerId).toBe('p1');
    expect(room.deadline).toBe(T0 + 1850 + TURN_MS);
    expect(completeResultPresentation(room, T0 + 1851)).toBe(false);
  });

  it('0 秒与 10 秒边界：投掷仍保留 750ms 动画，超时 0 秒可立即完成展示', () => {
    const zero = makeRoom(2);
    zero.pacing.resultHoldSeconds = 0;
    startGame(zero, T0, 0);
    applyRoll(zero, 'p0', YIXIU, T0);
    expect(zero.presentation?.until).toBe(T0 + DICE_REVEAL_MS);
    expect(completeResultPresentation(zero, T0 + DICE_REVEAL_MS - 1)).toBe(false);
    expect(completeResultPresentation(zero, T0 + DICE_REVEAL_MS)).toBe(true);

    const max = makeRoom(2);
    max.pacing.resultHoldSeconds = 10;
    startGame(max, T0, 0);
    applyRoll(max, 'p0', YIXIU, T0);
    expect(max.presentation?.until).toBe(T0 + DICE_REVEAL_MS + 10_000);

    const timeoutRoom = makeRoom(2);
    timeoutRoom.pacing.resultHoldSeconds = 0;
    startGame(timeoutRoom, T0, 0);
    expect(skipExpiredTurn(timeoutRoom, T0 + TURN_MS)).toBe(true);
    expect(timeoutRoom.presentation?.until).toBe(T0 + TURN_MS);
    expect(completeResultPresentation(timeoutRoom, T0 + TURN_MS)).toBe(true);
    expect(timeoutRoom.turnPlayerId).toBe('p1');
    expect(timeoutRoom.history).toHaveLength(1); // 超时记录保留
  });

  it('展示期间全桌暂停：保存剩余时间，重连后继续剩余部分', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', YIXIU, T0);
    pauseRoom(room, T0 + 250);
    expect(room.presentation?.until).toBeNull();
    expect(room.presentationRemainingMs).toBe(1500);
    expect(room.deadline).toBeNull();
    expect(completeResultPresentation(room, T0 + 10_000)).toBe(false); // 暂停时不结束展示

    resumeRoom(room, T0 + 10_000);
    expect(room.paused).toBe(false);
    expect(room.presentation?.until).toBe(T0 + 10_000 + 1500);
    expect(room.presentationRemainingMs).toBeNull();
    expect(completeResultPresentation(room, T0 + 11_499)).toBe(false);
    expect(completeResultPresentation(room, T0 + 11_500)).toBe(true);
    expect(room.turnPlayerId).toBe('p1');
    expect(room.deadline).toBe(T0 + 11_500 + TURN_MS);
  });

  it('展示中的玩家离席不提前推进，展示结束后统一跳过该席位', () => {
    const room = makeRoom(3);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', NONE, T0);
    player(room, 'p0').left = true;
    expect(dropCurrentTurnIfPlayer(room, 'p0', T0 + 100)).toBe(false);
    expect(room.turnPlayerId).toBe('p0'); // 展示仍持有上下文
    expect(room.presentation).not.toBeNull();
    expect(completeResultPresentation(room, T0 + DICE_REVEAL_MS + 1000)).toBe(true);
    expect(room.turnPlayerId).toBe('p1');
  });

  it('最后一掷经展示阶段后才结算，结算页仍能读到该次记录', () => {
    const room = makeRoom(2, { maxRounds: 5 });
    startGame(room, T0, 0);
    for (let i = 0; i < 9; i++) rollThrough(room, currentPlayerId(room), NONE, T0 + i);
    const last = applyRoll(room, currentPlayerId(room), DUITANG, T0 + 9);
    expect(room.status).toBe('playing'); // 展示期间不提前结算
    expect(room.presentation?.recordId).toBe(last.id);
    expect(completeResultPresentation(room, room.presentation?.until ?? 0)).toBe(true);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('round-limit');
    expect(room.presentation).toBeNull();
    expect(room.history.at(-1)?.id).toBe(last.id);
    expect(player(room, last.playerId).lastRoll?.id).toBe(last.id);
    expect(room.championEvents.filter((event) => event.kind === 'settled')).toHaveLength(0); // 无人夺魁不发奖
  });
});

describe('结算幂等与损坏防护', () => {
  it('状元只发一次，重复 finishGame 不重复发奖', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', WUHONG, T0);
    finishGame(room, 'host-ended', T0 + 1);
    expect(room.status).toBe('finished');
    expect(room.pool.zhuangyuan).toBe(0);
    expect(player(room, 'p0').awards.zhuangyuan).toBe(1);
    expect(room.incomplete).toBe(true); // 主动中止属于未完成

    finishGame(room, 'host-ended', T0 + 2);
    expect(player(room, 'p0').awards.zhuangyuan).toBe(1);
    expect(room.pool.zhuangyuan).toBe(0);
  });

  it('无人夺魁时状元空缺且库存保留', () => {
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
    finishDisplayedResult(room);
    applyRoll(room, 'p1', ERJU, T0 + 1); // 普通奖即时发放
    finishDisplayedResult(room);
    for (let i = 2; i < 9; i++) rollThrough(room, currentPlayerId(room), NONE, T0 + i);
    expect(room.status).toBe('playing');
    applyRoll(room, currentPlayerId(room), NONE, T0 + 9);
    finishDisplayedResult(room);
    expect(room.status).toBe('finished');
    expect(room.finishedReason).toBe('round-limit');
    expect(room.champion?.playerId).toBe('p0');
    expect(player(room, 'p0').awards.zhuangyuan).toBe(1);
    expect(player(room, 'p1').awards.erju).toBe(1);
    expect(player(room, 'p0').awards.erju).toBe(0);
  });

  it('状元得主记录损坏时结算抛错，不先扣库存再悄悄丢奖', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', WUHONG, T0);
    room.players = room.players.filter((candidate) => candidate.id !== 'p0');
    expect(() => finishGame(room, 'host-ended', T0 + 1)).toThrow(/状元玩家不在房间内/);
    expect(room.status).toBe('playing');
    expect(room.pool.zhuangyuan).toBe(1);
  });
});

describe('超时跳过', () => {
  it('到点只跳过 1 次，无骰子无奖，重复调用不再轮转，累计 timeoutCount', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);

    expect(skipExpiredTurn(room, T0 + TURN_MS - 1)).toBe(false);
    expect(skipExpiredTurn(room, T0 + TURN_MS)).toBe(true);
    const record = room.history[0];
    expect(record.reason).toBe('timeout');
    expect(record.dice).toEqual([]);
    expect(record.result).toBeNull();
    expect(record.awarded).toBeNull();
    expect(record.championOutcome).toBeNull();
    // 超时没有动画：展示时长就是配置的停留时长（默认 1 秒），期间 deadline 为 null
    expect(room.presentation?.recordId).toBe(record.id);
    expect(room.presentation?.until).toBe(T0 + TURN_MS + DEFAULT_RESULT_HOLD_SECONDS * 1000);
    expect(room.deadline).toBeNull();
    expect(player(room, 'p0').lastRoll?.id).toBe(record.id);

    // 展示未到时无法推进
    expect(completeResultPresentation(room, T0 + TURN_MS + 999)).toBe(false);
    const settledAt = finishDisplayedResult(room);
    expect(settledAt).toBe(T0 + TURN_MS + 1000);
    expect(room.turnPlayerId).toBe('p1');
    expect(room.deadline).toBe(settledAt + TURN_MS); // 下一位拿到完整 30 秒
    expect(player(room, 'p0').timeoutCount).toBe(1);
    expect(room.pool).toEqual(room.initialPool);

    // 同一时刻重复 tick 不再产生第二条记录
    expect(skipExpiredTurn(room, T0 + TURN_MS)).toBe(false);
    expect(skipExpiredTurn(room, T0 + TURN_MS + 1)).toBe(false);
    expect(room.history).toHaveLength(1);
    expect(player(room, 'p0').timeoutCount).toBe(1);
  });

  it('超时也消耗机会，与掷骰交错时不会重复轮转', () => {
    const room = makeRoom(2, { maxRounds: 5 });
    startGame(room, T0, 0);
    rollThrough(room, 'p0', NONE, T0 + 1);
    timeoutThrough(room, room.deadline ?? 0);
    applyRoll(room, 'p0', NONE, room.deadline ?? 0);
    finishDisplayedResult(room);
    expect(room.history.map((record) => record.reason)).toEqual(['rolled', 'timeout', 'rolled']);
    expect(room.round).toBe(2);
    expect(room.turnPlayerId).toBe('p1');
    expect(player(room, 'p0').rollCount).toBe(2);
    expect(player(room, 'p1').timeoutCount).toBe(1);
  });

  it('暂停期间不判超时', () => {
    const room = makeRoom(2);
    startGame(room, T0, 0);
    pauseRoom(room, T0 + 5_000);
    expect(room.paused).toBe(true);
    expect(room.deadline).toBeNull();
    expect(skipExpiredTurn(room, T0 + 10 * TURN_MS)).toBe(false);
    expect(room.history).toHaveLength(0);
    expect(room.expiresAt).toBeNull(); // 到期时间由服务层按离线起点计算，game 层不改
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

describe('离开与人数', () => {
  it('开局后仅剩一位在席成员仍可继续投掷（A14）', () => {
    const room = makeRoom(3, { maxRounds: 5 });
    startGame(room, T0, 0);
    applyRoll(room, 'p0', NONE, T0); // p0 → p1
    finishDisplayedResult(room);

    player(room, 'p1').left = true;
    expect(dropCurrentTurnIfPlayer(room, 'p1', T0 + 1)).toBe(true);
    expect(room.turnPlayerId).toBe('p2');
    expect(room.status).toBe('playing');

    player(room, 'p2').left = true;
    expect(dropCurrentTurnIfPlayer(room, 'p2', T0 + 2)).toBe(true);
    expect(activePlayers(room).map((candidate) => candidate.id)).toEqual(['p0']);
    expect(room.status).toBe('playing'); // 只剩一人继续，不因人数少于两人结束

    applyRoll(room, 'p0', NONE, T0 + 3);
    finishDisplayedResult(room);
    expect(room.status).toBe('playing');
    expect(room.history).toHaveLength(2);
    // 顺序里两个已离席席位被跳过，轮数仍按完整顺序边界计算
    expect(room.round).toBe(3);
  });

  it('全员主动离席按未完成关闭并保留记录', () => {
    const room = makeRoom(3, { maxRounds: 5 });
    startGame(room, T0, 0);
    applyRoll(room, 'p0', DUITANG, T0);
    finishDisplayedResult(room);
    player(room, 'p1').left = true;
    dropCurrentTurnIfPlayer(room, 'p1', T0 + 1);
    player(room, 'p2').left = true;
    dropCurrentTurnIfPlayer(room, 'p2', T0 + 2);
    player(room, 'p0').left = true;
    expect(dropCurrentTurnIfPlayer(room, 'p0', T0 + 3)).toBe(true);
    expect(room.status).toBe('closed');
    expect(room.finishedReason).toBe('all-left');
    expect(room.incomplete).toBe(true);
    expect(room.history).toHaveLength(1);
    expect(player(room, 'p0').awards.duitang).toBe(1);
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
    expect(room.players.map((candidate) => candidate.id)).toEqual(['p0', 'p1']);
    expect(room.players[0].ready).toBe(true); // 房主默认准备
    expect(room.players[1].ready).toBe(false); // 非房主准备取消
    expect(room.players[0].awards).toEqual({ zhuangyuan: 0, duitang: 0, sanhong: 0, sijin: 0, erju: 0, yixiu: 0 });
    expect(room.pool.duitang).toBe(2);
    expect(room.history).toEqual([]);
    expect(room.champion).toBeNull();
    expect(room.finishedReason).toBeNull();
    expect(room.incomplete).toBe(false);
    expect(room.turnOrder).toEqual([]);
  });

  it('再开一局沿用本房间配置并清空库存、锁定、收尾与累计统计（A11）', () => {
    const config = lockConfig();
    config.prizes.yixiu = { count: 7, content: '月饼一盒' };
    const room = configuredRoom(2, config);
    startGame(room, T0, 0);
    applyRoll(room, 'p0', WUHONG, T0); // 锁定 + 状元候选
    finishDisplayedResult(room);
    applyRoll(room, 'p1', YIXIU, T0 + 1);
    finishGame(room, 'host-ended', T0 + 2);
    expect(player(room, 'p0').awards.zhuangyuan).toBe(1);
    expect(room.players.some((candidate) => candidate.rollCount > 0)).toBe(true);

    prepareRematch(room, T0 + 3);
    expect(room.config).toEqual(config);
    expect(room.ruleset.id).toBe('high-tier-lock');
    expect(room.initialPool.yixiu).toBe(7);
    expect(room.pool.yixiu).toBe(7);
    expect(room.pool.zhuangyuan).toBe(1);
    expect(room.champion).toBeNull();
    expect(room.closingRound).toBeNull();
    expect(room.incomplete).toBe(false);
    expect(room.players.every((candidate) => candidate.rollCount === 0 && candidate.timeoutCount === 0)).toBe(true);
    expect(room.players.every((candidate) => candidate.awards.zhuangyuan === 0)).toBe(true);
  });

  it('开局时配置与规则快照按房间保存，不随注册表变化改判', () => {
    const room = configuredRoom(2, lockConfig());
    startGame(room, T0, 0);
    // 快照是独立深拷贝：预设对象不被房间修改影响
    expect(room.ruleset).toEqual(snapshotRuleset('high-tier-lock'));
    room.ruleset.name = '被改过的名字';
    expect(snapshotRuleset('high-tier-lock').name).toBe('高阶锁定');
    expect(poolFromConfig(room.config)).toEqual(room.initialPool);
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
