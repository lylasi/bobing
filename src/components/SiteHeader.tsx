/**
 * 顶部导航：左品牌（名 + 方形红印），右“游戏大厅”与“博饼怎么玩”。
 * 高度桌面 80px、移动 64px，由 styles.css 控制。
 */

import type { ReactElement } from 'react';
import { Link } from '../lib/router.js';

export function SiteHeader({ current }: { current?: 'home' | 'lobby' | 'rules' }): ReactElement {
  return (
    <header className="site-header">
      <div className="container site-header-inner">
        <Link to="/" className="brand" aria-label="月满博饼，回到首页">
          <span className="brand-seal" aria-hidden="true">
            饼
          </span>
          <span className="brand-name">月满博饼</span>
        </Link>
        <nav className="site-nav" aria-label="主导航">
          {current !== 'home' ? (
            <Link to="/lobby" className={`header-link ${current === 'lobby' ? 'is-current' : ''}`}>
              游戏大厅
            </Link>
          ) : null}
          <Link to="/rules" className={`header-link ${current === 'rules' ? 'is-current' : ''}`}>
            博饼怎么玩
          </Link>
        </nav>
      </div>
    </header>
  );
}
