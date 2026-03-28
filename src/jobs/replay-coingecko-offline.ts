import { runOfflineReplay } from '../coingecko/offline-replay';

export async function runOfflineReplayCli(argv: string[] = process.argv.slice(2)) {
  const report = await runOfflineReplay({
    validationApiBaseUrl: process.env.OPENGECKO_VALIDATION_API_URL ?? 'http://127.0.0.1:3102',
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && process.argv[1].endsWith('replay-coingecko-offline.ts')) {
  runOfflineReplayCli().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
