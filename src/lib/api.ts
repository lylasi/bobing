/**
 * REST 客户端：统一超时、错误码映射与服务器校时。
 *
 * - 所有请求带 AbortController 超时；超时/网络失败与业务错误分开，方便调用方区分
 *   “不知道服务器有没有执行”和“服务器明确拒绝”。
 * - 每次响应用 HTTP `Date` 头校对服务端时间，倒计时以服务端 deadline 为准。
 * - 只读扩展 `/api/config` 提供运行时分享地址；失败时回退到当前 origin。
 */

import { ERROR_MESSAGES } from '../../shared/types.js';
import type {
  Action,
  CreateRoomRequest,
  ErrorCode,
  MemberStateResponse,
  RoomPreview,
  RoomResponse,
  RoomState,
  RoomWithMembershipResponse,
} from '../../shared/types.js';

export const DEFAULT_TIMEOUT_MS = 10_000;

export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'protocol';

/** 统一失败类型：`kind` 决定能否重试，`code` 用于展示中文提示。 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly code: ErrorCode | null;
  readonly status: number | null;

  constructor(kind: ApiErrorKind, message: string, code: ErrorCode | null = null, status: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.code = code;
    this.status = status;
  }

  /** 服务端是否可能已经执行了这次写操作（用于决定是否复用 requestId）。 */
  get uncertain(): boolean {
    return this.kind === 'timeout' || this.kind === 'network';
  }
}

// —— 服务器校时 ——

let clockOffsetMs = 0;
let clockSynced = false;

/** 本地时钟与会话内最新一次服务端时间的偏移（正数表示服务端时间更快）。 */
export function clockOffset(): number {
  return clockOffsetMs;
}

export function hasServerClock(): boolean {
  return clockSynced;
}

/** 服务端视角的“现在”，用于倒计时显示；授权仍然只由服务端 deadline 决定。 */
export function serverNow(): number {
  return Date.now() + clockOffsetMs;
}

/**
 * HTTP `Date` 只有秒级精度，服务端写入的这个值是被**截断**到整秒的：
 * 真实的头生成时刻落在 [S, S+1000) 之间，直接用 S 会让服务端时钟被系统性低估
 * （平均 500ms，最坏 1 秒），倒计时因此会多显示 1 秒。取该秒的中点作为估计，
 * 把误差从 [0, 1000) 收敛到 [-500, +500)，并略偏“早”，倒计时不会多给时间。
 */
const DATE_TRUNCATION_HALF_MS = 500;

/**
 * 由一次响应的 HTTP `Date`（已截断到整秒的 `headerMs`）与本地往返时间推算
 * 「服务端时钟 − 本地时钟」的偏移。抽成纯函数便于单测：旧写法少了截断补偿，
 * 会稳定地把服务端时钟低估 0–1000ms（平均 500ms），倒计时因此多 1 秒。
 */
export function serverClockOffset(headerMs: number, startedAt: number, finishedAt: number): number {
  return headerMs + DATE_TRUNCATION_HALF_MS + (finishedAt - startedAt) / 2 - finishedAt;
}

function syncClockFrom(response: Response, startedAt: number, finishedAt: number): void {
  const header = response.headers.get('date');
  if (!header) return;
  const serverMs = Date.parse(header);
  if (Number.isNaN(serverMs)) return;
  const roundTrip = finishedAt - startedAt;
  // HTTP Date 只有秒级精度，长往返会把误差放大；只采纳合理的样本
  if (roundTrip > 5000) return;
  clockOffsetMs = serverClockOffset(serverMs, startedAt, finishedAt);
  clockSynced = true;
}

// —— 通用请求 ——

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  token?: string | null;
  timeoutMs?: number;
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in ERROR_MESSAGES;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      signal: controller.signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new ApiError('timeout', '操作超时，请检查网络后重试');
    }
    throw new ApiError('network', '网络连接失败，请检查网络后重试');
  }
  clearTimeout(timer);
  syncClockFrom(response, startedAt, Date.now());

  const text = await response.text().catch(() => '');
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const body = parsed as { error?: { code?: unknown; message?: unknown } } | null;
    const rawCode = body?.error?.code;
    const code = isErrorCode(rawCode) ? rawCode : null;
    const message =
      typeof body?.error?.message === 'string' && body.error.message.length > 0
        ? body.error.message
        : code
          ? ERROR_MESSAGES[code]
          : '暂时无法完成操作，请稍后重试';
    throw new ApiError('http', message, code, response.status);
  }

  if (parsed === null) throw new ApiError('protocol', '服务器返回了无法识别的响应');
  return parsed as T;
}

// —— 运行时配置（只读） ——

export interface RuntimeConfig {
  publicBaseUrl: string | null;
}

let configPromise: Promise<RuntimeConfig> | null = null;

/** 读取 `/api/config`；失败不阻塞页面，退化为“使用当前访问地址”。 */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (!configPromise) {
    configPromise = request<RuntimeConfig>('/api/config', { timeoutMs: 5000 }).catch(() => ({ publicBaseUrl: null }));
  }
  return configPromise;
}

let resolvedBaseUrl: string | null = null;

/** 生成分享链接的基地址：优先服务端配置，其次当前 origin；不含 token。 */
export function shareBaseUrl(): string {
  if (resolvedBaseUrl) return resolvedBaseUrl;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

export function setShareBaseUrl(value: string | null): void {
  resolvedBaseUrl = value;
}

/** 邀请链接只包含房码，绝不带任何凭证。 */
export function buildInviteUrl(code: string, base: string = shareBaseUrl()): string {
  return `${base.replace(/\/+$/, '')}/room/${code}`;
}

// —— 业务接口 ——

export function fetchHealth(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/health', { timeoutMs: 5000 });
}

export function createRoom(input: CreateRoomRequest): Promise<RoomWithMembershipResponse> {
  return request<RoomWithMembershipResponse>('/api/rooms', { method: 'POST', body: input });
}

export function previewRoom(code: string): Promise<RoomPreview> {
  return request<RoomPreview>(`/api/rooms/${encodeURIComponent(code)}`, { timeoutMs: 8000 });
}

export function joinRoom(code: string, nickname: string): Promise<RoomWithMembershipResponse> {
  return request<RoomWithMembershipResponse>(`/api/rooms/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    body: { nickname },
  });
}

export function fetchRoomState(code: string, token: string): Promise<MemberStateResponse> {
  return request<MemberStateResponse>(`/api/rooms/${encodeURIComponent(code)}/state`, { token, timeoutMs: 8000 });
}

export function sendAction(code: string, token: string, action: Action): Promise<RoomResponse> {
  return request<RoomResponse>(`/api/rooms/${encodeURIComponent(code)}/actions`, {
    method: 'POST',
    token,
    body: action,
  });
}

/** 把任意异常转成可直接展示的中文提示。 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return ERROR_MESSAGES.INTERNAL_ERROR;
}

export function errorCodeOf(error: unknown): ErrorCode | null {
  return error instanceof ApiError ? error.code : null;
}

export type { RoomState };
