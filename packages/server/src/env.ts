import { existsSync } from 'fs';
import { resolve } from 'path';

// Load the repo-root .env (works whether started from the root or from packages/server)
for (const candidate of [resolve(process.cwd(), '.env'), resolve(__dirname, '../../../.env')]) {
    if (existsSync(candidate)) { process.loadEnvFile(candidate); break; }
}
