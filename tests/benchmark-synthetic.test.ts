import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSyntheticBenchmarks } from "../src/benchmark/synthetic.js";

describe("committed synthetic benchmark suite", () => {
  it("runs two cases for agent and one-shot, including the expected custom experiment, reproducibly", async () => {
    const firstOutput = await mkdtemp(join(tmpdir(), "benchmark-synthetic-first-"));
    const secondOutput = await mkdtemp(join(tmpdir(), "benchmark-synthetic-second-"));
    const first = await runSyntheticBenchmarks({ output_directory: firstOutput });
    const second = await runSyntheticBenchmarks({ output_directory: secondOutput });

    expect(first.results).toHaveLength(4);
    expect(new Set(first.results.map((entry) => entry.case_id)).size).toBe(2);
    expect(first.results.filter((entry) => entry.variant === "agent")).toHaveLength(2);
    expect(first.results.filter((entry) => entry.variant === "one_shot")).toHaveLength(2);
    expect(first.results.some((entry) => entry.metrics.custom_experiment_present.value === true)).toBe(true);
    expect(first.results.every((entry) => entry.metrics.completion.value === true)).toBe(true);

    expect(first.report).toEqual(second.report);
    expect(await readFile(first.paths.json_path, "utf8")).toBe(await readFile(second.paths.json_path, "utf8"));
    expect(await readFile(first.paths.markdown_path, "utf8")).toBe(await readFile(second.paths.markdown_path, "utf8"));

    const serialized = `${JSON.stringify(first.report)}\n${await readFile(first.paths.markdown_path, "utf8")}`;
    expect(serialized).not.toMatch(/\/(?:home|Users|tmp)\//);
    expect(serialized).not.toMatch(/(?:token|password|credential|secret)\s*[:=]\s*[^,\s}]+/i);
    expect(serialized).not.toContain("reference_answer");
  });
});
