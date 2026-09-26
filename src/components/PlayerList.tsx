/**
 * 玩家与席位：等待区展示真实席位（空位用虚线框，不伪造昵称），
 * 对局区展示在线/准备状态与获奖进度。
 */

import type { ReactElement } from 'react';
import { PRIZE_KEYS, PRIZE_META, emptyAwards } from '../../shared/rules.js';
import type { Player, RoomState } from '../../shared/types.js';
import { seatedPlayers, totalAwards, totalNormalAwards } from '../lib/format.js';

function avatarText(nickname: string): string {
  return Array.from(nickname)[0] ?? '客';
}

export interface PlayerCardProps {
  player: Player;
  hostId: string;
  isMe: boolean;
  showAwards?: boolean;
}

export function PlayerCard({ player, hostId, isMe, showAwards = false }: PlayerCardProps): ReactElement {
  const isHost = player.id === hostId;
  const awards = player.awards ?? emptyAwards();
  const detail = PRIZE_KEYS.filter((key) => awards[key] > 0)
    .map((key) => `${PRIZE_META[key].label}×${awards[key]}`)
    .join(' ');

  return (
    <li className={`player-card ${isMe ? 'player-card--me' : ''}`}>
      <span className="player-avatar" aria-hidden="true">
        {avatarText(player.nickname)}
      </span>
      <span className="player-main">
        <span className="player-line">
          <span className="player-name">{player.nickname}</span>
          {isMe ? <span className="tag tag-me">我</span> : null}
          {isHost ? <span className="tag tag-host">房主</span> : null}
        </span>
        <span className="player-sub">
          <span className={`presence presence--${player.online ? 'online' : 'offline'}`}>
            {player.online ? '在线' : '离线'}
          </span>
          {player.ready ? <span className="player-ready">已准备</span> : <span className="player-unready">未准备</span>}
          {showAwards ? <span className="player-awards">共 {totalAwards(awards)} 份</span> : null}
        </span>
      </span>
      {showAwards && detail ? <span className="player-award-detail">{detail}</span> : null}
    </li>
  );
}

export interface PlayerListProps {
  room: RoomState;
  playerId: string;
  /** seats：等待区展示全部席位（含空位）；compact：对局/结算只显示在座成员。 */
  variant: 'seats' | 'compact';
}

export function PlayerList({ room, playerId, variant }: PlayerListProps): ReactElement {
  const players = seatedPlayers(room);
  const emptySeats = variant === 'seats' ? Math.max(0, room.maxPlayers - players.length) : 0;
  const showAwards = room.status === 'playing' || room.status === 'finished';

  return (
    <div className="player-list">
      <div className="panel-heading">
        <h3>入座玩家</h3>
        <span className="panel-meta">
          已入座 {players.length}/{room.maxPlayers}
        </span>
      </div>
      <ul className="player-cards">
        {players.map((player) => (
          <PlayerCard key={player.id} player={player} hostId={room.hostId} isMe={player.id === playerId} showAwards={showAwards} />
        ))}
        {Array.from({ length: emptySeats }, (_, index) => (
          <li key={`empty-${index}`} className="player-card player-card--empty">
            <span className="player-avatar player-avatar--empty" aria-hidden="true">
              +
            </span>
            <span className="player-empty-text">等一位好友</span>
          </li>
        ))}
      </ul>
      {room.status === 'playing' ? (
        <p className="panel-footnote">
          普通奖还剩 {totalNormalAwards(room.pool)} 份，状元 {room.pool.zhuangyuan} 份留到整局结束时颁发。
        </p>
      ) : null}
    </div>
  );
}
