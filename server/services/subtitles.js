// Convert a list of segments [{ start, end, text, speaker? }] into subtitle formats.

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function timecode(sec, sep = ',') {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const s = Math.floor(sec) % 60;
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

export function toSRT(segments) {
  return segments.map((seg, i) => {
    const spk = seg.speaker ? `[${seg.speaker}] ` : '';
    return `${i + 1}\n${timecode(seg.start, ',')} --> ${timecode(seg.end, ',')}\n${spk}${(seg.text || '').trim()}\n`;
  }).join('\n');
}

export function toVTT(segments) {
  const body = segments.map((seg) => {
    const spk = seg.speaker ? `<v ${seg.speaker}>` : '';
    return `${timecode(seg.start, '.')} --> ${timecode(seg.end, '.')}\n${spk}${(seg.text || '').trim()}\n`;
  }).join('\n');
  return `WEBVTT\n\n${body}`;
}

// 無時間軸：純逐字稿（段落串接，可選說話者前綴）
export function toTXT(segments) {
  return segments.map((s) => (s.speaker ? `${s.speaker}: ` : '') + (s.text || '').trim()).join('\n');
}

// 有時間軸的逐字稿：每段前加 [hh:mm:ss]，方便人閱讀/定位
export function toTXTtimed(segments) {
  const stamp = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
  };
  return segments.map((s) => `[${stamp(s.start)}]${s.speaker ? ` ${s.speaker}:` : ''} ${(s.text || '').trim()}`).join('\n');
}

// Advanced SubStation Alpha — 有時間軸、可帶樣式，剪輯軟體常用
export function toASS(segments, title = 'MediaStudio') {
  const t = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const cs = Math.round((sec - Math.floor(sec)) * 100);
    const s = Math.floor(sec) % 60, m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
    return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
  };
  const head = `[Script Info]
Title: ${title}
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.601

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,42,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const body = segments.map((s) => {
    const name = s.speaker || '';
    const text = (s.text || '').trim().replace(/\r?\n/g, '\\N');
    return `Dialogue: 0,${t(s.start)},${t(s.end)},Default,${name},0,0,0,,${text}`;
  }).join('\n');
  return head + body + '\n';
}

export function toJSON(payload) {
  return JSON.stringify(payload, null, 2);
}

export const FORMATTERS = {
  srt:   { ext: 'srt',  mime: 'application/x-subrip', timed: true,  label: '字幕 SRT (時間軸)',       fn: (p) => toSRT(p.segments) },
  vtt:   { ext: 'vtt',  mime: 'text/vtt',             timed: true,  label: '字幕 WebVTT (時間軸)',    fn: (p) => toVTT(p.segments) },
  ass:   { ext: 'ass',  mime: 'text/x-ssa',           timed: true,  label: '字幕 ASS (時間軸+樣式)',  fn: (p) => toASS(p.segments, p.title) },
  'txt-ts': { ext: 'timed.txt', mime: 'text/plain',   timed: true,  label: '逐字稿 (含時間標記)',     fn: (p) => toTXTtimed(p.segments) },
  txt:   { ext: 'txt',  mime: 'text/plain',           timed: false, label: '逐字稿 (純文字, 無時間軸)', fn: (p) => toTXT(p.segments) },
  json:  { ext: 'json', mime: 'application/json',     timed: true,  label: 'JSON (含字級時間戳)',     fn: (p) => toJSON(p) }
};
