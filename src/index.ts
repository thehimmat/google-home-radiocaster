import { startScheduler } from './scheduler';

const now = new Date().toLocaleString();
console.log(`\n=== Radio Caster started at ${now} ===`);

startScheduler();

// Keep the process alive so cron jobs can fire.
// Press Ctrl+C to stop.
