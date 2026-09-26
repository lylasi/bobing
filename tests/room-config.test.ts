import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIZE_COUNTS, PRIZE_KEYS, evaluateDice } from '../shared/rules.js';
import { createDefaultRoomConfig, normalizeRoomConfig, poolFromConfig } from '../shared/room-config.js';
import {
  RULESETS,
  RULESET_IDS,
  UNKNOWN_RULESET_MESSAGE,
  isRulesetId,
  shouldLockChampion,
  snapshotRuleset,
} from '../shared/rulesets.js';
import type { PrizeKey, ResultCode, RulesetId } from '../shared/types.js';

/** 模拟真实外部输入：经过 JSON 序列化，可以自由加入未声明的字段。 */
function rawConfig(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(createDefaultRoomConfig())) as Record<string, unknown>;
}

function rawPrizes(config: Record<string, unknown>): Record<string, unknown> {
  return config.prizes as Record<string, unknown>;
}

/** 只改一档数量，其余保持默认。 */
function withCount(key: PrizeKey, count: unknown): Record<string, unknown> {
  const config = rawConfig();
  rawPrizes(config)[key] = { ...(rawPrizes(config)[key] as object), count };
  return config;
}

describe('可配置房规', () => {
  it('默认不限轮数且配置对象彼此独立', () => {
    const a = createDefaultRoomConfig();
    const b = createDefaultRoomConfig();
    expect(a.rulesetId).toBe('continuous');
    expect(a.endCondition).toEqual({ mode: 'all-prizes' });
    expect(poolFromConfig(a)).toEqual({
      zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 32,
    });
    a.prizes.yixiu.count = 7;
    expect(b.prizes.yixiu.count).toBe(32);
  });

  it('默认六档与 PRIZE_KEYS 一致、合计 63、内容为空', () => {
    const config = createDefaultRoomConfig();
    expect(Object.keys(config.prizes).sort()).toEqual([...PRIZE_KEYS].sort());
    expect(PRIZE_KEYS.reduce((sum, key) => sum + config.prizes[key].count, 0)).toBe(63);
    for (const key of PRIZE_KEYS) {
      expect(config.prizes[key].count).toBe(DEFAULT_PRIZE_COUNTS[key]);
      expect(config.prizes[key].content).toBe('');
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, '4', null, undefined, true, 2 ** 53])(
    '拒绝非法份数 %s',
    (count) => {
      expect(() => normalizeRoomConfig(withCount('yixiu', count))).toThrow();
    },
  );

  it('拒绝半份配置：缺档、非对象档位、缺 content、非字符串 content', () => {
    const missingTier = rawConfig();
    delete rawPrizes(missingTier).sijin;
    expect(() => normalizeRoomConfig(missingTier)).toThrow();

    const tierNotObject = rawConfig();
    rawPrizes(tierNotObject).sijin = 8;
    expect(() => normalizeRoomConfig(tierNotObject)).toThrow();

    const emptyPrizes = { ...createDefaultRoomConfig(), prizes: {} };
    expect(() => normalizeRoomConfig(emptyPrizes)).toThrow();

    const missingContent = rawConfig();
    rawPrizes(missingContent).erju = { count: 16 };
    expect(() => normalizeRoomConfig(missingContent)).toThrow();

    const numericContent = rawConfig();
    rawPrizes(numericContent).erju = { count: 16, content: 12 };
    expect(() => normalizeRoomConfig(numericContent)).toThrow();
  });

  it('拒绝合计超出安全整数范围', () => {
    const config = rawConfig();
    const prizes = rawPrizes(config);
    prizes.zhuangyuan = { count: Number.MAX_SAFE_INTEGER, content: '' };
    prizes.duitang = { count: Number.MAX_SAFE_INTEGER, content: '' };
    expect(() => normalizeRoomConfig(config)).toThrow();
  });

  it('拒绝非对象输入', () => {
    for (const input of [null, undefined, 'config', 42, true, [], [{}, {}, {}]]) {
      expect(() => normalizeRoomConfig(input)).toThrow();
    }
  });

  it('拒绝未知系统方案', () => {
    expect(() => normalizeRoomConfig({
      ...createDefaultRoomConfig(), rulesetId: 'custom-script',
    })).toThrow();
    expect(() => normalizeRoomConfig({
      ...createDefaultRoomConfig(), rulesetId: 'high-tier',
    })).toThrow();
  });

  it('结束方式是判别联合，固定轮数只允许 5／10／20', () => {
    for (const maxRounds of [5, 10, 20] as const) {
      const config = normalizeRoomConfig({
        ...createDefaultRoomConfig(), endCondition: { mode: 'rounds', maxRounds },
      });
      expect(config.endCondition).toEqual({ mode: 'rounds', maxRounds });
    }
    for (const bad of [{ mode: 'rounds' }, { mode: 'rounds', maxRounds: 7 }, { mode: 'rounds', maxRounds: '5' },
      { mode: 'rounds', maxRounds: 5.5 }, { mode: 'fresh' }, { mode: 'ALL-PRIZES' }, {}]) {
      expect(() => normalizeRoomConfig({ ...createDefaultRoomConfig(), endCondition: bad })).toThrow();
    }
  });

  it('奖品发完结束带多余 maxRounds 时按 all-prizes 处理并丢弃该字段', () => {
    const config = normalizeRoomConfig({
      ...createDefaultRoomConfig(), endCondition: { mode: 'all-prizes', maxRounds: 20 },
    });
    expect(config.endCondition).toEqual({ mode: 'all-prizes' });
  });

  it('只返回允许字段：未知字段与未知档位不污染返回值', () => {
    const config = rawConfig();
    config.ruleset = { id: 'high-tier-lock', lockCodes: ['sihong'], championPolicy: 'lock-high-tier' };
    config.lockCodes = ['sihong'];
    config.maxRounds = 20;
    config.rulesVersion = 'hacked';
    rawPrizes(config).yixiu = { count: 3, content: '月饼', extra: true, rankKey: [99, 99, 99] };
    rawPrizes(config).waibing = { count: 999, content: '伪造档位' };

    const normalized = normalizeRoomConfig(config);
    expect(normalized).toEqual({
      rulesetId: 'continuous',
      endCondition: { mode: 'all-prizes' },
      prizes: {
        zhuangyuan: { count: 1, content: '' },
        duitang: { count: 2, content: '' },
        sanhong: { count: 4, content: '' },
        sijin: { count: 8, content: '' },
        erju: { count: 16, content: '' },
        yixiu: { count: 3, content: '月饼' },
      },
    });
    expect(Object.keys(normalized)).toEqual(['rulesetId', 'endCondition', 'prizes']);
    expect(Object.keys(normalized.prizes).sort()).toEqual([...PRIZE_KEYS].sort());
    expect(snapshotRuleset(normalized.rulesetId).championPolicy).toBe('competitive');
  });

  it('不把 __proto__ 等原型键带入返回值，也不污染 Object.prototype', () => {
    const config = JSON.parse(
      '{"rulesetId":"continuous","endCondition":{"mode":"all-prizes"},'
      + '"prizes":{"zhuangyuan":{"count":1,"content":""},"duitang":{"count":2,"content":""},'
      + '"sanhong":{"count":4,"content":""},"sijin":{"count":8,"content":""},'
      + '"erju":{"count":16,"content":""},"yixiu":{"count":32,"content":""}},'
      + '"__proto__":{"polluted":true},"constructor":{"polluted":true}}',
    ) as Record<string, unknown>;

    const normalized = normalizeRoomConfig(config);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(normalized)).toEqual(['rulesetId', 'endCondition', 'prizes']);
  });

  it('content 去掉首尾空格并返回深拷贝，输入不被修改', () => {
    const config = rawConfig();
    rawPrizes(config).sanhong = { count: 5, content: '  三红礼盒  ' };
    const normalized = normalizeRoomConfig(config);
    expect(normalized.prizes.sanhong.content).toBe('三红礼盒');
    expect(normalized).not.toBe(config);
    expect(normalized.prizes).not.toBe(config.prizes);
    expect(normalized.prizes.sanhong).not.toBe(rawPrizes(config).sanhong);
    expect(normalized.endCondition).not.toBe(config.endCondition);

    // 修改输入不再影响已归一化的结果
    rawPrizes(config).sanhong = { count: 99, content: '改过' };
    expect(normalized.prizes.sanhong).toEqual({ count: 5, content: '三红礼盒' });

    // 修改结果不影响下一次归一化
    normalized.prizes.zhuangyuan.count = 42;
    expect(normalizeRoomConfig(config).prizes.zhuangyuan.count).toBe(1);
  });

  it('归一化后的配置可重复归一化且结果相同', () => {
    const config = normalizeRoomConfig({
      ...createDefaultRoomConfig(),
      rulesetId: 'high-tier-lock',
      endCondition: { mode: 'rounds', maxRounds: 20 },
    });
    expect(normalizeRoomConfig(config)).toEqual(config);
  });
});

describe('poolFromConfig 初始奖池', () => {
  it('按本局 count 生成，六个档位齐全且互相独立', () => {
    const config = createDefaultRoomConfig();
    config.prizes.yixiu = { count: 7, content: '月饼一盒' };
    const pool = poolFromConfig(config);
    expect(pool).toEqual({ ...DEFAULT_PRIZE_COUNTS, yixiu: 7 });
    expect(Object.keys(pool).sort()).toEqual([...PRIZE_KEYS].sort());

    pool.yixiu = 0;
    expect(poolFromConfig(config).yixiu).toBe(7);
  });

  it('拒绝被损坏的配置，不用剩余库存或默认值顶替', () => {
    const broken = { ...createDefaultRoomConfig(), prizes: { ...createDefaultRoomConfig().prizes } };
    broken.prizes.sijin = { count: 0, content: '' };
    expect(() => poolFromConfig(broken)).toThrow();
  });
});

describe('系统房规注册表', () => {
  it('只有两种方案、ID 与快照字段符合契约', () => {
    expect(RULESET_IDS).toEqual(['continuous', 'high-tier-lock']);
    expect(Object.keys(RULESETS).sort()).toEqual([...RULESET_IDS].sort());
    for (const id of RULESET_IDS) {
      const snapshot = RULESETS[id];
      expect(snapshot.id).toBe(id);
      expect(snapshot.version).toBe(1);
      expect(snapshot.diceRulesVersion).toBe('unified-v1');
      expect(typeof snapshot.name).toBe('string');
      expect(snapshot.name.length).toBeGreaterThan(0);
    }
    expect(RULESETS.continuous).toMatchObject({ championPolicy: 'competitive', lockCodes: [] });
    expect(RULESETS['high-tier-lock'].championPolicy).toBe('lock-high-tier');
    expect([...RULESETS['high-tier-lock'].lockCodes].sort()).toEqual(
      ['biandijin', 'chajinhua', 'liuhe', 'liuhong', 'wuhong'].sort(),
    );
  });

  it('isRulesetId 只承认注册表中的 ID', () => {
    expect(isRulesetId('continuous')).toBe(true);
    expect(isRulesetId('high-tier-lock')).toBe(true);
    for (const value of ['custom-script', 'high-tier', '', 'CONTINUOUS', '__proto__', 'toString', null, 1, {}]) {
      expect(isRulesetId(value)).toBe(false);
    }
  });

  it('预设记录只读，不会被就地修改', () => {
    expect(Object.isFrozen(RULESETS)).toBe(true);
    expect(Object.isFrozen(RULESETS.continuous)).toBe(true);
    expect(Object.isFrozen(RULESETS['high-tier-lock'].lockCodes)).toBe(true);
    expect(() => {
      (RULESETS.continuous as unknown as { name: string }).name = '被改掉的方案';
    }).toThrow(TypeError);
    expect(RULESETS.continuous.name).toBe('持续顶状元');
  });

  it('snapshotRuleset 返回深拷贝，修改快照不污染注册表', () => {
    const snapshot = snapshotRuleset('high-tier-lock');
    expect(snapshot).toEqual(RULESETS['high-tier-lock']);
    expect(snapshot).not.toBe(RULESETS['high-tier-lock']);
    expect(snapshot.lockCodes).not.toBe(RULESETS['high-tier-lock'].lockCodes);

    (snapshot.lockCodes as ResultCode[]).push('sihong');
    snapshot.name = '本地改名';
    expect(RULESETS['high-tier-lock'].lockCodes).not.toContain('sihong');
    expect(snapshotRuleset('high-tier-lock').name).toBe('高阶锁定');
    expect(Object.isFrozen(snapshot)).toBe(false);
  });

  it('snapshotRuleset 拒绝未注册的房规 ID', () => {
    expect(() => snapshotRuleset('custom-script' as RulesetId)).toThrow(UNKNOWN_RULESET_MESSAGE);
    expect(() => snapshotRuleset(undefined as unknown as RulesetId)).toThrow();
  });
});

describe('shouldLockChampion 状元锁定', () => {
  const LOCKING: ReadonlyArray<readonly [string, number[]]> = [
    ['五红', [4, 4, 4, 4, 4, 6]],
    ['六红', [4, 4, 4, 4, 4, 4]],
    ['遍地锦', [1, 1, 1, 1, 1, 1]],
    ['六黑', [2, 2, 2, 2, 2, 2]],
    ['插金花', [4, 4, 4, 4, 1, 1]],
  ];
  const CONTESTED: ReadonlyArray<readonly [string, number[]]> = [
    ['四红', [4, 4, 4, 4, 2, 6]],
    ['五子登科', [2, 2, 2, 2, 2, 4]],
    ['对堂', [1, 2, 3, 4, 5, 6]],
    ['谢谢参与', [1, 1, 2, 2, 3, 3]],
  ];

  it('五红在锁定版锁定，在持续版继续争夺', () => {
    const result = evaluateDice([4, 4, 4, 4, 4, 6]);
    expect(shouldLockChampion(snapshotRuleset('high-tier-lock'), result)).toBe(true);
    expect(shouldLockChampion(snapshotRuleset('continuous'), result)).toBe(false);
  });

  it.each(LOCKING)('高阶锁定版：%s 触发锁定', (_label, dice) => {
    const result = evaluateDice(dice);
    expect(shouldLockChampion(snapshotRuleset('high-tier-lock'), result)).toBe(true);
    expect(shouldLockChampion(snapshotRuleset('continuous'), result)).toBe(false);
  });

  it.each(CONTESTED)('高阶锁定版：%s 不锁定，仍可争夺', (_label, dice) => {
    const result = evaluateDice(dice);
    expect(shouldLockChampion(snapshotRuleset('high-tier-lock'), result)).toBe(false);
    expect(shouldLockChampion(snapshotRuleset('continuous'), result)).toBe(false);
  });

  it('不修改传入的规则快照，也不依赖调用方提供的锁定列表', () => {
    const snapshot = snapshotRuleset('high-tier-lock');
    const before = JSON.parse(JSON.stringify(snapshot)) as unknown;
    shouldLockChampion(snapshot, evaluateDice([4, 4, 4, 4, 4, 6]));
    expect(snapshot).toEqual(before);

    const forged = { ...snapshotRuleset('continuous'), lockCodes: ['sihong'] } as const;
    expect(shouldLockChampion(forged, evaluateDice([4, 4, 4, 4, 2, 6]))).toBe(false);

    const damaged = { ...snapshotRuleset('high-tier-lock'), lockCodes: null as unknown as ResultCode[] };
    expect(shouldLockChampion(damaged, evaluateDice([4, 4, 4, 4, 4, 6]))).toBe(false);
  });
});
