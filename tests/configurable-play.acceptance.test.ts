/** 跨层验收：通过真实服务动作逐份领奖，检查库存守恒、收尾、唯一状元及独立归档。 */
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { AppDatabase } from '../server/db.js';
import { RoomService } from '../server/room-service.js';
import { createDefaultRoomConfig } from '../shared/room-config.js';
import { NORMAL_PRIZE_KEYS, PRIZE_KEYS, ROOM_TTL_MS } from '../shared/rules.js';
import type { Action, Membership, RoomConfig, RoomState } from '../shared/types.js';

const NONE = [1, 1, 2, 2, 3, 3];
const SIHONG = [4, 4, 4, 4, 2, 6];
const WUHONG = [4, 4, 4, 4, 4, 6];
const CHAJINHUA = [4, 4, 4, 4, 1, 1];
const NORMAL_DICE = [
  [4, 1, 1, 2, 3, 5],
  [4, 4, 1, 2, 3, 5],
  [4, 4, 4, 1, 2, 3],
  [2, 2, 2, 2, 3, 5],
  [1, 2, 3, 4, 5, 6],
];
const databases: AppDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function minimalConfig(): RoomConfig {
  const config = createDefaultRoomConfig();
  for (const key of PRIZE_KEYS) config.prizes[key].count = 1;
  return config;
}

function startTable(config: RoomConfig, players: number) {
  const db = new AppDatabase(':memory:');
  databases.push(db);
  const clock = { now: 1_800_000_000_000 };
  const diceQueue: number[][] = [];
  const service = new RoomService({
    db,
    now: () => clock.now,
    rollDice: () => {
      const dice = diceQueue.shift();
      if (!dice) throw new Error('验收用例未提供本手点数');
      return dice;
    },
    pickStartSeat: () => 0,
  });
  const created = service.create({
    nickname: '房主', name: '完整发奖验收', maxPlayers: players, config, maxRounds: undefined,
  }, 'acceptance');
  const { roomCode: code } = created.membership;
  const members: Membership[] = [created.membership];
  for (let i = 1; i < players; i += 1) {
    members.push(service.join(code, `玩家${i}`, 'acceptance').membership);
  }
  for (const member of members) {
    service.connectMember(code, member.token);
    service.action(code, member.token, { type: 'ready', ready: true });
  }
  let room = service.action(code, members[0]!.token, { type: 'start' }).room;
  let last: { member: Membership; action: Extract<Action, { type: 'roll' }> } | undefined;
  const roll = (dice: readonly number[]): RoomState => {
    const member = members.find(item => item.playerId === room.turnPlayerId);
    if (!member || !room.turnId) throw new Error('对局提前结束或没有合法当前玩家');
    const previousRevision = room.revision;
    const action = { type: 'roll' as const, requestId: randomUUID(), expectedTurnId: room.turnId };
    diceQueue.push([...dice]);
    clock.now += 1;
    room = service.action(code, member.token, action).room;
    last = { member, action };
    expect(room.revision).toBeGreaterThan(previousRevision);
    for (const key of PRIZE_KEYS) {
      expect(room.pool[key]).toBeGreaterThanOrEqual(0);
      expect(room.pool[key] + room.players.reduce((sum, player) => sum + player.awards[key], 0))
        .toBe(room.initialPool[key]);
    }
    expect(JSON.stringify(room)).not.toContain('tokenHash');
    return room;
  };
  const retryLast = (): RoomState => {
    if (!last) throw new Error('尚未投掷');
    return service.action(code, last.member.token, last.action).room;
  };
  return { db, clock, service, code, members, createdAt: room.createdAt, roll, retryLast };
}

it.each([
  ['continuous', 'all-prizes'],
  ['high-tier-lock', 'all-prizes'],
  ['continuous', 'rounds'],
  ['high-tier-lock', 'rounds'],
] as const)('%s / %s：最后一轮顶状元、三份归一人、重复请求与过期清理不丢归档', (rulesetId, mode) => {
  const config = minimalConfig();
  config.rulesetId = rulesetId;
  config.prizes.zhuangyuan = { count: 3, content: '状元礼盒' };
  config.endCondition = mode === 'rounds' ? { mode, maxRounds: 5 } : { mode };
  const table = startTable(config, 4);
  // 固定轮数场景把收尾安排在第 5 轮，覆盖“发完”和“上限”同时到达的原因选择。
  if (mode === 'rounds') for (let i = 0; i < 12; i += 1) table.roll(NONE);
  table.roll(SIHONG);
  let room!: RoomState;
  for (const dice of NORMAL_DICE) room = table.roll(dice);
  expect(room.status).toBe('playing');
  expect(room.closingRound).toBe(mode === 'rounds' ? 5 : 2);
  expect(room.pool.zhuangyuan).toBe(3);
  room = table.roll(WUHONG);
  expect(room.status).toBe('playing');
  expect(room.champion?.locked).toBe(rulesetId === 'high-tier-lock');
  room = table.roll(CHAJINHUA);
  const winner = table.members[rulesetId === 'continuous' ? 3 : 2]!;
  expect(room.status).toBe('finished');
  expect(room.finishedReason).toBe('pool-empty');
  expect(room.incomplete).toBe(false);
  expect(room.round).toBe(mode === 'rounds' ? 5 : 2);
  expect(room.champion?.playerId).toBe(winner.playerId);
  expect(room.players.filter(player => player.awards.zhuangyuan > 0)).toHaveLength(1);
  expect(room.players.find(player => player.id === winner.playerId)?.awards.zhuangyuan).toBe(3);
  expect(room.players.reduce((sum, player) => sum + player.rollCount, 0)).toBe(mode === 'rounds' ? 20 : 8);
  expect(PRIZE_KEYS.every(key => room.pool[key] === 0)).toBe(true);
  expect(table.retryLast()).toEqual(room);
  expect(table.db.listArchives(table.code, table.createdAt)).toHaveLength(1);
  expect(room.expiresAt).not.toBeNull();
  table.clock.now = room.expiresAt! + 1;
  table.service.tick();
  expect(table.db.getRoom(table.code)).toBeNull();
  const archived = table.db.listArchives(table.code, table.createdAt);
  expect(archived).toHaveLength(1);
  expect(archived[0]?.reason).toBe('pool-empty');
  expect(archived[0]?.incomplete).toBe(false);
  expect(archived[0]?.stateJson).not.toContain('tokenHash');
  const snapshot = JSON.parse(archived[0]!.stateJson) as RoomState;
  expect(snapshot.players.find(player => player.id === winner.playerId)?.awards.zhuangyuan).toBe(3);
});

it('五档真实发空后超过 20 轮仍等状元，出现后收完当前轮且允许最后一人顶替', () => {
  const table = startTable(minimalConfig(), 2);
  let room!: RoomState;
  for (const dice of NORMAL_DICE) room = table.roll(dice);
  expect(NORMAL_PRIZE_KEYS.every(key => room.pool[key] === 0)).toBe(true);
  expect(room.champion).toBeNull();
  for (let i = 0; i < 41; i += 1) room = table.roll(NONE);
  expect(room.status).toBe('playing');
  expect(room.round).toBe(24);
  expect(room.closingRound).toBeNull();
  room = table.roll(SIHONG);
  expect(room.status).toBe('playing');
  expect(room.closingRound).toBe(24);
  room = table.roll(CHAJINHUA);
  expect(room.status).toBe('finished');
  expect(room.round).toBe(24);
  expect(room.champion?.playerId).toBe(table.members[1]!.playerId);
  expect(room.players.reduce((sum, player) => sum + player.rollCount, 0)).toBe(48);
  expect(room.pool.zhuangyuan).toBe(0);
});

it('最后一个机会因超时结束时，也从结算时刻开始保留 24 小时', () => {
  const config = minimalConfig();
  config.endCondition = { mode: 'rounds', maxRounds: 5 };
  const table = startTable(config, 2);
  for (let i = 0; i < 10; i += 1) {
    const before = table.service.getSnapshot(table.code)!;
    expect(before.status).toBe('playing');
    table.clock.now = before.deadline!;
    table.service.tick();
  }
  const finished = table.service.getSnapshot(table.code)!;
  expect(finished.status).toBe('finished');
  expect(finished.finishedReason).toBe('round-limit');
  expect(finished.expiresAt).toBe(table.clock.now + ROOM_TTL_MS);
  expect(finished.players.reduce((sum, player) => sum + player.timeoutCount, 0)).toBe(10);
});

it('最后在线成员主动离席、其余成员仅离线时，应立即暂停并建立离线期限', () => {
  const table = startTable(minimalConfig(), 2);
  const host = table.members[0]!;
  const guest = table.members[1]!;
  table.service.disconnectMember(table.code, guest.playerId);
  table.clock.now += 1_000;
  const paused = table.service.action(table.code, host.token, { type: 'leave' }).room;
  expect(paused.status).toBe('playing');
  expect(paused.paused).toBe(true);
  expect(paused.deadline).toBeNull();
  expect(paused.allOfflineSince).toBe(table.clock.now);
  expect(paused.expiresAt).toBe(table.clock.now + ROOM_TTL_MS);
  table.clock.now += 60_000;
  table.service.tick();
  expect(table.service.getSnapshot(table.code)?.history).toHaveLength(0);
});

it('固定局最后一轮全员主动离席，应记录未完成，不能因轮指针越界记为正常结算', () => {
  const config = minimalConfig();
  config.endCondition = { mode: 'rounds', maxRounds: 5 };
  const table = startTable(config, 2);
  for (let i = 0; i < 9; i += 1) table.roll(NONE);
  table.service.action(table.code, table.members[0]!.token, { type: 'leave' });
  const closed = table.service.action(table.code, table.members[1]!.token, { type: 'leave' }).room;
  expect(closed.status).toBe('closed');
  expect(closed.finishedReason).toBe('all-left');
  expect(closed.incomplete).toBe(true);
  expect(table.db.listArchives(table.code, table.createdAt)[0]?.reason).toBe('all-left');
});

it('旧房间的提前收尾标记在没有状元时不能造成“奖品发完”的错误结算', () => {
  const config = createDefaultRoomConfig();
  config.endCondition = { mode: 'rounds', maxRounds: 20 };
  const table = startTable(config, 4);
  const keys = ['yixiu', 'erju', 'sanhong', 'sijin', 'duitang'] as const;
  for (const [index, key] of keys.entries()) {
    for (let n = 0; n < config.prizes[key].count; n += 1) table.roll(NORMAL_DICE[index]!);
  }
  // V1 会在普通奖发完时立刻保存 pendingFinish，即便尚无状元。
  // 使用实际完成 62 次发奖后的完整存储快照，转换为真实的旧字段集合。
  const stored = table.db.getRoom(table.code)!;
  const legacy = JSON.parse(stored.stateJson) as Record<string, unknown>;
  for (const key of ['config', 'ruleset', 'initialPool', 'closingRound', 'incomplete', 'allOfflineSince']) {
    delete legacy[key];
  }
  legacy.maxRounds = 20;
  legacy.pendingFinish = 'pool-empty';
  legacy.expiresAt = table.clock.now + ROOM_TTL_MS;
  for (const player of legacy.players as Array<Record<string, unknown>>) {
    delete player.rollCount;
    delete player.timeoutCount;
  }
  table.db.saveRoom({
    ...stored,
    stateJson: JSON.stringify(legacy),
    expiresAt: table.clock.now + ROOM_TTL_MS,
  });
  const restoredService = new RoomService({ db: table.db, now: () => table.clock.now, rollDice: () => [...NONE] });
  let restored = restoredService.state(table.code, table.members[0]!.token).room;
  expect(restored.config.endCondition).toEqual({ mode: 'rounds', maxRounds: 20 });
  expect(restored.champion).toBeNull();
  expect(restored.closingRound).toBeNull();
  for (let i = 0; i < 2; i += 1) {
    const member = table.members.find(item => item.playerId === restored.turnPlayerId)!;
    restored = restoredService.action(table.code, member.token, {
      type: 'roll', requestId: randomUUID(), expectedTurnId: restored.turnId!,
    }).room;
  }
  expect(restored.status).toBe('playing');
  expect(restored.finishedReason).toBeNull();
  expect(restored.pool.zhuangyuan).toBe(1);
});
