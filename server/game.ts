/**
 * 对局纯逻辑：开局、轮转、发奖、状元争夺与锁定、收尾结算、超时跳过、再开局重置。
 *
 * 本文件只操作内部房间对象，不做 IO、不读时钟：`now` 由调用方传入，
 * 骰子由调用方（room-service）从 crypto.randomInt 得到后传入。
 * 服务层负责权限、幂等回执、持久化、广播与到期时间。
 *
 * 房规来自本房间保存的 `ruleset` 快照（开局时深拷贝，不随系统预设更新改判）：
 *  - continuous（持续顶状元）：收尾结束前严格更大的成绩替换领先者，同分先到先得；
 *  - high-tier-lock（高阶锁定）：首次出现锁定牌型后得主不可再被顶替，但整局不提前结束。
 *
 * 结束方式来自 `config.endCondition`：
 *  - all-prizes（默认）：五档普通奖全空且已有状元候选才进入收尾 `closingRound`，
 *    完成当前整轮后结算，不额外多打一轮；普通奖空但无人状元则继续轮转；
 *  - rounds：达到所选上限后按轮数结算，剩余奖品与空缺照常展示，不冒称“奖品发完”。
 */

import { randomUUID } from 'node:crypto';
import {
  DICE_COUNT,
  MAX_HISTORY,
  NORMAL_PRIZE_KEYS,
  RULES_VERSION,
  TURN_DURATION_MS,
  emptyAwards,
  evaluateDice,
  isBetterRank,
} from '../shared/rules.js';
import { poolFromConfig } from '../shared/room-config.js';
import { shouldLockChampion, snapshotRuleset } from '../shared/rulesets.js';
import type {
  Champion,
  DiceResult,
  FinishedReason,
  PrizeKey,
  RoomConfig,
  RoomStatus,
  RollRecord,
  RulesetSnapshot,
} from '../shared/types.js';

/** 未完成（不合格结束）的结束原因：主动中止、全员离席关闭、离线过期，以及旧版的“人数不足”。 */
const INCOMPLETE_REASONS: ReadonlySet<FinishedReason> = new Set<FinishedReason>([
  'host-ended',
  'all-left',
  'offline-expired',
  'players-left',
]);

/** 内部玩家：比公共 `Player` 多出凭证哈希与最后可见时间，绝不整体进入公共快照。 */
export interface InternalPlayer {
  id: string;
  nickname: string;
  seat: number;
  ready: boolean;
  online: boolean;
  left: boolean;
  awards: Record<PrizeKey, number>;
  best: DiceResult | null;
  /** 本局累计投掷次数，独立于 240 条历史窗口。 */
  rollCount: number;
  /** 本局累计超时跳过次数，独立于 240 条历史窗口。 */
  timeoutCount: number;
  tokenHash: string;
  lastSeenAt: number;
}

/** 内部房间：比公共 `RoomState` 多出轮转顺序、暂停剩余时间等实现细节。 */
export interface InternalRoom {
  code: string;
  name: string;
  maxPlayers: number;
  config: RoomConfig;
  ruleset: RulesetSnapshot;
  rulesVersion: typeof RULES_VERSION;
  status: RoomStatus;
  hostId: string;
  revision: number;
  players: InternalPlayer[];
  gameNumber: number;
  round: number;
  turnPlayerId: string | null;
  turnId: string | null;
  deadline: number | null;
  paused: boolean;
  pool: Record<PrizeKey, number>;
  /** 本局初始奖池（进度分母），来自本局 config，不随发放减少。 */
  initialPool: Record<PrizeKey, number>;
  champion: Champion | null;
  /** 已进入收尾的轮次；未进入收尾为 null。 */
  closingRound: number | null;
  /** 主动中止、全员离席关闭或离线过期导致的未完成。 */
  incomplete: boolean;
  /** 本次全员离线起点；有人在线时为 null（重启保留，不顺延）。 */
  allOfflineSince: number | null;
  history: RollRecord[];
  finishedReason: FinishedReason | null;
  createdAt: number;
  /** 活跃对局为 null；全员离线起 24 小时，或其他状态转换起 24 小时。 */
  expiresAt: number | null;

  // —— 仅服务端使用的内部字段 ——
  /** 开局时固定的轮转顺序（playerId），离开席位不重排。 */
  turnOrder: string[];
  turnIndex: number;
  /** 暂停时保留的当前回合剩余毫秒。 */
  pauseRemainingMs: number | null;
  turnDurationMs: number;
  startedAt: number | null;
  finishedAt: number | null;
  hostOfflineSince: number | null;
  lastActivityAt: number;
}

export interface CreateRoomSeed {
  code: string;
  name: string;
  maxPlayers: number;
  /** 本房间选择的配置；ruleset／initialPool／pool 由它派生。 */
  config: RoomConfig;
  hostId: string;
  hostNickname: string;
  hostTokenHash: string;
  now: number;
  /** 等待室为创建后 24 小时；活跃对局为 null。 */
  expiresAt: number | null;
  turnDurationMs?: number;
}

export function createInternalRoom(seed: CreateRoomSeed): InternalRoom {
  const config = structuredClone(seed.config);
  const initialPool = poolFromConfig(config);
  const host: InternalPlayer = {
    id: seed.hostId,
    nickname: seed.hostNickname,
    seat: 0,
    // 房主默认准备且可切换
    ready: true,
    online: false,
    left: false,
    awards: emptyAwards(),
    best: null,
    rollCount: 0,
    timeoutCount: 0,
    tokenHash: seed.hostTokenHash,
    lastSeenAt: seed.now,
  };
  return {
    code: seed.code,
    name: seed.name,
    maxPlayers: seed.maxPlayers,
    config,
    // 系统预设的深拷贝：本房间的判奖策略不随后续注册表变化而改变
    ruleset: snapshotRuleset(config.rulesetId),
    rulesVersion: RULES_VERSION,
    status: 'waiting',
    hostId: host.id,
    revision: 0,
    players: [host],
    gameNumber: 1,
    round: 0,
    turnPlayerId: null,
    turnId: null,
    deadline: null,
    paused: false,
    pool: { ...initialPool },
    initialPool,
    champion: null,
    closingRound: null,
    incomplete: false,
    allOfflineSince: null,
    history: [],
    finishedReason: null,
    createdAt: seed.now,
    expiresAt: seed.expiresAt,
    turnOrder: [],
    turnIndex: 0,
    pauseRemainingMs: null,
    turnDurationMs: seed.turnDurationMs ?? TURN_DURATION_MS,
    startedAt: null,
    finishedAt: null,
    hostOfflineSince: null,
    lastActivityAt: seed.now,
  };
}

export function findPlayer(room: InternalRoom, playerId: string): InternalPlayer | undefined {
  return room.players.find((player) => player.id === playerId);
}

/** 未离开的成员，按入座顺序。 */
export function activePlayers(room: InternalRoom): InternalPlayer[] {
  return room.players.filter((player) => !player.left).sort((a, b) => a.seat - b.seat);
}

export function countActive(room: InternalRoom): number {
  return activePlayers(room).length;
}

export function allActiveOnline(room: InternalRoom): boolean {
  const active = activePlayers(room);
  return active.length > 0 && active.every((player) => player.online);
}

export function allActiveOffline(room: InternalRoom): boolean {
  return activePlayers(room).every((player) => !player.online);
}

/** 固定轮数模式的上限；奖品发完模式返回 null（无限轮数）。 */
export function maxRoundsOf(room: InternalRoom): number | null {
  return room.config.endCondition.mode === 'rounds' ? room.config.endCondition.maxRounds : null;
}

function beginTurn(room: InternalRoom, now: number, playerId: string): void {
  room.turnPlayerId = playerId;
  room.turnId = randomUUID();
  if (room.paused) {
    room.deadline = null;
    room.pauseRemainingMs = room.turnDurationMs;
  } else {
    room.deadline = now + room.turnDurationMs;
    room.pauseRemainingMs = null;
  }
  room.lastActivityAt = now;
}

/**
 * 开局：随机起始位（调用方传入 startOffset）之后按入座顺序循环。
 * 只由 room-service 在权限与准备校验之后调用。
 * 本局状态（库存、状元、收尾、记录、累计统计、锁定）全部从 config 重建。
 */
export function startGame(room: InternalRoom, now: number, startOffset: number): void {
  const seated = activePlayers(room);
  const order = seated.map((player) => player.id);
  const size = order.length;
  const offset = size > 0 ? ((startOffset % size) + size) % size : 0;
  room.turnOrder = [...order.slice(offset), ...order.slice(0, offset)];
  room.turnIndex = 0;
  room.round = 1;
  room.status = 'playing';
  room.initialPool = poolFromConfig(room.config);
  room.pool = { ...room.initialPool };
  room.champion = null;
  room.closingRound = null;
  room.incomplete = false;
  room.allOfflineSince = null;
  room.history = [];
  room.finishedReason = null;
  room.startedAt = now;
  room.finishedAt = null;
  room.paused = false;
  room.pauseRemainingMs = null;
  room.hostOfflineSince = null;
  // 活跃对局不受“创建后 24 小时”截断；全员离线时才另行计算
  room.expiresAt = null;
  for (const player of room.players) {
    player.awards = emptyAwards();
    player.best = null;
    player.rollCount = 0;
    player.timeoutCount = 0;
  }
  const first = room.turnOrder[0];
  if (first === undefined) {
    finishGame(room, 'all-left', now);
    return;
  }
  beginTurn(room, now, first);
}

function pushHistory(room: InternalRoom, record: RollRecord): void {
  room.history.push(record);
  if (room.history.length > MAX_HISTORY) {
    room.history.splice(0, room.history.length - MAX_HISTORY);
  }
}

function allNormalPrizesEmpty(room: InternalRoom): boolean {
  return NORMAL_PRIZE_KEYS.every((key) => room.pool[key] <= 0);
}

function cloneResult(result: DiceResult): DiceResult {
  return { code: result.code, label: result.label, prize: result.prize, rankKey: [...result.rankKey] as DiceResult['rankKey'] };
}

/**
 * 登记状元候选：唯一状元，只保留一份归属。
 *  - 已有锁定得主：任何更大的牌型都不能顶替；
 *  - 否则严格更大才顶替，同分先到先得；
 *  - 新的归属者若掷出本房规的锁定牌型，立即锁定（不可再被顶替），但不结束整局。
 */
function registerChampion(room: InternalRoom, player: InternalPlayer, result: DiceResult, dice: readonly number[], now: number): void {
  const current = room.champion;
  if (current === null) {
    room.champion = { playerId: player.id, result: cloneResult(result), dice: [...dice], at: now, locked: false, lockedBy: null };
  } else if (!current.locked && isBetterRank(result.rankKey, current.result.rankKey)) {
    room.champion = { playerId: player.id, result: cloneResult(result), dice: [...dice], at: now, locked: false, lockedBy: null };
  } else {
    return;
  }
  const champion = room.champion;
  if (champion && shouldLockChampion(room.ruleset, champion.result)) {
    champion.locked = true;
    champion.lockedBy = champion.result.code;
  }
}

/**
 * 发奖：普通奖先到先得，库存 0 时返回 null（不降级、不补发、不追缴）。
 * 状元只登记候选与最佳成绩，奖在整局结束时一次性发放，因此此处返回 null。
 */
function awardPrize(room: InternalRoom, player: InternalPlayer, result: DiceResult, dice: readonly number[], now: number): PrizeKey | null {
  const prize = result.prize;
  if (prize === null) return null;

  if (prize === 'zhuangyuan') {
    if (player.best === null || isBetterRank(result.rankKey, player.best.rankKey)) {
      player.best = cloneResult(result);
    }
    registerChampion(room, player, result, dice, now);
    return null;
  }

  if (room.pool[prize] > 0) {
    room.pool[prize] -= 1;
    player.awards[prize] += 1;
    return prize;
  }
  return null;
}

/**
 * 推进到下一个未离开席位。跨过顺序末尾即进入下一轮：
 *  - 已进入收尾（普通奖全空且已有状元候选）：本轮结束即按 `pool-empty` 结算，不多打一轮；
 *  - 固定轮数模式达到上限：按 `round-limit` 结算，剩余奖品照常展示；
 *  - 其余情况继续轮转；全员离席时按 `all-left` 关闭。
 */
function advanceTurn(room: InternalRoom, now: number): void {
  const size = room.turnOrder.length;
  if (size === 0) {
    finishGame(room, 'all-left', now);
    return;
  }
  let index = room.turnIndex;
  let round = room.round;
  for (let step = 0; step <= size; step++) {
    index += 1;
    if (index >= size) {
      index = 0;
      round += 1;
      // 全员已离席时，这一轮边界不构成“正常结算”：按未完成关闭，不制造奖品发完的结果
      if (activePlayers(room).length === 0) {
        finishGame(room, 'all-left', now);
        return;
      }
      // 再判“奖品发完”收尾：必须同时满足普通奖已发空且已经有人夺魁，
      // 同时触达轮数上限时，结束原因必须与实际剩余奖品一致
      const allNormalEmpty = NORMAL_PRIZE_KEYS.every((key) => room.pool[key] === 0);
      if (room.closingRound !== null && room.champion !== null && allNormalEmpty) {
        finishGame(room, 'pool-empty', now);
        return;
      }
      // 收尾条件不再成立（例如旧数据的残留标记）：清掉收尾轮次，避免之后误判
      if (room.closingRound !== null) room.closingRound = null;
      const maxRounds = maxRoundsOf(room);
      if (maxRounds !== null && round > maxRounds) {
        finishGame(room, 'round-limit', now);
        return;
      }
    }
    const nextId = room.turnOrder[index];
    if (nextId === undefined) continue;
    const next = findPlayer(room, nextId);
    if (next && !next.left) {
      room.turnIndex = index;
      room.round = round;
      beginTurn(room, now, nextId);
      return;
    }
  }
  finishGame(room, 'all-left', now);
}

/**
 * 记录一次掷骰并推进回合。调用方必须已校验：房间在 playing、是当前玩家、
 * turnId 与 expectedTurnId 一致。`dice` 由服务端随机源生成，不接受客户端输入。
 */
export function applyRoll(room: InternalRoom, playerId: string, dice: readonly number[], now: number): RollRecord {
  const player = findPlayer(room, playerId);
  if (!player) throw new Error(`玩家不在房间内：${playerId}`);
  if (room.turnPlayerId !== playerId) throw new Error('不是当前回合玩家');
  const turnId = room.turnId;
  if (turnId === null) throw new Error('当前没有进行中的回合');

  const result = evaluateDice(dice);
  player.rollCount += 1;
  const awarded = awardPrize(room, player, result, dice, now);
  // 收尾条件：五档普通奖全空且已有状元候选（状元库存此时必定未发，不能当作空仓依据）
  if (room.closingRound === null && room.champion !== null && allNormalPrizesEmpty(room)) {
    room.closingRound = room.round;
  }
  const record: RollRecord = {
    id: randomUUID(),
    playerId,
    nickname: player.nickname,
    round: room.round,
    turnId,
    dice: [...dice],
    result,
    awarded,
    reason: 'rolled',
    at: now,
  };
  pushHistory(room, record);
  room.lastActivityAt = now;
  advanceTurn(room, now);
  return record;
}

/**
 * 30 秒超时：记一条“超时跳过”，不掷骰、不发奖，消耗一次机会并累计 timeoutCount。
 * 幂等：deadline 已过但回合已经推进时返回 false，不会重复轮转。
 */
export function skipExpiredTurn(room: InternalRoom, now: number): boolean {
  if (room.status !== 'playing') return false;
  if (room.paused) return false;
  if (room.deadline === null || room.turnPlayerId === null || room.turnId === null) return false;
  if (now < room.deadline) return false;

  const player = findPlayer(room, room.turnPlayerId);
  if (player) player.timeoutCount += 1;
  const record: RollRecord = {
    id: randomUUID(),
    playerId: room.turnPlayerId,
    nickname: player?.nickname ?? '',
    round: room.round,
    turnId: room.turnId,
    dice: [],
    result: null,
    awarded: null,
    reason: 'timeout',
    at: now,
  };
  pushHistory(room, record);
  room.lastActivityAt = now;
  advanceTurn(room, now);
  return true;
}

/**
 * 结算：幂等，重复调用不重复发状元。
 * 有领先者/锁定得主时把状元档剩余的全部份数一次性发给他；无人夺魁则状元空缺、库存保留。
 * 找不到得主属于状态损坏，先抛错而不是悄悄丢奖。
 */
export function finishGame(room: InternalRoom, reason: FinishedReason, now: number): void {
  if (room.status === 'finished' || room.status === 'closed') return;

  if (room.champion !== null) {
    const champion = findPlayer(room, room.champion.playerId);
    if (!champion) throw new Error(`状元玩家不在房间内：${room.champion.playerId}`);
    const portions = room.pool.zhuangyuan;
    if (portions > 0) {
      champion.awards.zhuangyuan += portions;
      room.pool.zhuangyuan = 0;
    }
  }

  room.status = reason === 'all-left' ? 'closed' : 'finished';
  room.finishedReason = reason;
  room.incomplete = INCOMPLETE_REASONS.has(reason);
  room.deadline = null;
  room.paused = false;
  room.pauseRemainingMs = null;
  room.turnPlayerId = null;
  room.turnId = null;
  room.finishedAt = now;
  room.lastActivityAt = now;
}

/** 全员离线：保留剩余毫秒并清空 deadline，避免无人时被判超时。 */
export function pauseRoom(room: InternalRoom, now: number): void {
  if (room.status !== 'playing' || room.paused) return;
  room.pauseRemainingMs = room.deadline === null ? room.turnDurationMs : Math.max(0, room.deadline - now);
  room.deadline = null;
  room.paused = true;
  room.lastActivityAt = now;
}

/** 有人回来：用保留的剩余毫秒恢复 deadline。 */
export function resumeRoom(room: InternalRoom, now: number): void {
  if (room.status !== 'playing' || !room.paused) return;
  const remaining = room.pauseRemainingMs ?? room.turnDurationMs;
  room.deadline = now + remaining;
  room.pauseRemainingMs = null;
  room.paused = false;
  room.lastActivityAt = now;
}

/**
 * 把房主交给候选（最早入座的在线成员优先）；没有候选时保持不变。
 * `onlineOnly` 用于 60 秒离线自动转交：只允许在线候选，避免房主落到另一个离线成员身上；
 * 主动离开时可以不带该选项，按“在线优先、否则最早入座”兜底。
 */
export function transferHost(
  room: InternalRoom,
  options: { excludePlayerId?: string; onlineOnly?: boolean } = {},
): string | null {
  const candidates = activePlayers(room).filter((player) => player.id !== options.excludePlayerId);
  if (candidates.length === 0) return null;
  const online = candidates.filter((player) => player.online);
  const pool = options.onlineOnly ? online : online.length > 0 ? online : candidates;
  const next = pool[0];
  if (!next || next.id === room.hostId) return null;
  room.hostId = next.id;
  // 房主默认准备，转交后新宿主视为已准备，可自行切换
  next.ready = true;
  room.hostOfflineSince = null;
  return next.id;
}

/**
 * 再开一局：归档由服务层完成，这里只做状态重置。
 * 沿用本房间配置（房规、奖品、结束方式），重置库存/锁定/收尾/记录/累计统计，
 * 房码与身份保留、离开者清理、非房主准备取消、局编号加 1。
 */
export function prepareRematch(room: InternalRoom, now: number): void {
  room.players = room.players.filter((player) => !player.left).sort((a, b) => a.seat - b.seat);
  if (room.players.length > 0 && !room.players.some((player) => player.id === room.hostId)) {
    room.hostId = room.players[0]!.id;
  }
  for (const player of room.players) {
    player.awards = emptyAwards();
    player.best = null;
    player.rollCount = 0;
    player.timeoutCount = 0;
    player.ready = player.id === room.hostId;
  }
  room.gameNumber += 1;
  room.status = 'waiting';
  room.round = 0;
  room.turnPlayerId = null;
  room.turnId = null;
  room.deadline = null;
  room.paused = false;
  room.pauseRemainingMs = null;
  room.initialPool = poolFromConfig(room.config);
  room.pool = { ...room.initialPool };
  room.champion = null;
  room.closingRound = null;
  room.incomplete = false;
  room.allOfflineSince = null;
  room.history = [];
  room.finishedReason = null;
  room.turnOrder = [];
  room.turnIndex = 0;
  room.startedAt = null;
  room.finishedAt = null;
  room.hostOfflineSince = null;
  room.lastActivityAt = now;
}

/**
 * 当前回合的玩家在对局中离开时调用：跳过其回合（不掷骰、不发奖）。
 * 离开席位保留历史、不重排席位；轮数仍按完整顺序边界计算。
 */
export function dropCurrentTurnIfPlayer(room: InternalRoom, playerId: string, now: number): boolean {
  if (room.status !== 'playing') return false;
  if (room.turnPlayerId !== playerId) return false;
  advanceTurn(room, now);
  return true;
}

/** 校验骰子数组形状（服务端内部仍做一次防御，避免随机源被替换后写入坏数据）。 */
export function isValidDice(dice: unknown): dice is number[] {
  return (
    Array.isArray(dice) &&
    dice.length === DICE_COUNT &&
    dice.every((value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6)
  );
}
