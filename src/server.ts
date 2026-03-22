import { buildApp } from './app';
import { loadConfig } from './config/env';

const config = loadConfig();
const app = buildApp({ config, startBackgroundJobs: true, pluginTimeout: 120_000 });

async function start() {
  try {
    await app.listen({
      host: config.host,
      port: config.port,
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void start();
