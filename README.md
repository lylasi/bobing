# 月满博饼

中秋博饼多人网页：房主创建房间、分享邀请，朋友输入昵称即可入席，轮流掷六颗骰子博状元。
服务端是随机数、轮次、权限、奖池、判奖与结算的唯一权威，所有客户端通过 Socket.IO 接收同一份带 `revision` 的房间快照。

- 房规：[线上统一房规 v1](docs/rules-research.md)（特殊牌型各地有差异，本房间采用该线上版本）
- 完整需求与接口契约：[docs/product-spec.md](docs/product-spec.md)
- 分步计划、工时与依赖：[开发计划](docs/superpowers/plans/2026-09-25-bobing.md)
- 界面规范：[docs/ui-design.md](docs/ui-design.md)
- 部署与备份：[docs/deployment.md](docs/deployment.md)
- 本轮实测记录：[docs/verification.md](docs/verification.md)
- 最终独立验收：[docs/primary-final-verification.md](docs/primary-final-verification.md)

## 技术栈

Node.js ≥ 24、npm、TypeScript、React 19、Vite、Express、Socket.IO、`node:sqlite`、Vitest、Playwright、Docker。
前端与后端同源；开发时由 Vite 代理 `/api` 与 `/socket.io` 到 3001。

## 快速开始

```bash
npm install          # 安装依赖（Node 24+）
npm run dev          # 一条命令同时起前端 5173 与后端 3001
```

打开 http://localhost:5173 ，创建房间后用第二个浏览器（或无痕窗口）打开邀请链接，即可两人对局。
同一个浏览器窗口只保存一份该房间的成员凭证，因此**联调请用两个不同的浏览器/无痕窗口**。

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
| `npm test` | Vitest 单元与集成测试（119 条；不包含 Playwright 用例） |
| `npm run test:e2e` | Playwright 端到端测试（22条，先用生产构建启动真实服务，再跑真实浏览器流程） |

## 环境变量

直接用环境变量启动。若复制 `.env.example` 为 `.env`，生产构建后使用 `node --env-file=.env dist-server/server/index.js` 加载；`npm start` 本身不会读取 `.env`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 服务端口，监听 `0.0.0.0`（同一局域网可访问） |
| `DATA_DIR` | `./data` | SQLite 目录，包含 `bobing.sqlite` 与 WAL/SHM 文件；部署时必须挂载为持久化卷 |
| `PUBLIC_BASE_URL` | 空 | 分享链接使用的对外地址。必须是 http(s) 绝对地址，且不含用户名/密码、查询串或片段；留空时前端使用访问者当前地址。通过只读接口 `GET /api/config` 下发给前端，不需要重新构建前端 |
| `TRUST_PROXY` | `0` | 前置反向代理时设为 `1`，按 `X-Forwarded-For` 取客户端 IP 用于限流 |

`PUBLIC_BASE_URL` 与构建产物无关：运行时修改后重启进程即可生效（避免构建期与运行期配置混淆）。

## 目录结构

```text
shared/types.ts        公共 DTO / 动作 / 错误码（不含任何密钥字段）
shared/rules.ts        纯判奖函数、比较器、规则展示元数据（穷举 46656 组合校验）
server/index.ts        服务入口、生产静态资源与 SPA 回退、PUBLIC_BASE_URL 读取
server/app.ts          HTTP 路由、输入校验、GET /api/config
server/db.ts           SQLite 建表、事务、回执与归档、过期墓碑
server/room-service.ts 创建/加入/身份恢复/动作/公共快照/在线状态/计时
server/game.ts         开局、轮转、发奖、状元比较、超时跳过、结算、再开局
server/realtime.ts     Socket.IO 鉴权、订阅、断连引用计数、广播
server/clock.ts        1 秒时钟：超时、暂停恢复、房主转交、过期清理
src/App.tsx            路由与页面装配
src/pages/Home.tsx     首页（创建 / 房码加入）
src/pages/Room.tsx     邀请落地 → 等待室 → 对局 → 结算
src/pages/Rules.tsx    完整规则页
src/components/*       瓷碗、点阵骰子、玩家、奖池、记录、结算、分享/规则/确认弹层
src/hooks/useRoom.ts   权威快照同步、revision 合并、断线重连、幂等掷骰
src/lib/api.ts         REST 超时、错误码映射、HTTP Date 校时、运行时配置
src/lib/session.ts     按房间保存/恢复匿名凭证（不进入 URL、二维码或分享文本）
src/styles.css         Pi 设计规范的完整响应式样式（自绘瓷碗与骰子，无外链图片/字体）
tests/*.test.ts        Vitest：规则、对局状态机、HTTP/Socket/持久化、运行时配置
tests/e2e/*.spec.ts    Playwright：两个独立浏览器上下文完成真实对局
```

## 玩法与实现要点

- 创建时可选 2–12 人（默认 8）、每人 5/10/20 轮（默认 10）。房主默认已准备且可切换。
- 至少 2 人在线且都已准备时房主才能开始；开局后不再加入新玩家。
- 每次机会 30 秒：超时记「超时跳过」，不掷骰、不发奖，消耗一次机会。
- 奖池 63 份：对堂 2、三红 4、四进 8、二举 16、一秀 32，状元 1 份在整局结束时发给领先者。
- 普通奖领完时完成当前整轮后结算；同一投掷只取最高牌型，不兼得、不追缴。
- 全员掉线会暂停倒计时，有人重连后恢复剩余时间；刷新不丢身份、不重新掷骰。
- 房主离线60秒后转交给最早入座的在线成员；主动离开立即转交，优先在线成员，无在线候选则交给最早入座的在席成员。
- 房间创建后 24 小时固定过期（不随操作续期），过期访问返回「房间已过期」。
- 没有账号体系：只有昵称、房名与本地凭证；凭证不会出现在 URL、二维码、分享文本、日志或广播里。

## 部署

单实例 + 持久化数据卷的 Docker 部署：

```bash
PUBLIC_BASE_URL=https://bobing.example.com docker compose up -d --build
```

限制与注意（完整版见 [docs/deployment.md](docs/deployment.md)）：

- **只能启动一个副本**：SQLite 文件数据库 + 进程内房间状态，多副本会互相覆盖。
- 数据卷 `/app/data` 必须持久化；备份请用 SQLite 备份接口或停服后连同 `-wal`/`-shm` 一起复制。
- 公网必须走 HTTPS，并在反向代理中转发 WebSocket 的 `Upgrade`/`Connection`。
- 使用独立域名的根路径，当前不支持 `/bobing/` 等子路径部署。
- `localhost` 只对本机有效，局域网 IP 只对同一网络有效；把它们当成可发给互联网好友的地址是错的。
- 正常关闭会保存暂停状态，重启后原身份重连可继续；异常退出且未保存暂停时，停机时间可能耗尽当前机会（见部署文档「已知限制」）。

## 验收与测试

```bash
npm run typecheck && npm test && npm run build && npm run test:e2e
```

`npm run test:e2e` 会先用生产构建启动真实服务（端口 3210、独立数据目录 `.e2e-data`），再用两个独立浏览器上下文完成
创建 → 邀请链接加入 → 准备 → 开始 → 轮流掷骰 → 刷新保持身份 → 结算 → 再开一局，并在 375 / 768 / 1440 三档宽度留档截图到 `docs/screenshots/`。
E2E 不使用任何测试专用接口，也不修改轮数等规则。
