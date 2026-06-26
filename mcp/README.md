# MediaStudio MCP Server

Local stdio MCP server. Lets Claude Code or Cowork (Claude for Mac) drive MediaStudio — pull a transcript, plan summary / chapters / shorts / titles, and trigger video edits — **without** an Anthropic API key. The host LLM is your Claude client; this MCP exposes MediaStudio as tools.

## Tools

| Tool | What it does |
|---|---|
| `mediastudio_get_status` | System + dependency snapshot (read-only) |
| `mediastudio_list_jobs` | List transcribed jobs (read-only) |
| `mediastudio_get_transcript` | Fetch a job's transcript as `[hh:mm:ss-hh:mm:ss] text` (read-only) |
| `mediastudio_list_artifacts` | List subtitle outputs + produced videos (read-only) |
| `mediastudio_save_plan` | Persist a `{summary, chapters, shorts, titles}` plan; the MediaStudio editor displays it immediately |
| `mediastudio_cut_clip` | Lossless cut a `[start,end]` segment; produces a downloadable artifact |
| `mediastudio_transcribe_file` | Start a new ASR job from a local file path |

## Install — Claude Code

```bash
claude mcp add mediastudio -- node "$HOME/Claude Code/MediaStudio/mcp/server.js"
```

Then in any Claude Code session, `/mcp` will show `mediastudio` and its 7 tools.

## Install — Cowork (Claude for Mac)

Cowork settings → **MCP servers** → Add, or edit `~/Library/Application Support/Claude/claude_desktop_config.json` and merge:

```json
{
  "mcpServers": {
    "mediastudio": {
      "command": "node",
      "args": ["$HOME/Claude Code/MediaStudio/mcp/server.js"]
    }
  }
}
```

Restart Cowork. The tools appear in the tool picker.

## Typical session

1. Start MediaStudio (double-click `start-macos.command`).
2. Drop a video in MediaStudio UI; wait for state `done`.
3. In MediaStudio editor click **🤖 摘要 / 章節 / 短影片 (用 Claude Code / Cowork)** — the dialog prefills a prompt with the current `jobId`.
4. Paste that prompt in Claude Code or Cowork. Claude reads the transcript via `get_transcript`, composes the plan, and saves via `save_plan`. MediaStudio editor refreshes — chapters become click-to-seek, each suggested short gets a `✂ 裁出` button.
5. Tell Claude "裁出第 N 個" if you want it to call `cut_clip` for you.

## Env

| Var | Purpose |
|---|---|
| `MEDIASTUDIO_URL` | MediaStudio HTTP base URL (default `http://localhost:9810`) |

## Schema notes

- Time fields accept `HH:MM:SS`, `MM:SS`, or seconds.
- `save_plan` is idempotent — calling it again overwrites the stored plan.
- `cut_clip` is non-destructive — output is a new file under MediaStudio's output dir.
