/**
 * 本机音效开关：默认关闭（false），保存在当前浏览器 `bobing.sound-enabled.v1`。
 * 隐私模式或存储受限时自动降级为当前页面会话内生效，不抛异常。
 */

import { useCallback, useState } from 'react';

export const SOUND_ENABLED_STORAGE_KEY = 'bobing.sound-enabled.v1';

export function readSoundEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(SOUND_ENABLED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeSoundEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(SOUND_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // 隐私模式或配额受限时忽略持久化错误，内存状态仍生效
  }
}

export function useSoundSettings(): {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(() => readSoundEnabled());

  const setEnabled = useCallback((next: boolean): void => {
    setEnabledState(next);
    writeSoundEnabled(next);
  }, []);

  return { enabled, setEnabled };
}
