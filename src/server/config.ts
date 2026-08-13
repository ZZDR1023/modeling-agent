export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 4317;

export interface ServerConfig {
  host: string;
  port: number;
  runsRoot: string;
}

export function readServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const host = env.MODELING_AGENT_HOST ?? DEFAULT_SERVER_HOST;
  const rawPort = env.MODELING_AGENT_PORT;
  const port = rawPort === undefined ? DEFAULT_SERVER_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("MODELING_AGENT_PORT must be an integer between 1 and 65535.");
  }
  return {
    host,
    port,
    runsRoot: env.MODELING_AGENT_RUNS_ROOT ?? "runs"
  };
}
