/**
 * 规则正文：规则页与房间内规则弹层共用同一份数据（shared/rules.ts），
 * 不出现 rankKey 数组，也不复制第二份判奖实现。
 */

import type { ReactElement } from 'react';
import {
  PRIZE_KEYS,
  PRIZE_META,
  RULES_NAME,
  RULES_RESULT_ROWS,
  RULES_TEXT,
  totalPrizeCount,
} from '../../shared/rules.js';
import { DiceRow } from './Dice.js';

const STEPS: ReadonlyArray<{ title: string; text: string }> = [
  { title: '一、轮流掷骰', text: '每人轮流把六颗骰子投进瓷碗，服务端随机，按点数组合判奖。' },
  { title: '二、只取最高奖', text: '一次投掷只判最高牌型，不兼得、不追缴；四点（红四点）是判奖依据。' },
  { title: '三、奖池先到先得', text: '普通奖库存领完即止；状元整局结束时发给领先者，没人掷出则本局空缺。' },
];

export function RulesContent({ compact = false }: { compact?: boolean }): ReactElement {
  return (
    <div className={`rules-content ${compact ? 'rules-content--compact' : ''}`.trim()}>
      <section className="rules-block">
        <h3 className="rules-heading">怎么玩</h3>
        <ol className="rules-steps">
          {STEPS.map((step) => (
            <li key={step.title}>
              <span className="rules-step-title">{step.title}</span>
              <span className="rules-step-text">{step.text}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="rules-block">
        <h3 className="rules-heading">牌型与判定（由高到低）</h3>
        <p className="rules-note">从上到下匹配，只取命中的最高一项。</p>
        <ul className="rules-result-list">
          {RULES_RESULT_ROWS.map((row) => (
            <li key={row.code} className={`rules-result rules-result--${row.prize ?? 'none'}`}>
              <div className="rules-result-main">
                <span className="rules-order">{row.order}</span>
                <span className="rules-label">{row.label}</span>
                <span className="rules-condition">{row.condition}</span>
              </div>
              <div className="rules-result-side">
                <DiceRow dice={row.example} size="xs" label={`${row.label}示例：${row.example.join('、')}`} />
                <span className="rules-prize">{row.prize ? `${PRIZE_META[row.prize].label}奖池` : '无奖品'}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="rules-block">
        <h3 className="rules-heading">奖池数量</h3>
        <p className="rules-note">共 {totalPrizeCount()} 份，状元 1 份单独保留，其余五类先到先得。</p>
        <ul className="rules-pool">
          {PRIZE_KEYS.map((key) => (
            <li key={key}>
              <span className="rules-pool-label">{PRIZE_META[key].label}</span>
              <span className="rules-pool-count">{PRIZE_META[key].count} 份</span>
              <span className="rules-pool-desc">{PRIZE_META[key].description}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rules-block">
        <h3 className="rules-heading">本房间约定</h3>
        <ul className="rules-points">
          {RULES_TEXT.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>

      <section className="rules-block">
        <h3 className="rules-heading">参考来源</h3>
        <p className="rules-note">{RULES_TEXT.variants} 本房间使用「{RULES_NAME}」。</p>
        <ul className="rules-sources">
          {RULES_TEXT.sources.map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer noopener">
                {source.label}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
