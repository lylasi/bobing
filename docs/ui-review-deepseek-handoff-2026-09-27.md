# DeepSeek 交付：交互业务逻辑（Antigravity 评审跟进 · Task 2）

**日期**：2026-09-27
**分支**：`feat/room-experience-lobby`（未提交、未推送、未部署）
**计划**：`docs/superpowers/plans/2026-09-27-antigravity-review-followup.md` § Task 2
**评审依据**：`docs/ui-review-antigravity-2026-09-27.md` 建议 2、建议 5

本轮只实现 Task 2 归属的文件，样式、页面布局与端到端用例分别由 Pi 与主代理负责。
未触碰 `src/styles.css`、`src/styles-room-settings.css`、`GameBoard.tsx`、`MyRewards.tsx`、`Lobby.tsx`、`RoomSettingsDialog.tsx`、`tests/e2e/`、`shared/`、`server/`，也未新增任何后端接口或数据契约。

## 一、实际改动文件

| 文件 | 状态 | 内容 |
| --- | --- | --- |
| `src/lib/seat-name.ts` | 新增 | `compactSeatName(nickname)`：按 Unicode 字素压缩长昵称 |
| `src/lib/result-hold.ts` | 新增 | `parseResultHoldSeconds` / `validateResultHoldSeconds` / `stepResultHoldSeconds` |
| `src/components/SeatStrip.tsx` | 修改 | 头像+昵称改为原生按钮、长昵称压缩、单一全名状态行与 Escape 关闭 |
| `src/components/RoomSettingsFields.tsx` | 修改 | 抽出解析/校验并 re-export 旧导出，新增 ±1 步进按钮与精简提示 |
| `tests/ui-interactions.test.ts` | 新增 | 20 条单元/标记契约用例（字素、数值边界、SSR 标记） |
| `docs/ui-review-deepseek-handoff-2026-09-27.md` | 新增 | 本文档 |

## 二、`src/lib/seat-name.ts`

- 实现：`compactSeatName(nickname: string): string`
  - ≤5 字素原样返回（`阿月` → `阿月`）；>5 字素返回「前 2 + `…` + 后 2」（`团圆长昵称玩家01` → `团圆…01`）。
  - 计数与切片用 `Intl.Segmenter('zh-Hans', { granularity: 'grapheme' })`：家庭 emoji（`👨‍👩‍👧‍👦`）、肤色修饰符、变体选择符、组合字符（`a`+U+0301）、非 BMP 代理对都不会被拆开。
  - Segmenter 不可用时退化为码点拆分（`Array.from`），仍不拆代理对；结果只用于呈现，**不修改原始昵称**。
  - 无 `title` 依赖、无 DOM 依赖，纯函数。

## 三、`src/components/SeatStrip.tsx`

保留：`<section class="seat-strip">`、`.seat-strip-list` 横向滚动容器与原有滚动到当前玩家的逻辑、`li`、`data-seat-player`、`seat-chip--current/--me/--offline`、`seat-chip-avatar`、`seat-chip-name`、`seat-chip-badge--*`、`seat-chip-dice-icon`、`查看席位` 入口。未引入 portal、未新增席位/回合/权限等业务状态。

新增：

- `.seat-chip-trigger`（`type="button"`）包裹 `.seat-chip-avatar` 与 `.seat-chip-name`；徽章仍在 `li` 内、按钮之外。
- 按钮 `aria-label` 恒含**完整昵称**：折叠为「{昵称}，查看完整昵称（我）（当前出手）」、展开为「…收起完整昵称…」，并附状态后缀「（我）／（当前出手）／（本次结果）／（离线）」。同时保留 `title` 作为桌面悬停补充，但全名不依赖它。
- `aria-expanded` + `aria-controls`（展开时指向全名行 id），行本身为 `.seat-full-name`（`role="status"`），内含 Pi 已定义的 `.seat-full-name-prefix`（“完整昵称”）与 `.seat-full-name-value`（完整昵称）。
- 交互：点同项收起、点别项切换（单一状态行，永远只有一个 `.seat-full-name`）；`Escape` 关闭并把焦点还给对应触发按钮。
  Escape 用 `document` 级 `keydown` 监听（与 `Dialog`/`RecentActivity` 同风格）而非只挂按钮：部分浏览器点按按钮后不聚焦，只挂按钮会导致 Escape 关不掉。
- 离席清理：状态来自 `seatedPlayers(room)`，玩家离席（或不再在座）后对应行消失，展开状态同步清空，不留悬空详情。

## 四、`src/components/RoomSettingsFields.tsx`

保留的旧契约：

- 组件 Props 完全不变（`pacing`、`onPacingChange`、`access`、`onAccessChange`、`disabled`、`onValidityChange`、`variant`）。
- `export { validateResultHoldSeconds }` 仍从本模块导出（实现移到 `src/lib/result-hold.ts`），签名与文案不变。
- `rawHoldSeconds` 草稿 + `syncedHoldSecondsRef` 同步契约不变：非法草稿（空、`1.5`、`-1`、`11` 等）原样保留，不被切换可见性或同值 pacing 覆盖，仍然通过 `onValidityChange` 阻止提交。
- 输入框 id、`aria-label="结果停留秒数"`、`type="number"`、`inputMode`、`min`/`max`/`step`、`.settings-hold-input`、`.settings-hold-unit`、`.settings-hold-input-group`、`.settings-hold-label` 全部保留；旧 number 输入的 onChange 逻辑与直接输入路径不变。

新增/变更：

- `.settings-hold-stepper` 包裹「原输入组」；左右各一个 `.settings-hold-step`（`type="button"`）按钮，可访问名严格为 **“减少结果停留秒数”** / **“增加结果停留秒数”**（视觉字形为 `−` / `+`）。
- onClick 走 `stepResultHoldSeconds(raw, ±1)`，成功才调用原 `handleHoldSecondsChange(String(next))`，因此解析、同步 ref 与 `onPacingChange` 路径与直接输入完全一致。
- 禁用规则：`disabled` 属性为真、草稿非法、或目标越界（0 减一 / 10 加一）时对应按钮禁用；不钳制、不回退默认值。`disabled` 时输入框、单选、复选框与两个步进按钮一并禁用。
- 错误关联：新增独立 `holdErrorId`，错误时不只 `role="alert"`，输入框 `aria-describedby` 同时指向提示与错误 id。
- 秒数提示精简为唯一一句：**“0–10 秒，默认 1 秒；0 秒保留动画，下次结果生效。”**（弹窗顶部文案由 Pi 的 Task 1 负责。）

## 五、测试与验证（实际结果）

```
$ npx vitest run tests/ui-interactions.test.ts
 ✓ tests/ui-interactions.test.ts (20 tests) 19ms
 Test Files  1 passed (1)
      Tests  20 passed (20)

$ npm run typecheck
> tsc -p tsconfig.json --noEmit
（无输出，0 错误；与 Pi 并行改动同时存在时仍通过）
```

`tests/ui-interactions.test.ts` 覆盖：

1. **字素边界**：`团圆长昵称玩家01/02` → `团圆…01`/`团圆…02` 且互不相同；`老李家大宝儿` → `老李…宝儿`、5 字素 `老李家大宝` 不变；家庭 emoji（`👨‍👩‍👧‍👦宝宝贝贝囍` → `👨‍👩‍👧‍👦宝…贝囍`）、肤色修饰符、`❤️` 变体选择符、组合字符 `a\u0301…f\u0301`、非 BMP `𠮷野家拉面店` → `𠮷野…面店` 均不被拆开。
2. **数值与非法草稿**：`0`/`10`/`" 3 "` 合法；``、`   `、`1.5`、`-0`、`-1`、`11`、`1e1`、`NaN`、`abc`、`5秒`、`+1`、`0x1`、`½`、`Infinity`、`1 2`、超安全整数一律 `null`。
3. **步进边界**：`step('0',-1) === null`、`step('10',1) === null`、`step('11',-1) === null`、`step('1.5',1) === null`、`step('1',1) === 2`、`step('1',-1) === 0`；草稿非法时不产生新值、不回退默认 1；0–10 全区间扫描确认无钳制且步进结果仍可被解析。
4. **DOM 契约（`react-dom/server` 静态标记，非浏览器）**：席位条保留 `li`/`data-seat-player`/徽章与滚动容器；可见名压缩为 `团圆…01`，按钮 `aria-label` 含完整昵称、`aria-expanded="false"`、折叠时不渲染 `.seat-full-name` 也不留 `aria-controls`；离席玩家不渲染；步进按钮可访问名固定、0 时只能加、10 时只能减、`disabled` 时全字段禁用、提示文案与 `aria-describedby` 正确。

## 六、未验证项与限制（交主代理）

- **浏览器交互未自测**：点按展开/切换、Escape 焦点归还、44px 触控、320/375px 几何与滚动位置由 Pi 的 `tests/e2e/review-followup.spec.ts` 与主代理统一运行；本轮未启动任何 E2E 服务（遵守“不并发启动 E2E 服务”）。
- **样式未验证**：`.seat-chip-trigger`、`.seat-full-name*`、`.settings-hold-stepper`、`.settings-hold-step` 的样式由 Pi 负责；已按 Pi 现有 CSS 的类名（含 `.seat-full-name-prefix` / `.seat-full-name-value`）对齐标记，未编辑任何 CSS。
- **文案归属**：设置弹窗顶部提示（`.room-settings-dialog-notice`）在 `RoomSettingsDialog.tsx`，属 Pi 的 Task 1；本轮的秒数提示精简只在 `RoomSettingsFields.tsx` 内。
- **行为未变**：玩法、服务端权限、奖品计算、结果展示计时、网络 DTO、默认值（默认 1 秒 / 0–10 整数）均未改动，未新增后端 API。
- 未执行 restore/reset/clean、提交、推送、部署，也未改动真实数据库。
