/**
 * 本局记录：一行一次机会，含昵称、点阵、牌型与实际发奖。
 * 超时记录没有骰子；列表仅展示最近 240 条窗口，完整累计次数独立保存在玩家统计中。
 */

import type { ReactElement } from 'react';
import type { RoomState, RollRecord } from '../../shared/types.js';
import { describeRoll } from '../lib/format.js';
import { DiceRow } from './Dice.js';

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function History({
  history,
  room = null,
  limit = 240,
}: {
  history: readonly RollRecord[];
  room?: RoomState | null;
  limit?: number;
}): ReactElement {
  const records = [...history].slice(-limit).reverse();

  return (
    <section className="history" role="region" aria-label="本局完整记录">
      <div className="panel-heading">
        <h3>本局记录</h3>
        <span className="panel-meta">最近 {records.length} 条（最多保留 240 条）</span>
      </div>
      {records.length === 0 ? (
        <p className="empty-state">骰声未起，第一份好运等你开启。</p>
      ) : (
        <ol className="record-list">
          {records.map((record) => {
            const headline = describeRoll(record, room);
            return (
              <li key={record.id} className={`record record--${headline.tone}`}>
                <span className="record-time">{formatTime(record.at)}</span>
                <span className="record-who">
                  {record.nickname || '已离开的玩家'}
                  <span className="record-round">第{record.round}轮</span>
                </span>
                <span className="record-dice">
                  {record.dice.length > 0 ? (
                    <DiceRow dice={record.dice} size="xs" label={`${record.nickname} 掷出：${record.dice.join('、')}`} />
                  ) : (
                    <span className="record-timeout">超时未掷</span>
                  )}
                </span>
                <span className="record-result">
                  <span className="record-title">{headline.title}</span>
                  {headline.detail ? <span className="record-detail">{headline.detail}</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      <p className="panel-footnote">仅显示最近 240 条记录；完整累计投掷与超时次数以玩家统计为准。</p>
    </section>
  );
}
