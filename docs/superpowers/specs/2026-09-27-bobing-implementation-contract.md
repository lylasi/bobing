# 本轮实现契约与分工

用户已授权实现。日期：2026-09-27。工作分支：feat/room-experience-lobby。

本文件与已确认设计稿优先于旧计划示例。最终更改：**停留默认 1 秒、可手动设置；新房默认公开、可选仅邀请**。其余按设计稿。执行过程不需要再请求开始许可。

## 分工

- **Pi：**所有 `src/` 前端代码、`tests/e2e/`、`docs/ui-design.md` 与截图。负责所有 UI、客户端状态/网络接入、数字码输入、大厅、旁观、结果/奖品/状元、设置、动画与响应式验收。
- **DeepSeek Harness：**所有 `shared/`、`server/`、`tests/*.test.ts`，业务规格和 README 中的功能/接口说明。负责共享 DTO、规则状态机、时间配置、持久化迁移、数字码生成/验证、大厅数据、旁观权限与业务测试。
- **主代理：**本次三份方案文档与本契约、只读审查、集成验证、问题回派和最终验收记录。
- 不编辑对方所有的文件，不还原对方改动，不执行 git reset/clean，不提交或发布。两方可以读取全项目。不得通过添加生产测试接口或弱化权限来让测试通过。
- 共用工作目录 `/Users/linus/CODE/bobing`。前端按本契约构建；共享实现尚未落盘造成的临时类型错误记录清楚，不通过复制私有 DTO 或大量 any 绕过。

## 输入配置与默认值

`shared/types.ts` 新增：

```ts
export interface RoomPacing { resultHoldSeconds: number; }
export interface RoomAccess { visibility: 'invite' | 'public'; allowSpectators: boolean; }
```

- `RoomState`、`InternalRoom`、`RoomPreview` 有必填 pacing 与 access。
- `CreateRoomRequest`、内部 CreateRoomInput／CreateRoomSeed 增加可选 pacing 与 access；HTTP 创建路径传递这两项。
- 新房默认 pacing={resultHoldSeconds:1}、access={visibility:'public',allowSpectators:true}。
- 旧快照缺新字段时 pacing 默认 1 秒，access={visibility:'invite',allowSpectators:false}，presentation=null。旧数据的可见性不自动放开。
- 停留值必须是 0–10 的整数，默认 1，0 表示不额外阅读但仍保留正常投掷动画。省略配置与非法显式配置必须分开处理。
- Action 增加 `{type:'update-pacing';pacing:RoomPacing}` 和 `{type:'update-access';access:RoomAccess}`。仅未离席房主可改，waiting／playing／finished 允许，closed 拒绝；修改不重置准备、deadline、expiresAt、库存或正在执行的 presentation.until。
- pacing 从下一条记录生效；access 的旁观开关立即生效。RoomConfig 与个人奖品方案都不混入这两类房间设置。
- UI：创建页可选公开／仅邀请，默认公开；房间更多有“房间设置”，包含可见性、允许旁观、结果停留（秒），可用于局中调整。普通成员可见当前节奏但不能修改。

`shared/presentation.ts` 导出：

```ts
export const DICE_REVEAL_MS = 750;
export const DEFAULT_RESULT_HOLD_SECONDS = 1;
export const MIN_RESULT_HOLD_SECONDS = 0;
export const MAX_RESULT_HOLD_SECONDS = 10;
export function normalizeRoomPacing(value: unknown): RoomPacing;
export function presentationDurationMs(reason: RollRecord['reason'], pacing: RoomPacing): number;
```

normalizeRoomPacing 对 undefined 返回默认；非法显式对象、类型、数值抛错，服务层映射 INVALID_INPUT。presentationDurationMs(rolled)=750+seconds*1000，timeout=seconds*1000。

## 结果展示与个人记录

```ts
export interface ResultPresentation { recordId: string; until: number | null; }
```

- RoomState／InternalRoom：`presentation: ResultPresentation | null`。仅 InternalRoom 增加 `presentationRemainingMs: number | null`。
- Player／InternalPlayer：`lastRoll: RollRecord | null`，正常投掷或超时后保存对应结果，独立于 history 裁剪。
- 展示阶段 room.status 仍为 playing，保留该次 turnId／turnPlayerId 作为上下文、deadline=null；不能新的掷骰。未暂停时 until 为服务端毫秒时间；全员成员离线暂停时 until=null，内部保存剩余时长。
- `completeResultPresentation(room:InternalRoom,now:number):boolean` 在 game.ts 导出；到时清除阶段并调用原轮转，从实际开放时刻开启下一人完整 30 秒。超时 0 秒允许立即完成阶段。
- applyRoll 只负责本次权威事实与开始展示；最终一掷在展示结束后结算。相同 requestId 重试仍先命中回执；其他展示期间投掷返回 RESULT_SHOWING（409）。
- 服务端 tick、启动恢复、离席、房主结束、全员离线、归档完整适配；观众不能影响这些判断。
- 前端 presentation 非空时显示“本次结果展示中”，不能因 deadline=null 显示等待开局；个人结果卡独立保留，不由全桌最新骰面替代。
- 本人新掷骰有动画与可选声音；他人/观众直接显示真实点数。刷新、重连、重复快照不重播；迟到动画不使轮次倒退。

## 状元事实 DTO

```ts
export interface ChampionOutcome {
  kind: 'first' | 'takeover' | 'improved' | 'tied' | 'lower' | 'locked' | 'legacy-unknown';
  previousPlayerId: string | null;
  currentPlayerId: string | null;
  locked: boolean;
}
export interface ChampionEvent {
  id: string;
  recordId: string | null;
  kind: 'first' | 'takeover' | 'improved' | 'settled';
  playerId: string;
  nickname: string;
  previousPlayerId: string | null;
  previousNickname: string | null;
  round: number;
  at: number;
  dice: number[];
  result: DiceResult;
  locked: boolean;
  awardedCount: number;
}
```

- RollRecord 新增 `championOutcome: ChampionOutcome | null`；非状元 null，旧状元记录 legacy-unknown。
- RoomState／InternalRoom 新增 `championEvents: ChampionEvent[]` 和 `championHistoryComplete:boolean`。
- first、takeover、improved 才有成绩变化事件，locked 表示该变化同时触发锁定。结算实际发奖时仅一次 settled，recordId=null、awardedCount=实际份数；其他事件 awardedCount=0。
- 个人 best 非空不等于曾登顶；登顶次数只算 first／takeover。未超过、同分与锁定结果不产生虚假登顶事件。
- 事件不随 240 条 history 一起裁剪，写公共快照和归档；旧局不伪造事件，完整性=false；新局与再开局为 true。lastRoll 从旧 history 可恢复则恢复，否则 null。
- Pi 负责 format.ts 消费这些当次事实；旧历史不能用当前 champion 重新解释。普通奖显示 config.prizes[key].content 与实际 awarded；未结算状元不计入已获份数。

## 数字码、大厅与旁观

`shared/room-code.ts` 导出 `normalizeRoomCodeText(raw:string):string`（去空格/转大写）及 `isAcceptedRoomCode(code:string):boolean`；接受六位数字或旧字符集的六位码。新生成仅数字，保留前导零，保持 50 次防碰撞重试和墓碑检查。原 ROOM_CODE_LENGTH=6 不变。

```ts
export interface LobbyRoomSummary {
  code: string; name: string; status: 'waiting' | 'playing';
  playerCount: number; onlinePlayerCount: number; maxPlayers: number;
  rulesetName: string; endCondition: EndCondition;
  canJoin: boolean; allowSpectators: boolean; createdAt: number;
}
export interface LobbyQuery { filter:'joinable'|'all'|'playing'; limit:number; cursor:string|null; }
export interface LobbyPage { rooms:LobbyRoomSummary[]; nextCursor:string|null; }
export interface AudienceState { roomCode:string; viewerCount:number; }
export interface WatchEnded { code:'SPECTATING_DISABLED'|'ROOM_EXPIRED'|'INVALID_STATE'; message:string; }
export type RoomViewer = {role:'player';playerId:string}|{role:'spectator'};
export const SOCKET_EVENT_AUDIENCE = 'room:audience';
export const SOCKET_EVENT_WATCH_ENDED = 'room:watch-ended';
```

- GET `/api/rooms?filter=joinable&limit=20&cursor=...` -> LobbyPage，默认 filter=joinable、limit=20、cursor=null；limit 1–50。仅公开未过期 waiting/playing，joinable 还要求 waiting 未满。createdAt 倒序/code 升序，cursor 为 `{createdAt,code}` base64url。遍历持久化目录，不能只读 cache。无结果返回空列表。
- GET `/api/rooms/:code/watch` -> `{room:RoomState}`。允许旁观且房间有效非 closed 才返回；不需要成员 token、不标记玩家在线、不续期。禁用返回 SPECTATING_DISABLED（403）。原成员 /state 与 /actions 保持 token 鉴权。
- 加入仍用 POST `/api/rooms/:code/join`，只有 waiting、有座、昵称不重名才成功。旁观者开局后等下一局，成功加入时由 UI 从 spectator 切到原 MemberView。
- 原 Socket `{roomCode,token}` 保持成员语义。新增 `{role:'spectator',roomCode,viewerId}`，viewerId 为仅用于计数的 UUID。未知 role 拒绝；错误成员凭证不能自动变旁观。
- 成员频道 `room:<code>`，观众频道 `room:<code>:spectators`。两者同用 room:state 游戏快照；独立 room:audience 人数事件不增加游戏 revision。观众断连不调用 closeConnection；不进入成员 presence。
- 旁观计数按同房 viewerId 合并多个 socket；初连发当前 AudienceState。关闭旁观先发 watch-ended 再断开观众，之后不再推快照。房间清理断开两频道。
- 大厅路径 `/lobby`；旁观 `/room/:code/watch`；原房间链接不变。已有有效成员凭证优先恢复成员身份。旁观不显示我的奖品/准备/掷骰/结束/成员离席。

## 验证和交付

- DeepSeek 负责新增及适配共享/服务单元与集成测试，重点默认公开、可配置 1 秒、权限、暂停、迁移、事件、幂等与结算。
- Pi 负责浏览器流程与 375/768/1440 截图，补 320px、12 人、长奖品、手机键盘、本人结果不覆盖、1 条/10 条抽屉、大厅加入和真正观众。
- 新组件首次编写时采用 region 等可访问名称，测试限定完整记录区域，避免多个展示副本被重复计数。
- 回报修改文件、验证命令及实际结果、遗留问题。出现契约无法实现的原因时写到 `docs/backend-handoff-2026-09-27.md` 或 `docs/ui-handoff-2026-09-27.md` 并明确提出，不静默改名。
- 只用用户指定 codeg delegate_to_agent 通道；两位代理不自行把任务交给其他代理。主代理收集结果后做最终集成验收。
