// Shared helpers: Postgres pool, Redis client, timeouts.
// Every integration is optional — if its URL isn't set, the app still runs
// and the dashboard shows that check as "not configured".
const { Pool } = require('pg');
const { createClient } = require('redis');

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createPg() {
  if (!process.env.DATABASE_URL) return null;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 3000,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (e) => console.error('[pg] idle client error:', e.message));
  return pool;
}

let schemaPromise = null;
function ensureSchema(pool) {
  if (!schemaPromise) {
    schemaPromise = pool
      .query(`
        CREATE TABLE IF NOT EXISTS visits (
          id     serial PRIMARY KEY,
          at     timestamptz NOT NULL DEFAULT now(),
          host   text,
          ip     text
        );
        CREATE TABLE IF NOT EXISTS job_runs (
          id      serial PRIMARY KEY,
          ran_at  timestamptz NOT NULL DEFAULT now(),
          note    text,
          host    text
        );
      `)
      .catch((e) => {
        schemaPromise = null; // retry next time
        throw e;
      });
  }
  return schemaPromise;
}

function createRedis(name) {
  if (!process.env.REDIS_URL) return null;
  const client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 3000,
      reconnectStrategy: (retries) => Math.min(retries * 500, 5000),
    },
  });
  wireRedisLogging(client, name);
  client.connect().catch(() => {}); // errors are logged by the handler, retries continue
  return client;
}

function wireRedisLogging(client, name) {
  let lastError = '';
  client.on('error', (e) => {
    if (e.message !== lastError) console.error(`[redis:${name}] ${e.message}`);
    lastError = e.message;
  });
  client.on('ready', () => {
    lastError = '';
    console.log(`[redis:${name}] connected`);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { withTimeout, createPg, ensureSchema, createRedis, wireRedisLogging, sleep };
