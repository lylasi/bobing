/**
 * 当前状元常驻一行摘要 + 本局完整状元历程（championEvents）。
 * 覆盖首次登顶（first）、顶替夺魁（takeover）、原领先者刷新成绩（improved）、高阶锁定（locked）与终局实发（settled），
 * 并在旧局迁移快照（championHistoryComplete === false）时明确说明“旧局部分历程未记录”。
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import type { RoomState } from '../../shared/types.js';
import {
  championLockedByLabel,
  championPlayer,
  championStatusTitle,
  describeChampionEvent,
} from '../lib/format.js';
import { DiceRow } from './Dice.js';
import { Dialog } from './Dialog.js';

function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface ChampionHistoryProps {
  room: RoomState;
  playerId: string;
  variant?: 'bar' | 'panel';
}

export function ChampionHistoryContent({
  room,
  playerId,
}: {
  room: RoomState;
  playerId: string;
}): ReactElement {
  const leader = championPlayer(room);
  const statusTitle = championStatusTitle(room);
  const lockedLabel = championLockedByLabel(room);
  const events = room.championEvents ?? [];
  const historyComplete = room.championHistoryComplete !== false;
  const prizeContent = room.config.prizes.zhuangyuan?.content?.trim() ?? '';
  const initialCount = room.initialPool.zhuangyuan;

  return (
    <div className="champion-history-detail">
      <div className={`champion-banner ${leader ? '' : 'champion-banner--empty'} ${room.champion?.locked ? 'champion-banner--locked' : ''}`.trim()}>
        <div className="champion-banner-head">
          <span className="champion-banner-status">{statusTitle}</span>
          <span className="champion-banner-prize">
            状元奖 {initialCount} 份{prizeContent ? ` · ${prizeContent}` : ''}
          </span>
        </div>
        {leader && room.champion ? (
          <div className="champion-banner-body">
            <div className="champion-banner-who">
              <strong className="champion-banner-name">{leader.nickname}</strong>
              {leader.id === playerId ? <span className="tag tag-me">我</span> : null}
              {leader.left ? <span className="tag">已离席</span> : null}
              <span className="champion-banner-hand">
                {room.champion.result.label}
                {lockedLabel ? `（高阶锁定：${lockedLabel}）` : ''}
              </span>
            </div>
            <DiceRow
              dice={room.champion.dice}
              size="xs"
              label={`${leader.nickname} 当前状元骰子：${room.champion.dice.join('、')}`}
            />
          </div>
        ) : (
          <p className="champion-banner-empty">本局暂无状元候选，掷出四红及以上状元牌型即可登榜。</p>
        )}
      </div>

      {!historyComplete ? (
        <p className="champion-incomplete-note" role="note">
          旧局部分历程未记录：以下仅展示能证实的状元事实，不根据个人最佳牌型推算曾登顶经历。再开一局后将完整记录。
        </p>
      ) : null}

      <div className="champion-events-section">
        <div className="panel-heading">
          <h3>状元更迭历程</h3>
          <span className="panel-meta">共 {events.length} 次记录</span>
        </div>

        {events.length === 0 ? (
          <p className="empty-state">
            {leader && !historyComplete
              ? `当前可证实领先者为 ${leader.nickname}（${room.champion?.result.label ?? '状元'}），更早的更迭事件未在旧局快照中保存。`
              : '本局尚无状元更迭事件。'}
          </p>
        ) : (
          <ol className="champion-timeline" aria-label="本局状元事件序列" tabIndex={0}>
            {events.map((event, index) => {
              const desc = describeChampionEvent(event, room);
              const isMe = event.playerId === playerId;
              return (
                <li
                  key={event.id}
                  className={`champion-event champion-event--${event.kind} ${event.locked ? 'champion-event--locked' : ''}`.trim()}
                >
                  <div className="champion-event-head">
                    <span className="champion-event-step">#{index + 1}</span>
                    <span className={`champion-event-tag champion-event-tag--${event.kind}`}>
                      {desc.tag}
                    </span>
                    {isMe ? <span className="tag tag-me">我</span> : null}
                    <span className="champion-event-meta">
                      第 {event.round} 轮 · {formatClock(event.at)}
                    </span>
                  </div>
                  <p className="champion-event-title">{desc.title}</p>
                  <p className="champion-event-detail">{desc.detail}</p>
                  {event.dice.length > 0 ? (
                    <div className="champion-event-dice">
                      <DiceRow
                        dice={event.dice}
                        size="xs"
                        label={`${event.nickname} 状元事件骰子：${event.dice.join('、')}`}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

export function ChampionHistory({
  room,
  playerId,
  variant = 'bar',
}: ChampionHistoryProps): ReactElement {
  const [open, setOpen] = useState(false);
  const leader = championPlayer(room);
  const events = room.championEvents ?? [];
  const historyComplete = room.championHistoryComplete !== false;
  const prizeContent = room.config.prizes.zhuangyuan?.content?.trim() ?? '';

  if (variant === 'panel') {
    return (
      <section className="champion-history-panel" aria-label="状元历程">
        <ChampionHistoryContent room={room} playerId={playerId} />
      </section>
    );
  }

  const labelPrefix = room.status === 'finished' ? '最终状元：' : '当前状元：';

  return (
    <>
      <div className={`champion-bar ${leader ? 'champion-bar--has-leader' : 'champion-bar--empty'} ${room.champion?.locked ? 'champion-bar--locked' : ''}`.trim()}>
        <div className="champion-bar-main">
          <span className="champion-bar-prefix">{labelPrefix}</span>
          {leader && room.champion ? (
            <span className="champion-bar-value">
              <strong>{leader.nickname}</strong>
              {leader.id === playerId ? <span className="tag tag-me">我</span> : null}
              <span className="champion-bar-dot" aria-hidden="true">
                ·
              </span>
              <span className="champion-bar-hand">{room.champion.result.label}</span>
              {room.champion.locked ? <span className="champion-bar-lock">已锁定</span> : null}
              {prizeContent ? <span className="champion-bar-prize">（{prizeContent}）</span> : null}
            </span>
          ) : (
            <span className="champion-bar-none">虚位以待 · 尚无状元候选</span>
          )}
          {!historyComplete ? (
            <span className="champion-bar-legacy">旧局部分历程未记录</span>
          ) : null}
        </div>
        <button
          type="button"
          className="champion-bar-btn"
          onClick={() => setOpen(true)}
          aria-label="查看本局状元历程"
        >
          历程{events.length > 0 ? ` (${events.length})` : ''} <span aria-hidden="true">›</span>
        </button>
      </div>

      <Dialog
        open={open}
        title="本局状元历程"
        onClose={() => setOpen(false)}
        width="md"
      >
        <ChampionHistoryContent room={room} playerId={playerId} />
      </Dialog>
    </>
  );
}
