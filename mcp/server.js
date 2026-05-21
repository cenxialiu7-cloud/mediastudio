#!/usr/bin/env node
/**
 * MediaStudio MCP server (stdio transport).
 *
 * Wraps the local MediaStudio HTTP API (default http://localhost:9810) so that
 * Claude Code or Cowork can do "summary / chapters / shorts / titles" on a
 * transcript without an Anthropic API key — the host LLM uses these tools.
 *
 * Tools:
 *   mediastudio_get_status         system + dependency snapshot (read-only)
 *   mediastudio_list_jobs          list transcribed jobs (read-only)
 *   mediastudio_get_transcript     fetch a transcript (read-only)
 *   mediastudio_list_artifacts     produced files for a job (read-only)
 *   mediastudio_save_plan          persist {summary,chapters,shorts,titles} (writes UI panel)
 *   mediastudio_cut_clip           cut a [start,end] segment into a new file
 *   mediastudio_transcribe_file    start an ASR job from a local file path
 *
 * Env:
 *   MEDIASTUDIO_URL   defaults to http://localhost:9810
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const BASE = (process.env.MEDIASTUDIO_URL || 'http://localhost:9810').replace(/\/+$/, '');

async function api(path, init) {
  const url = BASE + path;
  let res;
  try { res = await fetch(url, init); }
  catch (e) { throw new Error(`無法連線 MediaStudio (${url})：${e.message}。請先啟動 MediaStudio（雙擊 start-macos.command）。`); }
  const txt = await res.text();
  let body; try { body = JSON.parse(txt); } catch { body = { raw: txt }; }
  if (!res.ok) throw new Error(body.error || `MediaStudio ${res.status}: ${txt.slice(0, 200)}`);
  return body;
}

function toolResult(text, structured) {
  const r = { content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text, null, 2) }] };
  if (structured !== undefined) r.structuredContent = structured;
  return r;
}

function fmtHMS(sec) {
  if (!Number.isFinite(sec)) return '00:00:00';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function parseTime(t) {
  if (typeof t === 'number') return t;
  if (typeof t !== 'string') return NaN;
  const m = t.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/) || t.trim().match(/^(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return Number(t);
  if (m.length === 5 && m[1] && !m[4]) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
  // 2 groups → mm:ss
  if (m.length === 4) return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number(`0.${m[4]}`) : 0);
}

// --- tool definitions ---
const TOOLS = [
  {
    name: 'mediastudio_get_status',
    description: 'Get MediaStudio status and dependency availability. Use this first to confirm the local service is reachable.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'mediastudio_list_jobs',
    description: 'List jobs known to MediaStudio (most recent first). Use this to find the jobId for a video the user wants to work on.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['any', 'done', 'error', 'queued', 'downloading', 'extracting', 'transcribing', 'writing', 'canceled'], description: 'Filter by state (default: any).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max items to return (default 20).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'mediastudio_get_transcript',
    description: 'Get the transcript of a job, formatted as a timed plaintext (each segment prefixed with [hh:mm:ss-hh:mm:ss]). Use this to read the content before composing summaries / chapters / shorts.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Job id from mediastudio_list_jobs.' },
        withTimestamps: { type: 'boolean', description: 'If true (default), include [hh:mm:ss] markers on each segment.', default: true },
        maxChars: { type: 'integer', minimum: 1000, description: 'Truncate the returned text to this many characters (default: no limit). Useful for very long videos.' }
      },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'mediastudio_list_artifacts',
    description: 'List artifacts (produced files) for a job — subtitle outputs and edited videos.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
      additionalProperties: false
    }
  },
  {
    name: 'mediastudio_save_plan',
    description: 'Persist an AI-generated content plan (summary / chapters / shorts / titles) for a job. MediaStudio\'s editor will display it; chapter timestamps become click-to-seek and each "short" gets a "✂ Cut" button. Call this after you have read the transcript and produced the plan.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        plan: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '整體 2–4 句摘要。' },
            chapters: {
              type: 'array', description: '4–10 個章節，覆蓋全片。',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  start: { type: 'string', description: 'HH:MM:SS。' },
                  end: { type: 'string', description: 'HH:MM:SS（選填）。' }
                },
                required: ['title', 'start'],
                additionalProperties: false
              }
            },
            shorts: {
              type: 'array', description: '3–6 個建議短影片，每段 20–60 秒。',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  start: { type: 'string', description: 'HH:MM:SS。' },
                  end: { type: 'string', description: 'HH:MM:SS。' },
                  hook: { type: 'string', description: '前 3 秒鉤子文案。' },
                  why: { type: 'string', description: '為什麼這段適合做短影片。' }
                },
                required: ['title', 'start', 'end'],
                additionalProperties: false
              }
            },
            titles: { type: 'array', description: '5 個可選的 YouTube / 社群標題。', items: { type: 'string' } }
          },
          additionalProperties: true
        }
      },
      required: ['jobId', 'plan'],
      additionalProperties: false
    }
  },
  {
    name: 'mediastudio_cut_clip',
    description: 'Losslessly cut a [start,end] segment from the source video. Produces an artifact downloadable from MediaStudio. Use this to materialize one of the "shorts" you suggested.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        start: { type: 'string', description: 'Start time — accepts HH:MM:SS, MM:SS, or seconds (number).' },
        end: { type: 'string', description: 'End time — same formats as start.' }
      },
      required: ['jobId', 'start', 'end'],
      additionalProperties: false
    }
  },
  {
    name: 'mediastudio_transcribe_file',
    description: 'Start a new transcription job from a local file path. Returns immediately with a jobId; poll mediastudio_list_jobs (or look in the MediaStudio UI) until state="done", then fetch the transcript.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a local video/audio file.' },
        model: { type: 'string', enum: ['tiny', 'base', 'small', 'medium', 'large-v3'], default: 'medium' },
        language: { type: 'string', description: 'BCP-47 / ISO short code (e.g. "zh", "en", "auto").', default: 'auto' },
        task: { type: 'string', enum: ['transcribe', 'translate'], default: 'transcribe' }
      },
      required: ['path'],
      additionalProperties: false
    }
  }
];

// --- tool dispatch ---
async function handle(name, args) {
  switch (name) {
    case 'mediastudio_get_status': {
      const s = await api('/api/status');
      const summary = [
        `status: ${s.status}`,
        `deps:  ${Object.entries(s.dependencies).map(([k, v]) => `${k}=${v.ok ? '✅' : '❌'}`).join(', ')}`,
        `features: ${Object.entries(s.features).map(([k, v]) => `${k}=${v}`).join(', ')}`
      ].join('\n');
      return toolResult(summary, s);
    }
    case 'mediastudio_list_jobs': {
      const state = args.state || 'any';
      const limit = args.limit || 20;
      const r = await api('/api/jobs');
      const filtered = (r.jobs || []).filter((j) => state === 'any' || j.state === state).slice(0, limit);
      const lines = filtered.map((j) => `${j.id}  [${j.state}]  ${j.language || '-'}  ${j.duration ? fmtHMS(j.duration) : '-'}  ${j.segmentCount || 0} segs  ${j.title}`);
      return toolResult(lines.length ? lines.join('\n') : '(沒有符合條件的任務)', { jobs: filtered });
    }
    case 'mediastudio_get_transcript': {
      if (!args.jobId) throw new Error('需要 jobId');
      const r = await api(`/api/jobs/${encodeURIComponent(args.jobId)}/segments`);
      const segs = r.segments || [];
      const withTs = args.withTimestamps !== false;
      const txt = segs.map((s, i) => {
        const head = withTs ? `[${fmtHMS(s.start)}-${fmtHMS(s.end)}] ` : '';
        const spk = s.speaker ? `${s.speaker}: ` : '';
        return `[${i}] ${head}${spk}${(s.text || '').trim()}`;
      }).join('\n');
      const trimmed = args.maxChars && txt.length > args.maxChars ? txt.slice(0, args.maxChars) + `\n…(truncated, full length=${txt.length})` : txt;
      return toolResult(trimmed || '(empty transcript)', { jobId: args.jobId, segmentCount: segs.length, truncated: !!(args.maxChars && txt.length > args.maxChars) });
    }
    case 'mediastudio_list_artifacts': {
      if (!args.jobId) throw new Error('需要 jobId');
      const j = await api(`/api/jobs/${encodeURIComponent(args.jobId)}`);
      const arts = j.artifacts || [];
      const subs = j.outputs || [];
      const txt = [
        `subtitle/transcript outputs: ${subs.join(', ') || '(none)'}`,
        `artifacts (videos / data):`,
        ...arts.map((a) => `  ${a.name}  —  ${a.label}  (download: ${BASE}/api/jobs/${args.jobId}/artifact/${encodeURIComponent(a.name)})`)
      ].join('\n');
      return toolResult(txt, { outputs: subs, artifacts: arts });
    }
    case 'mediastudio_save_plan': {
      if (!args.jobId || !args.plan) throw new Error('需要 jobId 與 plan');
      const r = await api(`/api/jobs/${encodeURIComponent(args.jobId)}/aiplan`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: args.plan })
      });
      return toolResult(`已儲存規劃（${Object.keys(args.plan).join(', ')}）。可在 MediaStudio 編輯器看到。`, r);
    }
    case 'mediastudio_cut_clip': {
      if (!args.jobId) throw new Error('需要 jobId');
      const s = parseTime(args.start), e = parseTime(args.end);
      if (!(e > s)) throw new Error(`start/end 無效：${args.start} → ${args.end}`);
      const r = await api(`/api/jobs/${encodeURIComponent(args.jobId)}/clip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start: s, end: e })
      });
      return toolResult(`已開始裁切 ${fmtHMS(s)}–${fmtHMS(e)}。完成後可在 MediaStudio 的「產出」列下載 clip.<ext>。`, r);
    }
    case 'mediastudio_transcribe_file': {
      if (!args.path) throw new Error('需要 path（檔案絕對路徑）');
      const r = await api('/api/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ type: 'file', value: args.path }],
          options: { model: args.model || 'medium', language: args.language || 'auto', task: args.task || 'transcribe' }
        })
      });
      const first = (r.jobs || [])[0];
      if (!first) throw new Error('未建立任務（可能路徑無效）');
      return toolResult(`已建立任務 jobId=${first.id}（${first.state}）。請等到 state=done 後再 get_transcript。`, first);
    }
    default:
      throw new Error(`未知的 tool：${name}`);
  }
}

const server = new Server(
  { name: 'mediastudio', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try { return await handle(name, args || {}); }
  catch (e) {
    return {
      content: [{ type: 'text', text: `❌ ${e.message}` }],
      isError: true
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
