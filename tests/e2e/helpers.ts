/**
 * E2E 公共步骤：全部通过真实界面操作，不调用任何内部接口或作弊入口。
 * 唯一读取的“接口”是页面自身的 localStorage（用于验证身份是否被保存/保持）。
 */

import { mkdirSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const SCREENSHOT_DIR = 'docs/screenshots';

mkdirSync(SCREENSHOT_DIR, { recursive: true });

export interface ConsoleWatch {
  errors: string[];
}

/** 收集控制台错误与页面异常，用例结束时断言为空。 */
export function watchConsole(page: Page): ConsoleWatch {
  const watch: ConsoleWatch = { errors: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') watch.errors.push(message.text());
  });
  page.on('pageerror', (error) => watch.errors.push(String(error)));
  return watch;
}

/**
 * 全页截图前先回到页面顶部：`position: sticky` 的顶部导航在 fullPage 截图里会停在
 * 当前滚动位置（旧桌面结算截图就是这样被粘在中间、遮住状元卡的）。
 */
export async function screenshot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => await page.evaluate(() => window.scrollY), { timeout: 5_000 }).toBe(0);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

/** 首页创建房间，返回房间码。 */
export async function createRoom(
  page: Page,
  options: { nickname: string; roomName: string; maxPlayers: number; rounds: 5 | 10 | 20 },
): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '一碗骰声，满桌团圆。' })).toBeVisible();
  await page.getByLabel('你的昵称').fill(options.nickname);
  await page.getByLabel('房间名称').fill(options.roomName);
  await page.getByLabel('人数上限').fill(String(options.maxPlayers));
  await page.getByRole('button', { name: `${options.rounds} 轮` }).click();
  await page.getByRole('button', { name: '创建房间' }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{6}$/);
  const code = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: options.roomName })).toBeVisible();
  return code;
}

/** 打开邀请弹层读取链接后关闭（链接用于第二个浏览器上下文加入）。 */
export async function readInviteUrl(page: Page): Promise<string> {
  await page.getByRole('button', { name: '邀请亲友' }).first().click();
  const dialog = page.getByRole('dialog', { name: '邀请亲友' });
  await expect(dialog).toBeVisible();
  const url = await dialog.getByLabel('邀请链接，可选中复制').inputValue();
  await expect(dialog.getByRole('img', { name: /邀请二维码/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  return url;
}

/** 通过邀请链接落地：先看到房间概况，再输入昵称加入。 */
export async function joinByInvite(page: Page, inviteUrl: string, nickname: string): Promise<void> {
  await page.goto(inviteUrl);
  await expect(page.getByText('收到邀请')).toBeVisible();
  await expect(page.getByText('线上统一房规 v1').first()).toBeVisible();
  await page.getByLabel('你的昵称').fill(nickname);
  await page.getByRole('button', { name: '加入房间' }).click();
  await expect(page.getByRole('heading', { name: '等好友入席' })).toBeVisible();
}

export async function toggleReady(page: Page): Promise<void> {
  await page.getByRole('button', { name: '准备好了' }).click();
  await expect(page.getByRole('button', { name: '取消准备' })).toBeVisible();
}

export async function startGame(page: Page): Promise<void> {
  const start = page.getByRole('button', { name: '开始博饼' });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole('button', { name: '掷出好运' }).first()).toBeVisible();
}

export async function rollCount(page: Page): Promise<number> {
  return page.locator('.record').count();
}

export async function prizeSnapshot(page: Page): Promise<string[]> {
  return page.locator('.prize-row .prize-count').allInnerTexts();
}

/** 最新一条记录里的骰子读法（无障碍标签），用于比对两端看到的手牌是否一致。 */
export async function latestDiceLabel(page: Page): Promise<string> {
  return page.locator('.record').first().locator('.dice-row').first().getAttribute('aria-label').then((value) => value ?? '');
}

/** 最新一条权威记录的六个点数（超时记录没有骰子，返回空数组）。 */
export async function latestRecordDice(page: Page): Promise<number[]> {
  const label = await latestDiceLabel(page);
  const segment = label.includes('：') ? label.slice(label.lastIndexOf('：') + 1) : '';
  if (segment.length === 0) return [];
  return segment
    .split('、')
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isInteger(value));
}

/**
 * 读碗里六颗骰子**实际显示的点数**：每颗骰子亮起的点阵数量。
 * 只检查记录文字会漏掉“记录更新了但碗里还是旧骰子/空白面”的真实缺陷。
 */
export async function bowlPips(page: Page): Promise<number[]> {
  return page.locator('.bowl .dice').evaluateAll((nodes) => nodes.map((node) => node.querySelectorAll('.dice-pip--on').length));
}

export const EMPTY_BOWL_PIPS = [0, 0, 0, 0, 0, 0];

/**
 * 等碗停稳（没有装饰旋转）并断言碗里六颗骰子的**真实点阵**等于最新权威记录，
 * 返回权威点数。空碗、旧点数、卡在旋转中都会在这里失败。
 */
export async function expectBowlMatchesLatestRecord(page: Page, message = ''): Promise<number[]> {
  await expect(page.locator('.bowl--spinning')).toHaveCount(0, { timeout: 20_000 });
  const authority = await latestRecordDice(page);
  expect(authority, `${message}没有读到最新权威点数`).toHaveLength(6);
  await expect
    .poll(async () => await bowlPips(page), { timeout: 20_000, message: `${message}碗里点数与最新权威记录不一致` })
    .toEqual(authority);
  return authority;
}

/** 读取本浏览器为该房间保存的身份凭证（仅用于断言“是否被误清理”）。 */
export async function readMembership(page: Page, code: string): Promise<{ playerId: string; token: string } | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { playerId: string; token: string }) : null;
  }, `bobing.membership.${code.toUpperCase()}`);
}

export interface PaintedStats {
  width: number;
  height: number;
  /** 截图里出现过的颜色数量（每通道取高 5 位）：渐变瓷碗会有大量颜色，空白/塌缩色块只有几种。 */
  colors: number;
}

/**
 * 把元素截图后在本页里解码统计颜色数量。
 * 这是“截图肉眼检查”的可编程替代：主视觉塌缩成一片纯色、或整块没画出来时，颜色数量会骤降。
 */
export async function paintedColors(page: Page, selector: string): Promise<PaintedStats> {
  const buffer = await page.locator(selector).first().screenshot();
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) return { width: image.width, height: image.height, colors: 0 };
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const colors = new Set<number>();
    for (let index = 0; index < data.length; index += 4) {
      colors.add(((data[index]! >> 3) << 10) | ((data[index + 1]! >> 3) << 5) | (data[index + 2]! >> 3));
    }
    return { width: image.width, height: image.height, colors: colors.size };
  }, buffer.toString('base64'));
}

export async function isRollEnabled(page: Page): Promise<boolean> {
  const button = page.getByRole('button', { name: '掷出好运' });
  if ((await button.count()) === 0) return false;
  return button.isEnabled();
}

export async function isFinished(page: Page): Promise<boolean> {
  return page.getByText('本局小结').isVisible().catch(() => false);
}

/**
 * 两个浏览器上下文轮流掷骰直到结算。
 * 每次掷骰后等两端记录数一致，顺带校验共享同一份权威状态。
 */
export async function playUntilFinished(pages: Page[], maxSteps = 60): Promise<number> {
  for (let step = 0; step < maxSteps; step += 1) {
    if (await isFinished(pages[0]!)) return step;
    let acted = false;
    for (const page of pages) {
      if (!(await isRollEnabled(page))) continue;
      const before = await rollCount(page);
      await page.getByRole('button', { name: '掷出好运' }).click();
      await expect(page.locator('.record')).toHaveCount(before + 1, { timeout: 30_000 });
      acted = true;
      break;
    }
    if (!acted) await pages[0]!.waitForTimeout(400);
  }
  throw new Error('超过最大步数仍未结算，对局没有正常结束');
}

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 读取一批元素相对视口的矩形（用于“几何顺序”“矩形不相交”这类断言）。 */
export async function rectsOf(page: Page, selector: string): Promise<Rect[]> {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }),
  );
}

export async function rectOf(page: Page, selector: string): Promise<Rect> {
  const [first] = await rectsOf(page, selector);
  if (!first) throw new Error(`没有找到元素：${selector}`);
  return first;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** 每个元素里文字实际占用的行数（Range 的客户矩形个数）：>1 即“被拆成了多行”。 */
export async function textLineCounts(page: Page, selector: string): Promise<number[]> {
  return page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const lines = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
      // 同一行的多个文本片段（例如文字 + 子 span）会合并成同一个高度带
      const tops = new Set(lines.map((rect) => Math.round(rect.top / 4)));
      return tops.size;
    }),
  );
}

/** 倒计时读数（秒）：`剩余 31 秒` → 31；暂停/未开局时返回 null。 */
export async function countdownSeconds(page: Page): Promise<number | null> {
  const text = (await page.locator('.turn-countdown').first().innerText()).trim();
  const matched = /剩余\s*(\d+)\s*秒/.exec(text);
  return matched ? Number.parseInt(matched[1]!, 10) : null;
}

interface RecordBox {
  time: Rect | null;
  who: Rect | null;
  /** `.record-dice` 容器本身。 */
  dice: Rect | null;
  /** 六颗骰子元素实际占用的并集矩形（旧实现的 60px 列宽下会溢出容器、压到奖项文案上）。 */
  diceSpan: Rect | null;
  result: Rect | null;
  /** 整条记录的矩形，用于检查骰子行没有被裁掉。 */
  ownBox: Rect | null;
  /** 记录里实际渲染的骰子颗数（超时记录为 0）。 */
  diceCount: number;
  /** 最后一颗骰子的矩形。 */
  lastDice: Rect | null;
}

/**
 * 记录条的几何检查：骰子必须与时间/玩家/奖项文案三块互不重叠，
 * 有骰子的记录必须正好渲染 6 颗且最后一颗仍在记录范围内（不被裁掉/压到文案上）。
 *
 * 注意检查的是**六颗骰子元素本身的并集**而不是 `.record-dice` 容器：
 * 只量容器会漏掉「容器只有 60px、骰子溢出到奖项文案上」这类真实缺陷。
 * 同一份断言同时作用于局中「记录」Tab 与结算页「完整记录」。
 */
export async function expectRecordsLayoutSane(page: Page): Promise<number> {
  const boxes = await page.locator('.record').evaluateAll((nodes): RecordBox[] =>
    nodes.map((node) => {
      const rect = (selector: string): Rect | null => {
        const element = node.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
      };
      const diceNodes = Array.from(node.querySelectorAll('.record-dice .dice'));
      const dieBoxes = diceNodes.map((die) => die.getBoundingClientRect());
      const lastBox = dieBoxes.at(-1);
      const own = node.getBoundingClientRect();
      return {
        time: rect('.record-time'),
        who: rect('.record-who'),
        dice: rect('.record-dice'),
        diceSpan: dieBoxes.length
          ? {
              left: Math.min(...dieBoxes.map((box) => box.left)),
              right: Math.max(...dieBoxes.map((box) => box.right)),
              top: Math.min(...dieBoxes.map((box) => box.top)),
              bottom: Math.max(...dieBoxes.map((box) => box.bottom)),
            }
          : null,
        result: rect('.record-result'),
        // 节点自身就是 .record，不能再用 querySelector 找自己
        ownBox: { left: own.left, right: own.right, top: own.top, bottom: own.bottom },
        diceCount: diceNodes.length,
        lastDice: lastBox ? { left: lastBox.left, right: lastBox.right, top: lastBox.top, bottom: lastBox.bottom } : null,
      };
    }),
  );

  expect(boxes.length, '没有任何记录可检查').toBeGreaterThan(0);
  let withDice = 0;
  boxes.forEach((box, index) => {
    expect(box.dice, `第 ${index + 1} 条记录缺少骰子容器`).not.toBeNull();
    if (box.diceCount === 0) return;
    withDice += 1;
    expect(box.diceCount, `第 ${index + 1} 条记录的骰子不是 6 颗`).toBe(6);
    const dice = box.diceSpan!;
    for (const [name, other] of [
      ['时间', box.time],
      ['玩家', box.who],
      ['奖项文案', box.result],
    ] as const) {
      if (!other) continue;
      expect(
        overlaps(dice, other),
        `第 ${index + 1} 条记录的骰子与${name}矩形重叠：骰子 ${JSON.stringify(dice)} vs ${name} ${JSON.stringify(other)}`,
      ).toBe(false);
    }
    expect(box.lastDice!.right, `第 ${index + 1} 条记录最后一颗骰子超出了记录右边界`).toBeLessThanOrEqual(box.ownBox!.right + 1);
  });
  expect(withDice, '没有一条带骰子的记录可检查').toBeGreaterThan(0);
  return boxes.length;
}

/** 断言页面没有横向溢出（375/768/1440 都必须满足）。 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    const offenders: string[] = [];
    for (const element of Array.from(document.querySelectorAll('body *'))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right > root.clientWidth + 1 || rect.left < -1) {
        offenders.push(`${element.tagName.toLowerCase()}.${element.className || '(no-class)'} → ${Math.round(rect.left)}..${Math.round(rect.right)}`);
      }
    }
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, offenders: offenders.slice(0, 5) };
  });
  expect(overflow.scrollWidth, `页面出现横向溢出，元素：${overflow.offenders.join(' | ')}`).toBeLessThanOrEqual(overflow.clientWidth + 1);
}
