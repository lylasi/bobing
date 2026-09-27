/**
 * 可复用房间设置字段（首页创建表单与局中/等待室 RoomSettingsDialog 共用）。
 *
 * - 受控编辑 RoomAccess（大厅公开/仅邀请、允许旁观）与 RoomPacing（结果停留 0–10 秒整数）。
 * - 内部维护 rawHoldSeconds 字符串草稿与 syncedHoldSecondsRef：
 *   当用户清空、输入小数（如 1.5）、负数或超出 0–10 范围的值时，保留原草稿并通过
 *   onValidityChange 通知外层阻止提交，绝不静默还原为 1；切换可见性或旁观开关也不会覆盖非法草稿。
 * - 输入框两侧提供 ±1 步进按钮（步进逻辑见 ../lib/result-hold.ts，与直接输入共用同一份解析与
 *   校验）：草稿非法或目标越界时按钮禁用，不钳制、不回退默认值；Disabled 时所有编辑入口一并禁用。
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { MAX_RESULT_HOLD_SECONDS, MIN_RESULT_HOLD_SECONDS } from '../../shared/presentation.js';
import type { RoomAccess, RoomPacing } from '../../shared/types.js';
import {
  parseResultHoldSeconds,
  stepResultHoldSeconds,
  validateResultHoldSeconds,
} from '../lib/result-hold.js';
import '../styles-room-settings.css';

// 兼容旧调用点：校验函数仍从本模块导出，实现已抽到 ../lib/result-hold.ts。
export { validateResultHoldSeconds } from '../lib/result-hold.js';

export interface RoomSettingsFieldsProps {
  pacing: RoomPacing;
  onPacingChange: (pacing: RoomPacing) => void;
  access: RoomAccess;
  onAccessChange: (access: RoomAccess) => void;
  disabled?: boolean;
  onValidityChange?: (valid: boolean, error: string | null) => void;
  variant?: 'create' | 'dialog';
}

export function RoomSettingsFields({
  pacing,
  onPacingChange,
  access,
  onAccessChange,
  disabled = false,
  onValidityChange,
  variant = 'create',
}: RoomSettingsFieldsProps): ReactElement {
  const baseId = useId();
  const publicId = `${baseId}-visibility-public`;
  const inviteId = `${baseId}-visibility-invite`;
  const allowSpectatorsId = `${baseId}-allow-spectators`;
  const holdSecondsId = `${baseId}-hold-seconds`;
  const holdHintId = `${baseId}-hold-hint`;
  const holdErrorId = `${baseId}-hold-error`;

  const [rawHoldSeconds, setRawHoldSeconds] = useState<string>(() => String(pacing.resultHoldSeconds));
  const syncedHoldSecondsRef = useRef<number>(pacing.resultHoldSeconds);

  useEffect(() => {
    if (pacing.resultHoldSeconds !== syncedHoldSecondsRef.current) {
      syncedHoldSecondsRef.current = pacing.resultHoldSeconds;
      setRawHoldSeconds(String(pacing.resultHoldSeconds));
    }
  }, [pacing.resultHoldSeconds]);

  const holdError = validateResultHoldSeconds(rawHoldSeconds);

  useEffect(() => {
    onValidityChange?.(holdError === null, holdError);
  }, [holdError, onValidityChange]);

  const handleVisibilityChange = (visibility: RoomAccess['visibility']): void => {
    onAccessChange({
      ...access,
      visibility,
    });
  };

  const handleAllowSpectatorsChange = (allowSpectators: boolean): void => {
    onAccessChange({
      ...access,
      allowSpectators,
    });
  };

  const handleHoldSecondsChange = (raw: string): void => {
    setRawHoldSeconds(raw);
    const parsed = parseResultHoldSeconds(raw);
    if (parsed !== null) {
      syncedHoldSecondsRef.current = parsed;
      onPacingChange({ resultHoldSeconds: parsed });
    }
  };

  // 草稿非法或目标越界（0 减一 / 10 加一）时禁用步进；输入框本身仍可继续编辑。
  const parsedHoldSeconds = parseResultHoldSeconds(rawHoldSeconds);
  const canDecreaseHold =
    !disabled &&
    parsedHoldSeconds !== null &&
    stepResultHoldSeconds(rawHoldSeconds, -1) !== null;
  const canIncreaseHold =
    !disabled &&
    parsedHoldSeconds !== null &&
    stepResultHoldSeconds(rawHoldSeconds, 1) !== null;

  const handleHoldStep = (direction: -1 | 1): void => {
    const next = stepResultHoldSeconds(rawHoldSeconds, direction);
    if (next === null) return;
    handleHoldSecondsChange(String(next));
  };

  return (
    <div
      className={`room-settings-fields ${variant === 'dialog' ? 'room-settings-fields--dialog' : ''}`}
      role="group"
      aria-label="房间访问与节奏设置"
    >
      <div className="settings-section-head">
        <span className="field-label">房间公开与节奏</span>
        <span className="settings-section-note">独立于房规与个人方案，可随时由房主调整</span>
      </div>

      {/* 1. 大厅公开 / 仅邀请 */}
      <fieldset className="settings-visibility-fieldset" disabled={disabled}>
        <legend className="visually-hidden">房间可见性</legend>
        <div className="settings-radio-grid">
          <label
            htmlFor={publicId}
            className={`config-radio-card ${access.visibility === 'public' ? 'is-active' : ''}`}
          >
            <span className="config-radio-head">
              <input
                id={publicId}
                type="radio"
                name={`${baseId}-visibility`}
                aria-label="大厅公开"
                checked={access.visibility === 'public'}
                onChange={() => handleVisibilityChange('public')}
                disabled={disabled}
              />
              <span className="config-radio-title">大厅公开</span>
            </span>
            <span className="config-radio-desc">展示在游戏大厅，方便同桌好友或路人发现</span>
          </label>

          <label
            htmlFor={inviteId}
            className={`config-radio-card ${access.visibility === 'invite' ? 'is-active' : ''}`}
          >
            <span className="config-radio-head">
              <input
                id={inviteId}
                type="radio"
                name={`${baseId}-visibility`}
                aria-label="仅邀请"
                checked={access.visibility === 'invite'}
                onChange={() => handleVisibilityChange('invite')}
                disabled={disabled}
              />
              <span className="config-radio-title">仅邀请</span>
            </span>
            <span className="config-radio-desc">不在大厅列出，凭 6 位房间码或邀请链接入席</span>
          </label>
        </div>
      </fieldset>

      {/* 2. 允许旁观 + 结果停留秒数 */}
      <div className="settings-grid-row">
        <label
          htmlFor={allowSpectatorsId}
          className={`settings-check-card ${access.allowSpectators ? 'is-active' : ''}`}
        >
          <span className="settings-check-head">
            <input
              id={allowSpectatorsId}
              type="checkbox"
              aria-label="允许旁观"
              checked={access.allowSpectators}
              onChange={(event) => handleAllowSpectatorsChange(event.target.checked)}
              disabled={disabled}
            />
            <span>允许旁观</span>
          </span>
          <span className="settings-check-desc">未入座访客可只读观看本桌投掷与奖池变化</span>
        </label>

        <div className="settings-hold-box">
          <div className="settings-hold-top">
            <label className="settings-hold-label" htmlFor={holdSecondsId}>
              结果停留秒数
            </label>
            <div className="settings-hold-stepper">
              <button
                type="button"
                className="settings-hold-step"
                aria-label="减少结果停留秒数"
                onClick={() => handleHoldStep(-1)}
                disabled={!canDecreaseHold}
              >
                −
              </button>
              <div className="settings-hold-input-group">
                <input
                  id={holdSecondsId}
                  aria-label="结果停留秒数"
                  aria-describedby={holdError ? `${holdHintId} ${holdErrorId}` : holdHintId}
                  aria-invalid={holdError !== null}
                  type="number"
                  inputMode="numeric"
                  min={MIN_RESULT_HOLD_SECONDS}
                  max={MAX_RESULT_HOLD_SECONDS}
                  step={1}
                  className="input settings-hold-input"
                  value={rawHoldSeconds}
                  onChange={(event) => handleHoldSecondsChange(event.target.value)}
                  disabled={disabled}
                />
                <span className="settings-hold-unit">秒</span>
              </div>
              <button
                type="button"
                className="settings-hold-step"
                aria-label="增加结果停留秒数"
                onClick={() => handleHoldStep(1)}
                disabled={!canIncreaseHold}
              >
                +
              </button>
            </div>
          </div>
          <p id={holdHintId} className="settings-hold-hint">
            0–10 秒，默认 1 秒；0 秒保留动画，下次结果生效。
          </p>
        </div>
      </div>

      {holdError ? (
        <p id={holdErrorId} className="form-error settings-field-error" role="alert">
          {holdError}
        </p>
      ) : null}
    </div>
  );
}
