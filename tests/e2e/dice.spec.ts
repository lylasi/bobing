/**
 * 骰子权威性回归（对应 docs/frontend-review.md 第 3 条与主代理真实复现）。
 *
 * 全部是真实双浏览器上下文 + 真实服务端，断言的是**碗里实际显示的点数**
 * （`.bowl .dice .dice-pip--on` 的个数），而不是只看记录文字。
 *
 * 用例数量受服务端真实限流约束（每 IP 每分钟 30 次创建/加入），
 * 因此同一局里相关的场景串行覆盖，不额外开房。
 */

import { expect, test } from '@playwright/test';
import {
  bowlPips,
  createRoom,
  EMPTY_BOWL_PIPS,
  expectRecordsLayoutSane,
  isRollEnabled,
  joinByInvite,
  latestRecordDice,
  paintedColors,
  playUntilFinished,
  readInviteUrl,
  startGame,
  toggleReady,
  rollCount,
} from './helpers.js';
import type { Page } from '@playwright/test';

async function rollOnce(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: '掷出好运' }).first();
  await expect(button).toBeEnabled({ timeout: 30_000 });
  await button.click();
}

test.describe('骰子只跟随最新权威记录', () => {
  test('A 投完 B 立刻投，刷新第二投手页面后两端碗里都是最新权威点数；再开一局清空', async ({ browser }) => {
    test.setTimeout(240_000);
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await createRoom(host, { nickname: '阿月', roomName: '骰子同步局', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      // 第一位投手：投出第一条记录
      const first = (await isRollEnabled(host)) ? host : guest;
      const second = first === host ? guest : host;
      await rollOnce(first);
      await expect(host.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      await expect(guest.locator('.record')).toHaveCount(1, { timeout: 30_000 });

      // 第二位投手紧接着投：这是主代理复现的时序（A 投完立即 B 投）
      await rollOnce(second);

      // 请求中与动画中都不能重复投掷（防重入）
      const inlineRoll = second.locator('.game-center .btn-roll');
      await expect(inlineRoll).toBeDisabled();
      await expect(inlineRoll).toHaveAttribute('aria-busy', 'true');

      await expect(host.locator('.record')).toHaveCount(2, { timeout: 30_000 });
      await expect(guest.locator('.record')).toHaveCount(2, { timeout: 30_000 });

      const authority = await latestRecordDice(host);
      expect(authority, '没有读到最新权威点数').toHaveLength(6);
      expect(await latestRecordDice(guest)).toEqual(authority);

      // 桌面 1440 的四列记录同样不能重叠（移动端改成三行排版后，桌面可读性不能回退）
      expect(await expectRecordsLayoutSane(host), '桌面记录的骰子与奖项文案重叠').toBe(2);

      // 刷新第二投手的页面：presence/重连会推来新的完整快照（旧实现会在这里丢掉计时器）
      await second.reload();
      await expect(second.locator('.record')).toHaveCount(2, { timeout: 30_000 });

      // 两页碗里显示的六颗骰子点数都必须等于最新权威点数
      await expect
        .poll(async () => await bowlPips(second), { timeout: 20_000, message: '刷新后的投手页面碗里不是最新权威点数' })
        .toEqual(authority);
      await expect
        .poll(async () => await bowlPips(first), { timeout: 20_000, message: '旁观页面的碗里回放了自己的旧结果' })
        .toEqual(authority);

      // 没有卡在装饰旋转上，操作已恢复可用
      await expect(second.locator('.bowl--spinning')).toHaveCount(0);
      await expect(first.locator('.bowl--spinning')).toHaveCount(0);
      await expect(second.getByRole('button', { name: '掷出好运' }).first()).toBeVisible({ timeout: 20_000 });

      // 碗本身确实画出来了（不是塌缩成一片纯色）
      const bowlStats = await paintedColors(second, '.bowl-wrap--game .bowl');
      expect(bowlStats.colors, '对局瓷碗看起来没有渲染').toBeGreaterThan(30);

      // 打到结算再开一局：新一局碗里必须清空，不能残留上一局的骰子
      await playUntilFinished([host, guest]);
      await expect(host.getByText('今宵状元')).toBeVisible({ timeout: 20_000 });
      expect(await rollCount(host)).toBe(10);

      await host.getByRole('button', { name: '再开一局' }).click();
      await expect(host.getByRole('heading', { name: '等好友入席' })).toBeVisible({ timeout: 20_000 });
      await toggleReady(guest);
      await startGame(host);
      await expect(host.locator('.bowl').first()).toBeVisible({ timeout: 20_000 });
      expect(await bowlPips(host)).toEqual(EMPTY_BOWL_PIPS);
      expect(await bowlPips(guest)).toEqual(EMPTY_BOWL_PIPS);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('掷骰失败停止旋转回到权威点数；本地倒计时到 0 时禁用掷骰并提示同步', async ({ browser }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await createRoom(host, { nickname: '阿月', roomName: '投掷失败局', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      const first = (await isRollEnabled(host)) ? host : guest;
      const second = first === host ? guest : host;
      await rollOnce(first);
      await expect(host.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      await expect(guest.locator('.record')).toHaveCount(1, { timeout: 30_000 });

      const authority = await latestRecordDice(host);
      expect(authority).toHaveLength(6);

      // 第二位投手的掷骰请求直接网络失败
      await second.route('**/api/rooms/*/actions', async (route) => {
        const body = route.request().postDataJSON() as { type?: string } | null;
        if (body?.type === 'roll') {
          await route.abort('failed');
          return;
        }
        await route.continue();
      });
      await rollOnce(second);

      // 提示可见、没有新记录、没有卡在旋转上，碗里仍是上一手权威点数
      await expect(second.getByRole('alert').first()).toBeVisible({ timeout: 20_000 });
      await expect(second.locator('.bowl--spinning')).toHaveCount(0, { timeout: 20_000 });
      await expect(host.locator('.record')).toHaveCount(1);
      await expect(second.locator('.record')).toHaveCount(1);
      await expect.poll(async () => await bowlPips(second), { timeout: 20_000 }).toEqual(authority);

      // 恢复网络后仍可正常投掷
      await second.unroute('**/api/rooms/*/actions');
      await rollOnce(second);
      await expect(host.locator('.record')).toHaveCount(2, { timeout: 30_000 });
      await expect(guest.locator('.record')).toHaveCount(2, { timeout: 30_000 });
      const secondAuthority = await latestRecordDice(host);
      await expect.poll(async () => await bowlPips(second), { timeout: 20_000 }).toEqual(secondAuthority);

      // 现在轮到第一位玩家：只改写“自己这一页”读到的权威快照，把本轮 deadline 放到过去，
      // 模拟浏览器看到的倒计时已经归零；revision 抬高让本页不再被后续推送更新
      // （服务端状态、对手页面与真实规则完全不受影响）。
      const roller = (await isRollEnabled(host)) ? host : guest;
      const other = roller === host ? guest : host;
      await roller.route('**/api/rooms/*/state', async (route) => {
        const response = await route.fetch();
        const body = (await response.json()) as {
          playerId?: string;
          room: { status: string; turnPlayerId: string | null; deadline: number | null; revision: number };
        };
        if (body.room.status === 'playing' && body.room.turnPlayerId === body.playerId) {
          body.room.deadline = Date.now() - 1000;
          body.room.revision += 100000;
        }
        await route.fulfill({ response, json: body });
      });
      await roller.reload();

      await expect(roller.getByText('本轮已到时，正在同步…')).toBeVisible({ timeout: 20_000 });
      await expect(roller.getByRole('button', { name: '掷出好运' }).first()).toBeDisabled();
      // 没有伪造结果：本地到期不会产生新记录，也不会把随机中帧当结果
      await expect(roller.locator('.record')).toHaveCount(2);
      await expect.poll(async () => await bowlPips(roller), { timeout: 20_000 }).toEqual(secondAuthority);
      // 另一页服务端状态正常，倒计时仍在
      await expect(other.locator('.turn-countdown')).toContainText('剩余');
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('超时只显示最新超时文案，不显示旧中奖，碗里保留上一手权威点数', async ({ browser }) => {
    test.setTimeout(240_000);
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    try {
      await createRoom(host, { nickname: '阿月', roomName: '超时同步局', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);

      // 先真实投一次，让结果区有“上一手”的内容
      const roller = (await isRollEnabled(host)) ? host : guest;
      await rollOnce(roller);
      await expect(host.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      await expect(guest.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      const authority = await latestRecordDice(host);
      expect(authority).toHaveLength(6);
      const previousHeadline = await host.locator('.game-result').innerText();
      expect(previousHeadline).not.toContain('超时');

      // 另一位玩家什么都不做，等 30 秒回合超时（超时不掷骰、不发奖、消耗一次机会）
      await expect(host.locator('.record')).toHaveCount(2, { timeout: 60_000 });
      await expect(guest.locator('.record')).toHaveCount(2, { timeout: 60_000 });
      await expect(host.locator('.record').first()).toContainText('超时未掷');

      // 结果区显示的是最新超时，而不是上一手的中奖文案
      await expect(host.locator('.game-result')).toContainText('本轮超时，已跳过');
      await expect(host.locator('.game-result')).not.toContainText(previousHeadline);
      await expect(guest.locator('.game-result')).toContainText('本轮超时，已跳过');

      // 超时不给假骰子：两页碗里都还是上一手的权威点数
      expect(await bowlPips(host)).toEqual(authority);
      expect(await bowlPips(guest)).toEqual(authority);

      // 刷新后仍然一致（不能因为超时记录没有骰子就把碗清空）
      await guest.reload();
      await expect(guest.locator('.record')).toHaveCount(2, { timeout: 30_000 });
      await expect.poll(async () => await bowlPips(guest), { timeout: 20_000 }).toEqual(authority);

      // 超时后轮到另一位玩家，可以正常继续投掷
      const next = (await isRollEnabled(host)) ? host : guest;
      await rollOnce(next);
      await expect(host.locator('.record')).toHaveCount(3, { timeout: 30_000 });
      const nextAuthority = await latestRecordDice(host);
      expect(nextAuthority).toHaveLength(6);
      await expect(host.locator('.game-result')).not.toContainText('本轮超时，已跳过');
      await expect.poll(async () => await bowlPips(host), { timeout: 20_000 }).toEqual(nextAuthority);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
