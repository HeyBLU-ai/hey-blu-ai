/**
 * Constant-time string comparison for secrets (mitigates timing analysis).
 */
import { timingSafeEqual } from 'node:crypto';

/**
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
export function safeCompareSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!expected.length) return false;

  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }

  return timingSafeEqual(a, b);
}

export default { safeCompareSecret };
