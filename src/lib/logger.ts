import pino from 'pino';

export type LoggerOptions = {
  level?: pino.LevelWithSilent;
  pretty?: boolean;
};

export function createLogger(options: LoggerOptions = {}) {
  const { level = 'info', pretty = false } = options;

  const pinoOptions: pino.LoggerOptions = { level };

  if (pretty) {
    // Use pino-pretty for human-readable dev output
    pinoOptions.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'UTC:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
        customLogLevel: (_: unknown, method: number) => {
          if (method >= 60) return 'error';
          if (method >= 50) return 'error';
          if (method >= 40) return 'warn';
          if (method >= 30) return 'info';
          if (method >= 20) return 'debug';
          return 'trace';
        },
      },
    };
  }

  return pino(pinoOptions);
}
