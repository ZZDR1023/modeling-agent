import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runSyntheticBenchmarks } from "./synthetic.js";

function parseOutputDirectory(argv: readonly string[]): string {
  const outputIndex = argv.indexOf("--output");
  if (outputIndex === -1) return resolve("benchmarks/output/synthetic");
  const value = argv[outputIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--output requires a directory");
  }
  return resolve(value);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const outputDirectory = parseOutputDirectory(argv);
  const run = await runSyntheticBenchmarks({ output_directory: outputDirectory });
  process.stdout.write(`${JSON.stringify({
    suite_id: run.report.suite_id,
    total_runs: run.report.summary.total_runs,
    completed_runs: run.report.summary.completed_runs,
    json_report: run.paths.json_path,
    markdown_report: run.paths.markdown_path
  }, null, 2)}\n`);
}

const entryUrl = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (entryUrl === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Synthetic benchmark failed: ${message}\n`);
    process.exitCode = 1;
  });
}
