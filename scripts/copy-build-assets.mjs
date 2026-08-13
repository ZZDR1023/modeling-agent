import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(root, "dist");
const pythonSource = resolve(root, "python");
const pythonDestination = resolve(dist, "python");
const pythonPackageDestination = resolve(pythonDestination, "modeling_agent");
const pythonModules = ["__init__.py", "forecasting.py", "io.py", "metrics.py", "runner.py"];

// Compiled workers and report generation resolve these assets relative to dist/src.
await rm(pythonDestination, { recursive: true, force: true });
await mkdir(pythonPackageDestination, { recursive: true });
await Promise.all([
  ...pythonModules.map((filename) => cp(resolve(pythonSource, "modeling_agent", filename), resolve(pythonPackageDestination, filename))),
  cp(resolve(pythonSource, "requirements.lock"), resolve(pythonDestination, "requirements.lock")),
  cp(resolve(pythonSource, "standalone.Dockerfile"), resolve(pythonDestination, "standalone.Dockerfile")),
  cp(resolve(pythonSource, "standalone_reproduce.py"), resolve(pythonDestination, "standalone_reproduce.py"))
]);
