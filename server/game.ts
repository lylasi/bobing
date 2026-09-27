/**
 * 对局纯逻辑：开局、轮转、发奖、状元争夺与锁定、结果展示阶段、收尾结算、超时跳过、再开局重置。
 *
 * 本文件只操作内部房间对象，不做 IO、不读时钟：`now` 由调用方传入，
 * 骰子由调用方（room-service）从 crypto.randomInt 得到后传入。
 * 服务层负责权限、幂等回执、持久化、广播与到期时间。
 *
 * 一次机会的节奏：投掷（或超时）立即产生权威记录，然后进入结果展示阶段
 * （`presentation`，时长 750ms 动画 + 房主配置的阅读时间，超时没有动画）。
 * 展示期间保留该次 turnId／turnPlayerId 作为上下文、`deadline` 为 null、拒绝新的掷骰；
 * 展示结束后才调用 advanceTurn，从实际开放时刻起给下一位完整回合时长。
 * 最后一掷同样经过展示阶段后才结算（`advanceTurn` → `finishGame`）。
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
  compareRank,
  emptyAwards,
  evaluateDice,
  isBetterRank,
} from '../shared/rules.js';
import { poolFromConfig } from '../shared/room-config.js';
import { createDefaultRoomAccess } from '../shared/room-access.js';
import { createDefaultRoomPacing, presentationDurationMs } from '../shared/presentation.js';
import { shouldLockChampion, snapshotRuleset } from '../shared/rulesets.js';
import type {
  Champion,
  ChampionEvent,
  ChampionOutcome,
  DiceResult,
  FinishedReason,
  PrizeKey,
  ResultPresentation,
  RoomAccess,
  RoomConfig,
  RoomPacing,
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
  /** 本人最后一次机会的记录，独立于 240 条历史窗口。 */
  lastRoll: RollRecord | null;
  tokenHash: string;
  lastSeenAt: number;
}

/** 内部房间：比公共 `RoomState` 多出轮转顺序、暂停剩余时间等实现细节。 */
export interface InternalRoom {
  code: string;
  name: string;
  maxPlayers: number;
  config: RoomConfig;
  /** 房间节奏（结果停留时长）；可在等待与进行中由房主调整，从下一条结果生效。 */
  pacing: RoomPacing;
  /** 大厅可见性与旁观开关；不属于 config，改动不影响奖品与对局进度。 */
  access: RoomAccess;
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
  /** 本局完整状元历程；不随 history 的 240 条窗口裁剪。 */
  championEvents: ChampionEvent[];
  /** 本局状元历程是否完整记录；旧快照迁移后为 false。 */
  championHistoryComplete: boolean;
  /** 结果展示阶段；非空时 deadline 为 null 且不能掷骰。 */
  presentation: ResultPresentation | null;
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
  /** 暂停时保留的结果展示剩余毫秒（展示阶段暂停时使用）。 */
  presentationRemainingMs: number | null;
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
  /** 可选：省略时使用新房默认（结果停留 1 秒）。 */
  pacing?: RoomPacing;
  /** 可选：省略时使用新房默认（公开、允许旁观）。 */
  access?: RoomAccess;
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
    lastRoll: null,
    tokenHash: seed.hostTokenHash,
    lastSeenAt: seed.now,
  };
  return {
    code: seed.code,
    name: seed.name,
    maxPlayers: seed.maxPlayers,
    config,
    // 新房默认：结果停留 1 秒、公开且允许旁观（省略配置与非法显式配置分开处理）
    pacing: seed.pacing ? { ...seed.pacing } : createDefaultRoomPacing(),
    access: seed.access ? { ...seed.access } : createDefaultRoomAccess(),
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
    championEvents: [],
    championHistoryComplete: true,
    presentation: null,
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
    presentationRemainingMs: null,
    turnDurationMs: seed.turnDurationMs ?? TURN_DURATION_MS,
    startedAt: null,
    finishedAt: null,
    hostOfflineSince: null,
    lastActivityAt: seed.now,
  };
}

/** 记录一次机会（投掷或超时）后，保存为本人的最后结果，独立于 240 条历史窗口。 */
function rememberLastRoll(player: InternalPlayer | undefined, record: RollRecord): void {
  if (player) player.lastRoll = cloneRecord(record);
}

/** 记录对象的深拷贝：历史窗口已裁剪后，个人最后记录仍要完整保留。 */
function cloneRecord(record: RollRecord): RollRecord {
  return {
    id: record.id,
    playerId: record.playerId,
    nickname: record.nickname,
    round: record.round,
    turnId: record.turnId,
    dice: [...record.dice],
    result: record.result ? cloneResult(record.result) : null,
    awarded: record.awarded,
    reason: record.reason,
    at: record.at,
    championOutcome: record.championOutcome ? { ...record.championOutcome } : null,
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
  room.championEvents = [];
  room.championHistoryComplete = true;
  room.presentation = null;
  room.presentationRemainingMs = null;
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
    player.lastRoll = null;
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
 * 登记状元候选：唯一状元，只保留一份归属，并返回本次判定的事实。
 *  - 已有锁定得主：任何更大的牌型都不能顶替（kind='locked'）；
 *  - 否则严格更大才顶替（自己提高成绩为 improved，换人为 takeover），同分先到先得（kind='tied'）；
 *  - 新的归属者若掷出本房规的锁定牌型，立即锁定（不可再被顶替），但不结束整局。
 *
 * 只有归属或成绩实际变化（first／takeover／improved）才追加状元历程事件；
 * 同分、较小与锁定不产生虚假的登顶事件。投出状元牌型不等于曾登顶。
 */
function registerChampion(
  room: InternalRoom,
  player: InternalPlayer,
  result: DiceResult,
  dice: readonly number[],
  now: number,
  recordId: string,
): ChampionOutcome {
  const current = room.champion;
  let kind: ChampionOutcome['kind'];
  let previousPlayerId: string | null = null;
  let previousNickname: string | null = null;

  if (current === null) {
    kind = 'first';
  } else if (!current.locked && isBetterRank(result.rankKey, current.result.rankKey)) {
    kind = current.playerId === player.id ? 'improved' : 'takeover';
    previousPlayerId = current.playerId;
    previousNickname = findPlayer(room, current.playerId)?.nickname ?? null;
  } else if (current.locked) {
    // 锁定得主不可顶替：本次投掷只是被挡下，不产生登顶事件
    return { kind: 'locked', previousPlayerId: null, currentPlayerId: current.playerId, locked: true };
  } else {
    const same = compareRank(result.rankKey, current.result.rankKey) === 0;
    return { kind: same ? 'tied' : 'lower', previousPlayerId: null, currentPlayerId: current.playerId, locked: false };
  }

  room.champion = { playerId: player.id, result: cloneResult(result), dice: [...dice], at: now, locked: false, lockedBy: null };
  const champion = room.champion;
  let locked = false;
  if (champion && shouldLockChampion(room.ruleset, champion.result)) {
    champion.locked = true;
    champion.lockedBy = champion.result.code;
    locked = true;
  }
  room.championEvents.push({
    id: randomUUID(),
    recordId,
    kind,
    playerId: player.id,
    nickname: player.nickname,
    previousPlayerId,
    previousNickname,
    round: room.round,
    at: now,
    dice: [...dice],
    result: cloneResult(result),
    locked,
    awardedCount: 0,
  });
  return { kind, previousPlayerId, currentPlayerId: player.id, locked };
}

interface AwardOutcome {
  awarded: PrizeKey | null;
  championOutcome: ChampionOutcome | null;
}

/**
 * 发奖：普通奖先到先得，库存 0 时返回 null（不降级、不补发、不追缴）。
 * 状元只登记候选、最佳成绩与当次判定，奖在整局结束时一次性发放，因此此处 awarded 为 null。
 * 一次投掷只判一次奖，普通发奖结果与状元判定同时返回，调用方不得重复消费。
 */
function awardPrize(
  room: InternalRoom,
  player: InternalPlayer,
  result: DiceResult,
  dice: readonly number[],
  now: number,
  recordId: string,
): AwardOutcome {
  const prize = result.prize;
  if (prize === null) return { awarded: null, championOutcome: null };

  if (prize === 'zhuangyuan') {
    if (player.best === null || isBetterRank(result.rankKey, player.best.rankKey)) {
      player.best = cloneResult(result);
    }
    return { awarded: null, championOutcome: registerChampion(room, player, result, dice, now, recordId) };
  }

  if (room.pool[prize] > 0) {
    room.pool[prize] -= 1;
    player.awards[prize] += 1;
    return { awarded: prize, championOutcome: null };
  }
  return { awarded: null, championOutcome: null };
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
 * 开始结果展示阶段：保留该次 turnId／turnPlayerId 作为上下文，清空 deadline，
 * 由 `completeResultPresentation` 在到时后再开放下一位（下一位获得完整回合时长）。
 */
function beginPresentation(room: InternalRoom, record: RollRecord, now: number): void {
  room.presentation = { recordId: record.id, until: now + presentationDurationMs(record.reason, room.pacing) };
  room.presentationRemainingMs = null;
  room.deadline = null;
}

/**
 * 记录一次掷骰并开始结果展示。调用方必须已校验：房间在 playing、是当前玩家、
 * turnId 与 expectedTurnId 一致。`dice` 由服务端随机源生成，不接受客户端输入。
 * 回合推进由展示结束后的 `completeResultPresentation` 完成（最后一手在展示后结算）。
 */
export function applyRoll(room: InternalRoom, playerId: string, dice: readonly number[], now: number): RollRecord {
  const player = findPlayer(room, playerId);
  if (!player) throw new Error(`玩家不在房间内：${playerId}`);
  if (room.turnPlayerId !== playerId) throw new Error('不是当前回合玩家');
  const turnId = room.turnId;
  if (turnId === null) throw new Error('当前没有进行中的回合');

  const result = evaluateDice(dice);
  player.rollCount += 1;
  // 先生成本次记录 id，再判奖：状元历程事件与当次事实共用同一个 recordId
  const recordId = randomUUID();
  const { awarded, championOutcome } = awardPrize(room, player, result, dice, now, recordId);
  // 收尾条件：五档普通奖全空且已有状元候选（状元库存此时必定未发，不能当作空仓依据）
  if (room.closingRound === null && room.champion !== null && allNormalPrizesEmpty(room)) {
    room.closingRound = room.round;
  }
  const record: RollRecord = {
    id: recordId,
    playerId,
    nickname: player.nickname,
    round: room.round,
    turnId,
    dice: [...dice],
    result,
    awarded,
    reason: 'rolled',
    at: now,
    championOutcome,
  };
  pushHistory(room, record);
  rememberLastRoll(player, record);
  beginPresentation(room, record, now);
  room.lastActivityAt = now;
  return record;
}

/**
 * 30 秒超时：记一条“超时跳过”，不掷骰、不发奖，消耗一次机会并累计 timeoutCount，
 * 随后进入结果展示（没有动画，只停留配置的阅读时间）。
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
    championOutcome: null,
  };
  pushHistory(room, record);
  rememberLastRoll(player, record);
  beginPresentation(room, record, now);
  room.lastActivityAt = now;
  return true;
}

/**
 * 结果展示到时结束：清除阶段并调用原轮转，从实际开放时刻起给下一位完整回合时长。
 * 展示期间全桌暂停（参赛者全部离线）时不结束；0 秒停留允许到时立即完成。
 * 返回是否真的结束了本次展示。
 */
export function completeResultPresentation(room: InternalRoom, now: number): boolean {
  const presentation = room.presentation;
  if (room.status !== 'playing' || room.paused || !presentation) return false;
  if (presentation.until === null || now < presentation.until) return false;
  room.presentation = null;
  room.presentationRemainingMs = null;
  advanceTurn(room, now);
  return true;
}

/**
 * 结算：幂等，重复调用不重复发状元。
 * 有领先者/锁定得主时把状元档剩余的全部份数一次性发给他；无人夺魁则状元空缺、库存保留。
 * 实际发奖时追加唯一一条 settled 历程事件（recordId 为 null，awardedCount 为实际份数）。
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
      room.championEvents.push({
        id: randomUUID(),
        recordId: null,
        kind: 'settled',
        playerId: champion.id,
        nickname: champion.nickname,
        previousPlayerId: null,
        previousNickname: null,
        round: room.round,
        at: now,
        dice: [...room.champion.dice],
        result: cloneResult(room.champion.result),
        locked: room.champion.locked,
        awardedCount: portions,
      });
    }
  }

  room.status = reason === 'all-left' ? 'closed' : 'finished';
  room.finishedReason = reason;
  room.incomplete = INCOMPLETE_REASONS.has(reason);
  room.deadline = null;
  room.paused = false;
  room.pauseRemainingMs = null;
  room.presentation = null;
  room.presentationRemainingMs = null;
  room.turnPlayerId = null;
  room.turnId = null;
  room.finishedAt = now;
  room.lastActivityAt = now;
}

/**
 * 全员离线：保留剩余毫秒并清空 deadline／until，避免无人时被判超时。
 * 展示阶段暂停时保存的是展示剩余时间，恢复后继续展示剩余部分。
 */
export function pauseRoom(room: InternalRoom, now: number): void {
  if (room.status !== 'playing' || room.paused) return;
  if (room.presentation) {
    room.presentationRemainingMs = Math.max(0, (room.presentation.until ?? now) - now);
    room.presentation.until = null;
    room.deadline = null;
  } else {
    room.pauseRemainingMs = room.deadline === null ? room.turnDurationMs : Math.max(0, room.deadline - now);
    room.deadline = null;
  }
  room.paused = true;
  room.lastActivityAt = now;
}

/** 有人回来：用保留的剩余毫秒恢复 deadline 或结果展示。 */
export function resumeRoom(room: InternalRoom, now: number): void {
  if (room.status !== 'playing' || !room.paused) return;
  if (room.presentation) {
    room.presentation.until = now + (room.presentationRemainingMs ?? 0);
    room.presentationRemainingMs = null;
  } else {
    const remaining = room.pauseRemainingMs ?? room.turnDurationMs;
    room.deadline = now + remaining;
    room.pauseRemainingMs = null;
  }
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
    player.lastRoll = null;
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
  room.championEvents = [];
  room.championHistoryComplete = true;
  room.presentation = null;
  room.presentationRemainingMs = null;
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
 * 处于结果展示阶段时不提前推进：展示结束后由 completeResultPresentation 统一跳过已离席席位，
 * 避免展示中的结果被下一手直接覆盖。离开席位保留历史、不重排席位；轮数仍按完整顺序边界计算。
 */
export function dropCurrentTurnIfPlayer(room: InternalRoom, playerId: string, now: number): boolean {
  if (room.status !== 'playing') return false;
  if (room.turnPlayerId !== playerId) return false;
  if (room.presentation !== null) return false;
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
