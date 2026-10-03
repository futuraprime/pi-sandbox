import type { CredentialEnvVarConfig } from "@carderne/sandbox-runtime";

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as NetServer } from "node:net";
import { networkInterfaces } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";

import { buildMaskedEnvVars } from "@carderne/sandbox-runtime/dist/sandbox/credential-mask-env.js";
import { SentinelRegistry } from "@carderne/sandbox-runtime/dist/sandbox/credential-sentinel.js";
import { createHttpProxyServer } from "@carderne/sandbox-runtime/dist/sandbox/http-proxy.js";
import { createMitmCA, disposeMitmCA } from "@carderne/sandbox-runtime/dist/sandbox/mitm-ca.js";
import { mintLeafCert } from "@carderne/sandbox-runtime/dist/sandbox/mitm-leaf.js";
import assert from "node:assert/strict";

import { domainMatchesPattern } from "../src/policy.ts";

const ENABLED = process.env.PI_SANDBOX_CREDENTIAL_CLI_ACCEPTANCE === "1";
const GITHUB_SECRET = "pi-sandbox-cli-test-gh-secret-6a12";
const NPM_SECRET = "pi-sandbox-cli-test-npm-secret-9c47";
const UNAPPROVED_SECRET = "pi-sandbox-cli-test-unapproved-secret-3d85";
const API_HOST = privateInterfaceAddress();

interface SeenRequest {
  url: string;
  authorization?: string;
  unapproved?: string;
}

function privateInterfaceAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const octets = entry.address.split(".").map(Number);
      if (
        octets[0] === 10 ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)
      ) {
        return entry.address;
      }
    }
  }
  return undefined;
}

function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function listen(server: NetServer, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("local fixture did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: NetServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runCli(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    timeout.unref();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function isolatedEnv(root: string, cliPaths: string[]): NodeJS.ProcessEnv {
  const dirs = {
    home: join(root, "home"),
    config: join(root, "xdg-config"),
    cache: join(root, "xdg-cache"),
    state: join(root, "xdg-state"),
    tmp: join(root, "tmp"),
  };
  for (const path of Object.values(dirs)) mkdirSync(path, { recursive: true });
  return {
    PATH: [
      ...new Set([
        ...cliPaths.map(dirname),
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/opt/homebrew/bin",
      ]),
    ].join(delimiter),
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    TMPDIR: dirs.tmp,
    TMP: dirs.tmp,
    TEMP: dirs.tmp,
    LANG: "C.UTF-8",
    TERM: "dumb",
    CI: "1",
    GH_CONFIG_DIR: join(dirs.config, "gh"),
    GH_STATE_DIR: join(dirs.state, "gh"),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_PROXY: "",
    no_proxy: "",
  };
}

function redactedCliError(stderr: string): string {
  let redacted = stderr;
  for (const secret of [GITHUB_SECRET, NPM_SECRET, UNAPPROVED_SECRET]) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.slice(0, 4000).trim() || "(no stderr)";
}

function assertNoPlaintext(values: Iterable<string>, secrets: string[]): void {
  for (const value of values) {
    for (const secret of secrets) assert.equal(value.includes(secret), false);
  }
}

const disabledReason = ENABLED
  ? false
  : "set PI_SANDBOX_CREDENTIAL_CLI_ACCEPTANCE=1 to run real local CLI acceptance probes";

test(
  "real gh and npm CLIs use fake credentials and proxy-only host substitution",
  {
    skip: disabledReason,
  },
  async (t) => {
    const gh = findExecutable("gh");
    const npm = findExecutable("npm");
    if (!gh || !npm) {
      t.skip(
        "requires installed gh and npm executables; no CLI is installed or downloaded by this test",
      );
      return;
    }
    if (!API_HOST) {
      t.skip(
        "requires a private IPv4 interface so Go's proxy client does not bypass the local proxy for loopback",
      );
      return;
    }

    const registry = new SentinelRegistry();
    const envVars: CredentialEnvVarConfig[] = [
      { name: "GH_ENTERPRISE_TOKEN", mode: "mask", injectHosts: [API_HOST] },
      { name: "NPM_TOKEN", mode: "mask", injectHosts: ["localhost"] },
      { name: "PI_UNAPPROVED_TOKEN", mode: "mask", injectHosts: ["unapproved.invalid"] },
    ];
    const masked = buildMaskedEnvVars(envVars, [API_HOST, "localhost"], registry, {
      GH_ENTERPRISE_TOKEN: GITHUB_SECRET,
      NPM_TOKEN: NPM_SECRET,
      PI_UNAPPROVED_TOKEN: UNAPPROVED_SECRET,
    });
    assert.deepEqual(masked.degradeToUnsetNames, []);
    const ghFake = masked.setEnvVars.GH_ENTERPRISE_TOKEN;
    const npmFake = masked.setEnvVars.NPM_TOKEN;
    const unapprovedFake = masked.setEnvVars.PI_UNAPPROVED_TOKEN;
    assert.ok(ghFake && npmFake && unapprovedFake);
    assertNoPlaintext(
      [ghFake, npmFake, unapprovedFake],
      [GITHUB_SECRET, NPM_SECRET, UNAPPROVED_SECRET],
    );
    const root = mkdtempSync(join(process.cwd(), ".pi-sandbox-cli-compatibility-"));

    const seen: SeenRequest[] = [];
    let ca: ReturnType<typeof createMitmCA> | undefined;
    let upstream: ReturnType<typeof createHttpsServer> | undefined;
    let upstreamListening = false;
    let npmUpstream: ReturnType<typeof createHttpsServer> | undefined;
    let npmUpstreamListening = false;
    let proxyListening = false;
    let proxy: NetServer | undefined;

    try {
      ca = createMitmCA({});
      const upstreamLeaf = mintLeafCert(ca, API_HOST);
      const handleRequest: RequestListener = (req, res) => {
        seen.push({
          url: req.url ?? "",
          authorization: req.headers.authorization,
          unapproved: req.headers["x-pi-unapproved"] as string | undefined,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          req.url?.includes("whoami")
            ? JSON.stringify({ username: "fixture-user" })
            : JSON.stringify({ ok: true }),
        );
      };
      upstream = createHttpsServer(
        { key: upstreamLeaf.keyPem, cert: upstreamLeaf.certPem },
        handleRequest,
      );
      const upstreamPort = await listen(upstream, API_HOST);
      upstreamListening = true;
      const npmLeaf = mintLeafCert(ca, "localhost");
      npmUpstream = createHttpsServer(
        { key: npmLeaf.keyPem, cert: npmLeaf.certPem },
        handleRequest,
      );
      const npmUpstreamPort = await listen(npmUpstream, "localhost");
      npmUpstreamListening = true;
      proxy = createHttpProxyServer({
        filter: (port, host) =>
          (host === API_HOST && port === upstreamPort) ||
          (host === "localhost" && port === npmUpstreamPort),
        mitmCA: ca,
        tlsTerminateUpstreamCA: ca.certPem,
        mutateHeaders: (headers, host) =>
          registry.substituteInHeaders(headers, host, domainMatchesPattern),
      });
      const proxyPort = await listen(proxy, "127.0.0.1");
      proxyListening = true;

      const ghEnv = {
        ...isolatedEnv(root, [gh]),
        GH_ENTERPRISE_TOKEN: ghFake,
        PI_UNAPPROVED_TOKEN: unapprovedFake,
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        SSL_CERT_FILE: ca.trustBundlePath,
      };
      const ghArgs = [
        "api",
        "--hostname",
        API_HOST,
        "-H",
        `X-Pi-Unapproved: ${unapprovedFake}`,
        `https://${API_HOST}:${upstreamPort}/api/v3/user`,
      ];
      assertNoPlaintext(
        [...ghArgs, ...Object.values(ghEnv).filter((value): value is string => Boolean(value))],
        [GITHUB_SECRET, NPM_SECRET, UNAPPROVED_SECRET],
      );
      const ghRun = await runCli(gh, ghArgs, ghEnv, root);
      assert.equal(
        ghRun.status,
        0,
        `gh api must exit successfully: ${redactedCliError(ghRun.stderr)}`,
      );
      assert.equal(
        JSON.parse(ghRun.stdout)?.ok === true,
        true,
        "gh api must receive the fixture JSON response",
      );
      const ghRequest = seen.find(
        (request) => request.url.includes("/api/v3/user") || request.url === "/user",
      );
      assert.ok(ghRequest, "gh api must reach the local TLS upstream through the fixture");
      assert.equal(
        ghRequest.authorization?.split(/\s+/).at(-1) === GITHUB_SECRET,
        true,
        "approved GitHub credential is substituted only at the local upstream",
      );
      assert.equal(
        ghRequest.unapproved,
        unapprovedFake,
        "sentinel for an unapproved host stays fake on the wire",
      );

      const npmrcPath = join(root, "npmrc");
      const globalNpmrcPath = join(root, "global-npmrc");
      const npmEnv = {
        ...isolatedEnv(root, [npm]),
        NPM_CONFIG_USERCONFIG: npmrcPath,
        NPM_CONFIG_GLOBALCONFIG: globalNpmrcPath,
        NPM_CONFIG_CACHE: join(root, "npm-cache"),
        NPM_CONFIG_LOGS_DIR: join(root, "npm-logs"),
        NPM_CONFIG_HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        NPM_CONFIG_NO_PROXY: "",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_FETCH_RETRIES: "0",
        NPM_CONFIG_FETCH_TIMEOUT: "10000",
        NPM_CONFIG_LOGLEVEL: "verbose",
        NPM_CONFIG_STRICT_SSL: "true",
        NODE_EXTRA_CA_CERTS: ca.certPath,
        NPM_CONFIG_CAFILE: ca.trustBundlePath,
      };
      writeFileSync(
        npmrcPath,
        [
          `registry=https://localhost:${npmUpstreamPort}/`,
          `//localhost:${npmUpstreamPort}/:_authToken=${npmFake}`,
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(globalNpmrcPath, "", "utf8");
      const npmArgs = ["whoami", "--registry", `https://localhost:${npmUpstreamPort}/`];
      assertNoPlaintext(
        [
          ...npmArgs,
          ...Object.values(npmEnv).filter((value): value is string => Boolean(value)),
          readFileSync(npmrcPath, "utf8"),
        ],
        [GITHUB_SECRET, NPM_SECRET, UNAPPROVED_SECRET],
      );
      const npmRun = await runCli(npm, npmArgs, npmEnv, root);
      assert.equal(
        npmRun.status,
        0,
        `npm whoami must exit successfully: ${redactedCliError(npmRun.stderr)}`,
      );
      assert.equal(
        npmRun.stdout.trim() === "fixture-user",
        true,
        "npm whoami must receive the fixture username",
      );
      const npmRequest = seen.find((request) => request.url.includes("whoami"));
      assert.ok(npmRequest, "npm whoami must reach the local TLS upstream through the fixture");
      assert.equal(
        npmRequest.authorization?.split(/\s+/).at(-1) === NPM_SECRET,
        true,
        "approved npm credential is substituted only at the local upstream",
      );

      const requestsBeforeDeniedHost = seen.length;
      const deniedRun = await runCli(
        gh,
        ["api", "--hostname", "unapproved.invalid", "user"],
        ghEnv,
        root,
      );
      assert.notEqual(deniedRun.status, 0, "unapproved upstream must not succeed");
      assert.match(deniedRun.stderr, /403|forbidden/i, "proxy must explicitly deny the host");
      assert.equal(seen.length, requestsBeforeDeniedHost, "denied host must not reach upstream");

      assertNoPlaintext(
        [
          ghRun.stdout,
          ghRun.stderr,
          npmRun.stdout,
          npmRun.stderr,
          deniedRun.stdout,
          deniedRun.stderr,
        ],
        [GITHUB_SECRET, NPM_SECRET, UNAPPROVED_SECRET],
      );
    } finally {
      if (proxyListening && proxy) await close(proxy);
      if (upstreamListening && upstream) await close(upstream);
      if (npmUpstreamListening && npmUpstream) await close(npmUpstream);
      if (ca) await disposeMitmCA(ca);
      registry.clear();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

const wranglerSkip = !ENABLED
  ? disabledReason
  : !findExecutable("wrangler")
    ? "Wrangler CLI is absent; it is not installed or downloaded by this test"
    : "unverified: Wrangler has no configured local API-base override in this fixture; " +
      "no mock or live request is used";

test(
  "optional Wrangler CLI compatibility is explicitly unverified",
  { skip: wranglerSkip },
  () => {},
);
