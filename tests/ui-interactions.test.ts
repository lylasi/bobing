/**
 * 交互业务纯函数回归（Antigravity 评审跟进 Task 2）。
 *
 * 覆盖两个新抽出的纯函数模块（席位条昵称压缩的 Unicode 字素边界、结果停留秒数的
 * 解析/校验/步进），并用 renderToStaticMarkup 固化两处 DOM 契约：
 * 席位条 .seat-chip-trigger / .seat-full-name 的标记与可访问名，以及设置步进按钮的
 * 可访问名与禁用边界。组件真正的点按、Escape 与几何表现由 Playwright 端到端用例验收，
 * 这里不引入浏览器环境，也不改动任何业务契约。
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { compactSeatName } from '../src/lib/seat-name.js';
import {
  parseResultHoldSeconds,
  stepResultHoldSeconds,
  validateResultHoldSeconds,
} from '../src/lib/result-hold.js';
import {
  validateResultHoldSeconds as legacyValidateResultHoldSeconds,
  RoomSettingsFields,
} from '../src/components/RoomSettingsFields.js';
import { SeatStrip } from '../src/components/SeatStrip.js';
import { PRIZE_KEYS } from '../shared/rules.js';
import type { Player, PrizeKey, RoomState } from '../shared/types.js';
import {
  MAX_RESULT_HOLD_SECONDS,
  MIN_RESULT_HOLD_SECONDS,
} from '../shared/presentation.js';

/** 家庭 emoji：4 个码点 + 3 个 ZWJ，按字素算 1 个字符。 */
const FAMILY_EMOJI = '👨‍👩‍👧‍👦';

describe('compactSeatName', () => {
  it('超过 5 字素时保留前 2 与后 2，同前缀昵称不再变成同一个前缀', () => {
    expect(compactSeatName('团圆长昵称玩家01')).toBe('团圆…01');
    expect(compactSeatName('团圆长昵称玩家02')).toBe('团圆…02');
    expect(compactSeatName('团圆长昵称玩家01')).not.toBe(compactSeatName('团圆长昵称玩家02'));
    expect(compactSeatName('老李家大宝儿')).toBe('老李…宝儿');
    // 恰好 5 字的家庭昵称原样保留，不产生省略号
    expect(compactSeatName('老李家大宝')).toBe('老李家大宝');
  });

  it('5 字素及以内原样返回，不做补齐或省略', () => {
    expect(compactSeatName('阿月')).toBe('阿月');
    expect(compactSeatName('一二三四五')).toBe('一二三四五');
    expect(compactSeatName('')).toBe('');
    expect(compactSeatName('a')).toBe('a');
  });

  it('6 字素刚好触发一次压缩，且不修改原始字符串', () => {
    const nickname = '一二三四五六';
    expect(compactSeatName(nickname)).toBe('一二…五六');
    expect(nickname).toBe('一二三四五六');
  });

  it('家庭 emoji 作为单个字素参与计数与切片，绝不被拆开', () => {
    // 1（家庭 emoji）+ 宝宝贝贝囍 = 6 字素：只有整体保留才可能出现在结果里
    expect(compactSeatName(`${FAMILY_EMOJI}宝宝贝贝囍`)).toBe(`${FAMILY_EMOJI}宝…贝囍`);
    // 5 字素以内原样保留，不产生任何省略号
    expect(compactSeatName(`${FAMILY_EMOJI}宝宝贝贝`)).toBe(`${FAMILY_EMOJI}宝宝贝贝`);
    expect(compactSeatName(`${FAMILY_EMOJI}宝宝贝贝`)).not.toContain('…');
  });

  it('组合字符（基字符 + 组合附加符号）按一个字素处理', () => {
    // a\u0301 / e\u0301 等共 6 个字素：前 2 是 á 与 b́，后 2 是 é 与 f́
    expect(compactSeatName('a\u0301b\u0301c\u0301d\u0301e\u0301f\u0301')).toBe(
      'a\u0301b\u0301…e\u0301f\u0301',
    );
    // 变体选择符与 emoji 修饰符同样不能被切开
    expect(compactSeatName('❤️宝宝贝贝囍')).toBe('❤️宝…贝囍');
    expect(compactSeatName('👍🏽宝宝贝贝囍')).toBe('👍🏽宝…贝囍');
  });

  it('非 BMP 字符（代理对）不会被截成半个字符', () => {
    expect(compactSeatName('𠮷野家拉面店')).toBe('𠮷野…面店');
  });
});

describe('parseResultHoldSeconds', () => {
  it('接受 0–10 的整数字符串（含前后空白）', () => {
    expect(parseResultHoldSeconds('0')).toBe(MIN_RESULT_HOLD_SECONDS);
    expect(parseResultHoldSeconds('10')).toBe(MAX_RESULT_HOLD_SECONDS);
    expect(parseResultHoldSeconds(' 3 ')).toBe(3);
    for (let seconds = MIN_RESULT_HOLD_SECONDS; seconds <= MAX_RESULT_HOLD_SECONDS; seconds += 1) {
      expect(parseResultHoldSeconds(String(seconds))).toBe(seconds);
    }
  });

  it('空值与非法草稿一律返回 null，不做静默回退', () => {
    const invalid = [
      '',
      '   ',
      '1.5',
      '-0',
      '-1',
      '11',
      '1e1',
      'NaN',
      'abc',
      '5秒',
      '+1',
      '0x1',
      '½',
      'Infinity',
      ' 1 2 ',
      '99999999999999999999',
    ];
    for (const raw of invalid) {
      expect(parseResultHoldSeconds(raw), `raw=${JSON.stringify(raw)}`).toBeNull();
    }
  });
});

describe('validateResultHoldSeconds', () => {
  it('0 与 10 合法，返回 null', () => {
    expect(validateResultHoldSeconds('0')).toBeNull();
    expect(validateResultHoldSeconds('10')).toBeNull();
    expect(validateResultHoldSeconds(' 7 ')).toBeNull();
  });

  it('空值提示“请填写”，其它非法草稿给出范围提示', () => {
    expect(validateResultHoldSeconds('')).toContain('请填写');
    expect(validateResultHoldSeconds('   ')).toContain('请填写');
    for (const raw of ['1.5', '-0', '-1', '11', '1e1', 'NaN']) {
      const error = validateResultHoldSeconds(raw);
      expect(error, `raw=${JSON.stringify(raw)}`).toBeTruthy();
      expect(error).toContain(
        `${MIN_RESULT_HOLD_SECONDS}–${MAX_RESULT_HOLD_SECONDS}`,
      );
    }
  });
});

describe('stepResultHoldSeconds', () => {
  it('合法草稿严格 ±1', () => {
    expect(stepResultHoldSeconds('1', 1)).toBe(2);
    expect(stepResultHoldSeconds('1', -1)).toBe(0);
    expect(stepResultHoldSeconds('0', 1)).toBe(1);
    expect(stepResultHoldSeconds('10', -1)).toBe(9);
    expect(stepResultHoldSeconds(' 4 ', 1)).toBe(5);
  });

  it('两端越界返回 null，不钳制到边界', () => {
    expect(stepResultHoldSeconds('0', -1)).toBeNull();
    expect(stepResultHoldSeconds('10', 1)).toBeNull();
    expect(stepResultHoldSeconds('11', -1)).toBeNull();
  });

  it('非法草稿返回 null，既不改动草稿也不回退默认值 1', () => {
    for (const raw of ['', '1.5', '-0', '-1', '1e1', 'NaN', 'abc']) {
      expect(stepResultHoldSeconds(raw, 1), `raw=${JSON.stringify(raw)}`).toBeNull();
      expect(stepResultHoldSeconds(raw, -1), `raw=${JSON.stringify(raw)}`).toBeNull();
    }
  });

  it('整个 0–10 区间步进后仍落在合法范围内，且与解析结果一致', () => {
    for (let seconds = MIN_RESULT_HOLD_SECONDS; seconds <= MAX_RESULT_HOLD_SECONDS; seconds += 1) {
      const raw = String(seconds);
      const down = stepResultHoldSeconds(raw, -1);
      const up = stepResultHoldSeconds(raw, 1);
      expect(down).toBe(seconds === MIN_RESULT_HOLD_SECONDS ? null : seconds - 1);
      expect(up).toBe(seconds === MAX_RESULT_HOLD_SECONDS ? null : seconds + 1);
      if (down !== null) expect(parseResultHoldSeconds(String(down))).toBe(down);
      if (up !== null) expect(parseResultHoldSeconds(String(up))).toBe(up);
    }
  });
});

describe('RoomSettingsFields 兼容导出', () => {
  it('validateResultHoldSeconds 仍从组件模块导出，且与 lib 实现逐值一致', () => {
    for (const raw of ['0', '10', '7', '', '1.5', '-0', '11', '1e1', 'NaN']) {
      expect(legacyValidateResultHoldSeconds(raw), `raw=${JSON.stringify(raw)}`).toBe(
        validateResultHoldSeconds(raw),
      );
    }
  });
});

/* ---------- DOM 契约（服务端渲染；真实交互由 Playwright 验收） ---------- */

/** 只填 SeatStrip 读取的字段，避免在测试里复制一份完整房间快照。 */
function seatPlayer(id: string, nickname: string, seat: number, overrides: Partial<Player> = {}): Player {
  return {
    id,
    nickname,
    seat,
    ready: true,
    online: true,
    left: false,
    awards: Object.fromEntries(PRIZE_KEYS.map((key: PrizeKey) => [key, 0])) as Record<PrizeKey, number>,
    best: null,
    rollCount: 0,
    timeoutCount: 0,
    lastRoll: null,
    ...overrides,
  };
}

function seatStripHtml(players: Player[], viewerPlayerId: string, turnPlayerId: string | null): string {
  const room = {
    players,
    turnPlayerId,
    presentation: null,
    maxPlayers: 8,
  } as unknown as RoomState;
  return renderToStaticMarkup(createElement(SeatStrip, { room, playerId: viewerPlayerId }));
}

function settingsHtml(seconds: number, disabled = false): string {
  return renderToStaticMarkup(
    createElement(RoomSettingsFields, {
      pacing: { resultHoldSeconds: seconds },
      onPacingChange: () => {},
      access: { visibility: 'public', allowSpectators: true },
      onAccessChange: () => {},
      disabled,
    }),
  );
}

function buttonTag(html: string, label: string): string {
  const match = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`));
  return match ? match[0] : '';
}

describe('SeatStrip 标记与可访问名', () => {
  it('保留 li / data-seat-player / 状态徽章，昵称压缩而可访问名仍是完整昵称', () => {
    const html = seatStripHtml(
      [seatPlayer('p1', '团圆长昵称玩家01', 1), seatPlayer('p2', '团圆长昵称玩家02', 2)],
      'p1',
      'p1',
    );

    expect(html).toContain('<li class="seat-chip seat-chip--current seat-chip--me" data-seat-player="p1">');
    expect(html).toContain('data-seat-player="p2"');
    // 横向滚动容器与状态徽章保持不变
    expect(html).toContain('class="seat-strip-list"');
    expect(html).toContain('seat-chip-dice-icon');
    expect(html).toContain('seat-chip-badge--me');
    expect(html).toContain('seat-chip-badge--current');

    // 头像与昵称在原生按钮内，可见文本压缩、可访问名完整且互不相同
    expect(html).toContain('class="seat-chip-trigger"');
    expect(html).toContain('<span class="seat-chip-name">团圆…01</span>');
    expect(html).toContain('<span class="seat-chip-name">团圆…02</span>');
    expect(html).toMatch(/aria-label="团圆长昵称玩家01，查看完整昵称（我）（当前出手）"/);

    // 折叠时不渲染全名行，也不留 aria-controls 悬空引用
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-controls');
    expect(html).not.toContain('seat-full-name');
  });

  it('已离席玩家不进入席位条，也不会留下悬空的全名行', () => {
    const html = seatStripHtml(
      [seatPlayer('p1', '团圆长昵称玩家01', 1), seatPlayer('p2', '阿月', 2, { left: true })],
      'p1',
      null,
    );

    expect(html).toContain('data-seat-player="p1"');
    expect(html).not.toContain('data-seat-player="p2"');
    expect(html).not.toContain('seat-full-name');
  });
});

describe('RoomSettingsFields 步进按钮契约', () => {
  it('可访问名固定，输入为 0 时只能加、输入为 10 时只能减', () => {
    const atMin = settingsHtml(MIN_RESULT_HOLD_SECONDS);
    expect(buttonTag(atMin, '减少结果停留秒数')).toMatch(/\sdisabled/);
    expect(buttonTag(atMin, '增加结果停留秒数')).not.toMatch(/\sdisabled/);

    const atMax = settingsHtml(MAX_RESULT_HOLD_SECONDS);
    expect(buttonTag(atMax, '减少结果停留秒数')).not.toMatch(/\sdisabled/);
    expect(buttonTag(atMax, '增加结果停留秒数')).toMatch(/\sdisabled/);

    const middle = settingsHtml(5);
    expect(buttonTag(middle, '减少结果停留秒数')).not.toMatch(/\sdisabled/);
    expect(buttonTag(middle, '增加结果停留秒数')).not.toMatch(/\sdisabled/);
  });

  it('disabled 时步进按钮、输入框与开关一并禁用', () => {
    const html = settingsHtml(5, true);
    expect(buttonTag(html, '减少结果停留秒数')).toMatch(/\sdisabled/);
    expect(buttonTag(html, '增加结果停留秒数')).toMatch(/\sdisabled/);
    expect(html).toMatch(/<input[^>]*aria-label="结果停留秒数"[^>]*disabled/);
    expect(html).toMatch(/<input[^>]*aria-label="允许旁观"[^>]*disabled/);
  });

  it('保留原输入名、aria-describedby 关联与唯一说明文案', () => {
    const html = settingsHtml(5);
    expect(html).toContain('class="settings-hold-stepper"');
    expect(html).toContain('class="settings-hold-input-group"');
    expect(html).toContain('class="input settings-hold-input"');
    expect(html).toContain('aria-label="结果停留秒数"');
    expect(html).toMatch(/<input[^>]*aria-label="结果停留秒数"[^>]*aria-describedby="[^"]+"/);
    expect(html).toMatch(/value="5"/);
    expect(html).toContain('0–10 秒，默认 1 秒；0 秒保留动画，下次结果生效。');
    expect(html).toContain('aria-invalid="false"');
  });
});
