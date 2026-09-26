/**
 * 本地骰子音效合成器（Web Audio API）：
 * - 通过短噪声突发与瓷碗泛音包络合成翻滚、落碗、碰撞与停稳声，不加载外部音频资源。
 * - 只在本人新发起投掷且已开启音效时调用，刷新、重连、历史快照或他人投掷绝不发声。
 * - start / impact / stop / dispose 均可安全重复调用；静音、失败或卸载时立即清理所有计时器与音频节点。
 */

export interface DiceSoundController {
  unlock(): Promise<void>;
  start(): void;
  impact(intensity?: number): void;
  stop(): void;
  dispose(): void;
}

type AudioContextConstructor = typeof AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof globalThis === 'undefined') return null;
  const win = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

/** 一次完整掷骰的碰撞节奏时间点（毫秒，上限 < 800ms，绝不无限播放）。 */
const ROLL_IMPACT_SCHEDULE: ReadonlyArray<{ delayMs: number; intensity: number }> = [
  { delayMs: 0, intensity: 0.92 },
  { delayMs: 75, intensity: 0.78 },
  { delayMs: 165, intensity: 1.0 },
  { delayMs: 255, intensity: 0.85 },
  { delayMs: 350, intensity: 0.72 },
  { delayMs: 445, intensity: 0.64 },
  { delayMs: 545, intensity: 0.52 },
  { delayMs: 650, intensity: 0.42 },
  { delayMs: 740, intensity: 0.34 },
];

export function createDiceSound(): DiceSoundController {
  let ctx: AudioContext | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let disposed = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const activeSources = new Set<AudioScheduledSourceNode>();
  const activeGains = new Set<GainNode>();

  const ensureContext = (): AudioContext | null => {
    if (disposed) return null;
    if (ctx) return ctx;
    const Ctor = getAudioContextConstructor();
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
      return ctx;
    } catch {
      return null;
    }
  };

  const ensureNoiseBuffer = (audioCtx: AudioContext): AudioBuffer | null => {
    if (noiseBuffer) return noiseBuffer;
    try {
      const length = Math.max(256, Math.floor(audioCtx.sampleRate * 0.045));
      const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i += 1) {
        const decay = 1 - i / length;
        data[i] = (Math.random() * 2 - 1) * decay * decay;
      }
      noiseBuffer = buffer;
      return buffer;
    } catch {
      return null;
    }
  };

  const unlock = async (): Promise<void> => {
    const audioCtx = ensureContext();
    if (!audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
    } catch {
      // 浏览器策略阻止自动播放时静默忽略，绝不阻塞掷骰请求
    }
  };

  const impact = (intensity = 1): void => {
    if (disposed) return;
    const audioCtx = ensureContext();
    if (!audioCtx) return;
    try {
      if (audioCtx.state === 'suspended') {
        void audioCtx.resume().catch(() => undefined);
      }
      const now = audioCtx.currentTime;
      const clamped = Math.max(0.15, Math.min(1.2, intensity));

      // 1. 瓷碗清脆泛音（双频短衰减正弦/三角波）
      const osc = audioCtx.createOscillator();
      const oscGain = audioCtx.createGain();
      const baseFreq = 1180 + Math.random() * 480;
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(baseFreq, now);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.68, now + 0.055);

      oscGain.gain.setValueAtTime(0.0001, now);
      oscGain.gain.linearRampToValueAtTime(0.14 * clamped, now + 0.004);
      oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.065);

      osc.connect(oscGain);
      oscGain.connect(audioCtx.destination);

      activeSources.add(osc);
      activeGains.add(oscGain);
      osc.onended = () => {
        activeSources.delete(osc);
        activeGains.delete(oscGain);
        try {
          osc.disconnect();
          oscGain.disconnect();
        } catch {
          // ignore
        }
      };
      osc.start(now);
      osc.stop(now + 0.07);

      // 2. 骨骰碰撞短瞬态噪声
      const buffer = ensureNoiseBuffer(audioCtx);
      if (buffer) {
        const noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(1900 + Math.random() * 500, now);
        filter.Q.setValueAtTime(2.4, now);

        const noiseGain = audioCtx.createGain();
        noiseGain.gain.setValueAtTime(0.0001, now);
        noiseGain.gain.linearRampToValueAtTime(0.11 * clamped, now + 0.002);
        noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);

        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(audioCtx.destination);

        activeSources.add(noise);
        activeGains.add(noiseGain);
        noise.onended = () => {
          activeSources.delete(noise);
          activeGains.delete(noiseGain);
          try {
            noise.disconnect();
            filter.disconnect();
            noiseGain.disconnect();
          } catch {
            // ignore
          }
        };
        noise.start(now);
        noise.stop(now + 0.045);
      }
    } catch {
      // Web Audio 调用异常时静默降级
    }
  };

  const stop = (): void => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();

    for (const gain of activeGains) {
      try {
        if (ctx) {
          gain.gain.cancelScheduledValues(ctx.currentTime);
          gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        }
        gain.disconnect();
      } catch {
        // ignore
      }
    }
    activeGains.clear();

    for (const source of activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // ignore
      }
    }
    activeSources.clear();
  };

  const start = (): void => {
    if (disposed) return;
    stop();
    for (const step of ROLL_IMPACT_SCHEDULE) {
      if (step.delayMs === 0) {
        impact(step.intensity);
      } else {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!disposed) {
            impact(step.intensity);
          }
        }, step.delayMs);
        timers.add(timer);
      }
    }
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stop();
    const currentCtx = ctx;
    ctx = null;
    noiseBuffer = null;
    if (currentCtx && typeof currentCtx.close === 'function') {
      void currentCtx.close().catch(() => undefined);
    }
  };

  return {
    unlock,
    start,
    impact,
    stop,
    dispose,
  };
}
