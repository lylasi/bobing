/**
 * 实时同步层：Socket.IO 身份验证、订阅、断连计数与广播。
 *
 * - handshake `auth:{roomCode,token}` 必须验证成功才允许进入对应房间；
 *   `connect_error` 带可读中文信息与错误码。
 * - 服务端只推 `room:state`（完整公共快照 + revision），不接受客户端提交的点数；
 *   所有操作走 REST，Socket 通道不提供任何写入口。
 * - 广播统一由 room-service 在落盘成功后触发，本层只负责发送。
 */

import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { ERROR_MESSAGES, SOCKET_EVENT_ROOM_STATE } from '../shared/types.js';
import type { RoomState } from '../shared/types.js';
import { RoomService, ServiceError, normalizeRoomCode } from './room-service.js';

export function roomChannel(code: string): string {
  return `room:${code}`;
}

export interface RealtimeHub {
  io: SocketIOServer;
  broadcast(room: RoomState): void;
  connectedCount(code: string): number;
  /** 房间过期清理时断开该房间的所有连接，不遗留连接引用。 */
  disconnectRoom(code: string): void;
  close(): Promise<void>;
}

interface SocketAuth {
  roomCode?: unknown;
  token?: unknown;
}

export function attachRealtime(httpServer: HttpServer, service: RoomService): RealtimeHub {
  const io = new SocketIOServer(httpServer, {
    // 应用与 Socket 同源；不开放跨源握手，客户端脚本本身不从这里下发
    serveClient: false,
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  io.use((socket, next) => {
    try {
      const auth = (socket.handshake.auth ?? {}) as SocketAuth;
      const code = normalizeRoomCode(auth.roomCode);
      const { room, playerId } = service.authenticateMember(code, auth.token);
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
    const playerId = String(socket.data.playerId ?? '');
    void socket.join(roomChannel(roomCode));

    const snapshot = service.openConnection(roomCode, playerId);
    if (snapshot) socket.emit(SOCKET_EVENT_ROOM_STATE, snapshot);

    socket.on('disconnect', () => {
      service.closeConnection(roomCode, playerId);
    });
  });

  const broadcast = (room: RoomState): void => {
    io.to(roomChannel(room.code)).emit(SOCKET_EVENT_ROOM_STATE, room);
  };

  const connectedCount = (code: string): number => io.sockets.adapter.rooms.get(roomChannel(code))?.size ?? 0;

  const disconnectRoom = (code: string): void => {
    io.in(roomChannel(code)).disconnectSockets(true);
  };

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      io.close(() => resolve());
    });

  return { io, broadcast, connectedCount, disconnectRoom, close };
}
