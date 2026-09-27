/**
 * 移动端底部统一交互栏（最近 1 条记录浮条 + 唯一掷骰主按钮）与“最近 10 次 / 只看我”抽屉。
 *
 * 关键实现：
 * 1. 默认收起时，唯一主按钮位于 `.action-bar` 内；展开抽屉时，唯一主按钮移入抽屉底部 `.recent-drawer-footer`，
 *    点击“掷出好运”立即收起抽屉并露出骰碗。任意时刻页面内移动端的“掷出好运”按钮严格只有 1 个。
 * 2. 通过 ResizeObserver 实测 `.action-bar` 高度并写入 `--mobile-dock-height`，配合 safe-area 动态留白。
 * 3. 抽屉内部仅 `.recent-drawer-scroll` 一个滚动容器；阅读旧记录时来新记录不强拉回顶部，显示“有新记录”入口。
 * 4. 列表项使用 `.recent-item`（不使用 `.record`），避免与完整记录 region（History）产生 E2E 重复计数。
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { RollRecord, RoomState } from '../../shared/types.js';
import { describeRoll, latestRoll } from '../lib/format.js';
import { DiceRow } from './Dice.js';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function formatShortTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export interface RecentActivityProps {
  room: RoomState;
  playerId: string;
  canRoll: boolean;
  rolling: boolean;
  onRoll: () => void;
  onHeightChange?: (heightPx: number) => void;
}

export function RecentActivity({
  room,
  playerId,
  canRoll,
  rolling,
  onRoll,
  onHeightChange,
}: RecentActivityProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'mine'>('all');
  const [expandedDiceIds, setExpandedDiceIds] = useState<Record<string, boolean>>({});
  const [hasNewWhileScrolled, setHasNewWhileScrolled] = useState(false);

  const dockRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevLatestIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();

  const latest = latestRoll(room);
  const latestHeadline = latest ? describeRoll(latest, room) : null;

  // 实测底栏高度并同步至 CSS 变量，供页面正文留白与安全区使用
  useEffect(() => {
    const node = dockRef.current;
    if (!node) return undefined;

    const updateHeight = (): void => {
      const rect = node.getBoundingClientRect();
      const isVisible =
        rect.height > 0 && (node.offsetParent !== null || window.getComputedStyle(node).display !== 'none');
      if (isVisible) {
        const measured = Math.max(76, Math.ceil(rect.height));
        document.documentElement.style.setProperty('--mobile-dock-height', `${measured}px`);
        onHeightChange?.(measured);
      } else {
        document.documentElement.style.removeProperty('--mobile-dock-height');
        onHeightChange?.(0);
      }
    };

    updateHeight();

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => updateHeight());
      observer.observe(node);
    }
    window.addEventListener('resize', updateHeight);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateHeight);
      document.documentElement.style.removeProperty('--mobile-dock-height');
      onHeightChange?.(0);
    };
  }, [onHeightChange, open, latest?.id]);

  // 监听新记录到达：若用户已在抽屉中向下滚动阅读旧记录，不强拉回顶部，而是展示“有新记录”按钮
  useEffect(() => {
    const currentId = latest?.id ?? null;
    if (prevLatestIdRef.current !== null && currentId !== null && currentId !== prevLatestIdRef.current) {
      const scroller = scrollRef.current;
      if (open && scroller && scroller.scrollTop > 24) {
        setHasNewWhileScrolled(true);
      }
    }
    prevLatestIdRef.current = currentId;
  }, [latest?.id, open]);

  const closeDrawer = useCallback((): void => {
    setOpen(false);
    setHasNewWhileScrolled(false);
  }, []);

  // 抽屉打开时管理焦点、Esc 关闭与 Tab 循环；关闭后恢复入口按钮焦点
  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        triggerRef.current?.focus();
      }
      return undefined;
    }

    wasOpenRef.current = true;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeDrawer();
        return;
      }
      if (event.key !== 'Tab') return;
      const container = drawerRef.current;
      if (!container) return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) =>
          (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0) &&
          !el.hasAttribute('disabled'),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    closeBtnRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, closeDrawer]);

  const handleRollFromDockOrDrawer = (): void => {
    if (open) {
      setOpen(false);
      setHasNewWhileScrolled(false);
    }
    const bowlElement = document.querySelector('.bowl, .bowl-wrap, .game-center');
    if (bowlElement && typeof bowlElement.scrollIntoView === 'function') {
      try {
        bowlElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch {
        // fallback
      }
    }
    onRoll();
  };

  const toggleItemDice = (recordId: string): void => {
    setExpandedDiceIds((prev) => ({
      ...prev,
      [recordId]: !prev[recordId],
    }));
  };

  const scrollToTop = (): void => {
    scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    setHasNewWhileScrolled(false);
  };

  const sourceRecords: readonly RollRecord[] =
    filter === 'mine'
      ? room.history.filter((record) => record.playerId === playerId)
      : room.history;

  const recentItems = [...sourceRecords].slice(-10).reverse();

  const summaryText = (() => {
    if (!latest || !latestHeadline) {
      return '最近：骰声未起，暂无投掷记录';
    }
    const who = latest.playerId === playerId ? `${latest.nickname}（我）` : latest.nickname || '玩家';
    return `最近：${who} · ${latestHeadline.title}`;
  })();

  const renderPrimaryRollButton = (): ReactElement => (
    <button
      type="button"
      className="btn btn-primary btn-roll"
      onClick={handleRollFromDockOrDrawer}
      disabled={!canRoll}
      aria-busy={rolling}
      aria-describedby="game-turn-hint"
    >
      {rolling ? '骰落瓷碗，静候佳音…' : '掷出好运'}
    </button>
  );

  return (
    <>
      <div className="action-bar" ref={dockRef} role="region" aria-label="最近记录与掷骰主操作">
        <div className="action-bar-inner">
          <button
            ref={triggerRef}
            type="button"
            className="recent-bar-trigger"
            aria-expanded={open}
            aria-controls="recent-activity-drawer"
            onClick={() => setOpen((prev) => !prev)}
          >
            <span className="recent-bar-text">{summaryText}</span>
            <span className="recent-bar-cta">
              {open ? '收起 ↓' : '最近 10 次 ↑'}
            </span>
          </button>
          {!open ? renderPrimaryRollButton() : null}
        </div>
      </div>

      {open ? (
        <div
          className="recent-drawer-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDrawer();
          }}
        >
          <div
            id="recent-activity-drawer"
            ref={drawerRef}
            className="recent-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
          >
            <div className="recent-drawer-header">
              <div className="recent-drawer-title-row">
                <h2 id={titleId} className="recent-drawer-title">
                  最近投掷记录
                </h2>
                <button
                  ref={closeBtnRef}
                  type="button"
                  className="dialog-close"
                  onClick={closeDrawer}
                  aria-label="关闭最近记录抽屉"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>

              <div className="recent-filter-bar" role="group" aria-label="记录筛选">
                <button
                  type="button"
                  className={`recent-filter-btn ${filter === 'all' ? 'is-active' : ''}`}
                  aria-pressed={filter === 'all'}
                  onClick={() => setFilter('all')}
                >
                  全桌最近 10 次
                </button>
                <button
                  type="button"
                  className={`recent-filter-btn ${filter === 'mine' ? 'is-active' : ''}`}
                  aria-pressed={filter === 'mine'}
                  onClick={() => setFilter('mine')}
                >
                  只看我
                </button>
              </div>

              {hasNewWhileScrolled ? (
                <button type="button" className="recent-new-pill" onClick={scrollToTop}>
                  ↑ 有新记录，点击查看最新
                </button>
              ) : null}
            </div>

            <div
              ref={scrollRef}
              className="recent-drawer-scroll"
              onScroll={(event) => {
                if (event.currentTarget.scrollTop <= 16 && hasNewWhileScrolled) {
                  setHasNewWhileScrolled(false);
                }
              }}
            >
              {recentItems.length === 0 ? (
                <p className="empty-state">
                  {filter === 'mine'
                    ? '最近记录中暂无你的投掷。'
                    : '本局还没有产生投掷记录。'}
                </p>
              ) : (
                <ol className="recent-item-list">
                  {recentItems.map((item) => {
                    const headline = describeRoll(item, room);
                    const isMine = item.playerId === playerId;
                    const diceExpanded = Boolean(expandedDiceIds[item.id]);
                    return (
                      <li
                        key={item.id}
                        className={`recent-item recent-item--${headline.tone} ${isMine ? 'recent-item--mine' : ''}`.trim()}
                      >
                        <div className="recent-item-top">
                          <span className="recent-item-who">
                            <strong>{item.nickname || '已离开的玩家'}</strong>
                            {isMine ? <span className="tag tag-me">我</span> : null}
                            <span className="recent-item-round">第 {item.round} 轮</span>
                          </span>
                          <span className="recent-item-time">{formatShortTime(item.at)}</span>
                        </div>

                        <div className="recent-item-body">
                          <div className="recent-item-outcome">
                            <span className="recent-item-title">{headline.title}</span>
                            {headline.detail ? (
                              <span className="recent-item-detail">{headline.detail}</span>
                            ) : null}
                          </div>

                          {item.dice.length === 6 ? (
                            <button
                              type="button"
                              className="recent-item-dice-toggle"
                              aria-expanded={diceExpanded}
                              onClick={() => toggleItemDice(item.id)}
                            >
                              {diceExpanded ? '收起骰面' : `骰面 ${item.dice.join('·')}`}
                            </button>
                          ) : (
                            <span className="recent-item-timeout">超时跳过</span>
                          )}
                        </div>

                        {diceExpanded && item.dice.length === 6 ? (
                          <div className="recent-item-dice-box">
                            <DiceRow
                              dice={item.dice}
                              size="xs"
                              label={`${item.nickname} 第 ${item.round} 轮骰子：${item.dice.join('、')}`}
                            />
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              )}

              <p className="recent-drawer-footnote">
                {filter === 'mine'
                  ? `仅展示你在本局最近的投掷记录（最多 10 条）；“我的上一掷”始终独立保留。`
                  : `显示全桌最近 ${recentItems.length} 条记录（含超时）；完整记录可在“记录”面板查看。`}
              </p>
            </div>

            <div className="recent-drawer-footer">
              {renderPrimaryRollButton()}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
