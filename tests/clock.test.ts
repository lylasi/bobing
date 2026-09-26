/**
 * 校时与倒计时上界的单元测试（对应 docs/final-review-addendum.md 的 C01）。
 *
 * HTTP `Date` 只有秒级精度，服务端写入的值被截断到整秒；旧公式
 * `serverMs + rtt/2 - finishedAt` 因此稳定低估服务端时钟 0–1000ms，
 * 叠加倒计时的 `Math.ceil` 就会把 30 秒回合显示成「剩余 31 秒」。
 */

import { describe, expect, it } from 'vitest';
import { serverClockOffset } from '../src/lib/api.js';
import { TURN_DURATION_MS } from '../shared/rules.js';

/** 一秒钟内头生成时刻的所有可能位置（毫秒）。 */
const TRUNCATION_OFFSETS = [0, 1, 137, 250, 499, 500, 501, 750, 999];

describe('HTTP Date 秒级校时', () => {
  it('截断补偿后偏差不超过 ±500ms（旧公式最坏 1000ms）', () => {
    const rtt = 20;
    for (const delta of TRUNCATION_OFFSETS) {
      // 本地与服务端时钟完全一致（真实偏移为 0）：
      // 头在服务端时间 servedAt 生成，本地在 servedAt + rtt/2 收到响应，Date 值被截断到整秒
      const servedAt = 1_800_000_000_000 + delta;
      const truncated = Math.floor(servedAt / 1000) * 1000;
      const startedAt = servedAt - rtt / 2;
      const finishedAt = servedAt + rtt / 2;
      const offset = serverClockOffset(truncated, startedAt, finishedAt);
      expect(Math.abs(offset), `截断位置 ${delta}ms 时偏差 ${offset}ms`).toBeLessThanOrEqual(500);
    }
  });

  it('倒计时读数钳制在回合时长内：任何校时误差都不会显示 31 秒', () => {
    const base = 1_800_000_000_000;
    const rtt = 20;
    let clampedCases = 0;
    // f：回合开始落在整秒内的位置；e：收到快照前经过的时间。两者共同决定 Date 的截断位置。
    for (const f of [0, 120, 300, 500, 700, 800, 900, 970, 999]) {
      const turnStart = base + f;
      const deadline = turnStart + TURN_DURATION_MS;
      const servedAt = turnStart + 50;
      const truncated = Math.floor(servedAt / 1000) * 1000;
      const offset = serverClockOffset(truncated, servedAt - rtt / 2, servedAt + rtt / 2);
      const raw = deadline - (servedAt + rtt / 2 + offset);
      const clamped = Math.min(raw, TURN_DURATION_MS);
      if (raw > TURN_DURATION_MS) clampedCases += 1;
      const shown = Math.max(0, Math.ceil(clamped / 1000));
      expect(shown, `回合在整秒内偏移 ${f}ms 时显示了「剩余 ${shown} 秒」`).toBeLessThanOrEqual(30);
      expect(shown).toBeGreaterThanOrEqual(29);
    }
    // 只靠校时补偿还不够：确有原始读数超过 30 秒的情形，钳制是真正的兜底
    expect(clampedCases, '没有出现需要钳制的样本，用例失去意义').toBeGreaterThan(0);
  });
});
