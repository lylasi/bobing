/**
 * 规则正文：规则页与房间内规则弹层共用同一份数据（shared/rules.ts 与 shared/rulesets.ts），
 * 区分共同牌型规则与房间配置（系统房规、结束方式、本局奖池与可选内容），不出现 rankKey 数组。
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import {
  PRIZE_KEYS,
  PRIZE_META,
  RULES_RESULT_ROWS,
  RULES_TEXT,
  resultRow,
  totalPrizeCount,
} from '../../shared/rules.js';
import { RULESETS, RULESET_IDS } from '../../shared/rulesets.js';
import type { RoomState, RulesetId } from '../../shared/types.js';
import { endConditionLabel, totalInitialPool } from '../lib/format.js';
import { DiceRow } from './Dice.js';

const STEPS: ReadonlyArray<{ title: string; text: string }> = [
  { title: '一、轮流掷骰', text: '每人轮流把六颗骰子投进瓷碗，服务端随机，按点数组合判奖。' },
  { title: '二、只取最高奖（不兼得、不追缴）', text: '一次投掷只判最高牌型：四进不兼得一秀或二举，状元插金花不额外领取对堂；六杯红不清空普通奖池、不追回他人已得普通奖。' },
  { title: '三、普通奖先到先得，状元收尾结算', text: '普通奖库存大于 0 时立即发放 1 份；唯一状元在整局收尾结束时一次性获得状元档全部份数。' },
];

const UPDATED_POINTS: readonly string[] = [
  '共同牌型排序：状元插金花 > 六杯红 > 遍地锦 > 六杯黑 > 五红 > 五子登科 > 四红状元 > 对堂 > 三红 > 四进 > 二举 > 一秀。',
  '一次投掷只判最高牌型，不兼得、不追缴：四进不兼得一秀或二举，插金花不额外领对堂，六杯红不夺走已发普通奖。',
  '持续顶状元（默认）：收尾结束前，严格更大的状元成绩替换当前领先者；同分保留先博得者，不加赛。',
  '高阶锁定（可选）：首次出现五红、六杯黑、遍地锦、六杯红或状元插金花即锁定唯一状元得主，后续更大牌型也不能顶替；四红状元、五子登科阶段仍允许争夺；锁定只确定状元得主，不提前结束整局。',
  '奖品发完结束（默认，无轮数上限）：五档普通奖库存全部归零，且已存在状元候选或已锁定得主时，才进入本轮收尾（完成当前整轮，不多打一轮）；若普通奖已领完但尚无状元，继续投掷直至出现状元并完成该轮。',
  '固定轮数（可选每人 5／10／20 轮）：达到轮数上限后按实际结果结算，剩余库存与空缺情况如实展示。',
  `每次机会 ${RULES_TEXT.turnSeconds} 秒，超时记为“超时跳过”，不掷骰、不发奖，并消耗一次机会。`,
  '开局后若只剩一位未离席成员，仍可继续轮转投掷，不再因在席人数少于两人自动结束；离席不清除已取得的状元资格或奖项。',
  '全员离线时自动暂停当前回合倒计时并保留 24 小时，任意成员重连即恢复剩余时间。',
];

export function RulesContent({
  compact = false,
  room = null,
}: {
  compact?: boolean;
  room?: RoomState | null;
}): ReactElement {
  const [activeRulesetId, setActiveRulesetId] = useState<RulesetId>(room?.ruleset.id ?? 'continuous');
  const activePreset = room ? room.ruleset : RULESETS[activeRulesetId];
  const lockLabels = RULESETS['high-tier-lock'].lockCodes.map((code) => resultRow(code).label).join('、');

  return (
    <div className={`rules-content ${compact ? 'rules-content--compact' : ''}`.trim()}>
      {room ? (
        <section className="rules-block rules-room-snapshot">
          <h3 className="rules-heading">当前房间配置</h3>
          <dl className="summary-grid">
            <div>
              <dt>系统房规</dt>
              <dd>{room.ruleset.name}</dd>
            </div>
            <div>
              <dt>结束方式</dt>
              <dd>{endConditionLabel(room.config.endCondition)}</dd>
            </div>
            <div>
              <dt>本局奖池总份数</dt>
              <dd>{totalInitialPool(room)} 份</dd>
            </div>
          </dl>
        </section>
      ) : (
        <section className="rules-block">
          <h3 className="rules-heading">两种内置系统房规</h3>
          <div className="pill-group" role="tablist" aria-label="系统房规说明切换">
            {RULESET_IDS.map((id) => {
              const preset = RULESETS[id];
              const selected = activeRulesetId === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`pill ${selected ? 'is-active' : ''}`}
                  onClick={() => setActiveRulesetId(id)}
                >
                  {preset.name}
                </button>
              );
            })}
          </div>
          <div className="rules-preset-detail">
            {activePreset.id === 'continuous' ? (
              <p className="rules-note">
                <strong>持续顶状元（默认）</strong>：在本局收尾结束前，任何玩家博出严格更大的状元牌型即可顶替当前领先者；同分先到先得，唯一最终状元在收尾结算时获得状元档全部份数。
              </p>
            ) : (
              <p className="rules-note">
                <strong>高阶锁定</strong>：首次出现 <strong>{lockLabels}</strong> 即锁定唯一状元得主，后续即使掷出更大牌型也不再顶替；四红状元、五子登科阶段仍可争夺。锁定只确定状元归属，不让整局提前结束。
              </p>
            )}
          </div>
        </section>
      )}

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
        <h3 className="rules-heading">共同牌型与判定（由高到低）</h3>
        <p className="rules-note">两种系统房规共用同一套六骰牌型判定表，从上到下匹配，只取命中的最高一项。</p>
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
        <h3 className="rules-heading">{room ? '本局奖池配置' : '六档奖池（默认配置示例）'}</h3>
        <p className="rules-note">
          {room
            ? `本局共配置 ${totalInitialPool(room)} 份奖品；状元份数由唯一最终状元在结算时全部获得。`
            : `默认共 ${totalPrizeCount()} 份（1／2／4／8／16／32），创建房间或等待室中可自定义各档份数与奖品内容。`}
        </p>
        <ul className="rules-pool">
          {PRIZE_KEYS.map((key) => {
            const count = room ? room.initialPool[key] : PRIZE_META[key].count;
            const content = room ? room.config.prizes[key].content : '';
            return (
              <li key={key}>
                <span className="rules-pool-label">{PRIZE_META[key].label}</span>
                <span className="rules-pool-count">{count} 份</span>
                {content !== '' ? <span className="prize-content">{content}</span> : null}
                <span className="rules-pool-desc">{PRIZE_META[key].description}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rules-block">
        <h3 className="rules-heading">房规与结算说明</h3>
        <ul className="rules-points">
          {UPDATED_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>

      <section className="rules-block">
        <h3 className="rules-heading">参考来源</h3>
        <p className="rules-note">各地博饼习俗略有差异，系统提供「持续顶状元」与「高阶锁定」两种房规供开房选择。</p>
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
