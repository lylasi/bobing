/**
 * 极小路由器：只服务 `/`、`/rules`、`/room/:code` 三条路径。
 *
 * 不引入路由依赖，行为清晰可查：浏览器前进/后退走 popstate，
 * 站内跳转走 history.pushState，生产环境由 Express 提供 SPA 回退，
 * 因此深链刷新 `/room/ABC234` 不会 404。
 */

import { createElement, useCallback, useEffect, useState } from 'react';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../shared/rules.js';

export type Route =
  | { name: 'home' }
  | { name: 'rules' }
  | { name: 'room'; code: string }
  | { name: 'notFound'; path: string };

/** 房码字符集与 shared/rules.ts 一致（去掉易混字符），长度 6。 */
export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const char of code) {
    if (!ROOM_CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}

export function parsePath(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'home' };
  if (path === '/rules') return { name: 'rules' };
  const room = /^\/room\/([^/]+)$/.exec(path);
  if (room) return { name: 'room', code: decodeURIComponent(room[1] ?? '').trim().toUpperCase() };
  return { name: 'notFound', path };
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === to) return;
  if (options.replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));

  useEffect(() => {
    const onChange = (): void => setRoute(parsePath(window.location.pathname));
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);

  return route;
}

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  children: ReactNode;
}

/** 站内链接：保留新标签页/中键/修饰键的原生行为，其余走前端路由。 */
export function Link({ to, children, onClick, ...rest }: LinkProps): ReactNode {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(to);
    },
    [onClick, to],
  );

  return createElement('a', { href: to, onClick: handleClick, ...rest }, children);
}
