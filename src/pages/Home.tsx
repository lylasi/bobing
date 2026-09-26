/**
 * 首页：左侧品牌文案与瓷碗主视觉，右侧创建/加入表单卡片，底部三步流程与六档奖项速览。
 * 奖项与步骤读取当前创建配置草稿与 shared 真实规则，不出现假的在线人数。
 */

import { useCallback, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { createDefaultRoomConfig, normalizeRoomConfig } from '../../shared/room-config.js';
import {
  DEFAULT_MAX_PLAYERS,
  DEFAULT_ROOM_NAME,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NICKNAME_MAX_LENGTH,
  PRIZE_KEYS,
  PRIZE_META,
} from '../../shared/rules.js';
import { RULESETS } from '../../shared/rulesets.js';
import type { RoomConfig } from '../../shared/types.js';
import { Bowl } from '../components/Bowl.js';
import { RoomConfigForm } from '../components/RoomConfigForm.js';
import { SiteHeader } from '../components/SiteHeader.js';
import { ApiError, createRoom, describeError, joinRoom, previewRoom } from '../lib/api.js';
import { endConditionLabel, totalConfiguredPrizes } from '../lib/format.js';
import { navigate } from '../lib/router.js';
import { saveMembership } from '../lib/session.js';

type Tab = 'create' | 'join';

const STEPS: ReadonlyArray<{ title: string; text: string }> = [
  { title: '创建房间', text: '起个房名，选好系统房规、结束方式与奖品，立刻开桌。' },
  { title: '分享邀请', text: '把邀请链接或房码发给好友，输入昵称即可入席。' },
  { title: '轮流博饼', text: '轮流掷六颗骰子，先博到状元最有彩头。' },
];

/** 首页主视觉的装饰骰面（不参与无障碍树，也不来自任何房间状态）。 */
const HERO_DICE: readonly number[] = [6, 4, 1, 3, 4, 5];

function countChars(value: string): number {
  return Array.from(value).length;
}

function validateNickname(value: string): string | null {
  const trimmed = value.trim();
  if (countChars(trimmed) < 1) return '请填写昵称（1–12个字）';
  if (countChars(trimmed) > NICKNAME_MAX_LENGTH) return `昵称最多 ${NICKNAME_MAX_LENGTH} 个字`;
  return null;
}

export function Home(): ReactElement {
  const [tab, setTab] = useState<Tab>('create');
  const nicknameId = useId();
  const nameId = useId();
  const maxPlayersId = useId();
  const joinCodeId = useId();
  const joinNicknameId = useId();

  const [nickname, setNickname] = useState('');
  const [roomName, setRoomName] = useState(DEFAULT_ROOM_NAME);
  const [maxPlayers, setMaxPlayers] = useState<number>(DEFAULT_MAX_PLAYERS);
  const [config, setConfig] = useState<RoomConfig>(() => createDefaultRoomConfig());
  const [configValid, setConfigValid] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState('');
  const [joinNickname, setJoinNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleValidityChange = useCallback((valid: boolean, message: string | null) => {
    setConfigValid(valid);
    setConfigError(message);
  }, []);

  const submitCreate = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    const nicknameError = validateNickname(nickname);
    if (nicknameError) return setError(nicknameError);
    const trimmedName = roomName.trim();
    if (countChars(trimmedName) < 1) return setError('请填写房间名称（1–24个字）');
    if (countChars(trimmedName) > 24) return setError('房间名称最多 24 个字');
    if (!Number.isInteger(maxPlayers) || maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
      return setError(`人数上限请填 ${MIN_PLAYERS}–${MAX_PLAYERS} 的整数`);
    }
    if (!configValid) {
      return setError(configError ?? '请检查房间配置与奖品数量');
    }

    let normalizedConfig: RoomConfig;
    try {
      normalizedConfig = normalizeRoomConfig(config);
    } catch (validationError) {
      return setError(describeError(validationError));
    }

    setError(null);
    setSubmitting(true);
    try {
      const created = await createRoom({
        nickname: nickname.trim(),
        name: trimmedName,
        maxPlayers,
        config: normalizedConfig,
      });
      saveMembership(created.membership);
      navigate(`/room/${created.room.code}`);
    } catch (submitError) {
      setError(describeError(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const submitJoin = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    const code = joinCode.trim().toUpperCase();
    if (code.length !== 6) return setError('房间码是6位字母或数字，请检查后重试');
    const nicknameError = validateNickname(joinNickname);
    if (nicknameError) return setError(nicknameError);

    setError(null);
    setSubmitting(true);
    try {
      const preview = await previewRoom(code);
      if (!preview.canJoin) {
        if (preview.status !== 'waiting') throw new ApiError('http', '本局已经开始，暂时不能加入');
        throw new ApiError('http', '这桌已经坐满啦');
      }
      const joined = await joinRoom(code, joinNickname.trim());
      saveMembership(joined.membership);
      navigate(`/room/${joined.room.code}`);
    } catch (submitError) {
      setError(describeError(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const totalPrizes = totalConfiguredPrizes(config.prizes);

  return (
    <div className="page page--home">
      <SiteHeader current="home" />
      <main className="container home-main">
        <div className="home-grid">
          <section className="home-hero">
            <p className="eyebrow">中秋欢聚 · 好彩头</p>
            <h1 className="home-title" aria-label="一碗骰声，满桌团圆。">
              <span className="home-title-line" aria-hidden="true">
                一碗骰声，
              </span>
              <span className="home-title-line" aria-hidden="true">
                满桌团圆。
              </span>
            </h1>
            <p className="home-subtitle">开一桌中秋好彩头，邀三五好友一起博个状元。</p>
            <ul className="home-points">
              <li>创建房间 · 分享邀请 · 轮流博饼</li>
              <li>默认持续顶状元、奖品发完结束，支持本机保存个人方案</li>
              <li>奖品为虚拟记录，不涉及任何金额</li>
            </ul>
            <div className="home-visual">
              <Bowl dice={HERO_DICE} size="hero" decorative className="bowl--decorative" />
              <p className="home-visual-caption" aria-hidden="true">
                六骰一掷，好运满桌
              </p>
            </div>
          </section>

          <section className="home-panel">
            <div className="card form-card">
              <div className="tabs" role="tablist" aria-label="创建或加入房间">
                <button
                  type="button"
                  role="tab"
                  id="tab-create"
                  aria-selected={tab === 'create'}
                  aria-controls="panel-create"
                  className={`tab ${tab === 'create' ? 'is-active' : ''}`}
                  onClick={() => {
                    setTab('create');
                    setError(null);
                  }}
                >
                  创建房间
                </button>
                <button
                  type="button"
                  role="tab"
                  id="tab-join"
                  aria-selected={tab === 'join'}
                  aria-controls="panel-join"
                  className={`tab ${tab === 'join' ? 'is-active' : ''}`}
                  onClick={() => {
                    setTab('join');
                    setError(null);
                  }}
                >
                  加入房间
                </button>
              </div>

              {error ? (
                <p className="form-error" role="alert">
                  {error}
                </p>
              ) : null}

              {tab === 'create' ? (
                <form className="form" role="tabpanel" id="panel-create" aria-labelledby="tab-create" onSubmit={(event) => void submitCreate(event)}>
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

                  <div className="form-row">
                    <div className="form-field">
                      <label className="field-label" htmlFor={nameId}>
                        房间名称
                      </label>
                      <input
                        id={nameId}
                        className="input"
                        value={roomName}
                        onChange={(event) => setRoomName(event.target.value)}
                        maxLength={40}
                        required
                      />
                    </div>

                    <div className="form-field">
                      <label className="field-label" htmlFor={maxPlayersId}>
                        人数上限
                      </label>
                      <input
                        id={maxPlayersId}
                        className="input"
                        type="number"
                        min={MIN_PLAYERS}
                        max={MAX_PLAYERS}
                        step={1}
                        value={maxPlayers}
                        onChange={(event) => setMaxPlayers(Number.parseInt(event.target.value, 10))}
                        required
                      />
                      <p className="field-hint">
                        {MIN_PLAYERS}–{MAX_PLAYERS} 人
                      </p>
                    </div>
                  </div>

                  <RoomConfigForm
                    value={config}
                    onChange={setConfig}
                    disabled={submitting}
                    onValidityChange={handleValidityChange}
                  />

                  <button
                    type="submit"
                    className="btn btn-primary btn-block"
                    disabled={submitting || !configValid}
                    aria-busy={submitting}
                  >
                    {submitting ? '正在开桌…' : '创建房间'}
                  </button>
                  <p className="form-footnote">无需注册，输入昵称即可入席。</p>
                </form>
              ) : (
                <form className="form" role="tabpanel" id="panel-join" aria-labelledby="tab-join" onSubmit={(event) => void submitJoin(event)}>
                  <div className="form-field">
                    <label className="field-label" htmlFor={joinCodeId}>
                      6位房间码
                    </label>
                    <input
                      id={joinCodeId}
                      className="input input--code"
                      value={joinCode}
                      onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/\s+/g, '').slice(0, 6))}
                      inputMode="text"
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="ABCD23"
                      required
                    />
                    <p className="field-hint">忽略大小写与首尾空格</p>
                  </div>

                  <div className="form-field">
                    <label className="field-label" htmlFor={joinNicknameId}>
                      你的昵称
                    </label>
                    <input
                      id={joinNicknameId}
                      className="input"
                      value={joinNickname}
                      onChange={(event) => setJoinNickname(event.target.value)}
                      maxLength={24}
                      placeholder="例如：小满"
                      required
                    />
                  </div>

                  <button type="submit" className="btn btn-primary btn-block" disabled={submitting} aria-busy={submitting}>
                    {submitting ? '正在入席…' : '加入房间'}
                  </button>
                  <p className="form-footnote">同一个昵称在一桌里只能入座一次。</p>
                </form>
              )}
            </div>
          </section>
        </div>

        <section className="home-steps">
          <h2 className="section-title">三步开一桌</h2>
          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="step-index" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="step-title">{step.title}</span>
                <span className="step-text">{step.text}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="home-prizes">
          <h2 className="section-title">六档奖项速览</h2>
          <ul className="prize-overview">
            {PRIZE_KEYS.map((key) => {
              const prize = config.prizes[key];
              const content = prize.content.trim();
              return (
                <li key={key}>
                  <span className="prize-overview-name">{PRIZE_META[key].label}</span>
                  <span className="prize-overview-count">{prize.count} 份</span>
                  {content !== '' ? <span className="prize-content">{content}</span> : null}
                  <span className="prize-overview-desc">{PRIZE_META[key].description}</span>
                </li>
              );
            })}
          </ul>
          <p className="panel-footnote">
            当前配置：{RULESETS[config.rulesetId].name} · {endConditionLabel(config.endCondition)} · 共 {totalPrizes} 份虚拟奖品，普通奖先到先得，状元在整局结束时发给唯一状元得主。
          </p>
        </section>
      </main>
    </div>
  );
}
