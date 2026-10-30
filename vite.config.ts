import tailwindcss from '@tailwindcss/postcss';
import { cloudflare } from '@cloudflare/vite-plugin';
import vinext from 'vinext';
import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';
import { licenseReportFile, thirdPartyNoticesPlugin } from './scripts/third-party-notices.mjs';

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.CLOUDFLARE_DEV_REGISTRY_PATH ??= '.wrangler/registry';

  const localWranglerConfig = new URL('./wrangler.local.jsonc', import.meta.url);
  const wranglerConfigPath = process.env.CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH
    ?? (existsSync(localWranglerConfig) ? 'wrangler.local.jsonc' : undefined);

  return {
    build: { license: { fileName: licenseReportFile } },
    css: { postcss: { plugins: [tailwindcss()] } },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      thirdPartyNoticesPlugin(),
      vinext(),
      cloudflare({
        configPath: wranglerConfigPath,
        inspectorPort: isCodexSeatbeltSandbox ? false : undefined,
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
      }),
    ],
  };
});
