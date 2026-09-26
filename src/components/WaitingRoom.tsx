/**
 * 等待区：房码与邀请、真实席位、房规与奖品概况、房主编辑弹层、准备/开始按钮及未满足条件的原因说明。
 */

import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { PRIZE_KEYS, PRIZE_META } from '../../shared/rules.js';
import type { RoomConfig, RoomState } from '../../shared/types.js';
import type { ActionOutcome } from '../hooks/useRoom.js';
import { endConditionLabel, startBlockedReason, totalInitialPool } from '../lib/format.js';
import { Dialog } from './Dialog.js';
import { PlayerList } from './PlayerList.js';
import { RoomConfigForm } from './RoomConfigForm.js';

export interface WaitingRoomProps {
  room: RoomState;
  playerId: string;
  isHost: boolean;
  busy: boolean;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onInvite: () => void;
  onUpdateConfig: (config: RoomConfig) => Promise<ActionOutcome>;
}

export function WaitingRoom({
  room,
  playerId,
  isHost,
  busy,
  onReady,
  onStart,
  onInvite,
  onUpdateConfig,
}: WaitingRoomProps): ReactElement {
  const me = room.players.find((player) => player.id === playerId) ?? null;
  const ready = me?.ready ?? false;
  const blockedReason = startBlockedReason(room);
  const seated = room.players.filter((player) => !player.left).length;

  const [configOpen, setConfigOpen] = useState(false);
  const [editorResetKey, setEditorResetKey] = useState(0);
  const [draft, setDraft] = useState<RoomConfig>(() => structuredClone(room.config));
  const [draftValid, setDraftValid] = useState(true);
  const [draftValidationError, setDraftValidationError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleValidityChange = useCallback((valid: boolean, message: string | null) => {
    setDraftValid(valid);
    setDraftValidationError(message);
  }, []);

  /**
   * 仅在打开编辑器时从服务端当前配置拷贝一份草稿；
   * 弹层开启期间收到 presence 广播绝不重置正在编辑的 draft。
   */
  const openConfigEditor = (): void => {
    setDraft(structuredClone(room.config));
    setEditorResetKey((prev) => prev + 1);
    setConfigError(null);
    setConfigOpen(true);
  };

  const handleSaveConfig = async (): Promise<void> => {
    if (saving) return;
    if (!draftValid) {
      setConfigError(draftValidationError ?? '请检查奖品数量配置');
      return;
    }
    setSaving(true);
    try {
      const outcome = await onUpdateConfig(draft);
      if (outcome.ok) {
        setConfigError(null);
        setConfigOpen(false);
      } else {
        setConfigError(outcome.error?.message ?? '配置保存失败，请重试');
      }
    } finally {
      setSaving(false);
    }
  };

  const totalPrizes = totalInitialPool(room);

  return (
    <div className="waiting">
      <section className="card waiting-card">
        <div className="waiting-head">
          <div>
            <h2 className="section-title">等好友入席</h2>
            <p className="waiting-lead">
              把房间码 <strong className="inline-code">{room.code}</strong> 或邀请链接发给亲友，无需注册即可加入。
            </p>
          </div>
          <div className="waiting-head-actions">
            {isHost ? (
              <button type="button" className="btn btn-secondary" onClick={openConfigEditor} disabled={busy}>
                修改房规与奖品
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary" onClick={onInvite}>
              邀请亲友
            </button>
          </div>
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
            <dt>当前人数</dt>
            <dd>{seated} 人</dd>
          </div>
        </dl>

        <div className="waiting-prizes">
          <div className="waiting-prizes-head">
            <span className="field-label">本局奖品（共 {totalPrizes} 份）</span>
            {!isHost ? <span className="field-hint">房主可在开局前调整房规与奖品</span> : null}
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

        <div className="waiting-actions">
          <button
            type="button"
            className={ready ? 'btn btn-secondary btn-wide' : 'btn btn-primary btn-wide'}
            onClick={() => onReady(!ready)}
            disabled={busy}
            aria-busy={busy}
            aria-pressed={ready}
          >
            {ready ? '取消准备' : '准备好了'}
          </button>

          {isHost ? (
            <div className="start-block">
              <button
                type="button"
                className="btn btn-primary btn-wide"
                onClick={onStart}
                disabled={busy || blockedReason !== null}
                aria-busy={busy}
                title={blockedReason ?? '开始博饼'}
              >
                {busy ? '正在开局…' : '开始博饼'}
              </button>
              {blockedReason ? (
                <p className="start-blocked" role="status">
                  {blockedReason}
                </p>
              ) : (
                <p className="start-ready">人数与准备都齐了，可以开局。</p>
              )}
            </div>
          ) : (
            <p className="waiting-host-hint">等待房主开始博饼。</p>
          )}
        </div>
      </section>

      <section className="card">
        <PlayerList room={room} playerId={playerId} variant="seats" />
      </section>

      <Dialog
        open={configOpen}
        title="修改房规与奖品"
        onClose={() => {
          if (!saving) setConfigOpen(false);
        }}
        width="lg"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setConfigOpen(false)}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleSaveConfig()}
              disabled={saving || !draftValid}
              aria-busy={saving}
            >
              {saving ? '正在保存…' : '保存配置'}
            </button>
          </>
        }
      >
        <p className="waiting-config-notice">修改后，其他玩家需要重新准备。</p>
        {configError ? (
          <p className="form-error waiting-config-error" role="alert">
            {configError}
          </p>
        ) : null}
        <RoomConfigForm
          key={editorResetKey}
          value={draft}
          onChange={setDraft}
          disabled={saving}
          onValidityChange={handleValidityChange}
          defaultAdvancedOpen
        />
      </Dialog>
    </div>
  );
}
