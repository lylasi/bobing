/**
 * 弹层基础组件：Esc 关闭、点击遮罩关闭、焦点锁在弹层内、关闭后焦点回到触发按钮、滚动锁定。
 * 危险操作（结束本局、离开房间）仍必须点击弹层内的确认按钮，遮罩关闭不会执行任何动作。
 */

import { useCallback, useEffect, useId, useRef } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** 弹层最大宽度：分享 420、规则 720、确认 400。 */
  width?: 'sm' | 'md' | 'lg';
  describedBy?: string;
  /** 打开时优先聚焦的元素（例如确认弹层的“取消”按钮）。 */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

export function Dialog({ open, title, onClose, children, footer, width = 'md', describedBy, initialFocusRef }: DialogProps): ReactElement | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const node = dialogRef.current;
      if (!node) return;
      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        node.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown, true);

    const node = dialogRef.current;
    if (node) {
      const preferred = initialFocusRef?.current;
      const target = preferred ?? node.querySelector<HTMLElement>(FOCUSABLE) ?? node;
      target.focus();
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      restoreRef.current?.focus();
    };
  }, [open, handleKeyDown, initialFocusRef]);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`dialog dialog--${width}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="dialog-header">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="关闭弹层">
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
