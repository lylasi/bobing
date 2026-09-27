# 后端交付说明：局内体验、数字房码、大厅与旁观（2026-09-27）

分支 `feat/room-experience-lobby`。本文件记录**共享层与服务层的实际改动、验证命令与实际结果、遗留问题**。
文件边界按[实现契约](superpowers/specs/2026-09-27-bobing-implementation-contract.md)：本文件作者只改了
`shared/**`、`server/**`、`tests/*.test.ts`、`README.md` 与本文件；未改动 `src/**`、`tests/e2e/**`、
方案与契约文档，也未执行 `git commit/push`、未部署、未再转发任务。

本轮工作是在**上一个被取消的 DeepSeek 任务留下的现有改动之上继续完成**，没有推倒重来：
既有 `shared/presentation.ts`、`shared/room-access.ts`、`shared/room-code.ts`、`server/game.ts`、
`server/room-service.ts`、`server/room-migrations.ts`、`tests/game.test.ts` 等实现被判读后保留，
本次补齐的是缺失的适配、修复、服务层测试、文档与验证。

---

## 1. 关键缺陷：省略 `access` 被当成非法配置

**状态：已修复。**

`RoomService.create` 现在对两个房间设置分别处理「省略」与「显式非法」：

```ts
const pacing = this.normalizePacingOrInvalid(input.pacing);                       // undefined → 默认 1 秒
const access = input.access === undefined ? createDefaultRoomAccess()             // 省略 → 公开＋允许旁观
                                          : this.normalizeAccessOrInvalid(input.access);
```

- 只改创建路径：`normalizeAccessOrInvalid` 本身没有放宽，`update-access` 的严格校验、旧快照迁移
  （`readAccessField` → `createLegacyRoomAccess()`）和损坏检测都没有被弱化。
- 显式 `access: null`、`{}`、缺字段、未知 visibility、非布尔 `allowSpectators`、数组仍然一律
  400 `INVALID_INPUT`，并且在生成房码之前就拒绝（不留下半个房间）。
- 省略 `pacing` 与省略 `access` 相互独立：只给其中一项时另一项仍落新房默认。

**回归用例**（`tests/server.test.ts`）：

- `房间节奏与访问设置：默认、校验与权限（A03、L02） > 省略 pacing／access 落到新房默认；显式非法一律 400 且不创建房间（回归）`
  覆盖：完全省略 → 201 且 `pacing={resultHoldSeconds:1}`、`access={visibility:'public',allowSpectators:true}`；
  只省略其中一项；8 种非法 `access` + 8 种非法 `pacing` 全部 400；`loadedRoomCount()` 不变。
- `测试 > 创建返回 201、房主默认准备、6 位纯数字房码且新房默认公开并停留 1 秒` 也直接断言了这两个默认值。

独立根集成脚本（主代理所有，未修改）在修复后 8/8 场景组全部 PASS，见第 5 节。

---

## 2. 实际改动（共享层与服务层）

### 2.1 共享 DTO 与规则（`shared/`）

| 文件 | 内容 |
| --- | --- |
| `shared/types.ts` | `RoomPacing`、`RoomAccess`、`ResultPresentation`、`ChampionOutcome`、`ChampionEvent`、`LobbyRoomSummary`、`LobbyQuery`、`LobbyPage`、`AudienceState`、`WatchEnded`、`RoomViewer`；`RoomState`／`InternalRoom`／`RoomPreview` 增加 `pacing`／`access`，`Player` 增加 `lastRoll`，`RollRecord` 增加 `championOutcome`，`RoomState` 增加 `championEvents`／`championHistoryComplete`／`presentation`；`Action` 增加 `update-pacing`／`update-access`；新增错误码 `RESULT_SHOWING`、`SPECTATING_DISABLED`；新增 `SOCKET_EVENT_AUDIENCE`、`SOCKET_EVENT_WATCH_ENDED` |
| `shared/presentation.ts` | `DICE_REVEAL_MS=750`、`DEFAULT_RESULT_HOLD_SECONDS=1`、`MIN/MAX_RESULT_HOLD_SECONDS=0/10`、`createDefaultRoomPacing`、`normalizeRoomPacing`（`undefined` → 默认；非法显式值 → `TypeError`）、`sameRoomPacing`、`presentationDurationMs`（`rolled=750+秒*1000`，`timeout=秒*1000`） |
| `shared/room-access.ts` | `createDefaultRoomAccess()`（公开＋允许旁观）、`createLegacyRoomAccess()`（仅邀请＋关闭旁观）、`normalizeRoomAccess`、`sameRoomAccess` |
| `shared/room-code.ts` | `ROOM_CODE_DIGITS`、`normalizeRoomCodeText`（去空白＋转大写）、`isAcceptedRoomCode`（六位数字或旧六位字符集）、`ACCEPTED_ROOM_CODE_LENGTH`；旧字符集与 `shared/rules.ts` 的 `ROOM_CODE_ALPHABET` 完全一致，`ROOM_CODE_LENGTH` 仍是 6 |

### 2.2 对局逻辑（`server/game.ts`）

- **结果展示阶段**：`applyRoll`／`skipExpiredTurn` 只记录本次权威事实并调用 `beginPresentation`
  （`until = now + presentationDurationMs(reason, pacing)`，`deadline=null`，保留 `turnId`／`turnPlayerId`）；
  新增 `completeResultPresentation(room, now)`：到时清除阶段并调用原 `advanceTurn`，**下一位从实际开放时刻起拿到完整 30 秒**。
  `dropCurrentTurnIfPlayer` 在展示期间不提前推进，展示结束后统一跳过已离席席位。
- **个人最后结果**：`InternalPlayer.lastRoll` 在正常投掷与超时后保存为记录深拷贝，独立于 240 条窗口。
- **状元事实**：`registerChampion` 返回 `ChampionOutcome`（`first`／`takeover`／`improved`／`tied`／`lower`／`locked`），
  且只在归属或成绩实际变化时追加 `ChampionEvent`；`finishGame` 实际发奖时追加唯一一条 `settled`（`recordId=null`、`awardedCount=实际份数`）。
  同分、较小、被锁定挡下都不产生虚假登顶事件。
- **暂停／恢复**：展示阶段暂停时保存 `presentationRemainingMs` 并把 `until` 置 `null`，恢复时从剩余毫秒继续。
- `finishGame`、`pauseRoom`、`prepareRematch`、`startGame` 全部清空展示阶段；`prepareRematch` 把 `championHistoryComplete` 复位为 `true`。

### 2.3 房间服务（`server/room-service.ts`）

- 创建：可选 `pacing`／`access`，省略取新房默认（见第 1 节）；`CreateRoomSeed` 透传。
- 动作用例 `update-pacing`（下一条记录生效，不重置准备／库存／`deadline`／`expiresAt`／进行中的 `presentation.until`）
  与 `update-access`（立即生效，不重置任何对局进度）：仅房主，`closed` 拒绝，无实际变化不递增 `revision`。
- `handleRoll`：先命中幂等回执（相同 `requestId` 在展示期间仍返回 200）；展示期间返回 409 `RESULT_SHOWING`；
  展示已到时（tick 未跑）先完成阶段再返回 `STALE_TURN`；到期与下一次 tick 之间迟到的掷骰先按超时结算。
- `tick`／`tickRoom`：新增 `drainResultPresentation`，允许 0 秒停留时在同一 tick 内连续完成展示与轮转；
  结算发生在 tick 内时把 `expiresAt` 从结算时刻重算。
- 旁观入口 `watch(code)`：允许旁观且房间有效（非 `closed`）才返回公共快照；不使用 token、不标记在线、不刷新 `lastActivityAt`、不续期。
- 大厅 `listLobby(query)`：遍历 `db.listRoomCodes(now)`（持久化目录，不读内存缓存），只保留公开、未过期、`waiting`／`playing`；
  `createdAt` 倒序 + `code` 升序稳定排序；`filter=joinable｜all｜playing`；`cursor` 为 `{createdAt,code}` 的 base64url，
  游标指向的房间已不可见时按同一排序取其后第一条；`encodeLobbyCursor`／`decodeLobbyCursor` 导出且非法游标 400。
- 归档（`archiveRowFor`）：离线过期时写出 `status=closed`／`finishedReason=offline-expired`／`incomplete=true` 的草稿，
  **清空 `presentation`／`presentationRemainingMs`／`deadline`／`turnPlayerId`／`turnId`**，保留 `allOfflineSince`、
  已发奖品、个人最后结果与已有状元历程，且不补发状元、不追加 `settled`。
- `preview` 返回 `pacing`／`access`；`number` 房码生成改为六位纯数字字符串（`ROOM_CODE_DIGITS` 拼接，保留前导零），
  仍保持 50 次防碰撞重试与墓碑检查。

### 2.4 HTTP 与实时层（`server/app.ts`、`server/realtime.ts`）

- 新增 `GET /api/rooms`（大厅）与 `GET /api/rooms/:code/watch`（只读旁观快照）；
  `parseLobbyQuery` 校验 `filter`／`limit`（1–50，默认 20）／`cursor`；
  `parseAction` 新增 `update-pacing`／`update-access` 的形状检查（完整校验交给共享层）。
- Socket：`auth:{role:'spectator',roomCode,viewerId}` 观众通道与成员通道分离（`room:<code>` / `room:<code>:spectators`），
  两条通道共用同一份 `room:state`；观众人数走独立 `room:audience` 事件（不改变游戏 `revision`），按同房 `viewerId` 去重，
  同一访客多标签页只算一位；未知 `role` 拒绝，成员凭证失败不会被降级成观众；观众连接不进入成员 presence，
  不参与暂停／恢复／房主转交；关闭旁观或房间关闭时先发 `room:watch-ended` 再断开观众，之后不再推快照。
- **本次在实时层额外做的小改动（两处，均属契约内要求的补全）**：
  1. 成员连接建立后立刻向**该连接**下发当前 `room:audience`（此前只有观众初连会收到，成员重连要等到下一次人数变化才知道有人在看）；
  2. 房间被清理（离线过期等）时，先向观众发 `room:watch-ended {code:'ROOM_EXPIRED'}` 再断开两个频道
     （此前是静默断开，`WatchEnded` 里的 `ROOM_EXPIRED` 分支永远不会到达前端）。

### 2.5 旧数据迁移（`server/room-migrations.ts`）

- 旧格式（无 `config`、有 `maxRounds`）：`pacing` 取默认 1 秒、`access` 迁移为仅邀请＋关闭旁观、
  `presentation=null`、`championEvents=[]` 且 `championHistoryComplete=false`、`lastRoll` 从幸存历史恢复、
  状元牌型记录标 `legacy-unknown`。
- **上一版房间**（有 `config`，但没有本轮的 `pacing`／`access`／`presentation`／`championEvents`／`lastRoll`／`championOutcome`）：
  走当前格式分支，缺失的新字段按同样的迁移默认补齐，可见性同样不放开。
- 新格式里字段存在但损坏（含 `pacing` 越界、`access` 非法、`presentation.recordId` 缺失、未知事件类型）一律按损坏报错，
  不静默兜底成旧房间。

### 2.6 README（业务与接口说明）

`README.md` 补充了：本轮规格与交付说明的链接、新共享文件与职责、
「结果展示阶段／游戏节奏／房间访问设置／个人最后结果与状元历程／数字房码／大厅与旁观」的业务规则，
以及新增与变化接口表（`GET /api/rooms`、`GET /api/rooms/:code/watch`、`update-pacing`／`update-access`、
`room:audience`、`room:watch-ended`、观众握手）。

---

## 3. 既有测试的适配（没有弱化断言）

结果展示阶段改变了「投掷后立刻轮到下一位」的旧语义，`tests/server.test.ts` 里 15 个旧用例随之失败。
适配原则：**保留原有的安全／时序断言，只把「读结果」这一步显式补上**，而不是放宽期望值。

新增的测试辅助（`readThroughPresentation`／`rollThrough`）不改动生产代码路径：把注入时钟推到
`presentation.until` 再走真实 `service.tick`，与前端实际经历一致。

| 用例 | 改动 |
| --- | --- |
| 创建返回 201… | 房码断言由「旧字符集六位」改为「六位纯数字」，并新增新房默认 `pacing`／`access` 断言 |
| 概况接口只暴露概况与配置 | 期望对象补上 `pacing`／`access`（公开概况本来就该有）；`assertNoSecrets` 保留 |
| 同回合不同 requestId 并发 | 第二个请求由 `STALE_TURN` 改为契约规定的 `RESULT_SHOWING`；仍然断言只有一条记录，并新增「`rollCount` 只加一次」 |
| 旧 turnId 配新 requestId 不能偷下一回合 | 先读完展示再验证已交给下一位；通过旧 `turnId` 重放仍然 `STALE_TURN`，记录仍为 1 条 |
| 重复请求返回已提交状态且不消耗下一次机会 | 展示期间重放同一 `requestId` 仍 200 且 `presentation` 完全一致；读完后 `rollCount` 仍为 1 |
| 关闭并重开数据库后用原 token 恢复 | 展示阶段也会被暂停／恢复：新增「恢复同一 `recordId`、剩余时长大于零、展示未结束时下一位不能掷骰」；仍断言重启不顺延超时 |
| 2 人 5 轮按轮数上限结算 | 每手都读完展示（最后一手也经展示才结算），轮数、奖品、再开一局断言不变 |
| 推进 30 秒只跳过 1 次／迟到掷骰／掷骰与 tick 交错 | 断言超时先进入展示（`until=now+停留`、`deadline=null`、保留本次上下文），重复 tick 不重复跳过，展示读完才轮到下一位且拿到完整 30 秒 |
| 无限轮数局打到 21 轮以上（A02） | 每手读完展示；`round>20`、奖池原封不动的断言不变 |
| 离线计时与过期归档（A12、A13） | 第二手前先读完展示；新增「离线恢复的是同一次展示、不重播、展示读完给足 30 秒」；归档断言加强（见第 4 节） |
| 结束归档 ×2 | 每手（含最后一手）读完展示；超时局改为按 `deadline` 推进并在每次 tick 后读完展示 |

---

## 4. 新增测试

`tests/server.test.ts`（67 → **94** 个用例）新增 5 个 `describe`：

- **房间节奏与访问设置：默认、校验与权限（A03、L02）**（6）
  省略即默认 + 显式非法 400 的回归；合法显式值且未知字段丢弃；仅离席房主可改（无凭证 401／非房主 403／非法值不落盘、`revision` 不变、无变化不算改动）；
  `finished` 房主仍可改且下一局沿用；改节奏不重置准备／库存／`expiresAt`／进行中的展示并从下一条记录生效（下一条 `until=now+750+5000`）；
  改访问不重置进度、关闭旁观立即撤销旁观入口且不影响概况链接。
- **游戏大厅（GET /api/rooms）**（5）
  默认 `filter=joinable` 且摘要字段逐项核对（含 `endCondition`、`canJoin`、`allowSpectators`、`createdAt`），不含昵称、成员列表与凭证；
  仅邀请／满房／进行中／`finished`／`closed`／过期房间的可见性；`limit=20` 默认分页 + `cursor` 翻页不重叠不遗漏且顺序稳定；
  `limit`／`filter`／`cursor` 非法一律 400；用**第二个 `RoomService` 实例（空缓存、同一数据库）**证明大厅读持久化目录而不是内存缓存，且大厅请求不改变房间状态。
- **只读旁观入口（GET /api/rooms/:code/watch）**（3）
  不需要凭证、不改变在线状态／`expiresAt`／`revision`、多次观看不续期；关闭旁观 403、不存在 404、房码非法 400、过期 410；已关闭房间 409。
- **观众连接：只读、去重计数与撤销（L04、L05、L06）**（6）
  未知 `role` 拒绝、成员凭证失败不被降级（含显式 `role:'member'` 无凭证）、观众缺 `viewerId` 拒绝、关闭旁观的房间拒绝订阅；
  同一 `viewerId` 多连接算一位访客（成员连接也能收到 `room:audience`）、人数事件不改变游戏快照与成员频道连接数、逐个断开后归零；
  **`viewerId` 不是成员凭证**（读成员状态与提交动作全部 401，跨房间同样无效，也不占席位、不把房主标成在线）；
  观众在线不阻止全员离线暂停／不延长到期时间／刷新不影响离线起点；
  房主关闭旁观时先发 `watch-ended` 再断开观众、成员连接不受影响、之后不再推任何快照；
  房间到期清理先发 `watch-ended {ROOM_EXPIRED}` 再断开并删除房间。
- **结果展示阶段的时序边界（E03、E04）**（4）
  0 秒停留保留 750ms 动画、动画结束立即交棒、超时 0 秒可在同一 tick 内完成；10 秒上限 `until=now+750+10000`、提前 tick 不推进；
  展示期间其他玩家 409 `RESULT_SHOWING` 且读完拿到新 `turnId`；公开快照与归档保留个人最后结果与完整状元历程（`['first','settled']`、`settled.awardedCount=1`、`recordId=null`）且不含凭证。
- **旧数据迁移在服务层的表现（L02 兼容）**（1）
  真实升级路径：旧行先落库 → 重启 → `onBoot` 归一化。断言仍能用原凭证进入、`pacing` 默认 1 秒、
  `access` 仅邀请＋关闭旁观、`presentation=null`、`championHistoryComplete=false`、`championEvents=[]`、
  `lastRoll` 恢复且标 `legacy-unknown`、不自动公开、不出现在大厅、`/watch` 403、概况仍可读。

`tests/db.test.ts`（17 → **18**）新增：

- `上一版房间（有 config 但缺本轮新字段）迁移为仅邀请、默认 1 秒，并恢复个人最后结果`：
  从当前格式快照中只删除本轮新增字段，验证升级路径上最常见的一种房间（上一版写入、缺 `pacing`／`access`／`presentation`／
  `championEvents`／`championHistoryComplete`／`lastRoll`／`championOutcome`）的归一化结果，
  并核对 `toPublicRoom` 输出的完整性标记与个人结果。

`tests/server.test.ts` 中另外加强了既有归档断言（离线过期）：

- 归档里 `presentation`／`deadline`／`turnPlayerId`／`turnId` 全部清空、`paused=false`、`allOfflineSince` 保留；
- `championHistoryComplete=true` 且历程为 `['first']`、**没有** `settled`（过期不结算、不补发状元）；
- 两位玩家的 `lastRoll`（`wuhong`／`yixiu`）随归档保留，`stateJson` 不含 `tokenHash`。

未采用的手段：没有新增任何生产测试接口，没有放宽权限或校验，没有用 `any` 绕过类型，没有改动 Pi 的文件。

---

## 5. 验证命令与实际结果

在 `/Users/linus/CODE/bobing`（分支 `feat/room-experience-lobby`）实际执行：

| 命令 | 结果 |
| --- | --- |
| `npm test` | **9 个测试文件、270 个用例全部通过**（改动前 242 个用例中 15 个失败） |
| `npx vitest run tests/server.test.ts` | **94 passed** |
| `npx vitest run tests/db.test.ts` | **18 passed** |
| `npm run build:server` | 退出码 0，无输出错误（`tsc -p tsconfig.server.json`） |
| `npx tsc --ignoreConfig --noEmit --target ES2023 --lib ES2023,DOM,DOM.Iterable --module NodeNext --moduleResolution NodeNext --types node --strict --noImplicitOverride --noFallthroughCasesInSwitch --noUnusedLocals --noUnusedParameters --isolatedModules --verbatimModuleSyntax --erasableSyntaxOnly --forceConsistentCasingInFileNames --skipLibCheck --resolveJsonModule shared/*.ts server/*.ts tests/*.test.ts` | **退出码 0**：本仓 `shared/**`、`server/**`、`tests/*.test.ts` 零类型错误 |
| `node --import tsx /private/tmp/bobing-review-20260927.mjs`（主代理的独立根集成脚本，未修改） | `{"result":"PASS","scenarioGroups":8,"defects":[]}` —— 8 个场景组全部通过：数字码前导零与默认公开／1 秒 + 大厅；观众去重且不能改成员状态或节奏；阅读阶段挡下投掷、改节奏只影响下一条、重放幂等；个人结果在被顶替后仍保留且实时观众看到一致快照；观众不保活／不续期、阅读暂停按剩余时长恢复；0 秒保留动画、仅邀请／关闭旁观光撤销观众而不断开成员；最后一掷展示完才结算、状元只结算一次、重启与归档保留事实；旧数据迁移保持仅邀请、保留个人最后结果、不伪造状元历程。 |
| `npm run typecheck` | **仍有 4 个错误，全部在本次不在我职责范围内的文件里，见第 6 节** |

本地监听（Vitest 里 `127.0.0.1:0` 的真实 HTTP/Socket 端口）在当前文件策略下正常，
不需要额外提权，也没有为此请求过权限升级。按分工没有运行完整前端构建与 E2E。

---

## 6. 遗留问题与需要注意的地方

1. **`npm run typecheck` 未全绿，4 个错误全部属于 Pi 负责的文件**（本次未改动，留给 Pi）：

   ```
   src/lib/format.ts(148,48): error TS2345: Argument of type 'RoomState | null' is not assignable to parameter of type 'RoomState'.
   src/lib/format.ts(291,5):  error TS2871: This expression is always nullish.
   tests/e2e/configuration.spec.ts(295,37): error TS2339: Property 'access' does not exist on type 'never'.
   tests/e2e/configuration.spec.ts(299,37): error TS2339: Property 'pacing' does not exist on type 'never'.
   ```

   诊断线索（只读观察，未修改、未用猜测下结论）：
   - `format.ts:148`：把 `room ?? null`（类型 `RoomState | null`）传给了只接受 `RoomState` 的 `playerById`，
     调用点需要先收窄或让参数接受 `null`。
   - `format.ts:291`：`matchedEvent?.previousNickname ?? … ?? '前任'` 这条 `??` 链上，
     编译器判定左侧恒为 nullish（`matchedEvent`／`outcome` 的收窄结果需要复核）；具体成因请 Pi 以该文件为准核实。
   - `configuration.spec.ts:295/299`：`capturedCreatePayload?.access` 处 TS 认为被访问对象的类型是 `never`
     （即 `capturedCreatePayload` 在该处已被收窄成 `null`），需要复核该变量的声明与赋值位置。
   本仓 `shared/**`、`server/**`、`tests/*.test.ts` 在同一套编译选项下是零错误的。

2. **`closed` 房间上的 `update-pacing`／`update-access` 分支是防御性的**：`closed` 只能由最后一位在席成员
   离开时产生，此时没有任何非离席成员能通过 `authenticate`，所以 HTTP 层永远先得到 401 而不是 409。
   契约里「`closed` 拒绝」的要求已在服务层实现，但没有端到端用例（构造不出可达状态），因此没有为它写测试，
   也没有为了让测试通过而放宽鉴权。

3. **观众相关状态是进程内的**：`room:audience` 的 `viewerCount` 与 `viewerId` 去重表保存在实时层内存里，
   与房间快照无关，因此重启进程后观众人数从 0 重新计数（观众会重新连接）。这符合「只用于计数、无任何权限」的定位，
   但多副本部署时人数不可跨实例聚合（本仓本来就只支持单实例 + 持久化卷，见 `docs/deployment.md`）。

4. **展示阶段的推进依赖 1 秒时钟**：`until` 精确到毫秒，但真正切换发生在下一次 tick 或下一次请求，
   所以「至少覆盖配置时长，实际切换可能晚不到 1 秒」是设计内的行为（设计稿 4.2 已写明）；
   本轮没有引入第二套计时源。

5. **未覆盖（按分工不由本文件负责）**：375／768／1440 与 320px 的真实浏览器验收、数字键盘与房码输入、
   大厅页与旁观页的界面状态、`docs/ui-design.md` 与截图（Pi）；
   完整前端构建与 Playwright E2E 需要与共享前端产物一起跑，本次未执行。

6. **未提交**：按要求没有 `git commit`／`push`、没有部署、没有 `git reset/clean`，
   也没有把任务再转发给其他代理。工作区里的前端改动、截图与方案文档保持原样。

---

## 7. 验收对照（本轮后端部分）

| 编号 | 后端侧证据 |
| --- | --- |
| E03 | 默认停留 1 秒（创建断言 + 游戏层用例）；0／10 秒边界；改节奏不重置任何进度、只对下一条生效；展示期间不能提前投掷；下一位拿完整 30 秒 |
| E04 | 最后一掷经展示后才结算（游戏层 + 服务层归档用例）；重启恢复同一展示、不重播、离线暂停按剩余时长恢复 |
| E05／E06 | `game.test.ts` 的当次状元事实与个人最后结果用例；服务层归档断言 `['first','settled']`、同分／较低／锁定不产生登顶事件 |
| E07 | 状元事件与 `lastRoll` 不受 240 条窗口裁剪（游戏层）；重启与归档保留（服务层 + 独立脚本） |
| L01 | 六位纯数字且保留前导零、50 次防碰撞与墓碑检查、旧字符集房码仍可访问、非法房码 400 |
| L02 | 新房默认公开可加入；仅邀请不出现在大厅但仍可访问概况；旧房间迁移为仅邀请＋关闭旁观且不自动公开；`finished`／`closed`／过期房间不在大厅 |
| L04 | 观众实时收到与成员一致的 `room:state`，不占席位、不能读成员状态或提交任何动作（`viewerId` 全程无效） |
| L05 | 全员离线时观众在线照样暂停、离线起点与到期时间不被观众刷新改变 |
| L06 | 关闭旁观先发 `watch-ended` 再断开观众、之后不再推快照；等待中可入座（沿用原 join 规则，不在后端做排队） |
| L07 | 大厅空列表、非法参数、旁观失效（403／409／410）、房间过期清理断开观众，都有明确的服务端状态与错误码 |
