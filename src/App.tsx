/**
 * 路由与全局错误区。
 * 支持路径：`/`、`/lobby`、`/rules`、`/room/:code`、`/room/:code/watch`；其余显示未找到。
 */

import type { ReactElement } from 'react';
import { Home } from './pages/Home.js';
import { Lobby } from './pages/Lobby.js';
import { Room } from './pages/Room.js';
import { Rules } from './pages/Rules.js';
import { Link, useRoute } from './lib/router.js';
import { SiteHeader } from './components/SiteHeader.js';
import './styles-lobby.css';

export function App(): ReactElement {
  const route = useRoute();

  if (route.name === 'home') return <Home />;
  if (route.name === 'lobby') return <Lobby />;
  if (route.name === 'rules') return <Rules />;
  if (route.name === 'spectate') return <Room code={route.code} mode="spectate" />;
  if (route.name === 'room') return <Room code={route.code} mode="member" />;

  return (
    <div className="page">
      <SiteHeader />
      <main className="container room-main">
        <section className="card closed-card">
          <h2 className="section-title">页面不存在</h2>
          <p className="landing-status">没有找到这个地址，回首页重新开一桌吧。</p>
          <Link className="btn btn-primary" to="/">
            回首页
          </Link>
        </section>
      </main>
    </div>
  );
}
