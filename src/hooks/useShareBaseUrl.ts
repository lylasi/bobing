/**
 * 分享基地址：来自只读的 `/api/config`（PUBLIC_BASE_URL），未配置时使用当前 origin。
 *
 * 必须做成 hook：配置是异步到达的，如果在组件首次渲染时就把链接写死，
 * 会永远停留在访问者当前地址，分享出去的可能是不对外可用的内网地址。
 */

import { useEffect, useState } from 'react';
import { buildInviteUrl, loadRuntimeConfig, setShareBaseUrl, shareBaseUrl } from '../lib/api.js';

export function useShareBaseUrl(): string {
  const [base, setBase] = useState(() => shareBaseUrl());

  useEffect(() => {
    let cancelled = false;
    void loadRuntimeConfig().then((config) => {
      if (cancelled) return;
      setShareBaseUrl(config.publicBaseUrl);
      setBase(shareBaseUrl());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return base;
}

export function useInviteUrl(code: string): string {
  const base = useShareBaseUrl();
  return buildInviteUrl(code, base);
}
