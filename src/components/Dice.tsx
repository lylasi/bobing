/**
 * 骰子：真实 3×3 点阵，不用 emoji 或图片。
 * 一点与四点为朱砂红，其余为深褐；每颗骰子都有可读的点数语义。
 */

import type { ReactElement } from 'react';

export type DiceSize = 'lg' | 'md' | 'sm' | 'xs';

/** 每个点数在 3×3 网格中的点位（索引 0–8，行优先）。 */
const PIP_CELLS: Readonly<Record<number, readonly number[]>> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

export interface DiceProps {
  /** null 表示尚未掷出（等待开局），显示空白骰面。 */
  value: number | null;
  size?: DiceSize;
  /** 纯装饰（例如首页主视觉、动画中间帧）时不参与无障碍树。 */
  decorative?: boolean;
  tilt?: number;
  className?: string;
}

export function Dice({ value, size = 'md', decorative = false, tilt = 0, className = '' }: DiceProps): ReactElement {
  const cells = value === null ? [] : (PIP_CELLS[value] ?? []);
  const red = value === 1 || value === 4;
  const label = value === null ? '骰子，尚未掷出' : `骰子，${value}点`;
  const classes = ['dice', `dice--${size}`, red ? 'dice--red' : '', className].filter(Boolean).join(' ');

  return (
    <span
      className={classes}
      style={tilt ? { transform: `rotate(${tilt}deg)` } : undefined}
      {...(decorative
        ? { 'aria-hidden': true as const }
        : { role: 'img', 'aria-label': label })}
    >
      {Array.from({ length: 9 }, (_, index) => (
        <span key={index} className={cells.includes(index) ? 'dice-pip dice-pip--on' : 'dice-pip'} />
      ))}
    </span>
  );
}

export interface DiceRowProps {
  dice: readonly number[];
  size?: DiceSize;
  className?: string;
  /** 供屏幕阅读器朗读的完整点数，默认由 dice 生成。 */
  label?: string;
}

/** 一行小骰子：记录、规则示例、结算明细使用。整体作为一张图朗读。 */
export function DiceRow({ dice, size = 'xs', className = '', label }: DiceRowProps): ReactElement | null {
  if (dice.length === 0) return null;
  const text = label ?? `六颗骰子：${dice.join('、')}`;
  return (
    <span className={`dice-row ${className}`.trim()} role="img" aria-label={text}>
      {dice.map((value, index) => (
        <Dice key={index} value={value} size={size} decorative />
      ))}
    </span>
  );
}
