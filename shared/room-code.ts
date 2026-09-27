/**
 * 房间码：新号码的字符集、输入归一化与统一接受规则。
 *
 *  - 新生成：六位纯数字，保留前导零（`028416` 仍然是合法的六位房间码，不能用 number 存储）；
 *  - 接受：六位数字，或旧版六位字符集（去掉容易读错的 I、O、0、1）的旧房码；
 *  - 房间码长度仍是 6，不区分大小写，忽略所有空白字符（手机粘贴常带空格）。
 *
 * 本文件前后端共用，不引入 Node 或浏览器专有 API。
 */

import { ROOM_CODE_LENGTH } from './rules.js';

/** 新号码字符集：0–9，必须保留前导零。 */
export const ROOM_CODE_DIGITS = '0123456789';

/** 旧房码字符集的接受规则（与 ROOM_CODE_ALPHABET 一致，但不用于新生成）。 */
const LEGACY_ROOM_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const NUMERIC_ROOM_CODE_PATTERN = /^[0-9]{6}$/;

/** 去掉所有空白并转大写：`' 028 416 '` → `'028416'`。 */
export function normalizeRoomCodeText(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** 六位数字码或旧字符集房码都接受；其它长度与字符一律拒绝。 */
export function isAcceptedRoomCode(code: string): boolean {
  return NUMERIC_ROOM_CODE_PATTERN.test(code) || LEGACY_ROOM_CODE_PATTERN.test(code);
}

/** 房码长度（与 shared/rules.ts 保持一致，避免两处漂移）。 */
export const ACCEPTED_ROOM_CODE_LENGTH = ROOM_CODE_LENGTH;
