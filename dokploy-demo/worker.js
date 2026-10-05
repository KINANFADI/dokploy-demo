// Background worker: heartbeats into Redis and processes jobs queued from the dashboard.
// Also serves a tiny /health endpoint so the image's HEALTHCHECK works for this service too.
const http = require('http');
const os = require('os');
const { createRedis, wireRedisLogging, sleep } = require('./lib');

const PORT = Number(process.env.PORT) || 3000;
let running = true;

http.createServer((req, res) => {
  res.writeHead(running ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ role: 'worker', status: running ? 'ok' : 'stopping' }));
}).listen(PORT, '0.0.0.0');

const redis = createRedis('worker');
if (!redis) {
  console.error('[worker] REDIS_URL is not set, so there is nothing to do. Idling.');
} else {
  console.log(`[worker] started on ${os.hostname()}`);

  // A second connection, because BRPOP blocks the connection it runs on.
  const blocking = redis.duplicate();
  wireRedisLogging(blocking, 'worker-queue');
  blocking.connect().catch(() => {});

  const heartbeat = async () => {
    if (!redis.isReady) return;
    await redis.set('demo:worker:heartbeat',
      JSON.stringify({ ts: Date.now(), hostname: os.hostname(), pid: process.pid }), { EX: 60 });
  };
  heartbeat().catch(() => {});
  setInterval(() => heartbeat().catch((e) => console.error('[worker] heartbeat failed:', e.message)), 5000);

  (async function loop() {
    while (running) {
      if (!blocking.isReady || !redis.isReady) { await sleep(1000); continue; }
      try {
        const item = await blocking.brPop('demo:jobs', 5);
        if (!item) continue;
        const job = JSON.parse(item.element);
        console.log(`[worker] job #${job.id} started`);
        await sleep(1000 + Math.random() * 1500); // pretend to work
        await redis.incr('demo:jobs:done');
        await redis.set('demo:jobs:last', JSON.stringify({ ...job, doneAt: Date.now(), by: os.hostname() }));
        console.log(`[worker] job #${job.id} done`);
      } catch (e) {
        if (running) { console.error('[worker] loop error:', e.message); await sleep(1000); }
      }
    }
  })();

  const stop = async (signal) => {
    if (!running) return;
    running = false;
    console.log(`[worker] ${signal} received, stopping`);
    setTimeout(() => process.exit(0), 5000).unref();
    await Promise.allSettled([blocking.isOpen && blocking.disconnect(), redis.isOpen && redis.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (!redis) {
  const exit = () => { running = false; process.exit(0); };
  process.on('SIGTERM', exit);
  process.on('SIGINT', exit);
}
