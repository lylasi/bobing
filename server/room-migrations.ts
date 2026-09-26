/**
 * 持久化快照迁移：把数据库里读出的 JSON 还原为当前 `InternalRoom`。
 *
 * 两条路径严格分开，避免“新格式损坏”被当成旧房间静默套上默认值：
 *  - 当前格式（含 config／ruleset／initialPool／closingRound 等新字段）：逐字段校验，
 *    任何缺失或类型不符都抛错；已有规则快照原样保留，不随系统注册表更新改判。
 *  - 旧格式（只有顶层 maxRounds）：原轮数保留为固定轮数模式，规则为持续顶状元，
 *    初始数量使用原默认值，奖品内容为空，不给旧房间静默切到无限轮数。
 *
 * 迁移只做结构补齐，不改写历史选择：旧房间的 maxRounds、剩余库存、已发奖品、
 * 累计记录都尽量保留；旧玩家累计次数按仍保留的旧局记录重建（窗口内可见部分）。
 *
 * 旧归档表 completed_games 里还有第三种格式：当前代码“再开一局”写入的白名单公共快照，
 * 它天然没有内部字段，不能送进 InternalRoom 读取器。这类行由 readPublicArchiveSnapshot
 * 按公共白名单识别，readArchiveIdentity 先按 (房码, 建房时间, 局号) 查重后原样使用。
 */

import { DEFAULT_ROOM_NAME, PRIZE_KEYS, RULES_RESULT_ROWS, ROUND_OPTIONS, TURN_DURATION_MS } from '../shared/rules.js';
import { createDefaultRoomConfig, normalizeRoomConfig, poolFromConfig } from '../shared/room-config.js';
import { isRulesetId, snapshotRuleset } from '../shared/rulesets.js';
import type {
  Champion,
  DiceResult,
  FinishedReason,
  PrizeKey,
  ResultCode,
  RoomConfig,
  RoomStatus,
  RollRecord,
  RulesetSnapshot,
} from '../shared/types.js';
import type { InternalPlayer, InternalRoom } from './game.js';

/** 快照损坏时的统一错误前缀。 */
export const CORRUPTED_ROOM_MESSAGE = '房间快照结构损坏';

/** 当前格式的标志字段：出现任意一个就按新结构严格校验，不退回旧数据默认值。 */
const CURRENT_FORMAT_KEYS = ['config', 'ruleset', 'initialPool', 'closingRound', 'allOfflineSince', 'incomplete'] as const;

const ROOM_STATUSES: readonly RoomStatus[] = ['waiting', 'playing', 'finished', 'closed'];
const FINISHED_REASONS: readonly FinishedReason[] = [
  'round-limit',
  'pool-empty',
  'host-ended',
  'players-left',
  'offline-expired',
  'all-left',
];
const INCOMPLETE_REASONS: readonly FinishedReason[] = ['host-ended', 'players-left', 'all-left', 'offline-expired'];
const ROLL_REASONS: readonly RollRecord['reason'][] = ['rolled', 'timeout'];
const RESULT_CODES: ReadonlySet<string> = new Set(RULES_RESULT_ROWS.map((row) => row.code));
const PRIZE_KEY_SET: ReadonlySet<string> = new Set(PRIZE_KEYS);

function corrupted(detail: string): never {
  throw new TypeError(`${CORRUPTED_ROOM_MESSAGE}：${detail}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) corrupted(`${label} 必须是对象`);
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) corrupted(`${label} 必须是非空字符串`);
  return value;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') corrupted(`${label} 必须是布尔值`);
  return value;
}

function readInteger(value: unknown, label: string, min: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    corrupted(`${label} 必须是不小于 ${min} 的安全整数`);
  }
  return value;
}

/** 读取时间戳：允许 null（活跃对局无到期时间），不允许 NaN/Infinity。 */
function readTimestampOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) corrupted(`${label} 必须是有限数字或 null`);
  return value;
}

function requireKey(raw: Record<string, unknown>, key: string): void {
  if (!(key in raw)) corrupted(`缺少字段 ${key}`);
}

/** 当前格式专用：字段必须存在（可以为 null）。 */
function requiredField(raw: Record<string, unknown>, key: string): unknown {
  requireKey(raw, key);
  return raw[key];
}

/** 旧格式专用：字段缺失时使用兼容默认值。 */
function legacyField(raw: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return key in raw && raw[key] !== undefined ? raw[key] : fallback;
}

/**
 * 把持久化里的任意 JSON 还原为内部房间。只用于读取已存房间与旧归档，
 * 外部输入（创建／改配置）走 normalizeRoomConfig 的严格校验。
 *
 * 格式判定：
 *  - 有 config（新格式的标志）：按新结构严格校验，缺字段或类型不符即报损坏。
 *  - 没有 config 但有 maxRounds：旧固定轮数房间，按旧结构尽力归一化。
 *  - 两者同时出现：视为混写损坏，不猜。
 *  - 只有其它新字段而没有 config：仍按新格式校验，报出缺失字段，
 *    绝不因为“少了 config”就退回旧默认值把损坏掩盖成旧房间。
 * `fallbackExpiresAt` 用于旧快照（旧结构没有到期时间字段）：由调用方传入
 * 数据库行里的 expires_at，避免旧房间在内存里失去到期时间。
 */
export function normalizeStoredRoom(value: unknown, options: NormalizeStoredRoomOptions = {}): InternalRoom {
  const raw = asObject(value, '房间快照');
  const hasCurrent = 'config' in raw;
  const hasLegacy = 'maxRounds' in raw;
  if (hasCurrent && hasLegacy) corrupted('同时出现 config 与旧版 maxRounds');
  if (hasCurrent) return readCurrentRoom(raw);
  if (hasLegacy) {
    const room = readLegacyRoom(raw);
    if (options.fallbackExpiresAt !== undefined) room.expiresAt = options.fallbackExpiresAt;
    return room;
  }
  if (CURRENT_FORMAT_KEYS.some((key) => key in raw)) return readCurrentRoom(raw);
  corrupted('既不是当前快照也不是旧版房间快照');
}

export interface NormalizeStoredRoomOptions {
  /** 旧快照缺得到期时间时使用的回退值（数据库行的 expires_at）。 */
  fallbackExpiresAt?: number | null;
}

// —— 当前格式 ——

function readCurrentRoom(raw: Record<string, unknown>): InternalRoom {
  const config = readConfig(raw.config);
  const ruleset = readRuleset(raw.ruleset, config);
  const initialPool = poolFromConfig(config);
  return {
    ...readCore(raw, true),
    config,
    ruleset,
    initialPool,
    pool: requirePool(raw.pool, 'pool'),
    champion: readChampion(raw.champion, true),
    // 当前格式里 closingRound 必须存在（可以为 null）：缺失说明快照被截断，不能当成“没有收尾轮”
    closingRound: readClosingRound(requiredField(raw, 'closingRound')),
    incomplete: readBoolean(requiredField(raw, 'incomplete'), 'incomplete'),
    allOfflineSince: readTimestampOrNull(requiredField(raw, 'allOfflineSince'), 'allOfflineSince'),
    expiresAt: readTimestampOrNull(requiredField(raw, 'expiresAt'), 'expiresAt'),
    players: readPlayers(raw.players, true),
  };
}

function readConfig(value: unknown): RoomConfig {
  try {
    return normalizeRoomConfig(value);
  } catch (error) {
    corrupted(`配置不合法（${error instanceof Error ? error.message : String(error)}）`);
  }
}

/**
 * 规则快照必须来自已存数据本身：即使系统注册表后来改了名称或锁定列表，
 * 本房间也继续按开局时保存的快照判奖。只校验结构，不按当前注册表重建。
 */
function readRuleset(value: unknown, config: RoomConfig): RulesetSnapshot {
  const raw = asObject(value, 'ruleset');
  const id = raw.id;
  if (!isRulesetId(id)) corrupted('ruleset.id 不是已知系统房规');
  if (id !== config.rulesetId) corrupted('ruleset.id 与本房间配置不一致');
  if (raw.version !== 1) corrupted('ruleset.version 只能是 1');
  const name = readString(raw.name, 'ruleset.name');
  if (raw.diceRulesVersion !== 'unified-v1') corrupted('ruleset.diceRulesVersion 只能是 unified-v1');
  const policy = raw.championPolicy;
  if (policy !== 'competitive' && policy !== 'lock-high-tier') corrupted('ruleset.championPolicy 不合法');
  const lockCodes = raw.lockCodes;
  if (!Array.isArray(lockCodes) || !lockCodes.every((code) => typeof code === 'string' && RESULT_CODES.has(code))) {
    corrupted('ruleset.lockCodes 必须是牌型代码数组');
  }
  return {
    id,
    version: 1,
    name,
    diceRulesVersion: 'unified-v1',
    championPolicy: policy,
    lockCodes: [...(lockCodes as ResultCode[])],
  };
}

// —— 旧格式（只有顶层 maxRounds） ——

function readLegacyRoom(raw: Record<string, unknown>): InternalRoom {
  const maxRounds = raw.maxRounds;
  if (typeof maxRounds !== 'number' || !(ROUND_OPTIONS as readonly number[]).includes(maxRounds)) {
    corrupted('旧房间缺少合法的轮数上限');
  }
  // 旧房间固定轮数原样保留：不静默切到无限轮数
  const config = normalizeRoomConfig({
    ...createDefaultRoomConfig(),
    endCondition: { mode: 'rounds', maxRounds: maxRounds as 5 | 10 | 20 },
  });
  const core = readCore(raw, false);
  const players = readPlayers(raw.players, false, core.history);
  const status = core.status;
  const finishedReason = core.finishedReason;
  const incomplete =
    status === 'closed' || (finishedReason !== null && INCOMPLETE_REASONS.includes(finishedReason));
  const champion = readChampion(raw.champion, false);
  /**
   * 旧版用 pendingFinish 表示“普通奖已领完、等待整轮结束”，迁移为收尾轮次。
   * 收尾轮次与状元绑定：旧数据可能在还没有状元时就写下这个标记（那时池子空了就收尾），
   * 但新规则要求“普通奖发完且已经有人夺魁”才收尾，因此没有状元时不迁移，
   * 避免旧标记把一局仍在继续的对局错误地按“奖品发完”结算。
   */
  const pendingFinish = 'pendingFinish' in raw ? raw.pendingFinish : null;
  const hasPendingFinish = pendingFinish !== null && pendingFinish !== undefined && pendingFinish !== false;
  const closingRound =
    'closingRound' in raw
      ? readClosingRound(raw.closingRound)
      : hasPendingFinish && champion !== null && status === 'playing'
        ? core.round
        : null;
  return {
    ...core,
    config,
    ruleset: snapshotRuleset('continuous'),
    initialPool: poolFromConfig(config),
    // 旧房间的剩余库存照常保留；缺失时退回原默认满额
    pool: readPool(raw.pool, 'pool', false) ?? poolFromConfig(config),
    champion,
    closingRound,
    incomplete,
    allOfflineSince: null,
    expiresAt: 'expiresAt' in raw ? readTimestampOrNull(raw.expiresAt, 'expiresAt') : null,
    players,
  };
}

// —— 公共字段 ——

type RoomCore = Pick<
  InternalRoom,
  | 'code'
  | 'name'
  | 'maxPlayers'
  | 'rulesVersion'
  | 'status'
  | 'hostId'
  | 'revision'
  | 'gameNumber'
  | 'round'
  | 'turnPlayerId'
  | 'turnId'
  | 'deadline'
  | 'paused'
  | 'history'
  | 'finishedReason'
  | 'createdAt'
  | 'turnOrder'
  | 'turnIndex'
  | 'pauseRemainingMs'
  | 'turnDurationMs'
  | 'startedAt'
  | 'finishedAt'
  | 'hostOfflineSince'
  | 'lastActivityAt'
>;

function readCore(raw: Record<string, unknown>, strict: boolean): RoomCore {
  const pick = (key: string, fallback: unknown): unknown =>
    strict ? requiredField(raw, key) : legacyField(raw, key, fallback);

  const code = readString(pick('code', undefined), 'code');
  const createdAtValue = pick('createdAt', 0);
  if (typeof createdAtValue !== 'number' || !Number.isFinite(createdAtValue)) corrupted('createdAt 必须是有限数字');
  const statusValue = pick('status', 'waiting');
  if (typeof statusValue !== 'string' || !(ROOM_STATUSES as readonly string[]).includes(statusValue)) {
    corrupted('status 不是已知房间状态');
  }
  const finishedReasonValue = pick('finishedReason', null);
  if (
    finishedReasonValue !== null &&
    (typeof finishedReasonValue !== 'string' || !(FINISHED_REASONS as readonly string[]).includes(finishedReasonValue))
  ) {
    corrupted('finishedReason 不是已知结束原因');
  }
  const turnPlayerIdValue = pick('turnPlayerId', null);
  const turnIdValue = pick('turnId', null);
  if (turnPlayerIdValue !== null && typeof turnPlayerIdValue !== 'string') corrupted('turnPlayerId 必须是字符串或 null');
  if (turnIdValue !== null && typeof turnIdValue !== 'string') corrupted('turnId 必须是字符串或 null');

  const hostIdValue = pick('hostId', undefined);
  const nameValue = pick('name', DEFAULT_ROOM_NAME);
  const turnOrderValue = pick('turnOrder', []);
  if (!Array.isArray(turnOrderValue) || !turnOrderValue.every((id) => typeof id === 'string')) {
    corrupted('turnOrder 必须是玩家 ID 数组');
  }

  return {
    code,
    name: typeof nameValue === 'string' ? nameValue : corrupted('name 必须是字符串'),
    maxPlayers: readInteger(pick('maxPlayers', 2), 'maxPlayers', 1),
    rulesVersion: 'unified-v1',
    status: statusValue as RoomStatus,
    hostId: readString(hostIdValue, 'hostId'),
    revision: readInteger(pick('revision', 0), 'revision', 0),
    gameNumber: readInteger(pick('gameNumber', 1), 'gameNumber', 1),
    round: readInteger(pick('round', 0), 'round', 0),
    turnPlayerId: turnPlayerIdValue as string | null,
    turnId: turnIdValue as string | null,
    deadline: readTimestampOrNull(pick('deadline', null), 'deadline'),
    paused: readBoolean(pick('paused', false), 'paused'),
    history: readHistory(pick('history', []), strict),
    finishedReason: finishedReasonValue as FinishedReason | null,
    createdAt: createdAtValue,
    turnOrder: [...(turnOrderValue as string[])],
    turnIndex: readInteger(pick('turnIndex', 0), 'turnIndex', 0),
    pauseRemainingMs: readTimestampOrNull(pick('pauseRemainingMs', null), 'pauseRemainingMs'),
    turnDurationMs: readInteger(pick('turnDurationMs', TURN_DURATION_MS), 'turnDurationMs', 1),
    startedAt: readTimestampOrNull(pick('startedAt', null), 'startedAt'),
    finishedAt: readTimestampOrNull(pick('finishedAt', null), 'finishedAt'),
    hostOfflineSince: readTimestampOrNull(pick('hostOfflineSince', null), 'hostOfflineSince'),
    lastActivityAt: readTimestampOrNull(pick('lastActivityAt', createdAtValue), 'lastActivityAt') ?? createdAtValue,
  };
}

function readClosingRound(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return readInteger(value, 'closingRound', 1);
}

function readPool(value: unknown, label: string, strict: boolean): Record<PrizeKey, number> | null {
  if (value === null || value === undefined) {
    if (strict) corrupted(`缺少字段 ${label}`);
    return null;
  }
  if (!isObject(value)) {
    if (strict) corrupted(`${label} 必须是对象`);
    return null;
  }
  const pool = {} as Record<PrizeKey, number>;
  for (const key of PRIZE_KEYS) {
    const count = (value as Record<string, unknown>)[key];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      if (strict) corrupted(`${label}.${key} 必须是不小于 0 的安全整数`);
      return null;
    }
    pool[key] = count;
  }
  return pool;
}

/** 当前格式必需字段：直接返回可用的奖池对象，缺失即视为损坏。 */
function requirePool(value: unknown, label: string): Record<PrizeKey, number> {
  const pool = readPool(value, label, true);
  if (pool === null) corrupted(`${label} 不合法`);
  return pool;
}

function readAwards(value: unknown, label: string, strict: boolean): Record<PrizeKey, number> {
  const pool = readPool(value, label, strict);
  if (pool === null) {
    if (strict) corrupted(`${label} 不合法`);
    return { zhuangyuan: 0, duitang: 0, sanhong: 0, sijin: 0, erju: 0, yixiu: 0 };
  }
  return pool;
}

function readResult(value: unknown, label: string, strict: boolean): DiceResult | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) {
    if (strict) corrupted(`${label} 必须是判奖结果或 null`);
    return null;
  }
  const code = value.code;
  const rankKey = value.rankKey;
  const prize = value.prize;
  if (
    typeof code !== 'string' ||
    !RESULT_CODES.has(code) ||
    typeof value.label !== 'string' ||
    (prize !== null && (typeof prize !== 'string' || !PRIZE_KEY_SET.has(prize))) ||
    !Array.isArray(rankKey) ||
    rankKey.length !== 3 ||
    !rankKey.every((part) => typeof part === 'number' && Number.isFinite(part))
  ) {
    if (strict) corrupted(`${label} 不是合法的判奖结果`);
    return null;
  }
  return {
    code: code as ResultCode,
    label: value.label,
    prize: prize as PrizeKey | null,
    rankKey: [rankKey[0] as number, rankKey[1] as number, rankKey[2] as number],
  };
}

function readChampion(value: unknown, strict: boolean): Champion | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) {
    if (strict) corrupted('champion 必须是对象或 null');
    return null;
  }
  const result = readResult(value.result, 'champion.result', strict);
  if (result === null) {
    if (strict) corrupted('champion.result 缺失');
    return null;
  }
  const diceValue = 'dice' in value ? value.dice : [];
  if (!Array.isArray(diceValue) || !diceValue.every((die) => typeof die === 'number')) {
    if (strict) corrupted('champion.dice 必须是数字数组');
    return null;
  }
  const playerIdValue = value.playerId;
  if (typeof playerIdValue !== 'string' || playerIdValue.length === 0) {
    if (strict) corrupted('champion.playerId 必须是非空字符串');
    return null;
  }
  const lockedValue = 'locked' in value ? value.locked : false;
  const lockedByValue = 'lockedBy' in value ? value.lockedBy : null;
  if (strict && (!('locked' in value) || !('lockedBy' in value))) corrupted('champion 缺少锁定字段');
  if (typeof lockedValue !== 'boolean') {
    if (strict) corrupted('champion.locked 必须是布尔值');
    return null;
  }
  if (lockedByValue !== null && (typeof lockedByValue !== 'string' || !RESULT_CODES.has(lockedByValue))) {
    if (strict) corrupted('champion.lockedBy 不是已知牌型');
    return null;
  }
  const atValue = 'at' in value ? value.at : 0;
  if (typeof atValue !== 'number' || !Number.isFinite(atValue)) {
    if (strict) corrupted('champion.at 必须是有限数字');
    return null;
  }
  return {
    playerId: playerIdValue,
    result,
    dice: [...(diceValue as number[])],
    at: atValue,
    locked: lockedValue,
    lockedBy: lockedByValue as ResultCode | null,
  };
}

function readHistory(value: unknown, strict: boolean): RollRecord[] {
  if (!Array.isArray(value)) {
    if (strict) corrupted('history 必须是数组');
    return [];
  }
  const records: RollRecord[] = [];
  for (const [index, entry] of value.entries()) {
    const record = readRollRecord(entry, index, strict);
    if (record) records.push(record);
  }
  return records;
}

function readRollRecord(value: unknown, index: number, strict: boolean): RollRecord | null {
  const label = `history[${index}]`;
  if (!isObject(value)) {
    if (strict) corrupted(`${label} 必须是对象`);
    return null;
  }
  const reason = value.reason;
  const dice = value.dice;
  const awarded = value.awarded;
  if (
    typeof value.id !== 'string' ||
    typeof value.playerId !== 'string' ||
    typeof value.nickname !== 'string' ||
    typeof value.turnId !== 'string' ||
    typeof value.round !== 'number' ||
    !Array.isArray(dice) ||
    !dice.every((die) => typeof die === 'number') ||
    (awarded !== null && (typeof awarded !== 'string' || !PRIZE_KEY_SET.has(awarded))) ||
    typeof reason !== 'string' ||
    !(ROLL_REASONS as readonly string[]).includes(reason) ||
    typeof value.at !== 'number'
  ) {
    if (strict) corrupted(`${label} 结构不合法`);
    return null;
  }
  return {
    id: value.id,
    playerId: value.playerId,
    nickname: value.nickname,
    round: value.round,
    turnId: value.turnId,
    dice: [...(dice as number[])],
    result: readResult(value.result, `${label}.result`, strict),
    awarded: awarded as PrizeKey | null,
    reason: reason as RollRecord['reason'],
    at: value.at,
  };
}

// —— 公共归档快照（旧 completed_games 迁移用） ——

/**
 * 公共快照白名单键：与 shared/types.ts 的 RoomState、room-service 的 toPublicRoom 输出一致。
 * 出现集合之外的键（内部房间独有字段，或可能夹带凭证的未知字段）就不再算纯公共快照。
 */
const PUBLIC_ROOM_KEYS: ReadonlySet<string> = new Set([
  'code',
  'name',
  'maxPlayers',
  'config',
  'ruleset',
  'rulesVersion',
  'status',
  'hostId',
  'revision',
  'players',
  'gameNumber',
  'round',
  'turnPlayerId',
  'turnId',
  'deadline',
  'paused',
  'pool',
  'initialPool',
  'champion',
  'closingRound',
  'incomplete',
  'allOfflineSince',
  'history',
  'finishedReason',
  'createdAt',
  'expiresAt',
]);

/** 公共成员白名单键：tokenHash／lastSeenAt 等内部字段一定不在其中。 */
const PUBLIC_PLAYER_KEYS: ReadonlySet<string> = new Set([
  'id',
  'nickname',
  'seat',
  'ready',
  'online',
  'left',
  'awards',
  'best',
  'rollCount',
  'timeoutCount',
]);

/** 公共快照里可用于归档的身份与结束信息。 */
export interface PublicArchiveSnapshot {
  code: string;
  createdAt: number;
  finishedReason: FinishedReason | null;
  incomplete: boolean;
}

/**
 * 识别“已按白名单保存的公共快照”，例如兼容表 completed_games 里“再开一局”写入的那一行。
 *
 * 这类行没有 turnOrder／tokenHash 等内部字段，绝不能送进 InternalRoom 读取器当成损坏；
 * 反过来，只有当前格式（有 config）、键全在公共白名单内、成员也没有内部字段的行才被认作公共快照，
 * 真正的旧 InternalRoom 快照与损坏行一律返回 null，交给 normalizeStoredRoom 严格校验报错，
 * 不做“公共快照强转 InternalRoom”式的猜测。
 *
 * 旧版本公共快照缺 incomplete 时按既有口径（closed 或未完成原因）推导，不新增含义。
 */
export function readPublicArchiveSnapshot(value: unknown): PublicArchiveSnapshot | null {
  if (!isObject(value)) return null;
  // 当前格式标志：兼容表里的旧 InternalRoom 快照没有 config，不能走这条路
  if (!('config' in value)) return null;
  if (Object.keys(value).some((key) => !PUBLIC_ROOM_KEYS.has(key))) return null;
  const players = value.players;
  if (!Array.isArray(players) || players.length === 0) return null;
  const playersArePublic = players.every(
    (player) => isObject(player) && Object.keys(player).every((key) => PUBLIC_PLAYER_KEYS.has(key)),
  );
  if (!playersArePublic) return null;
  const status = value.status;
  if (typeof status !== 'string' || !(ROOM_STATUSES as readonly string[]).includes(status)) return null;
  const code = value.code;
  if (typeof code !== 'string' || code.length === 0) return null;
  const createdAt = value.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  const finishedReason = value.finishedReason;
  if (
    finishedReason !== null &&
    (typeof finishedReason !== 'string' || !(FINISHED_REASONS as readonly string[]).includes(finishedReason))
  ) {
    return null;
  }
  const incomplete =
    typeof value.incomplete === 'boolean'
      ? value.incomplete
      : status === 'closed' ||
        (finishedReason !== null && INCOMPLETE_REASONS.includes(finishedReason as FinishedReason));
  return { code, createdAt, finishedReason: finishedReason as FinishedReason | null, incomplete };
}

/**
 * 只读原始快照的公共身份字段（房码与建房时间），完全不解释快照格式。
 * 迁移时先用它查重：同一 (房码, 建房时间, 局号) 已经归档的行直接跳过，
 * 不再换一种格式重新解析，也不会因为格式不同而误报损坏。
 */
export function readArchiveIdentity(value: unknown): { code: string; createdAt: number } | null {
  if (!isObject(value)) return null;
  const code = value.code;
  const createdAt = value.createdAt;
  if (typeof code !== 'string' || code.length === 0) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  return { code, createdAt };
}

/**
 * 读取成员。旧格式玩家没有 rollCount／timeoutCount，按仍然保留的旧局记录重建
 * （历史窗口最多 240 条，这是旧数据能提供的最完整信息）。
 */
function readPlayers(value: unknown, strict: boolean, history: RollRecord[] = []): InternalPlayer[] {
  if (!Array.isArray(value) || value.length === 0) corrupted('players 必须是非空数组');
  const rebuilt = strict ? null : countRollsFromHistory(history);
  return (value as unknown[]).map((entry, index) => readPlayer(entry, index, strict, rebuilt));
}

function countRollsFromHistory(history: readonly RollRecord[]): Map<string, { rollCount: number; timeoutCount: number }> {
  const counts = new Map<string, { rollCount: number; timeoutCount: number }>();
  for (const record of history) {
    const entry = counts.get(record.playerId) ?? { rollCount: 0, timeoutCount: 0 };
    if (record.reason === 'timeout') entry.timeoutCount += 1;
    else entry.rollCount += 1;
    counts.set(record.playerId, entry);
  }
  return counts;
}

function readPlayer(
  value: unknown,
  index: number,
  strict: boolean,
  rebuilt: Map<string, { rollCount: number; timeoutCount: number }> | null,
): InternalPlayer {
  const label = `players[${index}]`;
  const raw = asObject(value, label);
  const pick = (key: string, fallback: unknown): unknown =>
    strict ? requiredField(raw, key) : legacyField(raw, key, fallback);

  const id = readString(pick('id', undefined), `${label}.id`);
  const nicknameValue = pick('nickname', '');
  const seat = readInteger(pick('seat', index), `${label}.seat`, 0);
  const lastSeenAt = readTimestampOrNull(pick('lastSeenAt', 0), `${label}.lastSeenAt`);
  const bestValue = pick('best', null);
  const legacyCounts = rebuilt?.get(id) ?? { rollCount: 0, timeoutCount: 0 };
  const rollCount = strict
    ? readInteger(requiredField(raw, 'rollCount'), `${label}.rollCount`, 0)
    : readInteger(legacyField(raw, 'rollCount', legacyCounts.rollCount), `${label}.rollCount`, 0);
  const timeoutCount = strict
    ? readInteger(requiredField(raw, 'timeoutCount'), `${label}.timeoutCount`, 0)
    : readInteger(legacyField(raw, 'timeoutCount', legacyCounts.timeoutCount), `${label}.timeoutCount`, 0);
  return {
    id,
    nickname: typeof nicknameValue === 'string' ? nicknameValue : corrupted(`${label}.nickname 必须是字符串`),
    seat,
    ready: readBoolean(pick('ready', false), `${label}.ready`),
    online: readBoolean(pick('online', false), `${label}.online`),
    left: readBoolean(pick('left', false), `${label}.left`),
    awards: readAwards(pick('awards', null), `${label}.awards`, strict),
    best: readResult(bestValue, `${label}.best`, strict),
    rollCount,
    timeoutCount,
    tokenHash: readString(pick('tokenHash', undefined), `${label}.tokenHash`),
    lastSeenAt: lastSeenAt ?? 0,
  };
}
