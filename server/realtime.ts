/**
 * 实时同步层：Socket.IO 身份验证、成员与观众两条订阅路径、断连计数与广播。
 *
 * - handshake `auth:{roomCode,token}` 保持成员语义：必须验证成功才允许进入成员频道；
 *   `connect_error` 带可读中文信息与错误码。
 * - 新增显式旁观握手 `auth:{role:'spectator',roomCode,viewerId}`：不需要成员凭证，
 *   viewerId 只是浏览器自己生成、仅用于同一访客多连接去重的标识，绝不是权限。
 *   未知 role 一律拒绝；成员凭证校验失败也不会被降级成旁观。
 * - 成员频道 `room:<code>`，观众频道 `room:<code>:spectators`；两者接收同一份权威游戏快照
 *   （`room:state`）。观众人数走独立事件 `room:audience`，不计入游戏 revision。
 * - 观众连接不进入成员 presence：不占席位、不保活、不参与暂停/恢复与房主转交。
 * - 关闭旁观或房间不再允许观看时，先给观众发 `room:watch-ended` 再断开；之后不再推快照。
 *   房间被清理（离线过期等）同样先说明原因再断开两个频道。
 * - 成员与观众初连都会立刻收到当前 `room:audience`，不必等到下一次人数变化。
 * - 服务端只推快照，不接受客户端提交的点数；所有写操作走 REST。
 */

import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import {
  ERROR_MESSAGES,
  SOCKET_EVENT_AUDIENCE,
  SOCKET_EVENT_ROOM_STATE,
  SOCKET_EVENT_WATCH_ENDED,
} from '../shared/types.js';
import type { AudienceState, RoomState, WatchEnded } from '../shared/types.js';
import { RoomService, ServiceError, isUuid, normalizeRoomCode } from './room-service.js';

export function roomChannel(code: string): string {
  return `room:${code}`;
}

/** 观众频道：与成员频道分开，成员广播与观众广播各自可控。 */
export function spectatorChannel(code: string): string {
  return `room:${code}:spectators`;
}

export interface RealtimeHub {
  io: SocketIOServer;
  broadcast(room: RoomState): void;
  connectedCount(code: string): number;
  /** 当前房间的去重观众数（同一 viewerId 多个连接算一位访客）。 */
  audienceCount(code: string): number;
  /** 房间过期清理时断开该房间的成员与观众连接，不遗留连接引用。 */
  disconnectRoom(code: string): void;
  close(): Promise<void>;
}

interface SocketAuth {
  role?: unknown;
  roomCode?: unknown;
  token?: unknown;
  viewerId?: unknown;
}

export function attachRealtime(httpServer: HttpServer, service: RoomService): RealtimeHub {
  const io = new SocketIOServer(httpServer, {
    // 应用与 Socket 同源；不开放跨源握手，客户端脚本本身不从这里下发
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  /**
   * 观众连接引用计数：房间 -> viewerId -> socketId 集合。
   * 同一浏览器开多个标签页（同 viewerId）按一位访客计算；与成员 presence 完全独立。
   */
  const spectatorConnections = new Map<string, Map<string, Set<string>>>();

  const addSpectator = (code: string, viewerId: string, socketId: string): void => {
    const viewers = spectatorConnections.get(code) ?? new Map<string, Set<string>>();
    const connections = viewers.get(viewerId) ?? new Set<string>();
    connections.add(socketId);
    viewers.set(viewerId, connections);
    spectatorConnections.set(code, viewers);
  };

  const removeSpectator = (code: string, viewerId: string, socketId: string): void => {
    const viewers = spectatorConnections.get(code);
    const connections = viewers?.get(viewerId);
    if (!viewers || !connections) return;
    connections.delete(socketId);
    if (connections.size === 0) viewers.delete(viewerId);
    if (viewers.size === 0) spectatorConnections.delete(code);
  };

  const viewerCount = (code: string): number => spectatorConnections.get(code)?.size ?? 0;

  const emitAudience = (code: string): void => {
    const payload: AudienceState = { roomCode: code, viewerCount: viewerCount(code) };
    io.to(roomChannel(code)).emit(SOCKET_EVENT_AUDIENCE, payload);
    io.to(spectatorChannel(code)).emit(SOCKET_EVENT_AUDIENCE, payload);
  };

  /** 关闭旁观：先把原因发给观众，再断开他们的连接，之后不再推任何快照。 */
  const closeSpectators = (code: string, ended: WatchEnded): void => {
    const channel = spectatorChannel(code);
    io.to(channel).emit(SOCKET_EVENT_WATCH_ENDED, ended);
    spectatorConnections.delete(code);
    io.in(channel).disconnectSockets(true);
    // 观众已经全部离开，人数归零要让成员看到
    io.to(roomChannel(code)).emit(SOCKET_EVENT_AUDIENCE, { roomCode: code, viewerCount: 0 } satisfies AudienceState);
  };

  io.use((socket, next) => {
    try {
      const auth = (socket.handshake.auth ?? {}) as SocketAuth;
      const role = auth.role;
      if (role !== undefined && role !== 'member' && role !== 'spectator') {
        const failure = new Error('未知的连接角色') as Error & { data?: unknown };
        failure.data = { code: 'INVALID_INPUT', message: '未知的连接角色' };
        next(failure);
        return;
      }
      const code = normalizeRoomCode(auth.roomCode);
      if (role === 'spectator') {
        // viewerId 只用于计数，不提供任何权限；必须是 UUID
        if (!isUuid(auth.viewerId)) {
          const failure = new Error('观众标识不合法') as Error & { data?: unknown };
          failure.data = { code: 'INVALID_INPUT', message: '观众标识不合法' };
          next(failure);
          return;
        }
        service.watch(code);
        socket.data.role = 'spectator';
        socket.data.roomCode = code;
        socket.data.viewerId = auth.viewerId;
        next();
        return;
      }
      const { room, playerId } = service.authenticateMember(code, auth.token);
      socket.data.role = 'member';
      socket.data.roomCode = room.code;
      socket.data.playerId = playerId;
      next();
    } catch (error) {
      const code = error instanceof ServiceError ? error.code : 'INTERNAL_ERROR';
      const message = error instanceof ServiceError ? error.message : ERROR_MESSAGES.INTERNAL_ERROR;
      const failure = new Error(message) as Error & { data?: unknown };
      failure.data = { code, message };
      next(failure);
    }
  });

  io.on('connection', (socket) => {
    const roomCode = String(socket.data.roomCode ?? '');
    const role = socket.data.role === 'spectator' ? 'spectator' : 'member';

    if (role === 'spectator') {
      const viewerId = String(socket.data.viewerId ?? '');
      // 握手与入频道之间房主可能刚关闭旁观：这里再读一次当前状态，避免漏判
      let snapshot: RoomState;
      try {
        snapshot = service.watch(roomCode);
      } catch (error) {
        const ended: WatchEnded = {
          code: error instanceof ServiceError && error.code === 'ROOM_EXPIRED' ? 'ROOM_EXPIRED' : error instanceof ServiceError && error.code === 'SPECTATING_DISABLED' ? 'SPECTATING_DISABLED' : 'INVALID_STATE',
          message: error instanceof Error ? error.message : ERROR_MESSAGES.INVALID_STATE,
        };
        socket.emit(SOCKET_EVENT_WATCH_ENDED, ended);
        socket.disconnect(true);
        return;
      }
      void socket.join(spectatorChannel(roomCode));
      addSpectator(roomCode, viewerId, socket.id);
      socket.emit(SOCKET_EVENT_ROOM_STATE, snapshot);
      // 初连发当前人数，并让全体成员/观众同步
      emitAudience(roomCode);
      socket.on('disconnect', () => {
        removeSpectator(roomCode, viewerId, socket.id);
        emitAudience(roomCode);
      });
      return;
    }

    const playerId = String(socket.data.playerId ?? '');
    void socket.join(roomChannel(roomCode));

    const snapshot = service.openConnection(roomCode, playerId);
    if (snapshot) socket.emit(SOCKET_EVENT_ROOM_STATE, snapshot);
    // 初连立刻告诉这位成员当前旁观人数：人数变化事件只发增量，
    // 重连或刚进房间的成员不能等到下一次变化才知道有人在看。
    socket.emit(SOCKET_EVENT_AUDIENCE, { roomCode, viewerCount: viewerCount(roomCode) } satisfies AudienceState);

    socket.on('disconnect', () => {
      service.closeConnection(roomCode, playerId);
    });
  });

  const broadcast = (room: RoomState): void => {
    // 成员始终收到权威快照
    io.to(roomChannel(room.code)).emit(SOCKET_EVENT_ROOM_STATE, room);
    const allowed = room.access.allowSpectators && room.status !== 'closed';
    if (allowed) {
      io.to(spectatorChannel(room.code)).emit(SOCKET_EVENT_ROOM_STATE, room);
      return;
    }
    // 已经不允许旁观（房主关闭或房间关闭）：先发 watch-ended 再断开，不把新快照推给已撤销的观众
    if (viewerCount(room.code) > 0) {
      closeSpectators(room.code, {
        code: room.status === 'closed' ? 'INVALID_STATE' : 'SPECTATING_DISABLED',
        message: room.status === 'closed' ? '房间已关闭' : ERROR_MESSAGES.SPECTATING_DISABLED,
      });
    }
  };

  const connectedCount = (code: string): number => io.sockets.adapter.rooms.get(roomChannel(code))?.size ?? 0;

  const disconnectRoom = (code: string): void => {
    // 房间已被清理（例如离线过期）：先说明原因再断开观众，不留下静默失效的订阅
    if (viewerCount(code) > 0) {
      io.to(spectatorChannel(code)).emit(SOCKET_EVENT_WATCH_ENDED, {
        code: 'ROOM_EXPIRED',
        message: ERROR_MESSAGES.ROOM_EXPIRED,
      } satisfies WatchEnded);
    }
    spectatorConnections.delete(code);
    io.in(spectatorChannel(code)).disconnectSockets(true);
    io.in(roomChannel(code)).disconnectSockets(true);
  };

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      io.close(() => resolve());
    });

  return { io, broadcast, connectedCount, audienceCount: viewerCount, disconnectRoom, close };
}
