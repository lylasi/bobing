/**
 * 房间配置：默认值、严格校验与初始奖池生成。
 *
 * 这里是外部输入（创建请求、等待室改配置、本机个人方案、旧数据迁移）进入业务层的唯一入口：
 * - normalizeRoomConfig 只信任允许的字段，逐项校验并返回全新深拷贝；非法配置抛错，
 *   由服务层统一映射为 INVALID_INPUT。不静默补齐半份配置。
 * - 请求传入的规则快照、锁定列表、比较键一律丢弃，房规只能由 rulesetId 在注册表中选择。
 * - 默认数量与 PRIZE_META／INITIAL_POOL 同源（shared/rules.ts 的 DEFAULT_PRIZE_COUNTS）。
 *
 * 本文件不引入 Node 或浏览器专有 API。
 */

import { DEFAULT_PRIZE_COUNTS, PRIZE_KEYS, ROUND_OPTIONS } from './rules.js';
import { isRulesetId, UNKNOWN_RULESET_MESSAGE } from './rulesets.js';
import type { EndCondition, PrizeConfig, PrizeKey, RoomConfig } from './types.js';

/** 配置非法时的统一前缀；服务层据此映射到 INVALID_INPUT。 */
export const INVALID_ROOM_CONFIG_MESSAGE = '房间配置不合法';

/** 六档默认份数合计 63；默认房规为持续顶状元，默认结束方式为奖品发完结束。 */
export function createDefaultRoomConfig(): RoomConfig {
  const prizes = {} as PrizeConfig;
  for (const key of PRIZE_KEYS) {
    prizes[key] = { count: DEFAULT_PRIZE_COUNTS[key], content: '' };
  }
  return {
    rulesetId: 'continuous',
    endCondition: { mode: 'all-prizes' },
    prizes,
  };
}

/**
 * 严格校验外部配置。合法则返回只含 rulesetId／endCondition／prizes 的深拷贝（content 去首尾空格），
 * 非法则抛 TypeError。未知字段与未知档位直接丢弃，不会进入返回值。
 */
export function normalizeRoomConfig(input: unknown): RoomConfig {
  if (!isConfigObject(input)) invalid('配置必须是对象');
  const rulesetId = input.rulesetId;
  if (!isRulesetId(rulesetId)) invalid(UNKNOWN_RULESET_MESSAGE);
  return {
    rulesetId,
    endCondition: normalizeEndCondition(input.endCondition),
    prizes: normalizePrizes(input.prizes),
  };
}

/** 按本局 prizes 的 count 生成独立初始奖池；只读取 count，不做任何合并或补齐。 */
export function poolFromConfig(config: RoomConfig): Record<PrizeKey, number> {
  const pool = {} as Record<PrizeKey, number>;
  for (const key of PRIZE_KEYS) {
    const count = config?.prizes?.[key]?.count;
    if (!isPositiveSafeInteger(count)) invalid(`${key} 的份数不合法`);
    pool[key] = count;
  }
  return pool;
}

function normalizeEndCondition(input: unknown): EndCondition {
  if (!isConfigObject(input)) invalid('结束方式必须是对象');
  if (input.mode === 'all-prizes') return { mode: 'all-prizes' };
  if (input.mode === 'rounds') {
    const maxRounds = input.maxRounds;
    if (typeof maxRounds !== 'number' || !(ROUND_OPTIONS as readonly number[]).includes(maxRounds)) {
      invalid('固定轮数只能是 5、10 或 20');
    }
    return { mode: 'rounds', maxRounds: maxRounds as 5 | 10 | 20 };
  }
  invalid('未知结束方式');
}

function normalizePrizes(input: unknown): PrizeConfig {
  if (!isConfigObject(input)) invalid('奖品配置必须是对象');
  const prizes = {} as PrizeConfig;
  let total = 0;
  for (const key of PRIZE_KEYS) {
    const entry = input[key];
    if (!isConfigObject(entry)) invalid(`缺少 ${key} 档配置`);
    const count = entry.count;
    if (!isPositiveSafeInteger(count)) invalid(`${key} 的份数必须是至少 1 的安全整数`);
    const content = entry.content;
    if (typeof content !== 'string') invalid(`${key} 的奖品内容必须是字符串`);
    total += count;
    if (!Number.isSafeInteger(total)) invalid('六档份数合计超出安全整数范围');
    prizes[key] = { count, content: content.trim() };
  }
  return prizes;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(detail: string): never {
  throw new TypeError(`${INVALID_ROOM_CONFIG_MESSAGE}：${detail}`);
}
