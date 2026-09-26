/**
 * 本机个人方案（保存在当前浏览器 localStorage）。
 *
 * - 存储键为 `bobing.personal-templates.v1`，绝不读取或修改 `bobing.membership.*`。
 * - 只保存 `prizes` 与 `endCondition`（系统房规在房间配置中单独选择，个人方案不能携带判奖代码或锁定阈值）。
 * - 输入条目一律通过 `normalizeRoomConfig({ ...item.config, rulesetId: 'continuous' })` 校验，再只拷贝允许字段。
 * - 读取时损坏 JSON 返回空数组且不清空原键；写入抛异常（如 QuotaExceededError 或隐私限制）时返回 `{ ok: false }`，绝不假报已持久保存。
 */

import { normalizeRoomConfig } from '../../shared/room-config.js';
import type { RoomConfig } from '../../shared/types.js';
import { randomUuid } from './uuid.js';

export const PERSONAL_TEMPLATES_STORAGE_KEY = 'bobing.personal-templates.v1';

export interface PersonalTemplate {
  id: string;
  name: string;
  version: 1;
  config: Pick<RoomConfig, 'prizes' | 'endCondition'>;
}

export interface SaveTemplatesResult {
  ok: boolean;
  message?: string;
}

export interface UpsertTemplateInput {
  id?: string;
  name: string;
  config: Pick<RoomConfig, 'prizes' | 'endCondition'>;
}

export interface UpsertTemplateResult extends SaveTemplatesResult {
  template?: PersonalTemplate;
  items?: PersonalTemplate[];
}

function getStorage(): Storage | null {
  try {
    const store = globalThis.localStorage;
    if (!store || typeof store.getItem !== 'function' || typeof store.setItem !== 'function') {
      return null;
    }
    return store;
  } catch {
    return null;
  }
}

function normalizeTemplateEntry(raw: unknown): PersonalTemplate {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError('个人方案格式不正确');
  }
  const candidate = raw as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  if (id.length === 0) {
    throw new TypeError('个人方案缺少有效标识');
  }
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (name.length === 0) {
    throw new TypeError('请填写个人方案名称');
  }
  if (Array.from(name).length > 24) {
    throw new TypeError('个人方案名称最多 24 个字');
  }
  if (candidate.version !== 1) {
    throw new TypeError('不支持的个人方案版本');
  }
  const rawConfig = candidate.config;
  if (typeof rawConfig !== 'object' || rawConfig === null || Array.isArray(rawConfig)) {
    throw new TypeError('个人方案配置无效');
  }
  const normalized = normalizeRoomConfig({
    ...(rawConfig as Record<string, unknown>),
    rulesetId: 'continuous',
  });
  return {
    id,
    name,
    version: 1,
    config: {
      prizes: structuredClone(normalized.prizes),
      endCondition: structuredClone(normalized.endCondition),
    },
  };
}

/**
 * 读取本机个人方案列表。
 * 若浏览器存储不可用或数据损坏，返回空列表且不清除原有存储键。
 */
export function loadTemplates(): PersonalTemplate[] {
  const store = getStorage();
  if (!store) return [];
  let raw: string | null = null;
  try {
    raw = store.getItem(PERSONAL_TEMPLATES_STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid: PersonalTemplate[] = [];
    for (const item of parsed) {
      try {
        valid.push(normalizeTemplateEntry(item));
      } catch {
        // 跳过损坏的单条记录，不清空原键
      }
    }
    return valid;
  } catch {
    return [];
  }
}

/**
 * 保存完整个人方案数组到当前浏览器。
 * 任一条目校验失败或浏览器拒绝写入时返回 `{ ok: false, message }`。
 */
export function saveTemplates(items: PersonalTemplate[]): SaveTemplatesResult {
  if (!Array.isArray(items)) {
    return { ok: false, message: '个人方案数据格式不正确' };
  }
  let sanitized: PersonalTemplate[];
  try {
    sanitized = items.map((item) => normalizeTemplateEntry(item));
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error && error.message ? error.message : '个人方案内容不合法',
    };
  }

  const store = getStorage();
  if (!store) {
    return {
      ok: false,
      message: '当前浏览器不支持持久保存个人方案，你仍可临时配置并开房',
    };
  }

  try {
    store.setItem(PERSONAL_TEMPLATES_STORAGE_KEY, JSON.stringify(sanitized));
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: '浏览器存储空间已满或受隐私限制，个人方案未能持久保存，但仍可临时配置开房',
    };
  }
}

/**
 * 新增或更新一条个人方案（传入 id 时保留原 ID 更新，否则新建）。
 */
export function upsertTemplate(input: UpsertTemplateInput): UpsertTemplateResult {
  const id = input.id && input.id.trim().length > 0 ? input.id.trim() : randomUuid();
  let nextEntry: PersonalTemplate;
  try {
    nextEntry = normalizeTemplateEntry({
      id,
      name: input.name,
      version: 1,
      config: input.config,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error && error.message ? error.message : '请检查个人方案名称和奖品数量',
    };
  }

  const existing = loadTemplates();
  const index = existing.findIndex((item) => item.id === id);
  const nextList = [...existing];
  if (index >= 0) {
    nextList[index] = nextEntry;
  } else {
    nextList.push(nextEntry);
  }

  const outcome = saveTemplates(nextList);
  if (!outcome.ok) {
    return outcome;
  }
  return {
    ok: true,
    template: nextEntry,
    items: nextList,
  };
}

/**
 * 删除指定 ID 的个人方案。
 */
export function deleteTemplate(id: string): SaveTemplatesResult & { items?: PersonalTemplate[] } {
  const existing = loadTemplates();
  const nextList = existing.filter((item) => item.id !== id);
  const outcome = saveTemplates(nextList);
  if (!outcome.ok) return outcome;
  return { ok: true, items: nextList };
}
