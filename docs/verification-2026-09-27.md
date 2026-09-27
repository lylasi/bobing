# 本轮实现与验证进度

日期：2026-09-27。分支：`feat/room-experience-lobby`。

**本地实现与验收完成。** 270 项单元与集成测试通过；完整 Playwright **36 项通过（约 4.2 分钟）**。最后的慢网络动画修复后，重跑受影响的骰子与手机对局 **6 项通过（约 1.9 分钟）**，两个原失败独立脚本均通过。最终类型检查、生产构建和 `git diff --check` 通过。未提交、推送或部署。

## 已核实的结果

| 检查 | 实际结果 |
| --- | --- |
| 主代理执行 `npm test` | 9 个测试文件、270 个用例全部通过 |
| DeepSeek 执行 `npm run build:server` | 通过 |
| 主代理执行生产构建（Playwright 启动器调用 `npm run build`） | 前后端构建通过 |
| 主代理执行 `git diff --check` | 通过 |
| 主代理完整 `npm run test:e2e` | 36 项全部通过，约 4.2 分钟；包含新增动画、个人结果、大厅与旁观回归 |
| 最后动画修订的定向回归 | `npx playwright test tests/e2e/dice.spec.ts tests/e2e/mobile.spec.ts`：6 项通过，约 1.9 分钟；HTTP 先到与 WS 先到均覆盖 |
| 主代理独立 HTTP／Socket 集成脚本 | 8 个场景组通过：默认公开与 1 秒、数字码前导零、观众权限与去重、展示阶段与幂等、个人结果与状元顶替、成员离线暂停、旁观撤销、最终结算／重启／迁移 |
| 主代理独立旁观人数／到期通知回归 | 修复后通过：新连接成员立即收到当前观众数；房间到期先发 `ROOM_EXPIRED` 再断开 |
| 主代理执行 `npm run typecheck` | 通过；此前 4 个错误已由 Pi 修复 |
| 主代理 Chromium 设置页检查 | 320px 整页没有横向溢出；`-0` 保存旧值问题已修复并复查为拒绝提交；手机奖品两行布局已在配置 E2E 通过 |
| 房间设置 Playwright 测试 | 1 项通过：更改公开范围／停留不重置准备，关闭旁观立即通知观众 |
| 主代理独立三浏览器流程 | 4 组通过：数字码公开房在大厅可加入、仅填昵称；观众实时真实点数与只读限制；结算／再开局／观众入座并退出观众计数；原成员访问 watch 路径恢复成员 |

完整后端改动、覆盖范围和命令见 [后端交付记录](backend-handoff-2026-09-27.md)。测试使用临时数据库与本地服务，不访问生产房间。未提交、推送或部署。

## 本轮集成检查与修复跟踪

- 独立 12 人浏览器检查 **7 组通过**：个人奖品结果在别人投掷后保留、320/375/768/1440 无横向溢出、唯一掷骰按钮、最近 10 条与只看我/Esc 焦点恢复、刷新不重播、大厅可见性、修改节奏并撤销旁观。
- 大厅 6 项 E2E 在首轮全套中通过：真实三浏览器、房间设置、失败保留列表、跨房间旧响应隔离、加载更多跨 5 秒轮询、失效成员凭证降级为旁观；网络错误仍保留凭证。
- 配置 E2E 通过：六档奖品手机布局为奖级与数量同行、内容独占下一行；非法草稿不静默回退。
- **手机首屏修复后通过**：375×812 普通双人局个人结果底边 667.344px、底栏顶边 701px，间隔约 33.7px；此前个人结果底边约 789px、底栏顶边 711px。移动 E2E 及独立几何断言均通过。
- **长文本与样式复查通过**：奖品详情完整换行、状元状态独占一行、桌面个人结果置于玩家列表前、手机导航单行。既有组件样式一度被覆盖，已由 Pi 从先前构建恢复并完成修订，主代理重新构建、截图验证。
- 首轮 dice 失败是展示阶段双方按钮禁用时测试误选投手；experience 失败是测试使用不存在的类名及旧弹窗名称。Pi 已适配，完整套件复测通过。
- 两项 multiplayer 失败的 Trace 证实 POST `/api/rooms` 返回 429 `RATE_LIMITED`：测试短时间创建/加入超过生产 30 次/分钟配额。测试侧按每次真实提交加入请求预算，生产限制不变，完整套件复测通过。
- 独立真实浏览器在整秒后 29ms 快速投掷，动画停稳阶段为 `[0,3,4,5,6]`，复现漏过阶段 1/2。Pi 引入本地单调时钟约束后，原独立脚本实测 `[0,1,2,3,4,5,6]`；完整套件的快速与迟到动画回归通过。
- **HTTP 先返回的迟到边界修复后通过**：HTTP 延迟 1350ms、WS 延迟 2500ms 时，修复前整秒后 909ms 投掷得到 `[0,2,3,4,5,6]`。加入请求前时钟锚点与本地等待时长保护后，原脚本在整秒后 908ms 投掷得到 `[0,6]`，直接停稳；正常快速投掷仍为 `[0,1,2,3,4,5,6]`。

## 需求与证据对应

| 需求 | 主要验证位置 |
| --- | --- |
| E01–E02 个人结果与实际奖品 | `tests/game.test.ts`、`tests/e2e/experience.spec.ts`、独立 12 人流程 |
| E03–E04 停留节奏、最后结果、刷新不重播 | `tests/game.test.ts`、`tests/server.test.ts`、`tests/e2e/dice.spec.ts`、`tests/e2e/experience.spec.ts` |
| E05–E07 状元事实、同分/锁定、窗口与持久化 | `tests/game.test.ts`、`tests/server.test.ts`、`tests/db.test.ts`、独立 HTTP/Socket 流程 |
| E08–E10 手机人数/轮次/结果、记录抽屉、紧凑邀请 | `tests/e2e/mobile.spec.ts`、`tests/e2e/experience.spec.ts`、320/375/768/1440 截图 |
| E11 奖品编辑、个人方案和草稿 | `tests/e2e/configuration.spec.ts`、`tests/templates.test.ts`、`tests/room-config.test.ts` |
| L01–L03 数字码、旧码、默认公开、大厅加入 | `tests/server.test.ts`、`tests/db.test.ts`、`tests/e2e/configuration.spec.ts`、`tests/e2e/lobby.spec.ts` |
| L04–L06 真实旁观、离线暂停、入座和撤销 | `tests/server.test.ts`、`tests/e2e/lobby.spec.ts`、独立三浏览器/Socket 流程 |
| L07 失败恢复、慢请求、跨房间隔离和身份恢复 | `tests/e2e/lobby.spec.ts`（首轮全套中的 6 项通过） |

## 独立复核材料

主代理的临时脚本使用独立服务与 SQLite 测试库：

- `/private/tmp/bobing-review-20260927.mjs`：8 组主要 HTTP/Socket 流程通过。
- `/private/tmp/bobing-audience-review-20260927.mjs`：初始人数与到期通知通过。
- `/private/tmp/bobing-settings-review-20260927.mjs`：非法停留草稿与设置布局检查。
- `/private/tmp/bobing-lobby-browser-review-20260927.mjs`：4 组三浏览器流程通过。
- `/private/tmp/bobing-browser-review-20260927.mjs`：修订样式后重跑 7 组均通过，已重拍最终样式。
- `/private/tmp/bobing-mobile-budget-20260927.mjs`：普通双人局首屏几何，修复后通过。
- `/private/tmp/bobing-animation-clock-review-20260927.mjs`：真实整秒边界快速投掷，修复后完整阶段通过。
- `/private/tmp/bobing-animation-late-http-review-20260927.mjs`：HTTP 先返回的迟到补播修复后通过。

业务细节见[后端交付记录](backend-handoff-2026-09-27.md)，前端见[大厅接入](ui-lobby-handoff-2026-09-27.md)、[局内行为](ui-game-behavior-handoff-2026-09-27.md)、[视觉样式](ui-game-style-handoff-2026-09-27.md)。阶段交付说明不能代替最终集成验收，最新实测以本文为准。

旧房间保持仅邀请并默认关闭旁观；旧状元历史不足时提示“旧局部分历程未记录”，不补造登顶事实。共用手机多人模式本轮未实现。完整验收范围以[已确认设计稿](superpowers/specs/2026-09-27-bobing-experience-and-lobby.md)及[实现契约](superpowers/specs/2026-09-27-bobing-implementation-contract.md)为准。

## 最终界面证据

已人工查看手机普通局、最近记录抽屉、长奖品详情与 12 人桌面布局；多宽度脚本确认没有页面横向溢出。浏览器为 Chromium，未进行 iOS Safari 真机验证。

- [375px 普通双人局](screenshots/60-experience-standard-375.png)
- [320px 12 人局](screenshots/61-experience-12players-320.png)、[375px](screenshots/62-experience-12players-375.png)、[768px](screenshots/63-experience-12players-768.png)、[1440px](screenshots/64-experience-12players-1440.png)
- [最近 10 次抽屉](screenshots/65-experience-recent10-375.png)、[完整个人奖品](screenshots/66-experience-my-prizes-375.png)
- [手机房间设置](screenshots/67-experience-room-settings-375.png)、[手机大厅](screenshots/68-experience-lobby-375.png)
