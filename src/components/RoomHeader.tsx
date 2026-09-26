/**
 * 房间顶部：房名、局编号、6位房码、连接状态，以及邀请/规则/结束/离开等文字按钮。
 * “提前结束”和“离开房间”放在顶部的次要区域，与底部主掷骰按钮保持距离。
 */

import type { ReactElement } from 'react';
import type { RoomState } from '../../shared/types.js';
import type { ConnectionState } from '../hooks/useRoom.js';

const CONNECTION_TEXT: Readonly<Record<ConnectionState, string>> = {
  connecting: '连接中…',
  connected: '已连接',
  disconnected: '连接断开，正在重连…',
};

export interface RoomHeaderProps {
  room: RoomState;
  connection: ConnectionState;
  isHost: boolean;
  showHostEnd: boolean;
  onInvite: () => void;
  onRules: () => void;
  onEndRequest: () => void;
  onLeaveRequest: () => void;
}

export function RoomHeader({
  room,
  connection,
  isHost,
  showHostEnd,
  onInvite,
  onRules,
  onEndRequest,
  onLeaveRequest,
}: RoomHeaderProps): ReactElement {
  return (
    <div className="room-header">
      <div className="room-header-main">
        <div className="room-title-row">
          <h1 className="room-title">{room.name}</h1>
          <span className="room-game">第 {room.gameNumber} 局</span>
        </div>
        <div className="room-meta">
          <span className="room-code" aria-label={`房间码 ${room.code}`}>
            {Array.from(room.code).map((char, index) => (
              <span key={index} className="room-code-char">
                {char}
              </span>
            ))}
          </span>
          <span className="room-meta-item">
            {room.players.filter((player) => !player.left).length}/{room.maxPlayers} 人
          </span>
          <span className="room-meta-item">每人 {room.maxRounds} 轮</span>
          <span className="room-meta-item">线上统一房规 v1</span>
          <span className={`connection connection--${connection}`}>
            <span className="connection-dot" aria-hidden="true" />
            {CONNECTION_TEXT[connection]}
          </span>
        </div>
      </div>

      <div className="room-header-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={onInvite}>
          邀请亲友
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onRules}>
          规则
        </button>
        {isHost && showHostEnd ? (
          <button type="button" className="btn btn-ghost btn-small" onClick={onEndRequest}>
            提前结束
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost btn-small" onClick={onLeaveRequest}>
          离开房间
        </button>
      </div>
    </div>
  );
}
