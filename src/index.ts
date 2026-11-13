import dotenv from 'dotenv';
import { workerCall } from './api';
import { MobileBuildWorker } from './worker';

dotenv.config();

const worker = new MobileBuildWorker();
const args = process.argv.slice(2);
const buildId = args.includes('--build') ? args[args.indexOf('--build') + 1] : undefined;

// `--build <id>` runs that one queued build without SQS (for testing); otherwise poll the queue.
const main = buildId
  ? workerCall(`/worker/builds/${buildId}/bundle`).then((bundle) => worker.runBuild(bundle))
  : worker.start().then(() => new Promise(() => {}));

main.then(
  () => process.exit(0),
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);

let isShuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log('Shutting down worker...');
    await worker.stop();
    process.exit(0);
  });
}
