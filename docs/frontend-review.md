# 前端开发中初审：交付前必须核对

主代理在第二批编写期间只读检查发现以下问题。请按最终实现复核，修复真实存在的项并加入有意义的浏览器回归。

1. **临时网络错误不能删身份**。`useRoom`初次fetch失败统一setFatal，`MemberView`对所有fatal调用onInvalid，而`Room.handleInvalid`清理localStorage。模拟已有身份刷新时state请求网络中断，会永久失去原成员token、占着旧席位且无法重入。只有明确INVALID_TOKEN可清该身份；ROOM_EXPIRED/NOT_FOUND可按终态处理。network/timeout/500必须保留Membership，展示重试按钮并可在恢复网络后原身份重试。
2. **离开失败不能假装已离开**。初稿handleLeave忽略runAction布尔结果，任何失败都会clearMembership并回首页。只有服务端确认成功才能清理身份和导航。对于连接失败/超时应保留凭证、留在房间并允许重试；身份明确被撤销可视为已经离开。
3. **骰子动画必须只跟随最新权威记录**。初稿useDiceAnimation分别用myLatest与latest两个effect，共用revealedId，且依赖记录对象。完整快照每次深拷贝对象，presence更新或别人掷骰会清掉未结束的900ms计时器；随后自己旧记录可能又触发动画，900ms后覆盖别人最新骰子。应以`gameNumber + latestRecord.id`为键，用单一最新记录驱动展示，清理旧计时器，杜绝myLatest旧结果回放。投掷失败且无新记录必须退出spinning并保持上一次权威点数，不把随机装饰骰子当结果。rematch应清空revealed；timeout文字显示最新超时而非旧中奖。回归：A投完立即B投，等1秒后A/B都显示B的六个点数；期间刷新在线状态也不挂动画；失败请求不无限旋转。
4. **运行时分享配置竞态**。Room中只把PUBLIC_BASE_URL写入普通模块变量，MemberView的inviteUrl只useMemo([code])一次，配置比初次render晚返回就永久使用错误origin。把配置纳入React state/context或在每次打开邀请时等待配置，使GET /api/config延迟返回也能使用指定域名。
5. **倒计时为0时禁投**。GameBoard.canRoll初稿未检查remaining>0，也未检查spinning。需按规范禁用本地已到期的操作并显示“本轮已到时，正在同步”；服务端仍最终裁决。
6. **用户流程去掉实现说明**。分享弹层“链接不含任何个人凭证”、结算“本局已归档保存”不帮助玩家决策，改成简洁邀请/玩法说明；离开说明应明确“开局后不能重新加入本局”，不能笼统承诺换昵称即可回来。
7. **首页主视觉需要真实可见**。主代理查看首次`20-home-1440.png`和`20-home-375.png`，当时瓷碗塌缩只剩一颗重叠白块。源CSS已出现修复宽度的注释，请重新生成并亲自检查截图确认生效。Home初稿仍用`<Bowl dice={null} decorative>`，导致6颗空白骰子；首页是装饰性示例，应使用明确的[1,2,3,4,5,6]等点阵，不把空白骰子当设计完成。实际房间未掷出时才用空面。
8. **移动标题分行**。首次375截图把“满桌团圆”拆成“满桌团 / 圆。”，请用两段不拆的span让“一碗骰声，”与“满桌团圆。”自然分两行，桌面仍可并排。验收应看图片本身，不能只检查scrollWidth。

本清单不授权把规则改成客户端判奖、把网络错误隐藏、或移除重连流程。最终需保留真实服务端并至少两独立浏览器上下文验证。

## 主代理实际浏览器复现

- 2026-09-25，使用构建产物独立启动3107端口、独立浏览器context。真实创建房间并保存凭证，进入等待室后拦截`/api/rooms/*/state`为网络失败再刷新。结果`membershipRetained=false`，页面显示“网络连接失败…（已清理本机保存的房间凭证）”并回到输入昵称界面。第1条确认是实际功能缺陷，不是推测。
- 同日，真实双上下文A、B连续投掷，然后刷新第二个投手页面，等待1300ms。最新权威骰子为`[6,2,6,1,2,4]`，两页碗内可见点数却分别为`[0,0,0,0,0,0]`与A旧结果`[1,1,4,5,3,4]`。历史两条均已同步，第3条确认是显示层缺陷。

## 后续独立视觉审查

主代理亲自查看最终候选截图后，还发现手机对局中心被隐藏、记录点阵与文字重叠等问题，已单列在 [最终审查补充](final-review-addendum.md)。必须连同本清单完成验收。

## 2026-09-26 可配置房规、个人方案与骰子音效动画补充审查

主代理依据 [可配置玩法规格](superpowers/specs/2026-09-26-bobing-configurable-play.md) 对前端实现进行了审查，以下 5 项问题已全部修复并补充单元与真实浏览器回归验证：

1. **`RoomConfigForm` 非法数量草稿保留与按档位精确同步（4a & 单档同步修复）**：修复了 `useEffect([value.prizes])` 在用户清空某档数量后继续编辑奖品内容或修改另一档数量时将非法空值重置回旧合法数量的问题；通过记录 `changedKeys` 仅更新外部真正发生数值变化的档位（而恢复默认数量与载入个人方案则显式重置全部六档 `rawCounts`），用户未修正非法数量时即使收起高级区也保留草稿、展示 `role="alert"` 并禁用提交。
2. **首页默认开房表单长度收敛与等待室默认展开（UI 收尾审查）**：首页 `RoomConfigForm` 默认收起“调整奖品与个人方案”展开区（`aria-expanded="false"` + `aria-controls`，触达高度 `>= 44px`），默认状态仅展示昵称/房名/人数、系统房规、结束方式、随草稿实时更新的奖品摘要及“创建房间”按钮；等待室“修改房规与奖品”弹层传入 `defaultAdvancedOpen` 默认展开全部编辑字段。实测 375×812 下首页默认“创建房间”按钮 `Y = 1385px`（较此前 `3804px` 缩短 `2419px`）、页面总高 `2411px`（较此前 `5066px` 缩短 `2655px`）；1440×900 下“创建房间”按钮 `Y = 767px`（底边 `819px < 900px`，首屏直接可见）且左右双栏高度均衡无大块留白。
3. **`useDiceAnimation` 同次提交 HTTP 先于 WebSocket 返回时不跳过本人动画（4b）**：将新记录消费 effect 置于 `rollPending` effect 之前，并以 `latestKeyRef.current === startedFrom && appliedKeyRef.current === startedFrom` 判定“请求结束但无新记录”，通过 Playwright `routeWebSocket` 延后 `room:state` 验证本人 HTTP 响应先到时仍完整播放分阶段动画。
4. **`stageForElapsed` 逐颗停稳完整覆盖 `0..6`（4c）**：修正 `stageForElapsed` 之前跳过 `settledCount = 2` 的问题，确保 `settledCount` 从 `0, 1, 2, 3, 4, 5, 6` 逐颗递增停稳，阶段完整覆盖 `tumbling -> landing -> colliding -> settling -> idle`。
5. **`Room.tsx` 音效控制器在 React StrictMode 与卸载时的准确清理（4d）**：移除 render 阶段副作用创建，改为在 effect 与惰性 getter 中管理 `soundRef.current`，卸载或路由离开时准确调用当前控制器的 `dispose()` 关闭 `AudioContext`；未开启音效或非本人新投掷时绝不发声。
