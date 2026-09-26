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
  expectBowlMatchesLatestRecord,
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
import type { BrowserContext, Page } from '@playwright/test';

interface ProbeSnapshot {
  audioStarts: number;
  audioCloses: number;
  spinningEvents: number;
  phases: string[];
  settledCounts: number[];
}

async function installAnimationAndAudioProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const state = {
      audioStarts: 0,
      audioCloses: 0,
      spinningEvents: 0,
      phases: [] as string[],
      settledCounts: [] as number[],
    };
    (window as unknown as { __bobingProbe?: typeof state }).__bobingProbe = state;

    if (typeof AudioScheduledSourceNode !== 'undefined' && AudioScheduledSourceNode.prototype) {
      const origStart = AudioScheduledSourceNode.prototype.start;
      AudioScheduledSourceNode.prototype.start = function (...args: Parameters<typeof origStart>) {
        state.audioStarts += 1;
        return origStart.apply(this, args);
      };
    }

    const AudioCtx =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx && AudioCtx.prototype) {
      const origClose = AudioCtx.prototype.close;
      AudioCtx.prototype.close = function (...args: Parameters<typeof origClose>) {
        state.audioCloses += 1;
        return origClose.apply(this, args);
      };
    }

    const recordBowl = (bowl: Element | null) => {
      if (!bowl) return;
      const isSpinning = bowl.classList.contains('bowl--spinning');
      const phase = bowl.getAttribute('data-phase') ?? 'idle';
      const settledRaw = bowl.getAttribute('data-settled-count');
      const settled = settledRaw !== null ? Number.parseInt(settledRaw, 10) : 6;

      if (isSpinning || phase !== 'idle') {
        state.spinningEvents += 1;
      }
      if (state.phases[state.phases.length - 1] !== phase) {
        state.phases.push(phase);
      }
      if (Number.isInteger(settled) && state.settledCounts[state.settledCounts.length - 1] !== settled) {
        state.settledCounts.push(settled);
      }
    };

    const attachObserver = () => {
      const observer = new MutationObserver(() => {
        const bowl = document.querySelector('.bowl-wrap--game .bowl');
        recordBowl(bowl);
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class', 'data-phase', 'data-settled-count'],
      });
    };

    if (document.documentElement) {
      attachObserver();
    } else {
      window.addEventListener('DOMContentLoaded', attachObserver, { once: true });
    }
  });
}

async function readProbe(page: Page): Promise<ProbeSnapshot> {
  return page.evaluate(() => {
    const p = (window as unknown as { __bobingProbe?: ProbeSnapshot }).__bobingProbe;
    return p
      ? {
          audioStarts: p.audioStarts,
          audioCloses: p.audioCloses,
          spinningEvents: p.spinningEvents,
          phases: [...p.phases],
          settledCounts: [...p.settledCounts],
        }
      : { audioStarts: 0, audioCloses: 0, spinningEvents: 0, phases: [], settledCounts: [] };
  });
}

async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const p = (window as unknown as { __bobingProbe?: ProbeSnapshot }).__bobingProbe;
    if (p) {
      p.audioStarts = 0;
      p.audioCloses = 0;
      p.spinningEvents = 0;
      p.phases = [];
      p.settledCounts = [];
    }
  });
}

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

  test('音效默认关/开启刷新记住、仅本人发声、HTTP先于WS到达完整播完0..6阶段动画(4b/4c)、离开dispose(4d)与reduced-motion', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const reducedContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });

    await installAnimationAndAudioProbe(hostContext);
    await installAnimationAndAudioProbe(guestContext);
    await installAnimationAndAudioProbe(reducedContext);

    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    const delayRolledWs = async (page: Page) => {
      await page.routeWebSocket(/.*/, (ws) => {
        const server = ws.connectToServer();
        server.onMessage((message) => {
          if (typeof message === 'string' && message.includes('room:state') && message.includes('"reason":"rolled"')) {
            setTimeout(() => {
              ws.send(message);
            }, 350);
            return;
          }
          ws.send(message);
        });
        ws.onMessage((message) => {
          server.send(message);
        });
      });
    };

    try {
      // 延后两端 Socket.IO WebSocket 的 room:state 推送，确保投掷者自己的 HTTP POST 响应先于 WS 到达（验证 4b）
      await delayRolledWs(host);
      await delayRolledWs(guest);

      const code = await createRoom(host, { nickname: '阿月', roomName: '音效动画局', maxPlayers: 2, rounds: 5 });
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');

      await toggleReady(guest);
      await startGame(host);

      const first = (await isRollEnabled(host)) ? host : guest;
      const second = first === host ? guest : host;

      // 1) 首次进入默认静音（aria-pressed="false"）
      const firstSoundBtn = first.getByRole('button', { name: '开启音效' });
      await expect(firstSoundBtn).toBeVisible();
      await expect(firstSoundBtn).toHaveAttribute('aria-pressed', 'false');

      // 旁观者（second）打开音效，用于验证“即使开启了音效，别人投掷也绝不发声”
      await second.getByRole('button', { name: '开启音效' }).click();
      await expect(second.getByRole('button', { name: '关闭音效' })).toHaveAttribute('aria-pressed', 'true');

      await resetProbe(first);
      await resetProbe(second);

      // 第一掷（first 投，音效关闭）：有完整 0..6 阶段动画（且 HTTP 先于 WS 到达），但 audioStarts 为 0
      await rollOnce(first);
      await expect(first.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      await expect(second.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      const firstDice = await expectBowlMatchesLatestRecord(first, '第一掷投手：');
      expect(await expectBowlMatchesLatestRecord(second, '第一掷旁观者：')).toEqual(firstDice);

      const firstRollProbe = await readProbe(first);
      expect(firstRollProbe.audioStarts, '音效关闭时不应产生音频节点').toBe(0);
      expect(firstRollProbe.spinningEvents, 'HTTP 先于 WS 返回时本人动画被跳过(4b)').toBeGreaterThan(0);
      expect(firstRollProbe.phases).toEqual(expect.arrayContaining(['tumbling', 'landing', 'colliding', 'settling', 'idle']));
      expect(firstRollProbe.settledCounts, '逐颗停稳必须完整包含 0..6 (4c)').toEqual(
        expect.arrayContaining([0, 1, 2, 3, 4, 5, 6]),
      );

      // 旁观者（second）即使打开了音效，在别人（first）投掷时也必须无动画、无声音
      const secondOnFirstRoll = await readProbe(second);
      expect(secondOnFirstRoll.spinningEvents, '别人投掷时旁观页不应播放旋转动画').toBe(0);
      expect(secondOnFirstRoll.audioStarts, '别人投掷时旁观页不应播放音效').toBe(0);

      // 2) first 开启音效并刷新页面：刷新后记住开启状态，且整个加载期间 MutationObserver 确认无动画重播、无声音重播
      await first.getByRole('button', { name: '开启音效' }).click();
      await expect(first.getByRole('button', { name: '关闭音效' })).toHaveAttribute('aria-pressed', 'true');

      await first.reload();
      await expect(first.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      await expect(first.getByRole('button', { name: '关闭音效' })).toHaveAttribute('aria-pressed', 'true');
      const firstAfterReload = await readProbe(first);
      expect(firstAfterReload.spinningEvents, '刷新页面加载期间不应重播历史动画').toBe(0);
      expect(firstAfterReload.audioStarts, '刷新页面加载期间不应重播历史音效').toBe(0);
      expect(await bowlPips(first)).toEqual(firstDice);

      // 3) 第二掷（轮到 second，已开启音效）：second 本人有声音 + 有动画；first 旁观（虽也开启音效）无声音 + 无动画
      await resetProbe(first);
      await resetProbe(second);
      await rollOnce(second);
      await expect(second.locator('.record')).toHaveCount(2, { timeout: 30_000 });
      await expect(first.locator('.record')).toHaveCount(2, { timeout: 30_000 });
      const secondDice = await expectBowlMatchesLatestRecord(second, '第二掷投手：');
      expect(await expectBowlMatchesLatestRecord(first, '第二掷旁观：')).toEqual(secondDice);

      const secondRollProbe = await readProbe(second);
      expect(secondRollProbe.audioStarts, '本人已开启音效投掷时应启动 WebAudio 声源').toBeGreaterThan(0);
      expect(secondRollProbe.spinningEvents).toBeGreaterThan(0);

      const firstOnSecondRoll = await readProbe(first);
      expect(firstOnSecondRoll.audioStarts, '旁观他人投掷时即使已开音效也不应发声').toBe(0);
      expect(firstOnSecondRoll.spinningEvents, '旁观他人投掷时不应播放动画').toBe(0);

      // 4) 第三掷（回到 first 的回合）：使用 prefers-reduced-motion: reduce 上下文接管 first 的席位投掷
      const firstMembershipRaw = await first.evaluate(
        (k) => window.localStorage.getItem(k),
        `bobing.membership.${code}`,
      );
      await first.close();

      const reducedPage = await reducedContext.newPage();
      await reducedPage.goto('/');
      await reducedPage.evaluate(
        ([k, v]) => {
          if (v) window.localStorage.setItem(k, v);
        },
        [`bobing.membership.${code}`, firstMembershipRaw ?? ''] as const,
      );
      await reducedPage.goto(`/room/${code}`);
      await expect(reducedPage.locator('.record')).toHaveCount(2, { timeout: 30_000 });
      await resetProbe(reducedPage);

      await rollOnce(reducedPage);
      await expect(reducedPage.locator('.record')).toHaveCount(3, { timeout: 30_000 });
      const thirdDice = await expectBowlMatchesLatestRecord(reducedPage, '第三掷 reduced-motion：');
      const reducedProbe = await readProbe(reducedPage);
      expect(reducedProbe.spinningEvents, 'prefers-reduced-motion 下不应启动装饰动画帧').toBe(0);
      expect(await bowlPips(reducedPage)).toEqual(thirdDice);

      // 5) 路由离开房间回到首页时，当前音效控制器必须调用 dispose 关闭 AudioContext (4d)
      const closesBeforeLeave = (await readProbe(second)).audioCloses;
      await second.getByRole('link', { name: '月满博饼' }).first().click();
      await expect(second).toHaveURL(/\/$/);
      const closesAfterLeave = (await readProbe(second)).audioCloses;
      expect(closesAfterLeave, '离开房间卸载组件时必须 dispose 关闭 AudioContext (4d)').toBeGreaterThan(closesBeforeLeave);
    } finally {
      await hostContext.close();
      await guestContext.close();
      await reducedContext.close();
    }
  });
});
