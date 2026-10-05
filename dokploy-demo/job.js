// One-off job for Dokploy "Schedules": records a run in Postgres and prunes old visits.
// Command to schedule:  node job.js            (optionally: node job.js "nightly cleanup")
const os = require('os');
const { createPg, ensureSchema } = require('./lib');

(async () => {
  const pg = createPg();
  if (!pg) {
    console.error('[job] DATABASE_URL is not set');
    process.exit(1);
  }
  try {
    await ensureSchema(pg);
    const note = process.argv.slice(2).join(' ') || 'scheduled run';
    const { rows } = await pg.query(
      'INSERT INTO job_runs (note, host) VALUES ($1, $2) RETURNING id, ran_at',
      [note, os.hostname()],
    );
    console.log(`[job] run #${rows[0].id} recorded at ${rows[0].ran_at.toISOString()} ("${note}")`);
    const pruned = await pg.query("DELETE FROM visits WHERE at < now() - interval '30 days'");
    console.log(`[job] pruned ${pruned.rowCount} visit(s) older than 30 days`);
  } catch (e) {
    console.error('[job] failed:', e.message);
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
})();
