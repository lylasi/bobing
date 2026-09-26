/**
 * 倒计时：只做显示。剩余时间以服务端 deadline 与校时后的服务端时间为准，
 * 本地倒计时到 0 不会授权任何操作（掷骰仍由服务端 deadline 判定）。
 */

import { useEffect, useState } from 'react';

export function useCountdown(deadline: number | null, now: () => number, intervalMs = 250): number {
  const [remaining, setRemaining] = useState(() => (deadline === null ? 0 : Math.max(0, deadline - now())));

  useEffect(() => {
    if (deadline === null) {
      setRemaining(0);
      return undefined;
    }
    const update = (): void => setRemaining(Math.max(0, deadline - now()));
    update();
    const timer = window.setInterval(update, intervalMs);
    return () => window.clearInterval(timer);
  }, [deadline, now, intervalMs]);

  return remaining;
}
