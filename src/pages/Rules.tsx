/**
 * 规则页 `/rules`：与房间内规则弹层共用 RulesContent（同一份 shared 数据）。
 */

import type { ReactElement } from 'react';
import { RulesContent } from '../components/RulesContent.js';
import { SiteHeader } from '../components/SiteHeader.js';
import { Link, useTitle } from '../lib/router.js';

export function Rules(): ReactElement {
  useTitle('线上统一房规 v1 · 月满博饼');
  return (
    <div className="page page--rules">
      <SiteHeader current="rules" />
      <main className="container rules-main">
        <nav className="breadcrumb" aria-label="面包屑">
          <Link to="/">首页</Link>
          <span aria-hidden="true">/</span>
          <span>线上统一房规 v1</span>
        </nav>
        <h1 className="page-title">博饼怎么玩</h1>
        <p className="page-lead">六颗骰子、六档奖项、63份虚拟奖品。以下是本房间采用的完整规则。</p>
        <div className="card rules-card">
          <RulesContent />
        </div>
      </main>
    </div>
  );
}
