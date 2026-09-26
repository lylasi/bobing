/**
 * 奖池与状元：六档余量、状元领先者金底卡。
 * 余量数字来自服务端快照，客户端不自行推算。
 */

import type { ReactElement } from 'react';
import { NORMAL_PRIZE_KEYS, PRIZE_META } from '../../shared/rules.js';
import type { RoomState } from '../../shared/types.js';
import { DiceRow } from './Dice.js';
import { championPlayer } from '../lib/format.js';

export function PrizePool({ room }: { room: RoomState }): ReactElement {
  const leader = championPlayer(room);
  return (
    <div className="prize-pool">
      <div className="panel-heading">
        <h3>奖池余量</h3>
        <span className="panel-meta">先到先得</span>
      </div>

      <div className={`champion-card ${leader ? '' : 'champion-card--empty'}`}>
        <span className="champion-title">当前状元领先者</span>
        {leader && room.champion ? (
          <>
            <span className="champion-name">{leader.nickname}</span>
            <DiceRow dice={room.champion.dice} size="xs" label={`${leader.nickname} 的状元骰子：${room.champion.dice.join('、')}`} />
            <span className="champion-label">{room.champion.result.label}</span>
          </>
        ) : (
          <span className="champion-none">暂无状元候选</span>
        )}
      </div>

      <ul className="prize-rows">
        {NORMAL_PRIZE_KEYS.map((key) => {
          const left = room.pool[key];
          const total = PRIZE_META[key].count;
          const ratio = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
          return (
            <li key={key} className={`prize-row ${left <= 0 ? 'prize-row--empty' : ''}`}>
              <span className="prize-name">{PRIZE_META[key].label}</span>
              <span className="prize-bar" aria-hidden="true">
                <span className="prize-bar-fill" style={{ width: `${ratio * 100}%` }} />
              </span>
              <span className="prize-count">
                <strong>{left}</strong>
                <span className="prize-total">/{total}</span>
              </span>
            </li>
          );
        })}
        <li className={`prize-row prize-row--champion ${room.pool.zhuangyuan <= 0 ? 'prize-row--empty' : ''}`}>
          <span className="prize-name">{PRIZE_META.zhuangyuan.label}</span>
          <span className="prize-bar" aria-hidden="true">
            <span className="prize-bar-fill" style={{ width: `${room.pool.zhuangyuan > 0 ? 100 : 0}%` }} />
          </span>
          <span className="prize-count">
            <strong>{room.pool.zhuangyuan}</strong>
            <span className="prize-total">/{PRIZE_META.zhuangyuan.count}</span>
          </span>
        </li>
      </ul>
      <p className="panel-footnote">状元奖在整局结束时发给领先者；无人夺魁则保留，本局状元空缺。</p>
    </div>
  );
}
