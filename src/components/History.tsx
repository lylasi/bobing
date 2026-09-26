/**
 * 本局记录：一行一次机会，含昵称、点阵、牌型与实际发奖。
 * 超时记录没有骰子；最多展示服务端保留的上限条数，列表自身滚动。
 */

import type { ReactElement } from 'react';
import type { RollRecord } from '../../shared/types.js';
import { DiceRow } from './Dice.js';
import { describeRoll } from '../lib/format.js';

function formatTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function History({ history, limit = 240 }: { history: readonly RollRecord[]; limit?: number }): ReactElement {
  const records = [...history].slice(-limit).reverse();

  return (
    <div className="history">
      <div className="panel-heading">
        <h3>本局记录</h3>
        <span className="panel-meta">{history.length} 条</span>
      </div>
      {records.length === 0 ? (
        <p className="empty-state">骰声未起，第一份好运等你开启。</p>
      ) : (
        <ol className="record-list">
          {records.map((record) => {
            const headline = describeRoll(record);
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
    </div>
  );
}
