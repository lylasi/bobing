/**
 * 邀请弹层：完整邀请链接、复制、二维码、系统分享（可用时才出现）。
 *
 * - 链接内容为 `${publicBaseUrl|origin}/room/{房码}`，**不含任何凭证**。
 * - 二维码使用本地依赖 qrcode 在浏览器内生成 SVG，运行时没有任何外链请求。
 * - 复制失败时绝不显示“已复制”，改为提示长按/选中链接手动复制。
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import QRCode from 'qrcode';
import { Dialog } from './Dialog.js';

export interface ShareDialogProps {
  open: boolean;
  roomCode: string;
  roomName: string;
  inviteUrl: string;
  onClose: () => void;
}

type CopyStatus = { tone: 'ok' | 'warn'; text: string } | null;

export function ShareDialog({ open, roomCode, roomName, inviteUrl, onClose }: ShareDialogProps): ReactElement | null {
  const [qrSvg, setQrSvg] = useState<string>('');
  const [qrFailed, setQrFailed] = useState(false);
  const [status, setStatus] = useState<CopyStatus>(null);
  const [canShare, setCanShare] = useState(false);
  const linkRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setQrFailed(false);
    setCanShare(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
    let cancelled = false;
    void QRCode.toString(inviteUrl, { type: 'svg', margin: 1, width: 192, errorCorrectionLevel: 'M' })
      .then((svg) => {
        if (!cancelled) setQrSvg(svg);
      })
      .catch(() => {
        if (!cancelled) {
          setQrSvg('');
          setQrFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, inviteUrl]);

  const selectLink = (): void => {
    const input = linkRef.current;
    if (!input) return;
    input.focus();
    input.select();
  };

  const copyLink = async (): Promise<void> => {
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(inviteUrl);
        setStatus({ tone: 'ok', text: '邀请链接已复制' });
        return;
      }
      throw new Error('clipboard unavailable');
    } catch {
      selectLink();
      setStatus({ tone: 'warn', text: '当前环境不能自动复制，长按或选中链接复制' });
    }
  };

  const systemShare = async (): Promise<void> => {
    try {
      await navigator.share({ title: `${roomName} · 月满博饼`, text: `来一起博饼：房间 ${roomCode}`, url: inviteUrl });
      setStatus({ tone: 'ok', text: '已打开系统分享' });
    } catch {
      setStatus({ tone: 'warn', text: '系统分享未完成，可复制链接或让好友扫码' });
    }
  };

  return (
    <Dialog
      open={open}
      title="邀请亲友"
      onClose={onClose}
      width="sm"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={selectLink}>
            选中链接
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void copyLink()}>
            复制邀请链接
          </button>
        </>
      }
    >
      <div className="share">
        <div className="share-code">
          <span className="share-code-label">房间码</span>
          <strong className="share-code-value">{roomCode}</strong>
        </div>

        <div className="share-qr">
          {qrSvg ? (
            <div
              className="share-qr-image"
              aria-label={`邀请二维码，对应链接 ${inviteUrl}`}
              role="img"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          ) : (
            <p className="share-qr-fallback">{qrFailed ? '二维码生成失败，请直接分享下面的链接' : '二维码生成中…'}</p>
          )}
          <p className="share-qr-hint">用手机相机扫一下就能进房间</p>
        </div>

        <label className="share-link-field">
          <span className="share-link-label">邀请链接</span>
          <input
            ref={linkRef}
            className="input share-link-input"
            value={inviteUrl}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
            aria-label="邀请链接，可选中复制"
          />
        </label>

        {canShare ? (
          <button type="button" className="btn btn-secondary btn-block" onClick={() => void systemShare()}>
            系统分享…
          </button>
        ) : (
          <p className="share-note">当前浏览器不支持系统分享，请复制链接或让好友扫码。</p>
        )}

        <p className="share-status" role="status" aria-live="polite" data-tone={status?.tone ?? 'none'}>
          {status?.text ?? ''}
        </p>
      </div>
    </Dialog>
  );
}
