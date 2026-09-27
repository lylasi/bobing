/**
 * 身份保持的真实浏览器回归（对应 docs/frontend-review.md 第 1、2、4 条）。
 *
 * 全部使用真实页面 + 真实服务端，只通过 Playwright 的网络层制造故障：
 *  - 初次加载 state 网络失败 / 500：必须保留本机凭证、展示重试，绝不回退到入房表单；
 *  - 只有服务端明确回答 INVALID_TOKEN 才清理身份；
 *  - 离开房间失败时不能假装已离开（保留身份、留在房间、可重试）；
 *  - /api/config 延迟返回时，邀请链接仍要使用 PUBLIC_BASE_URL。
 *
 * 用例数量受服务端真实限流约束（每 IP 每分钟 30 次创建/加入），因此相关场景在同一个真实房间里串行覆盖。
 */

import { expect, test } from '@playwright/test';
import {
  createRoom,
  joinByInvite,
  openMoreMenuIfNeeded,
  readInviteUrl,
  readMembership,
  startGame,
  toggleReady,
} from './helpers.js';

const STATE_ROUTE = '**/api/rooms/*/state';
const ACTIONS_ROUTE = '**/api/rooms/*/actions';

const NETWORK_ERROR_TEXT = '网络连接失败，请检查网络后重试';
const RETRY_HEADING = '暂时无法进入房间';

/** 只拦截掷骰/离开这类写操作，不影响页面其它同步。 */
async function failAction(page: import('@playwright/test').Page, type: 'roll' | 'leave'): Promise<void> {
  await page.route(ACTIONS_ROUTE, async (route) => {
    const body = route.request().postDataJSON() as { type?: string } | null;
    if (body?.type === type) {
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
}

test.describe('身份保持与离开', () => {
  test('state 请求失败：网络与 500 保留身份并可重试，只有 INVALID_TOKEN 才清身份', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    try {
      const code = await createRoom(page, { nickname: '阿月', roomName: '网络抖动局', maxPlayers: 4, rounds: 10 });
      const before = await readMembership(page, code);
      expect(before?.token).toBeTruthy();

      // 1) 主代理复现用例：进入已有的房间后把 state 请求打断，再刷新页面
      await page.route(STATE_ROUTE, (route) => route.abort('failed'));
      await page.reload();

      await expect(page.getByRole('heading', { name: RETRY_HEADING })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText(NETWORK_ERROR_TEXT)).toBeVisible();
      await expect(page.getByRole('button', { name: '重试' })).toBeVisible();
      // 绝不能退回入房表单
      await expect(page.getByRole('button', { name: '加入房间' })).toHaveCount(0);
      await expect(page.getByText('收到邀请')).toHaveCount(0);
      expect(await readMembership(page, code), '网络失败时本机凭证被清理了').toEqual(before);

      // 恢复网络后重试：仍是同一个人、同一个席位（1/4，而不是多占一个）
      await page.unroute(STATE_ROUTE);
      await page.getByRole('button', { name: '重试' }).click();
      await expect(page.getByRole('heading', { name: '网络抖动局' })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText('已入座 1/4')).toBeVisible();
      expect(await readMembership(page, code), '重试后身份发生了变化').toEqual(before);

      // 2) 500 同样是暂时错误，不是终态
      await page.route(STATE_ROUTE, (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '暂时无法完成操作，请稍后重试' } }),
        }),
      );
      await page.reload();
      await expect(page.getByRole('heading', { name: RETRY_HEADING })).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: '加入房间' })).toHaveCount(0);
      expect(await readMembership(page, code)).toEqual(before);

      await page.unroute(STATE_ROUTE);
      await page.getByRole('button', { name: '重试' }).click();
      await expect(page.getByRole('heading', { name: '网络抖动局' })).toBeVisible({ timeout: 20_000 });
      expect(await readMembership(page, code)).toEqual(before);

      // 3) 只有 INVALID_TOKEN 才清身份并回到入房表单
      await page.route(STATE_ROUTE, (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INVALID_TOKEN', message: '你的房间身份已失效，请重新加入' } }),
        }),
      );
      await page.reload();
      await expect(page.getByText('你的房间身份已失效，请重新加入')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('button', { name: '加入房间' })).toBeVisible();
      expect(await readMembership(page, code), 'INVALID_TOKEN 时应清理本机凭证').toBeNull();
    } finally {
      await context.close();
    }
  });

  test('离开失败不能假装已离开：保留身份留在房间，恢复重试后才真正离开', async ({ browser }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      const code = await createRoom(host, { nickname: '阿月', roomName: '离开失败局', maxPlayers: 3, rounds: 10 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      const before = await readMembership(guest, code);
      expect(before?.token).toBeTruthy();

      // 开局后离开：确认弹层必须说明本局不能再重新加入
      await toggleReady(guest);
      await startGame(host);
      await expect(guest.getByRole('button', { name: '掷出好运' }).first()).toBeVisible({ timeout: 20_000 });
      await openMoreMenuIfNeeded(guest);
      await guest.getByRole('button', { name: '离开房间' }).first().click();
      const dialog = guest.getByRole('dialog', { name: '离开房间？' });
      await expect(dialog).toContainText('本局已经开始的话，这一局不能再重新加入');

      // 网络失败：不能清理身份、不能跳首页
      await failAction(guest, 'leave');
      await dialog.getByRole('button', { name: '确认离开' }).click();
      await expect(dialog.getByRole('alert')).toContainText('离开没有成功', { timeout: 20_000 });
      expect(new URL(guest.url()).pathname).toMatch(/^\/room\/[A-Z0-9]{6}$/);
      await expect(guest.getByRole('heading', { name: '离开失败局' })).toBeVisible();
      expect(await readMembership(guest, code), '离开失败时凭证被清理了').toEqual(before);

      // 恢复网络后重试：这次真的离开，房主端看到小满已离开且对局继续（A14：单人仍可继续投掷）
      await guest.unroute(ACTIONS_ROUTE);
      await dialog.getByRole('button', { name: '确认离开' }).click();
      await expect(guest).toHaveURL(/\/$/, { timeout: 20_000 });
      expect(await readMembership(guest, code)).toBeNull();
      await openMoreMenuIfNeeded(host);
      await expect(host.locator('.room-meta-item', { hasText: '1/3 人' })).toBeVisible({ timeout: 20_000 });
      await expect(host.getByRole('button', { name: '掷出好运' }).first()).toBeEnabled({ timeout: 20_000 });
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('运行时配置延迟返回时，邀请链接仍会更新为 PUBLIC_BASE_URL', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const expectedBase = process.env.E2E_EXPECT_PUBLIC_BASE_URL ?? 'http://localhost:3210';

    try {
      // 让 /api/config 比房间页首次渲染晚返回：初稿会永久停留在访问者当前 origin
      await page.route('**/api/config', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        await route.continue();
      });

      const code = await createRoom(page, { nickname: '阿月', roomName: '延迟配置局', maxPlayers: 4, rounds: 10 });
      await page.getByRole('button', { name: '邀请亲友' }).first().click();
      const dialog = page.getByRole('dialog', { name: '邀请亲友' });
      const link = dialog.getByLabel('邀请链接，可选中复制');
      await expect(dialog).toBeVisible();

      // 配置还没回来时先用当前访问地址
      await expect(link).toHaveValue(`${new URL(page.url()).origin}/room/${code}`);

      // 配置到达后，无需重开弹层或刷新页面也必须自动换成对外域名
      await expect(link).toHaveValue(`${expectedBase}/room/${code}`, { timeout: 20_000 });
      expect(await link.inputValue()).not.toMatch(/token|playerId|\?/i);
    } finally {
      await context.close();
    }
  });
});
