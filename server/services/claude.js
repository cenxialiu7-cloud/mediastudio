// Anthropic Claude integration: turns a transcript into summary, chapters,
// suggested short-clip ranges, and title ideas. Uses prompt caching so repeat
// calls on the same transcript (e.g. "regenerate just the shorts") are cheap.
//
// Env:
//   ANTHROPIC_API_KEY   required
//   ANTHROPIC_BASE_URL  optional (custom router)
//   CLAUDE_MODEL        optional, defaults to claude-sonnet-4-6

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('未設定 ANTHROPIC_API_KEY，無法使用 AI 規劃功能。請在環境變數設定金鑰後重啟服務。');
  }
  if (!_client) _client = new Anthropic();
  return _client;
}

export function claudeReady() { return !!process.env.ANTHROPIC_API_KEY; }

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function transcriptText(segments) {
  return segments.map((s, i) => `[${i}] ${fmtTime(s.start)}-${fmtTime(s.end)} ${(s.speaker ? `${s.speaker}: ` : '')}${(s.text || '').trim()}`).join('\n');
}

/**
 * Ask Claude for a content plan.
 * tasks: array of 'summary'|'chapters'|'shorts'|'titles' (defaults to all)
 * Returns parsed JSON: { summary, chapters:[{title,start,end?}], shorts:[{title,start,end,hook}], titles:[...] }
 */
export async function aiPlan({ segments, tasks = ['summary', 'chapters', 'shorts', 'titles'], language = 'zh', extraInstructions = '', model = DEFAULT_MODEL }) {
  if (!segments?.length) throw new Error('沒有逐字稿可用');
  const transcript = transcriptText(segments);
  const ask = new Set(tasks);

  const schemaLines = [];
  if (ask.has('summary')) schemaLines.push('  "summary": "整體 2–4 句摘要（讀者導向）"');
  if (ask.has('chapters')) schemaLines.push('  "chapters": [ { "title": "章節標題", "start": "HH:MM:SS", "end": "HH:MM:SS?" } ]');
  if (ask.has('shorts')) schemaLines.push('  "shorts": [ { "title": "短片標題", "start": "HH:MM:SS", "end": "HH:MM:SS", "hook": "前 3 秒的鉤子文案", "why": "為什麼這段適合做短影片" } ]');
  if (ask.has('titles')) schemaLines.push('  "titles": [ "5 個可選的 YouTube/社群標題" ]');

  const system = `你是專業的影音內容編輯助手。會收到一份「帶時間軸的逐字稿」並輸出結構化規劃。
規則：
- 全部用 ${language === 'en' ? '英文' : language === 'ja' ? '日文' : '繁體中文'} 回覆（除非原文逐字稿語言一致即沿用）。
- 章節 4–10 個，覆蓋全片，時間取自逐字稿。
- 短片 (shorts) 3–6 個，每段 20–60 秒，挑「金句 / 反直覺 / 操作步驟 / 強情緒」的片段，start/end 對齊逐字稿邊界。
- 時間一律 HH:MM:SS 格式。
- 嚴格輸出符合下列 JSON schema 的純 JSON，不要加任何文字或 markdown 圍欄。`;

  const userText = `${extraInstructions ? `額外要求：${extraInstructions}\n\n` : ''}請只輸出以下欄位的 JSON：\n{\n${schemaLines.join(',\n')}\n}`;

  const msg = await client().messages.create({
    model,
    max_tokens: 4096,
    system,
    messages: [
      {
        role: 'user',
        content: [
          // Mark the transcript as cacheable so re-runs on the same job are cheap.
          { type: 'text', text: `<transcript>\n${transcript}\n</transcript>`, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: userText }
        ]
      }
    ]
  });

  const raw = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
  const json = extractJson(raw);
  return {
    plan: json,
    usage: msg.usage,
    model: msg.model,
    cacheHit: !!(msg.usage && (msg.usage.cache_read_input_tokens || 0) > 0)
  };
}

function extractJson(text) {
  // Try direct parse, else find the first {...} block.
  try { return JSON.parse(text); } catch { /* fall through */ }
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* ignore */ }
  }
  throw new Error('Claude 回傳的不是合法 JSON：\n' + text.slice(0, 400));
}
