import dotenv from 'dotenv';
import { MobileBuildWorker } from './worker';

dotenv.config();

const worker = new MobileBuildWorker();

worker.start().then(() => {
  console.log('Mobile Build Worker is running...');
});

let isShuttingDown = false;

process.on('SIGINT', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('Shutting down worker...');
  await worker.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('Shutting down worker...');
  await worker.stop();
  process.exit(0);
});
