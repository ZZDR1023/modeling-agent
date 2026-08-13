import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = resolve(root, "schemas");
const destination = resolve(root, "dist", "schemas");

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
