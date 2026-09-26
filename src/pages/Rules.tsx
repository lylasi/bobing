/**
 * 规则页 `/rules`：与房间内规则弹层共用 RulesContent（同一份 shared 数据），
 * 支持查看两种内置系统房规（持续顶状元、高阶锁定）与共同牌型规则。
 */

import type { ReactElement } from 'react';
import { RulesContent } from '../components/RulesContent.js';
import { SiteHeader } from '../components/SiteHeader.js';
import { Link, useTitle } from '../lib/router.js';

export function Rules(): ReactElement {
  useTitle('博饼怎么玩 · 月满博饼');
  return (
    <div className="page page--rules">
      <SiteHeader current="rules" />
      <main className="container rules-main">
        <nav className="breadcrumb" aria-label="面包屑">
          <Link to="/">首页</Link>
          <span aria-hidden="true">/</span>
          <span>博饼规则</span>
        </nav>
        <h1 className="page-title">博饼怎么玩</h1>
        <p className="page-lead">
          六颗骰子、六档奖项，支持「持续顶状元」与「高阶锁定」两种系统房规，以及奖品发完结束或固定轮数结算。
        </p>
        <div className="card rules-card">
          <RulesContent />
        </div>
      </main>
    </div>
  );
}
