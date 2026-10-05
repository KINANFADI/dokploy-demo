const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { createPg, ensureSchema, createRedis, withTimeout } = require('./lib');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || '/data';
const APP_VERSION = process.env.APP_VERSION || 'dev';
const startedAt = new Date();
const buildTime = readOptional(path.join(__dirname, '.build-time'));
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const pg = createPg();
const redis = createRedis('web');
let shuttingDown = false;

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
}

// ---- Volume: append one line per boot. The count only grows across
// redeploys if DATA_DIR is a mounted volume.
const volume = (() => {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, 'boots.log');
    fs.appendFileSync(file, `${startedAt.toISOString()} ${os.hostname()} v${APP_VERSION}\n`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    return { ok: true, path: DATA_DIR, boots: lines.length, recentBoots: lines.slice(-5).reverse() };
  } catch (e) {
    return { ok: false, path: DATA_DIR, error: e.message };
  }
})();

// ---- Checks ---------------------------------------------------------------
async function checkPostgres() {
  if (!pg) return { status: 'off', detail: 'DATABASE_URL is not set' };
  const t = Date.now();
  try {
    await withTimeout(ensureSchema(pg), 3000, 'schema setup');
    const { rows } = await withTimeout(pg.query(`
      SELECT version() AS v,
             (SELECT count(*) FROM visits)::int   AS visits,
             (SELECT count(*) FROM job_runs)::int AS job_runs,
             (SELECT max(ran_at) FROM job_runs)   AS last_job
    `), 3000, 'query');
    const r = rows[0];
    return {
      status: 'ok',
      latencyMs: Date.now() - t,
      version: r.v.split(' on ')[0],
      visitsStored: r.visits,
      scheduledJobRuns: r.job_runs,
      lastJobRun: r.last_job ? r.last_job.toISOString() : 'never — set up a schedule',
    };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

async function checkRedis() {
  if (!redis) return { status: 'off', detail: 'REDIS_URL is not set' };
  if (!redis.isReady) return { status: 'error', detail: 'Not connected, retrying. Check REDIS_URL and the password.' };
  const t = Date.now();
  try {
    const [, views, hb, done, queued, last, info] = await withTimeout(Promise.all([
      redis.ping(),
      redis.get('demo:page_views'),
      redis.get('demo:worker:heartbeat'),
      redis.get('demo:jobs:done'),
      redis.lLen('demo:jobs'),
      redis.get('demo:jobs:last'),
      redis.info('server'),
    ]), 3000, 'redis');
    return {
      status: 'ok',
      latencyMs: Date.now() - t,
      version: (info.match(/redis_version:(\S+)/) || [])[1],
      pageViews: Number(views) || 0,
      _heartbeat: hb ? JSON.parse(hb) : null,
      _jobs: { done: Number(done) || 0, queued, last: last ? JSON.parse(last) : null },
    };
  } catch (e) {
    return { status: 'error', detail: e.message };
  }
}

function checkWorker(r) {
  if (!redis) return { status: 'off', detail: 'Needs Redis' };
  if (r.status !== 'ok') return { status: 'error', detail: 'Redis is unreachable, so the worker can\'t be checked' };
  const hb = r._heartbeat;
  const jobs = r._jobs;
  if (!hb) return { status: 'warn', detail: 'No heartbeat. Is the worker service running?', jobsQueued: jobs.queued };
  const ageSec = Math.round((Date.now() - hb.ts) / 1000);
  return {
    status: ageSec < 30 ? 'ok' : 'error',
    lastHeartbeat: `${ageSec}s ago`,
    workerHost: hb.hostname,
    jobsDone: jobs.done,
    jobsQueued: jobs.queued,
    lastJob: jobs.last ? `#${jobs.last.id} by ${jobs.last.by}` : 'none yet',
  };
}

function checkEnv() {
  const secret = process.env.SECRET_KEY;
  const greeting = process.env.GREETING;
  return {
    status: greeting && secret ? 'ok' : 'warn',
    GREETING: greeting || 'not set',
    SECRET_KEY: secret ? `${secret.slice(0, 2)}•••• (${secret.length} chars)` : 'not set',
    NODE_ENV: process.env.NODE_ENV || 'not set',
    APP_VERSION: `${APP_VERSION} (build arg)`,
    otherDemoVars: Object.keys(process.env).filter((k) => k.startsWith('DEMO_')).sort(),
  };
}

function checkHttp(req) {
  const h = req.headers;
  const proto = (h['x-forwarded-proto'] || 'http').split(',')[0];
  const proxied = Boolean(h['x-forwarded-for']);
  return {
    status: proto === 'https' ? 'ok' : 'warn',
    host: h['x-forwarded-host'] || h.host,
    protocol: proto,
    behindProxy: proxied ? 'yes (Traefik)' : 'no, direct connection',
    clientIp: (h['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(),
  };
}

function checkVolume() {
  if (!volume.ok) return { status: 'error', path: volume.path, detail: volume.error };
  return {
    status: volume.boots > 1 ? 'ok' : 'warn',
    path: volume.path,
    bootsRecorded: volume.boots,
    hint: volume.boots > 1 ? 'Data survived a restart' : 'First boot seen. Redeploy and this should become 2.',
    recentBoots: volume.recentBoots,
  };
}

async function buildStatus(req) {
  const [postgres, redisRaw] = await Promise.all([checkPostgres(), checkRedis()]);
  const worker = checkWorker(redisRaw);
  const { _heartbeat, _jobs, ...redisPublic } = redisRaw;
  return {
    app: {
      version: APP_VERSION,
      buildTime,
      hostname: os.hostname(),
      pid: process.pid,
      node: process.version,
      startedAt: startedAt.toISOString(),
      uptimeSec: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
      cpus: os.cpus().length,
    },
    checks: {
      http: checkHttp(req),
      env: checkEnv(),
      postgres,
      redis: redisPublic,
      worker,
      volume: checkVolume(),
    },
  };
}

// ---- HTTP -----------------------------------------------------------------
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj, null, 2), 'application/json');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  const t = Date.now();
  res.on('finish', () => {
    if (url.pathname !== '/health') console.log(`${route} ${res.statusCode} ${Date.now() - t}ms`);
  });

  try {
    switch (route) {
      case 'GET /':
        return send(res, 200, PAGE, 'text/html; charset=utf-8');

      // Liveness: is the process up? Used by the Docker HEALTHCHECK.
      case 'GET /health':
        return shuttingDown
          ? json(res, 503, { status: 'shutting down' })
          : json(res, 200, { status: 'ok', uptimeSec: Math.round(process.uptime()) });

      // Readiness: are the configured dependencies reachable?
      case 'GET /ready': {
        const s = await buildStatus(req);
        const failing = Object.entries(s.checks).filter(([, c]) => c.status === 'error').map(([k]) => k);
        return json(res, failing.length ? 503 : 200, { ready: failing.length === 0, failing });
      }

      case 'GET /api/status':
        return json(res, 200, await buildStatus(req));

      case 'POST /api/visit': {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const results = await Promise.allSettled([
          redis && redis.isReady ? redis.incr('demo:page_views') : null,
          pg ? ensureSchema(pg).then(() => pg.query('INSERT INTO visits (host, ip) VALUES ($1, $2)', [os.hostname(), ip])) : null,
        ]);
        return json(res, 200, { recorded: results.map((r) => r.status) });
      }

      case 'POST /api/enqueue': {
        if (!redis || !redis.isReady) return json(res, 503, { error: 'Redis is not connected' });
        const id = await redis.incr('demo:jobs:seq');
        await redis.lPush('demo:jobs', JSON.stringify({ id, ts: Date.now(), from: os.hostname() }));
        return json(res, 200, { queued: id });
      }

      case 'POST /api/log': {
        const tag = Date.now().toString(36);
        console.log(`[demo-log ${tag}] info line written to stdout`);
        console.warn(`[demo-log ${tag}] warning line written to stderr`);
        console.error(`[demo-log ${tag}] error line written to stderr`);
        return json(res, 200, { wrote: 3, tag });
      }

      case 'POST /api/stress': {
        const seconds = Math.min(Math.max(Number(url.searchParams.get('seconds')) || 15, 1), 60);
        const threads = Math.min(Math.max(Number(url.searchParams.get('threads')) || 1, 1), os.cpus().length);
        for (let i = 0; i < threads; i++) {
          new Worker(`const end = Date.now() + ${seconds * 1000}; while (Date.now() < end) {}`, { eval: true });
        }
        console.log(`[stress] burning ${threads} core(s) for ${seconds}s`);
        return json(res, 200, { threads, seconds });
      }

      case 'POST /api/crash': {
        if (process.env.ALLOW_CRASH !== 'true') {
          return json(res, 403, { error: 'Crash is disabled. Set ALLOW_CRASH=true and redeploy to enable it.' });
        }
        json(res, 200, { crashing: true });
        console.error('[crash] requested from dashboard, exiting with code 1');
        setTimeout(() => process.exit(1), 200);
        return;
      }

      default:
        return json(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    console.error(`[error] ${route}:`, e);
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`dokploy-demo v${APP_VERSION} listening on :${PORT} (host ${os.hostname()})`);
  console.log(`  postgres: ${pg ? 'configured' : 'off'} | redis: ${redis ? 'configured' : 'off'} | volume: ${volume.ok ? `${volume.path} (boot #${volume.boots})` : volume.error}`);
});

// ---- Graceful shutdown (lets you verify zero-downtime redeploys) ---------
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, finishing in-flight requests…`);
  setTimeout(() => { console.log('forced exit after 10s'); process.exit(0); }, 10_000).unref();
  server.close(async () => {
    await Promise.allSettled([pg && pg.end(), redis && redis.isOpen && redis.quit()]);
    console.log('shutdown complete');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
