import { WebSocketServer } from 'ws';

let wss = null;
const clients = new Set();

export function setupWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });
}

export function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const c of clients) {
    if (c.readyState === 1) {
      try { c.send(msg); } catch { /* ignore */ }
    }
  }
}
