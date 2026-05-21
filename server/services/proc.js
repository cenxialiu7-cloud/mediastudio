import { spawn } from 'child_process';

/**
 * Run a command, streaming stdout/stderr lines to onLine(text, stream).
 * Resolves with { code, stdout, stderr }. Rejects only on spawn error.
 */
export function run(cmd, args, { onLine, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    let bufOut = '';
    let bufErr = '';

    const pump = (chunk, which) => {
      const s = chunk.toString();
      if (which === 'out') { stdout += s; bufOut += s; } else { stderr += s; bufErr += s; }
      let buf = which === 'out' ? bufOut : bufErr;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (onLine && line.length) onLine(line, which);
      }
      if (which === 'out') bufOut = buf; else bufErr = buf;
    };

    child.stdout.on('data', (c) => pump(c, 'out'));
    child.stderr.on('data', (c) => pump(c, 'err'));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function which(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { code, stdout } = await run(probe, [bin]);
    return code === 0 ? stdout.trim().split(/\r?\n/)[0] : null;
  } catch {
    return null;
  }
}
