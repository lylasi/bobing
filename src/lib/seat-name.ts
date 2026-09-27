/**
 * 席位条昵称压缩（纯函数，仅用于呈现）。
 *
 * 窄屏席位条对每个昵称只留有限宽度：同前缀昵称（“团圆长昵称玩家01/02”）若按前缀截断
 * 就会变成同一个“团圆长昵…”，席位条随即失去“看清是谁在掷”的辨识作用。
 * 因此超过 5 个字素时保留前 2 + “…” + 后 2，让末位最有区分度的字符一定可见。
 *
 * 计数与切片按 Unicode 字素簇（grapheme）进行：emoji、家庭 emoji（👨‍👩‍👧‍👦）、
 * 变体选择符与组合字符（e + U+0301）都不会被从中拆开；非 BMP 字符也不会被截成半个代理对。
 * 原始昵称不被修改，调用方继续持有完整昵称（用于可访问名与完整昵称状态行）。
 */

/** 不超过该字素数时原样展示。 */
const MAX_VISIBLE_GRAPHEMES = 5;
const HEAD_GRAPHEMES = 2;
const TAIL_GRAPHEMES = 2;
const ELLIPSIS = '…';

let cachedSegmenter: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter === undefined) {
    cachedSegmenter =
      typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter('zh-Hans', { granularity: 'grapheme' })
        : null;
  }
  return cachedSegmenter;
}

/** 按字素簇拆分；运行环境缺少 Intl.Segmenter 时退化为码点拆分（至少不拆代理对）。 */
function toGraphemes(nickname: string): string[] {
  const segmenter = graphemeSegmenter();
  if (!segmenter) return Array.from(nickname);
  return Array.from(segmenter.segment(nickname), (part) => part.segment);
}

/**
 * ≤5 字素原样返回；>5 返回“前2…后2”。
 * 空串返回空串，不做补齐或默认值替换。
 */
export function compactSeatName(nickname: string): string {
  const graphemes = toGraphemes(nickname);
  if (graphemes.length <= MAX_VISIBLE_GRAPHEMES) return nickname;
  const head = graphemes.slice(0, HEAD_GRAPHEMES).join('');
  const tail = graphemes.slice(graphemes.length - TAIL_GRAPHEMES).join('');
  return `${head}${ELLIPSIS}${tail}`;
}
