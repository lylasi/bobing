/**
 * 邀请落地页：先读房间真实概况（含系统房规、结束方式、奖品配置），再输入昵称加入。
 * 已开局 / 已结束 / 已满 / 已过期 / 不存在都给出对应说明与回首页入口，
 * 不会静默新建一个本地房间。
 */

import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { NICKNAME_MAX_LENGTH, PRIZE_KEYS, PRIZE_META } from '../../shared/rules.js';
import type { Membership, RoomPreview } from '../../shared/types.js';
import { ApiError, describeError, joinRoom, previewRoom } from '../lib/api.js';
import { endConditionLabel, totalConfiguredPrizes } from '../lib/format.js';
import { Link, navigate } from '../lib/router.js';
import { saveMembership } from '../lib/session.js';
import { Bowl } from './Bowl.js';

export interface RoomLandingProps {
  code: string;
  /** 凭证失效或房间失效时的说明（来自上一次成员会话）。 */
  notice: string | null;
  onJoined: (membership: Membership) => void;
}

function statusBlockReason(preview: RoomPreview): string | null {
  if (preview.status === 'playing') return '本局已经开始，暂时不能加入';
  if (preview.status === 'finished') return '本局已经结束，等房主再开一局';
  if (preview.status === 'closed') return '这桌已散席，重新开一桌吧';
  if (preview.playerCount >= preview.maxPlayers) return '这桌已经坐满啦';
  if (!preview.canJoin) return '这桌暂时不能加入';
  return null;
}

export function RoomLanding({ code, notice, onJoined }: RoomLandingProps): ReactElement {
  const nicknameId = useId();
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadPreview = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await previewRoom(code);
      setPreview(result);
    } catch (error) {
      setPreview(null);
      const apiError = error instanceof ApiError ? error : null;
      if (apiError?.code === 'ROOM_EXPIRED') setLoadError('这桌已散席，重新开一桌吧');
      else if (apiError?.code === 'ROOM_NOT_FOUND') setLoadError('没找到这个房间，请检查房间码');
      else if (apiError?.code === 'INVALID_INPUT') setLoadError('房间码格式不正确，请检查邀请链接');
      else setLoadError(describeError(error));
    } finally {
      setLoading(false);
    }
  }, [code]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    const trimmed = nickname.trim();
    const length = Array.from(trimmed).length;
    if (length < 1) return setFormError('请填写昵称（1–12个字）');
    if (length > NICKNAME_MAX_LENGTH) return setFormError(`昵称最多 ${NICKNAME_MAX_LENGTH} 个字`);

    setFormError(null);
    setSubmitting(true);
    try {
      const joined = await joinRoom(code, trimmed);
      saveMembership(joined.membership);
      onJoined(joined.membership);
    } catch (error) {
      setFormError(describeError(error));
      void loadPreview();
    } finally {
      setSubmitting(false);
    }
  };

  const blocked = preview ? statusBlockReason(preview) : null;

  return (
    <div className="landing">
      <div className="card landing-card">
        <p className="eyebrow">收到邀请</p>

        {notice ? (
          <p className="form-error" role="alert">
            {notice}
          </p>
        ) : null}

        {loading ? (
          <p className="landing-loading" role="status">
            正在读取房间概况…
          </p>
        ) : loadError ? (
          <>
            <h1 className="landing-title">无法进入这桌</h1>
            <p className="landing-status" role="alert">
              {loadError}
            </p>
            <div className="landing-actions">
              <button type="button" className="btn btn-secondary" onClick={() => void loadPreview()}>
                重新读取
              </button>
              <Link className="btn btn-primary" to="/">
                回首页开新桌
              </Link>
            </div>
          </>
        ) : preview ? (
          <>
            <h1 className="landing-title">{preview.name}</h1>
            <dl className="landing-meta">
              <div>
                <dt>房间码</dt>
                <dd className="inline-code">{preview.code}</dd>
              </div>
              <div>
                <dt>已入座</dt>
                <dd>
                  {preview.playerCount}/{preview.maxPlayers} 人
                </dd>
              </div>
              <div>
                <dt>结束方式</dt>
                <dd>{endConditionLabel(preview.config.endCondition)}</dd>
              </div>
              <div>
                <dt>系统房规</dt>
                <dd>{preview.ruleset.name}</dd>
              </div>
              <div>
                <dt>结果停留</dt>
                <dd>{preview.pacing?.resultHoldSeconds ?? 1} 秒</dd>
              </div>
            </dl>

            <div className="landing-prizes">
              <p className="field-label">
                本局奖品（共 {totalConfiguredPrizes(preview.config.prizes)} 份）
              </p>
              <ul className="waiting-prize-list">
                {PRIZE_KEYS.map((key) => {
                  const prize = preview.config.prizes[key];
                  return (
                    <li key={key} className="waiting-prize-item">
                      <span className="waiting-prize-name">{PRIZE_META[key].label}</span>
                      <span className="waiting-prize-count">{prize.count} 份</span>
                      {prize.content !== '' ? <span className="prize-content">{prize.content}</span> : null}
                    </li>
                  );
                })}
              </ul>
            </div>

            {blocked ? (
              <>
                <p className="landing-status" role="alert">
                  {blocked}
                </p>
                <div className="landing-actions">
                  {preview.access?.allowSpectators && preview.status !== 'closed' ? (
                    <Link className="btn btn-primary" to={`/room/${preview.code}/watch`}>
                      旁观
                    </Link>
                  ) : null}
                  <Link
                    className={
                      preview.access?.allowSpectators && preview.status !== 'closed'
                        ? 'btn btn-secondary'
                        : 'btn btn-primary'
                    }
                    to="/"
                  >
                    回首页
                  </Link>
                  <Link className="btn btn-secondary" to="/lobby">
                    去游戏大厅
                  </Link>
                </div>
              </>
            ) : (
              <form className="form" onSubmit={(event) => void submit(event)}>
                {formError ? (
                  <p className="form-error" role="alert">
                    {formError}
                  </p>
                ) : null}
                <div className="form-field">
                  <label className="field-label" htmlFor={nicknameId}>
                    你的昵称
                  </label>
                  <input
                    id={nicknameId}
                    className="input"
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value)}
                    maxLength={24}
                    placeholder="例如：阿月"
                    autoComplete="nickname"
                    required
                  />
                  <p className="field-hint">1–12个字，房间里不重名</p>
                </div>
                <button type="submit" className="btn btn-primary btn-block" disabled={submitting} aria-busy={submitting}>
                  {submitting ? '正在入席…' : '加入房间'}
                </button>
                {preview.access?.allowSpectators ? (
                  <Link className="btn btn-secondary btn-block landing-watch-btn" to={`/room/${preview.code}/watch`}>
                    先看看
                  </Link>
                ) : null}
                <p className="form-footnote">无需注册，输入昵称即可入席。</p>
              </form>
            )}
          </>
        ) : null}
      </div>

      {/* 落地页的碗同样是纯装饰 */}
      <div className="landing-visual" aria-hidden="true">
        <Bowl dice={[6, 4, 1, 3, 4, 5]} size="compact" decorative />
      </div>
    </div>
  );
}

export function navigateHome(): void {
  navigate('/');
}
