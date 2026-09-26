/**
 * 主流程 E2E：两个完全独立的浏览器上下文
 * 创建 → 邀请链接加入 → 准备 → 开始 → 轮流掷骰 → 刷新保持身份 → 结算 → 再开一局。
 *
 * 验证要点：两端看到相同的骰子、回合、奖池与记录（服务端 revision 权威同步）；
 * 分享链接来自 /api/config 的 PUBLIC_BASE_URL 且不含任何凭证。
 */

import { expect, test } from '@playwright/test';
import {
  createRoom,
  expectNoHorizontalOverflow,
  isFinished,
  joinByInvite,
  latestDiceLabel,
  playUntilFinished,
  prizeSnapshot,
  readInviteUrl,
  rollCount,
  screenshot,
  startGame,
  toggleReady,
  watchConsole,
} from './helpers.js';

test.describe('两人真实对局', () => {
  test('创建、邀请、准备、开始、轮转、刷新、结算与再开一局', async ({ browser }) => {
    test.setTimeout(240_000);

    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const hostConsole = watchConsole(host);
    const guestConsole = watchConsole(guest);

    try {
      const code = await createRoom(host, { nickname: '阿月', roomName: '中秋团圆局', maxPlayers: 2, rounds: 5 });
      await expect(host.getByText('已入座 1/2')).toBeVisible();

      // 分享链接必须来自 PUBLIC_BASE_URL，且只含房码
      const inviteUrl = await readInviteUrl(host);
      // 期望值来自服务端 PUBLIC_BASE_URL（默认 3210 用例为 http://localhost:3210）
      const expectedBase = process.env.E2E_EXPECT_PUBLIC_BASE_URL ?? 'http://localhost:3210';
      expect(inviteUrl).toBe(`${expectedBase}/room/${code}`);
      expect(inviteUrl).not.toMatch(/token|playerId|\?/i);

      await joinByInvite(guest, inviteUrl, '小满');
      await expect(guest.getByRole('heading', { name: '中秋团圆局' })).toBeVisible();
      await expect(host.getByText('已入座 2/2')).toBeVisible({ timeout: 15_000 });
      await expect(host.locator('.player-name', { hasText: '小满' })).toBeVisible();
      await expect(guest.locator('.player-name', { hasText: '阿月' })).toBeVisible();
      await screenshot(host, '01-waiting-desktop-1440');

      await toggleReady(guest);
      await expect(host.locator('.player-ready')).toHaveCount(2);
      await startGame(host);
      await expect(guest.getByRole('button', { name: '掷出好运' }).first()).toBeVisible({ timeout: 20_000 });
      await expect(host.locator('.turn-round')).toContainText('1/5');
      await expect(guest.locator('.turn-round')).toContainText('1/5');

      // 第一掷：由当前回合玩家完成，两端记录一致
      const roller = (await host.getByRole('button', { name: '掷出好运' }).first().isEnabled()) ? host : guest;
      const watcher = roller === host ? guest : host;
      await roller.getByRole('button', { name: '掷出好运' }).click();
      await expect(roller.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      await expect(watcher.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      expect(await latestDiceLabel(roller)).toBe(await latestDiceLabel(watcher));
      await expect(roller.getByText(/博得|好彩头|超时/).first()).toBeVisible();

      // 刷新保持身份：同一浏览器上下文重载后仍是同一玩家，记录与奖池不丢
      const beforeReload = await prizeSnapshot(watcher);
      await watcher.reload();
      await expect(watcher.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      await expect(watcher.getByRole('heading', { name: '中秋团圆局' })).toBeVisible();
      expect(await prizeSnapshot(watcher)).toEqual(beforeReload);
      await screenshot(roller, '02-playing-desktop-1440');
      await expectNoHorizontalOverflow(roller);
      await expectNoHorizontalOverflow(watcher);

      // 继续轮流掷骰直到结算（5 轮 × 2 人 = 10 次机会）
      await playUntilFinished([host, guest]);
      await expect(host.getByText('今宵状元')).toBeVisible();
      await expect(guest.getByText('今宵状元')).toBeVisible();
      expect(await rollCount(host)).toBe(10);
      const hostPool = await prizeSnapshot(host);
      const guestPool = await prizeSnapshot(guest);
      expect(guestPool).toEqual(hostPool);
      await screenshot(host, '03-results-desktop-1440');

      // 非房主看到等待提示，房主可再开一局
      await expect(guest.getByText('等待房主再开一局…')).toBeVisible();
      await host.getByRole('button', { name: '再开一局' }).click();
      await expect(host.getByRole('heading', { name: '等好友入席' })).toBeVisible({ timeout: 20_000 });
      await expect(guest.getByRole('heading', { name: '等好友入席' })).toBeVisible({ timeout: 20_000 });
      await expect(host.getByText('第 2 局')).toBeVisible();
      await expect(guest.getByText('第 2 局')).toBeVisible();
      await expect(host.locator('.record')).toHaveCount(0);
      await expect(guest.getByRole('button', { name: '准备好了' })).toBeVisible();

      expect(hostConsole.errors, `房主页面控制台错误：${hostConsole.errors.join('\n')}`).toEqual([]);
      expect(guestConsole.errors, `成员页面控制台错误：${guestConsole.errors.join('\n')}`).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('第三位玩家无法加入已满的房间', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const thirdContext = await browser.newContext();
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const third = await thirdContext.newPage();
    try {
      const code = await createRoom(host, { nickname: '阿月', roomName: '两人小桌', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await third.goto(inviteUrl);
      await expect(third.getByText('这桌已经坐满啦')).toBeVisible();
      await expect(third.getByRole('button', { name: '加入房间' })).toHaveCount(0);
      await expect(third.getByRole('link', { name: '回首页' })).toBeVisible();
      expect(code).toHaveLength(6);
    } finally {
      await hostContext.close();
      await guestContext.close();
      await thirdContext.close();
    }
  });

  test('已开局的邀请落地页不提供加入入口', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    try {
      await createRoom(host, { nickname: '阿月', roomName: '开局后不加人', maxPlayers: 4, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      await host.getByRole('button', { name: '邀请亲友' }).first().click();
      await expect(host.getByRole('dialog', { name: '邀请亲友' })).toBeVisible();
      const url = await host.getByLabel('邀请链接，可选中复制').inputValue();
      await host.keyboard.press('Escape');

      const late = await (await browser.newContext()).newPage();
      await late.goto(url);
      await expect(late.getByText('本局已经开始，暂时不能加入')).toBeVisible();
      await expect(late.getByRole('button', { name: '加入房间' })).toHaveCount(0);
      await late.context().close();
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('不存在的房间码给出明确提示', async ({ page }) => {
    await page.goto('/room/ZZZZ99');
    await expect(page.getByText('没找到这个房间，请检查房间码')).toBeVisible();
    await expect(page.getByRole('link', { name: '回首页开新桌' })).toBeVisible();

    await page.goto('/room/ABC');
    await expect(page.getByText('房间码是6位字母或数字，请检查邀请链接后重试。')).toBeVisible();
  });

  test('房主提前结束需要二次确认，成员端同步看到结算', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    try {
      await createRoom(host, { nickname: '阿月', roomName: '提前收桌', maxPlayers: 2, rounds: 20 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      await host.getByRole('button', { name: '提前结束' }).click();
      const confirm = host.getByRole('dialog', { name: '提前结束本局？' });
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: '继续博饼' }).click();
      await expect(host.getByRole('button', { name: '掷出好运' }).first()).toBeVisible();

      await host.getByRole('button', { name: '提前结束' }).click();
      await host.getByRole('dialog', { name: '提前结束本局？' }).getByRole('button', { name: '确认结束' }).click();
      await expect(host.getByText('房主提前结束')).toBeVisible({ timeout: 20_000 });
      await expect(guest.getByText('房主提前结束')).toBeVisible({ timeout: 20_000 });
      expect(await isFinished(host)).toBe(true);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
