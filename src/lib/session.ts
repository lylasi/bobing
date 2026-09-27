/**
 * 匿名凭证的本地保存与恢复（按房间隔离）。
 *
 * 凭证只用于本人向服务端证明身份：
 *  - 绝不进入 URL、二维码、分享文本、日志或广播；
 *  - 凭证失效时只清理当前房间的这一条记录，不影响其他房间；
 *  - localStorage 不可用（隐私模式等）时降级为“仅本次页面会话”，功能仍可使用。
 */

import type { Membership } from '../../shared/types.js';
import { randomUuid } from './uuid.js';

const KEY_PREFIX = 'bobing.membership.';
const VIEWER_KEY_PREFIX = 'bobing.viewer.';

function storage(): Storage | null {
  try {
    const value = window.localStorage;
    const probe = '__bobing_probe__';
    value.setItem(probe, '1');
    value.removeItem(probe);
    return value;
  } catch {
    return null;
  }
}

function keyFor(code: string): string {
  return `${KEY_PREFIX}${code.toUpperCase()}`;
}

function isMembership(value: unknown, code: string): value is Membership {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.roomCode === code &&
    typeof candidate.playerId === 'string' &&
    candidate.playerId.length > 0 &&
    typeof candidate.token === 'string' &&
    candidate.token.length > 0
  );
}

const memoryFallback = new Map<string, string>();

export function saveMembership(membership: Membership): void {
  const code = membership.roomCode.toUpperCase();
  const payload = JSON.stringify({ roomCode: code, playerId: membership.playerId, token: membership.token });
  const store = storage();
  if (store) {
    try {
      store.setItem(keyFor(code), payload);
      return;
    } catch {
      // 配额或隐私限制：退化为内存保存
    }
  }
  memoryFallback.set(keyFor(code), payload);
}

export function loadMembership(code: string): Membership | null {
  const normalized = code.toUpperCase();
  const key = keyFor(normalized);
  const store = storage();
  let raw: string | null = null;
  if (store) {
    try {
      raw = store.getItem(key);
    } catch {
      raw = null;
    }
  }
  if (raw === null) raw = memoryFallback.get(key) ?? null;
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isMembership(parsed, normalized)) {
      clearMembership(normalized);
      return null;
    }
    return parsed;
  } catch {
    clearMembership(normalized);
    return null;
  }
}

export function clearMembership(code: string): void {
  const normalized = code.toUpperCase();
  const key = keyFor(normalized);
  memoryFallback.delete(key);
  const store = storage();
  if (store) {
    try {
      store.removeItem(key);
    } catch {
      // 忽略：内存回退已经清理
    }
  }
}

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 旁观访客标识（按房间独立保存，仅用于同浏览器多标签去重计数，绝不具备任何成员权限）。
 * 使用独立键 `bobing.viewer.<CODE>`，不占用也不覆盖成员凭证存储。
 */
export function getOrCreateViewerId(code: string): string {
  const normalized = code.trim().toUpperCase();
  const key = `${VIEWER_KEY_PREFIX}${normalized}`;
  const store = storage();
  let existing: string | null = null;
  if (store) {
    try {
      existing = store.getItem(key);
    } catch {
      existing = null;
    }
  }
  if (!existing) {
    existing = memoryFallback.get(key) ?? null;
  }
  if (existing && UUID_V4_REGEX.test(existing)) {
    return existing;
  }
  const created = randomUuid();
  if (store) {
    try {
      store.setItem(key, created);
      return created;
    } catch {
      // 配额或隐私限制：退化为内存保存
    }
  }
  memoryFallback.set(key, created);
  return created;
}
