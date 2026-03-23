import { buildApp } from './app';
import { loadConfig } from './config/env';
import { createStartupProgressTracker } from './services/startup-progress';

async function start() {
  const startupProgress = createStartupProgressTracker();
  startupProgress.start();

  try {
    const config = loadConfig();
    startupProgress.complete('load_config');
    const app = buildApp({
      config,
      startBackgroundJobs: true,
      pluginTimeout: 120_000,
      startupProgress,
    });

    await app.listen({
      host: config.host,
      port: config.port,
    });
    startupProgress.complete('start_http_listener');
    startupProgress.start(config.port);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    startupProgress.failCurrent(message);
    console.error(error);
    process.exit(1);
  }
}

void start();
