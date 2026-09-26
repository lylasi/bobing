/**
 * 对局区：桌面三栏 280/560/312，移动端单栏 + 玩家/奖池/记录三个 Tab。
 * 掷骰按钮只在“轮到自己、连接正常、未暂停、没有进行中的请求”时可用，并说明原因。
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { TURN_DURATION_MS } from '../../shared/rules.js';
import type { RollRecord, RoomState } from '../../shared/types.js';
import { Bowl } from './Bowl.js';
import { History } from './History.js';
import { PlayerList } from './PlayerList.js';
import { PrizePool } from './PrizePool.js';
import { currentTurnPlayer, describeRoll, formatRemaining, latestRoll } from '../lib/format.js';
import { useCountdown } from '../hooks/useCountdown.js';
import type { ConnectionState } from '../hooks/useRoom.js';

export interface GameBoardProps {
  room: RoomState;
  playerId: string;
  connection: ConnectionState;
  rollPending: boolean;
  spinning: boolean;
  dice: number[] | null;
  revealed: RollRecord | null;
  now: () => number;
  onRoll: () => void;
}

type GameTab = 'players' | 'pool' | 'history';

export function GameBoard({
  room,
  playerId,
  connection,
  rollPending,
  spinning,
  dice,
  revealed,
  now,
  onRoll,
}: GameBoardProps): ReactElement {
  const [tab, setTab] = useState<GameTab>('players');
  const rawRemaining = useCountdown(room.deadline, now);
  /**
   * 服务端每回合的 deadline 就是「回合开始 + TURN_DURATION_MS」，真实剩余时间不可能超过它。
   * 读数大于回合时长只可能来自 HTTP Date 秒级校时的误差（截断误差最大 1 秒），
   * 因此展示值一律钳制在 0–30 秒，绝不出现「剩余 31 秒」。
   */
  const remaining = Math.min(rawRemaining, TURN_DURATION_MS);
  const current = currentTurnPlayer(room);
  const isMyTurn = room.turnPlayerId === playerId;
  const shown = revealed ?? latestRoll(room);
  const headline = shown ? describeRoll(shown) : null;
  const urgent = !room.paused && room.deadline !== null && remaining <= 5000;
  /** 本地倒计时已到 0：立即禁用按钮并提示正在与服务端同步，最终仍以服务端裁决为准。 */
  const expired = room.deadline !== null && !room.paused && remaining <= 0;
  const rolling = rollPending || spinning;
  const canRoll =
    isMyTurn && connection === 'connected' && !rolling && !room.paused && room.status === 'playing' && !expired;

  const turnHint = (() => {
    if (connection !== 'connected') return '连接已断开，正在重连…';
    if (room.paused) return '等待玩家回来，倒计时已暂停';
    if (rolling) return '骰落瓷碗，静候佳音…';
    if (expired) return '本轮已到时，正在同步…';
    if (isMyTurn) return '轮到你了，掷出好彩头';
    if (current) return `等待【${current.nickname}】掷骰`;
    return '正在同步房间状态…';
  })();

  const rollButton = (
    <button
      type="button"
      className="btn btn-primary btn-roll"
      onClick={onRoll}
      disabled={!canRoll}
      aria-busy={rolling}
      aria-describedby="game-turn-hint"
    >
      {rolling ? '骰落瓷碗，静候佳音…' : '掷出好运'}
    </button>
  );

  return (
    <div className="game">
      <div className={`turn-bar ${urgent ? 'turn-bar--urgent' : ''}`}>
        <span className="turn-round">
          第 <strong>{Math.max(1, room.round)}</strong>/{room.maxRounds} 轮
        </span>
        <span className="turn-player">
          当前玩家：<strong>{current ? current.nickname : '—'}</strong>
          {isMyTurn ? <span className="tag tag-me">我</span> : null}
        </span>
        <span className={`turn-countdown ${urgent ? 'is-urgent' : ''}`} role="timer" aria-live="off">
          {room.paused ? '倒计时已暂停' : room.deadline === null ? '等待开局' : `剩余 ${formatRemaining(remaining)}`}
        </span>
      </div>

      <div className="game-columns">
        <div
          className={`game-panel game-panel--players col-players ${tab === 'players' ? 'is-active' : ''}`}
          role="tabpanel"
          id="game-panel-players"
          aria-labelledby="game-tab-players"
        >
          <div className="card">
            <PlayerList room={room} playerId={playerId} variant="compact" />
          </div>
        </div>

        <div className="game-panel game-panel--center col-center">
          <div className="card game-center">
            <Bowl dice={dice} spinning={spinning} size="game" />
            <p className={`game-hint ${canRoll ? 'game-hint--mine' : ''}`} id="game-turn-hint" role="status" aria-live="polite">
              {turnHint}
            </p>
            {headline && shown ? (
              <p className={`game-result game-result--${headline.tone}`} aria-live="polite">
                <span className="game-result-who">{shown.nickname || '已离开的玩家'}</span>
                <span className="game-result-title">{headline.title}</span>
                {headline.detail ? <span className="game-result-detail">{headline.detail}</span> : null}
              </p>
            ) : (
              <p className="game-result game-result--none">骰声未起，第一份好运等你开启。</p>
            )}
            <div className="action-inline">{rollButton}</div>
            {!canRoll ? (
              <p className="game-hint-note">
                {connection !== 'connected'
                  ? '离线状态不能掷骰，恢复连接后会自动同步。'
                  : room.paused
                    ? '全员离线时倒计时暂停，有人回来再继续。'
                    : expired
                      ? '本轮已到时，服务端正在结算，请稍候。'
                      : rolling
                        ? '骰子还在碗里转，停稳之前不能重复投掷。'
                        : isMyTurn
                          ? '请稍候，正在处理上一掷。'
                          : '只有当前玩家可以掷骰。'}
              </p>
            ) : null}
          </div>
        </div>

        {/*
          Tab 栏紧跟中心区：移动端用 flex order 排成
          「轮次栏 → 中心碗/提示/最新结果 → Tab → 当前面板」，桌面端整体 display:none。
          中心区不属于任何 Tab，切换 Tab 永远不会隐藏碗与最新结果。
        */}
        <div className="game-tabs" role="tablist" aria-label="对局信息">
          {(
            [
              ['players', '玩家'],
              ['pool', '奖池'],
              ['history', '记录'],
            ] as ReadonlyArray<[GameTab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`game-tab-${key}`}
              aria-selected={tab === key}
              aria-controls={`game-panel-${key}`}
              className={`game-tab ${tab === key ? 'is-active' : ''}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          className={`game-panel game-panel--pool col-pool ${tab === 'pool' ? 'is-active' : ''}`}
          role="tabpanel"
          id="game-panel-pool"
          aria-labelledby="game-tab-pool"
        >
          <div className="card">
            <PrizePool room={room} />
          </div>
        </div>
      </div>

      <div
        className={`game-panel game-panel--history col-history ${tab === 'history' ? 'is-active' : ''}`}
        role="tabpanel"
        id="game-panel-history"
        aria-labelledby="game-tab-history"
      >
        <div className="card">
          <History history={room.history} />
        </div>
      </div>

      {/* 移动端固定在底部的唯一主操作（桌面隐藏，避免出现两个同名按钮） */}
      <div className="action-bar">{rollButton}</div>
    </div>
  );
}
