/**
 * 游戏大厅单桌摘要卡片（RoomCard）。
 *
 * - 展示房名、6位房间码（保留前导0）、状态、入座数/容量、在线参赛人数、系统房规与结束方式。
 * - 等待且有空位（canJoin=true）：主按钮“加入”；允许旁观时同时提供“先看看”。
 * - 满房或已开局（canJoin=false）：允许旁观时主按钮“旁观”；禁止旁观时显示不可入座状态。
 * - 本浏览器已保存该房间的成员身份时，点击“加入”直接恢复原成员身份进入房间，无需重填昵称。
 */

import type { ReactElement } from 'react';
import type { LobbyRoomSummary } from '../../shared/types.js';
import { endConditionLabel } from '../lib/format.js';

export interface RoomCardProps {
  room: LobbyRoomSummary;
  hasMembership: boolean;
  onJoin: (room: LobbyRoomSummary) => void;
  onWatch: (room: LobbyRoomSummary) => void;
}

export function RoomCard({ room, hasMembership, onJoin, onWatch }: RoomCardProps): ReactElement {
  const isPlaying = room.status === 'playing';
  const isFullWaiting = room.status === 'waiting' && !room.canJoin;

  const statusText = isPlaying ? '进行中' : isFullWaiting ? '等待中 · 已满' : '等待入席';
  const statusClass = isPlaying
    ? 'lobby-status-badge--playing'
    : isFullWaiting
      ? 'lobby-status-badge--full'
      : 'lobby-status-badge--waiting';

  return (
    <article
      className={`card lobby-room-card ${isPlaying ? 'lobby-room-card--playing' : ''}`.trim()}
      aria-label={`${room.name}（房间码 ${room.code}）`}
      data-room-code={room.code}
    >
      <div className="lobby-card-head">
        <div className="lobby-card-title-group">
          <h2 className="lobby-card-title">{room.name}</h2>
          <div className="lobby-card-badges">
            <span className={`lobby-status-badge ${statusClass}`}>{statusText}</span>
            {hasMembership ? <span className="lobby-status-badge lobby-status-badge--member">我已在席</span> : null}
          </div>
        </div>
        <span className="lobby-card-code" aria-label={`房间码 ${room.code}`}>
          房码 <strong>{room.code}</strong>
        </span>
      </div>

      <dl className="lobby-card-meta">
        <div className="lobby-card-meta-item">
          <dt>席位</dt>
          <dd>
            <strong>{room.playerCount}</strong>/{room.maxPlayers} 席
          </dd>
        </div>
        <div className="lobby-card-meta-item">
          <dt>在线参赛</dt>
          <dd>
            <strong>{room.onlinePlayerCount}</strong> 人在线
          </dd>
        </div>
        <div className="lobby-card-meta-item">
          <dt>系统房规</dt>
          <dd>{room.rulesetName}</dd>
        </div>
        <div className="lobby-card-meta-item">
          <dt>结束方式</dt>
          <dd>{endConditionLabel(room.endCondition)}</dd>
        </div>
      </dl>

      <div className="lobby-card-foot">
        <span className="lobby-card-access-hint">
          {room.allowSpectators ? '允许旁观' : '房主未开启旁观'}
        </span>

        <div className="lobby-card-actions">
          {room.canJoin ? (
            <>
              {room.allowSpectators ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => onWatch(room)}
                >
                  先看看
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={() => onJoin(room)}
              >
                加入
              </button>
            </>
          ) : (
            <>
              {hasMembership ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => onJoin(room)}
                >
                  回到我所在席位
                </button>
              ) : null}
              {room.allowSpectators ? (
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  onClick={() => onWatch(room)}
                >
                  旁观
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled
                >
                  {isPlaying ? '进行中（未开旁观）' : '席位已满'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}
