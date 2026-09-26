/**
 * 布局与可访问性检查：375 / 768 / 1440 三档宽度下，
 * 首页、规则页、邀请落地页、房间等待区都不横向溢出，主操作可见，并留存截图。
 */

import { expect, test } from '@playwright/test';
import { createRoom, expectNoHorizontalOverflow, readInviteUrl, screenshot, watchConsole } from './helpers.js';

const VIEWPORTS = [
  { name: '375', width: 375, height: 812 },
  { name: '768', width: 768, height: 1024 },
  { name: '1440', width: 1440, height: 900 },
] as const;

test.describe('响应式布局', () => {
  test('首页、规则页、落地页与房间页在三档宽度下都不溢出', async ({ browser }) => {
    test.setTimeout(180_000);

    const setupContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const setup = await setupContext.newPage();
    const consoleWatch = watchConsole(setup);
    let inviteUrl = '';

    try {
      await createRoom(setup, { nickname: '阿月', roomName: '布局检查局', maxPlayers: 6, rounds: 10 });
      inviteUrl = await readInviteUrl(setup);

      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
        const page = await context.newPage();
        try {
          await page.goto('/');
          await expect(page.getByRole('heading', { name: '一碗骰声，满桌团圆。' })).toBeVisible();
          await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible();
          const primary = page.getByRole('button', { name: '创建房间' });
          const box = await primary.boundingBox();
          expect(box!.height, `${viewport.name}: 主按钮高度不足 44px`).toBeGreaterThanOrEqual(44);
          const disclosure = page.getByRole('button', { name: '调整奖品与个人方案' });
          await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
          const disclosureBox = await disclosure.boundingBox();
          expect(disclosureBox!.height, `${viewport.name}: 展开按钮高度不足 44px`).toBeGreaterThanOrEqual(44);
          if (viewport.name === '375') {
            const metrics = await page.evaluate(() => {
              const btn = document.querySelector<HTMLButtonElement>('#panel-create button[type="submit"]');
              const rect = btn?.getBoundingClientRect();
              return {
                createBtnY: Math.round((rect?.top ?? 0) + window.scrollY),
                pageHeight: document.documentElement.scrollHeight,
              };
            });
            expect(metrics.createBtnY, '375 下默认创建按钮 Y 仍过深').toBeLessThan(1600);
            expect(metrics.pageHeight, '375 下默认首页总高仍过长').toBeLessThan(2600);
          }
          await expectNoHorizontalOverflow(page);
          await screenshot(page, `20-home-${viewport.name}`);

          await page.goto('/rules');
          await expect(page.getByRole('heading', { name: '博饼怎么玩' })).toBeVisible();
          await expect(page.getByText('状元插金花', { exact: true })).toBeVisible();
          await expect(page.getByText(/rankKey/i)).toHaveCount(0);
          await expectNoHorizontalOverflow(page);
          await screenshot(page, `21-rules-${viewport.name}`);

          await page.goto(inviteUrl);
          await expect(page.getByText('收到邀请')).toBeVisible();
          await expectNoHorizontalOverflow(page);
          await screenshot(page, `22-invite-${viewport.name}`);
        } finally {
          await context.close();
        }
      }

      // 房间等待区在三个宽度下：房主自己的上下文已持有该房间凭证
      for (const viewport of VIEWPORTS) {
        await setup.setViewportSize({ width: viewport.width, height: viewport.height });
        await setup.reload();
        await expect(setup.getByRole('heading', { name: '布局检查局' })).toBeVisible({ timeout: 20_000 });
        await expect(setup.getByRole('button', { name: /准备好了|取消准备/ })).toBeVisible();
        await expectNoHorizontalOverflow(setup);
        await screenshot(setup, `23-room-waiting-${viewport.name}`);
      }

      expect(consoleWatch.errors, `控制台错误：${consoleWatch.errors.join('\n')}`).toEqual([]);
    } finally {
      await setupContext.close();
    }
  });

  test('深链刷新 /room/:code 与 /rules 不返回 404', async ({ request, browser }) => {
    const rules = await request.get('/rules');
    expect(rules.status()).toBe(200);
    expect(await rules.text()).toContain('<div id="root">');

    const unknown = await request.get('/room/ABCDEF');
    expect(unknown.status()).toBe(200);
    expect(await unknown.text()).toContain('<div id="root">');

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto('/room/ABCDEF');
      await expect(page.getByRole('alert')).toContainText('没找到这个房间');
    } finally {
      await context.close();
    }
  });
});
