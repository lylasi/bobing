/**
 * 1 秒时钟：超时跳过、暂停/恢复、房主离线转交、过期清理。
 *
 * 时钟只是 `RoomService.tick(now)` 的驱动器；所有判断都在服务层用
 * deadline/turnId/hostOfflineSince 复核，重复 tick 不会重复轮转。
 * 测试可直接调用 `service.tick(注入的时间)`，不必启动真实定时器。
 */

import type { RoomService } from './room-service.js';

export interface Clock {
  /** 手动执行一次（测试用），返回发生变化的房间码。 */
  runOnce(now?: number): string[];
  stop(): void;
}

export function startClock(service: RoomService, intervalMs = 1000): Clock {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      service.tick();
    } catch (error) {
      console.error('[bobing] 时钟 tick 失败', error);
    }
  }, intervalMs);
  // 定时器不应阻止进程退出
  timer.unref?.();

  return {
    runOnce(now?: number): string[] {
      return service.tick(now);
    },
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
