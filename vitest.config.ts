import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations('./migrations');

  return {
    test: {
      server: {
        deps: {
          inline: ['sanitize-html'],
        },
      },
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.test.jsonc' },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
