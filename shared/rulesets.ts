/**
 * 系统房规注册表（由开发者维护，玩家只能选择，不能提交自定义判奖逻辑）。
 *
 * 两种房规的差别只在状元策略，判奖基础函数共用 shared/rules.ts 的 unified-v1：
 * - continuous（持续顶状元，默认）：收尾结束前，严格更大的状元成绩替换领先者；同分先到先得。
 * - high-tier-lock（高阶锁定）：首次出现五红／六黑／遍地锦／六红／插金花即锁定唯一得主。
 *   锁定只确定状元归属，不让整局提前结束；四红、五子登科阶段仍允许争夺。
 *
 * 本文件不引入 Node 或浏览器专有 API。预设记录整体冻结，防止调用方意外修改共享状态；
 * 对外只通过 snapshotRuleset 提供深拷贝，房间保存的快照因此不会影响其他房间或后续开局。
 */

import type { DiceResult, ResultCode, RulesetId, RulesetSnapshot } from './types.js';

/** 未知房规 ID 的错误信息。 */
export const UNKNOWN_RULESET_MESSAGE = '未知系统房规';

/** 高阶锁定版触发锁定的牌型（顺序无关，仅用于说明与查询）。 */
const HIGH_TIER_LOCK_CODES: readonly ResultCode[] = Object.freeze([
  'wuhong',
  'liuhe',
  'biandijin',
  'liuhong',
  'chajinhua',
]);

/** 系统房规预设：只读且冻结，调用方只能读取，不能就地修改。 */
export const RULESETS: Readonly<Record<RulesetId, RulesetSnapshot>> = Object.freeze({
  continuous: Object.freeze<RulesetSnapshot>({
    id: 'continuous',
    version: 1,
    name: '持续顶状元',
    diceRulesVersion: 'unified-v1',
    championPolicy: 'competitive',
    lockCodes: Object.freeze<ResultCode[]>([]),
  }),
  'high-tier-lock': Object.freeze<RulesetSnapshot>({
    id: 'high-tier-lock',
    version: 1,
    name: '高阶锁定',
    diceRulesVersion: 'unified-v1',
    championPolicy: 'lock-high-tier',
    lockCodes: HIGH_TIER_LOCK_CODES,
  }),
});

/** 全部系统房规 ID，供校验与页面选择器使用。 */
export const RULESET_IDS: readonly RulesetId[] = Object.freeze(
  Object.keys(RULESETS) as RulesetId[],
);

/** 外部输入（请求体、本机模板、旧数据）里的房规 ID 是否合法。 */
export function isRulesetId(value: unknown): value is RulesetId {
  return typeof value === 'string' && (RULESET_IDS as readonly string[]).includes(value);
}

/**
 * 取某个系统房规的独立深拷贝，用于写入房间快照。
 * 传入未注册的 ID（例如请求伪造的预设名）直接抛错，不返回空快照。
 */
export function snapshotRuleset(id: RulesetId): RulesetSnapshot {
  if (!isRulesetId(id)) throw new TypeError(UNKNOWN_RULESET_MESSAGE);
  return structuredClone(RULESETS[id]);
}

/**
 * 该次投掷是否触发状元锁定。只有高阶锁定版、且牌型在其锁定列表内才为 true；
 * 持续版永远为 false（继续按成绩争夺）。
 */
export function shouldLockChampion(ruleset: RulesetSnapshot, result: DiceResult): boolean {
  if (ruleset.championPolicy !== 'lock-high-tier') return false;
  const lockCodes = ruleset.lockCodes;
  return Array.isArray(lockCodes) && lockCodes.includes(result.code);
}
