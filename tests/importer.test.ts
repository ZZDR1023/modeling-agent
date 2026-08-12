import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importPackage, resolveSafePath } from "../src/input/package-importer.js";

describe("package importer", () => {
  it("inventories supported files with content identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-import-"));
    await mkdir(join(root, "data"));
    await writeFile(join(root, "problem.md"), "# Demo\n\nQuestion 1: Analyze the data.\n", "utf8");
    await writeFile(join(root, "data", "values.csv"), "x,target\n1,2\n2,4\n", "utf8");
    await writeFile(join(root, "notes.txt"), "local notes", "utf8");

    const imported = await importPackage(root);
    expect(imported.problemText).toContain("Analyze the data");
    expect(imported.dataAssets.map((asset) => asset.relative_path)).toEqual([
      "data/values.csv",
      "notes.txt"
    ]);
    expect(imported.dataAssets[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(imported.dataAssets[0]?.artifact_id).toMatch(/^input-[a-f0-9]{12}$/);
  });

  it("rejects traversal and all symlink inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "modeling-import-safe-"));
    await writeFile(join(root, "problem.md"), "# Demo\nQuestion 1: Analyze.\n", "utf8");
    await writeFile(join(root, "values.csv"), "x,target\n1,2\n", "utf8");
    await symlink(join(root, "values.csv"), join(root, "values-link.csv"));
    await expect(Promise.resolve().then(() => resolveSafePath(root, "../outside.csv"))).rejects.toThrow(
      /outside package/
    );
    await expect(importPackage(root)).rejects.toThrow(/Symlink inputs are not allowed/);
  });
});
