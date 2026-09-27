/**
 * 游戏大厅列表同步 Hook：
 * - 支持 `joinable`（可加入，默认）、`all`（全部公开桌）、`playing`（进行中）三档筛选；
 * - 切换筛选立即取消未完成请求并重置列表，严格按请求序号忽略乱序过期响应；
 * - 前台可见（`document.visibilityState === 'visible'`）时每 5 秒轮询刷新已加载页数，
 *   后台标签页停止轮询，切回前台立即刷新；
 * - 刷新失败时保留已有房间列表并标注更新错误，支持手动重试；
 * - 显式使用服务端返回的 `nextCursor` 加载更多（每页 20 条）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LobbyQuery, LobbyRoomSummary } from '../../shared/types.js';
import { describeError, fetchLobby } from '../lib/api.js';

export type LobbyFilter = LobbyQuery['filter'];

export const LOBBY_PAGE_SIZE = 20;
export const LOBBY_POLL_INTERVAL_MS = 5000;

type LobbyOp = 'initial' | 'refresh' | 'loadMore' | null;

export interface UseLobbyResult {
  rooms: LobbyRoomSummary[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

function dedupeLobbyRooms(items: readonly LobbyRoomSummary[]): LobbyRoomSummary[] {
  const seen = new Set<string>();
  const result: LobbyRoomSummary[] = [];
  for (const room of items) {
    if (!room || typeof room.code !== 'string') continue;
    if (room.status !== 'waiting' && room.status !== 'playing') continue;
    if (seen.has(room.code)) continue;
    seen.add(room.code);
    result.push(room);
  }
  return result;
}

export function useLobby(filter: LobbyFilter, pageSize: number = LOBBY_PAGE_SIZE): UseLobbyResult {
  const [rooms, setRooms] = useState<LobbyRoomSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const filterRef = useRef<LobbyFilter>(filter);
  filterRef.current = filter;

  const roomsRef = useRef<LobbyRoomSummary[]>([]);
  const nextCursorRef = useRef<string | null>(null);
  const loadedPagesRef = useRef<number>(1);
  const requestSeqRef = useRef<number>(0);
  const activeOpRef = useRef<LobbyOp>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const loadPages = useCallback(
    async (targetFilter: LobbyFilter, pagesToLoad: number, mode: 'initial' | 'refresh'): Promise<void> => {
      // 慢网络保护：进行中时轮询刷新跳过，避免中断当前加载；切换 filter 或初始加载仍可中断过期请求
      if (mode === 'refresh' && activeOpRef.current !== null) {
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++requestSeqRef.current;
      activeOpRef.current = mode;

      if (mode === 'initial') {
        setLoading(true);
        setRefreshing(false);
        setLoadingMore(false);
        setError(null);
      } else {
        setRefreshing(true);
        setLoadingMore(false);
      }

      try {
        const collected: LobbyRoomSummary[] = [];
        let cursor: string | null = null;
        const count = Math.max(1, pagesToLoad);
        let pagesFetched = 0;

        for (let pageIndex = 0; pageIndex < count; pageIndex += 1) {
          const page = await fetchLobby(
            {
              filter: targetFilter,
              limit: pageSize,
              cursor,
            },
            controller.signal,
          );
          if (!mountedRef.current || controller.signal.aborted || seq !== requestSeqRef.current) {
            return;
          }
          collected.push(...page.rooms);
          cursor = page.nextCursor;
          pagesFetched += 1;
          if (cursor === null) {
            break;
          }
        }

        const merged = dedupeLobbyRooms(collected);
        roomsRef.current = merged;
        nextCursorRef.current = cursor;
        loadedPagesRef.current = Math.max(1, pagesFetched);
        activeOpRef.current = null;
        setRooms(merged);
        setNextCursor(cursor);
        setError(null);
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      } catch (err) {
        if (!mountedRef.current || controller.signal.aborted || seq !== requestSeqRef.current) {
          return;
        }
        activeOpRef.current = null;
        setError(describeError(err));
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [pageSize],
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (activeOpRef.current !== null) {
      return;
    }
    const hasLoadedAny = roomsRef.current.length > 0;
    await loadPages(
      filterRef.current,
      loadedPagesRef.current,
      hasLoadedAny ? 'refresh' : 'initial',
    );
  }, [loadPages]);

  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = nextCursorRef.current;
    if (!cursor || activeOpRef.current !== null) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++requestSeqRef.current;
    activeOpRef.current = 'loadMore';
    const currentFilter = filterRef.current;

    setLoadingMore(true);
    setRefreshing(false);
    try {
      const page = await fetchLobby(
        {
          filter: currentFilter,
          limit: pageSize,
          cursor,
        },
        controller.signal,
      );
      if (!mountedRef.current || controller.signal.aborted || seq !== requestSeqRef.current) {
        return;
      }
      const merged = dedupeLobbyRooms([...roomsRef.current, ...page.rooms]);
      roomsRef.current = merged;
      nextCursorRef.current = page.nextCursor;
      loadedPagesRef.current += 1;
      activeOpRef.current = null;
      setRooms(merged);
      setNextCursor(page.nextCursor);
      setError(null);
      setLoadingMore(false);
      setRefreshing(false);
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted || seq !== requestSeqRef.current) {
        return;
      }
      activeOpRef.current = null;
      setError(describeError(err));
      setLoadingMore(false);
      setRefreshing(false);
    }
  }, [pageSize]);

  // 切换 filter 时重置列表并拉取第一页
  useEffect(() => {
    loadedPagesRef.current = 1;
    roomsRef.current = [];
    nextCursorRef.current = null;
    setRooms([]);
    setNextCursor(null);
    void loadPages(filter, 1, 'initial');

    return () => {
      abortRef.current?.abort();
    };
  }, [filter, loadPages]);

  // 前台可见时每 5 秒轮询刷新，切回前台立即刷新（慢网络进行中跳过，不中断加载）
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      if (activeOpRef.current !== null) {
        return;
      }
      void refresh();
    }, LOBBY_POLL_INTERVAL_MS);

    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        if (activeOpRef.current !== null) {
          return;
        }
        void refresh();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh]);

  return useMemo(
    () => ({
      rooms,
      loading,
      refreshing,
      loadingMore,
      error,
      hasMore: nextCursor !== null,
      refresh,
      loadMore,
    }),
    [rooms, loading, refreshing, loadingMore, error, nextCursor, refresh, loadMore],
  );
}
