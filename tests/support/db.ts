import 'dotenv/config';
import { Client } from 'pg';

// Single shared connection for the test run. If Playwright Test workers run
// in parallel and this becomes a bottleneck/source of cross-test interference,
// switch to a pool keyed per worker (testInfo.workerIndex) instead.
export const db = new Client({ connectionString: process.env.DATABASE_URL });

let connected = false;
export async function ensureDbConnected(): Promise<void> {
  if (!connected) {
    await db.connect();
    connected = true;
  }
}