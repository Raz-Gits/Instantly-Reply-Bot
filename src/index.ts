import { getConfig } from './core/config.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  const config = getConfig();
  const app = buildServer();

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`);
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`webhook endpoint: POST http://${config.HOST}:${config.PORT}/webhooks/instantly`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
