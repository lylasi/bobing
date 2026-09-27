/**
 * 375px 手机端完整流程：单栏布局、底部主操作、玩家/奖池/记录 Tab，
 * 并且不得横向滚动；两名玩家的对局在手机视口下同样可以打完并再开一局。
 *
 * 本用例同时守住 docs/final-review-addendum.md 的四个缺陷（M01/M02/M03/C01），
 * 全部在**同一个真实房间**里串行覆盖，不额外创建/加入（服务端限流为每 IP 每分钟 30 次）：
 *  - M01 轮次栏下首先看到中心骰碗/提示/最新结果，Tab 与玩家列表在其后，切 Tab 不隐藏碗；
 *  - M02 房间四个次操作文案不拆字、点击区 ≥44px、不横向溢出；
 *  - M03 记录为「时间/玩家 → 六颗骰子 → 奖项」三行，骰子与文案矩形不相交（局中与结算都查）；
 *  - C01 倒计时读数始终在 0–30 秒之内（曾因 HTTP Date 秒级校时显示 31 秒）。
 */

import { expect, test } from '@playwright/test';
import {
  countdownSeconds,
  createRoom,
  expectBowlMatchesLatestRecord,
  expectNoHorizontalOverflow,
  expectRecordsLayoutSane,
  isRollEnabled,
  joinByInvite,
  latestRecordDice,
  openMoreMenuIfNeeded,
  playUntilFinished,
  readInviteUrl,
  rectOf,
  rectsOf,
  screenshot,
  startGame,
  textLineCounts,
  toggleReady,
  watchConsole,
} from './helpers.js';

const PHONE = { width: 375, height: 812 };
const TABLET = { width: 768, height: 1024 };

/** Tab 切换的用例顺序：面板可见 + 碗与最新结果仍然可见 + 碗里仍是权威点数。 */
const TAB_CASES = [
  { label: '奖池', panel: '.prize-pool' },
  { label: '记录', panel: '.history' },
  { label: '玩家', panel: '.player-list' },
] as const;

test.describe('手机 375px', () => {
  test('创建、加入、对局、Tab 切换与结算都不横向溢出', async ({ browser }) => {
    test.setTimeout(300_000);

    const hostContext = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const guestContext = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const hostConsole = watchConsole(host);

    try {
      await host.goto('/');
      await expect(host.getByRole('heading', { name: '一碗骰声，满桌团圆。' })).toBeVisible();
      await expectNoHorizontalOverflow(host);
      await screenshot(host, '10-home-375');

      await createRoom(host, { nickname: '阿月', roomName: '手机小桌', maxPlayers: 2, rounds: 5 });
      await expectNoHorizontalOverflow(host);
      await screenshot(host, '11-waiting-375');

      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满');
      await toggleReady(guest);
      await startGame(host);
      await expect(guest.getByRole('button', { name: '掷出好运' }).first()).toBeVisible({ timeout: 20_000 });

      // 移动端主操作固定在底部（另一处同名按钮在移动端被 CSS 隐藏）
      await expect(host.getByRole('button', { name: '掷出好运' })).toHaveCount(1);

      // —— C01：新回合的倒计时读数必须落在 0–30 秒 ——
      const opening = await countdownSeconds(host);
      expect(opening, '开局后没有读到倒计时读数').not.toBeNull();
      expect(opening!, '倒计时没有随回合走').toBeGreaterThan(0);
      expect(opening!, `倒计时上界溢出：显示「剩余 ${opening} 秒」`).toBeLessThanOrEqual(30);
      for (let sample = 0; sample < 5; sample += 1) {
        const reading = await countdownSeconds(host);
        expect(reading!, '倒计时读数超出 0–30 秒').toBeGreaterThanOrEqual(0);
        expect(reading!, `倒计时上界溢出：显示「剩余 ${reading} 秒」`).toBeLessThanOrEqual(30);
        await host.waitForTimeout(300);
      }
      // 对手页同一时刻读到的是同一个服务端 deadline，同样不能越过 30 秒
      expect((await countdownSeconds(guest))!, '对手页倒计时上界溢出').toBeLessThanOrEqual(30);

      // —— M01：轮次栏之下先看到中心骰碗，且它在 Tab 与玩家列表之前 ——
      await expect(host.locator('.game-center')).toBeVisible();
      await expect(host.locator('.game-center .bowl')).toBeVisible();
      await expect(host.locator('.game-center .bowl .dice')).toHaveCount(6);
      for (let index = 0; index < 6; index += 1) {
        await expect(host.locator('.game-center .bowl .dice').nth(index), `第 ${index + 1} 颗骰子不可见`).toBeVisible();
      }
      await expect(host.locator('.game-result')).toBeVisible();

      const centerBox = await rectOf(host, '.col-center');
      const tabsBox = await rectOf(host, '.game-tabs');
      const playersBox = await rectOf(host, '.col-players');
      expect(centerBox.top, '中心骰碗区没有排在 Tab 之前').toBeLessThan(tabsBox.top);
      expect(centerBox.top, '中心骰碗区没有排在玩家列表之前').toBeLessThan(playersBox.top);
      expect(tabsBox.top, 'Tab 栏没有排在玩家列表之前').toBeLessThan(playersBox.top);

      // —— 真实投一骰：碗里实际点数必须等于最新权威记录 ——
      const roller = (await isRollEnabled(host)) ? host : guest;
      const watcher = roller === host ? guest : host;
      await roller.getByRole('button', { name: '掷出好运' }).first().click();
      await expect(roller.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      await expect(watcher.locator('.record')).toHaveCount(1, { timeout: 30_000 });

      const authority = await expectBowlMatchesLatestRecord(roller, '投手页：');
      expect(await latestRecordDice(watcher), '两端看到的权威点数不一致').toEqual(authority);
      expect(await expectBowlMatchesLatestRecord(watcher, '旁观页：')).toEqual(authority);
      await expect(host.locator('.game-result')).not.toContainText('骰声未起');

      // —— 切换三个 Tab：碗、六颗骰子与最新结果都必须仍然可见且点数不变 ——
      for (const { label, panel } of TAB_CASES) {
        await host.getByRole('tab', { name: label }).click();
        await expect(host.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
        await expect(host.locator(panel)).toBeVisible();
        await expect(host.locator('.game-center')).toBeVisible();
        await expect(host.locator('.game-center .bowl')).toBeVisible();
        await expect(host.locator('.game-center .bowl .dice')).toHaveCount(6);
        await expect(host.locator('.game-result')).toBeVisible();
        await expect(host.locator('.game-result')).not.toContainText('骰声未起');
        expect(await host.locator('.game-center .bowl .dice').evaluateAll((nodes) =>
          nodes.map((node) => node.querySelectorAll('.dice-pip--on').length),
        ), `切到「${label}」后碗里不再是权威点数`).toEqual(authority);
        // 切 Tab 后中心区依然排在 Tab 之前（几何顺序不因面板显隐而变化）
        expect((await rectOf(host, '.col-center')).top).toBeLessThan((await rectOf(host, '.game-tabs')).top);
        await expectNoHorizontalOverflow(host);
      }

      // —— M03：局中「记录」Tab 的三行排版 ——
      await host.getByRole('tab', { name: '记录' }).click();
      await expect(host.locator('.history')).toBeVisible();
      const inGameRecords = await expectRecordsLayoutSane(host);
      expect(inGameRecords).toBe(1);

      // —— M02：房间五个次操作（音效/邀请亲友/规则/提前结束/离开房间）文案不拆字、点击区 ≥44px ——
      // 先切回玩家 Tab：几何断言依赖面板真的可见（隐藏元素的矩形是 0）
      await host.getByRole('tab', { name: '玩家' }).click();
      await expect(host.locator('.player-list')).toBeVisible();
      await openMoreMenuIfNeeded(host);
      await expect(host.locator('.room-header-actions .btn')).toHaveCount(5);
      const actionLines = await textLineCounts(host, '.room-header-actions .btn');
      expect(actionLines, '房间次操作文案被拆成了多行').toEqual([1, 1, 1, 1, 1]);
      for (const box of await rectsOf(host, '.room-header-actions .btn')) {
        expect(box.bottom - box.top, '房间次操作点击区不足 44px').toBeGreaterThanOrEqual(44);
      }
      await expectNoHorizontalOverflow(host);

      // —— 平板 768：中心同样优先、不溢出（同一个房间，改视口即可） ——
      await host.setViewportSize(TABLET);
      await expect(host.locator('.game-center .bowl')).toBeVisible();
      await expect(host.locator('.game-center .bowl .dice')).toHaveCount(6);
      await expect(host.locator('.player-list')).toBeVisible();
      expect((await rectOf(host, '.col-center')).top).toBeLessThan((await rectOf(host, '.game-tabs')).top);
      expect((await rectOf(host, '.col-center')).top).toBeLessThan((await rectOf(host, '.col-players')).top);
      await expectNoHorizontalOverflow(host);
      expect(await textLineCounts(host, '.room-header-actions .btn')).toEqual([1, 1, 1, 1, 1]);
      await host.setViewportSize(PHONE);

      // 收起更多面板，恢复紧凑单行顶部栏，确保首屏（不滚动）能完整展示碗、当前提示与最新结果
      const moreBtn = host.locator('.room-more-btn');
      if ((await moreBtn.getAttribute('aria-expanded')) === 'true') {
        await moreBtn.click();
      }

      // —— 截图：先回顶部、等碗停稳、点数与权威记录一致 ——
      await expect(host.locator('.player-list')).toBeVisible();
      await host.evaluate(() => window.scrollTo(0, 0));
      // 首屏（不滚动）就要同时看到碗、当前提示与最新结果，且结果不被底部固定主按钮遮挡
      const bowlBox = await rectOf(host, '.game-center .bowl');
      const hintBox = await rectOf(host, '.game-center .game-hint');
      const resultBox = await rectOf(host, '.game-result');
      const actionBox = await rectOf(host, '.action-bar');
      expect(bowlBox.bottom, '手机首屏看不到当前提示').toBeLessThanOrEqual(hintBox.top);
      expect(hintBox.bottom, '手机首屏看不到最新结果').toBeLessThanOrEqual(resultBox.top);
      expect(
        resultBox.bottom,
        `最新结果被底部主按钮遮挡（结果 bottom=${Math.round(resultBox.bottom)}，按钮 top=${Math.round(actionBox.top)}）`,
      ).toBeLessThanOrEqual(actionBox.top + 1);
      expect(resultBox.bottom, '最新结果落在首屏之外').toBeLessThanOrEqual(PHONE.height);
      expect(await expectBowlMatchesLatestRecord(host, '截图前：')).toEqual(authority);
      await screenshot(host, '12-playing-375');

      await playUntilFinished([host, guest]);
      await expect(host.getByText('今宵状元')).toBeVisible();
      await expectNoHorizontalOverflow(host);
      await expectNoHorizontalOverflow(guest);

      // —— M03：结算页「完整记录」同样是三行，骰子不压中奖文案 ——
      const resultRecords = await expectRecordsLayoutSane(host);
      expect(resultRecords).toBe(10);
      await screenshot(host, '13-results-375');

      // 结算表格自身滚动，不撑宽整页
      await expect(host.locator('.table-scroll')).toBeVisible();

      await host.getByRole('button', { name: '再开一局' }).click();
      await expect(host.getByRole('heading', { name: '等好友入席' })).toBeVisible({ timeout: 20_000 });
      await expectNoHorizontalOverflow(host);

      expect(hostConsole.errors, `手机端控制台错误：${hostConsole.errors.join('\n')}`).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
