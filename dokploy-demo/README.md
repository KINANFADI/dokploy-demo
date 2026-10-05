# Dokploy pre-flight demo

A small Node.js app that exercises every common Dokploy feature and shows the result on one page. Each integration is optional, so you can add pieces one at a time and watch the checklist turn green.

| What it tests | How you see it |
|---|---|
| Git build (Dockerfile or Nixpacks) | Page loads; build time shown in the header |
| Build-time args | `APP_VERSION` appears in the header |
| Runtime env vars & secrets | Environment row (secret is masked) |
| Domain, Traefik, Let's Encrypt | Domain & HTTPS row shows `https` and "behind proxy: yes" |
| PostgreSQL | Version, latency, stored visits |
| Redis | Version, latency, page-view counter |
| Multi-service networking | Worker heartbeat + queued jobs processed |
| Volumes | Boot counter survives redeploys |
| Health checks | `/health` (liveness) and `/ready` (dependencies) |
| Logs (stdout/stderr) | "Write log lines" button |
| Monitoring | "Load the CPU for 15s" button |
| Restart policy | "Crash the container" button (needs `ALLOW_CRASH=true`) |
| Scheduled jobs | `node job.js` writes a row; "last job run" updates |
| Zero-downtime redeploys | Graceful SIGTERM handling; page keeps polling |
| Auto-deploy webhooks | Push a commit, watch the build time change |

## Get the code into Git

Push this folder to a GitHub/GitLab/Gitea repo (public or connected to Dokploy). You can also try Dokploy's drag-and-drop zip upload with `dokploy-demo.zip`.

---

## Path A: Docker Compose (everything in one go)

1. **Create project** → **Create service** → **Compose**.
2. **General**: pick your Git provider/repo, branch `main`, compose path `./docker-compose.yml`.
3. **Environment**: paste the contents of `.env.example` and change the values. Keep `POSTGRES_PASSWORD` alphanumeric since it's embedded in a URL.
4. **Domains** → add domain: service `web`, port `3000`, path `/`, enable HTTPS with Let's Encrypt. (Point an A record at your server first, or use the free `traefik.me` domain Dokploy can generate.)
5. **Deploy**. Open the domain.

Expected: Domain, Env, Postgres, Redis and Worker show **Go**. Volume shows **Check** on the first boot; redeploy once and it turns green.

Notes: don't add `ports:` or `container_name:` to the compose file. Dokploy attaches Traefik through the domain you configure in the UI.

---

## Path B: Native Dokploy services (tests more of the platform)

This uses Dokploy's managed databases, so you also get to test database backups and the per-service UI.

1. **Create service → Database → PostgreSQL** (v16). Deploy it, then copy its **Internal connection URL**.
2. **Create service → Database → Redis**. Deploy it, copy its **Internal connection URL**.
3. **Create service → Application** (name it `web`):
   - Provider: your repo. Build type: **Dockerfile** (try **Nixpacks** later; `npm start` works with it too, but the build-time stamp and healthcheck only exist with the Dockerfile).
   - **Environment**:
     ```
     DATABASE_URL=<postgres internal URL>
     REDIS_URL=<redis internal URL>
     GREETING=Hello from a Dokploy application
     SECRET_KEY=something-long-and-random
     ALLOW_CRASH=true
     DEMO_FEATURE_FLAG=on
     ```
   - **Build-time arguments**: `APP_VERSION=1.0.0`
   - **Advanced → Volumes/Mounts**: add a **volume mount**, mount path `/data`.
   - **Domains**: your domain, container port `3000`, HTTPS on.
   - Deploy.
4. **Worker**: create a second Application from the same repo (name it `worker`), set `REDIS_URL` only, and in **Advanced** set the run command to `node worker.js`. No domain needed. The worker serves its own `/health`, so the image healthcheck still passes.
5. **Schedule**: on `web`, open **Schedules** and add a job with command `node job.js`, cron `*/5 * * * *`. Run it once manually, then check the Postgres row on the page.
6. **Backups**: on the Postgres service, add an S3 destination and a backup, run it, then try a restore.

---

## Test script (do these in order)

1. **First deploy** → all configured rows green except Volume (amber, first boot).
2. **Redeploy** → Volume turns green, boot count 2; build time changes only if it actually rebuilt.
3. **Change `GREETING`** and redeploy → new value on the page (env vars reach the container).
4. **Change `APP_VERSION`** build arg and redeploy → header shows it (build args reach the build).
5. **Queue a worker job** → in a few seconds "jobs done" goes up; worker logs show `job #N done`.
6. **Write log lines** → find the tag in the Logs tab (stdout and stderr).
7. **Load the CPU** → spike appears in Monitoring.
8. **Crash the container** → page shows "can't reach" briefly, then recovers with a new uptime and a higher boot count.
9. **Stop the Redis service** → Redis and Worker rows go red, `/ready` returns 503, but `/health` stays 200 so the app isn't killed. Start Redis again and both recover without redeploying the app.
10. **Push a commit** with auto-deploy enabled → new build time appears without clicking Deploy.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | Dashboard |
| `GET /health` | Liveness, used by Docker `HEALTHCHECK` |
| `GET /ready` | 503 if any configured dependency fails |
| `GET /api/status` | Full JSON status |
| `POST /api/enqueue` | Push a job to the worker queue |
| `POST /api/log` | Emit stdout/stderr lines |
| `POST /api/stress?seconds=15&threads=1` | Burn CPU (max 60s) |
| `POST /api/crash` | Exit with code 1 (only if `ALLOW_CRASH=true`) |

## Troubleshooting

- **Bad Gateway / 404 from Traefik**: the domain's port must be `3000`; for Compose, the domain must target the `web` service.
- **HTTPS row amber**: you're on plain HTTP; turn on HTTPS for the domain and make sure DNS points at the server.
- **Postgres "password authentication failed"** (Compose): the DB volume was initialised with an older password. Delete the `db-data` volume or restore the old password.
- **Volume row red, permission denied**: you used a bind mount owned by root. Use a Docker volume mount, or `chown 1000:1000` the host folder.
- **Worker amber**: the worker isn't running or uses a different `REDIS_URL` than the web app.

## Run locally

```bash
cp .env.example .env
docker compose up --build
# then publish port 3000 temporarily, or: docker compose exec web wget -qO- localhost:3000/api/status
```
