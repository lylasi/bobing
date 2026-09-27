# 博饼局内结果与手机体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让玩家看清实际获奖、追溯状元经历、识别轮次，并在手机上便捷查看记录和编辑奖品。

**Architecture:** 服务端保存每人最后一次机会、不可变状元事件和结果展示阶段；前端分开显示全桌最新结果与个人结果。沿用 React、现有 Dialog 和共享样式，按职责增加个人奖品、状元历程、席位条和底部记录组件。

**Tech Stack:** Node.js ≥24、TypeScript、React 19、Socket.IO、SQLite、Vitest、Playwright。

**Spec:** [已确认规格](../specs/2026-09-27-bobing-experience-and-lobby.md) 与 [实现契约](../specs/2026-09-27-bobing-implementation-contract.md)。UI 由 Pi 实施，其余由 DeepSeek Harness 实施；使用用户指定的 codeg delegate_to_agent 通道。契约中的可配置时长优先于原计划固定时间示例。

**执行状态：** 实现与本地验收完成，勾选表示最终实现及验证状态；实测、修复历史和截图见[验收记录](../../verification-2026-09-27.md)。未要求提交、推送或部署，纯提交步骤不执行。

## Global Constraints

- 本期主要使用场景是每人一部手机。
- 状元历程覆盖本房间本局，刷新或重新进入后仍可查看。
- 保留现有中式节庆视觉，改进布局与信息层级。
- 正常投掷：本人约 750ms 动画，结果阅读默认 1000ms，再开放下一位的 30000ms；超时仅展示配置的阅读时间。房主可设置 0–10 秒整数，从下一次结果生效。
- 普通 history 最多 240 条，完整状元历程和每人最后结果独立保存。
- 新结果必须来自服务端；判奖、库存、同分先到先得和高阶锁定规则沿用现有行为。
- 数量至少为 1 的整数；普通奖即时发放，状元全部份数只在实际结算时发放。
- 刷新、重连和重复响应不重播旧动画或旧声音；减少动态效果不会改变服务端回合时间。
- 本轮交付 375／768／1440 三档，补查 320px、长内容、12 人和移动键盘。
- 新增测试仅覆盖状态、权限、数据和跨组件交互；纯视觉调整使用现有浏览器流程与截图验证。

---

## 文件职责与依赖

| 文件 | 改动责任 |
| --- | --- |
| shared/types.ts | 状元事件、当次状元判定、个人最后记录、展示阶段 DTO |
| shared/presentation.ts（新增） | 动画常量、0–10 秒结果停留配置与计算 |
| server/game.ts | 生成事实、展示阶段推进、暂停恢复及终局 |
| server/room-service.ts | 白名单快照、动作限制、tick 提交与归档 |
| server/room-migrations.ts | 旧快照归一化、完整性标记与严格验证 |
| src/lib/format.ts | 基于当次事实生成奖品和状元结果文案 |
| src/components/MyRewards.tsx（新增） | 我的上一掷、实得奖品、个人状元经历 |
| src/components/ChampionHistory.tsx（新增） | 当前状元摘要与完整历程 |
| src/components/SeatStrip.tsx（新增） | 人数、本人、当前席位和在线状态 |
| src/components/RecentActivity.tsx（新增） | 最新一条与最近十条抽屉 |
| src/components/GameBoard.tsx、History.tsx、RoomHeader.tsx | 整合结果、底栏、顶部与可复用记录 |
| src/components/RoomConfigForm.tsx、WaitingRoom.tsx | 六档奖品单层编辑与原有草稿生命周期 |
| src/hooks/useDiceAnimation.ts、src/pages/Room.tsx、src/styles.css | 展示时序、页面状态和响应式布局 |

依次完成任务 1–5。任务 1、2 修改共享契约，先完成持久化与服务端验证再接入 UI；不在本计划中实现大厅或观众身份。

## Task 1: 保存当次获奖事实与状元历程

**Files:** 修改 shared/types.ts、server/game.ts、server/room-service.ts、server/room-migrations.ts、src/lib/format.ts、tests/game.test.ts、tests/server.test.ts、tests/db.test.ts。

**Interfaces:**

- 消费：现有 DiceResult、PrizeKey、RollRecord、Champion、RoomState、InternalRoom。
- 产出：以下新类型；Player 与 InternalPlayer 增加 `lastRoll: RollRecord | null`；RollRecord 增加 `championOutcome: ChampionOutcome | null`；RoomState 与 InternalRoom 增加 `championEvents: ChampionEvent[]` 和 `championHistoryComplete: boolean`。

```ts
export interface ChampionOutcome {
  kind: 'first' | 'takeover' | 'improved' | 'tied' | 'lower' | 'locked' | 'legacy-unknown';
  previousPlayerId: string | null;
  currentPlayerId: string | null;
  locked: boolean;
}

export interface ChampionEvent {
  id: string;
  recordId: string | null; // settled 没有新的投掷记录
  kind: 'first' | 'takeover' | 'improved' | 'settled';
  playerId: string;
  nickname: string;
  previousPlayerId: string | null;
  previousNickname: string | null;
  round: number;
  at: number;
  dice: number[];
  result: DiceResult;
  locked: boolean; // 该次登顶／提高成绩同时触发锁定
  awardedCount: number; // 非 settled 为 0
}
```

- [x] **Step 1: 在 tests/game.test.ts 现有 makeRoom／player 辅助函数下添加业务断言。**

```ts
it('被顶替仍保留登顶经历，个人最后结果与实际奖品分别保存', () => {
  const room = makeRoom(2);
  startGame(room, T0, 0);
  const first = applyRoll(room, 'p0', SIHONG, T0 + 1);
  const second = applyRoll(room, 'p1', WUZI, T0 + 2);
  expect(room.championEvents.map(event => event.kind)).toEqual(['first', 'takeover']);
  expect(second.championOutcome?.previousPlayerId).toBe('p0');
  expect(player(room, 'p0').lastRoll?.id).toBe(first.id);
  expect(player(room, 'p0').awards.zhuangyuan).toBe(0);
  finishGame(room, 'host-ended', T0 + 3);
  finishGame(room, 'host-ended', T0 + 4);
  expect(room.championEvents.filter(event => event.kind === 'settled')).toHaveLength(1);
  expect(player(room, 'p1').awards.zhuangyuan).toBe(room.initialPool.zhuangyuan);
});
```

同组补齐：同分、较低、已经锁定时不产生登顶事件；本人提高成绩为 improved；历史截断不删事件；超时更新 lastRoll；数据库重开仍保留事件。先运行 `npx vitest run tests/game.test.ts tests/db.test.ts`，确认新增断言因字段缺失或事实缺失失败。

- [x] **Step 2: 在一次投掷中建立唯一关联。** 先生成 recordId，再判奖；registerChampion 返回 ChampionOutcome，只有归属或成绩实际变化时追加事件。原 awardPrize 改为同时返回普通发奖结果与状元判定，applyRoll 只消费一次。使用以下写入顺序：

```ts
// record 已包含预先生成的 id、实际 awarded、championOutcome。
pushHistory(room, record);
player.lastRoll = structuredClone(record);
// championEvents 只由 registerChampion / finishGame 写入，pushHistory 不处理它。
```

finishGame 仅在首次实际发放状元份数时追加 settled；离线过期仍沿用不补发语义。startGame／prepareRematch 清空 lastRoll 和事件、重置完整性为 true。

- [x] **Step 3: 同步序列化与旧数据迁移。** toPublicRoom 白名单深拷贝上述字段；旧玩家 lastRoll 可从现有 history 中找到其最后一条，没有则为 null；旧状元记录的 outcome 标为 legacy-unknown；旧局事件数组为空且完整性为 false。新格式中字段类型损坏继续报错，不能静默当旧数据。终局归档和旧归档读路径同步处理，不从 best 伪造登顶。

- [x] **Step 4: 改历史文案的数据来源并验证。** describeRoll 对新记录读取 championOutcome；legacy-unknown 显示“掷出状元牌型，旧记录未保存当时归属”。不再用当前 room.champion.locked 重解释旧记录。运行 `npx vitest run tests/game.test.ts tests/server.test.ts tests/db.test.ts` 与 `npm run typecheck`，修正所有显式 Player／RollRecord 测试夹具的新字段。

- [x] **Step 5: 审阅本任务涉及文件（本轮不提交）。** 建议提交说明：`feat: preserve personal outcomes and champion history`。

## Task 2: 服务端控制结果阅读阶段

**Files:** 新增 shared/presentation.ts；修改 shared/types.ts、server/game.ts、server/room-service.ts、server/room-migrations.ts、src/hooks/useDiceAnimation.ts、tests/game.test.ts、tests/server.test.ts、tests/clock.test.ts、tests/configurable-play.acceptance.test.ts。

**Interfaces:**

- 消费：Task 1 的 RollRecord、最后结果与事件。
- 产出：RoomState／InternalRoom 增加 `presentation: ResultPresentation | null`；仅 InternalRoom 增加 `presentationRemainingMs: number | null`。game.ts 导出 `completeResultPresentation(room: InternalRoom, now: number): boolean`。

```ts
// shared/presentation.ts
export const DICE_REVEAL_MS = 750;
export const DEFAULT_RESULT_HOLD_SECONDS = 1;
export const MIN_RESULT_HOLD_SECONDS = 0;
export const MAX_RESULT_HOLD_SECONDS = 10;

// shared/types.ts
export interface ResultPresentation {
  recordId: string;
  until: number | null; // 全员参赛者离线暂停时为 null
}
```

- [x] **Step 1: 添加阶段行为断言。** 使用 tests/game.test.ts 现有 makeRoom 与常量：

```ts
it('结果读完才轮到下一位，下一位拿到完整三十秒', () => {
  const room = makeRoom(2);
  startGame(room, T0, 0);
  const record = applyRoll(room, 'p0', YIXIU, T0 + 100);
  expect(room.presentation?.recordId).toBe(record.id);
  expect(room.deadline).toBeNull();
  expect(completeResultPresentation(room, T0 + 1849)).toBe(false);
  expect(completeResultPresentation(room, T0 + 1850)).toBe(true);
  expect(room.turnPlayerId).toBe('p1');
  expect(room.deadline).toBe(T0 + 1850 + TURN_MS);
  expect(completeResultPresentation(room, T0 + 1851)).toBe(false);
});
```

在测试中导入新函数。运行 `npx vitest run tests/game.test.ts`，确认时间断言失败。

- [x] **Step 2: 把 applyRoll／skipExpiredTurn 的即时 advanceTurn 换成展示阶段。** record 写入后设置 presentation、清空 deadline。正常投掷 until = now + DICE_REVEAL_MS + room.pacing.resultHoldSeconds * 1000；timeout 仅加配置停留时长。0 秒超时允许即时完成展示。新导出函数在 game.ts 中实现：

```ts
export function completeResultPresentation(room: InternalRoom, now: number): boolean {
  const presentation = room.presentation;
  if (room.status !== 'playing' || room.paused || !presentation) return false;
  if (presentation.until === null || now < presentation.until) return false;
  room.presentation = null;
  room.presentationRemainingMs = null;
  advanceTurn(room, now);
  return true;
}
```

展示阶段保留原 turnId 作为该次结果的上下文；任何新的 roll 都不能使用它重复投掷。最后一掷在 completeResultPresentation 中通过现有 advanceTurn 进入结算。

- [x] **Step 3: 接入动作、计时与恢复。** handleRoll 仍先查原回执，再检查 presentation；新增 `RESULT_SHOWING` 错误码，HTTP 409，文案“本次结果展示中，请稍候”。tickRoom 先推进已结束的 presentation，再按现有超时／在线流程处理；发生终局时照常设置到期并由 commit 归档。所有提交仍先持久化再广播。

暂停与恢复必须使用独立剩余时间，核心转换为：

```ts
// pauseRoom 的展示分支，设置 paused / deadline / lastActivityAt 后返回。
room.presentationRemainingMs = Math.max(0, (room.presentation.until ?? now) - now);
room.presentation.until = null;

// resumeRoom 的展示分支，清除 paused / 更新 lastActivityAt 后返回。
room.presentation.until = now + (room.presentationRemainingMs ?? 0);
room.presentationRemainingMs = null;
```

结束、关闭、开局和再开局清理 presentation。结果展示者离席时，dropCurrentTurnIfPlayer 不再提前 advanceTurn，由展示结束后统一跳过已离席席位；全员离席与房主结束仍立即按原终止规则收尾。旧房 presentation=null；重启恢复时尊重已有暂停剩余值。

- [x] **Step 4: 适配原有即时推进测试并补回归。** 原判奖／轮次测试在每次 roll 或 timeout 后明确调用 completeResultPresentation，再进行下一手；时间取该次 presentation.until，后续 now 单调递增。保留新阶段测试使用原始 applyRoll，不能把所有测试都包装成“自动跳过阶段”。

```ts
// 仅供原有“不关心展示时长”的游戏测试显式调用。
function finishDisplayedResult(room: InternalRoom): number {
  const until = room.presentation?.until;
  if (until === null || until === undefined) throw new Error('缺少待展示结果');
  expect(completeResultPresentation(room, until)).toBe(true);
  return until;
}
```

新增 HTTP 抢掷、幂等重试、最后一手、展示中离席、展示中全员掉线／重启、超时展示及仅余一人场景。另测默认 1 秒、0／10 秒边界、非法小数与越界、非房主拒绝、修改不重置当前阶段与准备状态。useDiceAnimation 的总时长改引用 DICE_REVEAL_MS；迟到的新记录按服务端时间显示最终结果，不补播过期动画。

- [x] **Step 5: 运行相关验证（本轮不提交）。** `npx vitest run tests/game.test.ts tests/server.test.ts tests/clock.test.ts tests/configurable-play.acceptance.test.ts`、`npm run typecheck`。提交说明：`feat: add a shared result reading phase between turns`。

## Task 3: 我的结果、奖品与状元历程

**Files:** 新增 MyRewards.tsx、ChampionHistory.tsx；修改 GameBoard.tsx、PrizePool.tsx、Results.tsx、src/lib/format.ts、src/pages/Room.tsx、src/styles.css；扩展 tests/e2e/dice.spec.ts 和 tests/e2e/mobile.spec.ts。

**Interfaces:**

- 消费：RoomState.players[].lastRoll、awards、config.prizes、championEvents、championHistoryComplete、presentation。
- 产出：`MyRewards({ room, playerId }: { room: RoomState; playerId: string })`；`ChampionHistory({ room, playerId }: { room: RoomState; playerId?: string })`；格式函数 `formatActualAward(record: RollRecord, room: RoomState): string | null`。

- [x] **Step 1: 实现共享奖品文案并替换普通结果小字。**

```ts
export function formatActualAward(record: RollRecord, room: RoomState): string | null {
  if (record.awarded === null) return null;
  const key = record.awarded;
  const content = room.config.prizes[key].content.trim();
  return content ? '获得' + content + ' ×1' : '获得 1 份';
}
```

完整结果标题由牌型、当次 championOutcome 与实际 awarded 组合。库存为空不使用当前 pool 倒推，读取 record.result.prize 与 record.awarded 判定。实际累计奖品从 awards 读取，不从近期记录累计。

- [x] **Step 2: 实现 MyRewards 与 ChampionHistory 并接入。** MyRewards 摘要常显最后机会及实际累计份数，详情使用现有 Dialog。ChampionHistory 展示按时间排列的完整事件；first／takeover 算登顶，improved 不计，settled 才展示发奖数量。空、旧局不完整、锁定、已被顶和最终状态按设计稿文案覆盖。

GameBoard 在 presentation 非空时使用“本次结果展示中”，canRoll 增加 `room.presentation === null` 条件；倒计时不把 deadline=null 误写成“等待开局”。Results 顶部保留最后结果摘要与已结算个人奖品。个人卡以 `(gameNumber, lastRoll.id)` 为标识，presence 快照不会触发重复动效。

- [x] **Step 3: 用两个真实浏览器验证结果留存。** 在 tests/e2e/dice.spec.ts 添加以下用例，沿用 helpers.ts 已有的建房和准备流程；同时保留该文件已有的两端骰面一致性断言。

```ts
// 按需合并到文件已有的 import。
import { test, expect } from '@playwright/test';
import { createRoom, readInviteUrl, joinByInvite, toggleReady, startGame } from './helpers.js';

test('他人投掷与刷新不会覆盖我的上一掷', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const host = await first.newPage();
    const guest = await second.newPage();
    await createRoom(host, { nickname: '阿月', roomName: '结果留存', maxPlayers: 2, rounds: 5 });
    await joinByInvite(guest, await readInviteUrl(host), '小林');
    await toggleReady(guest);
    await startGame(host);
    const hostFirst = await host.getByRole('button', { name: '掷出好运', exact: true }).isEnabled();
    const [playerA, playerB] = hostFirst ? [host, guest] : [guest, host];
    await playerA.getByRole('button', { name: '掷出好运', exact: true }).click();
    await expect(playerB.getByRole('button', { name: '掷出好运', exact: true })).toBeEnabled();
    const mine = playerA.getByRole('region', { name: '我的上一掷' });
    const before = await mine.innerText();
    await playerB.getByRole('button', { name: '掷出好运', exact: true }).click();
    await expect(playerA.getByRole('button', { name: '掷出好运', exact: true })).toBeEnabled();
    await expect(mine).toHaveText(before);
    await playerA.reload();
    await expect(mine).toHaveText(before);
  } finally {
    await first.close();
    await second.close();
  }
});
```

随机骰面测试只断言与真实权威结果一致；特殊状元序列用 Task 1 的可控服务端测试覆盖，不给生产接口增加自选骰子入口。

- [x] **Step 4: 验证（本轮不提交）。** `npm run typecheck`，构建后运行 `npx playwright test tests/e2e/dice.spec.ts tests/e2e/mobile.spec.ts`，检查截图中的真实点阵与长奖品文案。提交说明：`feat: show lasting personal rewards and champion milestones`。

## Task 4: 席位条、顶部收纳与最近记录底栏

**Files:** 新增 SeatStrip.tsx、RecentActivity.tsx；修改 GameBoard.tsx、RoomHeader.tsx、History.tsx、Dialog.tsx、src/pages/Room.tsx、src/styles.css、tests/e2e/helpers.ts、tests/e2e/mobile.spec.ts、tests/e2e/layout.spec.ts。

**Interfaces:**

- `SeatStrip({ room, playerId }: { room: RoomState; playerId: string })`：只读真实席位，presentation 阶段不声明下一位已经可操作。
- `RecentActivity({ room, playerId, action }: { room: RoomState; playerId: string; action: ReactNode })`：统一容纳最近记录和主按钮；打开抽屉时 action 移到抽屉底部，保持 DOM 中只有一个可见主按钮。
- History 扩展 `records?: RollRecord[]` 与 `showWindowNote?: boolean`，保留原 limit；传入筛选后的 records 时不再重复截断或写死“240 条”。

- [x] **Step 1: 构建席位条与紧凑顶栏。** 手机依次为房名／更多、人数／头像、轮次、状元摘要、碗区；等待时邀请仍常显。更多复用 Dialog 焦点和 Esc；结束、离开沿用已有 ConfirmDialog。头像横向容器内部滚动，不撑宽页面；除颜色外还显示“我／当前／离线”。

- [x] **Step 2: 实现两种近期记录列表。**

```ts
const recentTable = room.history.slice(-10).reverse();
const recentMine = room.history.filter(record => record.playerId === playerId).slice(-10).reverse();
const latest = room.history.at(-1) ?? null;
```

默认一行 latest；打开后显示 recentTable，可切 recentMine。使用记录 id 标识条目；用户阅读旧内容时维持滚动位置并提供新记录提示。抽屉内单层滚动，完整骰面通过展开该条查看。原完整历史面板标记为 region“完整投掷记录”，helpers.ts 的 rollCount／latestDiceLabel 等查询限定在该 region，避免把悬浮列表与完整列表重复计数。

- [x] **Step 3: 统一底栏高度与正文留白。** 底部容器包含安全区；用 ResizeObserver 测量实际高度，在该 GameBoard 根节点设置 `--game-bottom-inset`。关闭抽屉恢复焦点；展开时移入主按钮，背景不能出现第二个可操作掷骰按钮。抽屉中的投掷点击先关闭抽屉再调用 onRoll，让玩家看见本次动画。

```css
.game { padding-bottom: calc(var(--game-bottom-inset, 0px) + 16px); }
.game-bottom-bar { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
.recent-activity-dialog { max-height: min(70dvh, 640px); }
.recent-activity-dialog__list { min-height: 0; overflow-y: auto; }
```

替换原 `.room-main` 固定 120px 留白，避免双重 padding；History 在抽屉中禁用原 380px 内滚动。品牌导航手机房间态减高，桌面整体布局不变。

- [x] **Step 4: 验证交互和几何。** 复用 mobile／layout 流程检查：当前席位始终可找到；375px 首屏不需切 Tab 就能看到个人结果；最近记录打开／关闭、Escape、键盘焦点正确；12 人、12 字昵称、长奖品内容和 200% 文字缩放不互相覆盖；主操作只有一个且热区至少 44px。运行 `npx playwright test tests/e2e/mobile.spec.ts tests/e2e/layout.spec.ts` 并人工查看截图。

- [ ] **Step 5: 提交（本轮不执行）。** 建议说明：`feat: simplify mobile table navigation and recent activity`。

## Task 5: 奖品编辑整理与整体验收

**Files:** 修改 RoomConfigForm.tsx、WaitingRoom.tsx、src/styles.css、docs/ui-design.md、docs/acceptance-matrix.md；使用现有 tests/e2e/configuration.spec.ts、tests/room-config.test.ts、tests/templates.test.ts。

**Interfaces:** RoomConfigForm 的 value、onChange、onValidityChange 与 defaultAdvancedOpen 契约保留；原 rawCounts 仍是未完成数字输入的唯一草稿来源。

- [x] **Step 1: 改为单层奖品编辑布局。** 保留表单逻辑，只重新组织六档行、总份数、可展开规则说明和个人方案区。布局取值如下：

```css
.prize-editor-row { display: grid; grid-template-columns: 7rem 6rem minmax(0, 1fr); gap: 12px; }
.prize-editor-row input { min-width: 0; min-height: 44px; }
@media (max-width: 599px) {
  .prize-editor-row { grid-template-columns: minmax(0, 1fr) 104px; }
  .prize-editor-row__content { grid-column: 1 / -1; }
}
```

数量和内容有独立 label；状元数量解释可展开且不截断。恢复默认继续只改数量。首页保持摘要默认收起，等待室直接展开六档。

- [x] **Step 2: 用现有关键用例验证草稿与保存。** 清空一个数量后编辑另一档内容，原非法草稿仍保留并阻止保存；恢复默认不丢奖品文字；载入方案不改房规；presence 更新不重置编辑；提交失败保留草稿；修改成功其他玩家取消准备。纯排版不额外编写镜像测试。运行 `npx vitest run tests/room-config.test.ts tests/templates.test.ts` 与 `npx playwright test tests/e2e/configuration.spec.ts`。

- [x] **Step 3: 更新界面说明与验收表。** 将设计稿 E01–E11 对应到实际通过的测试或截图；记录旧局不完整历程的展示方式。记录真实执行结果，不能用计划中的预期替代实测。

- [x] **Step 4: 完成一次整体检查。** 运行 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`。此前定向测试通过后不重复运行无关测试，最终全量只做一次；仅在失败或再次改动时重跑对应范围。截图放 `docs/screenshots/` 并人工检查 375／768／1440。

- [x] **Step 5: 交付（本轮不提交）。** 提交说明：`refactor: clarify prize editing and document the game experience`。交付变更摘要、验证结果及旧房兼容边界，再进入大厅与旁观计划。
