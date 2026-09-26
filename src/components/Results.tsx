/**
 * 结算区：最终状元（或空缺）、结束原因与未完成状态、本局奖池发放与剩余、
 * 每位玩家明细（含已离席得主，累计次数取 player.rollCount / timeoutCount），以及房主的“再开一局”。
 */

import type { ReactElement } from 'react';
import { NORMAL_PRIZE_KEYS, PRIZE_KEYS, PRIZE_META } from '../../shared/rules.js';
import type { RoomState } from '../../shared/types.js';
import {
  championLockedByLabel,
  championPlayer,
  endConditionLabel,
  finishedReasonLabel,
  playerRollCount,
  playerTimeoutCount,
  standings,
  totalAwards,
  totalInitialNormalPool,
  totalRoomRolls,
  totalRoomTimeouts,
} from '../lib/format.js';
import { DiceRow } from './Dice.js';
import { History } from './History.js';

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
  // 离席玩家（包括离席状元或获奖者）仍保留在本局战绩中，绝不过滤
  const rows = standings(room.players);
  const remainingNormal = NORMAL_PRIZE_KEYS.reduce((sum, key) => sum + room.pool[key], 0);
  const initialNormal = totalInitialNormalPool(room);
  const totalRolls = totalRoomRolls(room);
  const totalTimeouts = totalRoomTimeouts(room);
  const lockedLabel = championLockedByLabel(room);

  return (
    <div className="results">
      <section className={`result-champion ${leader ? '' : 'result-champion--empty'}`}>
        <p className="result-champion-eyebrow">
          今宵状元 · 最终状元
          {room.incomplete ? <span className="tag tag-incomplete">本局未完成</span> : null}
        </p>
        {leader && room.champion ? (
          <>
            <p className="result-champion-name">
              {leader.nickname}
              {leader.left ? <span className="tag">已离席</span> : null}
            </p>
            <DiceRow
              dice={room.champion.dice}
              size="sm"
              label={`${leader.nickname} 夺魁骰子：${room.champion.dice.join('、')}`}
            />
            <p className="result-champion-label">
              {room.champion.result.label}
              {lockedLabel ? ` · 高阶锁定（${lockedLabel}）` : ''}
              {leader.awards.zhuangyuan > 0 ? ` · 获得状元 ${leader.awards.zhuangyuan} 份` : ''}
            </p>
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
            <dd>
              {finishedReasonLabel(room.finishedReason)}
              {room.incomplete ? '（未完成）' : ''}
            </dd>
          </div>
          <div>
            <dt>系统房规</dt>
            <dd>{room.ruleset.name}</dd>
          </div>
          <div>
            <dt>结束方式</dt>
            <dd>{endConditionLabel(room.config.endCondition)}</dd>
          </div>
          <div>
            <dt>本局进度</dt>
            <dd>
              第 {room.gameNumber} 局 · 第 {Math.max(1, room.round)} 轮
            </dd>
          </div>
          <div>
            <dt>剩余普通奖</dt>
            <dd>
              {remainingNormal} / {initialNormal} 份
            </dd>
          </div>
          <div>
            <dt>剩余状元</dt>
            <dd>
              {room.pool.zhuangyuan} / {room.initialPool.zhuangyuan} 份
            </dd>
          </div>
          <div>
            <dt>累计实际投掷</dt>
            <dd>{totalRolls} 次</dd>
          </div>
          <div>
            <dt>累计超时跳过</dt>
            <dd>{totalTimeouts} 次</dd>
          </div>
          <div>
            <dt>近期记录窗口</dt>
            <dd>{room.history.length} 条（最多 240 条）</dd>
          </div>
        </dl>

        <div className="result-prizes-breakdown">
          <h3 className="field-label">各档奖品发放与剩余</h3>
          <ul className="waiting-prize-list">
            {PRIZE_KEYS.map((key) => {
              const initial = room.initialPool[key];
              const remaining = room.pool[key];
              const awarded = Math.max(0, initial - remaining);
              const content = room.config.prizes[key].content;
              return (
                <li key={key} className="waiting-prize-item">
                  <span className="waiting-prize-name">{PRIZE_META[key].label}</span>
                  <span className="waiting-prize-count">
                    已发 {awarded}/{initial} 份（剩余 {remaining} 份）
                  </span>
                  {content !== '' ? <span className="prize-content">{content}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
        <p className="panel-footnote">
          {room.incomplete
            ? '本局因中止、全员离席或离线过期而未完成，只统计实际已发出的奖品，剩余奖池如实保留。'
            : '只统计实际发出去的奖品，未领完的奖池如实展示。'}
        </p>
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
                    {player.left ? <span className="tag">已离席</span> : null}
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
                  <td>{playerRollCount(player, room.history)}</td>
                  <td>{playerTimeoutCount(player, room.history)}</td>
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
        <History history={room.history} room={room} />
      </section>
    </div>
  );
}
