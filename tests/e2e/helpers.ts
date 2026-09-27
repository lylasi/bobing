/**
 * E2E 公共步骤：全部通过真实界面操作，不调用任何内部接口或作弊入口。
 * 唯一读取的“接口”是页面自身的 localStorage（用于验证身份是否被保存/保持）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export const SCREENSHOT_DIR = 'docs/screenshots';

mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * 跨 Playwright worker 进程共享的真实限流预算状态文件。
 * 服务端默认真实生产限流为：同 IP 每 60 秒最多 30 次创建/加入房间。
 * 保存在操作系统临时目录以跨 worker 同步滑动窗口历史；
 * 若设置了 E2E_BASE_URL 则按服务端 origin 隔离，否则按端口隔离。
 */
function getRateLimitScope(): string {
  if (process.env.E2E_BASE_URL) {
    try {
      const origin = new URL(process.env.E2E_BASE_URL).origin;
      return origin.replace(/[^a-zA-Z0-9_-]/g, '_');
    } catch {
      return process.env.E2E_BASE_URL.replace(/[^a-zA-Z0-9_-]/g, '_');
    }
  }
  return process.env.E2E_PORT ?? '3210';
}

const RATE_LIMIT_FILE = join(tmpdir(), `bobing-e2e-rate-${getRateLimitScope()}.json`);
const RATE_LIMIT_WINDOW_MS = 60_000;
/** 预算容量：使用生产上限 30（采用 29 安全容量留出单次防守余量） */
const RATE_LIMIT_BUDGET_CAPACITY = 29;

function readRateRecords(): number[] {
  try {
    if (!existsSync(RATE_LIMIT_FILE)) return [];
    const raw = readFileSync(RATE_LIMIT_FILE, 'utf-8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return (parsed as unknown[])
      .filter((ts): ts is number => typeof ts === 'number' && Number.isFinite(ts) && now - ts < RATE_LIMIT_WINDOW_MS)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function writeRateRecords(records: number[]): void {
  const content = JSON.stringify(records);
  const tempPath = `${RATE_LIMIT_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, RATE_LIMIT_FILE);
  } catch {
    try {
      writeFileSync(RATE_LIMIT_FILE, content, 'utf-8');
    } catch {
      // 兜底文件系统异常
    }
  }
}

/**
 * 在发起创建或加入房间操作前按真实生产配额（30次/分钟）做确定性节流：
 * 若当前 60 秒滑动窗口内已接近预算上限，循环等待最早记录滑出窗口所需的最短毫秒数。
 * 绝非盲目粗暴的无条件 sleep，保证测试快速且决不突破生产配额。
 */
export async function paceForRateLimit(cost = 1): Promise<void> {
  while (true) {
    const records = readRateRecords();
    const excess = records.length + cost - RATE_LIMIT_BUDGET_CAPACITY;
    if (excess <= 0) {
      const reservation = Date.now();
      for (let i = 0; i < cost; i++) {
        records.push(reservation);
      }
      writeRateRecords(records);
      break;
    }
    const targetOldest = records[excess - 1];
    if (typeof targetOldest !== 'number') {
      break;
    }
    const now = Date.now();
    const waitMs = RATE_LIMIT_WINDOW_MS - (now - targetOldest) + 300; // 300ms 安全余量防止服务端时钟微小偏差
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

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

/** 首页创建房间，返回房间码（rounds 参数代表选择“固定轮数”并设置对应轮数）。 */
export async function createRoom(
  page: Page,
  options: { nickname: string; roomName: string; maxPlayers: number; rounds: 5 | 10 | 20 },
): Promise<string> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '一碗骰声，满桌团圆。' })).toBeVisible();
  await page.getByLabel('你的昵称').fill(options.nickname);
  await page.getByLabel('房间名称').fill(options.roomName);
  await page.getByLabel('人数上限').fill(String(options.maxPlayers));
  await page.getByRole('radio', { name: '固定轮数' }).check();
  await page.getByRole('button', { name: `${options.rounds} 轮`, exact: true }).click();
  await paceForRateLimit();
  await page.getByRole('button', { name: '创建房间' }).click();
  await expect(page).toHaveURL(/\/room\/[A-Z0-9]{6}$/);
  const code = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByRole('heading', { name: options.roomName })).toBeVisible();
  return code;
}

/**
 * 对局中/结算后次操作（邀请亲友、音效、规则、提前结束、离开房间、房间设置）收纳在“更多”面板中。
 * 若“更多”面板未展开，先点击“更多”按钮展开。
 */
export async function openMoreMenuIfNeeded(page: Page): Promise<void> {
  const moreBtn = page.locator('.room-more-btn');
  if (await moreBtn.isVisible().catch(() => false)) {
    const isExpanded = await moreBtn.getAttribute('aria-expanded');
    if (isExpanded !== 'true') {
      await moreBtn.click();
      await expect(page.locator('#room-more-panel, .room-more-panel')).toBeVisible();
    }
  }
}

/** 打开邀请弹层读取链接后关闭（链接用于第二个浏览器上下文加入）。 */
export async function readInviteUrl(page: Page): Promise<string> {
  await openMoreMenuIfNeeded(page);
  await page.getByRole('button', { name: '邀请亲友' }).first().click();
  const dialog = page.getByRole('dialog', { name: '邀请亲友' });
  await expect(dialog).toBeVisible();
  const url = await dialog.getByLabel('邀请链接，可选中复制').inputValue();
  await expect(dialog.getByRole('img', { name: /邀请二维码/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  return url;
}

/** 通过邀请链接落地：先看到房间概况（断言真实系统房规名称），再输入昵称加入。 */
export async function joinByInvite(
  page: Page,
  inviteUrl: string,
  nickname: string,
  expectedRuleset = '持续顶状元',
): Promise<void> {
  await page.goto(inviteUrl);
  await expect(page.getByText('收到邀请')).toBeVisible();
  await expect(page.getByText(expectedRuleset).first()).toBeVisible();
  await page.getByLabel('你的昵称').fill(nickname);
  await paceForRateLimit();
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
  return page.locator('.record-list .record, .history-panel .record').count();
}

export async function prizeSnapshot(page: Page): Promise<string[]> {
  return page.locator('.prize-row .prize-count').allInnerTexts();
}

/** 最新一条记录里的骰子读法（无障碍标签），用于比对两端看到的手牌是否一致。 */
export async function latestDiceLabel(page: Page): Promise<string> {
  return page
    .locator('.record-list .record, .history-panel .record')
    .first()
    .locator('.dice-row')
    .first()
    .getAttribute('aria-label')
    .then((value) => value ?? '');
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
  return button.first().isEnabled();
}

export async function isFinished(page: Page): Promise<boolean> {
  return page.getByText('本局小结').isVisible().catch(() => false);
}

/**
 * 两个浏览器上下文轮流掷骰直到结算。
 * 权威展示阶段（约 750ms 动画 + 至少 1s 停留，单手约 1.75s–2.5s）期间不可掷骰，
 * 循环预算必须根据每手真实节奏设计，避免在展示阶段空轮转耗尽步数。
 */
export async function playUntilFinished(pages: Page[], maxRolls = 60): Promise<number> {
  let rolls = 0;
  const maxWaitLoops = maxRolls * 15;
  for (let loop = 0; loop < maxWaitLoops && rolls < maxRolls; loop += 1) {
    if (await isFinished(pages[0]!)) return rolls;
    let acted = false;
    for (const page of pages) {
      if (!(await isRollEnabled(page))) continue;
      const before = await rollCount(page);
      await page.getByRole('button', { name: '掷出好运' }).first().click();
      await expect(page.locator('.record-list .record, .history-panel .record')).toHaveCount(before + 1, { timeout: 30_000 });
      rolls += 1;
      acted = true;
      // 权威展示阶段：等待动画与结果停留进入下一轮
      await page.waitForTimeout(1_800);
      break;
    }
    if (!acted) await pages[0]!.waitForTimeout(300);
  }
  if (await isFinished(pages[0]!)) return rolls;
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
