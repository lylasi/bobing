/**
 * 房间访问设置：大厅可见性与旁观开关的默认值与严格校验。
 *
 * 两类房间设置（节奏、访问）与 `RoomConfig`（房规／奖品／结束方式）分开保存：
 * 个人奖品方案不包含它们，改可见性或旁观也不会取消其他人的准备、改变奖品或对局进度。
 *
 *  - 新建房间默认“大厅公开、允许旁观”（用户确认）；
 *  - 旧快照缺少该字段时迁移为“仅邀请、关闭旁观”，不自动放开旧房间；
 *  - 仅邀请表示不出现在大厅，持有房间码或链接的人仍可访问概况，能否旁观由 allowSpectators 决定。
 *
 * 本文件前后端共用，不引入 Node 或浏览器专有 API。
 */

import type { RoomAccess } from './types.js';

/** 新房默认访问设置：公开且允许旁观。 */
export const DEFAULT_ROOM_ACCESS: Readonly<RoomAccess> = Object.freeze({
  visibility: 'public',
  allowSpectators: true,
});

/** 旧房间迁移后的访问设置：仅邀请、关闭旁观。 */
export const LEGACY_ROOM_ACCESS: Readonly<RoomAccess> = Object.freeze({
  visibility: 'invite',
  allowSpectators: false,
});

/** 配置非法时的统一前缀；服务层据此映射到 INVALID_INPUT。 */
export const INVALID_ROOM_ACCESS_MESSAGE = '房间访问设置不合法';

/** 新房默认访问设置的独立副本。 */
export function createDefaultRoomAccess(): RoomAccess {
  return { visibility: DEFAULT_ROOM_ACCESS.visibility, allowSpectators: DEFAULT_ROOM_ACCESS.allowSpectators };
}

/** 旧房间迁移后的访问设置的独立副本。 */
export function createLegacyRoomAccess(): RoomAccess {
  return { visibility: LEGACY_ROOM_ACCESS.visibility, allowSpectators: LEGACY_ROOM_ACCESS.allowSpectators };
}

/**
 * 严格校验访问设置：必须是对象，visibility 只能是 'invite'／'public'，
 * allowSpectators 必须是布尔值。未知字段直接丢弃，非法值抛 TypeError。
 */
export function normalizeRoomAccess(value: unknown): RoomAccess {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${INVALID_ROOM_ACCESS_MESSAGE}：配置必须是对象`);
  }
  const raw = value as Record<string, unknown>;
  const visibility = raw.visibility;
  const allowSpectators = raw.allowSpectators;
  if (visibility !== 'invite' && visibility !== 'public') {
    throw new TypeError(`${INVALID_ROOM_ACCESS_MESSAGE}：visibility 只能是 invite 或 public`);
  }
  if (typeof allowSpectators !== 'boolean') {
    throw new TypeError(`${INVALID_ROOM_ACCESS_MESSAGE}：allowSpectators 必须是布尔值`);
  }
  return { visibility, allowSpectators };
}

/** 两份已归一化访问设置是否完全一致（决定改动是否算“实际变化”）。 */
export function sameRoomAccess(a: RoomAccess, b: RoomAccess): boolean {
  return a.visibility === b.visibility && a.allowSpectators === b.allowSpectators;
}
