# Project Atlas — Thrico white-label build worker

Runs on the build Mac. Takes store builds of white-label Thrico apps off an AWS SQS queue, builds them
from a `release/*` branch of [thrico-mobile](https://github.com/thrico/thrico-mobile), and uploads them
for testing only (Play internal track as a draft, or TestFlight). Every step and every command's output
show up live on the admin dashboard's **Builds** page. Nothing goes to production without an admin
doing it in Play Console or App Store Connect.

How it works in detail: [docs/build-worker.md](docs/build-worker.md).

## Setup

Needs Node 20+, Xcode + CocoaPods (iOS), Android SDK + JDK (Android), and fastlane on the PATH.

```bash
pnpm install
```

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | What it is |
|---|---|
| `CUSTOM_APP_BUILD_QUEUE_URL` | The FIFO build queue thrico-logic sends builds to |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Credentials allowed to receive, delete and change visibility on that queue (an AWS profile works too) |
| `THRICO_API_URL` | thrico-logic base URL (serves `/worker/builds/...`). This Mac's IP must be on its admin IP allowlist |
| `BUILD_WORKER_TOKEN` | Same value as `BUILD_WORKER_TOKEN` on thrico-logic, 32+ characters |
| `BUILD_TIME_LIMIT_MINUTES` | Whole-build limit, default 120 |
| `APP_GOOGLE_MAPS_API_KEY`, `APP_SENTRY_DSN`, `APP_API_URL`, `APP_WS_URL` | Baked into every app |

Signing keys are **not** configured here: each build fetches its app's keys from thrico-logic.

## Run

Poll the queue (the normal mode):

```bash
npm start
```

Run one queued build by id, without SQS (for testing):

```bash
npm start -- --build <buildId>
```

Self-check (no network, no build):

```bash
npm run check
```

Stop with Ctrl-C or SIGTERM: a running build is failed, cleaned up and reported before the worker exits.

## Code map

| File | Role |
|---|---|
| `src/index.ts` | Entry point: queue mode or `--build <id>` |
| `src/worker.ts` | SQS loop: receive, fetch bundle, run, delete message |
| `src/api.ts` | thrico-logic client and `BuildReporter` (step reports, batched log upload) |
| `src/pipeline.ts` | Step order, time limit, cleanup, final report |
| `src/utils/command.ts` | Runs a command, streams its output lines, honours the abort |
| `src/steps/config.ts` | Writes the keys into the build folder and maps the bundle onto the payload |
| `src/steps/*.ts` | Clone, assets, branding, dependencies, Android, iOS, artifacts, cleanup |
| `src/worker.check.ts` | Self-check |
