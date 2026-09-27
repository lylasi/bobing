/**
 * 游戏大厅（/lobby）、六位数字房码、只读旁观（/room/:code/watch）、观众转入座与房间设置（RoomSettingsDialog）
 * 的真实多浏览器端到端回归测试（覆盖 L01–L07）。
 */

import { expect, test } from '@playwright/test';
import {
  bowlPips,
  expectBowlMatchesLatestRecord,
  expectNoHorizontalOverflow,
  isRollEnabled,
  latestRecordDice,
  paceForRateLimit,
  readMembership,
  screenshot,
  startGame,
  toggleReady,
  watchConsole,
} from './helpers.js';

test.describe('游戏大厅、真实旁观与入座转换（L01–L07）', () => {
  test('三浏览器：默认公开数字房码、大厅仅填昵称入座、第三人只读旁观同歩骰面与人数、再开局后我要入座转为玩家', async ({
    browser,
  }) => {
    test.setTimeout(240_000);

    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const visitorContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const visitor = await visitorContext.newPage();

    const hostConsole = watchConsole(host);
    const guestConsole = watchConsole(guest);
    const visitorConsole = watchConsole(visitor);

    try {
      // 1. 房主在首页创建默认房间（默认大厅公开、允许旁观、停留 1 秒）
      await host.goto('/');
      await host.getByLabel('你的昵称').fill('房主阿月');
      await host.getByLabel('房间名称').fill('中秋大厅公开桌');
      await host.getByLabel('人数上限').fill('4');
      await paceForRateLimit();
      await host.getByRole('button', { name: '创建房间', exact: true }).click();

      await expect(host).toHaveURL(/\/room\/[0-9]{6}$/);
      const code = new URL(host.url()).pathname.split('/').pop()!;
      expect(code).toMatch(/^[0-9]{6}$/);
      await expect(host.getByRole('heading', { name: '中秋大厅公开桌' })).toBeVisible();
      await expect(host.getByText('停留 1 秒', { exact: true })).toBeVisible();
      await expect(host.getByText('大厅公开', { exact: true })).toBeVisible();

      // 2. 第二位玩家（guest）前往 /lobby，从“可加入”列表点击“加入”，只填昵称入座
      await guest.goto('/lobby');
      await expect(guest.getByRole('heading', { name: '游戏大厅' })).toBeVisible();
      await expectNoHorizontalOverflow(guest);
      await screenshot(guest, '50-lobby-1440');

      const cardOnGuest = guest.locator('.lobby-room-card', { hasText: '中秋大厅公开桌' });
      await expect(cardOnGuest).toBeVisible();
      await expect(cardOnGuest).toContainText(code);
      await expect(cardOnGuest).toContainText('1/4 席');
      await expect(cardOnGuest.getByRole('button', { name: '先看看' })).toBeVisible();

      await cardOnGuest.getByRole('button', { name: '加入' }).click();
      const joinDialog = guest.getByRole('dialog', { name: '加入「中秋大厅公开桌」' });
      await expect(joinDialog).toBeVisible();
      await joinDialog.getByLabel('你的昵称').fill('小满');
      await paceForRateLimit();
      await joinDialog.getByRole('button', { name: '加入房间' }).click();

      await expect(guest).toHaveURL(new RegExp(`/room/${code}$`));
      await expect(guest.getByRole('heading', { name: '等好友入席' })).toBeVisible();

      // 非房主看不到“房间设置”按钮，但能看到“停留 1 秒”
      await expect(guest.getByRole('button', { name: '房间设置' })).toHaveCount(0);
      await expect(guest.getByText('停留 1 秒', { exact: true })).toBeVisible();
      await expect(host.getByRole('button', { name: '房间设置' }).first()).toBeVisible();

      // 3. 两人准备并开局
      await toggleReady(guest);
      await startGame(host);

      // 4. 第三位访客（visitor，无任何成员凭证）进入 /lobby，切换到“进行中”或“全部”，点击“旁观”
      await visitor.goto('/lobby');
      // 默认“可加入”下已开局的房间不应出现
      await expect(visitor.locator('.lobby-room-card', { hasText: '中秋大厅公开桌' })).toHaveCount(0);

      await visitor.getByRole('tab', { name: '进行中' }).click();
      const playingCard = visitor.locator('.lobby-room-card', { hasText: '中秋大厅公开桌' });
      await expect(playingCard).toBeVisible();
      await expect(playingCard).toContainText('进行中');
      await expect(playingCard.getByRole('button', { name: '加入' })).toHaveCount(0);
      await playingCard.getByRole('button', { name: '旁观' }).click();

      await expect(visitor).toHaveURL(new RegExp(`/room/${code}/watch$`));
      await expect(visitor.getByText('只读旁观', { exact: true })).toBeVisible();

      // 契约关键断言：观众没有掷骰/准备/结束/离开/我的奖品，且显示“本局已开始，可在下一局入座”与“返回大厅”
      await expect(visitor.getByRole('button', { name: '掷出好运', exact: true })).toHaveCount(0);
      await expect(visitor.getByText('本局已开始，可在下一局入座', { exact: true })).toBeVisible();
      await expect(visitor.getByRole('link', { name: '返回大厅' }).first()).toBeVisible();
      await expect(visitor.getByRole('region', { name: '我的上一掷' })).toHaveCount(0);
      await expect(visitor.getByRole('button', { name: '离开房间' })).toHaveCount(0);
      expect(await readMembership(visitor, code)).toBeNull();

      // 参赛人数仍为 2，旁观人数为 1（玩家端与观众端都可见）
      await expect(visitor.getByText('1 人旁观').first()).toBeVisible({ timeout: 10_000 });
      await expect(host.getByText('1 人旁观').first()).toBeVisible({ timeout: 10_000 });
      await expect(guest.getByText('1 人旁观').first()).toBeVisible({ timeout: 10_000 });
      await expect(visitor.getByText('2 人在玩')).toBeVisible();

      // 5. 当前回合玩家投掷一次，观众端实时看到相同权威骰面与记录
      const roller = (await isRollEnabled(host)) ? host : guest;
      await roller.getByRole('button', { name: '掷出好运' }).first().click();
      await expect(roller.locator('.record')).toHaveCount(1, { timeout: 30_000 });
      await expect(visitor.locator('.record')).toHaveCount(1, { timeout: 30_000 });

      const authority = await expectBowlMatchesLatestRecord(roller, '投手端：');
      expect(await latestRecordDice(visitor)).toEqual(authority);
      await expect.poll(async () => await bowlPips(visitor), { timeout: 15_000 }).toEqual(authority);
      await screenshot(visitor, '51-spectator-playing-1440');

      // 320px / 375px / 768px 响应式检查
      for (const vp of [
        { width: 768, height: 1024 },
        { width: 375, height: 812 },
        { width: 320, height: 640 },
      ]) {
        await visitor.setViewportSize(vp);
        await expectNoHorizontalOverflow(visitor);
      }
      await visitor.setViewportSize({ width: 1440, height: 900 });

      // 6. 房主提前结束本局 -> 观众看到只读结算；房主再开一局 -> 观众实时回到等待室并可点击“我要入座”
      await host.getByRole('button', { name: '更多' }).click();
      await host.getByRole('button', { name: '提前结束' }).click();
      await host.getByRole('dialog', { name: '提前结束本局？' }).getByRole('button', { name: '确认结束' }).click();
      await expect(visitor.getByRole('heading', { name: '本局小结' })).toBeVisible({ timeout: 20_000 });
      await expect(visitor.getByRole('button', { name: '再开一局' })).toHaveCount(0);

      await host.getByRole('button', { name: '再开一局' }).click();
      await expect(visitor.getByRole('button', { name: '我要入座' }).first()).toBeVisible({ timeout: 20_000 });

      await visitor.getByRole('button', { name: '我要入座' }).first().click();
      const seatDialog = visitor.getByRole('dialog', { name: '入座「中秋大厅公开桌」' });
      await expect(seatDialog).toBeVisible();
      await seatDialog.getByLabel('你的昵称').fill('阿福');
      await paceForRateLimit();
      await seatDialog.getByRole('button', { name: '确认入座' }).click();

      // 入座成功后：URL 恢复为 /room/:code，拥有成员凭证，参赛人数变为 3/4，旁观人数归零
      await expect(visitor).toHaveURL(new RegExp(`/room/${code}$`));
      await expect(visitor.getByRole('button', { name: '准备好了' })).toBeVisible();
      expect((await readMembership(visitor, code))?.token).toBeTruthy();
      await expect(host.getByText('3/4 人').first()).toBeVisible({ timeout: 15_000 });
      await expect(host.getByText('0 人旁观').first()).toBeVisible({ timeout: 15_000 });

      // 已有有效成员凭证的浏览器若再访问 /room/:code/watch，自动恢复成员身份
      await visitor.goto(`/room/${code}/watch`);
      await expect(visitor).toHaveURL(new RegExp(`/room/${code}$`));
      await expect(visitor.getByRole('button', { name: '准备好了' })).toBeVisible();

      expect(hostConsole.errors).toEqual([]);
      expect(guestConsole.errors).toEqual([]);
      expect(visitorConsole.errors).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
      await visitorContext.close();
    }
  });

  test('房间设置弹层（RoomSettingsDialog）：改仅邀请从大厅隐藏、改停留秒数不重置准备、关闭旁观立即撤销观众推送与大厅失败保留列表', async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const watcherContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const watcher = await watcherContext.newPage();

    try {
      await host.goto('/');
      await host.getByLabel('你的昵称').fill('房主小林');
      await host.getByLabel('房间名称').fill('设置与权限测试桌');
      await host.getByLabel('人数上限').fill('4');
      await paceForRateLimit();
      await host.getByRole('button', { name: '创建房间', exact: true }).click();

      await expect(host).toHaveURL(/\/room\/[0-9]{6}$/);
      const code = new URL(host.url()).pathname.split('/').pop()!;

      // guest 通过邀请落地页先看概况，点击“加入房间”入座并准备
      await guest.goto(`/room/${code}`);
      await expect(guest.getByRole('link', { name: '先看看' })).toBeVisible();
      await guest.getByLabel('你的昵称').fill('二号阿月');
      await paceForRateLimit();
      await guest.getByRole('button', { name: '加入房间' }).click();
      await toggleReady(guest);

      // watcher 进入旁观
      await watcher.goto(`/room/${code}/watch`);
      await expect(watcher.getByText('只读旁观', { exact: true })).toBeVisible();
      await expect(host.getByText('1 人旁观').first()).toBeVisible({ timeout: 10_000 });

      // 房主打开“房间设置”，把可见性改为“仅邀请”、结果停留改为 3 秒
      await host.getByRole('button', { name: '房间设置' }).first().click();
      const settingsDialog = host.getByRole('dialog', { name: '房间设置' });
      await expect(settingsDialog).toBeVisible();
      await settingsDialog.getByRole('radio', { name: '仅邀请' }).check();
      await settingsDialog.getByRole('spinbutton', { name: '结果停留秒数', exact: true }).fill('3');
      await settingsDialog.getByRole('button', { name: '保存设置' }).click();
      await expect(settingsDialog).toBeHidden();

      // 改动后：guest 的准备状态保持未重置，且两端均显示停留 3 秒与仅邀请
      await expect(guest.getByRole('button', { name: '取消准备' })).toBeVisible();
      await expect(host.getByText('停留 3 秒', { exact: true })).toBeVisible();
      await expect(guest.getByText('停留 3 秒', { exact: true })).toBeVisible();
      await expect(host.getByText('仅邀请', { exact: true })).toBeVisible();

      // 房主再次打开“房间设置”，关闭“允许旁观” -> watcher 立即收到 room:watch-ended 并停止旁观
      await host.getByRole('button', { name: '房间设置' }).first().click();
      await expect(settingsDialog).toBeVisible();
      await settingsDialog.getByRole('checkbox', { name: '允许旁观' }).uncheck();
      await settingsDialog.getByRole('button', { name: '保存设置' }).click();
      await expect(settingsDialog).toBeHidden();

      await expect(watcher.getByRole('alert')).toContainText('房主已关闭旁观', { timeout: 15_000 });
      await expect(watcher.getByRole('link', { name: '返回大厅' }).first()).toBeVisible();
      await expect(host.getByText('0 人旁观').first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await hostContext.close();
      await guestContext.close();
      await watcherContext.close();
    }
  });

  test('大厅请求生命周期回归：慢网络延迟刷新、刷新失败保留已有列表、手动重试成功恢复与筛选切换取消旧请求', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    const hostConsole = watchConsole(host);
    const guestConsole = watchConsole(guest);

    try {
      // 1. 房主创建公开房间
      await host.goto('/');
      await host.getByLabel('你的昵称').fill('房主延迟测试');
      await host.getByLabel('房间名称').fill('大厅延迟回归桌');
      await host.getByLabel('人数上限').fill('4');
      await paceForRateLimit();
      await host.getByRole('button', { name: '创建房间', exact: true }).click();
      await expect(host).toHaveURL(/\/room\/[0-9]{6}$/);
      const code = new URL(host.url()).pathname.split('/').pop()!;

      // 2. 访客进入大厅，确认看到已公开房间
      await guest.goto('/lobby');
      const card = guest.locator('.lobby-room-card', { hasText: '大厅延迟回归桌' });
      await expect(card).toBeVisible();
      await expect(card).toContainText(code);

      // 3. 拦截大厅刷新接口返回 500 错误，测试“刷新失败保留已有列表并展示错误提示”
      await guest.route('**/api/rooms?*filter=*', async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '大厅服务临时不可用' } }),
        });
      });

      // 点击“刷新列表”触发错误刷新
      await guest.getByRole('button', { name: '刷新列表' }).click();

      // 断言：已有房间卡片依然保留展示，并未被清空或置空
      await expect(card).toBeVisible();
      await expect(card).toContainText(code);
      // 断言：出现错误提示横幅
      const errorBanner = guest.locator('.lobby-error-banner');
      await expect(errorBanner).toBeVisible();
      await expect(errorBanner).toContainText('大厅服务临时不可用');

      // 4. 解除错误拦截，测试手动点击“重试”成功恢复并清空错误横幅
      await guest.unroute('**/api/rooms?*filter=*');
      await errorBanner.getByRole('button', { name: '重试' }).click();

      // 断言：错误横幅消失，列表保持完整
      await expect(errorBanner).toHaveCount(0);
      await expect(card).toBeVisible();
      await expect(guest.getByRole('button', { name: '刷新列表' })).toBeEnabled();

      // 5. 测试切换筛选（filter switch）：取消过期慢请求，不被旧请求响应覆盖
      await guest.route('**/api/rooms?*filter=playing*', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ rooms: [], nextCursor: null }),
        });
      });

      let delayedResolve: () => void = () => {};
      await guest.route('**/api/rooms?*filter=joinable*', async (route) => {
        await new Promise<void>((resolve) => {
          delayedResolve = resolve;
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            rooms: [
              {
                code: '888888',
                name: '不应出现的过期幽灵房',
                status: 'waiting',
                maxPlayers: 4,
                playerCount: 1,
                onlinePlayerCount: 1,
                rulesetName: '经典大奖博饼',
                endCondition: { mode: 'all-prizes' },
                allowSpectators: true,
                canJoin: true,
                createdAt: Date.now(),
              },
            ],
            nextCursor: null,
          }),
        });
      });

      // 触发延迟的 joinable 请求
      await guest.getByRole('button', { name: '刷新列表' }).click();

      // 立即切换到“进行中”标签页
      await guest.getByRole('tab', { name: '进行中' }).click();
      await expect(guest.getByRole('heading', { name: '当前没有正在进行的公开房间' })).toBeVisible();

      // 放行旧的 joinable 延迟响应
      delayedResolve();
      await guest.unroute('**/api/rooms?*filter=joinable*');
      await guest.unroute('**/api/rooms?*filter=playing*');

      // 等待片刻，验证过期幽灵房绝不会覆盖到“进行中”标签页内
      await guest.waitForTimeout(500);
      await expect(guest.locator('.lobby-room-card', { hasText: '不应出现的过期幽灵房' })).toHaveCount(0);

      // 切回“可加入”，能正常恢复拉取最新权威列表
      await guest.getByRole('tab', { name: '可加入' }).click();
      await expect(card).toBeVisible();

      // 明确核验被注入的 500 网络错误，同时确保没有其他未预期的控制台错误
      expect(guestConsole.errors.some((err) => err.includes('500'))).toBe(true);
      const unexpectedGuestErrors = guestConsole.errors.filter((err) => !err.includes('500'));
      expect(unexpectedGuestErrors).toEqual([]);
      expect(hostConsole.errors).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('旁观房间世代保护（generation guard）：延迟旧响应切换房间不串房、不误关订阅与开局后更多面板Esc控制', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const visitorContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const visitor = await visitorContext.newPage();

    const hostConsole = watchConsole(host);
    const guestConsole = watchConsole(guest);
    const visitorConsole = watchConsole(visitor);

    try {
      // 1. 房主创建房间 A
      await host.goto('/');
      await host.getByLabel('你的昵称').fill('房主阿A');
      await host.getByLabel('房间名称').fill('旁观世代测试桌A');
      await host.getByLabel('人数上限').fill('4');
      await paceForRateLimit();
      await host.getByRole('button', { name: '创建房间', exact: true }).click();
      await expect(host).toHaveURL(/\/room\/[0-9]{6}$/);
      const codeA = new URL(host.url()).pathname.split('/').pop()!;

      // 2. 为访客安装 WebSocket 代理以支持主动断开重连
      let wsProxy: any = null;
      await visitor.routeWebSocket(/\/socket\.io\/.*/, (ws) => {
        const server = ws.connectToServer();
        wsProxy = server;
        server.onMessage((msg) => ws.send(msg));
        ws.onMessage((msg) => server.send(msg));
      });

      // 访客进入房间 A 旁观
      await visitor.goto(`/room/${codeA}/watch`);
      await expect(visitor.getByRole('heading', { name: '旁观世代测试桌A' })).toBeVisible();
      await expect(visitor.getByText('只读旁观', { exact: true })).toBeVisible();
      await expect(visitor.getByText('已连接', { exact: true })).toBeVisible();

      // 3. 房主在另一个标签页创建房间 B
      const hostB = await hostContext.newPage();
      await hostB.goto('/');
      await hostB.getByLabel('你的昵称').fill('房主阿B');
      await hostB.getByLabel('房间名称').fill('旁观世代测试桌B');
      await hostB.getByLabel('人数上限').fill('4');
      await paceForRateLimit();
      await hostB.getByRole('button', { name: '创建房间', exact: true }).click();
      await expect(hostB).toHaveURL(/\/room\/[0-9]{6}$/);
      const codeB = new URL(hostB.url()).pathname.split('/').pop()!;

      // 4. 为房间 A 的 watch 接口设置延迟的 SPECTATING_DISABLED 错误模拟（模拟房间 A 重连慢刷新）
      let delayARequestStarted: () => void = () => {};
      const delayARequestStartedPromise = new Promise<void>((resolve) => {
        delayARequestStarted = resolve;
      });
      let releaseAResponse: () => void = () => {};
      const releaseAResponsePromise = new Promise<void>((resolve) => {
        releaseAResponse = resolve;
      });

      await visitor.route(`**/api/rooms/${codeA}/watch*`, async (route) => {
        delayARequestStarted();
        await releaseAResponsePromise;
        try {
          await route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'SPECTATING_DISABLED', message: '房间A已关闭旁观' } }),
          });
        } catch {
          // 客户端若已 abort 该请求则忽略已处理错误
        }
      });

      // 触发 visitor 端的断开重连，在重连机制下真正触发一次房间 A 的 GET /watch 刷新请求
      if (wsProxy) {
        wsProxy.close();
      }
      // 确认房间 A 的重连刷新延迟请求确实已在途
      await delayARequestStartedPromise;

      // 5. 访客在同一页面 SPA 导航从房间 A 切换到房间 B 旁观（保持同一 document 测试世代守卫）
      await visitor.evaluate((targetUrl) => {
        window.history.pushState({}, '', targetUrl);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, `/room/${codeB}/watch`);

      await expect(visitor.getByRole('heading', { name: '旁观世代测试桌B' })).toBeVisible();
      await expect(visitor.getByText('只读旁观', { exact: true })).toBeVisible();
      await expect(visitor.getByText('已连接', { exact: true })).toBeVisible();

      // 6. 此时放行房间 A 的旧错误响应
      releaseAResponse();
      await visitor.unroute(`**/api/rooms/${codeA}/watch*`);
      await visitor.waitForTimeout(500);

      // 断言：房间 A 的旧响应绝不能把房间 B 的订阅关掉，房间 B 依然正常旁观且无 alert
      await expect(visitor.getByRole('alert')).toHaveCount(0);
      await expect(visitor.getByRole('heading', { name: '旁观世代测试桌B' })).toBeVisible();
      await expect(visitor.getByText('已连接', { exact: true })).toBeVisible();

      // 7. 测试 RoomHeader 开局后全宽度紧凑与“更多”面板交互（Esc 关闭与焦点合理）
      // guest 加入房间 B 并准备
      await guest.goto(`/room/${codeB}`);
      await guest.getByLabel('你的昵称').fill('伴玩客');
      await paceForRateLimit();
      await guest.getByRole('button', { name: '加入房间' }).click();
      await toggleReady(guest);

      // 房主 B 开局
      await startGame(hostB);

      // 验证开局后 RoomHeader 呈紧凑单行：“提前结束”与“离开房间”不在 DOM 中无条件可见
      const moreBtn = hostB.getByRole('button', { name: '更多' });
      await expect(moreBtn).toBeVisible();
      await expect(hostB.getByRole('button', { name: '提前结束' })).toHaveCount(0);

      // 点击“更多”展开面板
      await moreBtn.click();
      const endBtn = hostB.getByRole('button', { name: '提前结束' });
      await expect(endBtn).toBeVisible();

      // 按 Esc 键关闭更多面板，焦点应当回到“更多”按钮
      await hostB.keyboard.press('Escape');
      await expect(hostB.getByRole('button', { name: '提前结束' })).toHaveCount(0);
      await expect(moreBtn).toBeFocused();

      // 再次点击“更多”，提前结束游戏
      await moreBtn.click();
      await hostB.getByRole('button', { name: '提前结束' }).click();
      await hostB.getByRole('dialog', { name: '提前结束本局？' }).getByRole('button', { name: '确认结束' }).click();
      await expect(hostB.getByRole('heading', { name: '本局小结' })).toBeVisible();

      await hostB.close();
      expect(hostConsole.errors).toEqual([]);
      expect(guestConsole.errors).toEqual([]);
      // 过滤房间 A 预期 403 控制台日志，确认无其它未预期的错误
      const unexpectedVisitorErrors = visitorConsole.errors.filter(
        (err) => !err.includes('403') && !err.includes(codeA),
      );
      expect(unexpectedVisitorErrors).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
      await visitorContext.close();
    }
  });

  test('大厅慢网络加载更多跨越5秒轮询：有效分页数据、按钮不永久卡死且轮询不中断在途请求', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const consoleWatch = watchConsole(page);

    const roomPage1 = {
      code: '100001',
      name: '慢网络第一桌',
      status: 'waiting' as const,
      playerCount: 1,
      onlinePlayerCount: 1,
      maxPlayers: 4,
      rulesetName: '经典大奖博饼',
      endCondition: { mode: 'all-prizes' as const },
      canJoin: true,
      allowSpectators: true,
      createdAt: 1700000000000,
    };

    const roomPage2 = {
      code: '100002',
      name: '慢网络第二桌',
      status: 'waiting' as const,
      playerCount: 2,
      onlinePlayerCount: 2,
      maxPlayers: 4,
      rulesetName: '经典大奖博饼',
      endCondition: { mode: 'all-prizes' as const },
      canJoin: true,
      allowSpectators: true,
      createdAt: 1699999000000,
    };

    // 拦截大厅接口：第一页返回 roomPage1 带有 nextCursor: 'cursor-2'
    await page.route('**/api/rooms?*filter=joinable*', async (route) => {
      const url = new URL(route.request().url());
      const cursor = url.searchParams.get('cursor');
      if (!cursor) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            rooms: [roomPage1],
            nextCursor: 'cursor-2',
          }),
        });
        return;
      }

      // 第二页：延迟 5.5 秒响应（超过 5 秒轮询周期），验证加载更多不被 5 秒轮询打断或导致按钮卡死
      await page.waitForTimeout(5500);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          rooms: [roomPage2],
          nextCursor: null,
        }),
      });
    });

    await page.goto('/lobby');
    await expect(page.locator('.lobby-room-card', { hasText: '慢网络第一桌' })).toBeVisible();

    // 找到“加载更多”按钮并点击
    const loadMoreBtn = page.getByRole('button', { name: '加载更多', exact: true });
    await expect(loadMoreBtn).toBeVisible();
    await loadMoreBtn.click();

    // 点击后按钮立即呈现加载中状态“正在加载更多…”且被禁用
    await expect(page.getByRole('button', { name: '正在加载更多…' })).toBeVisible();
    await expect(page.getByRole('button', { name: '正在加载更多…' })).toBeDisabled();

    // 等待跨越 5 秒轮询周期并完成加载：第二桌卡片顺利展示
    const secondCard = page.locator('.lobby-room-card', { hasText: '慢网络第二桌' });
    await expect(secondCard).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.lobby-room-card', { hasText: '慢网络第一桌' })).toBeVisible();

    // 断言：由于 nextCursor 为 null，加载更多按钮正常消失（未卡在“正在加载更多…”）
    await expect(page.getByRole('button', { name: '正在加载更多…' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0);

    await page.unroute('**/api/rooms?*filter=joinable*');
    expect(consoleWatch.errors).toEqual([]);
  });

  test('旁观路由凭证恢复回归：失效旧凭证降级为只读旁观并仅清理当前房间、有效凭证恢复成员路由、网络错误保留凭证', async ({
    browser,
  }) => {
    test.setTimeout(120_000);

    const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });

    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    const hostConsole = watchConsole(host);
    const guestConsole = watchConsole(guest);

    try {
      // 1. 房主创建房间
      await host.goto('/');
      await host.getByLabel('你的昵称').fill('房主小陈');
      await host.getByLabel('房间名称').fill('旁观凭证降级桌');
      await host.getByLabel('人数上限').fill('4');
      await paceForRateLimit();
      await host.getByRole('button', { name: '创建房间', exact: true }).click();
      await expect(host).toHaveURL(/\/room\/[0-9]{6}$/);
      const code = new URL(host.url()).pathname.split('/').pop()!;

      // 2. guest 本机存有当前房间的失效旧凭证，以及另一个房间 999999 的凭证
      await guest.goto('/');
      await guest.evaluate(
        ({ roomCode }) => {
          localStorage.setItem(
            `bobing.membership.${roomCode}`,
            JSON.stringify({ roomCode, playerId: 'stale-player-id', token: 'invalid-stale-token' }),
          );
          localStorage.setItem(
            'bobing.membership.999999',
            JSON.stringify({ roomCode: '999999', playerId: 'other-player-id', token: 'valid-other-token' }),
          );
        },
        { roomCode: code },
      );

      // 3. guest 访问 /room/:code/watch
      await guest.goto(`/room/${code}/watch`);

      // 验证：服务端判定 INVALID_TOKEN 后，平滑降级为只读旁观，不掉入加入房间落地页，URL 保持 /watch
      await expect(guest).toHaveURL(new RegExp(`/room/${code}/watch$`));
      await expect(guest.getByText('只读旁观', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(guest.getByRole('button', { name: '加入房间' })).toHaveCount(0);

      // 验证：仅清理了当前房间的凭证，另一个房间 999999 的凭证被完好保留
      const remainingStorage = await guest.evaluate(
        ({ roomCode }) => {
          return {
            current: localStorage.getItem(`bobing.membership.${roomCode}`),
            other: localStorage.getItem('bobing.membership.999999'),
          };
        },
        { roomCode: code },
      );
      expect(remainingStorage.current).toBeNull();
      expect(remainingStorage.other).not.toBeNull();

      // 4. guest 在旁观状态下点击“我要入座”，填昵称成为真实成员
      await guest.getByRole('button', { name: '我要入座' }).first().click();
      const seatDialog = guest.getByRole('dialog', { name: '入座「旁观凭证降级桌」' });
      await seatDialog.getByLabel('你的昵称').fill('降级后入座客');
      await paceForRateLimit();
      await seatDialog.getByRole('button', { name: '确认入座' }).click();

      // 入座成功后恢复成员路由 /room/:code
      await expect(guest).toHaveURL(new RegExp(`/room/${code}$`));
      await expect(guest.getByRole('button', { name: '准备好了' })).toBeVisible();

      // 5. 验证有效凭证：在已拥有有效凭证时再次访问 /room/:code/watch，经服务端验证后自动恢复为成员路由
      await guest.goto(`/room/${code}/watch`);
      await expect(guest).toHaveURL(new RegExp(`/room/${code}$`));
      await expect(guest.getByRole('button', { name: '准备好了' })).toBeVisible();

      // 6. 验证网络错误（loadError）不清除本地凭证：
      // 拦截 /api/rooms/:code/state 返回 500
      await guest.route(`**/api/rooms/${code}/state*`, async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '网络服务临时异常' } }),
        });
      });

      // 刷新页面，触发网络错误
      await guest.reload();
      await expect(guest.getByRole('heading', { name: '暂时无法进入房间' })).toBeVisible();
      await expect(guest.getByText('本机保存的房间身份仍然保留')).toBeVisible();

      // 验证：本地凭证未被清除！
      const tokenAfterNetworkError = await guest.evaluate(
        ({ roomCode }) => {
          return localStorage.getItem(`bobing.membership.${roomCode}`);
        },
        { roomCode: code },
      );
      expect(tokenAfterNetworkError).not.toBeNull();

      // 解除网络拦截并点击重试，验证恢复成员视图
      await guest.unroute(`**/api/rooms/${code}/state*`);
      await guest.getByRole('button', { name: '重试' }).click();
      await expect(guest.getByRole('button', { name: '准备好了' })).toBeVisible();

      // 检查控制台：guest 会有 401（stale token）和 500（network error）预期网络错误，按预期过滤
      const unexpectedGuestErrors = guestConsole.errors.filter(
        (err) => !err.includes('401') && !err.includes('500') && !err.includes('INVALID_TOKEN'),
      );
      expect(unexpectedGuestErrors).toEqual([]);
      expect(hostConsole.errors).toEqual([]);
    } finally {
      await hostContext.close();
      await guestContext.close();
    }
  });
});
