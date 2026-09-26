/**
 * 视觉与组件自检：点阵骰子、瓷碗、主按钮色值与尺寸。
 * 这些断言替代人工肉眼检查中最容易回归的部分（点数是否真实、是否用了设计 token）。
 */

import { expect, test } from '@playwright/test';
import { createRoom, joinByInvite, paintedColors, readInviteUrl, screenshot, startGame, toggleReady } from './helpers.js';

test.describe('视觉与组件', () => {
  test('首页主视觉真的画出来了：420px 瓷碗、六颗有点阵骰子、颜色不是一片纯色', async ({ page }) => {
    await page.goto('/');
    const bowl = page.locator('.home-visual .bowl');
    await expect(bowl).toBeVisible();

    const box = await bowl.boundingBox();
    expect(Math.round(box!.width), '首页瓷碗塌缩了').toBe(420);
    expect(Math.round(box!.height)).toBe(420);

    // 装饰碗里是六颗真实点阵骰子，不是六个空白面
    const pips = await page
      .locator('.home-visual .dice')
      .evaluateAll((nodes) => nodes.map((node) => node.querySelectorAll('.dice-pip--on').length));
    expect(pips).toEqual([6, 4, 1, 3, 4, 5]);
    expect(pips.every((value) => value > 0)).toBe(true);

    // 截图颜色数量：径向渐变瓷碗 + 阴影 + 点阵骰子会有远多于纯色块的层次
    const stats = await paintedColors(page, '.home-visual .bowl');
    expect(stats.colors, '瓷碗看起来是一片纯色/没有画出来').toBeGreaterThan(30);
  });

  test('375 首页标题「一碗骰声，」「满桌团圆。」各段独占一行且不被拆断', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    const heading = page.getByRole('heading', { name: '一碗骰声，满桌团圆。' });
    await expect(heading).toBeVisible();

    const lines = await page.locator('.home-title-line').evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { text: node.textContent ?? '', top: Math.round(rect.top), height: Math.round(rect.height), width: Math.round(rect.width) };
      }),
    );
    expect(lines.map((line) => line.text)).toEqual(['一碗骰声，', '满桌团圆。']);
    // 两段各占一行：起始高度不同，且每段自身只占一行（高度约等于单行行高）
    expect(lines[1]!.top).toBeGreaterThan(lines[0]!.top);
    const lineHeight = await page.locator('.home-title-line').first().evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize) * 1.3);
    for (const line of lines) {
      expect(line.height, `${line.text} 被拆成了多行`).toBeLessThanOrEqual(lineHeight + 2);
      expect(line.width).toBeGreaterThan(80);
    }
  });

  test('骰子是按点数真实渲染的 3×3 点阵，一/四点为朱砂红', async ({ page }) => {
    await page.goto('/rules');
    const firstRow = page.locator('.rules-result').first().locator('.dice-row');
    await expect(firstRow).toBeVisible();
    await expect(firstRow.locator('.dice')).toHaveCount(6);

    // 状元插金花示例 [4,4,4,4,1,1]
    const pipCounts = await firstRow.locator('.dice').evaluateAll((nodes) =>
      nodes.map((node) => node.querySelectorAll('.dice-pip--on').length),
    );
    expect(pipCounts).toEqual([4, 4, 4, 4, 1, 1]);

    const cellCount = await firstRow.locator('.dice').first().evaluate((node) => node.querySelectorAll('.dice-pip').length);
    expect(cellCount).toBe(9);

    const pipColors = await firstRow.locator('.dice').evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node.querySelector('.dice-pip--on')!, '::after').backgroundColor),
    );
    // 四点为朱砂红，一点（最后一个）也是朱砂红
    expect(pipColors[0]).toBe('rgb(200, 62, 49)');
    expect(pipColors[5]).toBe('rgb(200, 62, 49)');

    // 谢谢参与示例 [1,1,2,2,3,3] 的二点不是红色
    const lastRow = page.locator('.rules-result').last().locator('.dice-row');
    const lastColors = await lastRow.locator('.dice').evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node.querySelector('.dice-pip--on')!, '::after').backgroundColor),
    );
    expect(lastColors[2]).toBe('rgb(44, 26, 17)');
  });

  test('首页主视觉是瓷碗加六颗骰子，碗体不使用外链图片', async ({ page }) => {
    await page.goto('/');
    const bowl = page.locator('.home-visual .bowl');
    await expect(bowl).toBeVisible();
    await expect(page.locator('.home-visual .dice')).toHaveCount(6);

    const remoteAssets = await page.evaluate(() =>
      Array.from(document.querySelectorAll('img, link[rel="stylesheet"], script[src]'))
        .map((element) => element.getAttribute('src') ?? element.getAttribute('href') ?? '')
        .filter((url) => /^https?:\/\//i.test(url)),
    );
    expect(remoteAssets, `发现外链资源：${remoteAssets.join(', ')}`).toEqual([]);

    // 碗内的六颗骰子互不遮挡
    const boxes = await page.locator('.home-visual .bowl-slot').evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      }),
    );
    expect(boxes).toHaveLength(6);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        expect(overlap, `第 ${i + 1} 颗与第 ${j + 1} 颗骰子重叠`).toBe(false);
      }
    }
  });

  test('主按钮使用朱砂红并满足 52px 高与 26px 圆角', async ({ page }) => {
    await page.goto('/');
    const button = page.getByRole('button', { name: '创建房间' });
    const styles = await button.evaluate((node) => {
      const computed = getComputedStyle(node);
      return { background: computed.backgroundColor, height: computed.height, radius: computed.borderRadius, font: computed.fontSize };
    });
    expect(styles.background).toBe('rgb(200, 62, 49)');
    expect(Number.parseFloat(styles.height)).toBeGreaterThanOrEqual(52);
    expect(styles.radius).toBe('26px');
    expect(styles.font).toBe('18px');

    const titleFont = await page
      .getByRole('heading', { name: '一碗骰声，满桌团圆。' })
      .evaluate((node) => getComputedStyle(node).fontFamily);
    expect(titleFont).toMatch(/Songti|serif/i);
  });

  test('房间页留存桌面与手机截图', async ({ browser }) => {
    const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const desktop = await desktopContext.newPage();
    try {
      await createRoom(desktop, { nickname: '阿月', roomName: '截图小桌', maxPlayers: 4, rounds: 10 });
      await desktop.getByRole('button', { name: '邀请亲友' }).first().click();
      await expect(desktop.getByRole('dialog', { name: '邀请亲友' })).toBeVisible();
      await screenshot(desktop, '30-share-dialog-1440');
      await desktop.keyboard.press('Escape');
      await desktop.getByRole('button', { name: '规则' }).first().click();
      await expect(desktop.getByRole('dialog', { name: /持续顶状元.*房间规则/ })).toBeVisible();
      await screenshot(desktop, '31-rules-dialog-1440');
      await desktop.keyboard.press('Escape');
    } finally {
      await desktopContext.close();
    }
  });

  test('1440 对局区为 280/560/312 三栏，中心瓷碗 400px', async ({ browser }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    try {
      await createRoom(host, { nickname: '阿月', roomName: '三栏检查', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      const container = await host.locator('.game-columns').boundingBox();
      const players = await host.locator('.col-players').boundingBox();
      const center = await host.locator('.col-center').boundingBox();
      const pool = await host.locator('.col-pool').boundingBox();
      const bowl = await host.locator('.bowl-wrap--game .bowl').boundingBox();

      expect(Math.round(players!.width)).toBe(280);
      expect(Math.round(center!.width)).toBe(560);
      expect(Math.round(pool!.width)).toBe(312);
      expect(Math.round(container!.width)).toBe(1200);
      expect(Math.round(bowl!.width)).toBe(400);
      expect(Math.round(center!.x - (players!.x + players!.width))).toBe(24);

      // 顶部导航高度、历史记录在下方整宽
      const header = await host.locator('.site-header-inner').boundingBox();
      expect(Math.round(header!.height)).toBeGreaterThanOrEqual(80);
      const history = await host.locator('.col-history').boundingBox();
      expect(history!.width).toBeGreaterThan(center!.width);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
