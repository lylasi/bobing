/**
 * 运行时公开配置的测试（P9 部署所需的最小只读扩展）：
 * `PUBLIC_BASE_URL` 的校验规则与 `GET /api/config` 的真实响应。
 * 这些用例是新增的，不修改既有 111 条核心用例。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServerInstance } from '../server/index.js';
import type { ServerInstance } from '../server/index.js';
import { normalizePublicBaseUrl } from '../server/app.js';

const opened: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (opened.length > 0) {
    const dispose = opened.pop();
    if (dispose) await dispose();
  }
});

async function startInstance(publicBaseUrl: string | null): Promise<{ instance: ServerInstance; base: string; dataDir: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'bobing-config-'));
  const instance = await createServerInstance({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    staticDir: null,
    clockIntervalMs: null,
    quiet: true,
    publicBaseUrl,
  });
  opened.push(async () => {
    await instance.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { instance, base: `http://127.0.0.1:${instance.port}`, dataDir };
}

describe('normalizePublicBaseUrl', () => {
  it('接受 http(s) 地址并去掉结尾斜杠', () => {
    expect(normalizePublicBaseUrl('https://bobing.example.com')).toBe('https://bobing.example.com');
    expect(normalizePublicBaseUrl('https://bobing.example.com/')).toBe('https://bobing.example.com');
    expect(normalizePublicBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizePublicBaseUrl('  https://example.com/bobing//  ')).toBe('https://example.com/bobing');
  });

  it('拒绝非 http(s)、含凭证、查询串或片段的值', () => {
    expect(normalizePublicBaseUrl('ftp://example.com')).toBeNull();
    expect(normalizePublicBaseUrl('javascript:alert(1)')).toBeNull();
    expect(normalizePublicBaseUrl('https://user:secret@example.com')).toBeNull();
    expect(normalizePublicBaseUrl('https://user@example.com')).toBeNull();
    expect(normalizePublicBaseUrl('https://example.com/?token=abc')).toBeNull();
    expect(normalizePublicBaseUrl('https://example.com/#frag')).toBeNull();
  });

  it('空值与非法输入统一退化为 null（前端使用当前 origin）', () => {
    expect(normalizePublicBaseUrl('')).toBeNull();
    expect(normalizePublicBaseUrl('   ')).toBeNull();
    expect(normalizePublicBaseUrl(undefined)).toBeNull();
    expect(normalizePublicBaseUrl(null)).toBeNull();
    expect(normalizePublicBaseUrl('example.com')).toBeNull();
    expect(normalizePublicBaseUrl(123)).toBeNull();
  });
});

describe('GET /api/config', () => {
  it('返回配置的公开分享地址且不含任何凭证字段', async () => {
    const { base } = await startInstance('https://bobing.example.com/');
    const response = await fetch(`${base}/api/config`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ publicBaseUrl: 'https://bobing.example.com' });
    expect(Object.keys(body)).toEqual(['publicBaseUrl']);
  });

  it('未配置时返回 null，前端据此回退到当前 origin', async () => {
    const { base } = await startInstance(null);
    const response = await fetch(`${base}/api/config`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ publicBaseUrl: null });
  });

  it('健康检查与配置接口都是只读的 GET', async () => {
    const { base } = await startInstance('https://bobing.example.com');
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });
});
