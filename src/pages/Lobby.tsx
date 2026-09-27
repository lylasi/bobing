/**
 * 游戏大厅页面（`/lobby`）：
 * - 顶部提供“开一桌”入口与“输入房间码”直达栏（默认 6 位数字键盘，可切换含字母旧码）；
 * - 默认筛选“可加入（joinable）”，可切换“全部（all）”、“进行中（playing）”；
 * - 点击“加入”时：若本浏览器已有该房间有效凭证则直接恢复成员身份进入，否则仅弹出昵称输入框入座；
 * - 若入座时遇到刚满员或刚开局（409），保留弹层提示并提供一键“先去旁观”入口；
 * - 网络刷新失败时保留已展示列表并提示更新失败，空列表提供明确“开一桌”引导。
 */

import { useCallback, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import {
  ACCEPTED_ROOM_CODE_LENGTH,
  isAcceptedRoomCode,
  normalizeRoomCodeText,
} from '../../shared/room-code.js';
import { NICKNAME_MAX_LENGTH } from '../../shared/rules.js';
import type { ErrorCode, LobbyRoomSummary } from '../../shared/types.js';
import { Dialog } from '../components/Dialog.js';
import { RoomCard } from '../components/RoomCard.js';
import { SiteHeader } from '../components/SiteHeader.js';
import { useLobby } from '../hooks/useLobby.js';
import type { LobbyFilter } from '../hooks/useLobby.js';
import { describeError, errorCodeOf, joinRoom } from '../lib/api.js';
import { endConditionLabel } from '../lib/format.js';
import { Link, navigate, useTitle } from '../lib/router.js';
import { loadMembership, saveMembership } from '../lib/session.js';

const FILTER_TABS: ReadonlyArray<{ key: LobbyFilter; label: string }> = [
  { key: 'joinable', label: '可加入' },
  { key: 'all', label: '全部' },
  { key: 'playing', label: '进行中' },
];

function validateNickname(value: string): string | null {
  const trimmed = value.trim();
  const count = Array.from(trimmed).length;
  if (count < 1) return '请填写昵称（1–12个字）';
  if (count > NICKNAME_MAX_LENGTH) return `昵称最多 ${NICKNAME_MAX_LENGTH} 个字`;
  return null;
}

export function Lobby(): ReactElement {
  useTitle('游戏大厅 · 月满博饼');

  const codeInputId = useId();
  const joinNicknameId = useId();

  const [filter, setFilter] = useState<LobbyFilter>('joinable');
  const { rooms, loading, refreshing, loadingMore, error, hasMore, refresh, loadMore } = useLobby(filter);

  const [quickCode, setQuickCode] = useState('');
  const [legacyCodeMode, setLegacyCodeMode] = useState(false);
  const [quickCodeError, setQuickCodeError] = useState<string | null>(null);

  const [targetRoom, setTargetRoom] = useState<LobbyRoomSummary | null>(null);
  const [nickname, setNickname] = useState('');
  const [joinSubmitting, setJoinSubmitting] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinErrorCode, setJoinErrorCode] = useState<ErrorCode | null>(null);

  const handleQuickCodeSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalized = normalizeRoomCodeText(quickCode);
    if (!isAcceptedRoomCode(normalized)) {
      setQuickCodeError('房间码是6位字母或数字，请检查后重试');
      return;
    }
    setQuickCodeError(null);
    navigate(`/room/${normalized}`);
  };

  const handleCardJoin = useCallback((room: LobbyRoomSummary): void => {
    const existing = loadMembership(room.code);
    if (existing) {
      navigate(`/room/${room.code}`);
      return;
    }
    setTargetRoom(room);
    setNickname('');
    setJoinError(null);
    setJoinErrorCode(null);
  }, []);

  const handleCardWatch = useCallback((room: LobbyRoomSummary): void => {
    const existing = loadMembership(room.code);
    if (existing) {
      navigate(`/room/${room.code}`);
      return;
    }
    navigate(`/room/${room.code}/watch`);
  }, []);

  const closeJoinDialog = useCallback((): void => {
    if (joinSubmitting) return;
    setTargetRoom(null);
    setJoinError(null);
    setJoinErrorCode(null);
  }, [joinSubmitting]);

  const submitJoinRoom = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!targetRoom || joinSubmitting) return;

    const existing = loadMembership(targetRoom.code);
    if (existing) {
      setTargetRoom(null);
      navigate(`/room/${targetRoom.code}`);
      return;
    }

    const validationError = validateNickname(nickname);
    if (validationError) {
      setJoinError(validationError);
      return;
    }

    setJoinError(null);
    setJoinErrorCode(null);
    setJoinSubmitting(true);
    try {
      const joined = await joinRoom(targetRoom.code, nickname.trim());
      saveMembership(joined.membership);
      setTargetRoom(null);
      navigate(`/room/${joined.room.code}`);
    } catch (err) {
      setJoinError(describeError(err));
      setJoinErrorCode(errorCodeOf(err));
      void refresh();
    } finally {
      setJoinSubmitting(false);
    }
  };

  const canFallbackToWatch =
    targetRoom !== null &&
    targetRoom.allowSpectators &&
    (joinErrorCode === 'ROOM_FULL' || joinErrorCode === 'ROOM_STARTED' || joinError !== null);

  return (
    <div className="page page--lobby">
      <SiteHeader current="lobby" />
      <main className="container lobby-main">
        <section className="card lobby-hero-card" aria-label="大厅操作与房间码入口">
          <div className="lobby-hero-top">
            <div className="lobby-hero-copy">
              <h1 className="lobby-title">游戏大厅</h1>
              <span className="lobby-eyebrow-tag">中秋欢聚 · 公开牌桌</span>
            </div>
            <p className="lobby-subtitle">
              挑选公开桌入席或旁观，也可输码直达亲友房。
            </p>
          </div>

          <div className="lobby-hero-bar">
            <Link to="/" className="btn btn-primary lobby-create-btn">
              开一桌
            </Link>

            <details className="lobby-code-details">
              <summary className="btn btn-secondary lobby-code-summary">
                输码直达
              </summary>
              <form className="lobby-code-form" noValidate onSubmit={handleQuickCodeSubmit}>
                <div className="lobby-code-field">
                  <div className="lobby-code-label-row">
                    <label className="field-label" htmlFor={codeInputId}>
                      输入房间码
                    </label>
                    <button
                      type="button"
                      className={`code-mode-toggle ${legacyCodeMode ? 'is-active' : ''}`}
                      aria-pressed={legacyCodeMode}
                      onClick={() => setLegacyCodeMode((prev) => !prev)}
                    >
                      {legacyCodeMode ? '切换数字键盘' : '输入旧房间码'}
                    </button>
                  </div>
                  <div className="lobby-code-input-row">
                    <input
                      id={codeInputId}
                      className="input input--code lobby-code-input"
                      value={quickCode}
                      onChange={(event) => {
                        setQuickCode(
                          normalizeRoomCodeText(event.target.value).slice(0, ACCEPTED_ROOM_CODE_LENGTH),
                        );
                        if (quickCodeError) setQuickCodeError(null);
                      }}
                      inputMode={legacyCodeMode ? 'text' : 'numeric'}
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={legacyCodeMode ? 'ABCD23' : '028416'}
                    />
                    <button type="submit" className="btn btn-secondary">
                      进入房间
                    </button>
                  </div>
                  {quickCodeError ? (
                    <p className="form-error" role="alert">
                      {quickCodeError}
                    </p>
                  ) : null}
                </div>
              </form>
            </details>
          </div>
        </section>

        <section className="lobby-content" aria-label="公开房间大厅">
          <div className="lobby-toolbar">
            <div className="lobby-filter-tabs" role="tablist" aria-label="房间状态筛选">
              {FILTER_TABS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  id={`lobby-tab-${item.key}`}
                  aria-selected={filter === item.key}
                  aria-controls="lobby-rooms-panel"
                  className={`lobby-filter-tab ${filter === item.key ? 'is-active' : ''}`}
                  onClick={() => setFilter(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="lobby-toolbar-right">
              {refreshing ? (
                <span className="lobby-refresh-status" role="status">
                  正在同步最新状态…
                </span>
              ) : null}
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => void refresh()}
                disabled={loading || refreshing}
              >
                刷新列表
              </button>
            </div>
          </div>

          {error && rooms.length > 0 ? (
            <div className="lobby-error-banner" role="alert">
              <span>列表更新失败：{error}（已为你保留当前列表）</span>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => void refresh()}
              >
                重试
              </button>
            </div>
          ) : null}

          <div
            id="lobby-rooms-panel"
            role="tabpanel"
            aria-labelledby={`lobby-tab-${filter}`}
            className="lobby-panel"
          >
            {loading && rooms.length === 0 ? (
              <section className="card lobby-state-card" role="status">
                <p className="lobby-loading-text">正在读取公开房间…</p>
              </section>
            ) : error && rooms.length === 0 ? (
              <section className="card lobby-state-card" role="alert">
                <h2 className="section-title">暂时无法加载大厅列表</h2>
                <p className="landing-status">{error}</p>
                <div className="landing-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void refresh()}
                  >
                    重试
                  </button>
                  <Link to="/" className="btn btn-secondary">
                    开一桌
                  </Link>
                </div>
              </section>
            ) : rooms.length === 0 ? (
              <section className="card lobby-state-card">
                <h2 className="section-title">
                  {filter === 'joinable'
                    ? '当前没有可加入的公开房间'
                    : filter === 'playing'
                      ? '当前没有正在进行的公开房间'
                      : '当前暂无公开房间'}
                </h2>
                <p className="landing-status">
                  {filter === 'joinable'
                    ? '你可以切换到“全部”查看正在进行的牌局，或直接自己开一桌邀请好友。'
                    : '现在去首页开一桌，创建后默认展示在大厅，好友和路人都能加入或旁观。'}
                </p>
                <div className="landing-actions">
                  {filter !== 'all' ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => setFilter('all')}
                    >
                      查看全部公开桌
                    </button>
                  ) : null}
                  <Link to="/" className="btn btn-primary">
                    开一桌
                  </Link>
                </div>
              </section>
            ) : (
              <>
                <div className="lobby-grid" role="region" aria-label="公开房间列表">
                  {rooms.map((room) => (
                    <RoomCard
                      key={room.code}
                      room={room}
                      hasMembership={loadMembership(room.code) !== null}
                      onJoin={handleCardJoin}
                      onWatch={handleCardWatch}
                    />
                  ))}
                </div>

                {hasMore ? (
                  <div className="lobby-more">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void loadMore()}
                      disabled={loadingMore}
                      aria-busy={loadingMore}
                    >
                      {loadingMore ? '正在加载更多…' : '加载更多'}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>

        <Dialog
          open={targetRoom !== null}
          title={targetRoom ? `加入「${targetRoom.name}」` : '加入房间'}
          onClose={closeJoinDialog}
          width="md"
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeJoinDialog}
                disabled={joinSubmitting}
              >
                取消
              </button>
              {canFallbackToWatch && targetRoom ? (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    const code = targetRoom.code;
                    setTargetRoom(null);
                    navigate(`/room/${code}/watch`);
                  }}
                >
                  先去旁观
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-primary"
                onClick={(event) => {
                  const form = document.getElementById('lobby-join-form') as HTMLFormElement | null;
                  if (form) {
                    form.requestSubmit();
                  } else {
                    void submitJoinRoom(event as unknown as FormEvent<HTMLFormElement>);
                  }
                }}
                disabled={joinSubmitting}
                aria-busy={joinSubmitting}
              >
                {joinSubmitting ? '正在入座…' : '加入房间'}
              </button>
            </>
          }
        >
          {targetRoom ? (
            <form id="lobby-join-form" className="form" noValidate onSubmit={(event) => void submitJoinRoom(event)}>
              <div className="lobby-join-summary">
                <span>
                  房间码：<strong className="inline-code">{targetRoom.code}</strong>
                </span>
                <span>{targetRoom.rulesetName}</span>
                <span>{endConditionLabel(targetRoom.endCondition)}</span>
                <span>
                  席位：{targetRoom.playerCount}/{targetRoom.maxPlayers}
                </span>
              </div>

              {joinError ? (
                <p className="form-error" role="alert">
                  {joinError}
                  {targetRoom.allowSpectators && (joinErrorCode === 'ROOM_FULL' || joinErrorCode === 'ROOM_STARTED')
                    ? '，你可以点击下方“先去旁观”实时观看本桌。'
                    : ''}
                </p>
              ) : null}

              <div className="form-field">
                <label className="field-label" htmlFor={joinNicknameId}>
                  你的昵称
                </label>
                <input
                  id={joinNicknameId}
                  className="input"
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  maxLength={24}
                  placeholder="例如：阿月"
                  autoComplete="nickname"
                  autoFocus
                  required
                />
                <p className="field-hint">无需重复输入房间码，填写 1–12 个字昵称即可入席。</p>
              </div>
            </form>
          ) : null}
        </Dialog>
      </main>
    </div>
  );
}
