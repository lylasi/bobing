/**
 * 局内体验与交互回归（E01–E10）：
 * 1. 本人上一掷在他人最早合法投掷后持续保留、奖品明细独立可读（E01/E02）；
 * 2. 常驻席位条（SeatStrip）展示人数、席位容量、在线状态与当前玩家骰子标识；
 * 3. 开局后紧凑顶部栏收纳次操作至“更多”面板，支持 Esc 键收起；
 * 4. 最近记录抽屉（RecentActivity）：焦点捕获、Esc 恢复、唯一掷骰主操作与“只看我”自然文案；
 * 5. 房主在局中调整游戏节奏（结果停留秒数），两端实时生效。
 */

import { expect, test } from '@playwright/test';
import {
  createRoom,
  isRollEnabled,
  joinByInvite,
  openMoreMenuIfNeeded,
  readInviteUrl,
  startGame,
  toggleReady,
  watchConsole,
} from './helpers.js';

test.describe('局内体验与交互', () => {
  test('本人上一掷在他人最早合法投掷后持续保留、奖品明细独立可读（E01）', async ({ browser }) => {
    test.setTimeout(240_000);
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const hostConsole = watchConsole(host);
    const guestConsole = watchConsole(guest);

    try {
      await createRoom(host, { nickname: '阿月', roomName: '体验验证局', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      // 确定第一位投手与第二位投手
      const first = (await isRollEnabled(host)) ? host : guest;
      const second = first === host ? guest : host;
      const firstIsHost = first === host;

      // 第一手投掷
      await first.getByRole('button', { name: '掷出好运' }).first().click();
      await expect(first.locator('.record-list .record, .history-panel .record')).toHaveCount(1, { timeout: 30_000 });
      await expect(second.locator('.record-list .record, .history-panel .record')).toHaveCount(1, { timeout: 30_000 });

      // 第一位投手的桌面端面板（.my-rewards-panel）展示“我的上一掷”和六档奖品明细
      const firstPanel = first.locator('.my-rewards-panel');
      await expect(firstPanel).toBeVisible();
      const firstLastRollCard = firstPanel.locator('.my-last-roll-card');
      await expect(firstLastRollCard).toBeVisible();
      const firstLastRollHeadline = await firstLastRollCard.locator('.my-last-roll-headline').innerText();
      expect(firstLastRollHeadline).toBeTruthy();
      const firstLastRollText = await firstLastRollCard.innerText();
      expect(firstLastRollText).toBeTruthy();

      // 验证六档奖品明细完整可见
      const firstPrizesBreakdown = firstPanel.locator('.my-prizes-breakdown');
      await expect(firstPrizesBreakdown).toBeVisible();
      await expect(firstPanel.locator('.my-prize-row')).toHaveCount(6);
      const firstPrizesText = await firstPrizesBreakdown.innerText();

      // 在服务端结果展示阶段（默认 1 秒 + 750ms 动画），第二位投手不能提前投掷
      // 随后第二位投手在允许的最早时刻投掷
      await expect(second.getByRole('button', { name: '掷出好运' }).first()).toBeEnabled({ timeout: 20_000 });
      await second.getByRole('button', { name: '掷出好运' }).first().click();
      await expect(first.locator('.record-list .record, .history-panel .record')).toHaveCount(2, { timeout: 30_000 });
      await expect(second.locator('.record-list .record, .history-panel .record')).toHaveCount(2, { timeout: 30_000 });

      // 全桌“本次结果”已更新为第二位投手的记录
      const secondName = firstIsHost ? '小满' : '阿月';
      await expect(first.locator('.game-result')).toContainText(secondName);

      // 关键断言（E01）：第一位投手的桌面“我的上一掷”依然完好保留，没有被第二位投手的记录覆盖或清空
      const firstLastRollAfterSecond = await firstPanel.locator('.my-last-roll-card').innerText();
      expect(firstLastRollAfterSecond).toBe(firstLastRollText);
      // 桌面六档奖品明细同样完整保留
      expect(await firstPanel.locator('.my-prizes-breakdown').innerText()).toBe(firstPrizesText);

      // 切换至移动端视口（桌面端隐藏内联条与弹窗入口，按渲染规格在移动端测试弹窗）
      await first.setViewportSize({ width: 375, height: 812 });
      const firstInline = first.locator('.my-rewards-inline');
      await expect(firstInline).toBeVisible();
      await expect(firstInline.locator('.my-rewards-last-value')).toContainText(firstLastRollHeadline);

      // 点击真实无障碍名称“查看我的奖品与状元经历”按钮唤起弹窗
      const openDialogBtn = first.getByRole('button', { name: '查看我的奖品与状元经历' });
      await expect(openDialogBtn).toBeVisible();
      await openDialogBtn.click();

      // 真实弹层名称为“我的奖品与状元经历”
      const myRewardsDialog = first.getByRole('dialog', { name: '我的奖品与状元经历' });
      await expect(myRewardsDialog).toBeVisible();
      // 弹窗内保留 exact personal persistent result 与奖品明细
      await expect(myRewardsDialog.locator('.my-last-roll-card')).toContainText(firstLastRollHeadline);
      expect(await myRewardsDialog.locator('.my-last-roll-card').innerText()).toBe(firstLastRollText);
      expect(await myRewardsDialog.locator('.my-prizes-breakdown').innerText()).toBe(firstPrizesText);
      await expect(myRewardsDialog.locator('.my-prize-row')).toHaveCount(6);

      // 按 Esc 键关闭弹层并确认隐藏
      await first.keyboard.press('Escape');
      await expect(myRewardsDialog).toBeHidden();

      // 恢复视口
      await first.setViewportSize({ width: 1440, height: 900 });

      expect(hostConsole.errors).toEqual([]);
      expect(guestConsole.errors).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('常驻席位条（SeatStrip）展示人数、席位容量、在线状态与当前玩家骰子标识', async ({ browser }) => {
    test.setTimeout(180_000);
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await createRoom(host, { nickname: '阿月', roomName: '席位测试桌', maxPlayers: 4, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      // 验证席位条头部汇总信息（2 人在玩 · 2 人在线 · 2/4 席）
      const seatStrip = host.locator('.seat-strip');
      await expect(seatStrip).toBeVisible();
      await expect(seatStrip.locator('.seat-strip-stat').first()).toContainText('2');
      await expect(seatStrip.locator('.seat-strip-cap')).toContainText('2/4 席');

      // 验证头像席位项与身份标识
      await expect(host.locator('.seat-chip--me')).toContainText('阿月');
      await expect(host.locator('.seat-chip--me .seat-chip-badge--me')).toContainText('我');

      // 验证当前回合玩家标识（骰子小图标与“当前”标识）
      const currentChip = host.locator('.seat-chip--current');
      await expect(currentChip).toBeVisible();
      await expect(currentChip.locator('.seat-chip-dice-icon')).toHaveText('🎲');
      await expect(currentChip.locator('.seat-chip-badge--current')).toBeVisible();
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('开局后紧凑顶部栏收纳次操作至“更多”面板，支持 Esc 键收起', async ({ browser }) => {
    test.setTimeout(180_000);
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await createRoom(host, { nickname: '阿月', roomName: '顶栏收纳局', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      // 对局中顶部栏收缩为紧凑单行
      const compactHeader = host.locator('.room-header--compact');
      await expect(compactHeader).toBeVisible();
      await expect(host.locator('.room-pacing-pill')).toContainText('停留 1 秒');

      // 展开“更多”面板
      const moreBtn = host.locator('.room-more-btn');
      await expect(moreBtn).toHaveAttribute('aria-expanded', 'false');
      await moreBtn.click();
      await expect(moreBtn).toHaveAttribute('aria-expanded', 'true');

      // 面板内次操作与元信息可见
      const morePanel = host.locator('#room-more-panel');
      await expect(morePanel).toBeVisible();
      await expect(morePanel.getByRole('button', { name: '邀请亲友' })).toBeVisible();
      await expect(morePanel.getByRole('button', { name: '规则' })).toBeVisible();
      await expect(morePanel.getByRole('button', { name: '提前结束' })).toBeVisible();
      await expect(morePanel.getByRole('button', { name: '离开房间' })).toBeVisible();

      // 按 Esc 键收起面板
      await host.keyboard.press('Escape');
      await expect(moreBtn).toHaveAttribute('aria-expanded', 'false');
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('最近记录抽屉：焦点捕获、Esc 恢复、唯一掷骰主操作与“只看我”自然文案', async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const host = await context.newPage();
    const guestContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const guest = await guestContext.newPage();

    try {
      await createRoom(host, { nickname: '阿月', roomName: '抽屉回归局', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      // 第一位选手投掷产生记录
      const roller = (await isRollEnabled(host)) ? host : guest;
      await roller.getByRole('button', { name: '掷出好运' }).first().click();
      await expect(host.locator('.record-list .record, .history-panel .record')).toHaveCount(1, { timeout: 30_000 });

      // 移动端底部栏展现最近 1 条摘要
      const trigger = host.locator('.recent-bar-trigger');
      await expect(trigger).toBeVisible();
      await expect(trigger.locator('.recent-bar-text')).toContainText('最近：');

      // 打开抽屉
      await trigger.click();
      const drawer = host.locator('#recent-activity-drawer');
      await expect(drawer).toBeVisible();

      // 焦点捕获在抽屉关闭按钮上
      const closeBtn = drawer.locator('.dialog-close');
      await expect(closeBtn).toBeFocused();

      // 抽屉内有唯一掷骰按钮（若处于自己回合），底栏掷骰按钮不重复出现在 DOM 中
      const drawerRoll = drawer.locator('.recent-drawer-footer .btn-roll');
      await expect(drawerRoll).toHaveCount(1);
      await expect(host.locator('.action-bar-inner > .btn-roll')).toHaveCount(0);

      // Esc 键关闭抽屉并恢复触发按钮焦点
      await host.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(trigger).toBeFocused();

      // 再次打开抽屉，切换“只看我”筛选
      await trigger.click();
      await expect(drawer).toBeVisible();
      const mineFilterBtn = drawer.getByRole('button', { name: '只看我' });
      await mineFilterBtn.click();
      await expect(mineFilterBtn).toHaveClass(/is-active/);

      // 说明文案不应包含技术黑话（如“服务端240条窗口”）
      const footnote = drawer.locator('.recent-drawer-footnote');
      await expect(footnote).toBeVisible();
      await expect(footnote).not.toContainText('服务端240条窗口');
      await expect(footnote).toContainText('仅展示你在本局最近的投掷记录');
    } finally {
      await context.close();
      await guestContext.close();
    }
  });

  test('房主在局中调整游戏节奏（结果停留秒数），两端实时生效', async ({ browser }) => {
    test.setTimeout(180_000);
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await createRoom(host, { nickname: '阿月', roomName: '节奏调整局', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      // 初始停留 1 秒
      await expect(host.locator('.room-pacing-pill')).toContainText('停留 1 秒');
      await expect(guest.locator('.room-pacing-pill')).toContainText('停留 1 秒');

      // 房主打开“更多” -> “房间设置”
      await openMoreMenuIfNeeded(host);
      await host.getByRole('button', { name: '房间设置' }).click();

      const dialog = host.getByRole('dialog', { name: '房间设置' });
      await expect(dialog).toBeVisible();

      // 修改结果停留秒数为 2
      const pacingInput = dialog.getByRole('spinbutton', { name: '结果停留秒数', exact: true });
      await pacingInput.fill('2');
      await dialog.getByRole('button', { name: '保存设置' }).click();
      await expect(dialog).toBeHidden();

      // 两端房间顶部均更新为停留 2 秒
      await expect(host.locator('.room-pacing-pill')).toContainText('停留 2 秒');
      await expect(guest.locator('.room-pacing-pill')).toContainText('停留 2 秒');
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
