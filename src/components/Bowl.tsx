/**
 * 瓷碗：CSS 径向渐变自绘的俯视青白瓷碗，内部错落摆放 6 颗点阵骰子。
 * 支持分阶段运动状态（tumbling → landing → colliding → settling → idle）与逐颗停稳（settledCount 0..6）。
 * 保留 .bowl .dice .dice-pip--on 结构供无障碍与真实点阵验证。
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { DicePhase } from '../hooks/useDiceAnimation.js';
import { Dice } from './Dice.js';
import type { DiceSize } from './Dice.js';

export type BowlSize = 'hero' | 'game' | 'compact';

/** 六颗骰子在碗内的位置（百分比）与轻微旋转，保证点数互不遮挡。 */
const SLOTS: ReadonlyArray<{ left: string; top: string; tilt: number }> = [
  { left: '15%', top: '16%', tilt: -9 },
  { left: '40%', top: '9%', tilt: 7 },
  { left: '64%', top: '18%', tilt: -4 },
  { left: '19%', top: '54%', tilt: 11 },
  { left: '43%', top: '47%', tilt: -7 },
  { left: '65%', top: '56%', tilt: 6 },
];

const DICE_SIZE: Readonly<Record<BowlSize, DiceSize>> = {
  hero: 'lg',
  game: 'lg',
  compact: 'md',
};

export interface BowlProps {
  /** 六颗骰子的点数；空数组或 null 表示还没掷出。 */
  dice: readonly number[] | null;
  spinning?: boolean;
  phase?: DicePhase;
  settledCount?: number;
  size?: BowlSize;
  /** 碗下方的说明文字（结果标题）。 */
  caption?: ReactNode;
  /** 主视觉用途时整块作为装饰，不进入无障碍树。 */
  decorative?: boolean;
  className?: string;
}

export function Bowl({
  dice,
  spinning = false,
  phase = 'idle',
  settledCount = 6,
  size = 'game',
  caption,
  decorative = false,
  className = '',
}: BowlProps): ReactElement {
  const faces: Array<number | null> = Array.from({ length: 6 }, (_, index) => dice?.[index] ?? null);
  const classes = ['bowl-wrap', `bowl-wrap--${size}`, className].filter(Boolean).join(' ');
  const activePhase: DicePhase = spinning && phase === 'idle' ? 'tumbling' : phase;

  return (
    <div className={classes}>
      <div
        className={`bowl ${spinning ? 'bowl--spinning' : ''}`}
        data-phase={activePhase}
        data-settled-count={settledCount}
        {...(decorative ? { 'aria-hidden': true as const } : {})}
      >
        <div className="bowl-rim" aria-hidden="true" />
        <div className="bowl-inner" aria-hidden="true" />
        <div className="bowl-dice">
          {faces.map((value, index) => {
            const slot = SLOTS[index]!;
            const isSettled = !spinning || index < settledCount;
            const slotStyle: CSSProperties & { '--die-index': number } = {
              left: slot.left,
              top: slot.top,
              '--die-index': index,
            };
            return (
              <span
                key={index}
                className={`bowl-slot ${isSettled ? 'bowl-slot--settled' : 'bowl-slot--moving'}`}
                data-settled={isSettled ? 'true' : 'false'}
                style={slotStyle}
              >
                <Dice
                  value={value}
                  size={DICE_SIZE[size]}
                  tilt={slot.tilt}
                  decorative={decorative || !isSettled}
                />
              </span>
            );
          })}
        </div>
      </div>
      {caption ? <p className="bowl-caption">{caption}</p> : null}
    </div>
  );
}
