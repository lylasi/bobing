# 博饼可配置房规业务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **用户指定的执行方式优先：**业务由 codeg-mcp delegate_to_agent 的 deepseek 执行，UI 由 pi 执行；不得按通用技能头改派其他代理。整体需求确认前只评审本计划。当前目录没有 Git 仓库，不初始化仓库、不执行 git commit。

**Goal:** 实现默认奖品发完结束、两种状元策略、可配置奖池以及离线过期归档，并为 Pi 提供稳定契约。

**Architecture:** 判奖基础函数继续采用 V1；规则注册表决定状元策略，房间保存配置和系统规则快照。服务端独占随机数、发奖、收尾和过期判断；SQLite 将可继续的房间与需要保留的归档分开。

**Tech Stack:** Node.js >=24.0.0、TypeScript、Express、Socket.IO、node:sqlite、Vitest。

**Spec:** ../specs/2026-09-26-bobing-configurable-play.md（包含最终产品选择、A01–A20 验收及共享类型）。

## Global Constraints

- 默认采用“持续顶状元＋奖品发完结束”，不设轮数上限，正常结束必须包含状元奖。
- 六档数量至少 1，默认 1／2／4／8／16／32；唯一状元获得该档全部份数。
- 五红、六黑、遍地锦、六红或插金花首次出现即触发高阶锁定；后续更大牌型不能顶替。
- 同分先到先得；不兼得、不追回普通奖；完成当前整轮后结算。
- 系统方案只由开发者维护；个人方案不携带可编辑的判奖逻辑。
- 服务端是随机数、轮次、权限、奖池、判奖、结算的唯一权威。
- 全员离线起 24 小时可恢复；归档不得被房间清理删除。
- 不修改用户运行中的数据来做测试；持久化测试使用临时 SQLite 文件。
- 不增加测试专用 HTTP 掷骰入口，不给客户端选择骰子点数的能力。

---

## 文件与交付边界

| 路径 | 责任 |
| --- | --- |
| shared/types.ts | 共享配置、快照、动作、累计统计、锁定及过期字段 |
| shared/room-config.ts（新） | 默认配置、严格配置校验、初始奖池生成 |
| shared/rulesets.ts（新） | 两种开发者维护的系统规则、版本化快照、锁定判断 |
| shared/rules.ts | 保留基础判奖，整理默认常量与通用说明 |
| server/game.ts | 收尾、状元争夺、锁定、发全部状元份数、累计计数 |
| server/room-migrations.ts（新） | 从旧存储快照补齐新字段，保留旧固定轮数 |
| server/room-service.ts、server/app.ts | 创建与改配置、权限、公开快照、presence、过期事务 |
| server/db.ts | 可空到期时间迁移、独立归档及过期清理 |
| tests/room-config.test.ts（新）、tests/rules.test.ts | 配置和预设行为 |
| tests/game.test.ts、tests/server.test.ts | 状态机、权限、真实 HTTP/Socket、恢复与归档 |
| tests/db.test.ts（新） | 数据迁移、空到期时间、归档保留 |

DeepSeek 不改 src 或 tests/e2e；Pi 不改 shared、server 或业务测试。发现另一侧必须修改的问题，向主代理报告具体接口和复现步骤，由主代理交回负责人。两个计划使用同一份 Spec 第 10 节，禁止分别采用 presetId／endPolicy 等别名。

## Task 1: 共享契约和配置注册表（先交付给 Pi）

**Files:** 修改 shared/types.ts、shared/rules.ts；新增 shared/room-config.ts、shared/rulesets.ts、tests/room-config.test.ts。

**Interfaces:** 按 Spec 第 10 节落实 RoomConfig、EndCondition、RulesetSnapshot、createDefaultRoomConfig、normalizeRoomConfig、poolFromConfig、snapshotRuleset、shouldLockChampion。保留 PrizeKey、DiceResult 与基础规则分类。

- [ ] **Step 1: 添加配置与策略测试。**

在 tests/room-config.test.ts 使用以下实际行为断言：

~~~ts
import { describe, expect, it } from 'vitest';
import { evaluateDice } from '../shared/rules.js';
import { createDefaultRoomConfig, normalizeRoomConfig, poolFromConfig } from '../shared/room-config.js';
import { shouldLockChampion, snapshotRuleset } from '../shared/rulesets.js';

describe('可配置房规', () => {
  it('默认不限轮数且配置对象彼此独立', () => {
    const a = createDefaultRoomConfig();
    const b = createDefaultRoomConfig();
    expect(a.rulesetId).toBe('continuous');
    expect(a.endCondition).toEqual({ mode: 'all-prizes' });
    expect(poolFromConfig(a)).toEqual({
      zhuangyuan: 1, duitang: 2, sanhong: 4, sijin: 8, erju: 16, yixiu: 32,
    });
    a.prizes.yixiu.count = 7;
    expect(b.prizes.yixiu.count).toBe(32);
  });
  it.each([0, -1, 1.5, NaN, Infinity])('拒绝非法份数 %s', count => {
    const config = createDefaultRoomConfig();
    config.prizes.yixiu.count = count;
    expect(() => normalizeRoomConfig(config)).toThrow();
  });
  it('拒绝未知系统方案', () => {
    expect(() => normalizeRoomConfig({
      ...createDefaultRoomConfig(), rulesetId: 'custom-script',
    })).toThrow();
  });
  it('五红在锁定版锁定，在持续版继续争夺', () => {
    const result = evaluateDice([4, 4, 4, 4, 4, 6]);
    expect(shouldLockChampion(snapshotRuleset('high-tier-lock'), result)).toBe(true);
    expect(shouldLockChampion(snapshotRuleset('continuous'), result)).toBe(false);
  });
});
~~~

基础判奖函数已核对为 shared/rules.ts 的 evaluateDice，直接复用。

- [ ] **Step 2: 运行新测试确认缺失的配置能力。**

Run: npm test -- tests/room-config.test.ts。Expected: 新模块尚未实现导致失败；不得把现有 V1 判奖行为改成预期外的新规则。

- [ ] **Step 3: 实现契约与注册表。**

系统注册表中的策略数据为：

~~~ts
export const RULESETS: Readonly<Record<RulesetId, RulesetSnapshot>> = {
  continuous: {
    id: 'continuous', version: 1, name: '持续顶状元',
    diceRulesVersion: 'unified-v1', championPolicy: 'competitive', lockCodes: [],
  },
  'high-tier-lock': {
    id: 'high-tier-lock', version: 1, name: '高阶锁定',
    diceRulesVersion: 'unified-v1', championPolicy: 'lock-high-tier',
    lockCodes: ['wuhong', 'liuhe', 'biandijin', 'liuhong', 'chajinhua'],
  },
};
export function snapshotRuleset(id: RulesetId): RulesetSnapshot {
  return structuredClone(RULESETS[id]);
}
export function shouldLockChampion(ruleset: RulesetSnapshot, result: DiceResult): boolean {
  return ruleset.championPolicy === 'lock-high-tier' && ruleset.lockCodes.includes(result.code);
}
~~~

normalizeRoomConfig 必须先验证输入是非数组对象、规则 ID 在注册表中、结束方式是判别联合、rounds 模式只有 5／10／20、六档齐全、份数为正安全整数、content 为字符串。只返回允许字段的深拷贝，content 去首尾空格，合计必须是安全整数。不得信任请求传入的规则快照、锁定列表或比较键。poolFromConfig 只读取本局 prizes 的 count。DEFAULT 数量保留单一数据来源，避免 PRIZE_META 和 INITIAL_POOL 分别漂移。

- [ ] **Step 4: 补齐锁定牌型与输入边界。**

用六红 [4,4,4,4,4,4]、遍地锦 [1,1,1,1,1,1]、六黑 [2,2,2,2,2,2]、插金花 [4,4,4,4,1,1] 验证可锁；四红 [4,4,4,4,2,6] 与五子 [2,2,2,2,2,4] 不锁。验证缺档、字符串份数、非字符串内容和超出安全整数的合计均拒绝。保留既有穷举判奖测试。

- [ ] **Step 5: 验证并交付契约。**

Run: npm test -- tests/room-config.test.ts tests/rules.test.ts。通过后向主代理列出实际导出名、DTO 字段和任何与 Spec 的差异；主代理确认后，Pi 可以开始其计划。此阶段整体 typecheck 可能仍受尚未迁移的旧调用点影响，不宣称整项目已通过。

## Task 2: 新建、等待室配置与旧数据恢复

**Files:** server/game.ts、server/room-service.ts、server/app.ts、server/room-migrations.ts（新）、tests/server.test.ts、tests/game.test.ts。

**Interfaces:** 创建入口接受 config；旧 maxRounds 请求适配为 rounds 模式；Action 增加 update-config；RoomPreview 和 toPublicRoom 输出 Spec 第 10 节字段。normalizeStoredRoom(value: unknown): InternalRoom 负责旧快照恢复。

- [ ] **Step 1: 用真实 HTTP 验证新配置能到达房间快照。**

在 tests/server.test.ts 现有 startServer 工具作用域内添加：

~~~ts
it('新建无限轮数房间公开真实奖品配置', async () => {
  const env = await startServer();
  const config = createDefaultRoomConfig();
  config.prizes.yixiu = { count: 7, content: '月饼一盒' };
  const created = await env.api('POST', '/api/rooms', {
    body: { nickname: '房主', name: '自选奖品局', maxPlayers: 4, config },
  });
  expect(created.status).toBe(201);
  expect(created.body.room.config).toEqual(config);
  expect(created.body.room.initialPool.yixiu).toBe(7);
  expect(created.body.room.pool.yixiu).toBe(7);
  expect(created.body.room.ruleset.name).toBe('持续顶状元');
  expect(JSON.stringify(created.body.room)).not.toContain('tokenHash');
});
~~~

- [ ] **Step 2: 运行失败用例，再实现创建与更新入口。**

Run: npm test -- tests/server.test.ts -t '新建无限轮数房间'。

服务层按以下顺序处理配置：

~~~ts
// raw 为已校验为对象的创建请求；此段位于现有 create 方法内。
if (raw.config !== undefined && raw.maxRounds !== undefined) {
  throw new ServiceError('INVALID_INPUT');
}
const config = raw.config !== undefined
  ? normalizeRoomConfig(raw.config)
  : raw.maxRounds !== undefined
    ? normalizeRoomConfig({
        ...createDefaultRoomConfig(),
        endCondition: { mode: 'rounds', maxRounds: raw.maxRounds },
      })
    : createDefaultRoomConfig();
~~~

将配置验证异常映射到 INVALID_INPUT。createInternalRoom 接收 config，生成独立的 ruleset、initialPool 和 pool。update-config 在认证后的现有同步事务中验证房主、waiting 状态和完整配置；配置实际变化才替换配置及满额库存、清除其他在席玩家 ready，房主 ready 保持原值。修改失败不落盘、不广播。开局、更新、投掷不能在同一事务中 await。

- [ ] **Step 3: 实现旧快照归一化，不修改历史选择。**

normalizeStoredRoom 仅对未升级快照采用原 maxRounds、默认六档数量、空 content、continuous 规则。旧 champion 增加 locked=false、lockedBy=null；旧玩家次数按仍完整的旧局记录重建；新增 closingRound、allOfflineSince、incomplete 有明确初值。迁移后的配置在 loadRoom 返回前验证；新配置缺字段不能套用“旧数据默认值”掩盖损坏。初始奖池来自配置，不能拿剩余库存当初始数量。

旧房间的配置转换使用原值，不使用新默认的无限模式：

~~~ts
const legacyConfig = normalizeRoomConfig({
  ...createDefaultRoomConfig(),
  endCondition: { mode: 'rounds', maxRounds: legacy.maxRounds },
});
// legacy 是 normalizeStoredRoom 内已验证为旧房间结构的输入。
// 新快照已有 config 时走新结构校验，不执行上述旧数据分支。
~~~

- [ ] **Step 4: 加入权限、原子性与兼容性测试。**

继续使用 tests/server.test.ts 已有 startServer、connectSocket 和状态等待工具。两人入席且准备后：房主 update-config 成功，另一人的 ready=false；非房主请求为 HOST_ONLY；开局后请求为 INVALID_STATE；六档任一非法值为 INVALID_INPUT 且 revision、库存与 ready 均未改变。另验证旧 maxRounds=5 请求仍得到 rounds 模式、邀请概况包含新配置、快照不泄漏 token 或 tokenHash。

- [ ] **Step 5: 聚焦验证。**

Run: npm test -- tests/server.test.ts tests/room-config.test.ts。记录新增断言覆盖 A01、A08–A11、A20。全套业务状态机迁移在下一任务完成。

## Task 3: 无限轮数、争夺、锁定与累计统计

**Files:** server/game.ts、server/room-service.ts、tests/game.test.ts。

**Interfaces:** 沿用 startGame、applyRoll、skipExpiredTurn、finishGame、prepareRematch；InternalRoom 持有 RoomState 的新配置和字段，Player 独立存储 rollCount／timeoutCount。

- [ ] **Step 1: 扩展现有 makeRoom 测试夹具，添加配置场景。**

现有 makeRoom 增加可选 config 参数。没有提供 config 时，把 overrides.maxRounds 或原默认 5 转成 rounds 配置，再把 config 传给 createInternalRoom，不再传旧顶层 maxRounds；手工加入的 InternalPlayer 初始化两个累计次数为 0。以下 helper 放在同一 tests/game.test.ts 中，其他测试继续复用原 makeRoom：

~~~ts
function configuredRoom(playerCount: number, config = createDefaultRoomConfig()): InternalRoom {
  const room = makeRoom(playerCount);
  room.config = structuredClone(config);
  room.ruleset = snapshotRuleset(config.rulesetId);
  room.initialPool = poolFromConfig(config);
  return room;
}

it('普通奖空缺状元时继续，产生状元后收完当轮并发全部状元份数', () => {
  const config = createDefaultRoomConfig();
  config.prizes.zhuangyuan.count = 3;
  const room = configuredRoom(3, config);
  startGame(room, T0, 0);
  for (const key of ['duitang', 'sanhong', 'sijin', 'erju', 'yixiu'] as const) room.pool[key] = 0;
  for (let i = 0; i < 3; i++) applyRoll(room, currentPlayerId(room), NONE, T0 + i);
  expect(room.status).toBe('playing');
  expect(room.champion).toBeNull();
  applyRoll(room, 'p0', SIHONG, T0 + 3);
  expect(room.closingRound).toBe(2);
  applyRoll(room, 'p1', NONE, T0 + 4);
  expect(room.status).toBe('playing');
  applyRoll(room, 'p2', WUHONG, T0 + 5);
  expect(room.status).toBe('finished');
  expect(player(room, 'p2').awards.zhuangyuan).toBe(3);
  expect(room.pool.zhuangyuan).toBe(0);
  finishGame(room, 'pool-empty', T0 + 6);
  expect(player(room, 'p2').awards.zhuangyuan).toBe(3);
});
~~~

- [ ] **Step 2: 增加锁定和长局测试并观察失败。**

~~~ts
it('五红锁定后插金花不能换人，普通奖未空仍继续', () => {
  const config = createDefaultRoomConfig();
  config.rulesetId = 'high-tier-lock';
  const room = configuredRoom(2, config);
  startGame(room, T0, 0);
  applyRoll(room, 'p0', WUHONG, T0);
  applyRoll(room, 'p1', CHAJINHUA, T0 + 1);
  expect(room.champion?.playerId).toBe('p0');
  expect(room.champion?.locked).toBe(true);
  expect(room.champion?.lockedBy).toBe('wuhong');
  expect(room.status).toBe('playing');
});
it('超过记录窗口和旧轮数上限仍保存累计次数', () => {
  const room = configuredRoom(2);
  startGame(room, T0, 0);
  for (let i = 0; i < 300; i++) applyRoll(room, currentPlayerId(room), NONE, T0 + i);
  expect(room.status).toBe('playing');
  expect(room.history).toHaveLength(240);
  expect(room.players.reduce((sum, p) => sum + p.rollCount, 0)).toBe(300);
});
~~~

Run: npm test -- tests/game.test.ts。原先断言“少于两人自动结束”的用例应改为“仅剩一人继续”，保留零在席关闭场景。

- [ ] **Step 3: 修改状态机核心。**

每次真实投掷：更新个人 best 与 rollCount；只在 champion 未锁且成绩严格更好时更新领先者，然后根据房间 ruleset 判断是否锁定。普通奖每次最多扣一份。每次投掷完成所有发奖与状元更新之后统一检查：

~~~ts
const readyToClose = NORMAL_PRIZE_KEYS.every(key => room.pool[key] === 0)
  && room.champion !== null;
if (readyToClose && room.closingRound === null) room.closingRound = room.round;
~~~

轮指针跨过本轮末端时才执行收尾；如果 readyToClose 为真，按 pool-empty 结算，否则只有 rounds 模式达到其 maxRounds 才结束。不得因为状元库存仍大于零而阻止结算。finishGame 保留幂等守卫，将剩余状元份数一次性发给唯一得主并置零；找不到候选玩家属于状态损坏，不能先扣库存再悄悄丢奖。

skipExpiredTurn 只增加 timeoutCount，不发奖。startGame 和 prepareRematch 从 config.prizes 重建初始奖池及剩余库存，清零个人统计、锁定、收尾、历史和 incomplete。服务层和游戏层所有“少于两人”自动结束分支统一调整，开局的至少两人要求保持。incomplete 只标记中止、全部离席或离线过期；固定轮数正常到期显示剩余库存，不冒称未完成。

- [ ] **Step 4: 验证剩余状态转换。**

用明确骰子增加：四红→五子→五红锁定；持续版五红被插金花顶替；同分不替换；状元得主离席保留资格；当轮最后一人出现状元即完成收尾；房主中止可结算已有候选但普通奖保持剩余；固定 5 轮无状元时按上限结束；再开局沿用配置且不保留 locked／closingRound／统计。

- [ ] **Step 5: 验证业务层。**

Run: npm test -- tests/game.test.ts tests/rules.test.ts tests/room-config.test.ts。覆盖 A02–A07、A14–A16、A19–A20；不得用概率等待稀有牌型替代确定性测试。

## Task 4: 离线期限、SQLite 迁移与未完成归档

**Files:** server/db.ts、server/room-service.ts、server/room-migrations.ts、tests/db.test.ts（新）、tests/server.test.ts。

**Interfaces:** RoomRow.expiresAt 改为 number|null；AppDatabase 增加 saveArchive(row: ArchiveRow): void、listArchives(code: string, roomCreatedAt: number): ArchiveRow[]。ArchiveRow 包含 code、roomCreatedAt、gameNumber、stateJson、archivedAt、reason、incomplete，stateJson 只保存公共快照。

- [ ] **Step 1: 添加不依赖真实等待的数据库回归。**

~~~ts
import { expect, it } from 'vitest';
import { AppDatabase } from '../server/db.js';

it('活跃房间无到期时间，删除房间不删除独立归档', () => {
  const db = new AppDatabase(':memory:');
  db.saveRoom({ code: 'ABCDEF', stateJson: '{}', expiresAt: null, revision: 1 });
  expect(db.listRoomCodes(100)).toContain('ABCDEF');
  expect(db.listExpiredCodes(100)).not.toContain('ABCDEF');
  db.saveArchive({
    code: 'ABCDEF', roomCreatedAt: 1, gameNumber: 1, stateJson: '{"awards":{"yixiu":2}}',
    archivedAt: 100, reason: 'offline-expired', incomplete: true,
  });
  db.deleteRoom('ABCDEF');
  expect(db.listArchives('ABCDEF', 1)[0]?.incomplete).toBe(true);
  expect(db.listArchives('ABCDEF', 1)[0]?.stateJson).toContain('"yixiu":2');
  db.close();
});
~~~

Run: npm test -- tests/db.test.ts。先验证旧 schema 拒绝 NULL 或没有归档能力，再实现。

- [ ] **Step 2: 迁移到期字段并新增独立归档。**

现有 rooms.expires_at 为 NOT NULL，需要版本化事务迁移，不可只修改 CREATE TABLE IF NOT EXISTS。检查 PRAGMA table_info(rooms)，必要时重建 rooms 表、拷贝全部旧行、重建索引；在首次准备查询语句前完成。新的加载和清理 SQL 为：

~~~sql
SELECT code FROM rooms
WHERE expires_at IS NULL OR expires_at > ? ORDER BY code;

SELECT code FROM rooms
WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY code;

CREATE TABLE IF NOT EXISTS room_archives (
  room_code TEXT NOT NULL,
  room_created_at INTEGER NOT NULL,
  game_number INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  incomplete INTEGER NOT NULL,
  PRIMARY KEY (room_code, room_created_at, game_number)
);
~~~

归档主键包含创建时间，避免墓碑清理后旧房码复用覆盖旧记录。现有 db.deleteRoom 会手动删除 completed_games；先将旧 completed_games 的快照迁入独立归档，之后正常完成、中止、零人关闭和离线过期都写入同一归档机制。删除临时房间与 receipts 不得删除 room_archives。不新增公开历史查询接口。

- [ ] **Step 3: 把 presence 转换与过期处理放进事务。**

playing 且至少一位在席成员在线时 allOfflineSince=null、expiresAt=null。首次从有人在线转为全员离线时：

~~~ts
pauseRoom(room, now);
if (room.allOfflineSince === null) room.allOfflineSince = now;
room.expiresAt = room.allOfflineSince + this.roomTtlMs;
~~~

同一次离线期间的 tick、重复 disconnect、重启不得重置起点。第一位重连时取消期限并调用 resumeRoom 恢复剩余时间。服务启动恢复时保留已有离线起点；旧活跃快照缺起点时只初始化并持久化一次。正常完成、等待和关闭状态的期限从转换时起计算 24 小时。

purgeExpiredRoom 必须先在一个事务中生成未完成公共快照、保存归档、删除临时记录、写过期墓碑；事务成功后才移除进程缓存、presence 和通知客户端。离线过期不能调用会补发状元的普通 finishGame 路径。

- [ ] **Step 4: 覆盖计时和迁移行为。**

使用 tests/server.test.ts 的 ClockBox、startServer、connectSocket 与 instance.service.tick 可注入时钟能力，检验：活跃超过创建后 24 小时；离线 23 小时回来；再次离线新起点；离线中重启不顺延；到期 410 且 archive 有原已发记录和 incomplete=true；空期限房间能被 onBoot 载入；多连接只在最后一个断开才进入全员离线状态。

另用临时 SQLite 文件建立原 NOT NULL schema 和旧固定轮数快照，重开 AppDatabase 后验证行、回执和原轮数未丢失，二次迁移幂等；旧 completed_games 在房间清理后仍可从新归档读取。

- [ ] **Step 5: 聚焦验证。**

Run: npm test -- tests/db.test.ts tests/server.test.ts。通过后 Run: npm run build:server。对应 A12–A14、A20。

## Task 5: 业务交付与集成复核

**Files:** README.md、docs/product-spec.md、docs/rules-research.md、docs/acceptance-matrix.md、docs/deployment.md、docs/verification.md；业务变更涉及的 shared／server／tests 文件。

**Interfaces:** 向 Pi 和主代理交付符合 Spec 第 10 节的真实字段；业务文档描述两种系统方案、两种结束方式与明确的迁移行为。

- [ ] 搜索旧前提，修正本次变更相关的文档：固定 10 轮默认、总奖池固定 63、状元只发 1、少于两人结束、创建后固定 24 小时、历史只有 240 次机会。
- [ ] 运行 npm test 和 npm run build:server，提供实际结果；不要把旧文档的测试数量当成本次结果。
- [ ] 与 Pi 完成字段衔接后，由主代理运行 npm run typecheck、npm test、npm run build 和 npm run test:e2e；仅因新失败或新增修改才扩大或重复测试。
- [ ] 逐项核对 Spec 的 A01–A20：业务负责编号 A01–A16、A19–A20，A17–A18 与 UI 计划共同覆盖。
- [ ] 交付实际修改文件、测试结果和仍存在的限制；所有“已完成”以检查通过为准，不部署或发布未验收状态。
