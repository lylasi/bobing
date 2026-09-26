/**
 * 断线与重连：真实浏览器拔掉网络后必须禁止掷骰，恢复后自动重连并追平房间状态。
 * 用浏览器上下文级别的离线模拟，不借助任何测试专用接口。
 *
 * 注意：断线检测走的是 Socket.IO 的心跳超时（客户端 pingTimeout），
 * 因此「掉线」需要几十秒才会显形，这也是真实断网的表现。
 */

import { expect, test } from '@playwright/test';
import { createRoom, joinByInvite, readInviteUrl, startGame, toggleReady, watchConsole } from './helpers.js';

test.describe('断线与重连', () => {
  test('掉线期间不能掷骰，恢复网络后自动重连并追平房间状态', async ({ browser }) => {
    test.setTimeout(300_000);

    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const guestConsole = watchConsole(guest);

    try {
      await createRoom(host, { nickname: '阿月', roomName: '断线重连局', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      // 先真实掷一次，确认对局在推进
      const firstRoller = (await guest.getByRole('button', { name: '掷出好运' }).first().isEnabled()) ? guest : host;
      await firstRoller.getByRole('button', { name: '掷出好运' }).first().click();
      await expect(host.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      await expect(guest.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      const seenWhileOnline = await guest.locator('.record').count();

      // 断开成员端的网络
      await guestContext.setOffline(true);
      await expect(guest.locator('.connection--disconnected')).toBeVisible({ timeout: 90_000 });
      await expect(guest.getByText('连接已断开，正在重连…')).toBeVisible();
      await expect(guest.getByRole('button', { name: '掷出好运' }).first()).toBeDisabled();

      // 掉线不等于离开：房间仍在、席位仍在、本地记录不再增长（已收不到广播）
      await expect(guest.getByRole('heading', { name: '断线重连局' })).toBeVisible();
      await expect(guest.locator('.player-name', { hasText: '小满' })).toBeVisible();
      await expect(guest.locator('.player-name', { hasText: '阿月' })).toBeVisible();
      await expect(guest.locator('.record')).toHaveCount(seenWhileOnline);

      // 恢复网络：自动重连，不需要刷新页面
      await guestContext.setOffline(false);
      await expect(guest.locator('.connection--connected')).toBeVisible({ timeout: 120_000 });
      await expect(guest.locator('.player-name', { hasText: '小满' })).toBeVisible();

      // 重连后先取一次状态再订阅：应追平房主看到的记录条数
      await expect
        .poll(
          async () => {
            const [hostCount, guestCount] = [await host.locator('.record').count(), await guest.locator('.record').count()];
            return guestCount >= hostCount;
          },
          { timeout: 90_000, message: '重连后未追平房间记录' },
        )
        .toBe(true);

      // 仍然可以继续掷骰：轮到谁就由谁掷
      const currentTurn = (await host.getByRole('button', { name: '掷出好运' }).first().isEnabled()) ? host : guest;
      if (await currentTurn.getByRole('button', { name: '掷出好运' }).first().isEnabled()) {
        const before = await host.locator('.record').count();
        await currentTurn.getByRole('button', { name: '掷出好运' }).first().click();
        await expect(host.locator('.record')).toHaveCount(before + 1, { timeout: 30_000 });
        await expect(guest.locator('.record')).toHaveCount(before + 1, { timeout: 30_000 });
      }

      expect(guestConsole.errors, `成员页面控制台错误：${guestConsole.errors.join('\n')}`).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
