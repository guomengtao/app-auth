export const config = { runtime: 'edge' };

const UPSTASH_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const NOTIFY_KEY = 'auth:push_notifications';
const POLL_INTERVAL = 500;
const BATCH_SIZE = 30;

function upstashCmd(...args) {
  const url = UPSTASH_URL + '/' + args.map(a => encodeURIComponent(String(a))).join('/');
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + UPSTASH_TOKEN,
      'Content-Type': 'application/json'
    }
  }).then(r => {
    if (!r.ok) throw new Error('Upstash ' + r.status);
    return r.json();
  }).then(j => (j && typeof j === 'object' && 'result' in j) ? j.result : j);
}

async function fetchMessages() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return [];
  try {
    const raw = await upstashCmd('LRANGE', NOTIFY_KEY, 0, BATCH_SIZE - 1);
    if (!Array.isArray(raw)) return [];
    return raw.map(s => {
      try { return JSON.parse(s); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

export default async function handler(req) {
  const rawUrl = req.url || '/';
  const url = rawUrl.startsWith('http') ? new URL(rawUrl) : new URL(rawUrl, 'http://localhost');
  const searchParams = url.searchParams;
  const heartbeatMs = parseInt(searchParams.get('heartbeat') || '30000', 10);
  const pollMs = parseInt(searchParams.get('poll') || String(POLL_INTERVAL), 10);
  const encoder = new TextEncoder();
  const seen = new Set();
  const stream = new ReadableStream({
    async start(controller) {
      let lastHeartbeat = Date.now();
      let lastPoll = 0;
      const send = (data) => {
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(data) + '\n\n'));
      };
      send({ type: 'connected', ts: Date.now() });
      while (true) {
        if (req.signal.aborted) break;
        const now = Date.now();
        if (now - lastHeartbeat > heartbeatMs) {
          try { controller.enqueue(encoder.encode(': hb\n\n')); } catch (_) { break; }
          lastHeartbeat = now;
        }
        if (now - lastPoll > pollMs) {
          lastPoll = now;
          try {
            const msgs = await fetchMessages();
            for (const m of msgs) {
              const id = m.ts + '_' + m.type;
              if (!seen.has(id)) {
                seen.add(id);
                send(m);
              }
            }
            if (seen.size > 500) {
              const arr = Array.from(seen);
              seen.clear();
              arr.slice(-200).forEach(x => seen.add(x));
            }
          } catch (_) {}
        }
        await new Promise(r => setTimeout(r, Math.min(pollMs, 1000)));
      }
    },
    cancel() {}
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
}