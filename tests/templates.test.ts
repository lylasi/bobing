import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRoomConfig } from '../shared/room-config.js';
import { stageForElapsed } from '../src/hooks/useDiceAnimation.js';
import { readSoundEnabled, writeSoundEnabled } from '../src/hooks/useSoundSettings.js';
import { createDiceSound } from '../src/lib/dice-sound.js';
import {
  PERSONAL_TEMPLATES_STORAGE_KEY,
  deleteTemplate,
  loadTemplates,
  saveTemplates,
  upsertTemplate,
} from '../src/lib/templates.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

describe('个人方案本地存储 (src/lib/templates)', () => {
  it('存储写入失败时不假报个人方案已保存', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });
    const { prizes, endCondition } = createDefaultRoomConfig();
    const outcome = saveTemplates([
      {
        id: 'example',
        name: '亲友局',
        version: 1,
        config: { prizes, endCondition },
      },
    ]);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toBeTruthy();
  });

  it('保存后的 config 仅保留 prizes 与 endCondition，重新读取后相等，不带入系统房规或锁定列表', () => {
    const storage = createMemoryStorage({
      'bobing.membership.ABCD23': JSON.stringify({ roomCode: 'ABCD23', playerId: 'p1', token: 'secret' }),
    });
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });

    const defaults = createDefaultRoomConfig();
    defaults.prizes.yixiu = { count: 12, content: '  手工月饼一盒  ' };
    defaults.endCondition = { mode: 'rounds', maxRounds: 10 };

    const dirtyConfig = {
      ...defaults,
      rulesetId: 'high-tier-lock',
      lockCodes: ['wuhong'],
      extraField: 'should-be-dropped',
    } as unknown as Pick<typeof defaults, 'prizes' | 'endCondition'>;

    const saved = saveTemplates([
      {
        id: 'tpl-1',
        name: '  中秋家宴方案  ',
        version: 1,
        config: dirtyConfig,
      },
    ]);
    expect(saved.ok).toBe(true);

    const loaded = loadTemplates();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual({
      id: 'tpl-1',
      name: '中秋家宴方案',
      version: 1,
      config: {
        prizes: {
          ...defaults.prizes,
          yixiu: { count: 12, content: '手工月饼一盒' },
        },
        endCondition: { mode: 'rounds', maxRounds: 10 },
      },
    });
    expect('rulesetId' in (loaded[0]!.config as Record<string, unknown>)).toBe(false);
    expect('lockCodes' in (loaded[0]!.config as Record<string, unknown>)).toBe(false);
    // 不读取或覆盖 bobing.membership.*
    expect(storage.getItem('bobing.membership.ABCD23')).toContain('secret');
  });

  it('损坏 JSON 返回空列表且不清空原键', () => {
    const removeSpy = vi.fn();
    const setSpy = vi.fn();
    const rawCorrupted = '{corrupted-json';
    const storage = {
      getItem: (key: string) => (key === PERSONAL_TEMPLATES_STORAGE_KEY ? rawCorrupted : null),
      removeItem: removeSpy,
      setItem: setSpy,
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });

    expect(loadTemplates()).toEqual([]);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('支持命名新建、更新（保留原 ID）与删除，拒绝空名称或非法份数', () => {
    const storage = createMemoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage });

    const base = createDefaultRoomConfig();
    const created = upsertTemplate({
      name: '公司茶话会',
      config: { prizes: base.prizes, endCondition: { mode: 'all-prizes' } },
    });
    expect(created.ok).toBe(true);
    expect(created.template?.id).toBeTruthy();

    const originalId = created.template!.id;
    const updatedPrizes = structuredClone(base.prizes);
    updatedPrizes.zhuangyuan = { count: 3, content: '金月饼礼盒' };

    const updated = upsertTemplate({
      id: originalId,
      name: '公司茶话会（升级版）',
      config: { prizes: updatedPrizes, endCondition: { mode: 'rounds', maxRounds: 20 } },
    });
    expect(updated.ok).toBe(true);
    expect(updated.template?.id).toBe(originalId);
    expect(loadTemplates()).toHaveLength(1);
    expect(loadTemplates()[0]?.config.prizes.zhuangyuan).toEqual({ count: 3, content: '金月饼礼盒' });

    // 空名称拒绝
    expect(
      upsertTemplate({
        name: '   ',
        config: { prizes: base.prizes, endCondition: { mode: 'all-prizes' } },
      }).ok,
    ).toBe(false);

    // 份数为 0 拒绝
    const badPrizes = structuredClone(base.prizes);
    badPrizes.yixiu.count = 0;
    expect(
      upsertTemplate({
        name: '非法零份',
        config: { prizes: badPrizes, endCondition: { mode: 'all-prizes' } },
      }).ok,
    ).toBe(false);

    // 删除方案
    const removed = deleteTemplate(originalId);
    expect(removed.ok).toBe(true);
    expect(loadTemplates()).toEqual([]);
  });
});

describe('骰子动画阶段与本地音效生命周期', () => {
  it('stageForElapsed 覆盖完整 settledCount 0..6（不跳过 2）及全部运动阶段', () => {
    const counts = new Set<number>();
    const phases = new Set<string>();
    for (let elapsed = 0; elapsed <= 750; elapsed += 75) {
      const stage = stageForElapsed(elapsed);
      counts.add(stage.settledCount);
      phases.add(stage.phase);
    }
    expect(Array.from(counts)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(Array.from(phases)).toEqual(['tumbling', 'landing', 'colliding', 'settling', 'idle']);
  });

  it('音效默认关闭、可持久化记住，且 dispose 后不再产生音频节点', () => {
    const storage = createMemoryStorage();
    let oscStarted = 0;
    let ctxClosed = 0;
    class FakeAudioContext {
      state = 'running';
      currentTime = 0;
      sampleRate = 8000;
      destination = {};
      resume = vi.fn(async () => undefined);
      close = vi.fn(async () => {
        ctxClosed += 1;
      });
      createBuffer(_channels: number, length: number) {
        return {
          getChannelData: () => new Float32Array(length),
        };
      }
      createOscillator() {
        return {
          type: 'triangle',
          frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: () => {
            oscStarted += 1;
          },
          stop: vi.fn(),
          onended: null,
        };
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
            cancelScheduledValues: vi.fn(),
          },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      }
      createBufferSource() {
        return {
          buffer: null,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null,
        };
      }
      createBiquadFilter() {
        return {
          type: 'bandpass',
          frequency: { setValueAtTime: vi.fn() },
          Q: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
      }
    }

    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('window', { localStorage: storage, AudioContext: FakeAudioContext });
    vi.stubGlobal('AudioContext', FakeAudioContext);

    expect(readSoundEnabled()).toBe(false);
    writeSoundEnabled(true);
    expect(readSoundEnabled()).toBe(true);

    const sound = createDiceSound();
    // 仅创建不启动时，不创建 AudioContext 或播放节点
    expect(oscStarted).toBe(0);

    sound.start();
    expect(oscStarted).toBeGreaterThan(0);

    const countBeforeDispose = oscStarted;
    sound.dispose();
    expect(ctxClosed).toBe(1);

    // dispose 后再次调用 start / impact 不会再产生新音频节点
    sound.start();
    sound.impact(1);
    expect(oscStarted).toBe(countBeforeDispose);
  });
});
