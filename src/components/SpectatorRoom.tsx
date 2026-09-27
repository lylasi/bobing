/**
 * 只读旁观房间组件（SpectatorRoom）：
 * - 实时展示骰碗点数（无本人旋转动画与音效）、轮次、倒计时、席位条、奖池、状元历程、完整记录与本局结算；
 * - 明确区分“参赛 / 在线 / 旁观”人数；
 * - 绝不展示“我的奖品”、“我的上一掷”、准备、开始、掷出好运、提前结束、再开一局或成员离开按钮；
 * - 等待中且有空位时提供“我要入座”，填昵称调用 join 成功后切换为正式成员视图；
 * - 进行中明确展示“本局已开始，可在下一局入座”；
 * - 收到 `room:watch-ended`（如房主关闭旁观）立即停止后续状态更新并展示原因与返回大厅入口。
 */

import { useCallback, useId, useMemo, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import {
  NICKNAME_MAX_LENGTH,
  NORMAL_PRIZE_KEYS,
  PRIZE_KEYS,
  PRIZE_META,
  TURN_DURATION_MS,
} from '../../shared/rules.js';
import type { Membership } from '../../shared/types.js';
import { useCountdown } from '../hooks/useCountdown.js';
import type { ConnectionState } from '../hooks/useRoom.js';
import { useSpectatorRoom } from '../hooks/useSpectatorRoom.js';
import { describeError, errorCodeOf, joinRoom } from '../lib/api.js';
import {
  championLockedByLabel,
  championPlayer,
  currentTurnPlayer,
  describeRoll,
  endConditionLabel,
  finishedReasonLabel,
  formatRemaining,
  latestRoll,
  playerRollCount,
  playerTimeoutCount,
  seatedPlayers,
  standings,
  totalAwards,
  totalInitialNormalPool,
  totalInitialPool,
  totalRoomRolls,
  totalRoomTimeouts,
} from '../lib/format.js';
import { Link, useTitle } from '../lib/router.js';
import { saveMembership } from '../lib/session.js';
import { Bowl } from './Bowl.js';
import { ChampionHistory } from './ChampionHistory.js';
import { Dialog } from './Dialog.js';
import { DiceRow } from './Dice.js';
import { History } from './History.js';
import { PlayerList } from './PlayerList.js';
import { PrizePool } from './PrizePool.js';
import { RulesContent } from './RulesContent.js';
import { SeatStrip } from './SeatStrip.js';

const CONNECTION_TEXT: Readonly<Record<ConnectionState, string>> = {
  connecting: '连接中…',
  connected: '已连接',
  disconnected: '连接断开，正在重连…',
};

type SpectatorTab = 'players' | 'pool' | 'history';

export interface SpectatorRoomProps {
  code: string;
  onJoinedMember: (membership: Membership) => void;
}

function validateNickname(value: string): string | null {
  const trimmed = value.trim();
  const count = Array.from(trimmed).length;
  if (count < 1) return '请填写昵称（1–12个字）';
  if (count > NICKNAME_MAX_LENGTH) return `昵称最多 ${NICKNAME_MAX_LENGTH} 个字`;
  return null;
}

export function SpectatorRoom({ code, onJoinedMember }: SpectatorRoomProps): ReactElement {
  const { room, loading, connection, audience, watchEnded, error, retry, now } = useSpectatorRoom(code);
  const [tab, setTab] = useState<SpectatorTab>('players');
  const [rulesOpen, setRulesOpen] = useState(false);

  const seatNicknameId = useId();
  const [seatDialogOpen, setSeatDialogOpen] = useState(false);
  const [seatNickname, setSeatNickname] = useState('');
  const [seatSubmitting, setSeatSubmitting] = useState(false);
  const [seatError, setSeatError] = useState<string | null>(null);

  useTitle(room ? `${room.name}（旁观） · 月满博饼` : '旁观 · 月满博饼');

  const rawRemaining = useCountdown(room?.deadline ?? null, now);
  const remaining = Math.min(rawRemaining, TURN_DURATION_MS);

  const authoritativeDice = useMemo<number[] | null>(() => {
    if (!room) return null;
    for (let i = room.history.length - 1; i >= 0; i -= 1) {
      const record = room.history[i];
      if (record && record.dice.length === 6) {
        return record.dice;
      }
    }
    return null;
  }, [room]);

  const openSeatDialog = useCallback((): void => {
    setSeatError(null);
    setSeatDialogOpen(true);
  }, []);

  const closeSeatDialog = useCallback((): void => {
    if (seatSubmitting) return;
    setSeatDialogOpen(false);
    setSeatError(null);
  }, [seatSubmitting]);

  const submitTakeSeat = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (seatSubmitting) return;
    const validationError = validateNickname(seatNickname);
    if (validationError) {
      setSeatError(validationError);
      return;
    }

    setSeatError(null);
    setSeatSubmitting(true);
    try {
      const joined = await joinRoom(code, seatNickname.trim());
      saveMembership(joined.membership);
      setSeatDialogOpen(false);
      onJoinedMember(joined.membership);
    } catch (err) {
      const errCode = errorCodeOf(err);
      const baseMsg = describeError(err);
      if (errCode === 'ROOM_FULL' || errCode === 'ROOM_STARTED') {
        setSeatError(`${baseMsg}（已为你保留旁观席位，可继续观看本桌）`);
      } else {
        setSeatError(baseMsg);
      }
    } finally {
      setSeatSubmitting(false);
    }
  };

  if (loading && !room) {
    return (
      <div className="room-view spectator-view">
        <p className="room-loading" role="status">
          正在进入旁观席…
        </p>
      </div>
    );
  }

  if (watchEnded && !room) {
    return (
      <div className="room-view spectator-view">
        <section className="card room-status-card" role="alert">
          <h1 className="section-title">
            {watchEnded.code === 'SPECTATING_DISABLED'
              ? '房主已关闭旁观'
              : watchEnded.code === 'ROOM_EXPIRED'
                ? '这桌已散席'
                : '旁观已结束'}
          </h1>
          <p className="landing-status">{watchEnded.message}</p>
          <div className="landing-actions">
            <Link className="btn btn-primary" to="/lobby">
              返回大厅
            </Link>
            <Link className="btn btn-secondary" to="/">
              回首页
            </Link>
          </div>
        </section>
      </div>
    );
  }

  if (!room && error) {
    return (
      <div className="room-view spectator-view">
        <section className="card room-status-card" role="alert">
          <h1 className="section-title">无法旁观这桌</h1>
          <p className="landing-status">{error.message}</p>
          <div className="landing-actions">
            <button type="button" className="btn btn-secondary" onClick={retry}>
              重试
            </button>
            <Link className="btn btn-primary" to="/lobby">
              返回大厅
            </Link>
            <Link className="btn btn-secondary" to="/">
              回首页
            </Link>
          </div>
        </section>
      </div>
    );
  }

  if (!room) return <div className="room-view spectator-view" />;

  const seated = seatedPlayers(room);
  const seatedCount = seated.length;
  const onlineCount = seated.filter((player) => player.online).length;
  const canTakeSeat = room.status === 'waiting' && seatedCount < room.maxPlayers && !watchEnded;
  const holdSeconds = room.pacing?.resultHoldSeconds ?? 1;

  const current = currentTurnPlayer(room);
  const shown = latestRoll(room);
  const headline = shown ? describeRoll(shown, room) : null;
  const isPresenting = room.presentation !== null;
  const waitingResultStage =
    isPresenting || (room.status === 'playing' && room.deadline === null && !room.paused);
  const urgent = !room.paused && !waitingResultStage && room.deadline !== null && remaining <= 5000;
  const roundNumber = Math.max(1, room.round);

  const turnHint = (() => {
    if (watchEnded) return watchEnded.message;
    if (connection !== 'connected') return '连接已断开，正在重连…';
    if (room.paused) return '等待玩家回来，倒计时已暂停';
    if (waitingResultStage) return '本次结果展示中，稍候开启下一掷…';
    if (current) return `等待【${current.nickname}】掷骰`;
    return '正在同步房间状态…';
  })();

  const leader = championPlayer(room);
  const lockedLabel = championLockedByLabel(room);
  const rows = standings(room.players);
  const remainingNormal = NORMAL_PRIZE_KEYS.reduce((sum, key) => sum + room.pool[key], 0);
  const initialNormal = totalInitialNormalPool(room);
  const totalRolls = totalRoomRolls(room);
  const totalTimeouts = totalRoomTimeouts(room);
  const zhuangyuanContent = room.config.prizes.zhuangyuan?.content?.trim() ?? '';

  return (
    <div className="room-view spectator-view">
      {/* 旁观顶部信息栏 */}
      <div className="room-header spectator-header">
        <div className="room-header-main">
          <div className="room-title-row">
            <h1 className="room-title">{room.name}</h1>
            <span className="room-game">第 {room.gameNumber} 局</span>
            <span className="spectator-role-pill">只读旁观</span>
          </div>
          <div className="room-meta">
            <span className="room-code" aria-label={`房间码 ${room.code}`}>
              {Array.from(room.code).map((char, index) => (
                <span key={index} className="room-code-char">
                  {char}
                </span>
              ))}
            </span>
            <span className="room-meta-item">
              参赛 {seatedCount}/{room.maxPlayers} 席
            </span>
            <span className="room-meta-item">在线 {onlineCount} 人</span>
            <span className="room-meta-item room-viewer-badge">{audience} 人旁观</span>
            <span className="room-meta-item">{endConditionLabel(room.config.endCondition)}</span>
            <span className="room-meta-item">{room.ruleset.name}</span>
            <span className="room-meta-item">结果停留：{holdSeconds} 秒</span>
            <span className={`connection connection--${watchEnded ? 'disconnected' : connection}`}>
              <span className="connection-dot" aria-hidden="true" />
              {watchEnded ? '旁观已停止' : CONNECTION_TEXT[connection]}
            </span>
          </div>
        </div>

        <div className="spectator-header-actions">
          {canTakeSeat ? (
            <button
              type="button"
              className="btn btn-primary btn-small"
              onClick={openSeatDialog}
            >
              我要入座
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => setRulesOpen(true)}
          >
            规则
          </button>
          <Link to="/lobby" className="btn btn-secondary btn-small">
            返回大厅
          </Link>
        </div>
      </div>

      {/* 旁观终止提示（房主关闭旁观 / 房间过期） */}
      {watchEnded ? (
        <section className="card spectator-ended-card" role="alert">
          <div className="spectator-ended-content">
            <h2 className="section-title">
              {watchEnded.code === 'SPECTATING_DISABLED'
                ? '房主已关闭旁观'
                : watchEnded.code === 'ROOM_EXPIRED'
                  ? '房间已过期'
                  : '旁观已结束'}
            </h2>
            <p className="landing-status">
              {watchEnded.message}。本页面已停止接收后续实时状态，你可以返回游戏大厅查看其他公开牌桌。
            </p>
          </div>
          <div className="landing-actions">
            <Link className="btn btn-primary" to="/lobby">
              返回大厅
            </Link>
            <Link className="btn btn-secondary" to="/">
              回首页
            </Link>
          </div>
        </section>
      ) : null}

      {/* 旁观转入座状态说明条 */}
      <div className="spectator-seat-banner" role="status">
        {room.status === 'waiting' ? (
          canTakeSeat ? (
            <div className="spectator-seat-banner-inner">
              <span>
                当前房间等待开局中（已入座 {seatedCount}/{room.maxPlayers} 席），填写昵称即可入座参与博饼。
              </span>
              <button
                type="button"
                className="btn btn-primary btn-small"
                onClick={openSeatDialog}
              >
                我要入座
              </button>
            </div>
          ) : (
            <div className="spectator-seat-banner-inner">
              <span>
                当前席位已满（{seatedCount}/{room.maxPlayers} 席），你正在以只读观众身份观看。
              </span>
              <Link to="/lobby" className="btn btn-secondary btn-small">
                返回大厅
              </Link>
            </div>
          )
        ) : room.status === 'playing' ? (
          <div className="spectator-seat-banner-inner">
            <span>本局已开始，可在下一局入座</span>
            <Link to="/lobby" className="btn btn-secondary btn-small">
              返回大厅
            </Link>
          </div>
        ) : (
          <div className="spectator-seat-banner-inner">
            <span>本局已结束，等待房主开启下一局后即可入座</span>
            <Link to="/lobby" className="btn btn-secondary btn-small">
              返回大厅
            </Link>
          </div>
        )}
      </div>

      {/* 等待室只读视图 */}
      {room.status === 'waiting' ? (
        <div className="waiting spectator-waiting">
          <section className="card waiting-card">
            <div className="waiting-head">
              <div>
                <h2 className="section-title">等待房主开局（旁观中）</h2>
                <p className="waiting-lead">
                  当前共有 <strong>{seatedCount}</strong> 人在席、<strong>{onlineCount}</strong> 人在线、<strong>{audience}</strong> 人旁观。
                </p>
              </div>
              {canTakeSeat ? (
                <div className="waiting-head-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={openSeatDialog}
                  >
                    我要入座
                  </button>
                </div>
              ) : null}
            </div>

            <dl className="config-list">
              <div>
                <dt>人数上限</dt>
                <dd>{room.maxPlayers} 人</dd>
              </div>
              <div>
                <dt>结束方式</dt>
                <dd>{endConditionLabel(room.config.endCondition)}</dd>
              </div>
              <div>
                <dt>系统房规</dt>
                <dd>{room.ruleset.name}</dd>
              </div>
              <div>
                <dt>结果停留</dt>
                <dd>{holdSeconds} 秒</dd>
              </div>
            </dl>

            <div className="waiting-prizes">
              <div className="waiting-prizes-head">
                <span className="field-label">本局奖品（共 {totalInitialPool(room)} 份）</span>
              </div>
              <ul className="waiting-prize-list">
                {PRIZE_KEYS.map((key) => {
                  const prize = room.config.prizes[key];
                  const content = prize.content;
                  const count = room.initialPool?.[key] ?? prize.count;
                  return (
                    <li key={key} className="waiting-prize-item">
                      <span className="waiting-prize-name">{PRIZE_META[key].label}</span>
                      <span className="waiting-prize-count">{count} 份</span>
                      {content !== '' ? <span className="prize-content">{content}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          <section className="card">
            <PlayerList room={room} playerId="" variant="seats" />
          </section>
        </div>
      ) : null}

      {/* 进行中只读视图 */}
      {room.status === 'playing' ? (
        <div className="game spectator-game">
          <SeatStrip
            room={room}
            playerId=""
            viewerCount={audience}
            onViewSeats={() => setTab('players')}
          />

          <div className={`turn-bar ${urgent ? 'turn-bar--urgent' : ''} ${waitingResultStage ? 'turn-bar--presenting' : ''}`.trim()}>
            <span className="turn-round">
              {room.config.endCondition.mode === 'rounds' ? (
                <>
                  第 <strong>{roundNumber}</strong>/{room.config.endCondition.maxRounds} 轮
                </>
              ) : (
                <>
                  第 <strong>{roundNumber}</strong> 轮
                </>
              )}
              {room.closingRound !== null ? <span className="turn-closing">本轮收尾</span> : null}
            </span>
            <span className="turn-player">
              {waitingResultStage ? (
                <>
                  本次结果：<strong>{shown?.nickname || current?.nickname || '—'}</strong>
                  <span className="tag tag-presenting">结果展示中</span>
                </>
              ) : (
                <>
                  当前玩家：<strong>{current ? current.nickname : '—'}</strong>
                </>
              )}
            </span>
            <span className={`turn-countdown ${urgent ? 'is-urgent' : ''}`} role="timer" aria-live="off">
              {room.paused
                ? '倒计时已暂停'
                : waitingResultStage
                  ? '本次结果展示中'
                  : room.deadline === null
                    ? '等待开局'
                    : `剩余 ${formatRemaining(remaining)}`}
            </span>
          </div>

          <ChampionHistory room={room} playerId="" variant="bar" />

          <div className="game-columns">
            <div
              className={`game-panel game-panel--players col-players ${tab === 'players' ? 'is-active' : ''}`}
              role="tabpanel"
              id="spectator-panel-players"
              aria-labelledby="spectator-tab-players"
            >
              <div className="card">
                <PlayerList room={room} playerId="" variant="compact" />
              </div>
            </div>

            <div className="game-panel game-panel--center col-center">
              <div className="card game-center">
                <Bowl dice={authoritativeDice} spinning={false} size="game" />
                <p className="game-hint" role="status" aria-live="polite">
                  {turnHint}
                </p>
                {headline && shown ? (
                  <p className={`game-result game-result--${headline.tone}`} aria-live="polite">
                    <span className="game-result-who">
                      本次：{shown.nickname || '已离开的玩家'}
                    </span>
                    <span className="game-result-title">{headline.title}</span>
                    {headline.detail ? <span className="game-result-detail">{headline.detail}</span> : null}
                  </p>
                ) : (
                  <p className="game-result game-result--none">骰声未起，等待第一位玩家投掷。</p>
                )}
                <p className="game-hint-note">
                  你正在旁观本桌对局（不占席位、不参与回合）。本局已开始，可在下一局入座。
                </p>
              </div>
            </div>

            <div className="game-tabs" role="tablist" aria-label="旁观对局信息">
              {(
                [
                  ['players', '玩家'],
                  ['pool', '奖池'],
                  ['history', '记录'],
                ] as ReadonlyArray<[SpectatorTab, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  id={`spectator-tab-${key}`}
                  aria-selected={tab === key}
                  aria-controls={`spectator-panel-${key}`}
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
              id="spectator-panel-pool"
              aria-labelledby="spectator-tab-pool"
            >
              <div className="card">
                <PrizePool room={room} />
              </div>
              <div className="card desktop-only-panel">
                <ChampionHistory room={room} playerId="" variant="panel" />
              </div>
            </div>
          </div>

          <div
            className={`game-panel game-panel--history col-history ${tab === 'history' ? 'is-active' : ''}`}
            role="tabpanel"
            id="spectator-panel-history"
            aria-labelledby="spectator-tab-history"
          >
            <div className="card">
              <History history={room.history} room={room} />
            </div>
          </div>
        </div>
      ) : null}

      {/* 结算只读视图 */}
      {room.status === 'finished' ? (
        <div className="results spectator-results">
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
                  {leader.awards.zhuangyuan > 0
                    ? ` · 获得状元 ${leader.awards.zhuangyuan} 份${zhuangyuanContent ? `（${zhuangyuanContent}）` : ''}`
                    : ''}
                </p>
              </>
            ) : (
              <p className="result-champion-name result-champion-name--none">本局状元空缺 · 好运留待下次</p>
            )}
          </section>

          <div className="card">
            <ChampionHistory room={room} playerId="" variant="panel" />
          </div>

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
                  第 {room.gameNumber} 局 · 第 {roundNumber} 轮
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
            </dl>
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
                    <tr key={player.id}>
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

          <section className="result-history">
            <h2 className="section-title">完整记录</h2>
            <History history={room.history} room={room} />
          </section>
        </div>
      ) : null}

      <Dialog open={rulesOpen} title={`${room.ruleset.name} · 房间规则`} onClose={() => setRulesOpen(false)} width="lg">
        <RulesContent compact room={room} />
      </Dialog>

      <Dialog
        open={seatDialogOpen}
        title={`入座「${room.name}」`}
        onClose={closeSeatDialog}
        width="md"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={closeSeatDialog}
              disabled={seatSubmitting}
            >
              继续旁观
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={(event) => {
                const form = document.getElementById('spectator-seat-form') as HTMLFormElement | null;
                if (form) {
                  form.requestSubmit();
                } else {
                  void submitTakeSeat(event as unknown as FormEvent<HTMLFormElement>);
                }
              }}
              disabled={seatSubmitting}
              aria-busy={seatSubmitting}
            >
              {seatSubmitting ? '正在入座…' : '确认入座'}
            </button>
          </>
        }
      >
        <form id="spectator-seat-form" className="form" noValidate onSubmit={(event) => void submitTakeSeat(event)}>
          <p className="spectator-seat-dialog-lead">
            入座成功后将自动退出只读旁观，并建立你的玩家席位连接。
          </p>
          {seatError ? (
            <p className="form-error" role="alert">
              {seatError}
            </p>
          ) : null}
          <div className="form-field">
            <label className="field-label" htmlFor={seatNicknameId}>
              你的昵称
            </label>
            <input
              id={seatNicknameId}
              className="input"
              value={seatNickname}
              onChange={(event) => setSeatNickname(event.target.value)}
              maxLength={24}
              placeholder="例如：小满"
              autoComplete="nickname"
              autoFocus
              required
            />
            <p className="field-hint">1–12 个字，房间内不可与在席玩家重名</p>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
