/**
 * UUID v4 生成：`crypto.randomUUID` 只在安全上下文（HTTPS / localhost）可用，
 * 局域网 HTTP 访问时必须回退到 `crypto.getRandomValues`，否则 `requestId` 无法生成、
 * 掷骰按钮会直接不可用。
 */

export function randomUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // 极端降级：仅在完全没有 Web Crypto 的旧环境使用，仍然只作为幂等键
  const fallback = `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
  return `${fallback.slice(0, 8)}-${fallback.slice(8, 12)}-4000-8000-${fallback.slice(0, 12)}`;
}
