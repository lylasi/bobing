/**
 * 房间顶部栏：
 * - 等待室（waiting）：突出展示 6 位房码、“邀请亲友”、房主“房间设置”按钮与旁观人数/节奏信息；
 * - 对局中/结算后（playing/finished）：顶部收纳为紧凑单行（房名、局号、旁观数、停留秒数、连接状态与“更多”按钮），
 *   邀请、房码、规则、音效、房主“房间设置”与提前结束/离开操作统一收进“更多”面板，保留原有二次确认流程。
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { RoomState } from '../../shared/types.js';
import type { ConnectionState } from '../hooks/useRoom.js';
import { endConditionLabel } from '../lib/format.js';

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
  soundEnabled: boolean;
  viewerCount?: number;
  onToggleSound: () => void;
  onInvite: () => void;
  onRules: () => void;
  onOpenSettings?: () => void;
  onEndRequest: () => void;
  onLeaveRequest: () => void;
}

export function RoomHeader({
  room,
  connection,
  isHost,
  showHostEnd,
  soundEnabled,
  viewerCount = 0,
  onToggleSound,
  onInvite,
  onRules,
  onOpenSettings,
  onEndRequest,
  onLeaveRequest,
}: RoomHeaderProps): ReactElement {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const isWaiting = room.status === 'waiting';
  const activePlayerCount = room.players.filter((player) => !player.left).length;
  const holdSeconds = room.pacing?.resultHoldSeconds ?? 1;
  const visibilityText = room.access?.visibility === 'invite' ? '仅邀请' : '大厅公开';

  // 状态切换到等待室时自动收起更多面板
  useEffect(() => {
    if (isWaiting) {
      setMoreOpen(false);
    }
  }, [isWaiting]);

  // Esc 键可关闭更多面板，并将焦点送回“更多”按钮
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [moreOpen]);

  const renderActions = (closeOnModalAction: boolean): ReactElement => (
    <div className="room-header-actions-wrap">
      {isHost && onOpenSettings ? (
        <div className="room-header-settings">
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => {
              if (closeOnModalAction) setMoreOpen(false);
              onOpenSettings();
            }}
          >
            房间设置
          </button>
        </div>
      ) : null}
      <div className="room-header-actions">
        <button
          type="button"
          className={`btn btn-secondary btn-small ${soundEnabled ? 'btn-sound--on' : ''}`}
          aria-pressed={soundEnabled}
          aria-label={soundEnabled ? '关闭音效' : '开启音效'}
          onClick={onToggleSound}
        >
          {soundEnabled ? '关闭音效' : '开启音效'}
        </button>
        <button
          type="button"
          className={`btn ${isWaiting ? 'btn-invite-prominent' : 'btn-secondary'} btn-small`}
          onClick={() => {
            if (closeOnModalAction) setMoreOpen(false);
            onInvite();
          }}
        >
          邀请亲友
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          onClick={() => {
            if (closeOnModalAction) setMoreOpen(false);
            onRules();
          }}
        >
          规则
        </button>
        {isHost && showHostEnd ? (
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => {
              if (closeOnModalAction) setMoreOpen(false);
              onEndRequest();
            }}
          >
            提前结束
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-small"
          onClick={() => {
            if (closeOnModalAction) setMoreOpen(false);
            onLeaveRequest();
          }}
        >
          离开房间
        </button>
      </div>
    </div>
  );

  if (isWaiting) {
    return (
      <div className="room-header room-header--waiting">
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
              {activePlayerCount}/{room.maxPlayers} 人
            </span>
            <span className="room-meta-item room-viewer-badge">{viewerCount} 人旁观</span>
            <span className="room-meta-item">{endConditionLabel(room.config.endCondition)}</span>
            <span className="room-meta-item">{room.ruleset.name}</span>
            <span className="room-meta-item">停留 {holdSeconds} 秒</span>
            <span className="room-meta-item">{visibilityText}</span>
            <span className={`connection connection--${connection}`}>
              <span className="connection-dot" aria-hidden="true" />
              {CONNECTION_TEXT[connection]}
            </span>
          </div>
        </div>

        {renderActions(false)}
      </div>
    );
  }

  return (
    <div className={`room-header room-header--compact ${moreOpen ? 'is-more-open' : ''}`.trim()}>
      <div className="room-header-bar">
        <div className="room-title-row">
          <h1 className="room-title">{room.name}</h1>
          <span className="room-game">第 {room.gameNumber} 局</span>
          <span className="room-viewer-pill">{viewerCount} 人旁观</span>
          <span className="room-pacing-pill">停留 {holdSeconds} 秒</span>
          {room.closingRound !== null && room.status === 'playing' ? (
            <span className="room-closing">本轮收尾</span>
          ) : null}
          <span className={`connection connection--${connection}`}>
            <span className="connection-dot" aria-hidden="true" />
            <span className="connection-text">{CONNECTION_TEXT[connection]}</span>
          </span>
        </div>

        <button
          ref={moreButtonRef}
          type="button"
          className={`btn btn-secondary btn-small room-more-btn ${moreOpen ? 'is-active' : ''}`}
          aria-expanded={moreOpen}
          aria-controls="room-more-panel"
          onClick={() => setMoreOpen((prev) => !prev)}
        >
          更多 <span aria-hidden="true">{moreOpen ? '▴' : '⋯'}</span>
        </button>
      </div>

      {moreOpen ? (
        <div id="room-more-panel" className="room-more-panel" role="region" aria-label="房间更多信息与操作">
          <div className="room-meta room-more-meta">
            <span className="room-code" aria-label={`房间码 ${room.code}`}>
              {Array.from(room.code).map((char, index) => (
                <span key={index} className="room-code-char">
                  {char}
                </span>
              ))}
            </span>
            <span className="room-meta-item">
              {activePlayerCount}/{room.maxPlayers} 人
            </span>
            <span className="room-meta-item room-viewer-badge">{viewerCount} 人旁观</span>
            <span className="room-meta-item">{endConditionLabel(room.config.endCondition)}</span>
            <span className="room-meta-item">{room.ruleset.name}</span>
            <span className="room-meta-item">结果停留：{holdSeconds} 秒</span>
            <span className="room-meta-item">{visibilityText}</span>
          </div>
          {renderActions(true)}
        </div>
      ) : null}
    </div>
  );
}
