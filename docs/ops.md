# Operations

How keep runs, is backed up and is restored. The decision behind it is
[ADR 0024](decisions/0024-rust-sqlite-per-org.md). The plan is
`factory/plans/migration-rust.sv`, step F2.

## Shape

One Fly app per environment, each with one machine and one volume, in
London (`lhr`):

| app | host | data | deploys |
|---|---|---|---|
| `keep-staging` | `staging.keep-together.org.uk` | reset to the riverside seed on every deploy | every push to `main` (`deploy.yml`) |
| `keep-prod` | `app.keep-together.org.uk` | real | by hand, from cutover (C2) |

The image (`rs/Dockerfile`) holds the api, the built SPA, Litestream and
a few scripts. The process tree inside the machine:

```
entrypoint.sh            restore an empty volume, reset staging, then exec
└─ litestream replicate  replicates /data/platform.db and /data/orgs/*.db to S3
   └─ api                serves /api, /healthz and the SPA on :8080
                         runs the hourly snapshot job
```

Litestream is PID 1 (after the entrypoint execs), so replication starts
before the api writes anything and gets the last WAL frames out after the
api exits. Fly sends SIGTERM, Litestream passes it to the api, and
`kill_timeout` gives both 30 s.

Data on the volume (`/data`):

| path | what |
|---|---|
| `platform.db` | tenants, users, memberships, sessions, the snapshot ledger |
| `orgs/<tenant-id>.db` | one organisation, named by its 32-hex tenant id |
| `premigrate/` | the `VACUUM INTO` copies taken before a boot migration (F1) |
| `snapshots-tmp/` | the snapshot job's scratch copies, removed after each file |
| `.image` | the image the data belongs to (staging's reset compares it) |

## Settings

Set in `fly.staging.toml` or the image: `KEEP_ENV`, `KEEP_DATA_DIR=/data`,
`KEEP_BIND=0.0.0.0`, `KEEP_PORT=8080`, `KEEP_STATIC_DIR=/app/dist`,
`KEEP_LITESTREAM_SOCKET=/run/litestream.sock`, `KEEP_RESET_SEED`
(staging only; refused when `KEEP_ENV=prod`).

Fly secrets:

| secret | from | used by |
|---|---|---|
| `LITESTREAM_BUCKET`, `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY` | `scripts/aws/backup.sh <env>` | Litestream, `restore.sh litestream` |
| `KEEP_SNAPSHOT_BUCKET`, `KEEP_SNAPSHOT_ACCESS_KEY_ID`, `KEEP_SNAPSHOT_SECRET_ACCESS_KEY` | `scripts/aws/backup.sh <env>` | the snapshot job, `keep-snapshot` |
| `SENTRY_DSN` | Sentry project, EU region | api errors |
| `KEEP_RESTORE_SOURCE`, `RESTORE_EXTRA` | set and unset by the drill | the entrypoint's restore |

GitHub (repo settings): secret `FLY_API_TOKEN`; variables `STAGING_URL`,
`SENTRY_DSN_SPA` (built into the SPA; a DSN is public by design),
`LITESTREAM_BUCKET`, `SNAPSHOT_BUCKET`, later `PROD_URL`; secrets
`DRILL_LITESTREAM_KEY_ID/_SECRET` and `DRILL_SNAPSHOT_KEY_ID/_SECRET` for
`drill.yml`.

Locally none of this is needed: without `LITESTREAM_BUCKET` the
entrypoint runs the api alone, and without `KEEP_SNAPSHOT_BUCKET` there
are no snapshots. `KEEP_SNAPSHOT_BUCKET=file:///some/dir` uses a
directory as the bucket, for trying the restore path.

## First-time setup (the human runs these)

In order. Each script is idempotent and echoes every command.

1. `aws sso login --profile mgmt`, then `scripts/aws/bootstrap.sh`: adds
   the `keep-backup` account (it asks before creating it).
2. `scripts/aws/backup.sh staging`: both buckets, the IAM users, and the
   `fly secrets set` and `gh secret set` lines with the new keys.
3. `fly auth login`, then `scripts/fly/staging.sh`: the app, the volume,
   the secrets it still lacks, the certificate; it prints the Route 53
   record and the GitHub token commands.
4. Add the Route 53 record, run the printed `gh` commands, then deploy:
   `fly deploy -c fly.staging.toml` or push to `main`.
5. Run the restore drill (below) and paste its table into the log at the
   end of this page.

At cutover: `scripts/aws/backup.sh prod`, a `scripts/fly/prod.sh` (C2
writes it from `staging.sh`), and the prod path of `deploy.yml`.

## Backups

Two copies, independent of each other.

**Litestream** (continuous). Bucket `keep-litestream-<keep-prod
account>` in `keep-prod`, eu-west-2, versioned, SSE-S3, public access
blocked. Layout: `<prefix>/platform.db/…` and
`<prefix>/orgs/<tenant-id>.db/…`. The prefix is `prod` for prod. Staging
gets `staging/<deployment>` because its reset recreates every file on
each deploy, and a fresh file must not meet the previous one's replica.
It syncs every second, takes a full snapshot daily and keeps 7 days, so
any point in the last week can be restored. Old object versions expire
after 30 days, and staging's prefixes after 14. The IAM user
`keep-litestream-<env>` can read, write and delete under its env's
prefix only. Litestream needs delete for its own retention.

**Hourly snapshots.** Bucket `keep-snapshots-<keep-backup account>` in
the `keep-backup` account, which runs nothing else, with Object Lock
(governance, 2 days). The job is `api::backup`. Every hour it copies
each org file whose newest revision moved since its last snapshot, plus
`platform.db`, with `VACUUM INTO`. It checks the copy with
`integrity_check`, compresses it with zstd and uploads it to
`<tier>/<env>/<tenant-id|platform>/<YYYY-MM-DDTHHZ>.db.zst`:

- `hourly/` when the file changed in the last hour; expires after 2 days;
- `daily/` at the first run of a UTC day, when it changed since the last
  daily; expires after 30 days;
- `monthly/` at the first run of a UTC month, whether it changed or not;
  expires after 365 days.

The newest state of every file is always in the bucket: hourly for two
days, then daily, then monthly. The IAM user `keep-snapshots-<env>` can
put, get and list under its env's prefixes and is explicitly denied
delete, retention changes and bucket policy or lifecycle changes. A
leaked app key can't destroy a snapshot, and neither can anyone who owns
`keep-prod`. The ledger of what was uploaded is the `snapshots` table in
`platform.db`. Fly's daily volume snapshots are a third copy we don't
rely on.

`keep-snapshot run --data /data` runs one pass by hand, beside the
running api.

## Restoring

**A lost machine or volume** restores itself. When a machine boots on a
volume without `platform.db` and a backup is configured, the entrypoint
runs `restore.sh` into `/data/restoring`, trying Litestream first and
then the snapshots if Litestream has nothing. The files move into place
only when every one is back and passed `integrity_check`. Then
Litestream starts as usual. If a source exists but fails (bad
credentials, a corrupt file), the machine doesn't start. Starting empty
there would replicate an empty `platform.db` over the real one. So:

```
fly volumes create keep_data -a keep-staging --region lhr --size 1
fly deploy -c fly.staging.toml --image <current image>   # or fly machine run …
fly logs -a keep-staging | grep 'restore:'
```

Set the secret `KEEP_RESTORE_SOURCE=snapshot` (`--stage`, before the
deploy) to restore from the snapshots on purpose, and unset it after.

**Point in time** (an app bug or a bad import, data still there). Restore
next to the live data, look, then swap by hand. Inside the machine:

```
export AWS_ACCESS_KEY_ID=$LITESTREAM_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$LITESTREAM_SECRET_ACCESS_KEY
prefix=prod   # staging: staging/<deployment>, the tag part of FLY_IMAGE_REF
litestream restore -timestamp 2026-10-24T09:00:00Z -o /data/pit/<id>.db \
  s3://$LITESTREAM_BUCKET/$prefix/orgs/<id>.db
sqlite3 -readonly /data/pit/<id>.db 'PRAGMA integrity_check'
```

To put one org back: stop the machine, replace `orgs/<id>.db` (and
delete its `-wal`/`-shm`), start it. The file carries its tenant id, so
it only opens under its own name. A snapshot works the same way:
download `<tier>/<env>/<id>/<stamp>.db.zst` with the AWS CLI and
`zstd -d` it.

**Everything, anywhere** (no Fly). `scripts/ops/restore.sh litestream
<dir>` or `restore.sh snapshot <dir>` with the same environment variables
restores into any empty directory, which `api` can then serve. That's
what `drill.yml` does each month on a GitHub runner.

## Restore drill

`scripts/ops/restore-drill.sh [litestream|snapshot|both]`, run by the
human against `keep-staging`. It:

1. seeds a 10k org (`drill`, the perf generator's people, through the
   `seed` bin) and takes a snapshot pass;
2. records counts with `drill.sh census`: tenants, and per org contacts,
   revisions and the matches of five search terms;
3. per source, destroys the machine (`--force`) and its volume, creates
   an empty volume and redeploys the same image, so the entrypoint
   restores; for Litestream it first starts a loop committing one row a
   time to `orgs/drill-marks.db` and printing each, to measure what the
   kill lost;
4. waits for `/healthz`, reads `restore: all files Ns` from the logs,
   recounts and diffs, and compares the last committed mark with the
   last restored one;
5. prints the table below and exits 1 if anything misses.

**Pass:** a 10k org back in under 60 s from either source, counts and
search matches equal, and at most 1 s of committed writes lost on
Litestream. Snapshots lose up to an hour by design.

`drill.yml` repeats the restore part monthly (the 1st, 06:00 UTC) with
read-only keys. It restores from both sources on a runner, fails if a
file fails `integrity_check`, if either source takes 60 s or more, or if
the two list different tenants, and puts the timings in the run summary.

## Monitoring

- `/healthz` (Fly's check every 15 s, and the cron): 200 when
  `platform.db` answers. Its `backup` field has `snapshotAgeSeconds` (of
  the last `platform.db` snapshot, which every run takes),
  `snapshotErrors` (from this process's last run), `litestream`
  (`ok`/`error`/`off`), `litestreamLagSeconds` (the worst database's
  seconds since its last sync, from the control socket's `GET /list`)
  and `litestreamDatabases`. A stale backup doesn't fail the Fly check:
  that would take the only machine out of service.
- `health.yml` every 15 minutes, for each URL in `STAGING_URL` and
  `PROD_URL`: fails on a non-200, a snapshot older than 2 h or never
  taken, snapshot errors, Litestream not `ok`, or a lag over
  `LITESTREAM_MAX_LAG` (default 300 s). A failure opens an issue labelled
  `health`, or comments on the open one. GitHub emails it.
- Sentry, EU region. The api reports panics and logged errors
  (`SENTRY_DSN`). The SPA loads Sentry's CDN bundle (one pinned version,
  with SRI) only when the build had `VITE_SENTRY_DSN`. Both drop users,
  cookies, headers, bodies and query strings, and redact anything shaped
  like an email address.
- Litestream's Prometheus metrics on :9090, scraped by Fly (`[metrics]`).

## Staging reset

`KEEP_RESET_SEED=riverside`: on the first boot of a new image (the
image ref differs from `/data/.image`) the entrypoint wipes `/data`
before Litestream starts, and the api seeds the `riverside` org. Restarts
and restored volumes keep their data. Until B3 ports the real riverside
seed it is a placeholder: one org, an admin `riverside-admin@example.com`
and 12 contacts. Until auth (A4) lands there is no way to sign in on
staging, because dev auth stays loopback-only.

## To verify on the first real run

Checked locally (podman, 2026-10-24, file replicas instead of S3): the
image builds; Litestream 0.5.17 accepts `rs/litestream.yml` (socket,
snapshot keys, `dir` + `watch` beside a `path`, `${VAR}` expansion) and
picks up an org file created while running; `GET /list` keeps
`last_sync_at` fresh for idle databases, so the lag check doesn't flag
quiet orgs; SIGTERM reaches the api through Litestream and both exit
cleanly; an empty volume restores itself through the entrypoint (row
below).

Still to verify on the first real run (no AWS or Fly from the builder's
sandbox):

- Litestream against S3 with the IAM user limited to its prefix.
- The snapshot bucket accepts `object_store`'s uploads with
  `x-amz-checksum-sha256`, which Object Lock requires (it refuses a PUT
  without Content-MD5 or a checksum).
- `fly deploy --image <same ref>` onto an app with no machines creates
  one with the new volume, and `FLY_IMAGE_REF` keeps its value, so
  staging's reset doesn't wipe the restored data.
- The Docker build on Fly's builder: `node:24-trixie-slim`,
  `rust:1.97-slim-trixie`, BuildKit cache mounts.

## Drill log

| date | env | source | restore (all files) | boot to healthy | counts | marks lost |
|---|---|---|---|---|---|---|
| 2026-10-24 | local podman, file replica (not the drill) | litestream | 0.3 s (10k org + riverside) | not timed | equal | 0 rows (SIGKILL mid-write) |
