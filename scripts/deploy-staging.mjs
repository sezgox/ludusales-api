import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const branch = process.env.WORKERS_CI_BRANCH;
if (branch && branch !== 'staging') {
  console.log(`Skipping the integration Preview for branch ${branch}.`);
  process.exit(0);
}

const workerName = 'ludusales-api';
const database = 'ludusales-db-staging';
const config = 'wrangler.preview.jsonc';
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

const buildWorker = process.env.WRANGLER_CI_OVERRIDE_NAME;
if (buildWorker && buildWorker !== workerName) {
  throw new Error(`The integration Preview must target ${workerName}.`);
}

const adminCode = process.env.STAGING_ADMIN_CODE?.trim();
if (!adminCode || adminCode.length < 20 || adminCode.length > 80) {
  throw new Error('Set STAGING_ADMIN_CODE to a unique login code of 20–80 characters.');
}

function runWrangler(args, capture = false) {
  const result = spawnSync(process.execPath, [wrangler, ...args, '--config', config], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler ${args.slice(0, 2).join(' ')} failed.`);
  return result.stdout;
}

runWrangler(['d1', 'migrations', 'apply', database, '--remote']);

const execute = ['d1', 'execute', database, '--remote'];
const demoCompany = '11000000-0000-4000-8000-000000000014';
const [demo] = JSON.parse(runWrangler([
  ...execute,
  '--command', `SELECT 1 FROM companies WHERE public_id = '${demoCompany}'`,
  '--json',
], true));
if (!demo.results.length) {
  runWrangler([...execute, '--file', './seed/portal-demo.sql']);
}

const codeHash = createHash('sha256').update(adminCode).digest('base64url');
runWrangler([...execute, '--command', `
  INSERT INTO users (public_id, role, display_name, email, access_code_hash)
  VALUES ('c24d42a1-d63f-4f0a-ad11-d6844c27aedb', 'superuser', 'Admin integración',
    'juan.mateo+integracion@ludusales.com', '${codeHash}')
  ON CONFLICT(public_id) DO UPDATE SET access_code_hash = excluded.access_code_hash
  WHERE users.access_code_hash <> excluded.access_code_hash;
`]);

runWrangler(['preview', '--worker-name', workerName, '--name', 'staging']);
