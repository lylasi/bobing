# Antigravity 评审优化最终验收

日期：2026-09-27。分支：`feat/room-experience-lobby`。

用户指定 Pi 调整界面、DeepSeek Harness 修改交互业务代码。主代理设计接口与文件边界，通过 codeg 指定代理派发，完成集成审查、回派修正与最终验收。七项评审建议均已落实。

## 完成情况

| 评审项 | 最终行为 | 主要负责方 |
| --- | --- | --- |
| 手机冗余说明 | 手机隐藏骰碗底部重复说明，保留轮次、主提示与底栏反馈 | Pi |
| 长昵称辨识 | 按 Unicode 字素保留前两字与后两字，点按可看全名，Esc 关闭并回焦；当前玩家徽章不再挤掉昵称尾字 | DeepSeek 逻辑、Pi 样式 |
| 全桌与个人结果层级 | 全桌最新标签与昵称同行，个人战绩独立呈现；别人投掷后自己的上一掷继续保留 | Pi |
| 我的奖品弹窗 | 六档真实奖品明细置顶，个人上一掷随后，状元经历可折叠；Tab、Enter、Shift+Tab、Esc 均可操作 | Pi |
| 房间设置 | 精简重复说明；0–10 秒加减步进，保留直接输入、非法草稿及保存校验；按钮至少 44px，隐藏重复的原生数字箭头 | DeepSeek 逻辑、Pi 样式 |
| 大厅首屏 | 开桌与输码入口收紧，输码表单可展开；375×812 首屏完整显示两张普通房间卡片，关键元信息保留 | Pi |
| 桌面右栏 | 奖品余量与状元事件列表限高滚动，并提供键盘焦点；手机不限制内容高度 | Pi |

## 最终实测

- **375×812 普通双人局**：个人结果底边 `647.75px`，固定底栏顶边 `701px`，净空 **53.25px**；主卡底边 `654.75px`。已查看最终截图。
- **12 人长昵称、长奖品**：320 / 375 / 768 / 1440 四档宽度无页面横向溢出；压缩昵称的 `scrollWidth <= clientWidth + 1`，包括“团圆…甲乙”和当前玩家徽章组合；只有一个可见掷骰主按钮。
- **375×812 大厅**：首张卡上边约 `244px`，第二张普通卡完整位于视口内；保留席位、在线人数、房规、结束方式和加入／旁观入口。
- **设置步进**：0 不能减、10 不能加；空值、小数、负数、负零、超限、指数写法均不能保存；切换公开范围不覆盖非法草稿。取消后重开恢复已保存值，合法值真实保存成功。
- **弹窗与记录**：六档奖品先于个人上一掷；状元经历可键盘展开；最近 10 次与只看我、Esc 回焦、刷新不重播均通过。
- **真正旁观**：不显示成员操作，接收真实点数；房主关闭旁观后观众立即退出订阅。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm test` | 10 个文件，290 项通过（含新增 20 项交互用例） |
| `npm run build` | 前端与后端构建通过 |
| `git diff --check` | 通过 |
| 受影响 Playwright 用例 | **15 / 15 通过**，约 57 秒 |
| 独立 12 人与多宽度浏览器检查 | **11 组通过** |
| 独立 stepper 检查 | 通过：步进、边界、六种非法草稿、取消重开、真实保存、四档按钮尺寸 |
| 独立普通手机首屏几何检查 | 通过，最终净空 53.25px |

受影响 E2E 为 `configuration.spec.ts`、`experience.spec.ts`、`lobby.spec.ts`、`mobile.spec.ts` 和新增 `review-followup.spec.ts`。为保留前次截图，将同一批测试复制到 `/private/tmp/bobing-ui-review-e2e-20260927/tests/e2e`，唯一辅助修改是将截图目录指向临时目录，使用全新临时数据库和本机 3317 服务运行。未将测试指向真实房间。

本轮修正了验收发现的手机底栏遮挡、弹窗 summary 焦点遗漏、昵称 flex 二次截断及 stepper 字段边界溢出。旧测试对秒数输入采用模糊 label，新增加减按钮后会匹配三个元素，现已改用精确 spinbutton 定位。一次重跑因临时数据库复用出现同名测试房间，最终使用全新测试库后 15 项全部通过。

独立脚本：

- `/private/tmp/bobing-ui-followup-review-20260927.mjs`
- `/private/tmp/bobing-ui-stepper-review-20260927.mjs`
- `/private/tmp/bobing-ui-followup-budget-20260927.mjs`

## 截图

- [375px 普通对局](screenshots/70-review-standard-375.png)
- [320px 12 人局](screenshots/71-review-12players-320.png)、[375px](screenshots/72-review-12players-375.png)、[768px](screenshots/73-review-12players-768.png)、[1440px](screenshots/74-review-12players-1440.png)
- [最近 10 次](screenshots/75-review-recent10-375.png)
- [我的奖品](screenshots/76-review-my-prizes-375.png)
- [房间设置](screenshots/77-review-room-settings-375.png)
- [大厅](screenshots/78-review-lobby-375.png)

## 范围与交付状态

以修改前的源码压缩快照核对：原有源码没有文件丢失；本轮 `server/` 与 `shared/` 未变更，原有未提交内容保留。默认 1 秒、0–10 整数秒、新房公开可选邀请、六位数字码与旧码兼容、个人奖品计算、只读旁观语义均保持。

全部更改保留在当前工作区，未提交、未推送、未部署。浏览器验证使用 Chromium；未做 iOS Safari 真机验收。

实施方案见 [实施计划](superpowers/plans/2026-09-27-antigravity-review-followup.md)，代理交付见 [Pi](ui-review-pi-handoff-2026-09-27.md) 与 [DeepSeek](ui-review-deepseek-handoff-2026-09-27.md)。
