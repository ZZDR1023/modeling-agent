import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  readServerConfig
} from "../src/server/config.js";

describe("server configuration", () => {
  it("uses loopback-only defaults", () => {
    expect(readServerConfig({})).toEqual({
      host: DEFAULT_SERVER_HOST,
      port: DEFAULT_SERVER_PORT,
      runsRoot: "runs"
    });
  });

  it("reads explicit host, port, and runs root", () => {
    expect(readServerConfig({
      MODELING_AGENT_HOST: "::1",
      MODELING_AGENT_PORT: "5432",
      MODELING_AGENT_RUNS_ROOT: "./temporary-runs"
    })).toEqual({ host: "::1", port: 5432, runsRoot: "./temporary-runs" });
  });

  it.each(["", "0", "65536", "abc", "43.17"])("rejects invalid port %s", (port) => {
    expect(() => readServerConfig({ MODELING_AGENT_PORT: port })).toThrow(/port/i);
  });
});
