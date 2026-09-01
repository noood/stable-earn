import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const sourceConfigPath = resolve(projectRoot, 'wrangler.jsonc');
const generatedConfigPath = resolve(projectRoot, '.wrangler', 'deploy-wrangler.jsonc');

const requiredValues = [
  ['CLOUDFLARE_ACCOUNT_ID', process.env.CLOUDFLARE_ACCOUNT_ID],
  ['D1_DATABASE_ID', process.env.D1_DATABASE_ID],
  ['TEAM_DOMAIN', process.env.TEAM_DOMAIN],
  ['POLICY_AUD', process.env.POLICY_AUD],
];

const missing = requiredValues
  .filter(([, value]) => !value?.trim())
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(`Missing deployment configuration: ${missing.join(', ')}`);
  console.error('Set these as private environment variables before running npm run deploy.');
  process.exit(1);
}

const config = JSON.parse(readFileSync(sourceConfigPath, 'utf8'));
config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
config.vars = {
  ...config.vars,
  TEAM_DOMAIN: process.env.TEAM_DOMAIN,
  POLICY_AUD: process.env.POLICY_AUD,
};

if (!Array.isArray(config.d1_databases) || config.d1_databases.length === 0) {
  console.error('wrangler.jsonc must define at least one D1 database.');
  process.exit(1);
}

config.d1_databases[0].database_id = process.env.D1_DATABASE_ID;

mkdirSync(resolve(projectRoot, '.wrangler'), { recursive: true });
writeFileSync(generatedConfigPath, `${JSON.stringify(config, null, 2)}\n`);

const cliPath = resolve(projectRoot, 'node_modules', '.bin', 'vinext-cloudflare');
const deployArgs = process.argv.slice(2);
const configFlagIndex = deployArgs.indexOf('--config');
const explicitConfigPath = configFlagIndex >= 0 ? deployArgs[configFlagIndex + 1] : deployArgs
  .find((arg) => arg.startsWith('--config='))?.slice('--config='.length);
const configPath = explicitConfigPath ? resolve(projectRoot, explicitConfigPath) : generatedConfigPath;

if (!explicitConfigPath) {
  deployArgs.push('--config', generatedConfigPath);
}

const result = spawnSync(cliPath, ['deploy', ...deployArgs], {
  cwd: projectRoot,
  env: {
    ...process.env,
    CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: configPath,
  },
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Unable to start deployment: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
