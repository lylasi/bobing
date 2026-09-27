# Antigravity Review Follow-up Implementation Plan

> **For agentic workers:** 按任务逐项执行。用户已指定 Pi 与 DeepSeek Harness，由主代理通过 codeg `delegate_to_agent` 派发；不得使用其他代理或再次派发。

**Goal:** 落实 Antigravity 评审的七项界面与交互优化，保持现有玩法、权限及数据契约。

**Architecture:** Pi 负责布局、样式与展示组件；DeepSeek 负责昵称可辨识交互及停留秒数编辑逻辑。共用目录按文件隔离，主代理负责设计接口、审阅与集成验收。

**Tech Stack:** React 19、TypeScript、Vite、Vitest、Playwright。

**Spec:** `docs/ui-review-antigravity-2026-09-27.md`；基础业务约束见 `docs/superpowers/specs/2026-09-27-bobing-implementation-contract.md`。

## Global Constraints

- 本轮用户已授权实施，前次会话“只评审”范围不再适用于本轮。
- 本计划的文件分工覆盖前次契约中笼统的 src/ 归属；其余业务约束继续有效。
- 每人一部手机；默认停留 1 秒，范围 0–10 整数秒；新房默认公开、可选仅邀请；米白、红、金中秋风格。
- 不修改玩法、服务端权限、奖品计算、结果展示计时、网络 DTO 或真实数据库。
- 保留所有现有未提交内容；禁止 restore/reset/clean、提交、推送、部署。不要用格式化重写整个文件。
- 测试使用临时数据库和本地隔离服务；主代理统一运行集成测试，代理不要并发启动 E2E 服务。
- 保留数字码前导零、旧字母码兼容、真正只读旁观、唯一掷骰主操作、个人上一掷与未结算状元语义。

## Task 1: Pi — 页面、布局、文案与视觉

**Files (exclusive ownership):**
- Modify: `src/components/GameBoard.tsx`, `src/components/MyRewards.tsx`, `src/components/RoomSettingsDialog.tsx`, `src/components/ChampionHistory.tsx`（如有必要）, `src/pages/Lobby.tsx`。
- Modify: `src/styles.css`, `src/styles-room-settings.css`, `src/styles-lobby.css`。
- Create: `tests/e2e/review-followup.spec.ts`（有意义的交互与几何回归）、`docs/ui-review-pi-handoff-2026-09-27.md`。
- 不编辑 Task 2 的文件；不改后端与共享类型。不覆盖旧截图，新增截图使用 `70-review-*` 等名称。

**Interfaces:** DeepSeek 将提供 `.seat-chip-trigger` 原生按钮（内含头像及 `.seat-chip-name`）、`.seat-full-name` 全名状态行、`.settings-hold-stepper` 容器以及 `.settings-hold-step` 按钮。按钮可访问名称为“减少结果停留秒数”“增加结果停留秒数”。现有输入名称“结果停留秒数”、旧 class、组件 Props 均保留。Pi 负责这些 class 的样式；不需等逻辑完成才写样式。

- [x] 读取报告与当前组件，查看 60/61/62/64/66/67/68 截图，确认真实 class（报告少数 class 为概称）。
- [x] ≤900px 隐藏 `.game-center .game-hint-note`，保留 `game-turn-hint`、轮次与底栏反馈；桌面保留辅助说明。

```css
@media (max-width: 900px) {
  .game-center .game-hint-note { display: none; }
}
```

- [x] 为全桌最新结果添加简洁语义锚点，个人上一掷保留；避免新增大段文字再次拉高首屏。保持 `.game-result-who` 等现有定位 class。
- [x] 奖品详情 DOM 顺序调整为六档明细、个人上一掷、可展开状元经历；采用原生 details/summary，摘要显示现有事实状态与登顶次数，保留完整奖品及旧局说明。保留 `.my-champion-exp` 容器，使用真实数据，不推导虚假登顶。六档顺序、奖品份数与未结算状元语义不变。
- [x] 设置弹窗顶部精简为“公开范围与旁观设置保存后立即生效。”；秒数旁由 Task 2 保留 0–10、默认 1、0 秒保留动画、下次结果生效的唯一说明。给步进按钮 ≥44×44px、禁用与 focus-visible 样式，在 320px 不溢出。
- [x] 昵称按钮支持 44px 触控区域、焦点态与全名行换行。不要只靠 title 呈现全名。
- [x] 大厅压缩 hero，移动端“开一桌”和“输码直达”紧凑并列；可用原生 details 收纳现有房码表单，不改变输入/提交逻辑。展开后数字码、旧码和错误反馈仍可操作。375×812 默认首张卡约在首屏 35% 附近，普通房名可看至少两张卡；320px 无横向溢出。长名称允许完整换行，不能为了高度隐藏重要房间状态。
- [x] >900px 桌面奖池与状元历程设置合理可滚动高度，标题/当前状元保持可见；滚动区域键盘可访问，手机和弹窗不限高、不截内容。
- [x] 新增少量 Playwright 回归，覆盖真实交互：首屏提示隐藏、全桌/个人信息同时存在、奖品明细排在经历之前且折叠可展开、长昵称后缀与触摸全名、stepper 两端禁用和非法草稿、紧凑大厅的输码展开。几何测试用 boundingBox 检查不溢出和底栏不遮挡。

```ts
await expect(page.getByRole('button', { name: '减少结果停留秒数', exact: true })).toBeDisabled(); // 输入为 0
await expect(page.getByRole('button', { name: '增加结果停留秒数', exact: true })).toBeDisabled(); // 输入为 10
await expect(dialog.locator('.my-prize-row')).toHaveCount(6);
```

- [x] 运行 `npm run typecheck`；回报文件、改动与未验证项到独立交付文档，交由主代理统一运行浏览器验收。

## Task 2: DeepSeek — 交互业务逻辑

**Files (exclusive ownership):**
- Modify: `src/components/SeatStrip.tsx`, `src/components/RoomSettingsFields.tsx`。
- Create: `src/lib/seat-name.ts`, `src/lib/result-hold.ts`, `tests/ui-interactions.test.ts`, `docs/ui-review-deepseek-handoff-2026-09-27.md`。
- 其他文件只读，尤其不能编辑 CSS、GameBoard、MyRewards、Lobby、RoomSettingsDialog、E2E。

**Interfaces:**

```ts
// src/lib/seat-name.ts：使用 Intl.Segmenter 的 grapheme，避免截断 emoji/组合字符。
export function compactSeatName(nickname: string): string;
// ≤5 字素保持；>5 返回前2 + … + 后2；只用于呈现，原始昵称不改。

// src/lib/result-hold.ts：复用 shared/presentation.ts 的上下限。
export function parseResultHoldSeconds(raw: string): number | null;
export function validateResultHoldSeconds(raw: string): string | null;
export function stepResultHoldSeconds(raw: string, direction: -1 | 1): number | null;
// 原始草稿非法或目标超界均 null；合法草稿严格 ±1，无默认回退或悄悄钳制。
```

- [x] 写有意义的单元回归：`团圆长昵称玩家01` / `02` 分别为 `团圆…01` / `02`；短名不变；家庭 emoji 和组合字符不能拆开。
- [x] 写数值边界回归：空值、`1.5`、`-0`、`-1`、`11`、`1e1`、`NaN` 非法；0 与 10 合法；0 减/10 加返回 null；非法草稿点步进不改变也不发出有效值。

```ts
expect(compactSeatName('团圆长昵称玩家01')).toBe('团圆…01');
expect(stepResultHoldSeconds('0', -1)).toBeNull();
expect(stepResultHoldSeconds('10', 1)).toBeNull();
expect(stepResultHoldSeconds('1.5', 1)).toBeNull();
expect(stepResultHoldSeconds('1', 1)).toBe(2);
```

- [x] 实现 helper，运行 `npx vitest run tests/ui-interactions.test.ts`。
- [x] SeatStrip 保留 li、data-seat-player、滚动逻辑与状态徽章。头像+昵称置于 type=button 的 `.seat-chip-trigger`；按钮 accessible label 含完整昵称，aria-expanded/aria-controls 关联一个 `.seat-full-name` 状态行。点击同项开关、点击别项切换、Escape 关闭并保持/恢复触发按钮焦点；已离席项不显示悬空详情。全名不只依赖 title；不引入 portal、全页滚动或新的席位业务状态。
- [x] RoomSettingsFields 抽出原有解析/校验，保留旧组件导出 validateResultHoldSeconds（可 re-export），保留 rawHoldSeconds 与 syncedHoldSecondsRef 的同步契约。新增 `.settings-hold-stepper` 包裹原输入，左右按钮 `.settings-hold-step`，type=button。onClick 通过 stepResultHoldSeconds 后调用现有 handleHoldSecondsChange；disabled 时、非法草稿时或目标越界时禁用。保留直接输入及 onValidityChange。
- [x] 秒数说明改为“0–10 秒，默认 1 秒；0 秒保留动画，下次结果生效。”；不要修改其他布局/文案。错误关联通过独立 id 和 aria-describedby，disabled 禁用所有编辑；切换可见性或收到同值 pacing 不覆盖非法草稿。
- [x] 运行 `npm run typecheck` 与定向 Vitest；回报实现、测试与约束。无后端需求时不改后端，不为分工人为新增接口。

## Task 3: 主代理 — 集成验收

- [x] 收集两个 codeg task 结果，按临时基线核对新增差异，确认无旧改动被覆盖。
- [x] `npm run typecheck`、`npm test`、`npm run build`、`git diff --check`。
- [x] 对隔离测试服务运行 review-followup、experience、mobile、lobby 等受影响 E2E，新增截图人工查看 320/375/768/1440，重点首屏、奖品、设置、大厅与长名。
- [x] 对发现的实现问题通过 codeg 原指定代理回派，主代理负责验收文档 `docs/verification-ui-review-2026-09-27.md`，不代写代理拥有的业务或 UI 源码。
- [x] 交付已完成项、实际测试结果与限制；保持未提交、未部署状态。

## 验收完成

2026-09-27：七项建议已落实，290 项单元测试、15 项受影响 E2E、11 组独立浏览器检查通过。补充授权 Pi 编辑 PrizePool.tsx 和旧 E2E 的精确秒数定位，解决键盘可访问性与回归断言问题。最终证据见 `docs/verification-ui-review-2026-09-27.md`。
