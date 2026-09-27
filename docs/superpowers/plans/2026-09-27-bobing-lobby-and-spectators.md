# 数字房间码、游戏大厅与旁观 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让玩家通过六位数字码或大厅便捷入桌，让未入座的访客实时观看并在开局前转为玩家。

**Architecture:** 新码生成与旧码接受规则分离；服务层从持久化房间目录生成公开摘要，增加受旁观开关控制的只读状态入口。Socket.IO 将成员与观众分成两条订阅路径，复用相同权威游戏快照，观众计数独立于成员 presence。

**Tech Stack:** Node.js ≥24、TypeScript、React 19、Socket.IO、SQLite、Vitest、Playwright。

**Spec:** [已确认规格](../specs/2026-09-27-bobing-experience-and-lobby.md) 与 [实现契约](../specs/2026-09-27-bobing-implementation-contract.md)。新房默认公开，UI 由 Pi 实施，其余由 DeepSeek Harness 实施。

**执行状态：** 实现与本地验收完成，勾选表示最终实现及验证状态；实测、修复历史和截图见[验收记录](../../verification-2026-09-27.md)。未要求提交、推送或部署，纯提交步骤不执行。

## Global Constraints

- 新房生成六位数字字符串，保留前导零；已有字母数字房码和邀请链接继续有效。
- 新码继续检查活跃房间与 7 天过期墓碑，最多尝试 50 次；不能覆盖已有房间。
- 新房默认公开且允许旁观，可选仅邀请；旧房迁移为仅邀请且关闭旁观，房主可自行开启。
- 仅邀请表示不出现在大厅；持有房间码或链接者仍可访问概况，并在允许旁观时观看。
- 大厅只列公开、未过期且 waiting／playing 的房间；每页 20 条，前台每 5 秒刷新。
- 旁观不填昵称、不占席位；等待中且有空位才可填昵称入座，开局后等下一局。
- 观众不参与准备、投掷、发奖、房主转交、暂停恢复、房间保活或成员离席。
- 观众和成员接收相同游戏事实；任何凭证或哈希不进入房间摘要、公共快照、链接与归档。
- 本期保持每人一机；账号体系、共用手机、聊天与下局排队不在本实现计划内。

---

## 文件职责与依赖

| 文件 | 改动责任 |
| --- | --- |
| shared/room-code.ts（新增） | 新数字码与旧码共同接受的纯校验 |
| shared/types.ts | RoomAccess、Lobby DTO、观众事件和角色契约 |
| server/room-service.ts、room-migrations.ts、game.ts | 访问配置持久化、摘要查询、旁观读取及旧房迁移 |
| server/app.ts | 列表、只读状态接口与 update-access 动作解析 |
| server/realtime.ts | 观众频道、独立引用计数、关闭旁观及清理 |
| src/pages/Lobby.tsx（新增） | 大厅列表、状态筛选、加载更多与加入 |
| src/components/RoomCard.tsx（新增） | 房间摘要与加入／旁观入口 |
| src/components/SpectatorRoom.tsx（新增） | 只读房间画面和转入座 |
| src/hooks/useLobby.ts、useSpectatorRoom.ts（新增） | 列表刷新与只读实时同步 |
| src/lib/router.ts、api.ts、session.ts、src/App.tsx | 路由、请求和访客计数标识 |
| src/pages/Home.tsx、Room.tsx、RoomLanding.tsx | 新入口、数字输入、成员身份优先恢复 |
| GameBoard.tsx、WaitingRoom.tsx、Results.tsx、RoomHeader.tsx | 显式区分成员与观众操作能力 |

Task 1 可独立先交付。Task 2、3 完成后再接 Task 4；若与局内体验同一分支实施，先完成另一份计划的共享 DTO 与 GameBoard 改动，不同时修改相同接口。

## Task 1: 六位数字房码与旧链接兼容

**Files:** 新增 shared/room-code.ts、tests/room-code.test.ts；修改 shared/rules.ts、server/room-service.ts、src/lib/router.ts、src/pages/Home.tsx、tests/server.test.ts、tests/e2e/identity.spec.ts。

**Interfaces:** 新增 `isAcceptedRoomCode(code: string): boolean` 与 `normalizeRoomCodeText(raw: string): string`；原 service.normalizeRoomCode 继续负责把非法输入映射为 ServiceError，前端 router.isValidRoomCode 委托共享校验。

- [x] **Step 1: 编写兼容行为测试并确认失败。**

```ts
import { expect, it } from 'vitest';
import { isAcceptedRoomCode, normalizeRoomCodeText } from '../shared/room-code.js';

it('数字前导零与旧字母码都可用，不接受非法长度和旧禁用字符', () => {
  expect(normalizeRoomCodeText(' 028 416 ')).toBe('028416');
  expect(isAcceptedRoomCode('028416')).toBe(true);
  expect(isAcceptedRoomCode('ABC234')).toBe(true);
  expect(isAcceptedRoomCode('12345')).toBe(false);
  expect(isAcceptedRoomCode('ABCIO1')).toBe(false);
});
```

运行 `npx vitest run tests/room-code.test.ts`，预期新模块缺失失败。

- [x] **Step 2: 分离生成字符与接受规则。**

```ts
// shared/room-code.ts；ROOM_CODE_LENGTH 仍为 6。
export function normalizeRoomCodeText(raw: string): string {
  return raw.trim().replace(/\s/g, '').toUpperCase();
}
export function isAcceptedRoomCode(code: string): boolean {
  return /^(?:[0-9]{6}|[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6})$/.test(code);
}

// server/room-service.ts 默认生成器，使用已有 node:crypto randomInt。
const numericCode = (): string => Array.from({ length: 6 }, () => String(randomInt(10))).join('');
```

不要把原 ROOM_CODE_ALPHABET 直接替换后继续用它验证旧链接。默认生成器使用 numericCode，注入 createRoomCode 的测试入口仍可构造旧房；现有 generateRoomCode 的缓存／数据库／墓碑检查和 50 次重试保留。若遇碰撞，不能走 saveRoom 的 upsert 覆盖旧记录。

- [x] **Step 3: 修改输入与分享展示。** Home 的房码仍为 type=text，默认 inputMode=numeric；清理空格后最多 6 位。允许粘贴旧码，“输入旧房间码”只切换键盘模式，不改变接受规则。邀请链接路径不变；数字码显示分组可以加空格，但复制与 URL 使用原六位字符串。

- [x] **Step 4: 验证（本轮不提交）。** 服务端补齐重复码生成、墓碑码重试、50 次耗尽不覆盖、前导零持久化与旧码恢复。运行 `npx vitest run tests/room-code.test.ts tests/server.test.ts`、`npm run typecheck`，浏览器验证数字键盘属性、粘贴旧码与旧邀请。提交说明：`feat: generate numeric room codes with legacy compatibility`。

## Task 2: 房间公开设置与大厅摘要 API

**Files:** 修改 shared/types.ts、server/game.ts、server/room-service.ts、server/room-migrations.ts、server/app.ts、tests/server.test.ts、tests/db.test.ts。

**Interfaces:**

- RoomState、InternalRoom、RoomPreview 增加 `access: RoomAccess`；CreateRoomRequest、CreateRoomInput 与 CreateRoomSeed 增加可选 access，旧客户端省略时取新房默认值；Action 增加 `{ type: 'update-access'; access: RoomAccess }`。
- RoomService 新增 `listLobby(query: LobbyQuery): LobbyPage` 与 `watch(rawCode: string): RoomState`。
- GET `/api/rooms?filter=joinable&limit=20&cursor=...` 返回 LobbyPage；GET `/api/rooms/:code/watch` 返回 `{ room: RoomState }`。

```ts
export interface RoomAccess {
  visibility: 'invite' | 'public';
  allowSpectators: boolean;
}
export interface LobbyRoomSummary {
  code: string;
  name: string;
  status: 'waiting' | 'playing';
  playerCount: number;
  onlinePlayerCount: number;
  maxPlayers: number;
  rulesetName: string;
  endCondition: EndCondition;
  canJoin: boolean;
  allowSpectators: boolean;
  createdAt: number;
}
export interface LobbyQuery {
  filter: 'joinable' | 'all' | 'playing';
  limit: number; // 1..50，默认 20
  cursor: string | null;
}
export interface LobbyPage {
  rooms: LobbyRoomSummary[];
  nextCursor: string | null;
}
```

- [x] **Step 1: 添加列表可见性测试。** 在 tests/server.test.ts 现有 startServer 下创建一个默认房间和一个公开房间，再查询列表：

```ts
it('新房默认进入大厅，显式仅邀请房不展示', async () => {
  const env = await startServer();
  const common = { nickname: '房主', name: '团圆局', maxPlayers: 8, config: createDefaultRoomConfig() };
  const hidden = await env.api('POST', '/api/rooms', {
    body: { ...common, access: { visibility: 'invite', allowSpectators: true } },
  });
  const visible = await env.api('POST', '/api/rooms', { body: common });
  const list = await env.api('GET', '/api/rooms?filter=all&limit=20');
  expect(list.status).toBe(200);
  expect(list.body.rooms.map((room: { code: string }) => room.code)).toEqual([visible.body.room.code]);
  expect(list.body.rooms.some((room: { code: string }) => room.code === hidden.body.room.code)).toBe(false);
});
```

运行 `npx vitest run tests/server.test.ts`，确认列表接口缺失失败。

- [x] **Step 2: 实现配置存取、权限与迁移。** 新建默认 `{ visibility: 'public', allowSpectators: true }`；旧快照缺字段时补 `{ visibility: 'invite', allowSpectators: false }`，新格式非法值拒绝。访问配置不放进个人奖品方案。update-access 要求未离席房主，允许 waiting／playing／finished，closed 拒绝；提交保持所有准备状态、库存、deadline 和 expiresAt 原值，实际未变更时不制造额外 revision。

- [x] **Step 3: 实现摘要查询与只读入口。** 使用已有 db.listRoomCodes(now) 枚举持久化目录，合并服务层已加载状态；不能仅枚举 cache。每房只生成上述摘要白名单，先过滤 public／有效期限／状态，再按 createdAt 倒序、code 升序排序。joinable 还要求 waiting 且未满；playing 只选进行中。

cursor 使用 base64url 编码的 `{ createdAt, code }`，验证有限数字与合法房码后按同一排序取后续项；非法 cursor 或 limit 返回 INVALID_INPUT。默认一次 20 条，最多 50；无数据返回空数组和 null。请求不更改房间 lastActivityAt，不续期。

watch 使用 requireRoom 的有效期检查，并校验 allowSpectators 与 status 非 closed；关闭旁观返回新增 `SPECTATING_DISABLED`（403，“房主已关闭旁观”），允许时仅调用白名单快照，不标记任何成员在线。已结束房间可通过原链接看结算，但不进入大厅。

- [x] **Step 4: 补充回归并验证。** 覆盖私有／公开切换、进行中、满员、finished／closed／expired、跨页稳定顺序、服务重启后列表、旧房默认、非法访问配置、非房主修改，以及 preview 仍不包含完整玩家信息。运行 `npx vitest run tests/server.test.ts tests/db.test.ts` 与 `npm run typecheck`。

- [ ] **Step 5: 提交（本轮不执行）。** 建议说明：`feat: expose opt-in lobby summaries and read-only room views`。

## Task 3: 独立观众订阅与人数

**Files:** 修改 shared/types.ts、server/realtime.ts、tests/server.test.ts；必要时调整 server/index.ts 的清理接线，保留原成员服务契约。

**Interfaces:**

- 既有 Socket 鉴权 `{ roomCode, token }` 保持成员语义；新增显式旁观握手 `{ role: 'spectator', roomCode, viewerId }`。
- viewerId 为浏览器生成并按房间保存的 UUID，仅用于去重计数，不可用于任何成员动作鉴权。
- 成员频道 `room:<code>` 保留；新增观众频道 `room:<code>:spectators`。
- 新事件 `room:audience` 负载 `AudienceState`；`room:watch-ended` 负载 `WatchEnded`；game 快照仍是 room:state。

```ts
export interface AudienceState { roomCode: string; viewerCount: number; }
export interface WatchEnded { code: 'SPECTATING_DISABLED' | 'ROOM_EXPIRED' | 'INVALID_STATE'; message: string; }
export type RoomViewer = { role: 'player'; playerId: string } | { role: 'spectator' };
```

- [x] **Step 1: 添加第三个 Socket 的业务测试。** 在现有 server.test.ts 双成员场景中连接带 role=spectator 的客户端：接收同一 revision 的骰面与奖池；成员数组长度不变；该连接不提供任何成员 token。使用 viewerId 当 Bearer token 提交 ready／roll／end／leave 都应失败，成员状态不变。先运行该文件确认现有仅成员握手会拒绝新角色。

- [x] **Step 2: 将鉴权与 presence 分支分开。** role 未提供或为 member 时保留 authenticateMember → openConnection／closeConnection；role=spectator 时验证 UUID 并调用 watch，只进入观众频道。其 disconnect 仅减少观众连接引用。未知 role 拒绝，不能把失败成员鉴权自动降为旁观。

观众计数在实时层使用独立映射，算法如下：

```ts
// 每个房间一张 Map；同一 viewerId 多个标签页按一个访客计算。
const spectatorConnections = new Map<string, Map<string, Set<string>>>();
function addSpectator(code: string, viewerId: string, socketId: string): void {
  const viewers = spectatorConnections.get(code) ?? new Map<string, Set<string>>();
  const connections = viewers.get(viewerId) ?? new Set<string>();
  connections.add(socketId);
  viewers.set(viewerId, connections);
  spectatorConnections.set(code, viewers);
}
function removeSpectator(code: string, viewerId: string, socketId: string): void {
  const viewers = spectatorConnections.get(code);
  const connections = viewers?.get(viewerId);
  if (!viewers || !connections) return;
  connections.delete(socketId);
  if (connections.size === 0) viewers.delete(viewerId);
  if (viewers.size === 0) spectatorConnections.delete(code);
}
const viewerCount = (code: string): number => spectatorConnections.get(code)?.size ?? 0;
```

计数变化只发 room:audience，不递增游戏 revision、不写游戏快照；广播给成员和观众。计数不作为权限、席位或准备条件；成员 connectedCount 保持原语义。

- [x] **Step 3: 对每次广播复核旁观开关并完整清理。** 广播始终推成员频道；允许旁观才推观众频道。关闭旁观时先发送 watch-ended，再断开观众频道，不能先把更新后的完整快照发给已撤销观众。公开转仅邀请仍按 allowSpectators 决定是否继续。

订阅建立时再次读取当前 watch 状态，覆盖握手与入频道之间房主关闭旁观的竞争。房间过期、主动关闭与服务停机清理两种频道和观众映射；成员离线暂停仍完全由 room.players 决定。

- [x] **Step 4: 验证独立性。** 同 viewerId 两连接断一条仍计一人；全部观众退出不改变玩家 online；所有参赛者离线而观众保留时仍暂停、allOfflineSince 不重置、到期不延长；房主关闭旁观后旧观众不再收到后续状态，成员不断开；无 token 的原成员订阅依旧失败。运行 `npx vitest run tests/server.test.ts tests/clock.test.ts` 与 `npm run typecheck`。

- [ ] **Step 5: 提交（本轮不执行）。** 建议说明：`feat: add isolated spectator subscriptions and audience presence`。

## Task 4: 大厅、旁观界面与转入座

**Files:** 新增 Lobby.tsx、RoomCard.tsx、SpectatorRoom.tsx、useLobby.ts、useSpectatorRoom.ts、tests/e2e/lobby.spec.ts；修改 App.tsx、router.ts、Home.tsx、Room.tsx、RoomLanding.tsx、SiteHeader.tsx、api.ts、session.ts、useRoom.ts、GameBoard.tsx、WaitingRoom.tsx、Results.tsx、RoomHeader.tsx、styles.css、tests/e2e/helpers.ts。

**Interfaces:**

- 路由新增 `{ name: 'lobby' }` 对应 /lobby；新增 `{ name: 'spectate'; code: string }` 对应 /room/:code/watch。既有 /room/:code 不变。
- api 新增 `fetchLobby(query: LobbyQuery, signal?: AbortSignal): Promise<LobbyPage>`、`fetchWatchState(code: string, signal?: AbortSignal): Promise<RoomResponse>`，沿用现有错误与校时处理。
- useLobby 返回 `{ rooms, loading, refreshing, error, hasMore, refresh, loadMore }`；后两方法均为 `() => Promise<void>`，filter 改变时重置列表并取消旧请求。
- useSpectatorRoom 返回 `{ room, connection, audience, error, now }`，connection 沿用 ConnectionState，now 沿用现有服务端校时方式；只有 fetch／订阅／取消订阅，没有成员动作。
- 成员 useRoom 额外监听 room:audience，游戏 revision 合并规则保持原样。
- 共享展示组件接收 Task 3 的 RoomViewer；成员操作 props 只在 player 分支提供。观众底部动作由 SpectatorRoom 提供返回大厅／我要入座，不复用成员 leave。

- [x] **Step 1: 接入页面路由和入口。**

```ts
// parsePath 中置于原 /room/:code 解析之前；path 已去掉结尾斜线。
if (path === '/lobby') return { name: 'lobby' };
const watch = /^\/room\/([^/]+)\/watch$/.exec(path);
if (watch) return { name: 'spectate', code: decodeURIComponent(watch[1] ?? '').trim().toUpperCase() };
```

App 为 lobby 渲染 Lobby，为 spectate 渲染旁观入口。显式检查本浏览器已有有效成员凭证时优先恢复成员页面，失效凭证按既有逻辑清理；viewerId 使用独立 key `bobing.viewer.<CODE>`，不占用 membership 存储。分享仍使用原房间链接，落地页提供加入和先看看。

- [x] **Step 2: 实现大厅卡片与刷新。** 首页增加游戏大厅入口。Lobby 顶部为开房／按码加入，默认 joinable；卡片按 canJoin 和 allowSpectators 决定按钮。加入弹层只填昵称，调用原 join；成功保存 Membership 后进入原 room 路径。若刚满或刚开局，保持卡片状态并提供允许的旁观入口。

useLobby 每 5 秒在 document.visibilityState=visible 时刷新；visibilitychange 恢复立即刷新，卸载清除定时器并 abort。已加载多页时刷新相同页数，按 code 去重、移除已不公开或已结束的房间；失败保留原列表。加载更多使用返回 cursor，不能自己猜下一页。

- [x] **Step 3: 实现旁观的实时视图与角色能力。** fetchWatchState 后建立 spectator Socket，按 revision 接受新快照；网络恢复重新取权威状态，不重播旧动画。旁观直接展示骰面，不播放本人音效，也不出现“我的奖品”、准备、掷骰、提前结束或成员离席按钮。

在等待状态且未满时显示“我要入座”；点击后填昵称，再调用原 join，由服务器决定能否成功。成功后销毁旁观订阅、保存成员凭证并进入 MemberView；失败继续看当前房间。finished 显示结算和等待下一局；room:watch-ended 停止重连并展示原因及返回大厅。

- [x] **Step 4: 补充真实三浏览器验收。** 两名玩家正常开始对局，第三个无成员凭证的上下文从大厅旁观；验证同一骰面／轮次／奖池，参赛人数仍为 2，旁观人数为 1。结束后再开一局，第三人可填昵称入座，随后参赛人数变 3、旁观数减少。另测邀请房不出现在大厅、数字码粘贴、旁观关闭、房间刚满和列表请求失败。

在该真实三浏览器用例中增加以下断言；visitor 为该用例创建的第三个 Page，先完成从大厅点击旁观的步骤，再验证这些可观察行为：

```ts
// visitor 是第三个独立上下文的 Page，房间当前为 playing。
await expect(visitor.getByRole('button', { name: '掷出好运', exact: true })).toHaveCount(0);
await expect(visitor.getByText('本局已开始，可在下一局入座')).toBeVisible();
await expect(visitor.getByRole('link', { name: '返回大厅' })).toBeVisible();
```

更新现有 helpers 中因顶部收纳改变的邀请入口定位；区分“未轮到的成员”与真正观众测试。保留无凭证不能调用成员 state／actions 的原断言，新增 watch 独立入口的断言。

- [x] **Step 5: 完成全量验收与文档（本轮不提交）。** 定向运行 `npx playwright test tests/e2e/lobby.spec.ts tests/e2e/multiplayer.spec.ts tests/e2e/identity.spec.ts`；完成后运行一次 `npm run typecheck`、`npm test`、`npm run build`、`npm run test:e2e`。截图覆盖 375／768／1440 的大厅、旁观和转入座；检查游戏计划 E01–E11 没被观众分支破坏。

更新 docs/product-spec.md、docs/ui-design.md、docs/acceptance-matrix.md 和 README.md 的入口／身份／接口说明，保留旧验收历史。提交说明：`feat: add the game lobby and spectator-to-player flow`。

## 交付边界

本计划完成后，用户可通过新数字码、旧邀请或公开大厅找到房间，未入座者可按房主设置旁观。新码与旧码兼容、只读角色及现有回合权限都必须有测试证据。共用手机多人模式另行规划，不把一个成员 token 同时当作多个玩家使用。
