/**
 * 结算区：状元（或空缺）、结束原因、每位玩家明细、实际投掷次数、剩余奖池与历史记录，
 * 以及房主的“再开一局”。
 */

import type { ReactElement } from 'react';
import { NORMAL_PRIZE_KEYS, PRIZE_META } from '../../shared/rules.js';
import type { RoomState } from '../../shared/types.js';
import { DiceRow } from './Dice.js';
import { History } from './History.js';
import {
  championPlayer,
  finishedReasonLabel,
  rollCountOf,
  standings,
  timeoutCountOf,
  totalAwards,
} from '../lib/format.js';

export interface ResultsProps {
  room: RoomState;
  playerId: string;
  isHost: boolean;
  busy: boolean;
  onRematch: () => void;
  onLeaveRequest: () => void;
}

export function Results({ room, playerId, isHost, busy, onRematch, onLeaveRequest }: ResultsProps): ReactElement {
  const leader = championPlayer(room);
  const rows = standings(room.players.filter((player) => !player.left));
  const remainingNormal = NORMAL_PRIZE_KEYS.reduce((sum, key) => sum + room.pool[key], 0);

  return (
    <div className="results">
      <section className={`result-champion ${leader ? '' : 'result-champion--empty'}`}>
        <p className="result-champion-eyebrow">今宵状元</p>
        {leader && room.champion ? (
          <>
            <p className="result-champion-name">{leader.nickname}</p>
            <DiceRow
              dice={room.champion.dice}
              size="sm"
              label={`${leader.nickname} 夺魁骰子：${room.champion.dice.join('、')}`}
            />
            <p className="result-champion-label">{room.champion.result.label}</p>
          </>
        ) : (
          <p className="result-champion-name result-champion-name--none">本局状元空缺 · 好运留待下次</p>
        )}
      </section>

      <section className="result-summary">
        <h2 className="section-title">本局小结</h2>
        <dl className="summary-grid">
          <div>
            <dt>结束原因</dt>
            <dd>{finishedReasonLabel(room.finishedReason)}</dd>
          </div>
          <div>
            <dt>每人轮数</dt>
            <dd>{room.maxRounds} 轮</dd>
          </div>
          <div>
            <dt>本局编号</dt>
            <dd>第 {room.gameNumber} 局</dd>
          </div>
          <div>
            <dt>剩余普通奖</dt>
            <dd>{remainingNormal} 份</dd>
          </div>
          <div>
            <dt>剩余状元</dt>
            <dd>{room.pool.zhuangyuan} 份</dd>
          </div>
          <div>
            <dt>本局记录</dt>
            <dd>{room.history.length} 条</dd>
          </div>
        </dl>
        <p className="panel-footnote">只统计实际发出去的奖品，未领完的奖池如实保留。</p>
      </section>

      <section className="result-players">
        <h2 className="section-title">玩家奖项明细</h2>
        <div className="table-scroll">
          <table className="standings-table">
            <caption className="visually-hidden">按状元、普通奖总数与入座顺序排列的本局明细</caption>
            <thead>
              <tr>
                <th scope="col">玩家</th>
                {NORMAL_PRIZE_KEYS.map((key) => (
                  <th scope="col" key={key}>
                    {PRIZE_META[key].label}
                  </th>
                ))}
                <th scope="col">状元</th>
                <th scope="col">合计</th>
                <th scope="col">实际投掷</th>
                <th scope="col">超时</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((player) => (
                <tr key={player.id} className={player.id === playerId ? 'is-me' : ''}>
                  <th scope="row">
                    {player.nickname}
                    {player.id === room.hostId ? <span className="tag tag-host">房主</span> : null}
                  </th>
                  {NORMAL_PRIZE_KEYS.map((key) => (
                    <td key={key} className={player.awards[key] > 0 ? 'has-award' : ''}>
                      {player.awards[key]}
                    </td>
                  ))}
                  <td className={player.awards.zhuangyuan > 0 ? 'has-champion' : ''}>{player.awards.zhuangyuan}</td>
                  <td>
                    <strong>{totalAwards(player.awards)}</strong>
                  </td>
                  <td>{rollCountOf(room.history, player.id)}</td>
                  <td>{timeoutCountOf(room.history, player.id)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="result-actions">
        {isHost ? (
          <button type="button" className="btn btn-primary btn-wide" onClick={onRematch} disabled={busy} aria-busy={busy}>
            {busy ? '正在准备新一局…' : '再开一局'}
          </button>
        ) : (
          <p className="result-wait-host">等待房主再开一局…</p>
        )}
        <button type="button" className="btn btn-secondary" onClick={onLeaveRequest} disabled={busy}>
          离开房间
        </button>
      </section>

      <section className="result-history">
        <h2 className="section-title">完整记录</h2>
        <History history={room.history} />
      </section>
    </div>
  );
}
