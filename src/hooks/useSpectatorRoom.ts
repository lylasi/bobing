/**
 * 只读观众状态订阅：GET `/api/rooms/:code/watch` 取权威快照 + Socket.IO `{ role: 'spectator', roomCode, viewerId }` 实时同步。
 *
 * 关键约束：
 * - 绝不发送成员 token，绝不调用 `/state` 或 `/actions`，不进入成员 presence。
 * - 只接受更高 revision 的游戏快照，断线重连先重拉权威快照再接受推送。
 * - 收到 `room:watch-ended`（房主关闭旁观、房间过期或状态不允许）立即停止重连并展示原因。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import {
  ERROR_MESSAGES,
  SOCKET_EVENT_AUDIENCE,
  SOCKET_EVENT_ROOM_STATE,
  SOCKET_EVENT_WATCH_ENDED,
} from '../../shared/types.js';
import type { AudienceState, ErrorCode, RoomState, WatchEnded } from '../../shared/types.js';
import { ApiError, fetchWatchState, serverNow } from '../lib/api.js';
import { getOrCreateViewerId } from '../lib/session.js';
import type { ConnectionState } from './useRoom.js';

export interface UseSpectatorRoomResult {
  room: RoomState | null;
  loading: boolean;
  connection: ConnectionState;
  audience: number;
  watchEnded: WatchEnded | null;
  error: ApiError | null;
  retry: () => void;
  now: () => number;
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError('protocol', error instanceof Error ? error.message : ERROR_MESSAGES.INTERNAL_ERROR);
}

function isWatchEndedCode(code: ErrorCode | null): code is WatchEnded['code'] {
  return code === 'SPECTATING_DISABLED' || code === 'ROOM_EXPIRED' || code === 'INVALID_STATE';
}

export function useSpectatorRoom(code: string): UseSpectatorRoomResult {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [audience, setAudience] = useState(1);
  const [watchEnded, setWatchEnded] = useState<WatchEnded | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const roomRef = useRef<RoomState | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const watchEndedRef = useRef<WatchEnded | null>(null);
  const generationRef = useRef<number>(0);

  useEffect(() => {
    const generation = ++generationRef.current;
    let cancelled = false;
    let generationWatchEnded = false;
    const controller = new AbortController();
    const viewerId = getOrCreateViewerId(code);
    let socket: Socket | null = null;
    let firstConnect = true;

    roomRef.current = null;
    watchEndedRef.current = null;
    setRoom(null);
    setWatchEnded(null);
    setError(null);
    setLoading(true);
    setConnection('connecting');
    setAudience(1);

    const stopSocket = (): void => {
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      if (socket) {
        socket.io.opts.reconnection = false;
        socket.disconnect();
        socket.close();
        socket = null;
      }
    };

    const markWatchEnded = (ended: WatchEnded): void => {
      if (cancelled || generation !== generationRef.current || generationWatchEnded) {
        return;
      }
      generationWatchEnded = true;
      watchEndedRef.current = ended;
      setWatchEnded(ended);
      setConnection('disconnected');
      stopSocket();
    };

    const merge = (snapshot: RoomState): void => {
      if (cancelled || generation !== generationRef.current || generationWatchEnded) {
        return;
      }
      if (!snapshot || typeof snapshot !== 'object') return;
      if (snapshot.code !== code) return;

      const current = roomRef.current;
      // 同房 revision 单调递增
      if (current && current.code === snapshot.code && snapshot.revision <= current.revision) {
        return;
      }
      roomRef.current = snapshot;
      setRoom(snapshot);
    };

    const refresh = async (): Promise<void> => {
      if (cancelled || generation !== generationRef.current || generationWatchEnded) {
        return;
      }
      try {
        const response = await fetchWatchState(code, controller.signal);
        if (cancelled || generation !== generationRef.current || generationWatchEnded) {
          return;
        }
        merge(response.room);
        setError(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted || generation !== generationRef.current || generationWatchEnded) {
          return;
        }
        const apiError = toApiError(err);
        if (isWatchEndedCode(apiError.code)) {
          markWatchEnded({ code: apiError.code, message: apiError.message });
        } else if (!roomRef.current) {
          setError(apiError);
        }
      }
    };

    const connect = (): void => {
      if (cancelled || generation !== generationRef.current || generationWatchEnded) {
        return;
      }
      const s = io({
        auth: {
          role: 'spectator',
          roomCode: code,
          viewerId,
        },
        reconnectionDelayMax: 5000,
      });
      socket = s;
      socketRef.current = s;

      s.on('connect', () => {
        if (cancelled || generation !== generationRef.current || generationWatchEnded) return;
        setConnection('connected');
        if (firstConnect) {
          firstConnect = false;
          return;
        }
        void refresh().catch(() => undefined);
      });

      s.on('disconnect', () => {
        if (cancelled || generation !== generationRef.current || generationWatchEnded) return;
        setConnection('disconnected');
      });

      s.on('connect_error', (err: Error & { data?: { code?: ErrorCode; message?: string } }) => {
        if (cancelled || generation !== generationRef.current || generationWatchEnded) return;
        setConnection('disconnected');
        const errCode = err.data?.code ?? null;
        const message = err.data?.message ?? err.message ?? ERROR_MESSAGES.INTERNAL_ERROR;
        if (isWatchEndedCode(errCode)) {
          markWatchEnded({ code: errCode, message });
          return;
        }
        if (errCode === 'ROOM_NOT_FOUND' || errCode === 'INVALID_INPUT') {
          setError(new ApiError('http', message, errCode));
          stopSocket();
        }
      });

      s.on(SOCKET_EVENT_ROOM_STATE, (snapshot: RoomState) => {
        if (cancelled || generation !== generationRef.current || generationWatchEnded) return;
        merge(snapshot);
      });

      s.on(SOCKET_EVENT_AUDIENCE, (payload: AudienceState) => {
        if (cancelled || generation !== generationRef.current || generationWatchEnded) return;
        if (payload && payload.roomCode === code && typeof payload.viewerCount === 'number') {
          setAudience(Math.max(0, payload.viewerCount));
        }
      });

      s.on(SOCKET_EVENT_WATCH_ENDED, (ended: WatchEnded) => {
        if (cancelled || generation !== generationRef.current || generationWatchEnded) return;
        if (ended) {
          markWatchEnded(ended);
        }
      });
    };

    void (async () => {
      try {
        const response = await fetchWatchState(code, controller.signal);
        if (cancelled || generation !== generationRef.current || generationWatchEnded) return;
        roomRef.current = response.room;
        setRoom(response.room);
        setError(null);
        setWatchEnded(null);
        setLoading(false);
        connect();
      } catch (err) {
        if (cancelled || controller.signal.aborted || generation !== generationRef.current || generationWatchEnded) {
          return;
        }
        setLoading(false);
        const apiError = toApiError(err);
        if (isWatchEndedCode(apiError.code)) {
          markWatchEnded({ code: apiError.code, message: apiError.message });
        } else {
          setError(apiError);
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      stopSocket();
    };
  }, [code, attempt]);

  const retry = useCallback((): void => {
    setAttempt((prev) => prev + 1);
  }, []);

  const now = useCallback(() => serverNow(), []);

  return useMemo(
    () => ({
      room,
      loading,
      connection,
      audience,
      watchEnded,
      error,
      retry,
      now,
    }),
    [room, loading, connection, audience, watchEnded, error, retry, now],
  );
}
