/**
 * 顶部常驻席位条：实时显示未离席人数、在线人数、席位容量（如 4/8 席），
 * 以及按入座顺序排列的横向头像条（标识“我”、“当前”+骰子小图标、“离线”）。
 * 12 人或长昵称时在内部横向滚动，切换回合时仅在容器内横滑，绝不改变整页纵向滚动位置。
 *
 * 长昵称按字素压缩为“前2…后2”（compactSeatName），同前缀昵称仍可区分；
 * 点按/回车触发按钮后在席位条下方的唯一 .seat-full-name 状态行显示完整昵称，
 * Escape 关闭并把焦点还给触发按钮。此处只维护“展开谁的全名”这一呈现状态，
 * 不引入席位、回合或权限相关的业务状态。
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { RoomState } from '../../shared/types.js';
import { seatedPlayers } from '../lib/format.js';
import { compactSeatName } from '../lib/seat-name.js';

function avatarChar(nickname: string): string {
  return Array.from(nickname.trim())[0] ?? '客';
}

export interface SeatStripProps {
  room: RoomState;
  playerId: string;
  viewerCount?: number;
  onViewSeats?: () => void;
}

export function SeatStrip({
  room,
  playerId,
  viewerCount,
  onViewSeats,
}: SeatStripProps): ReactElement {
  const listRef = useRef<HTMLUListElement | null>(null);
  const triggerRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const baseId = useId();
  const fullNameId = `${baseId}-seat-full-name`;
  const [fullNamePlayerId, setFullNamePlayerId] = useState<string | null>(null);
  const players = seatedPlayers(room);
  const onlineCount = players.filter((player) => player.online).length;
  const activePlayerId = room.turnPlayerId;
  const isPresenting = room.presentation !== null;
  const fullNamePlayer = players.find((player) => player.id === fullNamePlayerId) ?? null;

  useEffect(() => {
    const container = listRef.current;
    if (!container || !activePlayerId) return;
    const activeNode = container.querySelector<HTMLElement>(`[data-seat-player="${activePlayerId}"]`);
    if (!activeNode) return;

    const containerRect = container.getBoundingClientRect();
    const itemRect = activeNode.getBoundingClientRect();
    const itemLeft = itemRect.left - containerRect.left + container.scrollLeft;
    const itemRight = itemLeft + itemRect.width;
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;

    if (itemLeft < viewLeft || itemRight > viewRight) {
      const targetLeft = Math.max(0, itemLeft - (container.clientWidth - itemRect.width) / 2);
      container.scrollTo({ left: targetLeft, behavior: 'smooth' });
    }
  }, [activePlayerId]);

  // 玩家离席（或不再在座）后不再保留悬空详情行
  useEffect(() => {
    if (fullNamePlayerId !== null && fullNamePlayer === null) {
      setFullNamePlayerId(null);
    }
  }, [fullNamePlayerId, fullNamePlayer]);

  // 详情行打开期间的 Escape 关闭与焦点归还。
  // 用 document 监听而不是只依赖按钮自身焦点：部分浏览器点按按钮后并不聚焦，
  // 此时 Escape 不会经过席位条，全名行就会关不掉。与 Dialog/RecentActivity 的处理方式一致。
  useEffect(() => {
    if (fullNamePlayerId === null) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setFullNamePlayerId(null);
      const trigger = triggerRefs.current.get(fullNamePlayerId);
      if (trigger && document.activeElement !== trigger) {
        trigger.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [fullNamePlayerId]);

  const setTriggerRef = (id: string, node: HTMLButtonElement | null): void => {
    if (node) triggerRefs.current.set(id, node);
    else triggerRefs.current.delete(id);
  };

  const toggleFullName = (id: string): void => {
    setFullNamePlayerId((current) => (current === id ? null : id));
  };

  return (
    <section className="seat-strip" aria-label="在座人数与当前席位">
      <div className="seat-strip-head">
        <div className="seat-strip-summary">
          <span className="seat-strip-stat">
            <strong>{players.length}</strong> 人在玩
          </span>
          <span className="seat-strip-dot" aria-hidden="true">
            ·
          </span>
          <span className="seat-strip-stat">
            <strong>{onlineCount}</strong> 人在线
          </span>
          <span className="seat-strip-cap">
            （{players.length}/{room.maxPlayers} 席）
          </span>
          {typeof viewerCount === 'number' && viewerCount > 0 ? (
            <span className="seat-strip-viewers">{viewerCount} 人旁观</span>
          ) : null}
        </div>
        {onViewSeats ? (
          <button type="button" className="seat-strip-more" onClick={onViewSeats}>
            查看席位
          </button>
        ) : null}
      </div>

      <ul className="seat-strip-list" ref={listRef} aria-label="入座玩家头像条">
        {players.map((player) => {
          const isMe = player.id === playerId;
          const isCurrent = player.id === activePlayerId;
          const isFullNameOpen = player.id === fullNamePlayerId;
          const stateSuffix = [
            isMe ? '（我）' : '',
            isCurrent ? (isPresenting ? '（本次结果）' : '（当前出手）') : '',
            !player.online ? '（离线）' : '',
          ].join('');
          const classes = [
            'seat-chip',
            isCurrent ? 'seat-chip--current' : '',
            isMe ? 'seat-chip--me' : '',
            !player.online ? 'seat-chip--offline' : '',
            isFullNameOpen ? 'seat-chip--open' : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <li key={player.id} className={classes} data-seat-player={player.id}>
              <button
                type="button"
                className="seat-chip-trigger"
                ref={(node) => {
                  setTriggerRef(player.id, node);
                }}
                aria-label={
                  isFullNameOpen
                    ? `${player.nickname}，收起完整昵称${stateSuffix}`
                    : `${player.nickname}，查看完整昵称${stateSuffix}`
                }
                aria-expanded={isFullNameOpen}
                aria-controls={isFullNameOpen ? fullNameId : undefined}
                title={player.nickname}
                onClick={() => toggleFullName(player.id)}
              >
                <span className="seat-chip-avatar" aria-hidden="true">
                  {avatarChar(player.nickname)}
                </span>
                <span className="seat-chip-name">{compactSeatName(player.nickname)}</span>
              </button>
              {isMe ? <span className="seat-chip-badge seat-chip-badge--me">我</span> : null}
              {isCurrent ? (
                <span className="seat-chip-badge seat-chip-badge--current">
                  <span className="seat-chip-dice-icon" aria-hidden="true">
                    🎲
                  </span>
                  {isPresenting ? '本次结果' : '当前'}
                </span>
              ) : null}
              {!player.online ? <span className="seat-chip-badge seat-chip-badge--offline">离线</span> : null}
            </li>
          );
        })}
      </ul>

      {fullNamePlayer ? (
        <p id={fullNameId} className="seat-full-name" role="status">
          <span className="seat-full-name-prefix">完整昵称</span>
          <span className="seat-full-name-value">{fullNamePlayer.nickname}</span>
        </p>
      ) : null}
    </section>
  );
}
