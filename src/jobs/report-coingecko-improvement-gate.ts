import { createImprovementGateReport } from '../coingecko/improvement-gate';

export async function runCoinGeckoImprovementGateCli() {
  const report = createImprovementGateReport({
    baselineReportPath: process.env.COINGECKO_BASELINE_DIFF_REPORT_PATH ?? 'data/coingecko-snapshots/replay/baseline-diff-report.json',
    currentReportPath: process.env.COINGECKO_CURRENT_DIFF_REPORT_PATH ?? 'data/coingecko-snapshots/replay/diff-report.json',
  });

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (!report.passed) {
    process.exitCode = 1;
  }

  return report;
}

if (process.argv[1] && process.argv[1].endsWith('report-coingecko-improvement-gate.ts')) {
  runCoinGeckoImprovementGateCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
