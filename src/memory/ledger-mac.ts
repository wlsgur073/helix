import { createHash } from 'node:crypto';

export const MAC_VERSION = 1;

/** Lowercase hex SHA-256 over the UTF-8 bytes of `content`. Used for the content binding. */
export function digestContent(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}
