# UI E2E 针对性修复交付报告（2026-09-27）

本报告记录在分支 `feat/room-experience-lobby` 上针对 UI E2E 审查发现所完成的有界 E2E-only 修复，涵盖：
1. **真实限流预算调度器纠偏**（移除 `watchConsole` 被动计数耦合，在所有直接创建/加入提交前显式预约，纠正滑动窗口过期索引与循环，按 `E2E_BASE_URL` origin 隔离状态文件）；
2. **骰子动画粗粒度与延迟回归确定性纠偏**（提前挂载双上下文 WebSocket 路由、整秒边界 ~25ms 对齐、受控 per-page 延迟与中间阶段 1..5 彻底排除）。

---

## 1. 职责边界与文件所有权核对

按照协作分工要求：
- **独占修改文件**：
  1. `tests/e2e/helpers.ts`（移除被动监听、基于 origin 隔离、安全容量 29、纠正过期索引与重试循环）
  2. `tests/e2e/lobby.spec.ts`（11 处真实创建/加入前显式调用 `await paceForRateLimit()`，弹窗打开按钮不消耗额度）
  3. `tests/e2e/configuration.spec.ts`（真实创建提交前调用 `await paceForRateLimit()`）
  4. `tests/e2e/dice.spec.ts`（修复最后 1 项动画回归测试：提前挂载 WebSocket 路由、对齐整秒边界投掷、严格断言无 1..5 中间态与安全等待）
  5. `docs/ui-e2e-followup-2026-09-27.md`（本报告）
- **未触碰其他代理文件**：
  - 未修改 `src/styles.css`（由样式代理负责）；
  - 未修改任何产品源码（`server/**`、`shared/**`、`src/**`）；
  - 未做 git commit / push；未运行生产构建、E2E 测试或改写 `dist/`、`.e2e-data`、`test-results/`、`docs/screenshots/`。

---

## 2. 根因剖析与修复实现

### 一、限流预算调度器（Rate Scheduler）纠偏

#### 审查发现
1. 前序实现依赖 `watchConsole` 监听 `POST` 请求被动记账，该监听发生在网络请求已发出后，无法在请求发出前先拦截并等待配额；
2. 被动记录设置的 1500ms 防重复窗口跳过了该窗口内所有不同的真实请求；
3. `lobby.spec.ts` 自身包含多达 11 处直接开房/加入操作，远超原先预留的 5 个缓冲名额；
4. 状态文件名仅按 `E2E_PORT` 拼接，在外部指定 `E2E_BASE_URL` 时无法按服务 origin 正确隔离；
5. 原过期索引计算 `records.length - (CAPACITY - cost)` 存在多等一条历史记录的偏差，且缺乏 `while` 循环确保多 worker 或并发条件下的配额满足；
6. 文件写入吞并异常却声称跨进程绝对保证。

#### 修复方案
1. **解除与 `watchConsole` 的耦合**：
   - 彻底移除 `watchConsole` 内部的 `page.on('request')` 钩子，`watchConsole` 仅专注控制台错误与页面异常收集；
   - 移除不准确的 `recordObservedRateUsage`。
2. **显式前置预约（`paceForRateLimit`）**：
   - 在所有发起真实创建/加入请求的操作前，显式调用 `await paceForRateLimit()`；
   - 覆盖范围：
     - `tests/e2e/helpers.ts` 中的 `createRoom` 与 `joinByInvite`；
     - `tests/e2e/configuration.spec.ts` 中第 285 行的 `createButton.click()`；
     - `tests/e2e/lobby.spec.ts` 中的全部 11 处直接提交入口（44, 69, 148, 190, 199, 259, 390, 415, 474, 623, 668 行）；
   - **严格区分弹窗入口与真实提交**：仅在“创建房间”、“加入房间”、“确认入座”等真实发送 POST 请求的动作前预约，打开弹层的点击（如卡片“加入”、旁观“我要入座”）绝不消耗配额。
3. **安全容量与精准过期循环**：
   - 服务端真实限流为 30 次/分钟，客户端预算容量设为 29（预留 1 个安全名额单次防守）；
   - 超出容量时，需滑出窗口的记录数量为 `excess = records.length + cost - CAPACITY`，目标最早记录索引精准修正为 `excess - 1`；
   - 采用 `while (true)` 循环检测与等待，直到实际配额满足后原子记录时间戳并退出，无盲目粗暴 sleep。
4. **Origin 隔离与文件安全**：
   - 若提供 `E2E_BASE_URL`，以解析出的 `origin` 字符串安全转义后作为文件名标识，避免非默认端口场景冲突；
   - 写入临时文件并通过原子重命名覆盖，降低多进程并发写入损坏几率。

---

### 二、骰子动画回归测试（`dice.spec.ts` 最后一项用例）确定性纠偏

#### 审查发现
1. `routeWebSocket` 在页面已经连接 WebSocket 之后才安装，Playwright 无法拦截已建立的长连接；
2. 快速投掷场景仅设置静态整秒 `Date` 头，未对齐本地触发时间与整秒边界，无法复现真实的 HTTP Date 截断校时场景；
3. 延迟到达断言使用了 `.not.toEqual(expect.arrayContaining([1, 2, 3, 4, 5]))`，这只代表“未同时包含全部 1..5”，存在放行部分回放（如 `[1, 2, 6]`）的漏洞；
4. WebSocket 延迟使用了悬挂的 `setTimeout`，测试结束或页面关闭后存在 dangling timer。

#### 修复方案
1. **导航前安装双上下文 WebSocket 路由**：
   - 在 `hostContext.newPage()` 与 `guestContext.newPage()` 之前，分别在 `hostContext` 与 `guestContext` 上预先安装 `routeWebSocket(/.*/, ...)`；
   - 拦截由受控的 per-page 延迟标志（`hostDelayedRoll` / `guestDelayedRoll`）控制，仅在目标投掷激活时生效。
2. **整秒边界 ~25ms 快速投掷（场景 1）**：
   - 投掷前在浏览器端计算 `1000 - (Date.now() % 1000) + 25` 延迟触发点击，真实暴露整秒 HTTP Date 截断；
   - 保持原始 0..6 完整阶段与运动阶段断言不变。
3. **真实网络延迟 (>750ms) 确定性校验（场景 2）**：
   - 延迟常量设为 `DELAY_MS = 1350ms`（>=1300ms 且处于默认 1750ms 停留窗口内）；
   - 在 HTTP 路由与 WebSocket 路由中使用 `await new Promise((resolve) => setTimeout(resolve, DELAY_MS))`，杜绝 dangling timer；
   - 即使存在 -500ms 的 HTTP Date 校时误差，`serverEstimate` 仍保证 `>= 800ms > 750ms`；
   - 读取权威投掷记录时间戳 `rollRecordAt` 与 `Date` 头时间戳，验证其误差在整秒截断窗口内；
   - 断言实际等待时间 `pendingElapsed >= 1350ms`；
   - 严格断言：碗内最终点数与权威记录完全一致，且 `delayedProbe.settledCounts` 中**彻底不包含任何 1、2、3、4、5 中间停稳阶段**（对 1..5 逐一 `not.toContain`）。

---

## 3. 验证证据与结果

执行全项目 TypeScript 静态类型检查：

```bash
$ npm run typecheck
> bobing@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
```
**结果：退出码 0，零类型错误。**

---

## 4. 变更文件清单

| 文件 | 变更性质 | 变更说明 |
| --- | --- | --- |
| `tests/e2e/helpers.ts` | 修改 | 移除 `watchConsole` 被动限流监听；支持 `E2E_BASE_URL` origin 隔离；容量调整为 29；修复过期索引与采用 while 循环；临时文件原子写入 |
| `tests/e2e/lobby.spec.ts` | 修改 | 在 11 处真实创建/加入/入座按钮点击前显式调用 `await paceForRateLimit()`；弹层打开按钮不消耗配额 |
| `tests/e2e/configuration.spec.ts` | 修改 | 在 `createButton.click()` 真实提交前调用 `await paceForRateLimit()` |
| `tests/e2e/dice.spec.ts` | 修改 | 重构最后一项用例：提前挂载 WebSocket 路由、整秒边界 ~25ms 投掷、1350ms 双通道延迟、严格排除 1..5 任何中间态与清理 dangling timer |
| `docs/ui-e2e-followup-2026-09-27.md` | 更新 | 补充本次纠偏的根因分析、技术实现与验证记录 |
