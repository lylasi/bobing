/**
 * 房间设置弹层（供等待室/对局中/结算区的“更多 -> 房间设置”由房主打开）。
 *
 * 契约要求：
 * - 导出明确 Props：room, open, saving, error, onClose, onSave(pacing, access)。
 * - 仅在 open 从 false 变为 true 时从 room.pacing / room.access 复制一份独立草稿；
 *   弹层打开期间收到的在线状态/快照广播绝不覆盖正在编辑的草稿。
 * - 取消或关闭弹层不触发保存；点击保存校验通过且 onSave 成功后才关闭弹层。
 * - 清晰展示 0–10 秒整数范围说明与“从下次结果生效”说明。
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { normalizeRoomPacing } from '../../shared/presentation.js';
import { normalizeRoomAccess } from '../../shared/room-access.js';
import type { RoomAccess, RoomPacing, RoomState } from '../../shared/types.js';
import { describeError } from '../lib/api.js';
import { Dialog } from './Dialog.js';
import { RoomSettingsFields } from './RoomSettingsFields.js';
import '../styles-room-settings.css';

export interface RoomSettingsDialogProps {
  room: RoomState;
  open: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (pacing: RoomPacing, access: RoomAccess) => Promise<void>;
}

export function RoomSettingsDialog({
  room,
  open,
  saving,
  error,
  onClose,
  onSave,
}: RoomSettingsDialogProps): ReactElement {
  const noticeId = useId();
  const wasOpenRef = useRef<boolean>(false);
  const [editorResetKey, setEditorResetKey] = useState<number>(0);
  const [draftPacing, setDraftPacing] = useState<RoomPacing>(() => ({
    resultHoldSeconds: room.pacing.resultHoldSeconds,
  }));
  const [draftAccess, setDraftAccess] = useState<RoomAccess>(() => ({
    visibility: room.access.visibility,
    allowSpectators: room.access.allowSpectators,
  }));
  const [fieldsValid, setFieldsValid] = useState<boolean>(true);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      wasOpenRef.current = true;
      setDraftPacing({ resultHoldSeconds: room.pacing.resultHoldSeconds });
      setDraftAccess({
        visibility: room.access.visibility,
        allowSpectators: room.access.allowSpectators,
      });
      setFieldsValid(true);
      setFieldsError(null);
      setLocalError(null);
      setEditorResetKey((prev) => prev + 1);
    } else if (!open && wasOpenRef.current) {
      wasOpenRef.current = false;
    }
  }, [open, room.pacing.resultHoldSeconds, room.access.visibility, room.access.allowSpectators]);

  const handleValidityChange = useCallback((valid: boolean, validationMessage: string | null) => {
    setFieldsValid(valid);
    setFieldsError(validationMessage);
  }, []);

  const handleClose = useCallback((): void => {
    if (saving) return;
    setLocalError(null);
    onClose();
  }, [saving, onClose]);

  const handleSave = async (): Promise<void> => {
    if (saving) return;
    if (!fieldsValid) {
      setLocalError(fieldsError ?? '结果停留秒数请填 0–10 的整数');
      return;
    }

    let normalizedPacing: RoomPacing;
    let normalizedAccess: RoomAccess;
    try {
      normalizedPacing = normalizeRoomPacing(draftPacing);
      normalizedAccess = normalizeRoomAccess(draftAccess);
    } catch (validationError) {
      setLocalError(describeError(validationError));
      return;
    }

    setLocalError(null);
    try {
      const outcome = (await onSave(normalizedPacing, normalizedAccess)) as unknown;
      if (outcome !== false) {
        onClose();
      }
    } catch (saveError) {
      setLocalError(describeError(saveError));
    }
  };

  const activeError = error ?? localError;

  return (
    <Dialog
      open={open}
      title="房间设置"
      onClose={handleClose}
      width="md"
      describedBy={noticeId}
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleClose}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleSave()}
            disabled={saving || !fieldsValid}
            aria-busy={saving}
          >
            {saving ? '正在保存…' : '保存设置'}
          </button>
        </>
      }
    >
      <div className="room-settings-dialog-body">
        <p id={noticeId} className="room-settings-dialog-notice">
          公开范围与旁观设置保存后立即生效。
        </p>

        {activeError ? (
          <p className="form-error" role="alert">
            {activeError}
          </p>
        ) : null}

        <RoomSettingsFields
          key={editorResetKey}
          pacing={draftPacing}
          onPacingChange={setDraftPacing}
          access={draftAccess}
          onAccessChange={setDraftAccess}
          disabled={saving}
          onValidityChange={handleValidityChange}
          variant="dialog"
        />
      </div>
    </Dialog>
  );
}
