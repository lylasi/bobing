/**
 * 房间服务：创建、加入、身份恢复、动作、凭证、公共快照、在线状态与计时。
 *
 * 设计要点（product-spec 第 5、7 节）：
 *  - 服务端是随机数、轮次、权限、奖池、判奖、结算的唯一权威；客户端不能提交骰子。
 *  - 状态读取、校验、更新与 SQLite 事务全过程同步，中间不 await，因此单进程内
 *    两个并发请求只会有一个成功改变同一个 turnId。
 *  - 每次变更先落盘、再广播完整公共快照（含递增 revision）。
 *  - 公共快照按白名单构造，绝不展开内部成员对象，凭证哈希不会泄漏。
 *  - `now`、`rollDice`、`pickStartSeat` 等注入点只存在于本类构造函数，
 *    仅供测试注入确定性随机与时钟，不存在 HTTP/Socket 作弊入口。
 */

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  DEFAULT_MAX_PLAYERS,
  DEFAULT_MAX_ROUNDS,
  HOST_TRANSFER_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NICKNAME_MAX_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_NAME_MAX_LENGTH,
  ROOM_TTL_MS,
  ROUND_OPTIONS,
  TURN_DURATION_MS,
} from '../shared/rules.js';
import { ERROR_HTTP_STATUS, ERROR_MESSAGES } from '../shared/types.js';
import type {
  Action,
  Champion,
  DiceResult,
  ErrorCode,
  Membership,
  Player,
  RoomPreview,
  RoomState,
  RollRecord,
} from '../shared/types.js';
import type { AppDatabase } from './db.js';
import {
  activePlayers,
  allActiveOffline,
  allActiveOnline,
  applyRoll,
  countActive,
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
} from './game.js';
import type { InternalPlayer, InternalRoom } from './game.js';

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'ServiceError';
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
  }
}

export interface RateLimitOptions {
  /** 创建/加入：每 IP 每分钟上限。 */
  createJoinPerMinute: number;
  /** 其他写操作：每身份每分钟上限。 */
  actionPerMinute: number;
}

export interface RoomServiceOptions {
  db: AppDatabase;
  now?: () => number;
  /** 默认 crypto.randomInt(1,7) × 6；注入只用于测试。 */
  rollDice?: () => number[];
  /** 返回开局起始位偏移（0..playerCount-1），默认 crypto 安全随机。 */
  pickStartSeat?: (playerCount: number) => number;
  createRoomCode?: () => string;
  createToken?: () => string;
  createPlayerId?: () => string;
  turnDurationMs?: number;
  hostTransferMs?: number;
  roomTtlMs?: number;
  rateLimits?: Partial<RateLimitOptions>;
  onBroadcast?: (room: RoomState) => void;
}

export interface CreateRoomInput {
  nickname: unknown;
  name: unknown;
  maxPlayers: unknown;
  maxRounds: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** UTF-8 字符数按码点计数（Array.from），不允许控制字符。 */
function normalizeText(raw: unknown, min: number, max: number): string {
  if (typeof raw !== 'string') throw new ServiceError('INVALID_INPUT');
  const value = raw.trim();
  const length = Array.from(value).length;
  if (length < min || length > max) throw new ServiceError('INVALID_INPUT');
  if (CONTROL_CHARS.test(value)) throw new ServiceError('INVALID_INPUT');
  return value;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function cloneResult(result: DiceResult): DiceResult {
  return { code: result.code, label: result.label, prize: result.prize, rankKey: [result.rankKey[0], result.rankKey[1], result.rankKey[2]] };
}

function cloneRollRecord(record: RollRecord): RollRecord {
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
  };
}

function toPublicPlayer(player: InternalPlayer): Player {
  return {
    id: player.id,
    nickname: player.nickname,
    seat: player.seat,
    ready: player.ready,
    online: player.online,
    left: player.left,
    awards: { ...player.awards },
    best: player.best ? cloneResult(player.best) : null,
  };
}

/**
 * 白名单构造公共快照：显式列出每个字段并深拷贝。
 * 不得改为展开内部玩家对象，否则 tokenHash / lastSeenAt 会泄漏给所有客户端。
 */
export function toPublicRoom(room: InternalRoom): RoomState {
  const champion: Champion | null = room.champion
    ? { playerId: room.champion.playerId, result: cloneResult(room.champion.result), dice: [...room.champion.dice], at: room.champion.at }
    : null;
  return {
    code: room.code,
    name: room.name,
    maxPlayers: room.maxPlayers,
    maxRounds: room.maxRounds,
    rulesVersion: room.rulesVersion,
    status: room.status,
    hostId: room.hostId,
    revision: room.revision,
    players: [...room.players].sort((a, b) => a.seat - b.seat).map(toPublicPlayer),
    gameNumber: room.gameNumber,
    round: room.round,
    turnPlayerId: room.turnPlayerId,
    turnId: room.turnId,
    deadline: room.deadline,
    paused: room.paused,
    pool: { ...room.pool },
    champion,
    history: room.history.map(cloneRollRecord),
    finishedReason: room.finishedReason,
    createdAt: room.createdAt,
    expiresAt: room.expiresAt,
  };
}

/**
 * 过期墓碑保留期：房间清理后 7 天内原房码仍返回 410，
 * 之后仅剩“房间不存在”，墓碑由 tick 清理，不会无限增长。
 */
export const ROOM_TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class RoomService {
  private readonly db: AppDatabase;
  private readonly nowFn: () => number;
  private readonly rollDiceFn: () => number[];
  private readonly pickStartSeatFn: (playerCount: number) => number;
  private readonly createRoomCodeFn: () => string;
  private readonly createTokenFn: () => string;
  private readonly createPlayerIdFn: () => string;
  private readonly turnDurationMs: number;
  private readonly hostTransferMs: number;
  private readonly roomTtlMs: number;
  private readonly limits: RateLimitOptions;
  private broadcaster: ((room: RoomState) => void) | null;
  private purgeHandler: ((code: string) => void) | null = null;

  /** 房间内存缓存：单实例、全量状态，写入与读取都经过本缓存。 */
  private readonly cache = new Map<string, InternalRoom>();
  /** Socket 连接引用计数：同一成员多连接只有最后一个断开才算离线。 */
  private readonly presence = new Map<string, number>();
  private readonly rateBuckets = new Map<string, number[]>();

  constructor(options: RoomServiceOptions) {
    this.db = options.db;
    this.nowFn = options.now ?? (() => Date.now());
    this.rollDiceFn =
      options.rollDice ?? (() => Array.from({ length: 6 }, () => randomInt(1, 7)));
    this.pickStartSeatFn = options.pickStartSeat ?? ((playerCount: number) => randomInt(0, Math.max(1, playerCount)));
    this.createRoomCodeFn =
      options.createRoomCode ??
      (() => {
        let code = '';
        for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
          code += ROOM_CODE_ALPHABET[randomInt(0, ROOM_CODE_ALPHABET.length)];
        }
        return code;
      });
    this.createTokenFn = options.createToken ?? (() => randomBytes(32).toString('hex'));
    this.createPlayerIdFn = options.createPlayerId ?? (() => randomUUID());
    this.turnDurationMs = options.turnDurationMs ?? TURN_DURATION_MS;
    this.hostTransferMs = options.hostTransferMs ?? HOST_TRANSFER_MS;
    this.roomTtlMs = options.roomTtlMs ?? ROOM_TTL_MS;
    this.limits = {
      createJoinPerMinute: options.rateLimits?.createJoinPerMinute ?? 30,
      actionPerMinute: options.rateLimits?.actionPerMinute ?? 120,
    };
    this.broadcaster = options.onBroadcast ?? null;
  }

  setBroadcaster(broadcaster: ((room: RoomState) => void) | null): void {
    this.broadcaster = broadcaster;
  }

  /** 过期清理时通知实时层断开该房间的连接引用。 */
  setPurgeHandler(handler: ((code: string) => void) | null): void {
    this.purgeHandler = handler;
  }

  now(): number {
    return this.nowFn();
  }

  // —— 内部读取与持久化 ——

  private loadRoom(code: string): InternalRoom | null {
    const cached = this.cache.get(code);
    if (cached) return cached;
    const row = this.db.getRoom(code);
    if (!row) return null;
    const room = JSON.parse(row.stateJson) as InternalRoom;
    this.cache.set(room.code, room);
    return room;
  }

  private requireRoom(code: string): InternalRoom {
    const room = this.loadRoom(code);
    if (!room) {
      // 已知的过期房间保留墓碑，继续给“房间已过期”而不是“没找到”
      if (this.db.isExpiredCode(code)) throw new ServiceError('ROOM_EXPIRED');
      throw new ServiceError('ROOM_NOT_FOUND');
    }
    if (room.expiresAt <= this.nowFn()) throw new ServiceError('ROOM_EXPIRED');
    return room;
  }

  /**
   * 先落盘、再广播；公共快照在 revision 递增之后构造。
   * 写库失败时驱逐内存中被改动过的对象并回退到数据库中的已提交状态，
   * 避免未提交的奖池/记录/回合被后续请求读到，也绝不广播失败结果。
   */
  private commit(room: InternalRoom, extra?: () => void): RoomState {
    room.revision += 1;
    try {
      const stateJson = JSON.stringify(room);
      this.db.transaction(() => {
        this.db.saveRoom({ code: room.code, stateJson, expiresAt: room.expiresAt, revision: room.revision });
        extra?.();
      });
    } catch (error) {
      this.reloadFromDatabaseAfterFailure(room.code);
      throw error;
    }
    const snapshot = toPublicRoom(room);
    this.broadcaster?.(snapshot);
    return snapshot;
  }

  /** 写库失败后的恢复：创建失败不得留下虚假房间，更新失败回到已提交状态。 */
  private reloadFromDatabaseAfterFailure(code: string): void {
    this.cache.delete(code);
    try {
      const row = this.db.getRoom(code);
      if (!row) return; // 新建房间写入失败：内存里也不保留
      this.cache.set(code, JSON.parse(row.stateJson) as InternalRoom);
    } catch (reloadError) {
      console.error('[bobing] 写库失败后重新加载房间也失败，已从内存驱逐', code, reloadError);
    }
  }

  /** 清理过期房间：删除房间/回执/归档，留下墓碑并断开该房间的连接引用。 */
  private purgeExpiredRoom(code: string, now: number): void {
    this.cache.delete(code);
    this.clearPresence(code);
    this.db.transaction(() => {
      this.db.deleteRoom(code);
      this.db.markExpired(code, now);
    });
    try {
      this.purgeHandler?.(code);
    } catch (error) {
      console.error('[bobing] 通知房间清理失败', code, error);
    }
  }

  private clearPresence(code: string): void {
    const prefix = `${code}:`;
    for (const key of [...this.presence.keys()]) {
      if (key.startsWith(prefix)) this.presence.delete(key);
    }
  }

  private snapshot(room: InternalRoom): RoomState {
    return toPublicRoom(room);
  }

  private authenticate(room: InternalRoom, token: unknown): InternalPlayer {
    if (typeof token !== 'string' || token.length === 0) throw new ServiceError('INVALID_TOKEN');
    const hash = hashToken(token);
    const player = room.players.find((candidate) => !candidate.left && safeEqualHex(candidate.tokenHash, hash));
    if (!player) throw new ServiceError('INVALID_TOKEN');
    return player;
  }

  private checkRateLimit(key: string, limit: number, now: number): void {
    const windowMs = 60_000;
    const bucket = (this.rateBuckets.get(key) ?? []).filter((at) => now - at < windowMs);
    if (bucket.length >= limit) {
      this.rateBuckets.set(key, bucket);
      throw new ServiceError('RATE_LIMITED');
    }
    bucket.push(now);
    this.rateBuckets.set(key, bucket);
  }

  private pruneRateBuckets(now: number): void {
    const windowMs = 60_000;
    for (const [key, bucket] of this.rateBuckets) {
      const fresh = bucket.filter((at) => now - at < windowMs);
      if (fresh.length === 0) this.rateBuckets.delete(key);
      else if (fresh.length !== bucket.length) this.rateBuckets.set(key, fresh);
    }
  }

  // —— 生命周期 ——

  /**
   * 进程启动：所有连接状态置离线，进行中的对局暂停（保留剩余毫秒），
   * 不能把重启前的回合立刻判超时。返回恢复的房间数。
   */
  onBoot(now: number = this.nowFn()): number {
    this.presence.clear();
    let resumed = 0;
    for (const code of this.db.listRoomCodes(now)) {
      const room = this.loadRoom(code);
      if (!room) continue;
      let changed = false;
      for (const player of room.players) {
        if (player.online) {
          player.online = false;
          player.lastSeenAt = now;
          changed = true;
        }
      }
      if (room.status === 'playing') {
        const wasPaused = room.paused;
        pauseRoom(room, now);
        if (!wasPaused) changed = true;
      }
      if (changed) this.commit(room);
      resumed += 1;
    }
    return resumed;
  }

  /** 每秒时钟：超时跳过、全员离线暂停、房主离线转交、过期清理。 */
  tick(now: number = this.nowFn()): string[] {
    const changed: string[] = [];

    for (const code of this.db.listExpiredCodes(now)) {
      this.purgeExpiredRoom(code, now);
    }
    this.db.purgeExpiredTombstones(now - ROOM_TOMBSTONE_TTL_MS);

    for (const room of [...this.cache.values()]) {
      if (this.tickRoom(room, now)) changed.push(room.code);
    }

    this.pruneRateBuckets(now);
    return changed;
  }

  private tickRoom(room: InternalRoom, now: number): boolean {
    if (room.status === 'closed') return false;

    let changed = false;
    if (room.status === 'playing') {
      if (!room.paused && room.deadline !== null && now >= room.deadline) {
        if (skipExpiredTurn(room, now)) changed = true;
      }
      if (room.status === 'playing') {
        if (room.paused && allActiveOnline(room) && activePlayers(room).length > 0) {
          resumeRoom(room, now);
          changed = true;
        } else if (!room.paused && allActiveOffline(room) && activePlayers(room).length > 0) {
          pauseRoom(room, now);
          changed = true;
        }
        if (countActive(room) < MIN_PLAYERS) {
          finishGame(room, 'players-left', now);
          changed = true;
        }
      }
    }

    // 房主离线 60 秒后有在线成员则自动转交；自动转交只考虑在线候选人，
    // 全员离线时保持原房主，避免把房主交给另一个离线成员。
    const host = findPlayer(room, room.hostId);
    if (host && !host.left && !host.online) {
      if (room.hostOfflineSince === null) {
        room.hostOfflineSince = now;
        changed = true;
      } else if (now - room.hostOfflineSince >= this.hostTransferMs) {
        if (transferHost(room, { onlineOnly: true }) !== null) changed = true;
      }
    }

    if (changed) this.commit(room);
    return changed;
  }

  // —— 公共 API ——

  health(): boolean {
    return this.db.ping();
  }

  preview(rawCode: string): RoomPreview {
    const room = this.requireRoom(normalizeRoomCode(rawCode));
    const playerCount = countActive(room);
    return {
      code: room.code,
      name: room.name,
      playerCount,
      maxPlayers: room.maxPlayers,
      maxRounds: room.maxRounds,
      status: room.status,
      rulesVersion: room.rulesVersion,
      canJoin: room.status === 'waiting' && playerCount < room.maxPlayers,
    };
  }

  create(input: CreateRoomInput, clientIp: string): { membership: Membership; room: RoomState } {
    const nickname = normalizeText(input.nickname, 1, NICKNAME_MAX_LENGTH);
    const name = normalizeText(input.name, 1, ROOM_NAME_MAX_LENGTH);
    const maxPlayers = input.maxPlayers;
    if (typeof maxPlayers !== 'number' || !Number.isInteger(maxPlayers) || maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
      throw new ServiceError('INVALID_INPUT');
    }
    const maxRounds = input.maxRounds;
    if (typeof maxRounds !== 'number' || !(ROUND_OPTIONS as readonly number[]).includes(maxRounds)) {
      throw new ServiceError('INVALID_INPUT');
    }
    const now = this.nowFn();
    this.checkRateLimit(`create:${clientIp}`, this.limits.createJoinPerMinute, now);

    const code = this.generateRoomCode();
    const playerId = this.createPlayerIdFn();
    const token = this.createTokenFn();
    const room = createInternalRoom({
      code,
      name,
      maxPlayers,
      maxRounds: maxRounds as 5 | 10 | 20,
      hostId: playerId,
      hostNickname: nickname,
      hostTokenHash: hashToken(token),
      now,
      expiresAt: now + this.roomTtlMs,
      turnDurationMs: this.turnDurationMs,
    });
    this.cache.set(code, room);
    const snapshot = this.commit(room);
    return { membership: { roomCode: code, playerId, token }, room: snapshot };
  }

  join(rawCode: string, nicknameInput: unknown, clientIp: string): { membership: Membership; room: RoomState } {
    const code = normalizeRoomCode(rawCode);
    const room = this.requireRoom(code);
    const now = this.nowFn();
    this.checkRateLimit(`create:${clientIp}`, this.limits.createJoinPerMinute, now);

    if (room.status === 'closed') throw new ServiceError('INVALID_STATE', '本局已经结束，不能加入');
    if (room.status !== 'waiting') throw new ServiceError('ROOM_STARTED');
    if (countActive(room) >= room.maxPlayers) throw new ServiceError('ROOM_FULL');

    const nickname = normalizeText(nicknameInput, 1, NICKNAME_MAX_LENGTH);
    if (activePlayers(room).some((player) => player.nickname === nickname)) throw new ServiceError('NICKNAME_TAKEN');

    const playerId = this.createPlayerIdFn();
    const token = this.createTokenFn();
    const seat = room.players.reduce((max, player) => Math.max(max, player.seat), -1) + 1;
    room.players.push({
      id: playerId,
      nickname,
      seat,
      ready: false,
      online: false,
      left: false,
      awards: { zhuangyuan: 0, duitang: 0, sanhong: 0, sijin: 0, erju: 0, yixiu: 0 },
      best: null,
      tokenHash: hashToken(token),
      lastSeenAt: now,
    });
    room.lastActivityAt = now;
    const snapshot = this.commit(room);
    return { membership: { roomCode: room.code, playerId, token }, room: snapshot };
  }

  /** 刷新与断线恢复：用原 token 取回同一成员身份，不新增玩家。 */
  state(rawCode: string, token: unknown): { room: RoomState; playerId: string } {
    const room = this.requireRoom(normalizeRoomCode(rawCode));
    const player = this.authenticate(room, token);
    return { room: this.snapshot(room), playerId: player.id };
  }

  /** 只读快照（Socket 首帧、广播复用同一构造器）。 */
  getSnapshot(code: string): RoomState | null {
    const room = this.loadRoom(code);
    if (!room || room.expiresAt <= this.nowFn()) return null;
    return this.snapshot(room);
  }

  /** 校验 Socket handshake 凭证；不改变在线状态。 */
  authenticateMember(rawCode: string, token: unknown): { room: RoomState; playerId: string } {
    return this.state(rawCode, token);
  }

  action(rawCode: string, token: unknown, action: Action): { room: RoomState } {
    const room = this.requireRoom(normalizeRoomCode(rawCode));
    const player = this.authenticate(room, token);
    const now = this.nowFn();
    this.checkRateLimit(`action:${room.code}:${player.id}`, this.limits.actionPerMinute, now);

    switch (action.type) {
      case 'ready':
        return this.handleReady(room, player, action.ready);
      case 'start':
        return this.handleStart(room, player, now);
      case 'roll':
        return this.handleRoll(room, player, action, now);
      case 'leave':
        return this.handleLeave(room, player, now);
      case 'end':
        return this.handleEnd(room, player, now);
      case 'rematch':
        return this.handleRematch(room, player, now);
      default:
        throw new ServiceError('INVALID_INPUT');
    }
  }

  private handleReady(room: InternalRoom, player: InternalPlayer, ready: unknown): { room: RoomState } {
    if (room.status !== 'waiting') throw new ServiceError('INVALID_STATE');
    if (typeof ready !== 'boolean') throw new ServiceError('INVALID_INPUT');
    if (player.ready !== ready) {
      player.ready = ready;
      return { room: this.commit(room) };
    }
    return { room: this.snapshot(room) };
  }

  private handleStart(room: InternalRoom, player: InternalPlayer, now: number): { room: RoomState } {
    if (room.status !== 'waiting') throw new ServiceError('INVALID_STATE');
    if (room.hostId !== player.id) throw new ServiceError('HOST_ONLY');
    const active = activePlayers(room);
    const readyToStart =
      active.length >= MIN_PLAYERS && active.length <= room.maxPlayers && active.every((candidate) => candidate.online && candidate.ready);
    if (!readyToStart) throw new ServiceError('NOT_READY');
    startGame(room, now, this.pickStartSeatFn(active.length));
    return { room: this.commit(room) };
  }

  private handleRoll(room: InternalRoom, player: InternalPlayer, action: { requestId: string; expectedTurnId: string }, now: number): { room: RoomState } {
    if (!isUuid(action.requestId)) throw new ServiceError('INVALID_INPUT', '掷骰请求参数不完整，请刷新页面后重试');
    if (!isUuid(action.expectedTurnId)) throw new ServiceError('INVALID_INPUT', '掷骰请求参数不完整，请刷新页面后重试');

    // 幂等：先查当前局该玩家的回执，重复请求直接返回已提交状态，不消耗下一次机会
    const prior = this.db.findReceipt(room.code, room.gameNumber, player.id, action.requestId);
    if (prior) return { room: this.snapshot(room) };

    if (room.status !== 'playing') throw new ServiceError('INVALID_STATE');
    // 全员离线暂停期间不接受掷骰：先重连恢复倒计时再掷
    if (room.paused || room.deadline === null) {
      throw new ServiceError('INVALID_STATE', '房间已暂停，请重新连接后再掷骰');
    }
    // 到期与下一次 tick 之间迟到的请求：先把这一回合按超时结算并落盘，再让客户端同步
    if (now >= room.deadline) {
      if (skipExpiredTurn(room, now)) this.commit(room);
      throw new ServiceError('STALE_TURN');
    }
    // 先判回合是否已经过去（重试/双击时语义是“这一轮已经结束”），
    // 再判是否是本人回合（拿着当前 turnId 抢别人的回合）。
    if (room.turnId !== action.expectedTurnId) throw new ServiceError('STALE_TURN');
    if (room.turnPlayerId !== player.id) throw new ServiceError('NOT_YOUR_TURN');

    // 点数完全由服务端随机源产生：请求体里的任何 dice 字段都不会被读取
    const dice = this.rollDiceFn();
    if (!isValidDice(dice)) throw new ServiceError('INTERNAL_ERROR', '随机源返回了非法骰子');

    const gameNumber = room.gameNumber;
    const record = applyRoll(room, player.id, dice, now);
    const snapshot = this.commit(room, () => {
      this.db.saveReceipt({
        roomCode: room.code,
        gameNumber,
        playerId: player.id,
        requestId: action.requestId,
        resultJson: JSON.stringify(record),
        createdAt: now,
      });
    });
    return { room: snapshot };
  }

  private handleLeave(room: InternalRoom, player: InternalPlayer, now: number): { room: RoomState } {
    if (player.left) return { room: this.snapshot(room) };
    const wasPlaying = room.status === 'playing';

    player.left = true;
    player.ready = false;
    player.online = false;
    player.lastSeenAt = now;
    this.presence.delete(presenceKey(room.code, player.id));

    // 主动离开时允许交给离线成员（在线优先），否则房间可能没有房主
    if (room.hostId === player.id) transferHost(room, { excludePlayerId: player.id });

    if (wasPlaying) {
      dropCurrentTurnIfPlayer(room, player.id, now);
      if (room.status === 'playing' && countActive(room) < MIN_PLAYERS) {
        finishGame(room, 'players-left', now);
      }
    }
    if (countActive(room) === 0) {
      room.status = 'closed';
      room.deadline = null;
      room.paused = false;
      room.pauseRemainingMs = null;
      room.turnPlayerId = null;
      room.turnId = null;
    }
    room.lastActivityAt = now;
    return { room: this.commit(room) };
  }

  private handleEnd(room: InternalRoom, player: InternalPlayer, now: number): { room: RoomState } {
    if (room.hostId !== player.id) throw new ServiceError('HOST_ONLY');
    if (room.status !== 'playing') throw new ServiceError('INVALID_STATE');
    finishGame(room, 'host-ended', now);
    return { room: this.commit(room) };
  }

  private handleRematch(room: InternalRoom, player: InternalPlayer, now: number): { room: RoomState } {
    if (room.hostId !== player.id) throw new ServiceError('HOST_ONLY');
    if (room.status !== 'finished') throw new ServiceError('INVALID_STATE');
    const archivedGameNumber = room.gameNumber;
    const archivedJson = JSON.stringify(room);
    prepareRematch(room, now);
    const snapshot = this.commit(room, () => {
      this.db.saveCompletedGame(room.code, archivedGameNumber, archivedJson, now);
    });
    return { room: snapshot };
  }

  /** Socket 连接建立：引用计数 +1，首位回来的成员恢复倒计时。 */
  connectMember(rawCode: string, token: unknown): { room: RoomState; playerId: string } {
    const code = normalizeRoomCode(rawCode);
    const room = this.requireRoom(code);
    const player = this.authenticate(room, token);
    const snapshot = this.openConnection(code, player.id);
    return { room: snapshot ?? this.snapshot(room), playerId: player.id };
  }

  /**
   * 连接引用计数 +1（Socket 已通过 handshake 鉴权后调用）。
   * 同一成员多连接只有最后一个断开才算离线；第一位回来的成员恢复 deadline。
   */
  openConnection(code: string, playerId: string): RoomState | null {
    const room = this.loadRoom(code);
    if (!room || room.expiresAt <= this.nowFn()) return null;
    const player = findPlayer(room, playerId);
    if (!player || player.left) return null;
    const now = this.nowFn();

    const key = presenceKey(room.code, player.id);
    this.presence.set(key, (this.presence.get(key) ?? 0) + 1);

    let changed = false;
    if (!player.online) {
      player.online = true;
      player.lastSeenAt = now;
      changed = true;
    }
    if (room.hostId === player.id && room.hostOfflineSince !== null) {
      room.hostOfflineSince = null;
      changed = true;
    }
    if (room.status === 'playing' && room.paused) {
      resumeRoom(room, now);
      changed = true;
    }
    return changed ? this.commit(room) : this.snapshot(room);
  }

  /** Socket 断开：只有最后一个连接断开才标记离线。返回是否发生了状态变化。 */
  disconnectMember(code: string, playerId: string): boolean {
    return this.closeConnection(code, playerId);
  }

  closeConnection(code: string, playerId: string): boolean {
    const room = this.cache.get(code);
    if (!room) return false;
    const key = presenceKey(code, playerId);
    const current = this.presence.get(key) ?? 0;
    if (current > 1) {
      this.presence.set(key, current - 1);
      return false;
    }
    this.presence.delete(key);

    const player = findPlayer(room, playerId);
    if (!player) return false;
    const now = this.nowFn();
    let changed = false;
    if (player.online) {
      player.online = false;
      player.lastSeenAt = now;
      changed = true;
    }
    if (room.hostId === player.id && room.hostOfflineSince === null && !player.left) {
      room.hostOfflineSince = now;
      changed = true;
    }
    if (room.status === 'playing' && !room.paused && allActiveOffline(room) && activePlayers(room).length > 0) {
      pauseRoom(room, now);
      changed = true;
    }
    if (changed) this.commit(room);
    return changed;
  }

  /** 供测试与运维使用：当前内存中的房间数。 */
  loadedRoomCount(): number {
    return this.cache.size;
  }

  private generateRoomCode(): string {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = this.createRoomCodeFn();
      if (!this.cache.has(code) && this.db.getRoom(code) === null && !this.db.isExpiredCode(code)) return code;
    }
    throw new ServiceError('INTERNAL_ERROR', '无法生成唯一房间码');
  }
}

function presenceKey(code: string, playerId: string): string {
  return `${code}:${playerId}`;
}

/** 房码忽略首尾空格并转大写；长度与字符集不合法按输入错误处理。 */
export function normalizeRoomCode(raw: unknown): string {
  if (typeof raw !== 'string') throw new ServiceError('INVALID_INPUT');
  const code = raw.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) throw new ServiceError('INVALID_INPUT');
  for (const char of code) {
    if (!ROOM_CODE_ALPHABET.includes(char)) throw new ServiceError('INVALID_INPUT');
  }
  return code;
}

export const DEFAULTS = {
  maxPlayers: DEFAULT_MAX_PLAYERS,
  maxRounds: DEFAULT_MAX_ROUNDS,
} as const;
