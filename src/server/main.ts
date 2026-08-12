#!/usr/bin/env node
import { resolve } from "node:path";
import { SchemaRegistry } from "../contracts/schema-registry.js";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { readServerConfig } from "./config.js";
import { buildServer } from "./index.js";

async function main(): Promise<void> {
  const config = readServerConfig();
  const server = buildServer({
    host: config.host,
    logger: true,
    orchestrator: new Orchestrator({
      runsRoot: resolve(config.runsRoot),
      schemas: new SchemaRegistry(resolve(process.cwd(), "schemas"))
    })
  });
  let closing: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    server.log.info({ signal }, "Shutting down");
    closing = server.close().then(() => undefined);
    void closing.catch((error: unknown) => {
      server.log.error({ err: error }, "Graceful shutdown failed");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ status: "failed", error: { class: "server_startup_failure", message } })}\n`);
  process.exitCode = 1;
});
