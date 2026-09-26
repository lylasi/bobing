/**
 * 展示层纯函数：结算原因文案、判奖文案、战绩排序与时间格式。
 *
 * 与规则有关的判断全部来自 shared/rules.ts 的常量，不在这里复制第二份规则。
 */

import { NORMAL_PRIZE_KEYS, PRIZE_META, PRIZE_KEYS } from '../../shared/rules.js';
import type { DiceResult, FinishedReason, Player, PrizeKey, RoomState, RollRecord } from '../../shared/types.js';

export const FINISHED_REASON_LABELS: Readonly<Record<FinishedReason, string>> = {
  'round-limit': '达到轮数上限',
  'pool-empty': '普通奖全部领完，完成本轮后结算',
  'host-ended': '房主提前结束',
  'players-left': '在座玩家不足2人',
};

export function finishedReasonLabel(reason: FinishedReason | null): string {
  return reason ? FINISHED_REASON_LABELS[reason] : '本局已结束';
}

export function totalNormalAwards(awards: Readonly<Record<PrizeKey, number>>): number {
  return NORMAL_PRIZE_KEYS.reduce((sum, key) => sum + awards[key], 0);
}

export function totalAwards(awards: Readonly<Record<PrizeKey, number>>): number {
  return PRIZE_KEYS.reduce((sum, key) => sum + awards[key], 0);
}

/**
 * 战绩排序（rules-research 4.2）：状元拥有者优先，其次普通奖总数降序，最后入座顺序升序。
 * 只影响展示，不产生积分。
 */
export function standings(players: readonly Player[]): Player[] {
  return [...players].sort((a, b) => {
    const championA = a.awards.zhuangyuan > 0 ? 1 : 0;
    const championB = b.awards.zhuangyuan > 0 ? 1 : 0;
    if (championA !== championB) return championB - championA;
    const normalA = totalNormalAwards(a.awards);
    const normalB = totalNormalAwards(b.awards);
    if (normalA !== normalB) return normalB - normalA;
    return a.seat - b.seat;
  });
}

export function rollCountOf(history: readonly RollRecord[], playerId: string): number {
  return history.filter((record) => record.playerId === playerId && record.reason === 'rolled').length;
}

export function timeoutCountOf(history: readonly RollRecord[], playerId: string): number {
  return history.filter((record) => record.playerId === playerId && record.reason === 'timeout').length;
}

export interface RollHeadline {
  /** 主标题，例如“博得三红 · 获得1份”。 */
  title: string;
  /** 补充说明，例如“奖品已领完”或“好彩头留在下一掷”。 */
  detail: string | null;
  tone: 'champion' | 'prize' | 'empty' | 'none';
}

/** 把一条投掷记录翻译成设计规范中的中文文案（同一份文案用于碗下方与记录列表）。 */
export function describeRoll(record: RollRecord): RollHeadline {
  if (record.reason === 'timeout' || record.result === null) {
    return { title: '本轮超时，已跳过', detail: '超时不掷骰、不发奖，消耗一次机会', tone: 'empty' };
  }
  const result = record.result;
  if (result.prize === 'zhuangyuan') {
    return { title: `博得${result.label}`, detail: '计入状元候选，结束时发给领先者', tone: 'champion' };
  }
  if (result.prize !== null) {
    if (record.awarded === result.prize) {
      return { title: `博得${result.label} · 获得1份`, detail: null, tone: 'prize' };
    }
    return { title: `博得${result.label}`, detail: '奖品已领完', tone: 'empty' };
  }
  return { title: '好彩头留在下一掷', detail: `${result.label}，本次没有奖品`, tone: 'none' };
}

export function prizeLabelOf(key: PrizeKey): string {
  return PRIZE_META[key].label;
}

/** 当前状元领先者（用于奖池区金底卡）。 */
export function championPlayer(room: RoomState): Player | null {
  if (!room.champion) return null;
  return room.players.find((player) => player.id === room.champion?.playerId) ?? null;
}

export function playerById(room: RoomState, playerId: string | null): Player | null {
  if (!playerId) return null;
  return room.players.find((player) => player.id === playerId) ?? null;
}

/** 未离开成员，按入座顺序。 */
export function seatedPlayers(room: RoomState): Player[] {
  return room.players.filter((player) => !player.left).sort((a, b) => a.seat - b.seat);
}

export function currentTurnPlayer(room: RoomState): Player | null {
  return playerById(room, room.turnPlayerId);
}

/** 最近一条真实投掷记录（用于碗下方的结果说明）。 */
export function latestRoll(room: RoomState): RollRecord | null {
  for (let index = room.history.length - 1; index >= 0; index -= 1) {
    const record = room.history[index];
    if (record) return record;
  }
  return null;
}

export function resultOfDice(result: DiceResult | null): string {
  return result ? result.label : '';
}

export function formatRemaining(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${seconds} 秒`;
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 房主开始按钮的禁用原因（禁用时必须说明原因）。
 * 返回 null 表示可以开始。
 */
export function startBlockedReason(room: RoomState): string | null {
  const active = room.players.filter((player) => !player.left);
  if (active.length < 2) return '至少2位玩家在线并准备后才能开始';
  const offline = active.filter((player) => !player.online);
  if (offline.length > 0) return `等待 ${offline.map((player) => player.nickname).join('、')} 上线`;
  const notReady = active.filter((player) => !player.ready);
  if (notReady.length > 0) return `等待 ${notReady.map((player) => player.nickname).join('、')} 准备`;
  if (active.length > room.maxPlayers) return '人数超过上限';
  return null;
}

export const READY_BLOCKED_HINT = '至少2位玩家在线并准备后才能开始';
