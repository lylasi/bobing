/**
 * 纯规则函数与规则显示元数据（线上统一房规 v1）。
 *
 * 本文件不得引入 Node 或浏览器专有 API，前后端共用。
 * 判定顺序、rankKey 与奖池数量全部来自 docs/rules-research.md 第 4 节的冻结表格，
 * 页面文案由 RULES_RESULT_ROWS / RULES_TEXT 提供，避免同一份规则出现第二种实现。
 */

import type { DiceResult, PrizeKey, RankKey, ResultCode } from './types.js';

export const RULES_VERSION = 'unified-v1' as const;
export const RULES_NAME = '线上统一房规 v1' as const;

export const DICE_COUNT = 6;
export const DICE_FACES = 6;

/** 每人每次机会 30 秒。 */
export const TURN_DURATION_MS = 30_000;
/** 房主离线 60 秒后自动转交（有在线成员时）。 */
export const HOST_TRANSFER_MS = 60_000;
/** 全员离线或进入等待／结算／关闭状态后保留 24 小时；活跃对局不受创建时间限制。 */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 12;
export const DEFAULT_MAX_PLAYERS = 8;
export const ROUND_OPTIONS = [5, 10, 20] as const;
export const DEFAULT_MAX_ROUNDS = 10;
export type RoundOption = (typeof ROUND_OPTIONS)[number];

/** 近期记录窗口：最多保留 240 条（12 人 × 20 轮的历史容量）。累计统计独立保存，不由截断后的记录倒算。 */
export const MAX_HISTORY = 240;

export const ROOM_CODE_LENGTH = 6;
/** 去掉容易读错的 I、O、0、1。 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const NICKNAME_MIN_LENGTH = 1;
export const NICKNAME_MAX_LENGTH = 12;
export const ROOM_NAME_MIN_LENGTH = 1;
export const ROOM_NAME_MAX_LENGTH = 24;
export const DEFAULT_ROOM_NAME = '中秋团圆局';

export const PRIZE_KEYS: readonly PrizeKey[] = ['zhuangyuan', 'duitang', 'sanhong', 'sijin', 'erju', 'yixiu'];
/** 五类普通奖，状元单独保留。 */
export const NORMAL_PRIZE_KEYS: readonly PrizeKey[] = ['duitang', 'sanhong', 'sijin', 'erju', 'yixiu'];

export interface PrizeMeta {
  key: PrizeKey;
  label: string;
  /** 传统每会数量。 */
  count: number;
  description: string;
}

/**
 * 六档默认份数（合计 63 份）。
 *
 * 这是“默认数量”的唯一数据来源：PRIZE_META.count 与 INITIAL_POOL 都从这里派生，
 * 避免规则页、旧默认奖池与配置默认值三处各自漂移。房间实际数量来自本局 RoomConfig。
 */
export const DEFAULT_PRIZE_COUNTS: Readonly<Record<PrizeKey, number>> = {
  zhuangyuan: 1,
  duitang: 2,
  sanhong: 4,
  sijin: 8,
  erju: 16,
  yixiu: 32,
};

export const PRIZE_META: Readonly<Record<PrizeKey, PrizeMeta>> = {
  zhuangyuan: {
    key: 'zhuangyuan',
    label: '状元',
    count: DEFAULT_PRIZE_COUNTS.zhuangyuan,
    description: '最高牌型，唯一状元在整局结束时获得该档全部份数',
  },
  duitang: { key: 'duitang', label: '对堂', count: DEFAULT_PRIZE_COUNTS.duitang, description: '六个点数各不相同' },
  sanhong: { key: 'sanhong', label: '三红', count: DEFAULT_PRIZE_COUNTS.sanhong, description: '恰好三个四点' },
  sijin: { key: 'sijin', label: '四进', count: DEFAULT_PRIZE_COUNTS.sijin, description: '恰好四个相同的非四点' },
  erju: { key: 'erju', label: '二举', count: DEFAULT_PRIZE_COUNTS.erju, description: '恰好两个四点' },
  yixiu: { key: 'yixiu', label: '一秀', count: DEFAULT_PRIZE_COUNTS.yixiu, description: '恰好一个四点' },
};

/** V1 默认初始奖池：合计 63 份，其中状元 1 份单独保留。新房间请使用 poolFromConfig(config)。 */
export const INITIAL_POOL: Readonly<Record<PrizeKey, number>> = { ...DEFAULT_PRIZE_COUNTS };

export interface ResultRow {
  code: ResultCode;
  label: string;
  /** 精确条件，用于规则页表格。 */
  condition: string;
  /** rankKey 说明。 */
  rankNote: string;
  prize: PrizeKey | null;
  /** 判定顺序，1 为最高。 */
  order: number;
  /** 规则页示例骰子。 */
  example: number[];
}

/**
 * 判定表：从上到下匹配且只匹配一项。
 * 顺序即优先级，不可调整（例如插金花必须排在四红之前）。
 */
export const RULES_RESULT_ROWS: readonly ResultRow[] = [
  {
    code: 'chajinhua',
    label: '状元插金花',
    condition: '恰好四个4、两个1',
    rankNote: '[12,0,0]',
    prize: 'zhuangyuan',
    order: 1,
    example: [4, 4, 4, 4, 1, 1],
  },
  {
    code: 'liuhong',
    label: '六杯红',
    condition: '六个4',
    rankNote: '[11,0,0]',
    prize: 'zhuangyuan',
    order: 2,
    example: [4, 4, 4, 4, 4, 4],
  },
  {
    code: 'biandijin',
    label: '遍地锦',
    condition: '六个1',
    rankNote: '[10,0,0]',
    prize: 'zhuangyuan',
    order: 3,
    example: [1, 1, 1, 1, 1, 1],
  },
  {
    code: 'liuhe',
    label: '六杯黑',
    condition: '六个相同的2/3/5/6',
    rankNote: '[9,相同点数,0]',
    prize: 'zhuangyuan',
    order: 4,
    example: [6, 6, 6, 6, 6, 6],
  },
  {
    code: 'wuhong',
    label: '五红',
    condition: '恰好五个4',
    rankNote: '[8,剩余点数,0]',
    prize: 'zhuangyuan',
    order: 5,
    example: [4, 4, 4, 4, 4, 6],
  },
  {
    code: 'wuzi',
    label: '五子登科',
    condition: '恰好五个相同的非4点数',
    rankNote: '[7,相同点数,剩余点数]',
    prize: 'zhuangyuan',
    order: 6,
    example: [2, 2, 2, 2, 2, 4],
  },
  {
    code: 'sihong',
    label: '四红状元',
    condition: '恰好四个4且不是插金花',
    rankNote: '[6,另外两颗之和,0]',
    prize: 'zhuangyuan',
    order: 7,
    example: [4, 4, 4, 4, 2, 6],
  },
  {
    code: 'duitang',
    label: '对堂',
    condition: '六个点数各不相同',
    rankNote: '[5,0,0]',
    prize: 'duitang',
    order: 8,
    example: [1, 2, 3, 4, 5, 6],
  },
  {
    code: 'sanhong',
    label: '三红',
    condition: '恰好三个4',
    rankNote: '[4,0,0]',
    prize: 'sanhong',
    order: 9,
    example: [4, 4, 4, 2, 2, 2],
  },
  {
    code: 'sijin',
    label: '四进',
    condition: '恰好四个相同的非4点数',
    rankNote: '[3,0,0]',
    prize: 'sijin',
    order: 10,
    example: [2, 2, 2, 2, 4, 4],
  },
  {
    code: 'erju',
    label: '二举',
    condition: '恰好两个4',
    rankNote: '[2,0,0]',
    prize: 'erju',
    order: 11,
    example: [4, 4, 1, 2, 3, 5],
  },
  {
    code: 'yixiu',
    label: '一秀',
    condition: '恰好一个4',
    rankNote: '[1,0,0]',
    prize: 'yixiu',
    order: 12,
    example: [4, 1, 2, 3, 5, 5],
  },
  {
    code: 'none',
    label: '谢谢参与',
    condition: '不符合以上任一条件',
    rankNote: '[0,0,0]',
    prize: null,
    order: 13,
    example: [1, 1, 2, 2, 3, 3],
  },
];

const RESULT_META_BY_CODE: Readonly<Record<ResultCode, ResultRow>> = RULES_RESULT_ROWS.reduce(
  (acc, row) => {
    acc[row.code] = row;
    return acc;
  },
  {} as Record<ResultCode, ResultRow>,
);

/** 非法骰子输入的错误信息（长度不是 6、或不是 1–6 的整数）。 */
export const INVALID_DICE_MESSAGE = '骰子必须是6个1–6的整数';

function countDice(dice: readonly number[]): Int32Array {
  if (!Array.isArray(dice) || dice.length !== DICE_COUNT) {
    throw new TypeError(INVALID_DICE_MESSAGE);
  }
  const counts = new Int32Array(DICE_FACES + 1);
  for (const value of dice) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > DICE_FACES) {
      throw new TypeError(INVALID_DICE_MESSAGE);
    }
    counts[value] += 1;
  }
  return counts;
}

function valueWithCount(counts: Int32Array, n: number): number | null {
  for (let face = 1; face <= DICE_FACES; face++) {
    if (counts[face] === n) return face;
  }
  return null;
}

function buildResult(code: ResultCode, rankKey: RankKey): DiceResult {
  const row = RESULT_META_BY_CODE[code];
  return { code: row.code, label: row.label, prize: row.prize, rankKey };
}

/**
 * 判定一次投掷结果。输入不被修改，返回全新对象。
 * 判定顺序严格按 RULES_RESULT_ROWS，从上到下只取最高牌型。
 */
export function evaluateDice(dice: readonly number[]): DiceResult {
  const counts = countDice(dice);
  const fours = counts[4];
  const sixes = valueWithCount(counts, 6);
  const fives = valueWithCount(counts, 5);
  const quads = valueWithCount(counts, 4);

  // 1. 状元插金花：恰好四个4、两个1
  if (fours === 4 && counts[1] === 2) return buildResult('chajinhua', [12, 0, 0]);
  // 2. 六杯红：六个4
  if (sixes === 4) return buildResult('liuhong', [11, 0, 0]);
  // 3. 遍地锦：六个1
  if (sixes === 1) return buildResult('biandijin', [10, 0, 0]);
  // 4. 六杯黑：六个相同的2/3/5/6
  if (sixes !== null) return buildResult('liuhe', [9, sixes, 0]);
  // 5. 五红：恰好五个4
  if (fives === 4) return buildResult('wuhong', [8, otherValue(counts, 4), 0]);
  // 6. 五子登科：恰好五个相同的非4点数
  if (fives !== null) return buildResult('wuzi', [7, fives, otherValue(counts, fives)]);
  // 7. 四红状元：恰好四个4且不是插金花
  if (fours === 4) return buildResult('sihong', [6, sumOfOthers(counts, 4), 0]);
  // 8. 对堂：六个点数各不相同
  if (allDistinct(counts)) return buildResult('duitang', [5, 0, 0]);
  // 9. 三红：恰好三个4
  if (fours === 3) return buildResult('sanhong', [4, 0, 0]);
  // 10. 四进：恰好四个相同的非4点数
  if (quads !== null && quads !== 4) return buildResult('sijin', [3, 0, 0]);
  // 11. 二举：恰好两个4
  if (fours === 2) return buildResult('erju', [2, 0, 0]);
  // 12. 一秀：恰好一个4
  if (fours === 1) return buildResult('yixiu', [1, 0, 0]);
  // 13. 谢谢参与
  return buildResult('none', [0, 0, 0]);
}

/** 除 `value` 之外剩下那一颗骰子的点数（恰有五颗相同时使用）。 */
function otherValue(counts: Int32Array, value: number): number {
  for (let face = 1; face <= DICE_FACES; face++) {
    if (face !== value && counts[face] > 0) return face;
  }
  return 0;
}

/** 除 `value` 之外其余骰子的点数之和（恰有四颗相同时使用）。 */
function sumOfOthers(counts: Int32Array, value: number): number {
  let sum = 0;
  for (let face = 1; face <= DICE_FACES; face++) {
    if (face !== value) sum += face * counts[face];
  }
  return sum;
}

function allDistinct(counts: Int32Array): boolean {
  for (let face = 1; face <= DICE_FACES; face++) {
    if (counts[face] > 1) return false;
  }
  return true;
}

/** 三项字典序比较；只比较同一种比较键，不按骰子总和比较不同牌型。 */
export function compareRank(a: RankKey, b: RankKey): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    const left = a[i];
    const right = b[i];
    if (left > right) return 1;
    if (left < right) return -1;
  }
  return 0;
}

/** a 是否严格优于 b。同分返回 false（同分先到先得，保留既有领先者）。 */
export function isBetterRank(a: RankKey, b: RankKey): boolean {
  return compareRank(a, b) > 0;
}

export function isPrizeKey(value: unknown): value is PrizeKey {
  return typeof value === 'string' && (PRIZE_KEYS as readonly string[]).includes(value);
}

export function emptyAwards(): Record<PrizeKey, number> {
  return { zhuangyuan: 0, duitang: 0, sanhong: 0, sijin: 0, erju: 0, yixiu: 0 };
}

/** 旧默认奖池的独立副本（V1 兼容）。配置化房间请用 room-config 的 poolFromConfig。 */
export function clonePool(): Record<PrizeKey, number> {
  return { ...INITIAL_POOL };
}

export function prizeLabel(key: PrizeKey): string {
  return PRIZE_META[key].label;
}

export function resultRow(code: ResultCode): ResultRow {
  return RESULT_META_BY_CODE[code];
}

export function totalPrizeCount(): number {
  return PRIZE_KEYS.reduce((sum, key) => sum + PRIZE_META[key].count, 0);
}

/** 规则页与房间内规则弹层共用的文案数据。 */
export const RULES_TEXT = {
  version: RULES_VERSION,
  name: RULES_NAME,
  turnSeconds: TURN_DURATION_MS / 1000,
  hostTransferSeconds: HOST_TRANSFER_MS / 1000,
  roomTtlHours: ROOM_TTL_MS / 3_600_000,
  roundOptions: ROUND_OPTIONS,
  points: [
    '每人轮流投六颗骰子，按点数组合判奖，四点（红四点）是判定红点数量的依据。',
    '一次投掷只判最高牌型，不兼得、不追缴：四进带四点不兼得一秀或二举，插金花不额外领对堂，六红不清空奖池。',
    '普通奖先到先得：库存大于 0 才发奖，领完显示“博得该奖，奖品已领完”，不降级、不补发。',
    '持续顶状元方案中，更强的状元成绩可替换当前领先者，同分先到先得；高阶锁定方案中，首次出现五红、六黑、遍地锦、六红或插金花即锁定得主，锁定不提前结束整局。',
    '状元只有一位，整局结算时获得状元档配置的全部份数；固定轮数局达到上限仍无人博得状元时，该档奖品保留为未发放。',
    `每次机会 ${TURN_DURATION_MS / 1000} 秒，超时记为“超时跳过”，不掷骰、不发奖，并消耗一次机会。`,
    '开局时服务端随机决定起始玩家，之后按入座顺序循环；开局后不再加入新玩家。',
    '默认奖品发完结束、不限轮数：五档普通奖全部领完且已有状元候选后，完成当前整轮再结算；持续顶状元方案中，本轮余下玩家仍可顶替领先者。',
    '收尾只完成当前整轮；普通奖已空但没有状元时，无限轮数局继续等待状元，固定轮数局仍受所选的轮数上限约束。',
    '开局需至少两位在线且已准备的玩家；开局后只剩一位在席玩家仍可继续。',
    '全员掉线时暂停倒计时，从本次全员离线起保留 24 小时；有人重连则取消过期计时、恢复剩余时间。刷新页面不丢身份、不重新掷骰。',
    '战绩列表按状元拥有者优先、普通奖总数降序、入座顺序升序排列，不引入积分或金钱。',
  ],
  variants: '各地博饼习惯有差异，本游戏提供“持续顶状元”和“高阶锁定”两种系统方案，具体以本房间所选方案为准。',
  sources: [
    { label: '维基百科《中秋博饼》', url: 'https://zh.wikipedia.org/zh-cn/中秋博饼' },
    { label: '厦门本地宝《2026厦门中秋博饼专题·规则与活动汇总》', url: 'https://xm.bendibao.com/xiuxian/xiamenbobingtopic/' },
  ],
} as const;
