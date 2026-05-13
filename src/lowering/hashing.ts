/**
 * FNV-1a 32-bit hash, returned as zero-padded 8-hex.
 *
 * Used as a stable suffix in mangled identifiers:
 *   - function specialization names (`<name>__<8hex>`),
 *   - struct typedefs (`_mtoc_struct__<8hex>`),
 *   - handle typedefs (`_mtoc_handle__<8hex>`).
 *
 * Single source of truth. Browser-safe (no Node / WebCrypto / Buffer);
 * walks the input as UTF-16 code units. Same hash flavor across every
 * mangled name so different categories can never collide.
 */
export function fnv1a32Hex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
    const upper = s.charCodeAt(i) >>> 8;
    if (upper) {
      h ^= upper;
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
