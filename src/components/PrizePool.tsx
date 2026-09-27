/**
 * 奖池与状元：六档余量（分母取本局 initialPool，内容取本局 config.prizes）、状元领先者金底卡。
 * 余量与锁定状态均来自服务端快照，客户端不自行推算。
 */

import type { ReactElement } from 'react';
import { NORMAL_PRIZE_KEYS, PRIZE_META } from '../../shared/rules.js';
import type { PrizeKey, RoomState } from '../../shared/types.js';
import {
  championLockedByLabel,
  championPlayer,
  championStatusTitle,
} from '../lib/format.js';
import { DiceRow } from './Dice.js';

function renderPrizeRow(room: RoomState, key: PrizeKey, isChampion = false): ReactElement {
  const content = room.config.prizes[key].content;
  const total = room.initialPool[key];
  const remaining = room.pool[key];
  const ratio = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;

  return (
    <li
      key={key}
      className={`prize-row ${isChampion ? 'prize-row--champion' : ''} ${remaining <= 0 ? 'prize-row--empty' : ''}`.trim()}
    >
      <div className="prize-row-head">
        <span className="prize-name">{PRIZE_META[key].label}</span>
        {content !== '' ? <span className="prize-content">{content}</span> : null}
      </div>
      <span className="prize-bar" aria-hidden="true">
        <span className="prize-bar-fill" style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="prize-count">
        <strong>{remaining}</strong>
        <span className="prize-total">/{total}</span>
      </span>
    </li>
  );
}

export function PrizePool({ room }: { room: RoomState }): ReactElement {
  const leader = championPlayer(room);
  const statusTitle = championStatusTitle(room);
  const lockedLabel = championLockedByLabel(room);

  return (
    <div className="prize-pool">
      <div className="panel-heading">
        <h3>奖池余量</h3>
        <span className="panel-meta">{room.ruleset.name}</span>
      </div>

      <div className={`champion-card ${leader ? '' : 'champion-card--empty'} ${room.champion?.locked ? 'champion-card--locked' : ''}`.trim()}>
        <span className="champion-title">{statusTitle}</span>
        {leader && room.champion ? (
          <>
            <span className="champion-name">
              {leader.nickname}
              {leader.left ? <span className="tag">已离席</span> : null}
            </span>
            <DiceRow
              dice={room.champion.dice}
              size="xs"
              label={`${leader.nickname} 的状元骰子：${room.champion.dice.join('、')}`}
            />
            <span className="champion-label">
              {room.champion.result.label}
              {lockedLabel ? `（触发锁定：${lockedLabel}）` : ''}
            </span>
            {room.champion.locked ? (
              <span className="champion-lock-note">状元归属已锁定，本局继续至结束时发放全部 {room.initialPool.zhuangyuan} 份状元奖</span>
            ) : null}
          </>
        ) : (
          <span className="champion-none">暂无状元候选</span>
        )}
      </div>

      <ul className="prize-rows" aria-label="六档奖品余量列表" tabIndex={0}>
        {NORMAL_PRIZE_KEYS.map((key) => renderPrizeRow(room, key, false))}
        {renderPrizeRow(room, 'zhuangyuan', true)}
      </ul>
      <p className="panel-footnote">
        状元奖（{room.initialPool.zhuangyuan} 份）在整局结束时发给唯一状元得主；无人夺魁则保留，本局状元空缺。
      </p>
    </div>
  );
}
