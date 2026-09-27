# 月满博饼

中秋博饼多人网页：房主创建房间、分享邀请，朋友输入昵称即可入席，轮流掷六颗骰子博状元。
服务端是随机数、轮次、权限、奖池、判奖与结算的唯一权威，所有客户端通过 Socket.IO 接收同一份带 `revision` 的房间快照。

本轮（2026-09-27）在前一版基础上加入：六位纯数字房间码（保留前导零，旧字符集房码与旧邀请链接继续有效）、
公开游戏大厅 `/lobby` 与站内入座、只读旁观（`/room/:code/watch` 与观众频道：不占席位、不标记在线、不续期房间、
不影响回合与结算），以及房主可调的结果停留节奏（默认 1 秒，0–10 整数秒）。
新房默认「大厅公开、允许旁观」，旧房间迁移为「仅邀请、关闭旁观」；本机已有有效成员凭证时始终优先恢复成员身份。

本轮范围：后端实现与业务验证，以及大厅、旁观与房间设置的接入。
本轮的验证进度与最新实测结果以[本轮实现与验证进度](docs/verification-2026-09-27.md)为唯一来源，本文不复述当前状态。
**同屏／共用一台手机的多人轮流操作（shared-phone multiplayer）本轮明确推迟，不在本轮交付范围内。**

- 房规：[持续顶状元／高阶锁定](docs/rules-research.md)（共用 V1 牌型判定，状元争夺策略不同）
- 完整需求与接口契约：[docs/product-spec.md](docs/product-spec.md)（文首「当前状态」为本轮有效说明）
- 分步计划、工时与依赖：[开发计划](docs/superpowers/plans/2026-09-25-bobing.md)
- 界面规范：[docs/ui-design.md](docs/ui-design.md)
- 部署与备份：[docs/deployment.md](docs/deployment.md)
- 上一轮需求与分工：[可配置玩法规格](docs/superpowers/specs/2026-09-26-bobing-configurable-play.md)
- 上一轮集成验收：[docs/configurable-play-verification.md](docs/configurable-play-verification.md)
- 本轮需求（局内体验、数字房码、大厅与旁观）：[设计稿](docs/superpowers/specs/2026-09-27-bobing-experience-and-lobby.md) 与 [实现契约](docs/superpowers/specs/2026-09-27-bobing-implementation-contract.md)
- 本轮后端交付说明（改动、验证命令与实际结果、遗留问题）：[docs/backend-handoff-2026-09-27.md](docs/backend-handoff-2026-09-27.md)
- 本轮实现与验证进度（主代理维护）：[docs/verification-2026-09-27.md](docs/verification-2026-09-27.md)
- 历史实测记录：[docs/verification.md](docs/verification.md)

## 技术栈

Node.js ≥ 24、npm、TypeScript、React 19、Vite、Express、Socket.IO、`node:sqlite`、Vitest、Playwright、Docker。
前端与后端同源；开发时由 Vite 代理 `/api` 与 `/socket.io` 到 3001。

## 快速开始

```bash
npm install          # 安装依赖（Node 24+）
npm run dev          # 一条命令同时起前端 5173 与后端 3001
```

打开 http://localhost:5173 ，创建房间后用第二个浏览器（或无痕窗口）打开邀请链接，即可两人对局。
同一局域网的其他设备使用 `http://本机局域网IP:5173` 访问。与其他设备联机时，房主也使用这个局域网地址开房，使默认邀请链接可被其他设备访问；`localhost` 只指向访问者自己的设备。
同一个浏览器窗口只保存一份该房间的成员凭证，因此**联调请用两个不同的浏览器/无痕窗口**。
再开第三个无痕窗口访问 http://localhost:5173/lobby ，就能看到默认公开的房间并「先去旁观」：观众不占席位，可实时看到骰面与人数。

生产构建与运行：

```bash
npm run build        # 前端 Vite 构建 + 后端 tsc 构建（dist/ 与 dist-server/）
npm start            # 运行构建产物，默认 http://localhost:3001（深链刷新可用）
```

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 同时启动 Vite（5173）与后端（3001），一条命令完成开发联调 |
| `npm run dev:web` / `npm run dev:server` | 只启动前端 / 只启动后端（`tsx watch`） |
| `npm run build` | 完整前后端生产构建（`build:web` + `build:server`） |
| `npm start` | 运行 `dist-server/server/index.js`（会先执行 `prestart` 编译后端） |
| `npm run typecheck` | TypeScript 覆盖 `src`、`shared`、`server`、`tests` 与配置文件 |
| `npm test` | Vitest 单元与集成测试；本轮改动、实际命令与结果见 [后端交付说明](docs/backend-handoff-2026-09-27.md) |
| `npm run test:e2e` | Playwright 端到端测试，使用生产构建、独立测试数据与真实浏览器流程 |

## 环境变量

直接用环境变量启动。若复制 `.env.example` 为 `.env`，生产构建后使用 `node --env-file=.env dist-server/server/index.js` 加载；`npm start` 本身不会读取 `.env`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 服务端口，监听 `0.0.0.0`（同一局域网可访问）；docker compose 下同时决定宿主机映射端口 |
| `DATA_DIR` | `./data` | SQLite 目录，包含 `bobing.sqlite` 与 WAL/SHM 文件；部署时必须挂载为持久化目录/卷 |
| `PUBLIC_BASE_URL` | 空 | 分享链接使用的对外地址。必须是访问者能打开的 http(s) 绝对地址，且不含用户名/密码、查询串或片段；留空时前端使用访问者当前地址。通过只读接口 `GET /api/config` 下发给前端，不需要重新构建前端 |
| `TRUST_PROXY` | `0`（docker compose 下默认 `1`） | 前置反向代理时设为 `1`，按 `X-Forwarded-For` 取客户端 IP 用于限流；直连时必须为 `0`，否则可伪造 IP 绕过限流 |

`PUBLIC_BASE_URL` 与构建产物无关：运行时修改后重启进程即可生效（避免构建期与运行期配置混淆）。

## 目录结构

```text
shared/types.ts        公共 DTO / 动作 / 错误码（不含任何密钥字段）
shared/rules.ts        纯判奖函数、比较器、规则展示元数据（穷举 46656 组合校验）
shared/room-config.ts  默认房间配置、严格输入校验与初始奖池
shared/room-access.ts  房间访问设置：新房默认公开／允许旁观，旧房间迁移为仅邀请
shared/presentation.ts 结果展示节奏：投掷动画常量、结果停留 0–10 秒的默认值与严格校验
shared/room-code.ts    房间码：六位纯数字（保留前导零）与旧字符集码的统一接受规则
shared/rulesets.ts     系统房规注册表与版本快照
server/index.ts        服务入口、生产静态资源与 SPA 回退、PUBLIC_BASE_URL 读取
server/app.ts          HTTP 路由、输入校验、大厅查询解析、GET /api/config
server/db.ts           SQLite 建表、事务、回执、独立归档、过期墓碑与旧表结构迁移
server/room-migrations.ts 旧房间快照归一化：旧固定轮数房间、上一版房间、旧完成对局、损坏检测
server/room-service.ts 创建/加入/身份恢复/动作/公共快照/在线状态/大厅/旁观/计时/归档
server/game.ts         开局、轮转、发奖、状元事件、结果展示阶段、超时跳过、结算、再开局
server/realtime.ts     Socket.IO 成员与观众双通道鉴权、订阅、断连引用计数、观众计数、广播
server/clock.ts        1 秒时钟：展示结束、超时、暂停恢复、房主转交、过期清理
src/App.tsx            路由与页面装配（`/`、`/lobby`、`/rules`、`/room/:code`、`/room/:code/watch`）
src/pages/Home.tsx     首页（创建 / 房码加入）
src/pages/Lobby.tsx    游戏大厅：可加入／全部／进行中筛选、分页加载与仅填昵称入座
src/pages/Room.tsx     邀请落地 → 等待室 → 对局 → 结算（成员路由与只读旁观路由共用）
src/pages/Rules.tsx    完整规则页
src/components/RoomSettingsDialog.tsx 房间设置：可见性、允许旁观、结果停留
src/components/SpectatorRoom.tsx 观众视图：只读面板、观众人数与「我要入座」
src/components/SeatStrip.tsx 席位条（等待室与观众共用的入座概览）
src/components/ChampionHistory.tsx 本局状元历程（只统计当前一局）
src/components/RecentActivity.tsx 最近 1 条浮条与「最近 10 次／只看我」抽屉
src/components/*       瓷碗、点阵骰子、玩家、奖池、我的奖品、完整记录、结算、分享/规则/确认弹层
src/hooks/useRoom.ts   成员权威快照同步、revision 合并、断线重连、幂等掷骰
src/hooks/useLobby.ts  大厅列表：筛选、游标分页、轮询刷新与失败重试
src/hooks/useSpectatorRoom.ts 只读旁观：`/watch` 快照 + 观众频道、人数与 `room:watch-ended`
src/lib/router.ts      路径解析（大厅与 `/room/:code/watch` 路由）
src/lib/api.ts         REST 超时、错误码映射、HTTP Date 校时、运行时配置
src/lib/session.ts     按房间保存/恢复匿名凭证（不进入 URL、二维码或分享文本）
src/lib/templates.ts   本机个人方案：只保存奖品和结束方式
src/lib/dice-sound.ts  本人新投掷的翻滚与碰撞音效（默认关闭）
src/styles.css         Pi 设计规范的完整响应式样式（自绘瓷碗与骰子，无外链图片/字体）
tests/*.test.ts        Vitest：规则、对局状态机、结果展示节奏、HTTP/Socket/持久化、大厅与旁观、旧数据迁移
tests/e2e/*.spec.ts    Playwright：两人对局用两个独立浏览器上下文；大厅与旁观用三个独立浏览器上下文（房主＋入座成员＋观众）
```

## 玩法与实现要点

- 创建时可选 2–12 人（默认 8）。房主默认已准备且可切换；等待室里房主可以随时改配置，开局后冻结。
- **房规**（系统预设二选一）：`持续顶状元`（默认，严格更大的状元成绩持续顶替，同分先到先得）与
  `高阶锁定`（首次出现五红／六黑／遍地锦／六红／插金花即锁定唯一得主，锁定只定归属，不会让整局提前结束）。
- **结束方式**二选一：`奖品发完`（默认，普通五档全部发完且有人夺魁时收完当前整轮再结算，奖品没发完就继续，
  没有状元就一直等）与 `固定轮数`（5/10/20 轮，到上限按轮数结束并显示剩余奖品）。
- **奖品**六档份数与内容全部由房主设置，每档至少 1 份；默认共 63 份（对堂 2、三红 4、四进 8、二举 16、一秀 32、状元 1）。
  状元份数可以大于 1，全部归唯一的最终状元；重复结算不会再次发放。
- 个人方案可在当前浏览器命名保存、载入、更新和删除，只保存数量、奖品内容及结束方式，不改变系统房规、房间可见性或游戏节奏。
- 音效默认关闭，可打开并记住偏好；只为本人新投掷播放翻滚、落碗和碰撞声。六颗骰子分阶段运动、逐颗停稳，刷新与重连不重播旧结果，并尊重减少动态效果设置。
- **结果展示阶段**：一次机会按「本人约 750ms 骰子动画 → 结果阅读（默认 1 秒）→ 下一位完整 30 秒」推进。
  展示期间房间仍是 `playing`、保留本次 `turnId`／`turnPlayerId` 作为上下文、`deadline` 为 `null`，服务端拒绝新的掷骰并返回 `RESULT_SHOWING`；
  相同 `requestId` 的重试仍命中幂等回执，不会重复扣奖。最后一掷同样展示完才结算，结算页保留最后一次结果摘要。
- **游戏节奏**：房主可在创建时或房间设置里把结果停留设为 0–10 整数秒（默认 1，0 表示不额外阅读但仍保留掷骰动画）。
  修改只对下一条记录生效，不重置准备状态、库存、当前回合剩余时间、房间到期时间或正在进行的结果展示。节奏与个人奖品方案完全分离。
- **房间访问设置**：创建时可选「大厅公开」（默认）或「仅邀请」，并可选择是否允许旁观。
  仅邀请只表示不出现在大厅，持有房间码或链接的人仍能访问概况；旧房间迁移为「仅邀请、关闭旁观」，不会因为新房默认值自动公开。
  改可见性不取消其他人的准备，也不改变奖品与对局进度；关闭旁观会让正在观看的观众立即收到 `room:watch-ended` 并停止接收后续快照。
- **个人最后结果与状元历程**：本人的最后一次机会（投掷或超时）单独保存为 `Player.lastRoll`，他人投掷不会覆盖，也不受 240 条记录窗口裁剪。
  本局状元事实序列保存在 `RoomState.championEvents`（首次登顶／顶替／自己提高成绩／结算发奖），同样不受窗口裁剪；
  「登顶次数」只算首次登顶与从别人手中夺回。旧房间不伪造历史事件，`championHistoryComplete` 为 `false`。
- **数字房码**：新房码是六位纯数字字符串（`028416` 这样的前导零保留），旧六位字符集房码与邀请链接继续有效；
  输入忽略空白并转大写，生成时保留 50 次防碰撞重试与 7 天过期墓碑检查。
- **大厅与旁观**：`/lobby` 默认展示可加入的公开房间，可按「全部／进行中」切换，每页 20 条。
  旁观是服务端受限的只读订阅：不占席位、不需要成员凭证、不标记玩家在线、不续期房间，也不参与准备、掷骰、发奖与暂停判断。
  观众人数按同一浏览器的访客标识去重，通过独立的 `room:audience` 事件下发，不改变游戏 `revision`。
- 至少 2 人在线且都已准备时房主才能开始；开局后不再加入新玩家。开局后即使只剩 1 位在席成员也能继续掷骰。
- 每次机会 30 秒：超时记「超时跳过」，不掷骰、不发奖，消耗一次机会，并计入该玩家的累计次数。
- 每人每局的投掷／超时次数独立累计，不受当前显示的 240 条记录窗口影响；同一投掷只取最高牌型，不兼得、不追缴。
- 全员掉线会暂停倒计时并保存剩余时间，有人重连后恢复；刷新不丢身份、不重新掷骰。
- 房主离线60秒后转交给最早入座的在线成员；主动离开立即转交，优先在线成员，无在线候选则交给最早入座的在席成员。
- **到期规则**：等待室从创建起 24 小时；对局进行中只要还有人在线就不过期（不受创建时间截断），
  全员离线立刻暂停并从离线那一刻起 24 小时；重连即取消，重复断开或重启都不会顺延。
  完成／中止／全员离席／回到等待室都从那次状态转换起重新计算 24 小时。过期访问返回「房间已过期」。
- 每局结束（正常结算、房主中止、全员离席、离线过期）都会单独留一条归档记录，清理房间不会删除归档。
  归档保存白名单公共快照：个人最后结果与状元历程原样保留，离线过期时不补发状元、不追加结算事件，并且不留进行中的展示与回合状态。
- 没有账号体系：只有昵称、房名与本地凭证；凭证不会出现在 URL、二维码、分享文本、日志或广播里。

## HTTP 与 Socket 接口（本轮新增／变化）

| 接口 | 说明 |
| --- | --- |
| `POST /api/rooms` | 新增可选 `pacing`（`{resultHoldSeconds}`，0–10 整数）与 `access`（`{visibility,allowSpectators}`）。两项省略时取新房默认：停留 1 秒、公开且允许旁观；显式给出但非法一律 400 `INVALID_INPUT`，不静默补齐 |
| `GET /api/rooms` | 游戏大厅：`filter=joinable｜all｜playing`（默认 `joinable`）、`limit=1–50`（默认 20）、`cursor`。只列出公开、未过期、状态为 `waiting`／`playing` 的房间，按 `createdAt` 倒序、`code` 升序稳定分页；`cursor` 是 `{createdAt,code}` 的 base64url |
| `GET /api/rooms/:code/watch` | 只读旁观快照。不需要成员凭证，不标记在线、不续期；关闭旁观返回 403 `SPECTATING_DISABLED`，已关闭返回 409，已过期返回 410 |
| `GET /api/rooms/:code/state`、`POST /api/rooms/:code/actions` | 保持原有成员凭证鉴权；观众标识（viewerId）不是凭证，用它会得到 401 `INVALID_TOKEN` |
| `POST /api/rooms/:code/actions`（`update-pacing`／`update-access`） | 仅未离席房主可用，`waiting`／`playing`／`finished` 允许、`closed` 拒绝；没有实际变化时不递增 `revision` |
| Socket `auth:{roomCode,token}` | 保持成员语义；凭证失败不会被降级成观众 |
| Socket `auth:{role:'spectator',roomCode,viewerId}` | 观众订阅（`viewerId` 只用于同房去重计数）。未知 `role` 一律拒绝。成员频道 `room:<code>`、观众频道 `room:<code>:spectators` 接收同一份 `room:state` |
| Socket `room:audience` | `{roomCode,viewerCount}`：去重后的观众人数，初连即下发，不改变游戏 `revision` |
| Socket `room:watch-ended` | `{code:'SPECTATING_DISABLED'｜'ROOM_EXPIRED'｜'INVALID_STATE', message}`：先发本事件再断开观众连接，之后不再推快照 |

## 部署

单实例 + 持久化数据目录的 Docker 部署：

```bash
# 公网（反向代理 + HTTPS）
PUBLIC_BASE_URL=https://bobing.example.com TRUST_PROXY=1 docker compose up -d --build

# 局域网直连（无 HTTPS，连同一 Wi-Fi 的人可直接访问）
PORT=7777 PUBLIC_BASE_URL=http://10.10.10.5:7777 TRUST_PROXY=0 docker compose up -d --build
```

限制与注意（完整版见 [docs/deployment.md](docs/deployment.md)）：

- **只能启动一个副本**：SQLite 文件数据库 + 进程内房间状态，多副本会互相覆盖。
- 数据目录 `/app/data` 以 bind mount 落在宿主机 `./data`，可直接查看与备份。**清空该目录等于清空所有房间与凭证。**
- 端口绑定在所有网卡，本机与局域网都可访问；换端口：`PORT=8080 docker compose up -d --build`。
  只想允许反向代理访问时，把 `ports` 改成 `'127.0.0.1:${PORT:-3001}:${PORT:-3001}'`。
- `PORT`、`PUBLIC_BASE_URL`、`TRUST_PROXY` 可写在项目根目录 `.env` 里，`docker compose` 会自动读取。
- **直连（没套反向代理）时必须 `TRUST_PROXY=0`**，否则客户端可伪造 `X-Forwarded-For` 绕过限流。
- 公网必须走 HTTPS，并在反向代理中转发 WebSocket 的 `Upgrade`/`Connection`。
- 使用独立域名的根路径，当前不支持 `/bobing/` 等子路径部署。
- `PUBLIC_BASE_URL` 必须是**访问者真能打开的地址**。留空时前端用访问者当前地址，从 `localhost` 打开就会分享出 `localhost` 链接给别人。
- 正常关闭会保存暂停状态，重启后原身份重连可继续；异常退出且未保存暂停时，停机时间可能耗尽当前机会（见部署文档「已知限制」）。

## 验收与测试

```bash
npm run typecheck && npm test && npm run build && npm run test:e2e
```

`npm run test:e2e` 会先用生产构建启动真实服务（端口 3210、独立数据目录 `.e2e-data`），再用真实浏览器跑两类流程：

- 两人对局：两个独立浏览器上下文完成 创建 → 邀请链接加入 → 准备 → 开始 → 轮流掷骰 → 刷新保持身份 → 结算 → 再开一局；
- 大厅与旁观：三个独立浏览器上下文（房主＋入座成员＋观众）完成 默认公开数字房码 → 大厅仅填昵称入座 → 第三人只读旁观并同步看到同一骰面与观众人数 → 再开局后观众入座转为成员。

截图按 375 / 768 / 1440 三档宽度留档到 `docs/screenshots/`。E2E 不使用任何测试专用接口，也不注入自选骰子。

上面的命令只说明如何运行、不表示结果；本轮的**实际执行结果与未完成项**以[本轮实现与验证进度](docs/verification-2026-09-27.md)和[后端交付说明](docs/backend-handoff-2026-09-27.md)为准，是否全量通过以该进度文件记录的最新实测结果为准。
