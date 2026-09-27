/**
 * 房间配置编辑器（首页创建与等待室房主编辑共用）。
 *
 * - 不嵌套独立 <form>，避免与外层表单冲突。
 * - 包含系统房规、结束方式、固定轮数选择、单层六行奖品表（桌面奖级/数量/内容三列、手机每档两行）、
 *   默认数量恢复，以及独立收起的本机个人方案管理。
 * - 应用个人方案或恢复默认数量时，严格保留当前选择的系统房规（rulesetId），也不触碰房间访问/节奏设置。
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { DEFAULT_MAX_ROUNDS, DEFAULT_PRIZE_COUNTS, PRIZE_KEYS, PRIZE_META, ROUND_OPTIONS } from '../../shared/rules.js';
import { RULESETS, RULESET_IDS } from '../../shared/rulesets.js';
import type { PrizeKey, RoomConfig, RulesetId } from '../../shared/types.js';
import { totalConfiguredPrizes } from '../lib/format.js';
import { deleteTemplate, loadTemplates, upsertTemplate } from '../lib/templates.js';
import type { PersonalTemplate } from '../lib/templates.js';
import '../styles-room-settings.css';

export interface RoomConfigFormProps {
  value: RoomConfig;
  onChange: (value: RoomConfig) => void;
  disabled?: boolean;
  onValidityChange?: (valid: boolean, error: string | null) => void;
  /** 是否默认展开“调整奖品与个人方案”区域；首页默认收起(false)，等待室弹窗默认展开(true)。 */
  defaultAdvancedOpen?: boolean;
}

const RULESET_DESCRIPTIONS: Readonly<Record<RulesetId, string>> = {
  continuous: '收尾前更大状元可顶替领先者；同分保留先博得者。',
  'high-tier-lock': '五红及以上当场锁定唯一状元；四红、五子仍可争夺。',
};

function numericCountsFromConfig(config: RoomConfig): Record<PrizeKey, number> {
  const result = {} as Record<PrizeKey, number>;
  for (const key of PRIZE_KEYS) {
    result[key] = config.prizes[key]?.count ?? DEFAULT_PRIZE_COUNTS[key];
  }
  return result;
}

function validateCounts(rawCounts: Record<PrizeKey, string>): string | null {
  let sum = 0;
  for (const key of PRIZE_KEYS) {
    const label = PRIZE_META[key].label;
    const raw = (rawCounts[key] ?? '').trim();
    if (raw.length === 0) {
      return `请填写${label}数量（至少 1 份）`;
    }
    if (!/^\d+$/.test(raw)) {
      return `${label}数量必须是至少 1 的整数`;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      return `${label}数量必须是至少 1 的整数`;
    }
    sum += parsed;
    if (!Number.isSafeInteger(sum)) {
      return '六档奖品总份数超出有效范围';
    }
  }
  return null;
}

export function RoomConfigForm({
  value,
  onChange,
  disabled = false,
  onValidityChange,
  defaultAdvancedOpen = false,
}: RoomConfigFormProps): ReactElement {
  const baseId = useId();
  const advancedToggleId = `${baseId}-advanced-toggle`;
  const advancedPanelId = `${baseId}-advanced-panel`;
  const templatesToggleId = `${baseId}-templates-toggle`;
  const templatesPanelId = `${baseId}-templates-panel`;

  const [advancedOpen, setAdvancedOpen] = useState<boolean>(defaultAdvancedOpen);
  /** 个人方案管理独立收起，减少嵌套卡片与视觉负担 */
  const [templatesOpen, setTemplatesOpen] = useState<boolean>(false);
  const [rawCounts, setRawCounts] = useState<Record<PrizeKey, string>>(() => {
    const counts = numericCountsFromConfig(value);
    const initial = {} as Record<PrizeKey, string>;
    for (const key of PRIZE_KEYS) {
      initial[key] = String(counts[key]);
    }
    return initial;
  });
  const syncedCountsRef = useRef<Record<PrizeKey, number>>(numericCountsFromConfig(value));
  const [templates, setTemplates] = useState<PersonalTemplate[]>(() => loadTemplates());
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [templateName, setTemplateName] = useState<string>('');
  const [templateFeedback, setTemplateFeedback] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  // 仅当外部真正改变了某档的数值 count（而非仅修改奖品内容、系统房规或结束方式）时，只同步真正变化的档位，
  // 从而在用户清空/输错某档数量后继续编辑其它档位或奖品内容时，绝不隐式恢复未变化档位的非法草稿。
  useEffect(() => {
    const changedKeys: PrizeKey[] = [];
    const nextSynced = { ...syncedCountsRef.current };
    for (const key of PRIZE_KEYS) {
      const incoming = value.prizes[key].count;
      if (incoming !== syncedCountsRef.current[key]) {
        nextSynced[key] = incoming;
        changedKeys.push(key);
      }
    }
    if (changedKeys.length === 0) return;

    syncedCountsRef.current = nextSynced;
    setRawCounts((prev) => {
      const next = { ...prev };
      for (const key of changedKeys) {
        next[key] = String(value.prizes[key].count);
      }
      return next;
    });
  }, [value.prizes]);

  const countError = validateCounts(rawCounts);

  useEffect(() => {
    onValidityChange?.(countError === null, countError);
  }, [countError, onValidityChange]);

  const handleRulesetChange = (rulesetId: RulesetId): void => {
    onChange({
      ...value,
      rulesetId,
    });
  };

  const handleEndModeChange = (mode: 'all-prizes' | 'rounds'): void => {
    if (mode === 'all-prizes') {
      onChange({
        ...value,
        endCondition: { mode: 'all-prizes' },
      });
      return;
    }
    const maxRounds = value.endCondition.mode === 'rounds' ? value.endCondition.maxRounds : DEFAULT_MAX_ROUNDS;
    onChange({
      ...value,
      endCondition: { mode: 'rounds', maxRounds },
    });
  };

  const handleRoundSelect = (maxRounds: 5 | 10 | 20): void => {
    onChange({
      ...value,
      endCondition: { mode: 'rounds', maxRounds },
    });
  };

  const handleCountChange = (key: PrizeKey, raw: string): void => {
    const nextRaw = { ...rawCounts, [key]: raw };
    setRawCounts(nextRaw);
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (Number.isSafeInteger(parsed) && parsed >= 1) {
        syncedCountsRef.current = {
          ...syncedCountsRef.current,
          [key]: parsed,
        };
        onChange({
          ...value,
          prizes: {
            ...value.prizes,
            [key]: {
              ...value.prizes[key],
              count: parsed,
            },
          },
        });
      }
    }
  };

  const handleContentChange = (key: PrizeKey, content: string): void => {
    onChange({
      ...value,
      prizes: {
        ...value.prizes,
        [key]: {
          ...value.prizes[key],
          content,
        },
      },
    });
  };

  /**
   * 恢复默认数量：只恢复六档份数（1/2/4/8/16/32），
   * 不清除已填奖品内容，也不切换当前选择的系统房规或结束方式。
   */
  const handleRestoreDefaultCounts = (): void => {
    const nextPrizes = { ...value.prizes };
    const nextRaw = {} as Record<PrizeKey, string>;
    const nextSynced = {} as Record<PrizeKey, number>;
    for (const key of PRIZE_KEYS) {
      const defaultCount = DEFAULT_PRIZE_COUNTS[key];
      nextPrizes[key] = {
        count: defaultCount,
        content: value.prizes[key].content,
      };
      nextRaw[key] = String(defaultCount);
      nextSynced[key] = defaultCount;
    }
    syncedCountsRef.current = nextSynced;
    setRawCounts(nextRaw);
    onChange({
      ...value,
      prizes: nextPrizes,
    });
  };

  const applyTemplate = (template: PersonalTemplate): void => {
    const nextRaw = {} as Record<PrizeKey, string>;
    const nextSynced = {} as Record<PrizeKey, number>;
    for (const key of PRIZE_KEYS) {
      const count = template.config.prizes[key].count;
      nextRaw[key] = String(count);
      nextSynced[key] = count;
    }
    syncedCountsRef.current = nextSynced;
    setRawCounts(nextRaw);
    setSelectedTemplateId(template.id);
    setTemplateName(template.name);
    onChange({
      ...value,
      prizes: structuredClone(template.config.prizes),
      endCondition: structuredClone(template.config.endCondition),
    });
    setTemplateFeedback({ tone: 'ok', text: `已载入个人方案「${template.name}」（系统房规保持不变）` });
  };

  const handleSelectTemplate = (id: string): void => {
    setSelectedTemplateId(id);
    const found = templates.find((item) => item.id === id);
    if (found) {
      applyTemplate(found);
    }
  };

  const handleLoadSelectedTemplate = (): void => {
    const found = templates.find((item) => item.id === selectedTemplateId) ?? templates[0];
    if (!found) {
      setTemplateFeedback({ tone: 'error', text: '当前没有可载入的个人方案' });
      return;
    }
    applyTemplate(found);
  };

  const handleSaveNewTemplate = (): void => {
    if (countError) {
      setTemplateFeedback({ tone: 'error', text: countError });
      return;
    }
    const outcome = upsertTemplate({
      name: templateName,
      config: {
        prizes: value.prizes,
        endCondition: value.endCondition,
      },
    });
    if (!outcome.ok || !outcome.template) {
      setTemplateFeedback({
        tone: 'error',
        text: outcome.message ?? '个人方案保存失败，仍可继续使用当前配置开房',
      });
      return;
    }
    const nextItems = outcome.items ?? loadTemplates();
    setTemplates(nextItems);
    setSelectedTemplateId(outcome.template.id);
    setTemplateName(outcome.template.name);
    setTemplateFeedback({
      tone: 'ok',
      text: `个人方案「${outcome.template.name}」已保存在当前浏览器`,
    });
  };

  const handleUpdateTemplate = (): void => {
    if (!selectedTemplateId) {
      setTemplateFeedback({ tone: 'error', text: '请先选择要更新的个人方案' });
      return;
    }
    if (countError) {
      setTemplateFeedback({ tone: 'error', text: countError });
      return;
    }
    const outcome = upsertTemplate({
      id: selectedTemplateId,
      name: templateName,
      config: {
        prizes: value.prizes,
        endCondition: value.endCondition,
      },
    });
    if (!outcome.ok || !outcome.template) {
      setTemplateFeedback({
        tone: 'error',
        text: outcome.message ?? '个人方案更新失败',
      });
      return;
    }
    const nextItems = outcome.items ?? loadTemplates();
    setTemplates(nextItems);
    setTemplateName(outcome.template.name);
    setTemplateFeedback({
      tone: 'ok',
      text: `个人方案「${outcome.template.name}」已更新`,
    });
  };

  const handleDeleteTemplate = (): void => {
    if (!selectedTemplateId) return;
    const target = templates.find((item) => item.id === selectedTemplateId);
    const outcome = deleteTemplate(selectedTemplateId);
    if (!outcome.ok) {
      setTemplateFeedback({
        tone: 'error',
        text: outcome.message ?? '删除个人方案失败',
      });
      return;
    }
    const nextItems = outcome.items ?? loadTemplates();
    setTemplates(nextItems);
    setSelectedTemplateId('');
    setTemplateName('');
    setTemplateFeedback({
      tone: 'ok',
      text: target ? `已删除方案「${target.name}」` : '已删除个人方案',
    });
  };

  const totalPrizes = totalConfiguredPrizes(value.prizes);
  const isDefaultCounts = PRIZE_KEYS.every((key) => {
    const raw = (rawCounts[key] ?? '').trim();
    return /^\d+$/.test(raw) && Number.parseInt(raw, 10) === DEFAULT_PRIZE_COUNTS[key];
  });
  const customContentCount = PRIZE_KEYS.filter((key) => value.prizes[key].content.trim().length > 0).length;
  const activeTemplateName = templates.find((item) => item.id === selectedTemplateId)?.name ?? null;
  const prizeSummaryText = PRIZE_KEYS.map((key) => {
    const raw = (rawCounts[key] ?? '').trim();
    const countText = /^\d+$/.test(raw) && Number.parseInt(raw, 10) >= 1 ? `${Number.parseInt(raw, 10)}` : '待填';
    return `${PRIZE_META[key].label} ${countText}`;
  }).join(' · ');

  return (
    <div className="room-config-form">
      {/* 1. 系统房规 */}
      <fieldset className="form-field config-fieldset" disabled={disabled}>
        <legend className="field-label">系统房规</legend>
        <div className="config-radio-grid">
          {RULESET_IDS.map((id) => {
            const preset = RULESETS[id];
            const checked = value.rulesetId === id;
            const inputId = `${baseId}-ruleset-${id}`;
            return (
              <label
                key={id}
                htmlFor={inputId}
                className={`config-radio-card ${checked ? 'is-active' : ''}`}
              >
                <span className="config-radio-head">
                  <input
                    id={inputId}
                    type="radio"
                    name={`${baseId}-ruleset`}
                    aria-label={preset.name}
                    checked={checked}
                    onChange={() => handleRulesetChange(id)}
                    disabled={disabled}
                  />
                  <span className="config-radio-title">{preset.name}</span>
                </span>
                <span className="config-radio-desc">{RULESET_DESCRIPTIONS[id]}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {/* 2. 结束方式 */}
      <fieldset className="form-field config-fieldset" disabled={disabled}>
        <legend className="field-label">结束方式</legend>
        <div className="config-radio-grid">
          <label
            htmlFor={`${baseId}-end-all`}
            className={`config-radio-card ${value.endCondition.mode === 'all-prizes' ? 'is-active' : ''}`}
          >
            <span className="config-radio-head">
              <input
                id={`${baseId}-end-all`}
                type="radio"
                name={`${baseId}-end-mode`}
                aria-label="奖品发完结束"
                checked={value.endCondition.mode === 'all-prizes'}
                onChange={() => handleEndModeChange('all-prizes')}
                disabled={disabled}
              />
              <span className="config-radio-title">奖品发完结束</span>
            </span>
            <span className="config-radio-desc">
              五档普通奖发完且有状元后，完成当前整轮收尾结算。
            </span>
          </label>

          <label
            htmlFor={`${baseId}-end-rounds`}
            className={`config-radio-card ${value.endCondition.mode === 'rounds' ? 'is-active' : ''}`}
          >
            <span className="config-radio-head">
              <input
                id={`${baseId}-end-rounds`}
                type="radio"
                name={`${baseId}-end-mode`}
                aria-label="固定轮数"
                checked={value.endCondition.mode === 'rounds'}
                onChange={() => handleEndModeChange('rounds')}
                disabled={disabled}
              />
              <span className="config-radio-title">固定轮数</span>
            </span>
            <span className="config-radio-desc">
              每人 5／10／20 轮，到轮数或发完奖即按当前轮收尾。
            </span>
          </label>
        </div>

        {value.endCondition.mode === 'rounds' ? (
          <div className="config-rounds-picker">
            <span className="field-label">每人轮数</span>
            <div className="pill-group">
              {ROUND_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`pill ${value.endCondition.mode === 'rounds' && value.endCondition.maxRounds === option ? 'is-active' : ''}`}
                  aria-pressed={value.endCondition.mode === 'rounds' && value.endCondition.maxRounds === option}
                  onClick={() => handleRoundSelect(option)}
                  disabled={disabled}
                >
                  {option} 轮
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </fieldset>

      {/* 3. 奖品数量摘要与“调整奖品与个人方案”展开区 */}
      <div className="config-advanced-box">
        <div className="config-summary-bar">
          <div className="config-summary-info">
            <div className="config-summary-title-row">
              <span className="field-label">奖品与个人方案</span>
              <span className="config-summary-meta">
                {isDefaultCounts && customContentCount === 0 ? `默认共 ${totalPrizes} 份` : `当前共 ${totalPrizes} 份`}
                {customContentCount > 0 ? ` · 已填 ${customContentCount} 项内容` : ''}
                {activeTemplateName ? ` · 方案「${activeTemplateName}」` : ''}
              </span>
            </div>
            <p className="config-summary-counts">{prizeSummaryText}</p>
          </div>
          <button
            type="button"
            id={advancedToggleId}
            className={`btn btn-secondary btn-small config-disclosure-btn ${advancedOpen ? 'is-expanded' : ''}`}
            aria-expanded={advancedOpen}
            aria-controls={advancedPanelId}
            onClick={() => setAdvancedOpen((prev) => !prev)}
            disabled={disabled}
          >
            <span>调整奖品与个人方案</span>
            <span className="config-disclosure-state" aria-hidden="true">
              {advancedOpen ? '收起 ▲' : '展开 ▼'}
            </span>
          </button>
        </div>

        {countError ? (
          <p className="form-error" role="alert">
            {countError}
          </p>
        ) : null}

        <div
          id={advancedPanelId}
          role="region"
          aria-labelledby={advancedToggleId}
          className="config-advanced-panel"
          hidden={!advancedOpen}
        >
          {/* 3a. 单层六行奖品表（桌面：奖级/数量/内容三列；手机：每档两行） */}
          <fieldset className="config-prizes-section" disabled={disabled}>
            <div className="config-section-bar">
              <div>
                <span className="field-label">六档奖品配置</span>
                <p className="field-hint">
                  当前共 <strong>{totalPrizes}</strong> 份奖品（状元份数全部归最终状元得主所有；内容留空则不显示说明）。
                </p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={handleRestoreDefaultCounts}
                disabled={disabled}
              >
                恢复默认数量
              </button>
            </div>

            <div className="config-prizes-head-row" aria-hidden="true">
              <span>奖级（牌型）</span>
              <span>数量（份）</span>
              <span>奖品内容（可选）</span>
            </div>

            <div className="config-prizes-list" role="list" aria-label="六档奖品配置列表">
              {PRIZE_KEYS.map((key) => {
                const meta = PRIZE_META[key];
                const countId = `${baseId}-count-${key}`;
                const contentId = `${baseId}-content-${key}`;
                const isChampion = key === 'zhuangyuan';
                return (
                  <div
                    key={key}
                    role="listitem"
                    className={`config-prize-item ${isChampion ? 'config-prize-item--champion' : ''}`}
                  >
                    <div className="config-prize-header">
                      <div className="config-prize-title-line">
                        <span className="config-prize-name">{meta.label}</span>
                        {isChampion ? (
                          <span className="config-prize-badge">全部归最终状元</span>
                        ) : null}
                      </div>
                      <span className="config-prize-desc">{meta.description}</span>
                    </div>

                    <div className="config-prize-count-wrap">
                      <label className="field-label config-inline-label" htmlFor={countId}>
                        <span className="visually-hidden">{meta.label}</span>数量
                      </label>
                      <input
                        id={countId}
                        aria-label={`${meta.label}数量`}
                        type="number"
                        min={1}
                        step={1}
                        className="input config-count-input"
                        value={rawCounts[key]}
                        onChange={(event) => handleCountChange(key, event.target.value)}
                        disabled={disabled}
                      />
                    </div>

                    <div className="config-prize-content-wrap">
                      <label className="field-label config-inline-label" htmlFor={contentId}>
                        <span className="visually-hidden">{meta.label}</span>奖品内容
                      </label>
                      <input
                        id={contentId}
                        aria-label={`${meta.label}奖品内容`}
                        type="text"
                        maxLength={40}
                        className="input config-content-input"
                        placeholder="可选，例如：月饼一盒"
                        value={value.prizes[key].content}
                        onChange={(event) => handleContentChange(key, event.target.value)}
                        disabled={disabled}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>

          {/* 3b. 独立收起的个人方案管理（本机存储） */}
          <div className="config-templates-collapsible">
            <div className="config-templates-bar">
              <div className="config-templates-bar-info">
                <span className="field-label">个人方案（本浏览器保存）</span>
                <p className="field-hint">
                  只保存六档数量、内容与结束方式，不改变系统房规与房间公开/停留设置。
                </p>
              </div>
              <button
                type="button"
                id={templatesToggleId}
                className={`btn btn-secondary btn-small config-disclosure-btn config-template-toggle-btn ${templatesOpen ? 'is-expanded' : ''}`}
                aria-expanded={templatesOpen}
                aria-controls={templatesPanelId}
                onClick={() => setTemplatesOpen((prev) => !prev)}
                disabled={disabled}
              >
                <span>个人方案管理</span>
                <span className="config-disclosure-state" aria-hidden="true">
                  {templatesOpen ? '收起 ▲' : '展开 ▼'}
                </span>
              </button>
            </div>

            <fieldset
              id={templatesPanelId}
              role="region"
              aria-labelledby={templatesToggleId}
              className="config-templates-panel"
              disabled={disabled}
              hidden={!templatesOpen}
            >
              <div className="config-template-row">
                <div className="form-field">
                  <label className="field-label" htmlFor={`${baseId}-tpl-select`}>
                    已存个人方案
                  </label>
                  <div className="config-template-select-group">
                    <select
                      id={`${baseId}-tpl-select`}
                      className="input"
                      aria-label="已存个人方案"
                      value={selectedTemplateId}
                      onChange={(event) => handleSelectTemplate(event.target.value)}
                      disabled={disabled || templates.length === 0}
                    >
                      <option value="">
                        {templates.length === 0 ? '暂无已保存方案' : '请选择个人方案…'}
                      </option>
                      {templates.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={handleLoadSelectedTemplate}
                      disabled={disabled || templates.length === 0}
                    >
                      载入方案
                    </button>
                  </div>
                </div>

                <div className="form-field">
                  <label className="field-label" htmlFor={`${baseId}-tpl-name`}>
                    个人方案名称
                  </label>
                  <input
                    id={`${baseId}-tpl-name`}
                    type="text"
                    maxLength={24}
                    className="input"
                    placeholder="例如：中秋家宴方案"
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                    disabled={disabled}
                  />
                </div>
              </div>

              <div className="config-template-actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={handleSaveNewTemplate}
                  disabled={disabled}
                >
                  保存方案
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={handleUpdateTemplate}
                  disabled={disabled || !selectedTemplateId}
                >
                  更新方案
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  onClick={handleDeleteTemplate}
                  disabled={disabled || !selectedTemplateId}
                >
                  删除方案
                </button>
              </div>

              {templateFeedback ? (
                <p
                  className={templateFeedback.tone === 'error' ? 'form-error' : 'config-template-ok'}
                  role={templateFeedback.tone === 'error' ? 'alert' : 'status'}
                >
                  {templateFeedback.text}
                </p>
              ) : null}
            </fieldset>
          </div>
        </div>
      </div>
    </div>
  );
}
