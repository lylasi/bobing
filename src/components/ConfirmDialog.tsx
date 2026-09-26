/**
 * 二次确认弹层：用于房主“提前结束”和“离开房间”这类不可撤销的应用内操作。
 * 默认焦点落在安全的取消按钮上，避免误按回车直接执行危险动作。
 */

import { useRef } from 'react';
import type { ReactElement } from 'react';
import { Dialog } from './Dialog.js';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 确认按钮是否为危险样式（朱砂红实心）。 */
  danger?: boolean;
  busy?: boolean;
  /** 上一次确认失败的原因：保留弹层与身份，让玩家直接重试。 */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement | null {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      width="sm"
      initialFocusRef={cancelRef}
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onCancel} ref={cancelRef} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </>
      }
    >
      <p className="confirm-text">{description}</p>
      {error ? (
        <p className="form-error confirm-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
