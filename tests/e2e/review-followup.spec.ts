/**
 * Antigravity 评审后续回归测试（Task 1 & Task 2 验收）：
 * 1. 大厅紧凑入口、输码展开与 375/320px 无横向溢出；
 * 2. 移动端隐藏骰碗卡片底部 .game-hint-note，且底部悬浮栏不遮挡个人权威结果条（保留至少 8px）；
 * 3. “全桌最新”与“本人战绩”视觉层级锚点共存；
 * 4. “我的奖品”弹窗 DOM 次序（六档明细置顶、上一掷居中、状元经历 details 折叠与键盘焦点遍历）；
 * 5. 房间设置文案精简、Stepper 步进调节、两端禁用与非法草稿校验；
 * 6. 席位条长昵称字素截断、320px 避免二次省略、触摸全名行与 Esc 关闭；
 * 7. 桌面端（1440px）奖池与状元历程合理滚动高度与键盘可访问。
 */

import { expect, test } from '@playwright/test';
import {
  createRoom,
  expectNoHorizontalOverflow,
  isRollEnabled,
  joinByInvite,
  openMoreMenuIfNeeded,
  readInviteUrl,
  rectOf,
  startGame,
  toggleReady,
  watchConsole,
} from './helpers.js';

const PHONE = { width: 375, height: 812 };
const NARROW_PHONE = { width: 320, height: 568 };
const DESKTOP = { width: 1440, height: 900 };

test.describe('Antigravity 评审体验与展示回归', () => {
  test('大厅紧凑头部、输码 details 展开与 375/320px 几何安全', async ({ browser }) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const pageConsole = watchConsole(page);

    try {
      await page.goto('/lobby');
      await expect(page.getByRole('heading', { name: '游戏大厅' })).toBeVisible();

      // 验证“开一桌”与“输码直达”紧凑并列
      const createBtn = page.getByRole('link', { name: '开一桌' }).first();
      const codeSummary = page.locator('.lobby-code-summary');
      await expect(createBtn).toBeVisible();
      await expect(codeSummary).toBeVisible();

      const createRect = await rectOf(page, '.lobby-hero-bar > .lobby-create-btn');
      const summaryRect = await rectOf(page, '.lobby-code-summary');
      expect(createRect.bottom - createRect.top).toBeGreaterThanOrEqual(43.5);
      expect(summaryRect.bottom - summaryRect.top).toBeGreaterThanOrEqual(43.5);
      // 375px 下紧凑并列在同一水平带
      expect(Math.abs(createRect.top - summaryRect.top)).toBeLessThan(10);

      // details 初始为折叠状态，表单不可见
      const details = page.locator('.lobby-code-details');
      await expect(details).not.toHaveAttribute('open', '');
      const input = page.locator('.lobby-code-input');
      await expect(input).not.toBeVisible();

      // 点击展开
      await codeSummary.click();
      await expect(details).toHaveAttribute('open', '');
      await expect(input).toBeVisible();

      // 键盘模式切换与无效码校验
      const toggleModeBtn = page.locator('.code-mode-toggle');
      await expect(toggleModeBtn).toBeVisible();
      await toggleModeBtn.click();
      await expect(input).toHaveAttribute('placeholder', 'ABCD23');
      await toggleModeBtn.click();
      await expect(input).toHaveAttribute('placeholder', '028416');

      // 提交无效码触发表单错误提示
      await input.fill('123');
      await page.getByRole('button', { name: '进入房间' }).click();
      await expect(page.locator('.lobby-code-form .form-error')).toBeVisible();

      // 375px 与 320px 无横向滚动
      await expectNoHorizontalOverflow(page);
      await page.setViewportSize(NARROW_PHONE);
      await expectNoHorizontalOverflow(page);
    } finally {
      expect(pageConsole.errors).toEqual([]);
      await context.close();
    }
  });

  test('对局首屏提示隐藏、全桌/个人层级、奖品置顶与折叠、设置 Stepper 及长昵称全名', async ({ browser }) => {
    test.setTimeout(240_000);
    const hostContext = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const guestContext = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const hostConsole = watchConsole(host);
    const guestConsole = watchConsole(guest);

    try {
      await createRoom(host, {
        nickname: '阿月',
        roomName: '评审验收桌',
        maxPlayers: 2,
        rounds: 5,
      });

      // 1. 房间设置弹层文案精简与 Stepper 步进调节回归
      await openMoreMenuIfNeeded(host);
      await host.getByRole('button', { name: '房间设置' }).click();
      const settingsDialog = host.locator('.dialog');
      await expect(settingsDialog).toBeVisible();

      // 顶部说明已精简，不再出现大段冗余秒数
      const notice = settingsDialog.locator('.room-settings-dialog-notice');
      await expect(notice).toContainText('公开范围与旁观设置保存后立即生效。');
      await expect(notice).not.toContainText('结果停留时长可设');

      // Stepper 步进按钮验证（≥44px 触控区域）
      const stepDown = settingsDialog.getByRole('button', { name: '减少结果停留秒数', exact: true });
      const stepUp = settingsDialog.getByRole('button', { name: '增加结果停留秒数', exact: true });
      const saveSettingsBtn = settingsDialog.getByRole('button', { name: '保存设置', exact: true });
      await expect(stepDown).toBeVisible();
      await expect(stepUp).toBeVisible();
      const downRect = await rectOf(host, '.settings-hold-step:has-text("−")');
      const upRect = await rectOf(host, '.settings-hold-step:has-text("+")');
      expect(downRect.right - downRect.left).toBeGreaterThanOrEqual(43.5);
      expect(downRect.bottom - downRect.top).toBeGreaterThanOrEqual(43.5);
      expect(upRect.right - upRect.left).toBeGreaterThanOrEqual(43.5);
      expect(upRect.bottom - upRect.top).toBeGreaterThanOrEqual(43.5);

      // 默认停留 1 秒：可减也可加；测试步进与越界禁用
      const holdInput = settingsDialog.locator('.settings-hold-input');
      await expect(holdInput).toHaveValue('1');

      // 点击增加 -> 变为 2
      await stepUp.click();
      await expect(holdInput).toHaveValue('2');

      // 填 0 -> 减少禁用，增加可用
      await holdInput.fill('0');
      await expect(stepDown).toBeDisabled();
      await expect(stepUp).toBeEnabled();

      // 填 10 -> 增加禁用，减少可用
      await holdInput.fill('10');
      await expect(stepUp).toBeDisabled();
      await expect(stepDown).toBeEnabled();

      // 非法草稿输入校验：空白、小数、越界均禁用步进并阻止保存
      await holdInput.fill('');
      await expect(settingsDialog.getByRole('alert')).toContainText('请填写结果停留秒数');
      await expect(stepDown).toBeDisabled();
      await expect(stepUp).toBeDisabled();
      await expect(saveSettingsBtn).toBeDisabled();

      await holdInput.fill('1.5');
      await expect(settingsDialog.getByRole('alert')).toContainText('结果停留秒数必须是 0–10 的整数');
      await expect(stepDown).toBeDisabled();
      await expect(stepUp).toBeDisabled();
      await expect(saveSettingsBtn).toBeDisabled();

      await holdInput.fill('11');
      await expect(settingsDialog.getByRole('alert')).toContainText('结果停留秒数请填 0–10 的整数');
      await expect(stepDown).toBeDisabled();
      await expect(stepUp).toBeDisabled();
      await expect(saveSettingsBtn).toBeDisabled();

      // 恢复默认 1 并关闭弹窗
      await holdInput.fill('1');
      await expect(saveSettingsBtn).toBeEnabled();
      await settingsDialog.getByRole('button', { name: '取消' }).click();
      await expect(settingsDialog).not.toBeVisible();

      // 2. 长昵称入座并开始对局（SeatStrip 在 GameBoard 中渲染）
      const inviteUrl = await readInviteUrl(host);
      const longGuestName = '团圆长昵称玩家甲乙';
      await joinByInvite(guest, inviteUrl, longGuestName);

      // 等待室准备并开局
      await toggleReady(guest);
      await startGame(host);

      // 席位条头像下展示压缩名称（compactSeatName 产出“团圆…甲乙”，保留汉字后缀）
      const guestChip = host.locator('.seat-chip[data-seat-player]').filter({ hasText: '团圆…甲乙' }).first();
      await expect(guestChip).toBeVisible();
      const trigger = guestChip.locator('.seat-chip-trigger');
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-label', new RegExp(longGuestName));
      const chipName = guestChip.locator('.seat-chip-name');
      await expect(chipName).toHaveText('团圆…甲乙');

      // 触控尺寸不小于 44px
      const triggerBox = await trigger.boundingBox();
      expect(triggerBox?.height).toBeGreaterThanOrEqual(43.5);
      expect(triggerBox?.width).toBeGreaterThanOrEqual(43.5);

      // 320px/375px/768px/1440px 几何断言：长昵称字素未被二次截断（scrollWidth <= clientWidth），横滑无整页溢出
      for (const vp of [NARROW_PHONE, PHONE, { width: 768, height: 900 }, DESKTOP]) {
        await host.setViewportSize(vp);
        await expect(chipName).toHaveText('团圆…甲乙');
        const isClipped = await chipName.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        expect(isClipped).toBe(false);
        const clippedAll = await host.locator('.seat-chip-name').evaluateAll((els) =>
          els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => ({
            text: el.textContent,
            scroll: el.scrollWidth,
            width: el.clientWidth,
          }))
        );
        expect(clippedAll).toEqual([]);
        await expectNoHorizontalOverflow(host);
      }
      await host.setViewportSize(PHONE);

      // 展开全名状态行
      await trigger.click();
      const fullNameBar = host.locator('.seat-full-name');
      await expect(fullNameBar).toBeVisible();
      await expect(fullNameBar).toContainText(longGuestName);

      // Escape 键关闭全名行
      await host.keyboard.press('Escape');
      await expect(fullNameBar).not.toBeVisible();

      // 3. 移动端对局中骰碗底部 .game-hint-note 隐藏，释放首屏高度并消除粘连
      const hintNote = host.locator('.game-center .game-hint-note');
      await expect(hintNote).toBeHidden();

      // 4. 投掷并验证全桌最新与个人战绩层级共存
      const activePlayer = (await isRollEnabled(host)) ? host : guest;
      await activePlayer.getByRole('button', { name: '掷出好运' }).first().click();

      // 等待出结果
      const gameResult = activePlayer.locator('.game-result');
      await expect(gameResult).toBeVisible({ timeout: 15_000 });
      await expect(gameResult.locator('.game-result-badge')).toContainText('全桌最新');

      // 徽章组合验证：在当前出资/结果展示徽章组合（我 + 当前/本次结果）下，名字像素未被二次挤压
      const clippedDuringRoll = await activePlayer.locator('.seat-chip-name').evaluateAll((els) =>
        els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => ({
          text: el.textContent,
          scroll: el.scrollWidth,
          width: el.clientWidth,
        }))
      );
      expect(clippedDuringRoll).toEqual([]);

      const myRewardsInline = activePlayer.locator('.my-rewards-inline');
      await expect(myRewardsInline).toBeVisible();
      await expect(myRewardsInline.locator('.my-rewards-badge')).toContainText('本人战绩');

      // 底部悬浮栏可见，且个人权威结果条（.my-rewards-inline）底边比 dockTop 高出至少 8px
      const dock = activePlayer.locator('.action-bar');
      await expect(dock).toBeVisible();
      const dockRect = await rectOf(activePlayer, '.action-bar');
      const ownRect = await rectOf(activePlayer, '.my-rewards-inline');
      expect(dockRect.top - ownRect.bottom).toBeGreaterThanOrEqual(8);

      // 5. “我的奖品”弹层重构：六档明细置顶，标题完整不截断，状元经历折叠收纳与焦点陷阱
      await myRewardsInline.locator('.my-rewards-open-btn').click();
      const myRewardsDialog = activePlayer.locator('.dialog');
      await expect(myRewardsDialog).toBeVisible();

      // DOM 顺序核验：.my-prizes-breakdown 排在 .my-last-roll-card 与 .my-champion-exp 之前
      const detailSections = myRewardsDialog.locator('.my-rewards-detail > section');
      const firstSectionClass = await detailSections.nth(0).getAttribute('class');
      const secondSectionClass = await detailSections.nth(1).getAttribute('class');
      const thirdSectionClass = await detailSections.nth(2).getAttribute('class');

      expect(firstSectionClass).toContain('my-prizes-breakdown');
      expect(secondSectionClass).toContain('my-last-roll-card');
      expect(thirdSectionClass).toContain('my-champion-exp');

      // 六档明细完整存在，标题完整未被截断
      await expect(myRewardsDialog.locator('.my-prize-row')).toHaveCount(6);
      const heading = myRewardsDialog.locator('.my-prizes-breakdown h3');
      await expect(heading).toHaveText('我的奖品明细');
      await expect(heading).toBeVisible();

      // 状元经历为可折叠 details，初始折叠状态；验证 summary 的 tabIndex=0 与焦点导航
      const closeBtn = myRewardsDialog.getByRole('button', { name: '关闭弹层' });
      await expect(closeBtn).toBeFocused();

      const champDetails = myRewardsDialog.locator('.my-champion-details');
      const champSummary = champDetails.locator('.my-champion-summary');
      await expect(champDetails).toBeVisible();
      await expect(champDetails).not.toHaveAttribute('open', '');
      await expect(champSummary).toHaveAttribute('tabindex', '0');

      // Tab 到 summary 并按 Enter 展开
      await activePlayer.keyboard.press('Tab');
      await expect(champSummary).toBeFocused();
      await activePlayer.keyboard.press('Enter');
      await expect(champDetails).toHaveAttribute('open', '');
      await expect(champDetails.locator('.my-champion-box')).toBeVisible();

      // Shift+Tab 回到关闭按钮
      await activePlayer.keyboard.press('Shift+Tab');
      await expect(closeBtn).toBeFocused();

      // Esc 关闭弹层并回焦至打开按钮
      await activePlayer.keyboard.press('Escape');
      await expect(myRewardsDialog).not.toBeVisible();
      await expect(myRewardsInline.locator('.my-rewards-open-btn')).toBeFocused();

      // 6. 桌面端 1440px 几何与滚动验收
      await host.setViewportSize(DESKTOP);
      const prizeRows = host.locator('.col-pool .prize-rows');
      await expect(prizeRows).toBeVisible();
      await expect(prizeRows).toHaveAttribute('tabindex', '0');
      await expect(prizeRows).toHaveAttribute('aria-label', /奖品余量/);

      // 检查桌面端限高滚动样式生效
      const prizeOverflow = await prizeRows.evaluate((el) => window.getComputedStyle(el).overflowY);
      expect(prizeOverflow).toBe('auto');

      // 状元历程：若有事件则具备滚动与 tabIndex=0，若无事件则展示明确空态
      const timeline = host.locator('.col-pool .champion-timeline');
      const timelineCount = await timeline.count();
      if (timelineCount > 0) {
        await expect(timeline).toBeVisible();
        await expect(timeline).toHaveAttribute('tabindex', '0');
        const timelineOverflow = await timeline.evaluate((el) => window.getComputedStyle(el).overflowY);
        expect(timelineOverflow).toBe('auto');
      } else {
        await expect(host.locator('.col-pool .empty-state')).toContainText('本局尚无状元更迭事件');
      }
    } finally {
      expect(hostConsole.errors).toEqual([]);
      expect(guestConsole.errors).toEqual([]);
      await hostContext.close();
      await guestContext.close();
    }
  });
});
