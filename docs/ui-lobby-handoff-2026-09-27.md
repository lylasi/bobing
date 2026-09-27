# 前端交付说明：游戏大厅、旁观、入座转换与房间设置集成（2026-09-27）

分支：`feat/room-experience-lobby`。
严格遵守文件职责边界：仅新增/修改指定归属文件，未触碰 `src/styles.css`、`GameBoard.tsx`、`Results.tsx`、`MyRewards.tsx`、`ChampionHistory.tsx`、`RecentActivity.tsx`、`SeatStrip.tsx`、`format.ts`、`useDiceAnimation.ts`、`RoomSettingsFields.tsx`、`RoomSettingsDialog.tsx`、`RoomConfigForm.tsx`、`shared/` 与 `server/`。

---

## 1. 新增与修改文件清单

### 新增文件
- `src/hooks/useLobby.ts`：大厅分页与自动刷新 Hook（支持 `joinable` / `all` / `playing` 筛选、切换筛选自动取消旧请求并忽略乱序响应、`document.visibilityState === 'visible'` 下每 5 秒轮询、切回前台立即刷新、刷新失败保留现有列表并提示、显式 `nextCursor` 加载更多）。
- `src/hooks/useSpectatorRoom.ts`：只读观众实时同步 Hook（先 `GET /api/rooms/:code/watch` 取权威快照，再以 `{ role: 'spectator', roomCode, viewerId }` 握手 Socket.IO；严格按 `revision` 递增合并快照；断线重连重新同步；监听 `room:audience` 与 `room:watch-ended`，被撤销时停止重连并展示原因；绝不携带成员 token 或调用成员接口）。
- `src/components/RoomCard.tsx`：大厅房间摘要卡片（展示房名、6 位数字/旧房码、状态徽章、入座数/容量、在线参赛人数、房规与结束方式；按 `canJoin` 与 `allowSpectators` 渲染“加入 / 先看看 / 旁观”，本机已有成员身份时优先直接恢复原身份）。
- `src/pages/Lobby.tsx`：游戏大厅页（`/lobby`，包含“开一桌”、6 位房间码直达输入与数字/旧码键盘切换、三档筛选、空列表/错误重试/刷新失败保留列表提示、仅填昵称的入座弹层以及 409 满员/开局竞争时的一键“先去旁观”入口）。
- `src/components/SpectatorRoom.tsx`：只读观众房间视图（`/room/:code/watch`，明确区分“参赛 / 在线 / 旁观”人数，复用 `Bowl`、`SeatStrip`、`ChampionHistory`、`PlayerList`、`PrizePool`、`History` 实时展示等待室、对局中与结算页；不包含“我的奖品”、“我的上一掷”、准备、开始、掷骰、提前结束、再开一局或成员离开操作；等待中提供“我要入座”填昵称转正式成员，进行中显示“本局已开始，可在下一局入座”，收到 `room:watch-ended` 立即停止并展示原因）。
- `src/styles-lobby.css`：大厅、旁观与房间顶栏扩展样式表（响应式适配 320 / 375 / 768 / 1440 视口，确保触控目标 ≥44px 且无横向溢出）。
- `tests/e2e/lobby.spec.ts`：覆盖三浏览器真实大厅入座、只读旁观、再开局后“我要入座”转成员、成员身份优先恢复、`RoomSettingsDialog` 局内修改可见性/停留秒数/关闭旁观实时撤销观众的端到端测试用例。

### 修改文件
- `src/App.tsx`：接入 `/lobby`（`<Lobby />`）与 `/room/:code/watch`（`<Room code={route.code} mode="spectate" />`），引入 `./styles-lobby.css`。
- `src/pages/Room.tsx`：
  - 在 `MemberView` 中接入 `RoomSettingsDialog`，通过房主专属动作 `update-pacing` 与 `update-access` 保存设置（保持当前结果 deadline 不重置，保存失败保留弹层并显示错误）；
  - 支持 `mode="spectate"`：当本浏览器已存有该房间的有效成员凭证时，访问 `/room/:code/watch` 自动恢复为 `MemberView` 并同步路由为 `/room/:code`；无凭证时渲染 `SpectatorRoom`，并在观众成功入座后无缝切换为 `MemberView`。
- `src/components/RoomHeader.tsx`：
  - 为房主在等待室与局中“更多”面板提供“房间设置”按钮触发 `RoomSettingsDialog`；
  - 对全体成员（含非房主）展示当前结果停留秒数、可见性状态及实时旁观人数（`N 人旁观`）。
- `src/components/RoomLanding.tsx`：在邀请落地页补充结果停留时长展示、允许旁观时的“先看看 / 旁观”入口及“去游戏大厅”入口。
- `src/components/SiteHeader.tsx`：在非首页顶栏导航提供“游戏大厅”链接（首页保留 `Home.tsx` 内唯一“游戏大厅”入口，避免严格选择器冲突）。
- `src/hooks/useRoom.ts`：监听 `SOCKET_EVENT_AUDIENCE`（`room:audience`）并暴露 `viewerCount`，同时让 `update-pacing` / `update-access` 的错误由设置弹层内联处理。

---

## 2. 已执行验证与结果

按分工要求，未运行会争用 `dist/`、`.e2e-data` 或 `docs/screenshots` 的构建及完整 Playwright E2E 服务，仅执行只读与类型检查：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | **退出码 0（零错误）**，`tsc -p tsconfig.json --noEmit` 全量通过 |

---

## 3. 遗留问题与交接说明

- **无未解决的代码或类型错误**。
- 全部共享/前端/测试代码已通过 `npm run typecheck`，可由主代理统一执行 `npm run build` 与 Playwright 浏览器套件完成最终集成验收。

---

## 4. 定向修复（2026-09-27 根审查 3 项缺陷）

独占修复并验证以下 3 个核心缺陷：

### 1. `useLobby.ts` 请求生命周期与慢网络轮询统一
- **缺陷**：`loadMore` 进行中时，5 秒轮询刷新会中断请求，旧请求因 `signal.aborted` 直接退出未清除 `loadingMore`，而 `loadPages(mode refresh)` 亦未清理它，导致按钮永久停留“正在加载更多…”；反向 `loadMore` 打断 `refresh` 亦会导致 `refreshing` 残留；慢网络下 5 秒轮询会无休止中断当前未完成请求。
- **修复**：
  - 引入 `activeOpRef`（`'initial' | 'refresh' | 'loadMore' | null`）与 `requestSeqRef` 统一管理生命周期；
  - 慢网络轮询与前台切换事件在已有请求在进行中时自动跳过（非侵入保护），绝不无休止打断同页请求或加载更多；
  - 切换 filter 时仍执行 `abortRef.current?.abort()` 并自增 `seq`，彻底废弃旧 filter 的乱序过期响应；
  - 成功与失败分支（包括各模式互斥切换）均完整重置 `loading`、`refreshing`、`loadingMore`；
  - 刷新失败时保留已有 `rooms` 列表，展示错误横幅，手动点击“重试”或“刷新列表”可恢复更新。

### 2. `useSpectatorRoom.ts` 世代守卫（Generation Guard）与单调快照合并
- **缺陷**：`refresh`（重连）无 `AbortSignal` 且无 generation 检查；`code` 或 `attempt` 切换后，旧房间的延迟 `refresh` 仍可能合并旧快照，或以 `markWatchEnded` 误杀新房间的订阅；仅依赖闭包 `watchEndedRef` 会被新 effect 重置而失效。
- **修复**：
  - 增加 `generationRef`，在每次 `[code, attempt]` 切换时创建递增 generation 与独立的 `AbortController`；
  - `refresh` 传入对应代 signal 与 generation 校验，清理时调用 `controller.abort()` 与 `stopSocket()`；
  - 权威快照合并增加同房校验与严格单调检查（`snapshot.code === code && snapshot.revision > current.revision`）；
  - `markWatchEnded` 严格检查 `generation === generationRef.current`，旧房间的延迟错误/关闭通知彻底与新房间隔离。

### 3. `RoomHeader.tsx` 紧凑头部与“更多”面板交互无障碍修复
- **缺陷**：桌面端对局中/结算后无条件展示更多面板；移动端通过 `opacity: 0; pointer-events: none` 隐藏但键盘仍可 Tab 聚焦隐藏元素；开局后所有宽度未统一紧凑。
- **修复**：
  - 统一全断点设计：对局中/结算后全部宽度统一紧凑单行，仅展示房名、局号、旁观人数、停留秒数与“更多”按钮；
  - 恢复 `moreOpen` 条件渲染（未展开时 `room-more-panel` 根本不挂载到 DOM，杜绝键盘焦点泄露与屏幕阅读器误读）；
  - 彻底移除 `src/styles-lobby.css` 中的 `opacity: 0; pointer-events: none` hack；
  - 支持 Esc 键关闭面板并将焦点通过 `moreButtonRef` 合理送回“更多”按钮；
  - 点击面板内操作后自动关闭更多面板；
  - 更新 `tests/e2e/lobby.spec.ts` 中开局后提前结束先点击“更多”按钮。

### 5. 补充端到端回归测试用例（`tests/e2e/lobby.spec.ts`）
- `大厅请求生命周期回归：慢网络延迟刷新、刷新失败保留已有列表、手动重试成功恢复与筛选切换取消旧请求`：
  - 真实拦截 500 验证失败后保留已有列表，错误横幅展示列表更新失败提示；
  - 验证重试后列表恢复且横幅消失；
  - 验证切换到进行中标签页能取消 joinable 慢请求，过期幽灵房不串入。
- `旁观房间世代保护（generation guard）：延迟旧响应切换房间不串房、不误关订阅与开局后更多面板Esc控制`：
  - 模拟房间 A 延迟 `SPECTATING_DISABLED` 响应在访客切至房间 B 后到达，断言房间 B 订阅不被误关闭、不弹 alert、保持连接；
  - 验证开局后“提前结束”默认不在 DOM 中，点击“更多”展开、Esc 关闭且焦点回归“更多”按钮，再次点击“更多”成功提前结束游戏。

---

## 5. 定向修复（2026-09-27 根审查后续 5 项缺陷）

独占修复并全量跑通 `tests/e2e/lobby.spec.ts`：

### 1. 严格模式选择器多元素匹配消除
- **缺陷**：`getByText('大厅公开')` 匹配到房间标题 `中秋大厅公开桌` 与徽章；`getByText('本局已开始，可在下一局入座')` 匹配到旁观提示文字与单独文本节点。
- **修复**：对 `大厅公开`、`停留 1 秒`、`停留 3 秒`、`仅邀请`、`只读旁观`、`本局已开始，可在下一局入座`、`已连接` 等徽章与标签增加 `{ exact: true }`，完全消除 strict mode 冲突。

### 2. 大厅接口拦截路径与错误响应 DTO 规范化
- **缺陷**：旧用例拦截 `**/api/lobby*`（实际 REST 接口为 `GET /api/rooms?filter=...`），且错误结构为 `{code, message}` 而非 `{error: {code, message}}`，导致客户端退化为默认错误；假房间 DTO 包含不合规字段 `rulesetId` 与字符串 `endCondition`。
- **修复**：路由模式改为 `**/api/rooms?*`；错误结构修正为 `{ error: { code, message } }`；卡片 DTO 修正为包含 `rulesetName`、`onlinePlayerCount` 与对象型 `endCondition: { mode: 'all-prizes' }`。
- 控制台错误断言精准识别被测试注入的 500 网络日志，确保无其它未预期错误泄露。

### 3. 旁观世代守卫（Generation Guard）真实生命周期触发与慢加载更多回归
- **缺陷**：世代测试在初次加载后才装载拦截器且直接调用 `page.goto` 全局重新加载，无法触发真实的旧响应延迟到达。
- **修复**：
  - 访客端通过 `routeWebSocket` 代理关闭 WS 连接触发真实的 Socket.IO 快速重连刷新（`fetchWatchState(codeA)`）；
  - 等待房间 A 延迟请求确已在途后，通过 SPA 原生客户端路由（`history.pushState` + `popstate`）同 Document 切换至房间 B；
  - 放行房间 A 的 403 `SPECTATING_DISABLED` 响应，断言房间 B 旁观不受影响、不误关订阅且不报错；
  - 新增慢网络 `loadMore` 跨越 5 秒轮询测试：5.5 秒慢响应期间按钮显示“正在加载更多…”且禁用，5 秒轮询不打断进行中在途请求，响应完成后正常渲染新页卡片且按钮不卡死。

### 4. 旁观路由凭证恢复与失效平滑降级（`src/pages/Room.tsx`）
- **缺陷**：访问 `/room/:code/watch` 时，若本地存在任何已存凭证，原逻辑在未向服务端鉴权前立即将 URL 重定向至 `/room/:code`；凭证一旦判定为 `INVALID_TOKEN`，用户会落入加入落地页（`RoomLanding`），丢失了最初的旁观意图。
- **修复**：
  - 访问 `/room/:code/watch` 时保持旁观意图，不提前改写 URL；
  - 服务端验证有效（`room` 成功加载）后才将 URL 恢复为成员路由 `/room/:code`；
  - 凭证失效（`INVALID_TOKEN`）仅清理本地该房间的凭证（保留其它房间凭证），并平滑保留在 `/watch` 降级为 `SpectatorRoom`；
  - 遇到网络异常（`loadError`）时保留本地凭证，提供“重试”与“以观众身份先看看”安全降级入口；
  - 在 `lobby.spec.ts` 补充完整回归测试覆盖失效凭证降级、其它房间凭证保留、再入座转成员、有效凭证恢复以及网络错误凭证保留。

### 5. `useSpectatorRoom` 中 `stopSocket` 引用安全清理
- **修复**：在 `stopSocket` 中先对比 `socketRef.current === socket` 置空引用，再将局部 `socket` 置空与断开，避免产生残留的陈旧 ref。
