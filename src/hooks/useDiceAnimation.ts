/**
 * 骰子动画：碗里显示的永远是**最新一条权威记录**，中间帧只是装饰。
 *
 * 核心约束：
 *  - 唯一事件键为 `gameNumber + 最新记录 id`。完整快照每次新建引用不会打断进行中的计时器。
 *  - 首次挂载/刷新/重连先直接消费现有权威记录，不触发动画（`hydratedGameRef` + `armedRollRef`）。
 *  - 只有本机通过 `rollPending` 新发起的本人投掷才授权执行分阶段动画（tumbling → landing → colliding → settling → idle），
 *    并让六颗骰子从 `settledCount = 0..6` 逐颗停稳在服务端权威点数上。
 *  - 他人投掷直接显示服务端最终六个点数，不播放动画。
 *  - 请求失败且未产生新记录时立即退出装饰帧，恢复上一手权威点数。
 *  - `prefers-reduced-motion` 时直接展示权威结果，不等待装饰性计时器。
 */

import { useEffect, useRef, useState } from 'react';
import type { RoomState, RollRecord } from '../../shared/types.js';

export type DicePhase = 'idle' | 'tumbling' | 'landing' | 'colliding' | 'settling';

const TOTAL_ANIMATION_MS = 750;
const FRAME_MS = 75;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function randomDie(): number {
  return 1 + Math.floor(Math.random() * 6);
}

function randomFaces(): number[] {
  return Array.from({ length: 6 }, () => randomDie());
}

/** 已停稳的槽位固定为服务端权威点数，未停稳槽位使用装饰随机面。 */
function mixedFaces(authoritative: readonly number[], settledCount: number): number[] {
  return Array.from({ length: 6 }, (_, index) =>
    index < settledCount ? (authoritative[index] ?? 1) : randomDie(),
  );
}

export function stageForElapsed(elapsed: number): { phase: DicePhase; settledCount: number } {
  if (elapsed < 130) return { phase: 'tumbling', settledCount: 0 };
  if (elapsed < 240) return { phase: 'landing', settledCount: 1 };
  if (elapsed < 360) return { phase: 'colliding', settledCount: 2 };
  if (elapsed < 480) return { phase: 'colliding', settledCount: 3 };
  if (elapsed < 600) return { phase: 'settling', settledCount: 4 };
  if (elapsed < TOTAL_ANIMATION_MS) return { phase: 'settling', settledCount: 5 };
  return { phase: 'idle', settledCount: 6 };
}

export interface DiceAnimationState {
  dice: number[] | null;
  spinning: boolean;
  /** 本机刚停下的那条记录，用于结果区的淡入强调。 */
  revealed: RollRecord | null;
  phase: DicePhase;
  settledCount: number;
}

export function useDiceAnimation(
  room: RoomState | null,
  playerId: string,
  rollPending: boolean,
): DiceAnimationState {
  const [dice, setDice] = useState<number[] | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [revealed, setRevealed] = useState<RollRecord | null>(null);
  const [phase, setPhase] = useState<DicePhase>('idle');
  const [settledCount, setSettledCount] = useState<number>(6);

  const hasRoom = room !== null;
  const gameNumber = typeof room?.gameNumber === 'number' ? room.gameNumber : 0;
  const roomStatus = room?.status ?? null;
  const history = room?.history ?? [];
  const latest: RollRecord | null = history.length > 0 ? history[history.length - 1]! : null;

  const latestKey = latest ? `${gameNumber}:${latest.id}` : '';
  const latestReason = latest?.reason ?? null;
  const latestDiceKey = latest?.dice.join(',') ?? '';
  const latestIsMine = latest !== null && latest.playerId === playerId;

  const authorityKey = (() => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const record = history[index]!;
      if (record.reason === 'rolled' && record.dice.length === 6) return record.dice.join(',');
    }
    return '';
  })();

  const hydratedGameRef = useRef<number | null>(null);
  const appliedKeyRef = useRef('');
  const authorityKeyRef = useRef('');
  const latestKeyRef = useRef('');
  const armedRollRef = useRef(false);
  const prevRollPendingRef = useRef(false);
  const rollStartKeyRef = useRef<string | null>(null);
  const revealTimerRef = useRef<number | null>(null);
  const pendingTimerRef = useRef<number | null>(null);

  authorityKeyRef.current = authorityKey;
  latestKeyRef.current = latestKey;
  if (rollPending && !prevRollPendingRef.current) {
    armedRollRef.current = true;
    rollStartKeyRef.current = latestKey;
  }
  prevRollPendingRef.current = rollPending;

  const clearRevealTimer = (): void => {
    if (revealTimerRef.current !== null) {
      window.clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  };

  const clearPendingTimer = (): void => {
    if (pendingTimerRef.current !== null) {
      window.clearInterval(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  };

  const clearAllTimers = (): void => {
    clearRevealTimer();
    clearPendingTimer();
  };

  useEffect(() => clearAllTimers, []);

  // 1) 首次载入消费现有记录（不播旧动画） & 再开一局清空
  useEffect(() => {
    if (!hasRoom) return;

    const authoritative = authorityKey.length > 0 ? authorityKey.split(',').map(Number) : null;

    // 首次拿到权威房间快照：直接同步到最终状态，绝不重播历史动画
    if (hydratedGameRef.current === null) {
      hydratedGameRef.current = gameNumber;
      appliedKeyRef.current = latestKey;
      armedRollRef.current = false;
      rollStartKeyRef.current = null;
      clearAllTimers();
      setDice(authoritative);
      setSpinning(false);
      setPhase('idle');
      setSettledCount(authoritative ? 6 : 0);
      setRevealed(latest);
      return;
    }

    // 再开一局（gameNumber 变化或回到等待室）：清空上一局残留
    if (hydratedGameRef.current !== gameNumber || roomStatus === 'waiting') {
      hydratedGameRef.current = gameNumber;
      appliedKeyRef.current = latestKey;
      armedRollRef.current = false;
      rollStartKeyRef.current = null;
      clearAllTimers();
      if (history.length === 0) {
        setDice(null);
        setSpinning(false);
        setPhase('idle');
        setSettledCount(0);
        setRevealed(null);
      } else {
        setDice(authoritative);
        setSpinning(false);
        setPhase('idle');
        setSettledCount(authoritative ? 6 : 0);
        setRevealed(latest);
      }
    }
  }, [hasRoom, gameNumber, roomStatus, latestKey, authorityKey, history.length, latest]);

  // 2) 收到新的权威记录：按 gameNumber + 记录 ID 唯一触发（置于 rollPending effect 之前，确保同一次提交里先消费新记录）
  useEffect(() => {
    if (!hasRoom || hydratedGameRef.current === null) return undefined;
    if (!latest || latestKey.length === 0) return undefined;
    if (appliedKeyRef.current === latestKey) return undefined;

    appliedKeyRef.current = latestKey;
    clearAllTimers();

    // 超时记录没有骰子：只更新文案，碗里保留上一手权威点数
    if (latestReason === 'timeout') {
      armedRollRef.current = false;
      rollStartKeyRef.current = null;
      const authoritative = authorityKey.length > 0 ? authorityKey.split(',').map(Number) : null;
      setDice(authoritative);
      setSpinning(false);
      setPhase('idle');
      setSettledCount(authoritative ? 6 : 0);
      setRevealed(latest);
      return undefined;
    }

    // 别人的投掷：两端立即显示服务端权威点数，无动画
    if (!latestIsMine) {
      armedRollRef.current = false;
      rollStartKeyRef.current = null;
      setDice(latest.dice);
      setSpinning(false);
      setPhase('idle');
      setSettledCount(6);
      setRevealed(latest);
      return undefined;
    }

    // 本人的投掷：只有本机主动发起（wasArmed）且未开启减少动态效果才播放分阶段动画
    const wasArmed = armedRollRef.current;
    armedRollRef.current = false;
    rollStartKeyRef.current = null;

    if (!wasArmed || prefersReducedMotion()) {
      setDice(latest.dice);
      setSpinning(false);
      setPhase('idle');
      setSettledCount(6);
      setRevealed(latest);
      return undefined;
    }

    const targetDice = latest.dice;
    let elapsed = 0;
    setSpinning(true);
    setPhase('tumbling');
    setSettledCount(0);
    setDice(mixedFaces(targetDice, 0));

    const timer = window.setInterval(() => {
      elapsed += FRAME_MS;
      if (elapsed >= TOTAL_ANIMATION_MS) {
        window.clearInterval(timer);
        if (revealTimerRef.current === timer) revealTimerRef.current = null;
        setDice(targetDice);
        setSpinning(false);
        setPhase('idle');
        setSettledCount(6);
        setRevealed(latest);
        return;
      }
      const nextStage = stageForElapsed(elapsed);
      setPhase(nextStage.phase);
      setSettledCount(nextStage.settledCount);
      setDice(mixedFaces(targetDice, nextStage.settledCount));
    }, FRAME_MS);

    revealTimerRef.current = timer;
    return undefined;
  }, [hasRoom, gameNumber, latestKey, latestReason, latestDiceKey, latestIsMine, authorityKey, latest]);

  // 3) 本机发起投掷请求：在等待响应期间显示 tumbling 装饰帧；若请求结束仍无新结果则恢复上一手权威点数
  useEffect(() => {
    if (rollPending) {
      armedRollRef.current = true;
      if (rollStartKeyRef.current === null) {
        rollStartKeyRef.current = latestKeyRef.current;
      }
      clearPendingTimer();

      if (prefersReducedMotion()) {
        setSpinning(false);
        setPhase('idle');
        return undefined;
      }

      // 若同一提交内新记录已到达并启动了 revealTimerRef，不再启动随机等待帧
      if (revealTimerRef.current !== null) {
        return undefined;
      }

      setSpinning(true);
      setPhase('tumbling');
      setSettledCount(0);
      setRevealed(null);
      setDice(randomFaces());
      const timer = window.setInterval(() => {
        setDice(randomFaces());
      }, FRAME_MS);
      pendingTimerRef.current = timer;
      return () => {
        if (pendingTimerRef.current === timer) {
          window.clearInterval(timer);
          pendingTimerRef.current = null;
        }
      };
    }

    clearPendingTimer();
    const startedFrom = rollStartKeyRef.current;
    rollStartKeyRef.current = null;
    if (startedFrom !== null && latestKeyRef.current === startedFrom && appliedKeyRef.current === startedFrom) {
      // 请求结束但没有产生新记录（网络失败/超时未受理）：立即停止旋转，恢复权威点数
      armedRollRef.current = false;
      clearRevealTimer();
      const authoritative = authorityKeyRef.current.length > 0 ? authorityKeyRef.current.split(',').map(Number) : null;
      setDice(authoritative);
      setSpinning(false);
      setPhase('idle');
      setSettledCount(authoritative ? 6 : 0);
    }
    return undefined;
  }, [rollPending]);

  return {
    dice,
    spinning,
    revealed,
    phase,
    settledCount,
  };
}
