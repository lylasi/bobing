# 前端局内行为与浏览器回归交付说明（2026-09-27）

分支：`feat/room-experience-lobby`。
本文件记录本轮针对**对局体验、骰子动画时钟同步、最近记录抽屉交互、席位条坐标、E2E 适配以及新增体验用例**的实际改动、验证结果与边界约定。

---

## 1. 文件职责与改动清单

严格遵守协同边界与 Pi 文件所有权：
- **未触碰他人负责的文件**：`src/styles.css`、`src/styles-room-settings.css`、`tests/e2e/configuration.spec.ts`。
- **未触碰共享与服务层**：`shared/**`、`server/**`。
- **未触碰已完成的页面与 Hook**：`src/pages/Room.tsx`、`src/components/RoomHeader.tsx`、`src/pages/Lobby.tsx`、`src/hooks/useRoom.ts`、`src/lib/api.ts` 等。
- **改动文件**：
  1. `src/hooks/useDiceAnimation.ts`
  2. `src/components/RecentActivity.tsx`
  3. `src/components/SeatStrip.tsx`
  4. `tests/e2e/helpers.ts`
  5. `tests/e2e/dice.spec.ts`
  6. `tests/e2e/identity.spec.ts`
  7. `tests/e2e/multiplayer.spec.ts`
  8. `tests/e2e/mobile.spec.ts`
  9. `tests/e2e/experience.spec.ts`（新增）

---

## 2. 具体修复与功能实现

### 2.1 骰子动画时钟同步、粗粒度校时有界修正与结果展示阶段追赶（`src/hooks/useDiceAnimation.ts`）
- **核心问题与根因分析**：
  - 服务端 HTTP 响应头 `Date` 仅具整秒精度，客户端校时逻辑（`serverClockOffset`）为弥补向下截断加上了 +500ms 估计（误差区间为 ±500ms）；
  - 当本人在整秒边界刚过（如第 25ms）快速发起真实投掷并获得响应时，`serverNow() - latest.at` 会被系统性高估约 450–480ms；
  - 旧实现直接用 `serverNow() - latest.at` 作为已耗时长，导致仅耗时 15–25ms 的新鲜投掷被误判为迟到 470ms，初始阶段直接跳到 `settledCount = 3` 或 4，跳过了阶段 1（landing）与阶段 2（colliding）；且定时器每帧计算 `Math.max(elapsed + FRAME_MS, serverNow() - latest.at)` 持续被粗粒度时钟推高；
  - 此外，进行中的计时器未在房间被暂停或展示被撤销时立即中止，且未在组件注销/依赖变更时完备释放。
- **有界修正与单调推进修复方案**：
  1. **本地单调时钟上界与发信前采样（Monotonic Request Bound & Pre-Request Sample）**：
     - 在 `rollPending` 转为 true（请求发起）时，同时记录高精度单调时间戳 `armedAtRef.current = performance.now()` 与当时的校时基准 `armedServerNowRef.current = serverNow()`；
     - 收到权威记录时，计算本地实际等待时长 `elapsedSinceArmed = performance.now() - armedAt`；
     - 针对该手投掷的动画耗时，服务端当前时间以发信前采样为基准进行单调外推 `currentServerTime = armedServerNow + elapsedSinceArmed`，彻底隔绝因单边入站严重延迟（如 1350ms）导致中点 RTT 校时反向低估服务端时钟（~675ms 倒拨）；
     - 物理定律决定：服务端掷骰时刻必然晚于客户端发起时刻，因此自掷骰以来的真实耗时绝对不可能大于 `elapsedSinceArmed`；
     - 取两者的下界 `elapsedSinceRoll = Math.min(serverElapsed, elapsedSinceArmed)`，彻底消除了整秒边界处的粗粒度时钟伪迟到；且当 `elapsedSinceRoll >= TOTAL_ANIMATION_MS` 或 `elapsedSinceArmed >= TOTAL_ANIMATION_MS`（>=750ms）时，直接停稳呈现权威点数（`settledCount = 6`），绝不回放 1..5 阶段；
  2. **启动后单调推进（Monotonic Progression）**：
     - 动画启动时刻记录 `animStartTime = performance.now()`；
     - 计时器内部以单调差值 `initialElapsed + Math.max(0, currentNow - animStartTime)` 稳定推进，帧率调整为 50ms（`FRAME_MS = 50`），消除定时器抖动，保证快速投掷完整遍历 0..6 所有阶段；
  3. **权威暂停/取代即时中止与防泄漏（Authoritative Interruption & Leak-Proof）**：
     - 引入专用 Effect 监听 `room?.paused` 与 `room?.presentation`；
     - 当房间被房主暂停、展示被后续记录取代（`presentation.recordId !== latest.id`）或服务端展示明确终止时，立即 `clearRevealTimer()` 并瞬时呈现权威点数（`settledCount = 6`, `spinning = false`）；
     - 定时器循环内通过 `roomRef.current` 实时校验上述权威状态；
  4. **全套既有约束严格保持不变**：
     - 首次加载/页面刷新/断线重连（`hydratedGameRef.current === null`）绝不重播历史动画；
     - 他人投掷（`!latestIsMine`）直接显示点数，不播动画；
     - `prefers-reduced-motion` 保持直接停稳；
     - 请求失败（网络错误/超时拒绝）由 Effect 3 立即退出旋转并恢复上一手权威点数。

### 2.2 最近记录交互抽屉与产品文案去技术化（`src/components/RecentActivity.tsx`）
- **唯一可见/可操作掷骰控制**：
  - 收起抽屉时，移动端底部交互条（`.action-bar`）渲染唯一的掷骰按钮；
  - 展开抽屉时，底部交互条不再渲染该按钮，而是在抽屉底部（`.recent-drawer-footer`）渲染唯一的掷骰主按钮，全页面任意时刻主按钮不出现重复 ID 或同名冲突；
  - 点击抽屉内的掷骰按钮时，先关闭抽屉并重置状态，同时通过 `scrollIntoView` 智能平滑将瓷碗区域（`.bowl, .bowl-wrap, .game-center`）滚动回视口中心，确保主操作（`onRoll()`）立即派发不丢失。
- **无障碍焦点捕获与 Esc 恢复**：
  - 抽屉打开时将焦点锁定在关闭按钮上；
  - Tab / Shift+Tab 在抽屉内全部可聚焦且可见的元素（关闭按钮、筛选按钮、骰面展开项、底部掷骰按钮）间完整循环，防止焦点泄露至页面底层；
  - 按下 Esc 键时拦截冒泡、关闭抽屉，并将焦点安全恢复至底部的触发按钮（`.recent-bar-trigger`）。
- **ResizeObserver 留白安全区**：
  - 实测高度仅在底栏实际可见（高度大于 0 且非 `display: none`）时写入 `--mobile-dock-height`，桌面端隐藏或组件卸载时安全移除该变量，避免给桌面端正文产生不必要的固定留白。
- **文案优化与筛选独立性**：
  - 去除产品界面内生硬的技术实现用词（如“服务端240条窗口”）；
  - “只看我”空态改为自然友好的“最近记录中暂无你的投掷。”，底注明确说明“仅展示你在本局最近的投掷记录（最多 10 条）；“我的上一掷”始终独立保留。”；
  - 全桌记录底注更新为“显示全桌最近 N 条记录（含超时）；完整记录可在“记录”面板查看。”；
  - 筛选机制基于 `room.history` 过滤本人记录并截取最近 10 条，与 `player.lastRoll`（“我的上一掷”）服务端独立持久化机制完全解耦。

### 2.3 席位条横滑与当前状态（`src/components/SeatStrip.tsx`）
- **内部自滚动坐标计算**：
  - 容器内部滚动使用 `getBoundingClientRect()` 进行相对坐标计算（`itemRect.left - containerRect.left + container.scrollLeft`），消除父级 `offsetParent` 差异带来的偏移误差，仅横向滚动列表容器，绝不触发布局整页的垂直位移；
  - 维持当前行动席位骰子图标（🎲）、“当前” / “本次结果”状态徽章以及“我”、“离线”等高对比度标记。

### 2.4 E2E 测试套件适配与时序预算核对（`tests/e2e/dice.spec.ts` 健壮性修复）
- **修复展示期按钮禁用时的行动方误选（第 288 行与第 345 行）**：
  - **根因**：第二位玩家投掷完成后，服务端进入展示期（`room.presentation`），两端投掷按钮均被禁用；原测试立即执行 `isRollEnabled(host) ? host : guest`，在 host 为 false 时错误回退选中 guest，导致后续 route 拦截器未能改写真正行动方的 deadline；
  - **修复**：新增 `waitActiveRoller(host, guest)` 辅助函数，通过 `expect.poll` 显式等待展示期结束、权威轮转完成且某一方按钮明确变为 enabled 后再确定 `roller`，完整保留倒计时归零提示与禁用断言；
  - 超时测试（第 345 行）同理接入 `waitActiveRoller`，彻底避免超时展示期内选错玩家。
- **新增确定性回归用例（`tests/e2e/dice.spec.ts`）**：
  - 用例名称：`粗粒度服务端时钟下快速投掷保留完整 0..6 阶段，真实迟到(>750ms)直接呈现停稳权威结果`；
  - **场景 1（粗粒度时钟快速投掷）**：通过路由赋予响应整秒截断的 `Date` 头，使客户端产生真实整秒偏差，验证本地单调时钟约束生效，`settledCounts` 严格包含 `[0, 1, 2, 3, 4, 5, 6]`，`phases` 包含全部运动阶段；
  - **场景 2（真延迟超出 750ms 窗口，确定性覆盖 HTTP 优先与 WS 优先两种传输顺序）**：
    - 纠正关于“任意大于 750ms 延迟（如 850ms）必然跳过”的描述：在秒级 HTTP Date 截断存在 ±500ms 不确定性的前提下，若仅延迟 850ms，极端 -500ms 误差会导致纯时钟差仅评估为 350ms；测试采用确定的 1350ms 延迟（保证即便有 -500ms 误差，`serverElapsed` 仍稳定 `>= 850ms > 750ms`），且在实现中补充了物理流逝 `elapsedSinceArmed >= TOTAL_ANIMATION_MS` 的确定性保护；
    - 两手对局均在整秒边界后约 900ms 触发投掷（模拟最严苛整秒截断），循环覆盖两种信道竞争时序：
      1. **HTTP 优先（HTTP 延迟 1350ms，WS 延迟 2500ms）**：强制迟到的 HTTP 响应先到达并执行 `syncClockFrom`，验证发信前采样保护彻底阻止时钟倒拨，`settledCounts` 严格不含 1..5，直接停稳在 6；
      2. **WS 优先（HTTP 延迟 2500ms，WS 延迟 1350ms）**：验证 WebSocket 推送先到达时，同样瞬时停稳在 6，不回放 1..5。
    - 两者使用大于 1 秒的显式时间差（1350ms vs 2500ms），彻底杜绝网络时序随机性（timing lottery）；
  - 单局串行执行，控制用例耗时与房间配额。
- **新增适配辅助函数（`tests/e2e/helpers.ts`）**：
  - `openMoreMenuIfNeeded(page: Page)`：局中及结算时，邀请亲友、音效开关、房规、离开房间、提前结束及房间设置收纳至顶栏的“更多 ⋯”面板（`.room-more-btn`），该辅助函数在面板未展开时自动点击展开并等待 `#room-more-panel` 可见；
  - `readInviteUrl` 接入 `openMoreMenuIfNeeded`，统一支持等待室与局中获取分享链接；
  - `rollCount` 严格限定在全量记录区域（`.record-list .record, .history-panel .record`），避免页面中其他个人摘要或抽屉列表造成计数重叠；
  - `isRollEnabled` 采用 `.first().isEnabled()` 避免严格模式定位器歧义。
- **`playUntilFinished` 循环时序预算适配**：
  - 由于后端引入了权威结果展示阶段（默认 1 秒停留 + 750ms 动画，单手约 1.75s–2.5s），在此期间按钮处于不可掷状态；
  - 原逻辑在 400ms 轮询中消耗 `step` 计数，导致 60 步在等待展示阶段时提前耗尽报超限；
  - 现改为按实际完成的投掷次数（`rolls`）核算上限，并在每次成功投掷后等待 1.8 秒展示阶段自然结束，轮询预算扩容至与真实时钟节奏匹配。
- **既有测试调用点适配**：
  - `tests/e2e/dice.spec.ts`：在局中切换音效按钮（“开启音效” / “关闭音效”）前调用 `openMoreMenuIfNeeded`；
  - `tests/e2e/identity.spec.ts`：开局后点击“离开房间”及断言房主端“1/3 人”前调用 `openMoreMenuIfNeeded`；
  - `tests/e2e/multiplayer.spec.ts`：局中调用“邀请亲友”及房主“提前结束”二次确认前调用 `openMoreMenuIfNeeded`；
  - `tests/e2e/mobile.spec.ts`：局中验证五个次操作点击区域前调用 `openMoreMenuIfNeeded`，并在截图前收起更多面板，保证紧凑顶栏下首屏可见性。

### 2.5 新增对局体验 E2E 测试（`tests/e2e/experience.spec.ts`）
包含 5 组端到端全真流程用例，不依赖模拟或非生产测试接口：
1. **本人上一掷在他人最早合法投掷后持续保留、奖品明细独立可读（E01/E02）**：验证两名真实玩家对局中，第一位玩家投掷后产生个人上一掷摘要，第二位玩家在展示阶段结束后合法投掷，全桌最新记录更新为第二人，而第一位玩家页面上的“我的上一掷”和“我的奖品”弹层明细保持不变。
2. **常驻席位条（SeatStrip）展示人数、席位容量、在线状态与当前玩家骰子标识**：验证席位统计、容量（如 `2/4 席`）、“我”标识、以及当前出手的 🎲 骰子徽章。
3. **开局后紧凑顶部栏收纳次操作至“更多”面板，支持 Esc 键收起**：验证局中顶部收缩为紧凑单行、节奏与旁观徽章可见，展开更多面板后各项操作齐全，按 Esc 键正常收起。
4. **最近记录抽屉：焦点捕获、Esc 恢复、唯一掷骰主操作与“只看我”自然文案**：验证移动端最近 1 条入口、展开抽屉后的焦点 trap、Esc 关闭并恢复焦点、抽屉内唯一掷骰按钮、以及“只看我”筛选后的文案规范。
5. **房主在局中调整游戏节奏（结果停留秒数），两端实时生效**：验证房主通过“更多 -> 房间设置”将停留从 1 秒修改为 2 秒，两端顶部徽章均实时更新为 `停留 2 秒`。

---

## 3. 本地验证记录

| 验证项 | 实际执行命令 | 结果 |
| --- | --- | --- |
| 全局类型检查 | `npm run typecheck` (`tsc -p tsconfig.json --noEmit`) | **退出码 0，零类型错误** |
| 动画与音效阶段单元测试 | `npx vitest run tests/templates.test.ts` | **6 passed**（含 `stageForElapsed` 0..6 覆盖） |
| 后端与共享层测试套件 | `npx vitest run` | **9 个测试文件、270 个用例全部 PASS** |

按规定，未执行任何构建（`npm run build`）、未启动 E2E 真实服务器（`e2e-server`）、未执行 Playwright，亦未执行 `git commit` 或外部转发。
代码与用例均已完备就绪，交付主代理统一执行最终验收。
