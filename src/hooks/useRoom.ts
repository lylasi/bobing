/**
 * 房间状态订阅：REST 取权威快照 + Socket.IO 接收带 revision 的完整快照。
 *
 * 关键约定（product-spec 第 4、7 节）：
 *  - 先 GET 权威快照，再订阅房间；断线重连后同样先同步再依赖推送。
 *  - 只接受更高 revision 的快照，乱序/重复推送不会回退界面。
 *  - 掷骰的 requestId 在“超时/网络不确定”时保留复用，重试不会造成多投；
 *    骰子点数只来自服务端响应，客户端不生成任何结果。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { SOCKET_EVENT_AUDIENCE, SOCKET_EVENT_ROOM_STATE } from '../../shared/types.js';
import type { Action, AudienceState, ErrorCode, RoomState } from '../../shared/types.js';
import { ApiError, clockOffset, fetchRoomState, sendAction, serverNow, hasServerClock } from '../lib/api.js';
import { randomUuid } from '../lib/uuid.js';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface ActionMessage {
  code: ErrorCode | null;
  text: string;
}

export interface ActionOutcome {
  ok: boolean;
  /** 服务端返回（或本地已合并）的快照，失败时为当前已知快照。 */
  room: RoomState | null;
  error: ApiError | null;
}

export interface UseRoomResult {
  room: RoomState | null;
  playerId: string;
  loading: boolean;
  /** 终态错误：房间不存在、已过期或身份被服务端明确判为失效。 */
  fatal: ApiError | null;
  /**
   * 可恢复错误（网络中断、超时、500 等）：**不清理本机凭证**，
   * 页面展示重试入口，恢复后继续用原 playerId / token。
   */
  loadError: ApiError | null;
  /** 重新拉取权威快照并重新订阅（用于 loadError 重试）。 */
  retry: () => void;
  connection: ConnectionState;
  viewerCount: number;
  actionMessage: ActionMessage | null;
  clearActionMessage: () => void;
  busy: boolean;
  rollPending: boolean;
  /** 掷骰用的服务端时间（已按 HTTP Date 校时）。 */
  now: () => number;
  clockSynced: boolean;
  clockSkewMs: number;
  refresh: () => Promise<void>;
  runAction: (action: Action) => Promise<ActionOutcome>;
  roll: () => Promise<void>;
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError('protocol', error instanceof Error ? error.message : '暂时无法完成操作，请稍后重试');
}

/**
 * 服务端已经给出结论、重试也不会有别的结果的错误码。
 * 只有 `INVALID_TOKEN` 代表“这份身份不再有效”，可以清理本机凭证；
 * `ROOM_NOT_FOUND` / `ROOM_EXPIRED` 是这桌本身的终态。
 * 网络中断、超时、500、429 一律不算终态，必须保留身份并允许重试。
 */
const TERMINAL_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['INVALID_TOKEN', 'ROOM_NOT_FOUND', 'ROOM_EXPIRED', 'INVALID_INPUT']);

function isTerminalError(error: ApiError): boolean {
  return error.code !== null && TERMINAL_CODES.has(error.code);
}

/** 只有服务端明确回答 INVALID_TOKEN 时才允许清理本机保存的身份。 */
export function isIdentityInvalid(error: ApiError | null): boolean {
  return error !== null && error.code === 'INVALID_TOKEN';
}

export function useRoom(code: string, token: string): UseRoomResult {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [playerId, setPlayerId] = useState('');
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState<ApiError | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [viewerCount, setViewerCount] = useState(0);
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [rollPending, setRollPending] = useState(false);

  const roomRef = useRef<RoomState | null>(null);
  const playerIdRef = useRef('');
  const socketRef = useRef<Socket | null>(null);
  const connectedRef = useRef(false);
  const firstConnectRef = useRef(true);
  const rollAttemptRef = useRef<{ requestId: string; expectedTurnId: string } | null>(null);

  const merge = useCallback((snapshot: RoomState): void => {
    if (!snapshot || typeof snapshot !== 'object') return;
    const current = roomRef.current;
    if (current && current.code === snapshot.code && snapshot.revision <= current.revision) return;
    roomRef.current = snapshot;
    setRoom(snapshot);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await fetchRoomState(code, token);
      playerIdRef.current = response.playerId;
      setPlayerId(response.playerId);
      merge(response.room);
      setFatal(null);
      setLoadError(null);
    } catch (error) {
      const apiError = toApiError(error);
      if (isTerminalError(apiError)) {
        setFatal(apiError);
      } else if (!roomRef.current) {
        // 还没有任何权威快照时才需要整页重试；已有快照时靠重连推送补齐
        setLoadError(apiError);
      }
      throw apiError;
    }
  }, [code, token, merge]);

  useEffect(() => {
    let cancelled = false;
    roomRef.current = null;
    playerIdRef.current = '';
    rollAttemptRef.current = null;
    firstConnectRef.current = true;
    setRoom(null);
    setFatal(null);
    setLoadError(null);
    setActionMessage(null);
    setViewerCount(0);
    setLoading(true);
    setConnection('connecting');

    const connect = (): void => {
      const socket = io({
        auth: { roomCode: code, token },
        reconnectionDelayMax: 5000,
      });
      socketRef.current = socket;

      socket.on('connect', () => {
        connectedRef.current = true;
        setConnection('connected');
        if (firstConnectRef.current) {
          firstConnectRef.current = false;
          return;
        }
        // 断线重连：先取权威快照，再接受推送
        void refresh().catch(() => undefined);
      });

      socket.on('disconnect', () => {
        connectedRef.current = false;
        setConnection('disconnected');
      });

      socket.on('connect_error', (error: Error & { data?: { code?: ErrorCode; message?: string } }) => {
        connectedRef.current = false;
        setConnection('disconnected');
        const errorCode = error.data?.code ?? null;
        if (errorCode !== null && TERMINAL_CODES.has(errorCode)) {
          setFatal(new ApiError('http', error.data?.message ?? '你的房间身份已失效，请重新加入', errorCode));
        }
        // 其它原因（网络抖动、服务重启）只标记为断开，Socket.IO 会继续自动重连
      });

      socket.on(SOCKET_EVENT_ROOM_STATE, (snapshot: RoomState) => merge(snapshot));
      socket.on(SOCKET_EVENT_AUDIENCE, (payload: AudienceState) => {
        if (payload && payload.roomCode === code && typeof payload.viewerCount === 'number') {
          setViewerCount(Math.max(0, payload.viewerCount));
        }
      });
    };

    void (async () => {
      try {
        const response = await fetchRoomState(code, token);
        if (cancelled) return;
        playerIdRef.current = response.playerId;
        setPlayerId(response.playerId);
        roomRef.current = response.room;
        setRoom(response.room);
        setFatal(null);
        setLoadError(null);
        setLoading(false);
        // 订阅放在权威快照之后，避免订阅早期推送覆盖更新状态
        connect();
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        const apiError = toApiError(error);
        if (isTerminalError(apiError)) {
          // 服务端明确回答：这桌不存在/已过期，或这份身份已失效
          setFatal(apiError);
        } else {
          // 网络中断/超时/500：保留本机凭证与席位，展示重试，绝不回退到入房表单
          setLoadError(apiError);
        }
      }
    })();

    return () => {
      cancelled = true;
      connectedRef.current = false;
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [code, token, merge, refresh, attempt]);

  const retry = useCallback((): void => {
    setAttempt((value) => value + 1);
  }, []);

  const runAction = useCallback(
    async (action: Action): Promise<ActionOutcome> => {
      setBusy(true);
      setActionMessage(null);
      try {
        const response = await sendAction(code, token, action);
        merge(response.room);
        return { ok: true, room: response.room, error: null };
      } catch (error) {
        const apiError = toApiError(error);
        rollAttemptRef.current = null;
        if (action.type !== 'update-config' && action.type !== 'update-pacing' && action.type !== 'update-access') {
          setActionMessage({ code: apiError.code, text: apiError.message });
        }
        try {
          await refresh();
        } catch {
          // 同步失败时保留原有提示，等待下一次推送或重连
        }
        return { ok: false, room: roomRef.current, error: apiError };
      } finally {
        setBusy(false);
      }
    },
    [code, token, merge, refresh],
  );

  const roll = useCallback(async (): Promise<void> => {
    const current = roomRef.current;
    if (!current || current.status !== 'playing' || !current.turnId) return;
    if (current.turnPlayerId !== playerIdRef.current) return;
    if (!connectedRef.current) return;
    if (rollPending) return;

    const turnId = current.turnId;
    if (!rollAttemptRef.current || rollAttemptRef.current.expectedTurnId !== turnId) {
      rollAttemptRef.current = { requestId: randomUuid(), expectedTurnId: turnId };
    }
    const attempt = rollAttemptRef.current;
    setRollPending(true);
    setActionMessage(null);
    try {
      const response = await sendAction(code, token, { type: 'roll', ...attempt });
      rollAttemptRef.current = null;
      merge(response.room);
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.uncertain) {
        // 不知道服务端是否已受理：保留同一个 requestId，重复提交也只会结算一次
        setActionMessage({ code: null, text: '掷骰请求超时，已为你同步最新状态；若仍轮到你，可再次点击，不会重复投掷' });
      } else {
        rollAttemptRef.current = null;
        setActionMessage({ code: apiError.code, text: apiError.message });
      }
      try {
        await refresh();
      } catch {
        // 刷新失败时保留提示，等待重连推送
      }
    } finally {
      setRollPending(false);
    }
  }, [code, token, merge, refresh, rollPending]);

  const now = useCallback(() => serverNow(), []);
  const clearActionMessage = useCallback(() => setActionMessage(null), []);

  return useMemo(
    () => ({
      room,
      playerId,
      loading,
      fatal,
      loadError,
      retry,
      connection,
      viewerCount,
      actionMessage,
      clearActionMessage,
      busy,
      rollPending,
      now,
      clockSynced: hasServerClock(),
      clockSkewMs: clockOffset(),
      refresh,
      runAction,
      roll,
    }),
    [room, playerId, loading, fatal, loadError, retry, connection, viewerCount, actionMessage, clearActionMessage, busy, rollPending, now, refresh, runAction, roll],
  );
}
