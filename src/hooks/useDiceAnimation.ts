/**
 * 骰子动画：碗里显示的永远是**最新一条权威记录**，中间帧只是装饰。
 *
 * 设计要点（任何一条回归都会让两端骰子不一致）：
 *  - 唯一驱动源是 `gameNumber + 最新记录 id` 这个**原始值键**。完整快照每次都会新建对象，
 *    如果 effect 依赖记录对象或数组，presence/重连/别人掷骰产生的快照会误判成“新事件”，
 *    把还没走完的 900ms 计时器清掉，骰子就停在随机中帧或空白面上。
 *  - 对象身份不变（同一个键）时既不重播，也不动已有计时器；计时器只在“真的来了新事件”时被替换。
 *  - 自己掷出的记录才做 900ms 旋转；其他玩家/刷新恢复直接显示服务端点数。
 *  - 投掷请求结束但没有产生新记录（失败/超时未受理）时退出旋转并回到权威点数，不把随机中帧当结果。
 *  - `gameNumber` 变化（再开一局）时清空展示。
 *  - 超时记录不带骰子：只更新文案，保留上一手权威点数。
 *  - `prefers-reduced-motion` 时不做旋转，直接淡入结果。
 */

import { useEffect, useRef, useState } from 'react';
import type { RoomState, RollRecord } from '../../shared/types.js';

const SPIN_MS = 900;
const FRAME_MS = 90;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function randomFaces(): number[] {
  return Array.from({ length: 6 }, () => 1 + Math.floor(Math.random() * 6));
}

export interface DiceAnimationState {
  dice: number[] | null;
  spinning: boolean;
  /** 本机刚停下的那条记录，用于结果区的淡入强调。 */
  revealed: RollRecord | null;
}

export function useDiceAnimation(room: RoomState | null, playerId: string, rollPending: boolean): DiceAnimationState {
  const [dice, setDice] = useState<number[] | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [revealed, setRevealed] = useState<RollRecord | null>(null);

  const gameNumber = typeof room?.gameNumber === 'number' ? room.gameNumber : 0;
  const history = room?.history ?? [];
  const latest: RollRecord | null = history.length > 0 ? history[history.length - 1]! : null;

  // 全部用原始值参与依赖判断，绝不用对象/数组引用
  const latestKey = latest ? `${gameNumber}:${latest.id}` : '';
  const latestReason = latest?.reason ?? null;
  const latestDiceKey = latest?.dice.join(',') ?? '';
  const latestIsMine = latest !== null && latest.playerId === playerId;

  // 本局的权威点数：最后一条真实掷骰记录（超时不产生点数）
  const authorityKey = (() => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const record = history[index]!;
      if (record.reason === 'rolled' && record.dice.length === 6) return record.dice.join(',');
    }
    return '';
  })();

  const appliedKeyRef = useRef('');
  const authorityKeyRef = useRef('');
  const latestKeyRef = useRef('');
  const rollStartKeyRef = useRef<string | null>(null);
  const revealTimerRef = useRef<number | null>(null);

  authorityKeyRef.current = authorityKey;
  latestKeyRef.current = latestKey;

  const clearRevealTimer = (): void => {
    if (revealTimerRef.current !== null) {
      window.clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  };

  // 1) 再开一局 / 进入另一局：清空上一局的骰子、结果与计时器
  useEffect(() => {
    appliedKeyRef.current = '';
    clearRevealTimer();
    setDice(null);
    setRevealed(null);
    setSpinning(false);
    return clearRevealTimer;
  }, [gameNumber]);

  // 2) 唯一权威事件：按 gameNumber + 记录 id 应用，同一个键不重播也不动计时器
  useEffect(() => {
    if (!latest || latestKey.length === 0) return undefined;
    if (appliedKeyRef.current === latestKey) return undefined;
    appliedKeyRef.current = latestKey;
    clearRevealTimer();

    // 超时没有骰子：只更新文案（显示最新超时而不是旧中奖），碗里保留上一手权威点数
    if (latestReason === 'timeout') {
      setDice(authorityKey.length > 0 ? authorityKey.split(',').map(Number) : null);
      setSpinning(false);
      setRevealed(latest);
      return undefined;
    }

    // 别人的结果：两端立刻显示同一份服务端点数，本机不生成任何中间结果
    if (!latestIsMine) {
      setDice(latest.dice);
      setSpinning(false);
      setRevealed(latest);
      return undefined;
    }

    // 自己的结果：900ms 后停在服务端点数
    if (prefersReducedMotion()) {
      setDice(latest.dice);
      setSpinning(false);
      setRevealed(latest);
      return undefined;
    }

    let elapsed = 0;
    setSpinning(true);
    const timer = window.setInterval(() => {
      elapsed += FRAME_MS;
      if (elapsed >= SPIN_MS) {
        window.clearInterval(timer);
        if (revealTimerRef.current === timer) revealTimerRef.current = null;
        setDice(latest.dice);
        setSpinning(false);
        setRevealed(latest);
        return;
      }
      setDice(randomFaces());
    }, FRAME_MS);
    revealTimerRef.current = timer;
    return undefined;
  }, [gameNumber, latestKey, latestReason, latestDiceKey, latestIsMine]);

  // 3) 请求中装饰性滚动；请求结束却没有新记录（失败）时回到权威点数
  useEffect(() => {
    if (rollPending) {
      rollStartKeyRef.current = latestKeyRef.current;
      setSpinning(true);
      setRevealed(null);
      if (prefersReducedMotion()) return undefined;
      const timer = window.setInterval(() => setDice(randomFaces()), FRAME_MS + 30);
      return () => window.clearInterval(timer);
    }

    const startedFrom = rollStartKeyRef.current;
    rollStartKeyRef.current = null;
    if (startedFrom !== null && appliedKeyRef.current === startedFrom) {
      // 没有产生新的权威记录：停止随机动画，回到服务端权威点数（可能为空面）
      const authoritative = authorityKeyRef.current.length > 0 ? authorityKeyRef.current.split(',').map(Number) : null;
      setDice(authoritative);
      setSpinning(false);
    }
    return undefined;
  }, [rollPending]);

  return { dice, spinning, revealed };
}
