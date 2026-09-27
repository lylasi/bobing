/**
 * 结果展示节奏：动画常量、结果停留配置的默认值与严格校验。
 *
 * 一次正常投掷的完整节奏是“本人约 750ms 投掷动画 → 结果阅读（默认 1 秒）→ 下一位完整 30 秒”。
 * 房主可以设置 0–10 秒的结果停留：0 秒表示跳过额外阅读时间，但仍保留投掷动画；
 * 超时跳过没有动画，展示时长就等于配置的停留时长（0 秒时可立即推进）。
 *
 * 本文件前后端共用，不引入 Node 或浏览器专有 API。
 */

import type { RollRecord, RoomPacing } from './types.js';

/** 本人投掷动画时长；服务端用同一常量决定结果最早可被阅读的时刻。 */
export const DICE_REVEAL_MS = 750;

/** 结果停留默认秒数（用户确认：默认 1 秒）。 */
export const DEFAULT_RESULT_HOLD_SECONDS = 1;
export const MIN_RESULT_HOLD_SECONDS = 0;
export const MAX_RESULT_HOLD_SECONDS = 10;

/** 配置非法时的统一前缀；服务层据此映射到 INVALID_INPUT。 */
export const INVALID_ROOM_PACING_MESSAGE = '结果停留时长只支持 0–10 的整数秒';

/** 新房默认节奏（结果停留 1 秒）。 */
export function createDefaultRoomPacing(): RoomPacing {
  return { resultHoldSeconds: DEFAULT_RESULT_HOLD_SECONDS };
}

/**
 * 严格校验结果停留配置。
 *
 * 省略（undefined 或字段缺失）返回默认值；显式给出但不合法（非对象、null、小数、越界、
 * 布尔或字符串）一律抛 TypeError，由服务层映射为 INVALID_INPUT。
 * 未知字段直接丢弃，不会进入返回值。
 */
export function normalizeRoomPacing(value: unknown): RoomPacing {
  if (value === undefined) return createDefaultRoomPacing();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${INVALID_ROOM_PACING_MESSAGE}：配置必须是对象`);
  }
  const raw = (value as Record<string, unknown>).resultHoldSeconds;
  if (raw === undefined) throw new TypeError(`${INVALID_ROOM_PACING_MESSAGE}：缺少 resultHoldSeconds`);
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new TypeError(`${INVALID_ROOM_PACING_MESSAGE}：必须是整数`);
  }
  if (raw < MIN_RESULT_HOLD_SECONDS || raw > MAX_RESULT_HOLD_SECONDS) {
    throw new TypeError(`${INVALID_ROOM_PACING_MESSAGE}：超出范围`);
  }
  return { resultHoldSeconds: raw };
}

/** 两份已归一化节奏是否完全一致（决定改节奏是否算“实际变化”）。 */
export function sameRoomPacing(a: RoomPacing, b: RoomPacing): boolean {
  return a.resultHoldSeconds === b.resultHoldSeconds;
}

/**
 * 本次结果需要展示的时长：
 *  - 正常投掷：投掷动画 + 配置的阅读时间；
 *  - 超时跳过：只算配置的阅读时间（没有动画，0 秒表示可以立即推进）。
 */
export function presentationDurationMs(reason: RollRecord['reason'], pacing: RoomPacing): number {
  const holdMs = pacing.resultHoldSeconds * 1000;
  return reason === 'rolled' ? DICE_REVEAL_MS + holdMs : holdMs;
}
