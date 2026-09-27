# 实测记录（P6 / P7 / P8 测试准备 / P9 部署）

本文按开发批次保留历史实测记录。2026-09-26 可配置房规、奖品、音效与动画的最新进度及验证结果见 [可配置玩法集成验收](configurable-play-verification.md)。下文第 9 节的 119 条单元／集成与 22 条 E2E，以及 [此前独立验收](primary-final-verification.md)，均为本次功能开发前的历史基线。尚未验证的公网、真机等范围在各批次末尾单列。
环境：macOS（darwin 25.x，Apple Silicon）、Node v24.20.0、npm 11、Docker 29.4.0（OrbStack）、Playwright 1.62.0 自带 Chromium 1234。

---

## 1. 类型检查与构建

```text
$ npx tsc -p tsconfig.json --noEmit
（无输出，退出码 0）

$ npm run build
> vite build
dist/index.html                   1.08 kB │ gzip:   0.78 kB
dist/assets/index-nTuW3UOG.css   28.26 kB │ gzip:   6.04 kB
dist/assets/index-Cy3uynRC.js   346.16 kB │ gzip: 110.01 kB
✓ built in 119ms
> tsc -p tsconfig.server.json
（无输出，退出码 0）
```

`npm run typecheck` 与 `npm run build` 均一次通过；前端产物中没有外链图片或字体请求（见第 4 节视觉自检）。

## 2. 单元与集成测试（Vitest）

```text
$ npm test
 ✓ tests/rules.test.ts (42 tests) 2489ms
   ✓ evaluateDice 穷举 46656 种组合
 ✓ tests/server.test.ts (44 tests) 569ms
 ✓ tests/game.test.ts (25 tests) 7ms
 ✓ tests/config.test.ts (6 tests) 37ms

 Test Files  4 passed (4)
      Tests  117 passed (117)
```

- 既有 111 条核心用例**全部保持通过**（规则 42 + 对局 25 + 服务端 44）。
- 新增 6 条 `tests/config.test.ts`：`normalizePublicBaseUrl` 的接受/拒绝规则，以及 `GET /api/config` 的真实响应（含未配置时返回 `null`、非法值被忽略）。
- `vitest.config.ts` 增加 `exclude: ['tests/e2e/**']`，确保 Playwright 用例不会被 Vitest 收走。

## 3. 端到端测试（Playwright，真实浏览器 + 生产构建产物）

```text
$ npm run test:e2e
Running 14 tests using 1 worker
 ✓ layout.spec.ts   首页、规则页、落地页与房间页在三档宽度下都不溢出 (3.6s)
 ✓ layout.spec.ts   深链刷新 /room/:code 与 /rules 不返回 404 (217ms)
 ✓ mobile.spec.ts   创建、加入、对局、Tab 切换与结算都不横向溢出 (2.5s)
 ✓ multiplayer.spec.ts  创建、邀请、准备、开始、轮转、刷新、结算与再开一局 (3.0s)
 ✓ multiplayer.spec.ts  第三位玩家无法加入已满的房间 (1.1s)
 ✓ multiplayer.spec.ts  已开局的邀请落地页不提供加入入口 (1.3s)
 ✓ multiplayer.spec.ts  不存在的房间码给出明确提示 (224ms)
 ✓ multiplayer.spec.ts  房主提前结束需要二次确认，成员端同步看到结算 (1.1s)
 ✓ resilience.spec.ts   掉线期间不能掷骰，恢复网络后自动重连并追平房间状态 (47.7s)
 ✓ visual.spec.ts   骰子是按点数真实渲染的 3×3 点阵，一/四点为朱砂红 (186ms)
 ✓ visual.spec.ts   首页主视觉是瓷碗加六颗骰子，碗体不使用外链图片 (164ms)
 ✓ visual.spec.ts   主按钮使用朱砂红并满足 52px 高与 26px 圆角 (179ms)
 ✓ visual.spec.ts   房间页留存桌面与手机截图 (479ms)
 ✓ visual.spec.ts   1440 对局区为 280/560/312 三栏，中心瓷碗 400px (866ms)

 14 passed (1.1m)
```

覆盖面与断言要点：

| 用例 | 断言的核心事实 |
| --- | --- |
| 两人真实对局 | 两个**独立浏览器上下文**（不同 localStorage）完成：创建 → 分享链接加入 → 准备 → 开始 → 第一掷两端记录数与骰子点数一致 → 刷新页面后仍是同一玩家且奖池快照不变 → 打完 5 轮 ×2 人 = 10 条记录 → 两端奖池快照完全相等 → 房主「再开一局」后两端回到等待区且记录清零 |
| 分享链接 | `http://localhost:3210/room/<6位房码>`（来自 `PUBLIC_BASE_URL`，与页面 origin `127.0.0.1` 不同，证明运行时配置真的生效），且不含 `token`、`playerId`、查询串 |
| 满房 / 已开局 / 不存在的房码 | 分别出现「这桌已经坐满啦」「本局已经开始，暂时不能加入」「没找到这个房间」且**没有**加入按钮；非法长度房码提示 6 位格式 |
| 房主提前结束 | 先「继续博饼」返回对局，再确认结束时两端都看到「房主提前结束」 |
| 断线重连 | 成员端 `context.setOffline(true)` 后出现「连接已断开，正在重连…」、掷骰按钮 `disabled`、本地记录不再增长、席位仍在；恢复网络后**不刷新页面**自动回到「连接正常」，并追平房主看到的记录条数，之后仍可继续掷骰 |
| 手机 375px | 完整对局可打完；底部主操作只有一个「掷出好运」（另一处被 CSS 隐藏）；玩家/奖池/记录三个 Tab 可切换且对应面板可见；结算表格自身横向滚动不撑宽页面 |
| 响应式 | 375 / 768 / 1440 三档下首页、规则页、邀请落地页、房间等待区均无横向溢出（逐元素比对 `scrollWidth`/`clientWidth` 与视口） |
| 视觉自检 | 骰子为真实 3×3 点阵（示例 [4,4,4,4,1,1] 渲染 4/4/4/4/1/1 个点，9 个格子）；一、四点为朱砂红 `rgb(200,62,49)`，二点为 `rgb(44,26,17)`；首页 6 颗骰子互不重叠、无任何外链资源；主按钮 `rgb(200,62,49)`、高 ≥52px、圆角 26px、字号 18px；标题字体命中 serif 字体族 |
| 布局规格 | `.game-columns` 三列实测 280 / 560 / 312、间距 24、容器内容宽 1200；中心瓷碗 400px；顶部导航 ≥80px |

截图（`fullPage`，由用例直接写入，供人工复核）位于 `docs/screenshots/`：

```text
20-home-375/768/1440.png        21-rules-375/768/1440.png
22-invite-375/768/1440.png      23-room-waiting-375/768/1440.png
01-waiting-desktop-1440.png     02-playing-desktop-1440.png     03-results-desktop-1440.png
10-home-375.png  11-waiting-375.png  12-playing-375.png  13-results-375.png
30-share-dialog-1440.png        31-rules-dialog-1440.png
```

E2E 不使用任何测试专用接口或作弊入口，也不修改轮数等规则；创建的房间数为 6 个（限流为每 IP 每分钟 30 次，未触发）。

## 4. 开发与生产启动方式

### 4.1 `npm run dev`（一条命令起前后端）

```text
$ npm run dev
[dev] 前端 http://localhost:5173 ，后端 http://localhost:3001 （/api 与 /socket.io 由 Vite 代理）
[web] VITE v8.3.1  ready in 96 ms
[api] [bobing] 服务已启动 http://localhost:3001（数据目录 .../data）

vite 首页             = 200 :: <!doctype html> <html lang="zh-CN">
vite 深链 /room/AB    = 200 :: <!doctype html> <html lang="zh-CN">
vite 代理 /api/health = 200 :: {"ok":true}
vite 代理 /api/config = 200 :: {"publicBaseUrl":null}
vite 代理 socket.io   = 200 :: 0{"sid":"uxgclm6KBgXat5LmAAAA","upgrades":["websocket"],"pingInterval":25000,...}
关闭后 vite 首页      = ERR fetch failed        ← 两个子进程都被正确回收，端口释放
```

### 4.2 `npm start`（生产产物 + 深链刷新）

```text
===== 生产模式（PUBLIC_BASE_URL=https://bobing.example.com/）=====
  健康检查:      200 {"ok":true}
  运行时配置:    200 {"publicBaseUrl":"https://bobing.example.com"}
  首页:          200 <!doctype html> ...
  深链房间页:    200 <!doctype html> ...        ← /room/ABCDEF 刷新不 404
  深链规则页:    200 <!doctype html> ...        ← /rules 刷新不 404
  未知 api 路径: 404 {"error":{"code":"ROOM_NOT_FOUND","message":"接口不存在"}}
  日志: 服务已启动 http://localhost:3311（数据目录 .../data-verify） | 分享地址：https://bobing.example.com

===== 生产模式（PUBLIC_BASE_URL=ftp://evil.example.com/?x=1）=====
  运行时配置:    200 {"publicBaseUrl":null}
  日志: PUBLIC_BASE_URL 不是合法的 http(s) 地址（不得含用户名、密码、查询串或片段），已忽略，分享链接将使用访问者当前地址。

===== 生产模式（未配置）=====
  运行时配置:    200 {"publicBaseUrl":null}

真实静态资源:   200 text/javascript; charset=utf-8
缺失的静态资源: 404 text/plain; charset=utf-8 Not Found   ← /assets/index-stale.js 不再回退成 HTML
深链房间页:     200 text/html; charset=utf-8
```

## 5. Docker 与 Compose

```text
$ docker compose config          # 配置解析通过（端口绑定 0.0.0.0:${PORT}、bind mount ./data:/app/data、健康检查、PUBLIC_BASE_URL/TRUST_PROXY 透传）

$ docker build -t bobing:0.1.0 .
#18 exporting to image
#18 naming to docker.io/library/bobing:0.1.0 done
#18 DONE 0.2s                    ← 两阶段构建成功，运行阶段不安装 devDependencies

$ docker run -d --name bobing-verify -p 127.0.0.1:3401:3001 \
    -e PUBLIC_BASE_URL=https://bobing.example.com -e TRUST_PROXY=1 bobing:0.1.0
$ docker ps --filter name=bobing-verify --format '{{.Status}}'
Up 6 seconds (healthy)           ← 镜像内 HEALTHCHECK 通过
$ docker logs bobing-verify
[bobing] 服务已启动 http://localhost:3001（数据目录 /app/data）
[bobing] 分享地址：https://bobing.example.com
$ curl 127.0.0.1:3401/api/health    → 200 {"ok":true}
$ curl 127.0.0.1:3401/api/config    → 200 {"publicBaseUrl":"https://bobing.example.com"}
$ curl 127.0.0.1:3401/room/ABCDEF   → 200（深链刷新）
$ docker exec bobing-verify sh -c 'id -un; ls /app/data'
node                             ← 以非 root 用户运行
bobing.sqlite  bobing.sqlite-shm  bobing.sqlite-wal
```

容器内跑完整套 E2E（证明容器形态下 HTTP、WebSocket 升级、分享地址、深链全部可用）：

```text
$ docker run -d --name bobing-verify -p 127.0.0.1:3401:3001 \
    -e PUBLIC_BASE_URL=http://127.0.0.1:3401 -e TRUST_PROXY=1 bobing:0.1.0
$ E2E_BASE_URL=http://127.0.0.1:3401 E2E_EXPECT_PUBLIC_BASE_URL=http://127.0.0.1:3401 npx playwright test
 14 passed (13.6s)               ← 不重新构建、直接对容器里的部署跑真实浏览器流程
```

### 5.1 备份演练（真实执行）

```text
$ docker exec bobing-verify ls -la /app/data
-rw-r--r-- 1 node node     4096  bobing.sqlite
-rw-r--r-- 1 node node   32768  bobing.sqlite-shm
-rw-r--r-- 1 node node 1194832  bobing.sqlite-wal     ← 主库 4KiB，数据都在 WAL 里

$ docker exec bobing-verify node -e 'const { DatabaseSync, backup } = require("node:sqlite"); ...'
备份文件: /app/data/backup-1790347732562.sqlite
表: completed_games, expired_rooms, receipts, rooms
房间数: 8                        ← 备份快照可独立打开且数据完整
```

这一步同时修正了一处文档错误：`node:sqlite` 的备份是**模块级函数** `backup(sourceDb, path)`，不存在 `db.backup()` 方法；`docs/deployment.md` 已按实测写法修正。

## 6. 本轮修复的真实缺陷

| # | 现象 | 原因 | 修复 |
| --- | --- | --- | --- |
| 1 | 首页与对局区的瓷碗完全不可见（宽高塌缩为 0） | `.bowl-wrap` 是 `align-items:center` 的 flex 列子项，其宽度由内容决定，而 `.bowl` 用 `width:100%` 反向依赖父级，形成循环依赖 | `.bowl-wrap` 自身给出确定宽度与 `max-width`（hero 420 / game 400 / compact 240），窄屏 260 |
| 2 | 分享链接/二维码永远是访问者当前地址，`PUBLIC_BASE_URL` 不生效 | 分享链接在首帧用 `useMemo` 算好，运行时配置异步返回后不会重算 | 新增 `src/hooks/useShareBaseUrl.ts`，把基地址做成状态；`PlayerId`/token 依旧只存在 localStorage |
| 3 | 对局区三列为 280/452/312，而不是设计要求的 280/560/312 | `MemberView` 在外层 `<main class="container">` 内部又套了一层 `.container`，多出 48px 内边距；同时 `.container` 的 `max-width` 未扣除自身 padding | 内层改为 `.room-view`；`.container` 改为 `max-width: 1248px`（内容区正好 1200） |
| 4 | 规则页出现 `rankKey` 字样（需求明确要求不展示） | 文案里直接写了字段名 | `shared/rules.ts` 文案改为「按牌型强弱竞争」，展示层不再出现内部字段名 |
| 5 | 缺失的构建产物返回 `index.html`（200 text/html） | SPA 回退把带扩展名的静态资源请求也接管了 | 回退逻辑跳过末段含 `.` 的路径，返回 404，避免把 HTML 当 JS 执行 |

上述 1–5 都由新增用例守住（视觉自检、分享链接断言、三栏尺寸断言、规则页 `rankKey` 断言、静态资源 404 断言）。

## 7. 未验证项（诚实声明）

- **未在真实公网域名 + 真实证书下访问**：nginx/Caddy 配置示例未在本机实际跑通（本机没有域名与证书）。已验证的是「应用在代理后能正常工作所需的行为」：`/api/config` 下发外部地址、深链回退、Socket.IO 升级在直连与容器两种形态下都成功。
- **未做真机移动端测试**：375px 与 768px 为 Chromium 模拟视口（含 `isMobile`/`hasTouch`），未在 iOS Safari / Android Chrome 真机验证；因此真机上的安全区（`env(safe-area-inset-bottom)`）与软键盘行为未实测。
- **未做多副本/压测**：本版本设计为单实例，未验证高并发房间数与长时间稳定性。
- **断线检测耗时**：实测约 40–50 秒（Socket.IO 心跳超时），属于协议行为，未做加速；断线期间如轮到掉线者，服务端会正常记为「超时跳过」（`tests/game.test.ts` 已覆盖该逻辑，E2E 中也能观察到记录增长）。
- **异常退出后的计时限制**：若未写入暂停状态且停机时间耗尽已保存的截止时间，恢复后的当前机会可能超时。正常关闭与真正进程重启后恢复已经由主代理实测，详见`docs/core-verification.md`；不能把此限制概括为每次重启都会归零。
- `docs/screenshots/*.png` 由 Playwright 生成，本轮的自动化结论来自第 3 节的几何/样式断言；**截图的观感验收建议由人工再复核一遍**（本轮执行环境中图像查看工具不可用）。

---

# 8. 最后一轮前端修复与回归（2026-09-26，DeepSeek）

针对 `docs/frontend-review.md` 与主代理实测复现的两个严重缺陷。**保留现有玩法与真实 Node + SQLite + Socket.IO 架构，只改前端错误分类、离房语义、骰子动画与文案**。本节的所有数字都来自本节记录的真实命令，覆盖第 3 节的旧计数。

## 8.1 命令结果

```text
$ npm run typecheck        # tsc -p tsconfig.json --noEmit
（无输出，退出码 0）

$ npm test                 # vitest run
 Test Files  4 passed (4)
      Tests  117 passed (117)          ← rules 42 / game 25 / server 44 / config 6，未改动

$ npm run build
dist/assets/index-L2IMMqNV.css   28.54 kB │ gzip:   6.09 kB
dist/assets/index-BoPGtHVx.js   349.07 kB │ gzip: 110.79 kB
✓ built in 78ms
> tsc -p tsconfig.server.json       （无输出，退出码 0）

$ npm run test:e2e         # Playwright 1.62，真实生产构建 + 独立端口 3210 + 独立临时库 .e2e-data
Running 22 tests using 1 worker
  ✓ dice.spec.ts     A 投完 B 立刻投，刷新第二投手页面后两端碗里都是最新权威点数；再开一局清空 (3.6s)
  ✓ dice.spec.ts     掷骰失败停止旋转回到权威点数；本地倒计时到 0 时禁用掷骰并提示同步 (3.1s)
  ✓ dice.spec.ts     超时只显示最新超时文案，不显示旧中奖，碗里保留上一手权威点数 (33.4s)
  ✓ identity.spec.ts state 请求失败：网络与 500 保留身份并可重试，只有 INVALID_TOKEN 才清身份 (532ms)
  ✓ identity.spec.ts 离开失败不能假装已离开：保留身份留在房间，恢复重试后才真正离开 (893ms)
  ✓ identity.spec.ts 运行时配置延迟返回时，邀请链接仍会更新为 PUBLIC_BASE_URL (4.6s)
  ✓ layout/mobile/multiplayer/resilience/visual 共 16 条既有用例全部保持通过
  22 passed (1.8m)
```

## 8.2 修复内容与复现证据

| # | 缺陷 | 修复 | 回归用例 | 旧实现下的真实失败证据 |
| --- | --- | --- | --- | --- |
| 1 | state 初次加载 network/timeout/500 被当成终态 → `onInvalid` → 清 localStorage → 回入房表单（房主永久丢失） | `useRoom` 区分**终态**（`INVALID_TOKEN`/`ROOM_NOT_FOUND`/`ROOM_EXPIRED`/`INVALID_INPUT`）与**可恢复**错误；可恢复错误写入新的 `loadError` 状态，页面显示「暂时无法进入房间 + 重试」，凭证与 playerId 原样保留；`MemberView` 只在 `fatal.code === 'INVALID_TOKEN'` 时调用 `onInvalid` | `identity.spec.ts` 第 1 条（网络中断→重试→500→重试→INVALID_TOKEN） | 把旧逻辑（所有人 `setFatal`）临时回填后，用例在「暂时无法进入房间」处失败：`element(s) not found`，页面回到加入表单 |
| 2 | `handleLeave` 忽略 `runAction` 的布尔结果：失败也清身份跳首页 | `runAction` 改为返回 `{ok, room, error}`；只有服务端接受请求**且**快照里自己已 `left`（或房间 `closed`）才清身份并导航；`INVALID_TOKEN/ROOM_NOT_FOUND/ROOM_EXPIRED` 视为身份已撤销；网络失败保留身份、留在房间，确认弹层内显示可重试的失败说明 | `identity.spec.ts` 第 2 条 | 回填旧 `handleLeave` 后用例失败：弹层消失、凭证被清、被导航回首页 |
| 3 | `useDiceAnimation` 用 `myLatest`/`latest` 两个 effect 共用 `revealedId`，依赖记录对象；presence/reconnect 快照会清掉未结束的 900ms 计时器，随后又回放自己的旧记录 | 重写为**单一最新权威事件**驱动：键为 `gameNumber + 最新记录 id`（全部原始值，依赖里不再出现对象/数组）；同键不重播也不动计时器；自己的记录才旋转 900ms；别人/刷新直接显示服务端点数；`gameNumber` 变化清空；超时只更新文案并保留上一手权威点数；投掷失败（无新记录）退出旋转并回到权威点数 | `dice.spec.ts` 第 1、2、3 条（含 presence/reload、失败 roll、rematch、timeout） | 回填旧 hook 后在主代理同款时序下失败：刷新后的投手页面碗里是 `[0,0,0,0,0,0]`，权威点数是 `[2,6,6,3,2,3]`；超时场景里结果区仍显示旧中奖「阿月博得三红 · 获得1份」 |
| 4 | 倒计时为 0 仍可点掷骰、旋转期间可重复点击 | `GameBoard.canRoll` 增加 `!spinning` 与 `remaining > 0`；提示改为「本轮已到时，正在同步…」「骰子还在碗里转，停稳之前不能重复投掷。」 | `dice.spec.ts` 第 1 条（防重入断言 `aria-busy`/disabled）、第 2 条（改写本页快照 deadline 后禁用+提示） | —（新增行为，服务端仍最终裁决） |
| 5 | 分享/结算里的实现说明（“链接不含任何个人凭证”“本局已归档保存”）；离开说明笼统承诺可回来 | 二维码提示改为「用手机相机扫一下就能进房间」；结算脚注改为「再开一局会保留房码与身份，奖品与本局记录重新开始。」；离开确认明确「本局已经开始的话，这一局不能再重新加入，只能等下一局」 | `identity.spec.ts` 第 2 条断言离开弹层文案 | — |
| 6 | 首页装饰碗、375 标题 | 首页主视觉本就是固定的 `[6,4,1,3,4,5]` 点阵（非空白面）；标题改为两个 `nowrap` 段 + `aria-label`，1100px 以下各占一行、以上并排 | `visual.spec.ts` 新增 2 条（420px 瓷碗 + 六颗有点阵骰子 + 截图颜色数 > 30；375 两段各占一行且段高≈单行） | — |
| 7 | 运行时配置晚返回时邀请链接停留在访问者 origin | 既有 `useShareBaseUrl` 已修，本轮不回退，并补延迟回归：`/api/config` 延迟 4 秒返回，先看到当前 origin，配置到达后**无需重开弹层**自动变为 `PUBLIC_BASE_URL` | `identity.spec.ts` 第 3 条 | — |

## 8.3 本轮新增/更新的测试

```text
tests/e2e/helpers.ts        + latestRecordDice / bowlPips / EMPTY_BOWL_PIPS / readMembership / paintedColors
tests/e2e/identity.spec.ts  新增 3 条（身份与离房，全部通过真实浏览器 + 网络层拦截）
tests/e2e/dice.spec.ts      新增 3 条（骰子权威性，断言碗里真实点阵而不是记录文字）
tests/e2e/visual.spec.ts    新增 2 条（主视觉真的绘制 / 375 标题分行）
```

骰子断言方式：直接数 `.bowl .dice .dice-pip--on`，与最新记录里的权威点数（`六颗骰子：6、2、6、1、4、3` 这类标签解析）逐颗比对，避免“记录对了但碗里是空白/旧点数”这类假通过。

用例数量受**服务端真实限流**（每 IP 每分钟 30 次创建/加入）约束，因此同一房间内串行覆盖多个场景，未使用任何测试专用接口或限流放宽。

## 8.4 视觉复核（无图像查看工具时的替代证据）

本机没有可用的图像查看能力（`read_image` 在本环境不可用），因此除保留 `docs/screenshots/*.png`（本轮已重新生成，`20-home-375/768/1440`、`01/02/03-*`、`10–13-*` 时间戳为本轮）外，改用可编程断言：

```text
375  viewport 260×260     骰面 [6,4,1,3,4,5]  截图颜色 172 种  标题两段 top=132 / 177，各高 45px  横向溢出 0
768  bowl     420×420     骰面 [6,4,1,3,4,5]  截图颜色 171 种  标题两段 top=148 / 193                横向溢出 0
1440 bowl     420×420     骰面 [6,4,1,3,4,5]  截图颜色 173 种  标题两段 top=172 / 172（并排）        横向溢出 0
```

截图文件本身：`20-home-1440.png` 1440×1427、`20-home-375.png` 375×2423、`02-playing-desktop-1440.png` 1440×1236、`12-playing-375.png` 375×812、`03-results-desktop-1440.png` 1440×1610、`13-results-375.png` 375×1769，均非空图。**观感（配色、留白、排版美观）仍需人工复核**，本节只保证几何、颜色层次与真实性。

## 8.5 本轮的限制与需知悉的操作

- **图像肉眼复核未做**：见上，主代理可直接查看 `docs/screenshots/*.png`。
- **未部署公网**：本轮只在本机独立端口跑真实构建产物（Playwright 自带的 3210 + 临时库 `.e2e-data`），未上线。
- **临时服务器误杀已恢复**：本轮排查时按 `pgrep` 顺序误把主代理的 `127.0.0.1:3107`（`DATA_DIR=/tmp/bobing-preview-20260925`）预览进程当成自用进程终止；已立刻用相同端口与相同 `DATA_DIR` 重启（`node dist-server/server/index.js`，日志 `/tmp/bobing-preview-3107.log`），`/api/health` 与首页均 200。数据库文件未被修改；按产品规则，重启会把既有连接置为离线并暂停，若重启瞬间某回合 deadline 已过，该回合剩余时间归零（`docs/deployment.md` 已记录该限制）。自用的 3321 临时服务已停止。
- **e2e 用例规模与限流**：新增用例后单次全量 `npm run test:e2e` 的创建/加入次数接近每 IP 每分钟 30 次上限，因此合并了同场景用例；若继续增加用例，需要拆分运行或引入独立 IP/端口。
- **未做真机与公网、多副本验证**：与第 7 节一致，仍然成立。

---

# 9. 移动界面收口批次（2026-09-26，DeepSeek）

对应 `docs/final-review-addendum.md` 的 M01 / M02 / M03 / C01（全部是原需求缺漏，未新增功能、未改设计语言、未动服务端规则与限流）。本节数字全部来自本轮真实执行的命令。

## 9.1 命令结果

```text
$ npm run typecheck                      # tsc -p tsconfig.json --noEmit
（无输出，退出码 0）

$ npm test                               # vitest run
 ✓ tests/rules.test.ts (42) ✓ tests/server.test.ts (44) ✓ tests/game.test.ts (25)
 ✓ tests/config.test.ts (6) ✓ tests/clock.test.ts (2)
 Test Files  5 passed (5)
      Tests  119 passed (119)            ← 原 117 条全部保留，新增 2 条校时/倒计时用例

$ npm run build
dist/assets/index-Dp67v7jI.css   29.28 kB │ gzip:   6.23 kB
dist/assets/index-CjSPx9Oj.js   349.16 kB │ gzip: 110.87 kB
✓ built in 94ms
> tsc -p tsconfig.server.json            （无输出，退出码 0）

$ npx playwright test                    # Playwright 1.62，真实生产构建 + 端口 3210 + 独立库 .e2e-data
Running 22 tests using 1 worker
  22 passed (1.8m)
```

E2E 用例数仍为 22（**没有新增用例**，M01/M02/M03/C01 的断言全部并入既有 `mobile.spec.ts` 的真实对局与 `dice.spec.ts` 的桌面记录检查），单次全量的创建/加入次数与上一轮相同，未触碰每 IP 每分钟 30 次的真实限流，也没有测试专用接口。

## 9.2 修复内容、回归断言与旧实现证据

| # | 缺陷 | 根因 | 修复（文件） | 旧实现下的实测证据 | 现在的可用断言 |
| --- | --- | --- | --- | --- | --- |
| M01 | 375/768 对局中心（骰碗+提示+最新结果）完全不可见 | `src/styles.css` 移动断点里 `.game-panel{display:none}` 把 `.game-panel--center` 一起隐藏，而中心区没有 `is-active`、也不属于任何 Tab | 只隐藏三个信息面板（`.game-panel--players/--pool/--history`）与 `.is-active` 组合；`.game-columns` 在 ≤899px 改为 `flex column; align-items:stretch`，中心 `order:1`、Tab `order:2`、面板 `order:3`；Tab 栏移入中心之后（`src/components/GameBoard.tsx`） | 把旧 CSS 运行时注回页面实测：`.col-center` / `.bowl` / `.dice` 矩形均为 `0×0`（不可见），中心区在三个 Tab 下都消失；`{"m01_centerVisible":false,"m01_bowlVisible":false,"m01_diceVisible":false}` | `mobile.spec.ts`：真实双上下文 375 对局实际掷骰后，`.game-center`、`.bowl`、6 颗 `.dice` 可见；碗里**实际点阵**（`.dice-pip--on` 计数）等于最新权威记录；切玩家/奖池/记录三个 Tab 后碗与最新结果仍可见且点数不变；几何断言 `center.top < tabs.top < players.top`；375/768 无横向溢出 |
| M02 | 375 房间栏「邀请亲友/提前结束/离开房间」被拆成两行 | ≤600px 时 `.room-header-actions .btn{flex:1}` 把四个按钮挤到 ~71px，4 个汉字放不下 | ≤600px 改为两列网格（`grid-template-columns:repeat(2,minmax(0,1fr))`），按钮 `width:100%`、`min-height:44px`、`white-space:nowrap`（`src/styles.css`） | 旧 CSS 下用 Range 客户矩形数实测四个按钮的行数 = `[2,1,2,2]`（邀请亲友/提前结束/离开房间各拆两行） | `mobile.spec.ts`：`.room-header-actions .btn` 共 4 个，文字行数 `[1,1,1,1]`，每个按钮高度 ≥44px，375 与 768 均无横向溢出 |
| M03 | 375 结算每条记录的六颗骰子压住中奖文案 | ≤899px 记录网格骰子列只有 60px，而 6×24px 骰子实占 ~164px，溢出到 `.record-result` 上 | ≤899px 记录改为三行两列：`'time who' / 'dice dice' / 'result result'`（骰子与奖项各占整行），`src/styles.css` | 旧 CSS 下实测：骰子元素并集 `39..203`、奖项文案 `109..332` → 重叠（`m03_recordsWithOverlap: 1`）；旧截图 `13-results-375.png` 肉眼可见同一现象 | `helpers.expectRecordsLayoutSane()`：**按六颗骰子元素的并集矩形**（不是 60px 容器）与时间/玩家/奖项三块做相交检查，带骰记录必须正好 6 颗、最后一颗不越出记录右边界；局中「记录」Tab 与结算页「完整记录」都跑同一断言 |
| C01 | 30 秒回合显示「剩余 31 秒」 | HTTP `Date` 只有秒级精度（被截断到整秒），旧公式 `serverMs + rtt/2 - finishedAt` 系统性低估服务端时钟 0–1000ms，叠加倒计时 `Math.ceil` 就会多 1 秒 | `src/lib/api.ts` 增加截断取中补偿 `+500ms`（抽出纯函数 `serverClockOffset`）；`src/components/GameBoard.tsx` 把展示值钳制在 `TURN_DURATION_MS`（0–30 秒）。**未改服务端 30 秒裁决，未改任何 API** | 同一批亚秒位置代入旧公式实测 9 个样本里有 6 个显示 31 秒（`f=120/300/500/700/800/900 → 31 秒`）；旧截图 `12-playing-375.png` 同样显示「剩余 31 秒」 | `tests/clock.test.ts`（纯函数：截断补偿后偏差 ≤±500ms；并断言「确有需要钳制的样本」避免断言空转）；`mobile.spec.ts` 开局即断言倒计时读数 ∈ [0,30] 并连续采样 5 次，对手页同刻读数也不越上界 |

## 9.3 无法只靠断言表达、已用真实截图复核的部分

本环境**图像查看可用**，以下四张关键截图均已重新生成（`fullPage`，`scrollTo(0,0)` 后再拍，等碗停稳且点数等于权威记录）并逐张肉眼确认：

```text
12-playing-375.png          375×1082  房间栏两行两列不拆字；「剩余 29 秒」；轮次栏下先是 260px 瓷碗（6 颗真实骰子）、
                                      当前提示、最新结果，再是 Tab 与玩家列表；底部只有一个「掷出好运」
13-results-375.png          375×1758  每条记录为「时间/玩家 → 六颗骰子整行 → 奖项文案」三行，骰子不再压字
02-playing-desktop-1440.png 1440×1236 保留 280/560/312 三栏与 400px 碗，顶部导航贴在页首（不再停在页面中间）
03-results-desktop-1440.png 1440×1610 状元卡、小结、明细与完整记录都不被 sticky 导航遮挡
```

截图助手 `tests/e2e/helpers.ts#screenshot()` 现在会先 `window.scrollTo(0,0)` 并等 `scrollY` 为 0 再拍：旧桌面结算截图里 sticky 导航停在页面中部挡住状元卡，就是上一次截图时页面处于滚动位置造成的。

375 首屏的量化结果（多次运行，含最高的三行结果文案）：

```text
结果框 top=635  最高变体 bottom=723  底部主按钮 top=735   → 留白 12px，不会遮挡
（两行结果变体 bottom=698；中心区 top 固定 635，跨运行稳定）
768 视口：中心区仍在 Tab 与玩家列表之前、6 颗骰子可见、无横向溢出（碗沿用设计稿的 400px 上界，故结果需轻微滚动；addendum 对 768 只要求「中心优先且不溢出」）
```

为把 375 首屏的核心玩法（碗/提示/最新结果）压进固定主按钮之上，≤600px 只收紧了间距（导航 56px、`.room-main` 上边距 8px、房间栏与轮次栏内边距、中心卡片内边距与间距），**颜色、字体、260px 瓷碗与 76px 主操作区等 Pi 设计规格未改**；1440 全部尺寸与三栏规格由既有用例继续守住。

## 9.4 本轮改动的文件

```text
src/components/GameBoard.tsx   Tab 栏移入中心之后；倒计时展示值钳制到 TURN_DURATION_MS
src/lib/api.ts                 serverClockOffset()：HTTP Date 秒级截断补偿 +500ms
src/styles.css                 ≤899px 中心常显/顺序/记录三行；≤600px 房间次操作两列网格与首屏间距
tests/e2e/helpers.ts           screenshot() 先回顶部；rectsOf/rectOf/overlaps/textLineCounts/countdownSeconds；
                               expectBowlMatchesLatestRecord()；expectRecordsLayoutSane()
tests/e2e/mobile.spec.ts       M01/M02/M03/C01 断言并入同一真实房间（无新增用例、无新增建房）
tests/e2e/dice.spec.ts         1440 记录骰子与奖项文案不相交（防移动端改动回退桌面可读性）
tests/clock.test.ts            新增 2 条校时/倒计时上界单元用例
```

## 9.5 本轮的限制（诚实声明）

- 375 的「最新结果不被底部按钮遮挡」是在**本用例的房间与昵称**下测得的（结果框最高变体 bottom=723，按钮 top=735，留白 12px）；若房间名换成两行以上、或当前提示因超长昵称折行，首屏仍会需要轻微滚动才能看全结果——此时内容依然可滚动、不被永久遮挡（`.room-main` 保留 120px 底部 padding）。
- 768 视口未调整瓷碗尺寸（沿用设计稿 400px 上界），因此中心区首个信息面板以下的内容需要滚动；addendum 对 768 的要求是「中心优先且不溢出」，已由断言覆盖。
- 仍未在 iOS Safari / Android Chrome 真机上验证；`env(safe-area-inset-bottom)` 在固定操作条上的表现与真机软键盘行为未实测（与第 7、8.5 节一致）。
- 仍只在本机独立端口 3210 + `.e2e-data` 跑真实生产构建产物，未部署公网；未触碰主代理 `127.0.0.1:3107` 预览进程与其 `/tmp/bobing-preview-20260925` 数据。
