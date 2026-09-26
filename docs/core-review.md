# 核心初审记录（主代理）

2026-09-25，在第一批代码编写中进行只读检查。以下是需在前端集成前确认并修复的具体问题，后续代码可能已变化，按最终实现复核。

## 已通过的独立检查

- 用独立于测试文件的枚举脚本调用shared/rules.ts：13类结果的准确组合数全部与acceptance-matrix一致。
- 公共快照通过白名单构造，没有直接展开内部玩家tokenHash。
- 生产骰子使用crypto.randomInt，客户端dice字段未进入随机结果。

## 需要处理

1. **投掷必须复核deadline和paused**：初稿handleRoll仅检查playing、当前玩家和turnId，未检查`paused`、`deadline===null`、`now>=deadline`。这样在全员掉线时用HTTP仍可投掷，或者在到期与1秒tick之间迟到投掷。应先处理已到期回合（只推进一次并提交），再返回STALE_TURN；暂停/离线拒绝操作。幂等回执重试仍应先返回既有成功状态。添加“过期但tick尚未执行”和“全员离线暂停后HTTP roll”的回归。
2. **SQLite失败后的内存回滚**：初稿commit只恢复revision，room/game/pool/history已在缓存对象中改变。如果saveRoom/saveReceipt失败，数据库回滚，但下一次state会看到未提交结果。应恢复整个内存状态或驱逐后从数据库加载，创建失败不得留下虚假房间。用注入的数据库写失败回归验证奖池、history、turnId、revision和receipt均一致；失败时不可广播。
3. **离线转交必须有在线候选**：初稿tick直接调用含离线兜底的transferHost，可能在全员离线且当前房主不是最早seat时，把房主交给离线成员。主动leave可有离线兜底；60秒自动转交只允许在线候选。添加“房主为后入座者、所有人离线”的测试。
4. **过期错误与清理语义一致**：初稿tick删除过期rooms之后，原房码preview变成404而非约定410。请提供轻量、可清理的过期标记或明确可验证的保留策略，让已知过期房间显示过期提示；清理不得遗留回执、完整游戏数据或连接引用。

## 前端接入时顺带落实

- 当前npm run dev只启动后端；最终需要一个命令同时提供5173页面与3001后端。
- package中的React/runtime socket客户端当前列为devDependencies；最终根据部署打包方式整理，保证生产安装流程完整可复现。
- PUBLIC_BASE_URL需要真正接到前端分享URL逻辑，不能只在.env中声明。
- 用户流程不能展示rankKey、requestId、数据库等内部术语；内部校验报错可在前端映射为可读中文。
