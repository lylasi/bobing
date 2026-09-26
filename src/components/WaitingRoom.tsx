/**
 * 等待区：房码与邀请、真实席位、准备/开始按钮及未满足条件的原因说明。
 */

import type { ReactElement } from 'react';
import type { RoomState } from '../../shared/types.js';
import { PlayerList } from './PlayerList.js';
import { startBlockedReason } from '../lib/format.js';

export interface WaitingRoomProps {
  room: RoomState;
  playerId: string;
  isHost: boolean;
  busy: boolean;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onInvite: () => void;
}

export function WaitingRoom({ room, playerId, isHost, busy, onReady, onStart, onInvite }: WaitingRoomProps): ReactElement {
  const me = room.players.find((player) => player.id === playerId) ?? null;
  const ready = me?.ready ?? false;
  const blockedReason = startBlockedReason(room);
  const seated = room.players.filter((player) => !player.left).length;

  return (
    <div className="waiting">
      <section className="card waiting-card">
        <div className="waiting-head">
          <div>
            <h2 className="section-title">等好友入席</h2>
            <p className="waiting-lead">
              把房间码 <strong className="inline-code">{room.code}</strong> 或邀请链接发给亲友，无需注册即可加入。
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={onInvite}>
            邀请亲友
          </button>
        </div>

        <dl className="config-list">
          <div>
            <dt>人数上限</dt>
            <dd>{room.maxPlayers} 人</dd>
          </div>
          <div>
            <dt>每人轮数</dt>
            <dd>{room.maxRounds} 轮</dd>
          </div>
          <div>
            <dt>房规</dt>
            <dd>线上统一房规 v1</dd>
          </div>
          <div>
            <dt>当前人数</dt>
            <dd>{seated} 人</dd>
          </div>
        </dl>

        <div className="waiting-actions">
          <button
            type="button"
            className={ready ? 'btn btn-secondary btn-wide' : 'btn btn-primary btn-wide'}
            onClick={() => onReady(!ready)}
            disabled={busy}
            aria-busy={busy}
            aria-pressed={ready}
          >
            {ready ? '取消准备' : '准备好了'}
          </button>

          {isHost ? (
            <div className="start-block">
              <button
                type="button"
                className="btn btn-primary btn-wide"
                onClick={onStart}
                disabled={busy || blockedReason !== null}
                aria-busy={busy}
                title={blockedReason ?? '开始博饼'}
              >
                {busy ? '正在开局…' : '开始博饼'}
              </button>
              {blockedReason ? (
                <p className="start-blocked" role="status">
                  {blockedReason}
                </p>
              ) : (
                <p className="start-ready">人数与准备都齐了，可以开局。</p>
              )}
            </div>
          ) : (
            <p className="waiting-host-hint">等待房主开始博饼。</p>
          )}
        </div>
      </section>

      <section className="card">
        <PlayerList room={room} playerId={playerId} variant="seats" />
      </section>
    </div>
  );
}
