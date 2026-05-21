// Build human-readable, filesystem-safe slugs that preserve CJK characters
// so a user can recognise which source video an output file belongs to.

const MULTER_TS_PREFIX = /^\d{13}-/;
const EXT_RE = /\.[A-Za-z0-9]{1,8}$/;
const UNSAFE_RE = /[\\/:*?"<>|\x00-\x1f]/g;

export function sanitizeSlug(raw, maxLen = 60) {
  if (!raw) return 'media';
  let s = String(raw).normalize('NFC');
  s = s.replace(MULTER_TS_PREFIX, '');
  s = s.replace(EXT_RE, '');
  s = s.replace(UNSAFE_RE, '_');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s_-]+|[.\s_-]+$/g, '');
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[.\s_-]+$/g, '');
  return s || 'media';
}

// URL → slug fallback when we couldn't probe a title yet (e.g. before yt-dlp runs).
export function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || u.hostname;
    return sanitizeSlug(decodeURIComponent(last));
  } catch {
    return sanitizeSlug(url);
  }
}

export function makePrefix(slug, id) {
  const shortId = String(id || '').replace(/-/g, '').slice(0, 8) || 'job';
  return `${sanitizeSlug(slug)}__${shortId}`;
}
