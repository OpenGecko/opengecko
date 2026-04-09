import Fastify, { type FastifyInstance } from 'fastify';

import { formatHttpCompactPLog } from '../http/http-log-style';
import type { AppConfig } from '../config/env';
import type { BuildAppOptions } from './types';

export function createLoggerOptions(config: AppConfig) {
  const useEmojiCompactHttpLogs = config.logPretty && config.httpLogStyle === 'emoji_compact_p';
  const logger = config.logLevel === 'silent'
    ? false
    : {
        level: config.logLevel,
        ...(useEmojiCompactHttpLogs ? { timestamp: false } : {}),
        ...(config.logPretty ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l',
              ignore: useEmojiCompactHttpLogs ? 'pid,hostname,req,res,responseTime' : 'pid,hostname',
            },
          },
        } : {}),
      };

  return { logger, useEmojiCompactHttpLogs };
}

export function createFastifyApp(config: AppConfig, options: BuildAppOptions): FastifyInstance {
  const suppressBuiltInLogsUntilReady = options.startupProgress != null;
  const { logger: loggerOpts, useEmojiCompactHttpLogs } = createLoggerOptions(config);
  const app = Fastify({
    logger: loggerOpts,
    ...(useEmojiCompactHttpLogs ? { disableRequestLogging: true } : {}),
    ...((options.pluginTimeout !== undefined || options.startupPluginTimeout !== undefined)
      ? { pluginTimeout: options.startupPluginTimeout ?? options.pluginTimeout }
      : {}),
    connectionTimeout: config.requestTimeoutMs,
    requestTimeout: config.requestTimeoutMs,
    ...(suppressBuiltInLogsUntilReady ? { disableStartupMessages: true } : {}),
  });

  if (useEmojiCompactHttpLogs) {
    app.addHook('onResponse', (request, reply, done) => {
      const message = formatHttpCompactPLog({
        timestamp: new Date(),
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
        reqId: request.id,
        slowThresholdMs: 1000,
      });

      app.log.info(message);
      done();
    });
  }

  return app;
}
