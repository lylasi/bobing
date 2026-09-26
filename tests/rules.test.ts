import { describe, expect, it } from 'vitest';
import {
  DICE_FACES,
  INITIAL_POOL,
  NORMAL_PRIZE_KEYS,
  PRIZE_KEYS,
  PRIZE_META,
  RULES_RESULT_ROWS,
  compareRank,
  emptyAwards,
  evaluateDice,
  isBetterRank,
  resultRow,
  totalPrizeCount,
} from '../shared/rules.js';
import type { RankKey, ResultCode } from '../shared/types.js';

/** docs/rules-research.md 第 5 节判定验收样例。 */
const ACCEPTANCE_SAMPLES: ReadonlyArray<readonly [number[], ResultCode]> = [
  [[4, 4, 4, 4, 1, 1], 'chajinhua'],
  [[4, 4, 4, 4, 4, 4], 'liuhong'],
  [[1, 1, 1, 1, 1, 1], 'biandijin'],
  [[6, 6, 6, 6, 6, 6], 'liuhe'],
  [[4, 4, 4, 4, 4, 6], 'wuhong'],
  [[2, 2, 2, 2, 2, 4], 'wuzi'],
  [[4, 4, 4, 4, 2, 6], 'sihong'],
  [[1, 2, 3, 4, 5, 6], 'duitang'],
  [[4, 4, 4, 2, 2, 2], 'sanhong'],
  [[2, 2, 2, 2, 4, 4], 'sijin'],
  [[4, 4, 1, 2, 3, 5], 'erju'],
  [[4, 1, 2, 3, 5, 5], 'yixiu'],
  [[1, 1, 2, 2, 3, 3], 'none'],
];

/** 判定优先级（与 docs/rules-research.md 4.1 表格自上而下一致）。 */
const EXPECTED_ORDER: readonly ResultCode[] = [
  'chajinhua',
  'liuhong',
  'biandijin',
  'liuhe',
  'wuhong',
  'wuzi',
  'sihong',
  'duitang',
  'sanhong',
  'sijin',
  'erju',
  'yixiu',
  'none',
];

/** docs/acceptance-matrix.md 的独立枚举结果（6^6 = 46656 种有序组合）。 */
const EXPECTED_COUNTS: Readonly<Record<ResultCode, number>> = {
  chajinhua: 15,
  liuhong: 1,
  biandijin: 1,
  liuhe: 4,
  wuhong: 30,
  wuzi: 150,
  sihong: 360,
  duitang: 720,
  sanhong: 2500,
  sijin: 1875,
  erju: 9300,
  yixiu: 17400,
  none: 14300,
};

/** 每个结果代码对应的 rankKey 首位。 */
const RANK_HEAD: Readonly<Record<ResultCode, number>> = {
  chajinhua: 12,
  liuhong: 11,
  biandijin: 10,
  liuhe: 9,
  wuhong: 8,
  wuzi: 7,
  sihong: 6,
  duitang: 5,
  sanhong: 4,
  sijin: 3,
  erju: 2,
  yixiu: 1,
  none: 0,
};

/** 状元候选牌型：rankKey 首位 >= 6。 */
const CHAMPION_CODES: readonly ResultCode[] = ['chajinhua', 'liuhong', 'biandijin', 'liuhe', 'wuhong', 'wuzi', 'sihong'];

/**
 * 测试侧独立实现：用 Map + 迭代器统计频次并按文档优先级匹配，
 * 与 shared/rules.ts（定长计数数组 + 局部变量）写法不同，用于交叉验证判定顺序。
 */
function referenceCode(dice: readonly number[]): ResultCode {
  const freq = new Map<number, number>();
  for (const die of dice) freq.set(die, (freq.get(die) ?? 0) + 1);
  const at = (face: number): number => freq.get(face) ?? 0;
  const faceWith = (n: number): number | null => {
    for (const [face, count] of freq) if (count === n) return face;
    return null;
  };
  const six = faceWith(6);
  const five = faceWith(5);
  const four = faceWith(4);
  const fours = at(4);

  if (fours === 4 && at(1) === 2) return 'chajinhua';
  if (six === 4) return 'liuhong';
  if (six === 1) return 'biandijin';
  if (six !== null) return 'liuhe';
  if (five === 4) return 'wuhong';
  if (five !== null) return 'wuzi';
  if (fours === 4) return 'sihong';
  if ([...freq.values()].every((count) => count === 1)) return 'duitang';
  if (fours === 3) return 'sanhong';
  if (four !== null) return 'sijin';
  if (fours === 2) return 'erju';
  if (fours === 1) return 'yixiu';
  return 'none';
}

function allCombinations(): number[][] {
  const all: number[][] = [];
  for (let n = 0; n < DICE_FACES ** 6; n++) {
    let value = n;
    const dice = Array.from({ length: 6 }, () => {
      const face = (value % DICE_FACES) + 1;
      value = Math.floor(value / DICE_FACES);
      return face;
    });
    all.push(dice);
  }
  return all;
}

function choose(n: number, r: number): number {
  let value = 1;
  for (let i = 0; i < r; i++) value = (value * (n - i)) / (i + 1);
  return Math.round(value);
}

const ALL_COMBOS = allCombinations();
const CODE_COUNTS: ReadonlyMap<ResultCode, number> = (() => {
  const counts = new Map<ResultCode, number>();
  for (const dice of ALL_COMBOS) {
    const code = evaluateDice(dice).code;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
})();

describe('evaluateDice 验收样例', () => {
  it.each(ACCEPTANCE_SAMPLES)('%j -> %s', (dice, code) => {
    expect(evaluateDice(dice).code).toBe(code);
  });

  it('样例中的“不能先命中低奖”项逐条复核', () => {
    expect(evaluateDice([4, 4, 4, 4, 1, 1]).code).not.toBe('sihong');
    expect(evaluateDice([4, 4, 4, 4, 4, 4]).code).not.toBe('wuhong');
    expect(evaluateDice([2, 2, 2, 2, 2, 4]).code).not.toBe('yixiu');
    expect(evaluateDice([2, 2, 2, 2, 2, 4]).code).not.toBe('erju');
    expect(evaluateDice([1, 2, 3, 4, 5, 6]).code).not.toBe('yixiu');
    expect(evaluateDice([2, 2, 2, 2, 4, 4]).code).not.toBe('erju');
    expect(evaluateDice([4, 4, 4, 4, 2, 6]).code).not.toBe('erju');
    expect(evaluateDice([4, 4, 4, 4, 2, 6]).code).not.toBe('yixiu');
    expect(evaluateDice([4, 4, 4, 2, 2, 2]).code).not.toBe('yixiu');
  });

  it('rankKey 与冻结表格一致', () => {
    expect(evaluateDice([4, 4, 4, 4, 1, 1]).rankKey).toEqual([12, 0, 0]);
    expect(evaluateDice([4, 4, 4, 4, 4, 4]).rankKey).toEqual([11, 0, 0]);
    expect(evaluateDice([1, 1, 1, 1, 1, 1]).rankKey).toEqual([10, 0, 0]);
    expect(evaluateDice([6, 6, 6, 6, 6, 6]).rankKey).toEqual([9, 6, 0]);
    expect(evaluateDice([4, 4, 4, 4, 4, 6]).rankKey).toEqual([8, 6, 0]);
    expect(evaluateDice([2, 2, 2, 2, 2, 4]).rankKey).toEqual([7, 2, 4]);
    expect(evaluateDice([4, 4, 4, 4, 2, 6]).rankKey).toEqual([6, 8, 0]);
    expect(evaluateDice([1, 2, 3, 4, 5, 6]).rankKey).toEqual([5, 0, 0]);
    expect(evaluateDice([4, 4, 4, 2, 2, 2]).rankKey).toEqual([4, 0, 0]);
    expect(evaluateDice([2, 2, 2, 2, 4, 4]).rankKey).toEqual([3, 0, 0]);
    expect(evaluateDice([4, 4, 1, 2, 3, 5]).rankKey).toEqual([2, 0, 0]);
    expect(evaluateDice([4, 1, 2, 3, 5, 5]).rankKey).toEqual([1, 0, 0]);
    expect(evaluateDice([1, 1, 2, 2, 3, 3]).rankKey).toEqual([0, 0, 0]);
  });

  it('label 与 prize 来自同一份元数据', () => {
    for (const row of RULES_RESULT_ROWS) {
      const result = evaluateDice(row.example);
      expect(result.code).toBe(row.code);
      expect(result.label).toBe(row.label);
      expect(result.prize).toBe(row.prize);
      expect(resultRow(row.code)).toBe(row);
    }
  });
});

describe('evaluateDice 非法输入', () => {
  const invalid: unknown[] = [
    [],
    [1, 2, 3, 4, 5],
    [1, 2, 3, 4, 5, 6, 1],
    [0, 1, 2, 3, 4, 5],
    [1, 2, 3, 4, 5, 7],
    [1, 2, 3, 4, 5, 1.5],
    [1, 2, 3, 4, 5, Number.NaN],
    [1, 2, 3, 4, 5, Number.POSITIVE_INFINITY],
    [1, 2, 3, 4, 5, '6'],
    [1, 2, 3, 4, 5, null],
    '123456',
    null,
    undefined,
    {},
  ];

  it.each(invalid)('拒绝 %j', (dice) => {
    expect(() => evaluateDice(dice as number[])).toThrow(TypeError);
  });
});

describe('evaluateDice 穷举 46656 种组合', () => {
  it('每个组合都能被判奖且与独立实现一致', () => {
    expect(ALL_COMBOS).toHaveLength(46_656);
    const seen = new Set<ResultCode>();

    for (const dice of ALL_COMBOS) {
      const snapshot = [...dice];
      const result = evaluateDice(dice);

      // 输入不被修改
      expect(dice).toEqual(snapshot);
      // 排列不影响判定
      expect(evaluateDice([...dice].reverse())).toEqual(result);
      expect(evaluateDice([dice[5], dice[0], dice[3], dice[1], dice[4], dice[2]])).toEqual(result);
      // 与测试侧独立实现一致
      expect(result.code).toBe(referenceCode(dice));
      // label / prize 与该代码的元数据一致
      const row = resultRow(result.code);
      expect(result.label).toBe(row.label);
      expect(result.prize).toBe(row.prize);
      // rankKey 形状与首位
      expect(result.rankKey).toHaveLength(3);
      expect(Number.isInteger(result.rankKey[0])).toBe(true);
      expect(result.rankKey[0]).toBe(RANK_HEAD[result.code]);
      for (const part of result.rankKey) {
        expect(Number.isInteger(part)).toBe(true);
        expect(part).toBeGreaterThanOrEqual(0);
      }
      // 状元候选与 rankKey 首位 >= 6 互为充要
      expect(CHAMPION_CODES.includes(result.code)).toBe(result.rankKey[0] >= 6);
      // 返回全新对象，不被复用
      expect(evaluateDice(dice)).not.toBe(result);

      seen.add(result.code);
    }

    expect(seen.size).toBe(13);
    expect([...seen].sort()).toEqual([...EXPECTED_ORDER].sort());
  });

  it('13 类结果的有序组合数与验收矩阵逐项一致', () => {
    const actual: Record<string, number> = {};
    let total = 0;
    for (const [code, count] of CODE_COUNTS) {
      actual[code] = count;
      total += count;
    }
    expect(total).toBe(46_656);
    expect(actual).toEqual(EXPECTED_COUNTS);
  });

  it('状元牌型组合数同时符合独立封闭形式', () => {
    const at = (code: ResultCode): number => CODE_COUNTS.get(code) ?? 0;
    expect(at('chajinhua')).toBe(choose(6, 4)); // 恰好四个4、两个1 → 位置组合 C(6,4)=15
    expect(at('liuhong')).toBe(1);
    expect(at('biandijin')).toBe(1);
    expect(at('liuhe')).toBe(4); // 六杯黑为 2/3/5/6 四种
    expect(at('wuhong')).toBe(choose(6, 5) * 5); // 五颗4 + 剩余一颗 1/2/3/5/6
    expect(at('wuzi')).toBe(5 * choose(6, 5) * 5); // 五种非4点数 × 剩余位置 × 剩余点数（可为4）
    expect(at('sihong')).toBe(choose(6, 4) * 5 ** 2 - choose(6, 4)); // 恰好四个4 减去插金花
    expect(at('duitang')).toBe(720); // 6!
  });
});

describe('compareRank', () => {
  it('严格同分返回 0 而不是改写领先者', () => {
    expect(compareRank([6, 8, 0], [6, 8, 0])).toBe(0);
    expect(isBetterRank([6, 8, 0], [6, 8, 0])).toBe(false);
  });

  it('从左到右字典序比较', () => {
    expect(compareRank([12, 0, 0], [11, 0, 0])).toBe(1);
    expect(compareRank([11, 0, 0], [12, 0, 0])).toBe(-1);
    expect(compareRank([9, 6, 0], [9, 5, 0])).toBe(1);
    expect(compareRank([7, 2, 5], [7, 2, 4])).toBe(1);
    expect(compareRank([7, 2, 4], [7, 2, 5])).toBe(-1);
    expect(compareRank([0, 0, 0], [1, 0, 0])).toBe(-1);
  });

  it('R02：四红带 2+6 与四红带 3+5 同分，后到者不能替换', () => {
    expect(evaluateDice([4, 4, 4, 4, 2, 6]).rankKey).toEqual([6, 8, 0]);
    expect(evaluateDice([4, 4, 4, 4, 3, 5]).rankKey).toEqual([6, 8, 0]);
    expect(compareRank(evaluateDice([4, 4, 4, 4, 2, 6]).rankKey, evaluateDice([4, 4, 4, 4, 3, 5]).rankKey)).toBe(0);
  });

  it('R03：五子登科先比较相同点数，五个3带1胜五个2带6', () => {
    const lower = evaluateDice([2, 2, 2, 2, 2, 6]);
    const higher = evaluateDice([3, 3, 3, 3, 3, 1]);
    expect(lower.rankKey).toEqual([7, 2, 6]);
    expect(higher.rankKey).toEqual([7, 3, 1]);
    expect(isBetterRank(higher.rankKey, lower.rankKey)).toBe(true);
    expect(isBetterRank(lower.rankKey, higher.rankKey)).toBe(false);
  });

  it('反对称、自反与传递性', () => {
    const keys: RankKey[] = [];
    for (let a = 0; a <= 12; a++) for (let b = 0; b <= 6; b++) for (let c = 0; c <= 6; c += 2) keys.push([a, b, c]);

    for (const key of keys) expect(compareRank(key, key)).toBe(0);

    for (const a of keys) {
      for (const b of keys) {
        expect(compareRank(a, b) + compareRank(b, a)).toBe(0);
      }
    }

    let checked = 0;
    for (const a of keys) {
      const b = keys[(a[0] * 7 + a[1] * 3 + a[2]) % keys.length] as RankKey;
      const c = keys[(a[0] * 13 + a[1] * 5 + a[2] * 2) % keys.length] as RankKey;
      if (compareRank(a, b) >= 0 && compareRank(b, c) >= 0) {
        expect(compareRank(a, c)).toBeGreaterThanOrEqual(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('奖池与规则元数据', () => {
  it('奖池合计 63 份，其中状元 1 份、普通奖 62 份', () => {
    expect(totalPrizeCount()).toBe(63);
    expect(PRIZE_META.zhuangyuan.count).toBe(1);
    expect(NORMAL_PRIZE_KEYS.reduce((sum, key) => sum + PRIZE_META[key].count, 0)).toBe(62);
  });

  it('INITIAL_POOL 与文档数量一致', () => {
    expect(INITIAL_POOL).toEqual({ zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 32 });
    expect(PRIZE_KEYS.reduce((sum, key) => sum + INITIAL_POOL[key], 0)).toBe(63);
  });

  it('emptyAwards 覆盖全部六档且为 0', () => {
    const awards = emptyAwards();
    expect(Object.keys(awards).sort()).toEqual([...PRIZE_KEYS].sort());
    expect(PRIZE_KEYS.every((key) => awards[key] === 0)).toBe(true);
  });

  it('判定表严格按文档顺序，order 连续', () => {
    expect(RULES_RESULT_ROWS.map((row) => row.code)).toEqual([...EXPECTED_ORDER]);
    RULES_RESULT_ROWS.forEach((row, index) => {
      expect(row.order).toBe(index + 1);
      expect(row.rankNote).toMatch(/^\[/);
    });
  });
});
