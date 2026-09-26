/**
 * 公共 DTO / 动作 / 错误码。
 *
 * 本文件的类型是前后端共同契约（product-spec 第 5 节），实现可以拆分文件，
 * 但不能在前后端自行改名。此处不得出现任何密钥字段：
 * 成员凭证（token）只在 `Membership` 中出现一次，绝不进入 `RoomState`。
 */

/** 奖池档位。状元单独保留，其余五档为普通奖。 */
export type PrizeKey = 'zhuangyuan' | 'duitang' | 'sanhong' | 'sijin' | 'erju' | 'yixiu';

/** 判奖结果代码，按线上统一房规 v1 的判定顺序排列。 */
export type ResultCode =
  | 'chajinhua'
  | 'liuhong'
  | 'biandijin'
  | 'liuhe'
  | 'wuhong'
  | 'wuzi'
  | 'sihong'
  | 'duitang'
  | 'sanhong'
  | 'sijin'
  | 'erju'
  | 'yixiu'
  | 'none';

export type RoomStatus = 'waiting' | 'playing' | 'finished' | 'closed';

/** 状元比较键：从左到右字典序比较，较大者胜；完全相同则先到先得。 */
export type RankKey = [number, number, number];

export type FinishedReason = 'round-limit' | 'pool-empty' | 'host-ended' | 'players-left';

export interface DiceResult {
  code: ResultCode;
  label: string;
  prize: PrizeKey | null;
  rankKey: RankKey;
}

export interface Player {
  id: string;
  nickname: string;
  seat: number;
  ready: boolean;
  online: boolean;
  left: boolean;
  awards: Record<PrizeKey, number>;
  best: DiceResult | null;
}

export interface RollRecord {
  id: string;
  playerId: string;
  nickname: string;
  round: number;
  turnId: string;
  dice: number[];
  result: DiceResult | null;
  awarded: PrizeKey | null;
  reason: 'rolled' | 'timeout';
  at: number;
}

export interface Champion {
  playerId: string;
  result: DiceResult;
  dice: number[];
  at: number;
}

export interface RoomState {
  code: string;
  name: string;
  maxPlayers: number;
  maxRounds: 5 | 10 | 20;
  rulesVersion: 'unified-v1';
  status: RoomStatus;
  hostId: string;
  revision: number;
  players: Player[];
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
}

/** 成员凭证。只返回给创建者/加入者本人，绝不进入 RoomState、URL 或分享文本。 */
export interface Membership {
  roomCode: string;
  playerId: string;
  token: string;
}

export type Action =
  | { type: 'ready'; ready: boolean }
  | { type: 'start' }
  | { type: 'roll'; requestId: string; expectedTurnId: string }
  | { type: 'leave' }
  | { type: 'end' }
  | { type: 'rematch' };

/** 邀请落地页概况：只暴露房间概况，不含任何成员信息。 */
export interface RoomPreview {
  code: string;
  name: string;
  playerCount: number;
  maxPlayers: number;
  maxRounds: 5 | 10 | 20;
  status: RoomStatus;
  rulesVersion: 'unified-v1';
  canJoin: boolean;
}

export interface CreateRoomRequest {
  nickname: string;
  name: string;
  maxPlayers: number;
  maxRounds: 5 | 10 | 20;
}

export interface JoinRoomRequest {
  nickname: string;
}

export interface RoomWithMembershipResponse {
  membership: Membership;
  room: RoomState;
}

export interface RoomResponse {
  room: RoomState;
}

export interface MemberStateResponse {
  room: RoomState;
  playerId: string;
}

export interface HealthResponse {
  ok: true;
}

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_TOKEN'
  | 'HOST_ONLY'
  | 'NOT_YOUR_TURN'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_STARTED'
  | 'NICKNAME_TAKEN'
  | 'NOT_READY'
  | 'STALE_TURN'
  | 'INVALID_STATE'
  | 'ROOM_EXPIRED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** 错误码到 HTTP 状态（product-spec 第 6 节）。 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  INVALID_INPUT: 400,
  INVALID_TOKEN: 401,
  HOST_ONLY: 403,
  NOT_YOUR_TURN: 403,
  ROOM_NOT_FOUND: 404,
  ROOM_FULL: 409,
  ROOM_STARTED: 409,
  NICKNAME_TAKEN: 409,
  NOT_READY: 409,
  STALE_TURN: 409,
  INVALID_STATE: 409,
  ROOM_EXPIRED: 410,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/** 错误码到简体中文提示（服务端 message 与前端提示共用同一份文案）。 */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  INVALID_INPUT: '请检查昵称、房间码或房间设置',
  INVALID_TOKEN: '你的房间身份已失效，请重新加入',
  HOST_ONLY: '只有房主可以进行此操作',
  NOT_YOUR_TURN: '还没轮到你，请等待其他玩家',
  ROOM_NOT_FOUND: '没找到这个房间，请检查房间码',
  ROOM_FULL: '房间已满',
  ROOM_STARTED: '本局已经开始，暂时不能加入',
  NICKNAME_TAKEN: '这个昵称已被使用，请换一个',
  NOT_READY: '至少2位玩家在线并准备后才能开始',
  STALE_TURN: '这一轮已经结束，已为你同步最新状态',
  INVALID_STATE: '当前房间状态不支持此操作',
  ROOM_EXPIRED: '房间已过期，可以重新开一桌',
  RATE_LIMITED: '操作太快了，请稍后再试',
  INTERNAL_ERROR: '暂时无法完成操作，请稍后重试',
};

export const ERROR_CODES = Object.keys(ERROR_MESSAGES) as ErrorCode[];

/** Socket.IO 事件名（前后端必须一致）。 */
export const SOCKET_EVENT_ROOM_STATE = 'room:state';
