/**
 * 对局纯逻辑：开局、轮转、发奖、状元比较、超时跳过、结算、再开局重置。
 *
 * 本文件只操作内部房间对象，不做 IO、不读时钟：`now` 由调用方传入，
 * 骰子由调用方（room-service）从 crypto.randomInt 得到后传入。
 * 服务层负责权限、幂等回执、持久化与广播。
 */

import { randomUUID } from 'node:crypto';
import {
  DICE_COUNT,
  MAX_HISTORY,
  NORMAL_PRIZE_KEYS,
  RULES_VERSION,
  TURN_DURATION_MS,
  clonePool,
  emptyAwards,
  evaluateDice,
  isBetterRank,
} from '../shared/rules.js';
import type {
  Champion,
  DiceResult,
  FinishedReason,
  PrizeKey,
  RoomStatus,
  RollRecord,
} from '../shared/types.js';

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
  tokenHash: string;
  lastSeenAt: number;
}

/** 内部房间：比公共 `RoomState` 多出轮转顺序、暂停剩余时间等实现细节。 */
export interface InternalRoom {
  code: string;
  name: string;
  maxPlayers: number;
  maxRounds: 5 | 10 | 20;
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
  champion: Champion | null;
  history: RollRecord[];
  finishedReason: FinishedReason | null;
  createdAt: number;
  expiresAt: number;

  // —— 仅服务端使用的内部字段 ——
  /** 开局时固定的轮转顺序（playerId），离开席位不重排。 */
  turnOrder: string[];
  turnIndex: number;
  /** 暂停时保留的当前回合剩余毫秒。 */
  pauseRemainingMs: number | null;
  /** 普通奖领完后等待“完成当前整轮”的结算原因。 */
  pendingFinish: FinishedReason | null;
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
  maxRounds: 5 | 10 | 20;
  hostId: string;
  hostNickname: string;
  hostTokenHash: string;
  now: number;
  expiresAt: number;
  turnDurationMs?: number;
}

export function createInternalRoom(seed: CreateRoomSeed): InternalRoom {
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
    tokenHash: seed.hostTokenHash,
    lastSeenAt: seed.now,
  };
  return {
    code: seed.code,
    name: seed.name,
    maxPlayers: seed.maxPlayers,
    maxRounds: seed.maxRounds,
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
    pool: clonePool(),
    champion: null,
    history: [],
    finishedReason: null,
    createdAt: seed.now,
    expiresAt: seed.expiresAt,
    turnOrder: [],
    turnIndex: 0,
    pauseRemainingMs: null,
    pendingFinish: null,
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
  room.pool = clonePool();
  room.champion = null;
  room.history = [];
  room.finishedReason = null;
  room.pendingFinish = null;
  room.startedAt = now;
  room.finishedAt = null;
  room.paused = false;
  room.pauseRemainingMs = null;
  room.hostOfflineSince = null;
  for (const player of room.players) {
    player.awards = emptyAwards();
    player.best = null;
  }
  const first = room.turnOrder[0];
  if (first === undefined) {
    finishGame(room, 'players-left', now);
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

/**
 * 发奖：普通奖先到先得，库存 0 时返回 null（不降级、不补发）。
 * 状元只登记候选与最佳成绩，奖在整局结束时发放，因此此处返回 null。
 */
function awardPrize(room: InternalRoom, player: InternalPlayer, result: DiceResult, dice: readonly number[], now: number): PrizeKey | null {
  const prize = result.prize;
  if (prize === null) return null;

  if (prize === 'zhuangyuan') {
    if (player.best === null || isBetterRank(result.rankKey, player.best.rankKey)) {
      player.best = result;
    }
    if (room.champion === null || isBetterRank(result.rankKey, room.champion.result.rankKey)) {
      room.champion = { playerId: player.id, result, dice: [...dice], at: now };
    }
    return null;
  }

  if (room.pool[prize] > 0) {
    room.pool[prize] -= 1;
    player.awards[prize] += 1;
    if (allNormalPrizesEmpty(room)) room.pendingFinish = 'pool-empty';
    return prize;
  }
  return null;
}

/**
 * 推进到下一个未离开席位。跨过顺序末尾即进入下一轮：
 * 轮数超过上限按 `round-limit` 结算；普通奖领完按 `pool-empty` 在整轮结束后结算。
 */
function advanceTurn(room: InternalRoom, now: number): void {
  const size = room.turnOrder.length;
  if (size === 0) {
    finishGame(room, 'players-left', now);
    return;
  }
  let index = room.turnIndex;
  let round = room.round;
  for (let step = 0; step <= size; step++) {
    index += 1;
    if (index >= size) {
      index = 0;
      round += 1;
      if (round > room.maxRounds) {
        finishGame(room, 'round-limit', now);
        return;
      }
      if (room.pendingFinish !== null) {
        finishGame(room, room.pendingFinish, now);
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
  finishGame(room, 'players-left', now);
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
  const awarded = awardPrize(room, player, result, dice, now);
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
 * 30 秒超时：记一条“超时跳过”，不掷骰、不发奖，消耗一次机会。
 * 幂等：deadline 已过但回合已经推进时返回 false，不会重复轮转。
 */
export function skipExpiredTurn(room: InternalRoom, now: number): boolean {
  if (room.status !== 'playing') return false;
  if (room.paused) return false;
  if (room.deadline === null || room.turnPlayerId === null || room.turnId === null) return false;
  if (now < room.deadline) return false;

  const player = findPlayer(room, room.turnPlayerId);
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
 * 有领先者时把状元 1 份发给他；无人夺魁则状元库存保留 1。
 */
export function finishGame(room: InternalRoom, reason: FinishedReason, now: number): void {
  if (room.status === 'finished' || room.status === 'closed') return;

  if (room.champion !== null && room.pool.zhuangyuan > 0) {
    const champion = findPlayer(room, room.champion.playerId);
    room.pool.zhuangyuan -= 1;
    if (champion) champion.awards.zhuangyuan += 1;
  }

  room.status = 'finished';
  room.finishedReason = reason;
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
 * 房码与身份保留、离开者清理、奖品与本局记录重置、非房主准备取消、局编号加 1。
 */
export function prepareRematch(room: InternalRoom, now: number): void {
  room.players = room.players.filter((player) => !player.left).sort((a, b) => a.seat - b.seat);
  if (room.players.length > 0 && !room.players.some((player) => player.id === room.hostId)) {
    room.hostId = room.players[0]!.id;
  }
  for (const player of room.players) {
    player.awards = emptyAwards();
    player.best = null;
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
  room.pool = clonePool();
  room.champion = null;
  room.history = [];
  room.finishedReason = null;
  room.pendingFinish = null;
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
