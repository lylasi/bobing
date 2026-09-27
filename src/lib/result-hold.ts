/**
 * 结果停留秒数的草稿解析、校验与步进（纯函数，前后端契约不变）。
 *
 * 上下限复用 shared/presentation.ts，不在这里复制第二份范围：
 * 0–10 的整数秒，默认 1 秒，0 秒仅跳过额外阅读时间（投掷动画仍保留）。
 *
 * 三条规则刻意保持“不悄悄容错”：
 *  - 解析只接受十进制整数字符串，空值、小数、负号、指数、十六进制与超安全整数都是 null；
 *  - 校验对非法草稿返回错误文案，调用方保留用户原样输入，绝不回退为默认 1；
 *  - 步进在草稿非法或目标越界时返回 null（不钳制到边界、不自行回退），
 *    由调用方据此禁用按钮，用户仍然可以继续直接编辑输入框。
 */

import { MAX_RESULT_HOLD_SECONDS, MIN_RESULT_HOLD_SECONDS } from '../../shared/presentation.js';

/** 解析为 0–10 的整数；任何非法草稿（含空串、`1.5`、`-0`、`-1`、`11`、`1e1`、`NaN`）返回 null。 */
export function parseResultHoldSeconds(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_RESULT_HOLD_SECONDS ||
    parsed > MAX_RESULT_HOLD_SECONDS
  ) {
    return null;
  }
  return parsed;
}

/** 合法返回 null，否则返回给用户看的错误文案（空值与其它非法输入分别提示）。 */
export function validateResultHoldSeconds(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return `请填写结果停留秒数（${MIN_RESULT_HOLD_SECONDS}–${MAX_RESULT_HOLD_SECONDS} 的整数）`;
  }
  if (!/^\d+$/.test(trimmed)) {
    return `结果停留秒数必须是 ${MIN_RESULT_HOLD_SECONDS}–${MAX_RESULT_HOLD_SECONDS} 的整数`;
  }
  if (parseResultHoldSeconds(trimmed) === null) {
    return `结果停留秒数请填 ${MIN_RESULT_HOLD_SECONDS}–${MAX_RESULT_HOLD_SECONDS} 的整数`;
  }
  return null;
}

/**
 * 合法草稿严格 ±1；草稿非法或结果超出 0–10 时返回 null（不钳制、不回退默认值）。
 */
export function stepResultHoldSeconds(raw: string, direction: -1 | 1): number | null {
  const current = parseResultHoldSeconds(raw);
  if (current === null) {
    return null;
  }
  const next = current + direction;
  if (next < MIN_RESULT_HOLD_SECONDS || next > MAX_RESULT_HOLD_SECONDS) {
    return null;
  }
  return next;
}
