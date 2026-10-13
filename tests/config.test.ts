import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig, URL_SETTING_PATTERN } from "../src/config.js";

const SALT = "0123456789abcdef0123";

function load(pluginConfig: Record<string, unknown>) {
  return loadConfig({ pluginConfig } as unknown as Parameters<typeof loadConfig>[0]);
}

describe("loadConfig URL schemes", () => {
  it("accepts https URLs and fills the defaults", () => {
    const cfg = load({ publicBaseUrl: "https://gateway.example", channelHashSalt: SALT });
    expect(cfg.publicBaseUrl).toBe("https://gateway.example");
    expect(cfg.baseUrl).toBe("https://backend.alterauth.com");
  });

  it.each(["http://localhost:18789", "http://127.0.0.1:18789", "http://[::1]:18789"])(
    "accepts http on a loopback host (%s) for local development",
    (url) => {
      expect(load({ publicBaseUrl: url, walletBaseUrl: url, channelHashSalt: SALT }).publicBaseUrl).toBe(url);
    },
  );

  it.each([
    "http://gateway.example",
    "http://localhost.example.com",
    "http://127.0.0.1.example.com",
    "http://127.0.0.1@evil.example",
    "http://localhost@evil.example",
    "http://0.0.0.0:18789",
    "http://127.0.0.2",
    "http://[::ffff:127.0.0.1]",
    "http://10.0.0.5:18789",
    // Other spellings of a loopback address: the manifest refuses them, so the plugin does too.
    "HTTP://LOCALHOST",
    "http://127.1",
    "http://2130706433",
    "http://0x7f.0.0.1",
    "http://[0:0:0:0:0:0:0:1]",
    "http://localhost:/",
    "http://localhost?q",
    "http://localhost#frag",
    " http://localhost",
    "http://localhost:99999",
    "http://127.0.0.1:65536",
    "ftp://localhost",
    "localhost:18789",
  ])("rejects %s", (url) => {
    expect(() => load({ publicBaseUrl: url, channelHashSalt: SALT })).toThrow(/must use https:\/\//);
  });

  it("applies the same rule to baseUrl and walletBaseUrl", () => {
    expect(() =>
      load({ publicBaseUrl: "https://gateway.example", baseUrl: "http://backend.example", channelHashSalt: SALT }),
    ).toThrow(/config\.baseUrl/);
    expect(() =>
      load({ publicBaseUrl: "https://gateway.example", walletBaseUrl: "http://wallet.example", channelHashSalt: SALT }),
    ).toThrow(/config\.walletBaseUrl/);
  });

  it("uses the exact pattern the manifest declares, which OpenClaw checks before the plugin loads", () => {
    const schema = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"))
      .configSchema.properties as Record<string, { pattern: string }>;
    for (const key of ["publicBaseUrl", "baseUrl", "walletBaseUrl"]) {
      expect(schema[key]!.pattern, key).toBe(URL_SETTING_PATTERN);
    }
  });

  it("still requires publicBaseUrl and a long enough salt", () => {
    expect(() => load({ channelHashSalt: SALT })).toThrow(/publicBaseUrl/);
    expect(() => load({ publicBaseUrl: "https://gateway.example", channelHashSalt: "short" })).toThrow(/channelHashSalt/);
  });
});
