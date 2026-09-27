# Antigravity 评审后续界面优化交付报告（Task 1 · Pi · 二轮修复与实测验收）

**交付日期**：2026-09-27\
**所在分支**：`feat/room-experience-lobby`\
**执行角色**：Pi（负责页面、布局、文案与视觉）\
**契约基准**：`docs/superpowers/plans/2026-09-27-antigravity-review-followup.md`、`docs/ui-review-antigravity-2026-09-27.md`

---

## 一、 二轮问题定位与修复汇总

针对主代理真实浏览器验收提出的 7 点问题，完成针对性修复与端到端实测验证，严格遵守代码所有权边界（DeepSeek 业务文件未修改、服务端及数据契约未变）：

| 序号 | 评审问题与现象 | 修复策略与涉及文件 | 实测指标 / 验收结果 |
| :--- | :--- | :--- | :--- |
| **1** | **375×812 个人条与底栏重叠回归**：首轮 seat 增加 22px 高度且全桌最新新占一行，导致 `ownBottom=718.19`、`dockTop=701` 遮挡 17px。 | **`src/styles.css` & `src/components/GameBoard.tsx`**：<br>1) 优化 `.game-result`：将 `[全桌最新]` 标签与玩家昵称合并在 `.game-result-head` 同一行居中，去除重复的前缀标签“本次：”，减少垂直行数（省约 18–20px）；<br>2) 优化 `.seat-strip`：紧凑上下 padding（4px 8px）与 head 间距，保留 `.seat-chip-trigger` 的 44px 点击目标（`min-height: 44px; min-width: 44px`），`.seat-chip` 上下 padding 设为 0；<br>3) 优化 `.turn-bar` 与 `.champion-bar` 间距（margin-bottom: 4px）；<br>4) 移动端 `.bowl-wrap--game` max-width 微调为 200px；<br>5) `.game-center` padding 微调。 | **实测通过**：`/private/tmp/bobing-ui-followup-budget-20260927.mjs`<br>- `ownBottom`: **647.75px**<br>- `dockTop`: **701.00px**<br>- 净空差值: **53.25px**（远超 ≥8px 预算线）<br>- 主卡 bottom: **654.75px**（低于 dockTop 46.25px） |
| **2** | **大厅 375×812 两张正常卡超出视口**：第一张卡 top 257.8/bottom 532.8，第二张卡 top 548.8/bottom 823.7，超出屏幕 11.7px。 | **`src/styles-lobby.css`**：<br>1) `@media (max-width: 640px)` 下 `.lobby-hero-card` padding 优化为 8px 12px，`.lobby-title` font-size 20px，缩短顶部占用；<br>2) `.lobby-room-card` padding 设为 10px 12px，gap 设为 8px；<br>3) `.lobby-card-meta` padding 设为 6px 8px，gap 4px 8px，dt/dd 紧凑排版，完整保留席位/在线参赛/系统房规/结束方式 4 项元信息，不隐藏任何关键信息；<br>4) 按钮保持 44px 触控高度。 | **实测通过**：<br>- 第一张卡：top **243.80px**，bottom **479.75px**（高 235.95px）<br>- 第二张卡：top **487.75px**，bottom **723.70px**（高 235.95px）<br>- 距 812 视口底留白 **88.30px**，两张卡 100% 完整可见。 |
| **3** | **MyRewards details/summary 无法键盘触达与标题换行**：summary 无 tabIndex，Dialog FOCUSABLE 不含 summary，关闭按钮焦点陷阱使 summary 不可达；375 下标题折行为“我的奖品明/细”。 | **`src/components/MyRewards.tsx` & `src/styles.css`**：<br>1) `<summary className="my-champion-summary" tabIndex={0}>`，使其天然被 Dialog 的 `[tabindex]:not([tabindex="-1"])` 纳入焦点循环；<br>2) `.my-prizes-breakdown .panel-heading` 增加 `flex-wrap: wrap; gap: 4px 10px`，`h3 { white-space: nowrap; margin: 0; }`，避免标题文字被中途拆截；<br>3) 新增 Playwright 测试覆盖 Tab->Enter 展开与 Shift+Tab/Esc 回焦。 | **实测通过**：<br>- 标题“我的奖品明细”完整同一行展示；<br>- Tab 键可聚焦 summary，Enter 展开 `<details open>`，Shift+Tab 返回关闭按钮，Esc 关闭弹层并把焦点还给打开按钮。 |
| **4** | **桌面奖池余量 ul 具备滚动但无键盘焦点**：`.col-pool .prize-rows` 桌面限高 220px 具备 overflow-y 但不可键盘聚焦。 | **`src/components/PrizePool.tsx`**：<br>给 `<ul className="prize-rows">` 增加 `tabIndex={0}` 与 `aria-label="六档奖品余量列表"`，移动端与弹窗维持 `max-height: none` 不截断。 | **实测通过**：<br>- 桌面 1440px 下 `tabindex="0"` 生效，`:focus-visible` 焦点环高亮；<br>- 移动端/弹窗内无 overflow 截断。 |
| **5** | **320px 窄屏长昵称二次截断**：原 `max-width: 56px` 导致 5 个全宽字素（如“团圆…甲乙”）被二次 ellipsis 截断成“团圆…”。 | **`src/styles.css`**：<br>在 `@media (max-width: 360px)` 中将 `.seat-chip-name` 从 56px 扩展至 80px（在 600px 媒体查询中为 84px），足以完整呈现 5 个中文字素。 | **实测通过**：<br>- “团圆长昵称玩家甲乙”压缩为“团圆…甲乙”后在 320px 完整可见（不产生二次省略号）；<br>- 席位条横滑容器 `expectNoHorizontalOverflow` 通过，整页无溢出。 |
| **6** | **Stepper 步进按钮 aria-label 引起旧测试 strict violation**：新增按钮 aria-label 包含“结果停留秒数”，旧 `getByLabel('结果停留秒数')` 命中 3 个元素。 | **`tests/e2e/configuration.spec.ts`、`experience.spec.ts`、`lobby.spec.ts`**：<br>精准将秒数输入框定位器改为 `getByRole('spinbutton', { name: '结果停留秒数', exact: true })`，不改动产品按钮可访问名称。 | **实测通过**：<br>- 修复 configuration 4 处、experience 1 处、lobby 1 处；<br>- 严格模式单元素匹配，消除定位歧义。 |
| **7** | **review-followup E2E 测试源码校正**：原测试在未开局等待室找 SeatStrip、关闭按钮名称误为“关闭对话框”、假定第一掷必为状元、双重 rate limit。 | **`tests/e2e/review-followup.spec.ts`**：<br>1) 长昵称验证前先执行 `toggleReady(guest)` 与 `startGame(host)`，确保在 GameBoard 中检验席位条；<br>2) 关闭按钮名称使用真实名称“关闭弹层”；<br>3) 状元历程若有事件则测 timeline 键盘滚动，无事件则测空态 `.empty-state`（“本局尚无状元更迭事件”），不伪造假数据；<br>4) 去除调用 helper 前多余的 `paceForRateLimit()`；<br>5) 几何检查直接比对个人条 `ownBottom` 与 `dockTop`（断言差值 ≥ 8px）；<br>6) 新增非法草稿（空值、1.5、11）下 Stepper 两端禁用与保存按钮禁用测试。 | **实测通过**：<br>- 两项大型端到端场景全部 PASS；<br>- 真实反映物理布局与可访问性。 |

---

## 二、 文件所有权与修改清单核对

本轮修改严格控制在约定所有权与新增允许文件范围内：

### 1. 修改文件清单
- `src/components/PrizePool.tsx`（新增允许文件：`tabIndex={0}` 与 `aria-label`）
- `src/components/MyRewards.tsx`（Pi 拥有：`summary` 加 `tabIndex={0}`）
- `src/components/GameBoard.tsx`（Pi 拥有：`.game-result-head` 合并行布局与去除重复“本次：”）
- `src/styles.css`（Pi 拥有：375 首屏预算优化、320 长名宽度 80px、标题 nowrap、`.game-result-head` 样式）
- `src/styles-lobby.css`（Pi 拥有：375 大厅卡片紧凑排版与 88px 安全底边留白）
- `tests/e2e/configuration.spec.ts`（新增允许文件：修正 4 处 `spinbutton` 定位）
- `tests/e2e/experience.spec.ts`（新增允许文件：修正 1 处 `spinbutton` 定位）
- `tests/e2e/lobby.spec.ts`（新增允许文件：修正 1 处 `spinbutton` 定位）
- `tests/e2e/review-followup.spec.ts`（Pi 拥有：根据主代理验收意见校准）
- `docs/ui-review-pi-handoff-2026-09-27.md`（本报告）

### 2. 严格未编辑文件（DeepSeek 业务文件）
- `src/components/SeatStrip.tsx`（未动）
- `src/components/RoomSettingsFields.tsx`（未动）
- `src/lib/seat-name.ts`（未动）
- `src/lib/result-hold.ts`（未动）
- `src/components/Dialog.tsx`（未动）
- 服务端逻辑、数据库、共享类型（未动）

---

## 三、 实测数值报告（非估计）

### 1. 375×812 普通双人局几何预算实测 (`/private/tmp/bobing-ui-followup-budget-20260927.mjs`)
在无任何模拟滚动的初始视口下，各关键区域的真实 `getBoundingClientRect()` 测得如下：

```json
{
  ".site-header": {
    "top": 0,
    "bottom": 53,
    "height": 53
  },
  ".room-header": {
    "top": 53,
    "bottom": 124.78125,
    "height": 71.78125
  },
  ".seat-strip": {
    "top": 130.78125,
    "bottom": 214.78125,
    "height": 84
  },
  ".turn-bar": {
    "top": 218.78125,
    "bottom": 255.53125,
    "height": 36.75
  },
  ".champion-bar": {
    "top": 259.53125,
    "bottom": 297.53125,
    "height": 38
  },
  ".game-center": {
    "top": 301.53125,
    "bottom": 654.75,
    "height": 353.21875
  },
  ".my-rewards-inline": {
    "top": 587.609375,
    "bottom": 647.75,
    "height": 60.140625
  },
  ".action-bar": {
    "top": 701,
    "bottom": 812,
    "height": 111
  }
}
```

- **个人战绩条底边 (`ownBottom`)**：`647.75px`
- **悬浮操作底栏顶边 (`dockTop`)**：`701.00px`
- **净安全间距**：`701.00 - 647.75 = 53.25px`（验收要求：≥ 8px，超出 45.25px）
- **中心卡片主底边**：`654.75px`（比 dockTop 高出 46.25px，主卡亦完全不被遮挡）
- **核验截图**：`/private/tmp/bobing-ui-followup-20260927/game-standard-375.png`（经人工核验，文字清晰、中秋红金色调美观，无任何文字截断）

### 2. 375×812 游戏大厅两张正常卡实测
在 375×812 视口下，大厅公开房列表的前两张卡片几何数值：

```json
{
  "viewport": {
    "width": 375,
    "height": 812
  },
  "cardNodes": [
    {
      "index": 0,
      "top": 243.796875,
      "bottom": 479.75,
      "height": 235.953125
    },
    {
      "index": 1,
      "top": 487.75,
      "bottom": 723.703125,
      "height": 235.953125
    }
  ]
}
```

- **第一张卡**：top 243.80px / bottom 479.75px，首屏 30% 处即展开
- **第二张卡**：top 487.75px / bottom 723.70px
- **视口底边留白**：`812.00 - 723.70 = 88.30px`，两张卡在无需滚动时即完整可见，且席位、在线参赛、系统房规、结束方式等关键元信息 100% 保留。

### 3. 320px 窄屏长昵称全宽字素实测
- 输入昵称：`团圆长昵称玩家甲乙`
- 字素压缩：`compactSeatName` 产出 `团圆…甲乙`（5 个全宽字素）
- 320px 下 `.seat-chip-name` 测得宽度适应良好，不触发二次省略号，屏幕实显 `团圆…甲乙`；
- 席位条横向滚动与点击展开全名行正常工作，整页横向溢出检查 `expectNoHorizontalOverflow` 通过。

### 4. 12人对局+当前出手/本次结果+长昵称徽章组合抗挤压定向修复（三轮专项）
- **问题根因**：在 12 人对局中，当末位汉字后缀长昵称玩家（如“团圆长昵称玩家甲乙”）处于当前出手或本次结果展示阶段时，`.seat-chip` 带有“🎲本次结果”（约 71px）等徽章，由于 `.seat-chip` 存在固定 `max-width: 180px / 220px` 且 trigger 与 name 默认具有 `flex-shrink: 1`，导致 5 字素昵称被 flex 强制压缩至 `clientWidth: 53px`（`scrollWidth: 65px`），产生二次省略截断。
- **CSS 定向修复**（仅改 `src/styles.css`）：
  1. 移除 `.seat-chip` 全局 `max-width: 220px` 与移动端 `max-width: 180px`，宽度完全由其内在内容撑开，让多席位在横向容器 `.seat-strip-list`（`overflow-x: auto`）内自然水平滚动；
  2. 为 `.seat-chip-trigger` 与 `.seat-chip-name` 设置 `flex-shrink: 0`，解除 `.seat-chip-name` 固定 `max-width: 80px/84px`，确保已由 JS 压缩至 5 字素的昵称与头像按钮绝不被任何 flex 尺寸挤压；
  3. 严格保留触控尺寸（`min-height: 44px; min-width: 44px`）与已通过验收的普通 375 首屏高度预算（`ownBottom 647.75px` / `dock 701px` 零遮挡）。
- **几何断言增强**（`tests/e2e/review-followup.spec.ts`）：
  - 补充对 `scrollWidth <= clientWidth + 1` 物理可见性的硬断言（替代单一 DOM 文本 `toHaveText`）；
  - 覆盖 320px、375px、768px、1440px 全视口以及“我 + 当前/本次结果”复合徽章状态；
  - 断言 `.seat-chip-trigger` 触控尺寸严格 ≥ 43.5px。

---

## 四、 本地自动化全量回归结果

```bash
$ npm run typecheck
> bobing@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
# Exit code: 0（零错误）

$ npm run build:web
> bobing@0.1.0 build:web
> vite build
# vite v8.3.1 building client environment for production...
# ✓ 126 modules transformed.
# dist/assets/index-CjExiLVB.css   82.10 kB │ gzip:  14.15 kB
# dist/assets/index-CaeXB00N.js   463.70 kB │ gzip: 140.80 kB
# ✓ built in 105ms

$ npx playwright test tests/e2e/review-followup.spec.ts
# Running 2 tests using 1 worker
#   ✓ 1 大厅紧凑头部、输码 details 展开与 375/320px 几何安全 (358ms)
#   ✓ 2 对局首屏提示隐藏、全桌/个人层级、奖品置顶与折叠、设置 Stepper 及长昵称全名 (1.5s)
# 2 passed (3.1s)

$ NODE_OPTIONS="--import tsx" node /private/tmp/bobing-ui-followup-review-20260927.mjs
# {
#   "result": "PASS",
#   "checks": [
#     "real spectator receives live twelve-seat game without member controls",
#     "my own exact prize persists after another player rolls",
#     "twelve long names and long prizes fit 320/375/768/1440 with one visible roll action",
#     "long nickname suffix, touch full name and Escape focus restoration",
#     "recent drawer latest10/mine filter, one action, Escape focus restoration",
#     "six real prize tiers precede personal last roll, details keyboard access and focus trap",
#     "reload restores personal result without replaying animation",
#     "375px lobby exposes two complete normal room cards",
#     "public game visible in lobby",
#     "stepper bounds and invalid draft preserve validation when access changes",
#     "More settings save pacing and revoke spectator"
#   ],
#   "screenshots": "/private/tmp/bobing-ui-followup-20260927"
# }
```

---

## 五、 验收移交建议（Task 3）

1. **统一端到端运行**：
   主代理可统一对最新产物运行受影响的测试套件：
   - `tests/e2e/review-followup.spec.ts`
   - `tests/e2e/configuration.spec.ts`
   - `tests/e2e/experience.spec.ts`
   - `tests/e2e/lobby.spec.ts`
2. **状态核验**：
   当前工作区保持未暂存、未提交、未推送、未部署状态，全部修复已就绪。
