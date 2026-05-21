// Browsers send multipart filename as raw UTF-8 bytes, but busboy (multer's
// parser) decodes Content-Disposition parameters as latin1 by default — so
// CJK filenames arrive as mojibake (e.g. "拉斯維加斯" → "Vegasé é äºæ").
// Re-interpret the latin1 string as UTF-8 to recover the original.
// See: https://github.com/expressjs/multer/issues/1104
export function decodeFilename(name) {
  if (!name) return name;
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    // If the round-trip yielded a replacement char, the original was already
    // valid UTF-8 (or pure ASCII) — keep it as-is.
    if (fixed.includes('�')) return name;
    return fixed;
  } catch {
    return name;
  }
}
