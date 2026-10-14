// 短 ID 生成：避免依赖 crypto.randomUUID 在某些老 Node 上不可用。
// 8 字节 hex → 16 字符，足够本地会话区分。

import { randomBytes } from 'node:crypto';

export function newSessionId() {
  return randomBytes(8).toString('hex');
}