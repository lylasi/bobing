/**
 * 我的上一掷 + 我的奖品汇总 + 个人状元经历。
 *
 * 核心规则：
 * 1. “我的上一掷”读取 `player.lastRoll`（服务端独立保存，不受 240 条窗口裁剪，绝不被他人后续投掷覆盖）；
 * 2. 展示奖级、具体配置的奖品内容（`config.prizes[key].content`）和实际获得份数；
 * 3. “我已获 N 份”在未结算前只计已落袋的普通奖份数，未结算状元绝不计入已获份数；
 * 4. 个人状元经历单独列出曾登顶次数（仅 `first` + `takeover`）与当前归属状态。
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { NORMAL_PRIZE_KEYS, PRIZE_META } from '../../shared/rules.js';
import type { PrizeKey, RoomState } from '../../shared/types.js';
import {
  describePersonalChampionExperience,
  describePersonalLastRoll,
  playerById,
  resolvePlayerLastRoll,
  settledAwardCountOf,
} from '../lib/format.js';
import { Dialog } from './Dialog.js';
import { DiceRow } from './Dice.js';

export interface MyRewardsProps {
  room: RoomState;
  playerId: string;
  variant?: 'inline' | 'panel';
}

export function MyRewardsDetail({
  room,
  playerId,
}: {
  room: RoomState;
  playerId: string;
}): ReactElement | null {
  const me = playerById(room, playerId);
  if (!me) return null;

  const myLastRoll = resolvePlayerLastRoll(me, room.history);
  const lastRollSummary = describePersonalLastRoll(myLastRoll, room);
  const settledTotal = settledAwardCountOf(me, room);
  const champExp = describePersonalChampionExperience(room, playerId);
  const zhuangyuanContent = room.config.prizes.zhuangyuan?.content?.trim() ?? '';
  const zhuangyuanPoolCount = room.initialPool.zhuangyuan;

  const renderTierRow = (key: PrizeKey): ReactElement => {
    const label = PRIZE_META[key].label;
    const content = room.config.prizes[key]?.content?.trim() ?? '';
    const count = me.awards[key] ?? 0;

    if (key === 'zhuangyuan') {
      const statusText =
        room.status === 'finished'
          ? count > 0
            ? `实得 ${count} 份`
            : '0 份'
          : champExp.isCurrentLeader
            ? `当前领先（终局结算后可获 ${zhuangyuanPoolCount} 份，暂不计入已获份数）`
            : '0 份（终局结算时归最终状元）';

      return (
        <li
          key={key}
          className={`my-prize-row my-prize-row--champion ${count > 0 || champExp.isCurrentLeader ? 'has-award' : ''}`.trim()}
        >
          <div className="my-prize-row-main">
            <span className="my-prize-name">{label}</span>
            <span className="my-prize-content">
              {content !== '' ? content : '未设置具体奖品内容'}
            </span>
          </div>
          <span className="my-prize-count">{statusText}</span>
        </li>
      );
    }

    return (
      <li key={key} className={`my-prize-row ${count > 0 ? 'has-award' : ''}`.trim()}>
        <div className="my-prize-row-main">
          <span className="my-prize-name">{label}</span>
          <span className="my-prize-content">
            {content !== '' ? content : '未设置具体奖品内容'}
          </span>
        </div>
        <span className="my-prize-count">
          {count > 0 ? `已获 ${count} 份` : '0 份'}
        </span>
      </li>
    );
  };

  return (
    <div className="my-rewards-detail">
      <section className="my-prizes-breakdown" aria-label="我的奖品六档汇总">
        <div className="panel-heading">
          <h3>我的奖品明细</h3>
          <span className="panel-meta">
            已获 <strong>{settledTotal}</strong> 份
            {room.status !== 'finished' ? '（不含未结算状元）' : ''}
          </span>
        </div>
        <ul className="my-prize-list">
          {renderTierRow('zhuangyuan')}
          {NORMAL_PRIZE_KEYS.map((key) => renderTierRow(key))}
        </ul>
      </section>

      <section className={`my-last-roll-card my-last-roll-card--${lastRollSummary.tone}`} aria-label="我的上一掷详情">
        <div className="my-last-roll-head">
          <span className="my-last-roll-eyebrow">我的上一掷</span>
          {myLastRoll ? <span className="my-last-roll-round">第 {myLastRoll.round} 轮</span> : null}
        </div>
        <p className="my-last-roll-headline">{lastRollSummary.headline}</p>
        <p className="my-last-roll-sub">{lastRollSummary.detail}</p>
        {myLastRoll && myLastRoll.dice.length === 6 ? (
          <div className="my-last-roll-dice">
            <DiceRow
              dice={myLastRoll.dice}
              size="xs"
              label={`我的上一掷点数：${myLastRoll.dice.join('、')}`}
            />
          </div>
        ) : null}
      </section>

      <section className="my-champion-exp" aria-label="个人状元经历">
        <details className="my-champion-details">
          <summary className="my-champion-summary" tabIndex={0}>
            <span className="my-champion-summary-title">个人状元经历</span>
            <span className="my-champion-summary-meta">
              {champExp.statusTitle} · 曾登顶 {champExp.reignCount} 次
            </span>
          </summary>
          <div className={`my-champion-box ${champExp.isCurrentLeader ? 'is-leading' : ''}`.trim()}>
            <p className="my-champion-status">{champExp.statusTitle}</p>
            <p className="my-champion-desc">{champExp.statusDetail}</p>
            {zhuangyuanContent ? (
              <p className="my-champion-prize-note">
                本局状元奖品：{zhuangyuanContent} ×{zhuangyuanPoolCount}（全部归最终状元）
              </p>
            ) : null}
            {room.championHistoryComplete === false ? (
              <p className="my-champion-legacy-note">旧局部分历程未记录</p>
            ) : null}
          </div>
        </details>
      </section>
    </div>
  );
}

export function MyRewards({
  room,
  playerId,
  variant = 'inline',
}: MyRewardsProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const me = playerById(room, playerId);
  if (!me) return null;

  const myLastRoll = resolvePlayerLastRoll(me, room.history);
  const lastRollSummary = describePersonalLastRoll(myLastRoll, room);
  const settledTotal = settledAwardCountOf(me, room);
  const champExp = describePersonalChampionExperience(room, playerId);

  if (variant === 'panel') {
    return (
      <section className="my-rewards-panel" aria-label="我的上一掷与奖品汇总">
        <MyRewardsDetail room={room} playerId={playerId} />
      </section>
    );
  }

  return (
    <>
      <section
        className={`my-rewards-inline my-rewards-inline--${lastRollSummary.tone}`}
        aria-label="我的上一掷与奖品摘要"
      >
        <div className="my-rewards-last-line">
          <span className="my-rewards-badge">本人战绩</span>
          <span className="my-rewards-label">我的上一掷：</span>
          <strong className="my-rewards-last-value">{lastRollSummary.headline}</strong>
        </div>
        {champExp.overtakenNotice ? (
          <p className="my-rewards-overtaken">{champExp.overtakenNotice}</p>
        ) : null}
        <div className="my-rewards-summary-line">
          <span className="my-rewards-total">
            我已获 <strong>{settledTotal}</strong> 份
            {champExp.shortBadge ? (
              <span className="my-rewards-champ-tag">{champExp.shortBadge}</span>
            ) : null}
          </span>
          <button
            type="button"
            className="my-rewards-open-btn"
            onClick={() => setOpen(true)}
            aria-label="查看我的奖品与状元经历"
          >
            我的奖品 <span aria-hidden="true">›</span>
          </button>
        </div>
      </section>

      <Dialog
        open={open}
        title="我的奖品与状元经历"
        onClose={() => setOpen(false)}
        width="md"
      >
        <MyRewardsDetail room={room} playerId={playerId} />
      </Dialog>
    </>
  );
}
