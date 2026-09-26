/**
 * 房规配置、本机个人方案、等待室权限与准备重置、内容留空/自定义分母及再开局沿用的真实浏览器回归。
 * 覆盖 Spec A01、A08、A09、A10、A11 及主代理审查发现 4a。
 */

import { expect, test } from '@playwright/test';
import {
  expectNoHorizontalOverflow,
  joinByInvite,
  readInviteUrl,
  screenshot,
  startGame,
  toggleReady,
  watchConsole,
} from './helpers.js';

test.describe('房规配置与本机个人方案', () => {
  test('默认无限轮数、非法草稿不因编辑内容被重置(4a)、个人方案存取与配额失败提示、等待室改配与再开局沿用', async ({
    browser,
  }) => {
    test.setTimeout(240_000);

    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const hostConsole = watchConsole(host);
    const guestConsole = watchConsole(guest);

    try {
      await host.goto('/');
      await expect(host.getByRole('radio', { name: '持续顶状元' })).toBeChecked();
      await expect(host.getByRole('radio', { name: '奖品发完结束' })).toBeChecked();
      await expect(host.locator('.config-summary-bar')).toContainText('默认共 63 份');
      await expect(host.locator('.config-summary-counts')).toContainText(
        '状元 1 · 对堂 2 · 三红 4 · 四进 8 · 二举 16 · 一秀 32',
      );

      await host.getByLabel('你的昵称').fill('房主阿月');
      await host.getByLabel('房间名称').fill('自选奖品局');

      // —— 首页初始状态：“调整奖品与个人方案”默认收起，点击目标 >= 44px ——
      const advancedToggle = host.getByRole('button', { name: '调整奖品与个人方案' });
      await expect(advancedToggle).toHaveAttribute('aria-expanded', 'false');
      const toggleBox = await advancedToggle.boundingBox();
      expect(toggleBox!.height).toBeGreaterThanOrEqual(44);

      const yixiuCountInput = host.getByLabel('一秀数量', { exact: true });
      const yixiuContentInput = host.getByLabel('一秀奖品内容', { exact: true });
      const createButton = host.getByRole('button', { name: '创建房间', exact: true });
      await expect(yixiuCountInput).toBeHidden();
      await expect(host.getByLabel('个人方案名称')).toBeHidden();

      // 先明确展开高级区再填写奖品与个人方案
      await advancedToggle.click();
      await expect(advancedToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(yixiuCountInput).toBeVisible();

      // —— 审查发现 4a + 单档同步回归：清空一秀数量后，无论编辑奖品内容还是修改另一档有效数量(状元=3)，非法空值都不得被重置回 32 ——
      await yixiuCountInput.fill('');
      await expect(yixiuCountInput).toHaveValue('');
      await expect(host.getByRole('alert')).toContainText('请填写一秀数量');
      await expect(createButton).toBeDisabled();

      // 继续编辑一秀奖品内容与状元奖品内容：一秀数量保持为空，且提交继续禁用
      await yixiuContentInput.fill('月饼一盒');
      await host.getByLabel('状元奖品内容', { exact: true }).fill('中秋特等团圆金礼盒（长文案展示不溢出测试）');
      await expect(yixiuCountInput).toHaveValue('');
      await expect(host.getByRole('alert')).toContainText('请填写一秀数量');
      await expect(createButton).toBeDisabled();

      // 修改另一档（状元数量=3）触发有效 count 更新：一秀数量仍必须保持为空，绝不因循环同步被隐式恢复为 32
      await host.getByLabel('状元数量', { exact: true }).fill('3');
      await expect(host.getByLabel('状元数量', { exact: true })).toHaveValue('3');
      await expect(yixiuCountInput).toHaveValue('');
      await expect(host.getByRole('alert')).toContainText('请填写一秀数量');
      await expect(createButton).toBeDisabled();

      // —— 收起高级区时：摘要反映草稿变化，非法字段绝不能因收起而绕过校验，再次展开保留全部草稿 ——
      await advancedToggle.click();
      await expect(advancedToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(yixiuCountInput).toBeHidden();
      await expect(host.locator('.config-summary-counts')).toContainText('状元 3');
      await expect(host.locator('.config-summary-counts')).toContainText('一秀 待填');
      await expect(host.getByRole('alert')).toContainText('请填写一秀数量');
      await expect(createButton).toBeDisabled();
      await host.locator('#panel-create').evaluate((form: HTMLFormElement) => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await expect(host).toHaveURL(/\/$/);

      // 重新展开：草稿（一秀空值、状元=3、已填内容）完整保留
      await advancedToggle.click();
      await expect(advancedToggle).toHaveAttribute('aria-expanded', 'true');
      await expect(yixiuCountInput).toHaveValue('');
      await expect(host.getByLabel('状元数量', { exact: true })).toHaveValue('3');
      await expect(yixiuContentInput).toHaveValue('月饼一盒');

      // 修正一秀数量为 7：摘要随草稿实时更新为 40 份，创建按钮恢复可用
      await yixiuCountInput.fill('7');
      await expect(host.locator('.config-summary-bar')).toContainText('当前共 40 份 · 已填 2 项内容');
      await expect(host.locator('.config-summary-counts')).toContainText(
        '状元 3 · 对堂 2 · 三红 4 · 四进 8 · 二举 16 · 一秀 7',
      );
      await expect(createButton).toBeEnabled();

      // —— 个人方案保存、恢复默认数量、刷新后载入且不覆盖当前系统房规 ——
      await host.getByLabel('个人方案名称').fill('中秋家宴方案');
      await host.getByRole('button', { name: '保存方案' }).click();
      await expect(host.getByRole('status')).toContainText('个人方案「中秋家宴方案」已保存在当前浏览器');

      // 切换系统房规到“高阶锁定”，再点击“恢复默认数量”：只恢复份数(1/2/4/8/16/32)，保留内容与高阶锁定
      await host.getByRole('radio', { name: '高阶锁定' }).check();
      await host.getByRole('button', { name: '恢复默认数量' }).click();
      await expect(yixiuCountInput).toHaveValue('32');
      await expect(yixiuContentInput).toHaveValue('月饼一盒');
      await expect(host.getByRole('radio', { name: '高阶锁定' })).toBeChecked();

      // 刷新首页，确认默认收起；重新选“高阶锁定”后展开并载入已保存方案：数量与内容恢复为 7 / 3，系统房规仍保持“高阶锁定”
      await host.reload();
      await expect(host.getByRole('button', { name: '调整奖品与个人方案' })).toHaveAttribute('aria-expanded', 'false');
      await host.getByRole('radio', { name: '高阶锁定' }).check();
      await host.getByRole('button', { name: '调整奖品与个人方案' }).click();
      await expect(host.getByRole('button', { name: '调整奖品与个人方案' })).toHaveAttribute('aria-expanded', 'true');
      await host.getByLabel('已存个人方案').selectOption({ label: '中秋家宴方案' });
      await expect(host.getByLabel('一秀数量', { exact: true })).toHaveValue('7');
      await expect(host.getByLabel('状元数量', { exact: true })).toHaveValue('3');
      await expect(host.getByLabel('一秀奖品内容', { exact: true })).toHaveValue('月饼一盒');
      await expect(host.getByRole('radio', { name: '高阶锁定' })).toBeChecked();

      // —— 存储不可用（QuotaExceededError）时绝不假报成功，但仍可正常开房 ——
      await host.evaluate(() => {
        const originalSetItem = Storage.prototype.setItem;
        (window as unknown as { __origSetItem?: typeof originalSetItem }).__origSetItem = originalSetItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key === 'bobing.personal-templates.v1') {
            throw new DOMException('quota', 'QuotaExceededError');
          }
          return originalSetItem.call(this, key, value);
        };
      });
      await host.getByLabel('个人方案名称').fill('超配额方案');
      await host.getByRole('button', { name: '保存方案' }).click();
      await expect(host.getByRole('alert')).toContainText(/未能持久保存|存储/);
      await host.evaluate(() => {
        const win = window as unknown as { __origSetItem?: typeof Storage.prototype.setItem };
        if (win.__origSetItem) Storage.prototype.setItem = win.__origSetItem;
      });

      // 重新填写昵称与房间名称并创建房间
      await host.getByLabel('你的昵称').fill('房主阿月');
      await host.getByLabel('房间名称').fill('自选奖品局');
      await expectNoHorizontalOverflow(host);
      await screenshot(host, '40-home-config-1440');

      await createButton.click();
      await expect(host).toHaveURL(/\/room\/[A-Z0-9]{6}$/);

      // 等待室显示高阶锁定、奖品发完结束、填写的内容；未填内容的档位不渲染 .prize-content
      await expect(host.getByText('高阶锁定').first()).toBeVisible();
      await expect(host.getByText('奖品发完结束').first()).toBeVisible();
      await expect(host.getByText('月饼一盒', { exact: true }).first()).toBeVisible();
      await expect(host.locator('.waiting-prize-list .prize-content')).toHaveCount(2);

      // 另一位玩家通过邀请链接入席：落地页同样展示高阶锁定与真实奖品概况
      const inviteUrl = await readInviteUrl(host);
      await joinByInvite(guest, inviteUrl, '小满', '高阶锁定');

      // 非房主看不到“修改房规与奖品”按钮
      await expect(guest.getByRole('button', { name: '修改房规与奖品' })).toHaveCount(0);
      await expect(host.getByRole('button', { name: '修改房规与奖品' })).toBeVisible();

      // 小满先准备
      await toggleReady(guest);
      await expect(host.locator('.player-ready')).toHaveCount(2);

      // 房主打开配置弹层：默认展开全部编辑字段（无需再点一次展开），并验证保存失败时保留草稿提示错误
      await host.getByRole('button', { name: '修改房规与奖品' }).click();
      const dialog = host.getByRole('dialog', { name: '修改房规与奖品' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('修改后，其他玩家需要重新准备。')).toBeVisible();
      await expect(dialog.getByRole('button', { name: '调整奖品与个人方案' })).toHaveAttribute('aria-expanded', 'true');
      await expect(dialog.getByLabel('对堂数量', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('对堂奖品内容', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('个人方案名称')).toBeVisible();
      await screenshot(host, '41-waiting-edit-dialog-1440');

      await dialog.getByLabel('对堂数量', { exact: true }).fill('5');
      await dialog.getByLabel('对堂奖品内容', { exact: true }).fill('武夷岩茶一盒');

      await host.route('**/api/rooms/*/actions', async (route) => {
        const body = route.request().postDataJSON() as { type?: string } | null;
        if (body?.type === 'update-config') {
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'INVALID_INPUT', message: '模拟配置保存被拒绝' } }),
          });
          return;
        }
        await route.continue();
      });

      await dialog.getByRole('button', { name: '保存配置' }).click();
      await expect(dialog.getByRole('alert')).toContainText('模拟配置保存被拒绝');
      await expect(dialog).toBeVisible();
      // 失败时小满仍是已准备状态
      await expect(guest.getByRole('button', { name: '取消准备' })).toBeVisible();

      // 恢复接口并成功保存配置：弹层关闭，两端同步新配置，小满准备状态被取消，房主准备状态保留
      await host.unroute('**/api/rooms/*/actions');
      await dialog.getByRole('button', { name: '保存配置' }).click();
      await expect(dialog).toBeHidden();

      await expect(host.getByText('武夷岩茶一盒').first()).toBeVisible();
      await expect(guest.getByText('武夷岩茶一盒').first()).toBeVisible();
      await expect(guest.getByRole('button', { name: '准备好了' })).toBeVisible();
      await expect(host.getByRole('button', { name: '取消准备' })).toBeVisible();

      // 小满重新准备并开局：局中无配置修改入口，轮次显示“第 1 轮”（无总轮数分母），奖池分母为真实配置
      await toggleReady(guest);
      await startGame(host);
      await expect(host.getByRole('button', { name: '修改房规与奖品' })).toHaveCount(0);
      await expect(host.locator('.turn-round')).toHaveText(/第\s*1\s*轮/);
      await expect(host.locator('.turn-round')).not.toContainText('/');

      // 奖池只对填了内容的 3 档（状元、对堂、一秀）渲染 .prize-content，分母为 /3、/5、/7
      await expect(host.locator('.prize-pool .prize-content')).toHaveCount(3);
      await expect(host.locator('.prize-pool')).toContainText('/7');
      await expect(host.locator('.prize-pool')).toContainText('/5');
      await expect(host.locator('.prize-pool')).toContainText('/3');
      await screenshot(host, '42-playing-custom-config-1440');

      // 手机 375 与平板 768 下检查长奖品内容与自定义奖池不横向溢出
      await host.setViewportSize({ width: 768, height: 1024 });
      await expectNoHorizontalOverflow(host);
      await screenshot(host, '43-playing-custom-config-768');

      await host.setViewportSize({ width: 375, height: 812 });
      await host.getByRole('tab', { name: '奖池' }).click();
      await expect(host.locator('.prize-pool')).toBeVisible();
      await expectNoHorizontalOverflow(host);
      await screenshot(host, '44-playing-custom-config-375');
      await host.setViewportSize({ width: 1440, height: 900 });

      // 修改本机浏览器个人方案不会污染已创建的房间
      await host.evaluate(() => {
        window.localStorage.setItem('bobing.personal-templates.v1', '[]');
      });
      await expect(host.locator('.prize-pool')).toContainText('武夷岩茶一盒');

      // 房主提前结束并再开一局：验证结算显示“本局未完成”，再开一局后沿用本房间配置并清空统计
      await host.getByRole('button', { name: '提前结束' }).click();
      await host.getByRole('dialog', { name: '提前结束本局？' }).getByRole('button', { name: '确认结束' }).click();
      await expect(host.getByText('本局未完成')).toBeVisible({ timeout: 20_000 });
      await expect(host.getByText('武夷岩茶一盒').first()).toBeVisible();

      await host.getByRole('button', { name: '再开一局' }).click();
      await expect(host.getByRole('heading', { name: '等好友入席' })).toBeVisible({ timeout: 20_000 });
      await expect(host.getByText('第 2 局')).toBeVisible();
      await expect(host.getByText('高阶锁定').first()).toBeVisible();
      await expect(host.getByText('奖品发完结束').first()).toBeVisible();
      await expect(host.getByText('武夷岩茶一盒').first()).toBeVisible();
      await expect(host.getByText('月饼一盒').first()).toBeVisible();

      expect(
        hostConsole.errors.filter((msg) => !msg.includes('status of 400 (Bad Request)')),
      ).toEqual([]);
      expect(guestConsole.errors).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
