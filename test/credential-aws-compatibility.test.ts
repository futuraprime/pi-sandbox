import type { CredentialEnvVarConfig } from "@carderne/sandbox-runtime";

import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, RequestListener } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as NetServer } from "node:net";
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
const ACCESS_KEY_ID = "pi-sandbox-aws-access-4b72";
const SECRET_ACCESS_KEY = "pi-sandbox-aws-secret-9ce1";
const SESSION_TOKEN = "pi-sandbox-aws-session-6d03";

interface SignatureCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
}

interface SignedRequest {
  method: string;
  target: URL;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface FixtureReceipt {
  matchesControlCredentials: boolean;
  matchesMaskedInputs: boolean;
  status: number;
}

function findExecutable(name: string): string | undefined {
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/homebrew/bin",
  ];
  for (const directory of new Set(directories)) {
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
        reject(new Error("local AWS fixture did not bind a TCP port"));
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

function isolatedEnv(root: string, aws: string): NodeJS.ProcessEnv {
  const dirs = {
    home: join(root, "home"),
    config: join(root, "xdg-config"),
    cache: join(root, "xdg-cache"),
    state: join(root, "xdg-state"),
    tmp: join(root, "tmp"),
  };
  for (const path of Object.values(dirs)) mkdirSync(path, { recursive: true });
  const awsConfig = join(root, "aws-config");
  const awsCredentials = join(root, "aws-credentials");
  writeFileSync(awsConfig, "", "utf8");
  writeFileSync(awsCredentials, "", "utf8");
  return {
    PATH: [
      ...new Set([
        dirname(process.execPath),
        dirname(aws),
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
    AWS_CONFIG_FILE: awsConfig,
    AWS_SHARED_CREDENTIALS_FILE: awsCredentials,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_METADATA_SERVICE_TIMEOUT: "1",
    AWS_METADATA_SERVICE_NUM_ATTEMPTS: "1",
    AWS_MAX_ATTEMPTS: "1",
    AWS_RETRY_MODE: "standard",
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_REGION: "us-east-1",
  };
}

function sha256(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(searchParams: URLSearchParams): string {
  return [...searchParams.entries()]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function normalizedHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value.join(",") : value).trim().replace(/\s+/g, " ");
}

function verifySigV4(request: SignedRequest, credentials: SignatureCredentials): boolean {
  const authorization = normalizedHeader(request.headers, "authorization");
  const match = authorization?.match(
    /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/,
  );
  if (!match) return false;

  const [, credential, signedHeaderValue, suppliedSignature] = match;
  const scope = credential.match(/^([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request$/);
  const amzDate = normalizedHeader(request.headers, "x-amz-date");
  if (!scope || !amzDate || scope[1] !== credentials.accessKeyId) return false;
  if (scope[3] !== credentials.region || scope[4] !== credentials.service) return false;
  if (!/^\d{8}T\d{6}Z$/.test(amzDate) || scope[2] !== amzDate.slice(0, 8)) return false;

  const signedHeaders = signedHeaderValue.split(";");
  if (
    signedHeaders.join(";") !== [...signedHeaders].sort().join(";") ||
    !signedHeaders.includes("host")
  ) {
    return false;
  }
  const actualToken = normalizedHeader(request.headers, "x-amz-security-token");
  if (credentials.sessionToken !== actualToken) return false;
  if (credentials.sessionToken !== undefined && !signedHeaders.includes("x-amz-security-token")) {
    return false;
  }

  const canonicalHeaders: string[] = [];
  for (const name of signedHeaders) {
    const value = normalizedHeader(request.headers, name);
    if (value === undefined) return false;
    canonicalHeaders.push(`${name}:${value}\n`);
  }
  const canonicalPath = request.target.pathname.split("/").map(awsEncode).join("/");
  const canonicalRequest = [
    request.method,
    canonicalPath || "/",
    canonicalQuery(request.target.searchParams),
    canonicalHeaders.join(""),
    signedHeaderValue,
    sha256(request.body).toString("hex"),
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    `${scope[2]}/${scope[3]}/${scope[4]}/aws4_request`,
    sha256(canonicalRequest).toString("hex"),
  ].join("\n");
  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, scope[2]);
  const regionKey = hmac(dateKey, scope[3]);
  const serviceKey = hmac(regionKey, scope[4]);
  const signingKey = hmac(serviceKey, "aws4_request");
  const expectedSignature = hmac(signingKey, stringToSign);
  const actualSignature = Buffer.from(suppliedSignature, "hex");
  return (
    actualSignature.length === expectedSignature.length &&
    timingSafeEqual(actualSignature, expectedSignature)
  );
}

async function requestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function assertNoPlaintext(values: Iterable<string>, secrets: string[]): void {
  for (const value of values) {
    for (const secret of secrets) assert.equal(value.includes(secret), false);
  }
}

function redactedCliError(stderr: string): string {
  let redacted = stderr;
  for (const secret of [ACCESS_KEY_ID, SECRET_ACCESS_KEY, SESSION_TOKEN]) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted.slice(0, 4_000);
}

const disabledReason = ENABLED
  ? false
  : "set PI_SANDBOX_CREDENTIAL_CLI_ACCEPTANCE=1 to run the local AWS CLI proof";

test("SigV4 verifier matches the published AWS IAM ListUsers signing example", () => {
  const verified = verifySigV4(
    {
      method: "GET",
      target: new URL("https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08"),
      headers: {
        authorization:
          "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        host: "iam.amazonaws.com",
        "x-amz-date": "20150830T123600Z",
      },
      body: Buffer.alloc(0),
    },
    {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "iam",
    },
  );
  assert.equal(verified, true);
});

test(
  "real AWS CLI SigV4 succeeds with control credentials and rejects a masked signing secret",
  { skip: disabledReason },
  async (t) => {
    const aws = findExecutable("aws");
    if (!aws) {
      t.skip("AWS CLI is absent; no CLI is installed or downloaded by this test");
      return;
    }

    const registry = new SentinelRegistry();
    const envVars: CredentialEnvVarConfig[] = [
      { name: "AWS_ACCESS_KEY_ID", mode: "mask", injectHosts: ["localhost"] },
      { name: "AWS_SECRET_ACCESS_KEY", mode: "mask", injectHosts: ["localhost"] },
      { name: "AWS_SESSION_TOKEN", mode: "mask", injectHosts: ["unapproved.invalid"] },
    ];
    const masked = buildMaskedEnvVars(envVars, ["localhost"], registry, {
      AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: SESSION_TOKEN,
    });
    assert.deepEqual(masked.degradeToUnsetNames, []);
    const maskedAccessKey = masked.setEnvVars.AWS_ACCESS_KEY_ID;
    const maskedSecret = masked.setEnvVars.AWS_SECRET_ACCESS_KEY;
    const maskedSessionToken = masked.setEnvVars.AWS_SESSION_TOKEN;
    assert.ok(maskedAccessKey && maskedSecret && maskedSessionToken);
    assertNoPlaintext(
      [maskedAccessKey, maskedSecret, maskedSessionToken],
      [ACCESS_KEY_ID, SECRET_ACCESS_KEY, SESSION_TOKEN],
    );

    const root = mkdtempSync(join(process.cwd(), ".pi-sandbox-aws-compatibility-"));
    const receipts: FixtureReceipt[] = [];
    const deniedTargets: string[] = [];
    let expectedSessionToken = SESSION_TOKEN;
    let ca: ReturnType<typeof createMitmCA> | undefined;
    let upstream: ReturnType<typeof createHttpsServer> | undefined;
    let upstreamListening = false;
    let proxy: NetServer | undefined;
    let proxyListening = false;

    try {
      ca = createMitmCA({});
      const leaf = mintLeafCert(ca, "localhost");
      const handleRequest: RequestListener = async (req, res) => {
        const body = await requestBody(req);
        const target = new URL(req.url ?? "/", "https://localhost");
        const signedRequest: SignedRequest = {
          method: req.method ?? "",
          target,
          headers: req.headers,
          body,
        };
        const matchesControlCredentials = verifySigV4(signedRequest, {
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
          sessionToken: expectedSessionToken,
          region: "us-east-1",
          service: "sts",
        });
        const matchesMaskedInputs = verifySigV4(signedRequest, {
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: maskedSecret,
          sessionToken: expectedSessionToken,
          region: "us-east-1",
          service: "sts",
        });
        const status = matchesControlCredentials ? 200 : 403;
        receipts.push({ matchesControlCredentials, matchesMaskedInputs, status });

        if (
          req.method !== "POST" ||
          target.pathname !== "/" ||
          target.search !== "" ||
          body.toString("utf8") !== "Action=GetCallerIdentity&Version=2011-06-15"
        ) {
          res.writeHead(400, { "content-type": "text/xml" });
          res.end(
            "<ErrorResponse><Error><Code>InvalidRequest</Code><Message>unexpected request</Message></Error></ErrorResponse>",
          );
          return;
        }
        if (!matchesControlCredentials) {
          res.writeHead(403, { "content-type": "text/xml" });
          res.end(
            '<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>SignatureDoesNotMatch</Code><Message>The request signature does not match.</Message></Error><RequestId>fixture-request</RequestId></ErrorResponse>',
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/xml" });
        res.end(
          '<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/fixture-user</Arn><UserId>AIDAFIXTUREUSER</UserId><Account>123456789012</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>fixture-request</RequestId></ResponseMetadata></GetCallerIdentityResponse>',
        );
      };
      upstream = createHttpsServer({ key: leaf.keyPem, cert: leaf.certPem }, handleRequest);
      const upstreamPort = await listen(upstream, "localhost");
      upstreamListening = true;
      proxy = createHttpProxyServer({
        filter: (port, host) => {
          const allowed = host === "localhost" && port === upstreamPort;
          if (!allowed) deniedTargets.push(`${host}:${port}`);
          return allowed;
        },
        mitmCA: ca,
        tlsTerminateUpstreamCA: ca.certPem,
        mutateHeaders: (headers, host) =>
          registry.substituteInHeaders(headers, host, domainMatchesPattern),
      });
      const proxyPort = await listen(proxy, "127.0.0.1");
      proxyListening = true;

      const baseEnv = isolatedEnv(root, aws);
      const proxyEnv = {
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        https_proxy: `http://127.0.0.1:${proxyPort}`,
        http_proxy: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: "",
        no_proxy: "",
        AWS_CA_BUNDLE: ca.trustBundlePath,
      };
      const controlEnv = {
        ...baseEnv,
        ...proxyEnv,
        AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: SESSION_TOKEN,
      };
      const endpointArgs = (endpoint: string) => [
        "sts",
        "get-caller-identity",
        "--endpoint-url",
        endpoint,
        "--region",
        "us-east-1",
        "--output",
        "json",
        "--cli-connect-timeout",
        "5",
        "--cli-read-timeout",
        "5",
      ];

      const controlRun = await runCli(
        aws,
        endpointArgs(`https://localhost:${upstreamPort}`),
        controlEnv,
        root,
      );
      assertNoPlaintext(
        [controlRun.stdout, controlRun.stderr],
        [ACCESS_KEY_ID, SECRET_ACCESS_KEY, SESSION_TOKEN],
      );
      assert.equal(
        controlRun.status,
        0,
        `control AWS CLI request must succeed through the fixture: ${redactedCliError(controlRun.stderr)}`,
      );
      assert.equal(JSON.parse(controlRun.stdout)?.Account, "123456789012");
      assert.equal(receipts.length, 1, "the control request must arrive once at the HTTPS fixture");
      assert.equal(receipts[0].matchesControlCredentials, true);
      assert.equal(receipts[0].status, 200);

      expectedSessionToken = maskedSessionToken;
      const maskedEnv = {
        ...baseEnv,
        ...proxyEnv,
        AWS_ACCESS_KEY_ID: maskedAccessKey,
        AWS_SECRET_ACCESS_KEY: maskedSecret,
        AWS_SESSION_TOKEN: maskedSessionToken,
      };
      const maskedArgs = endpointArgs(`https://localhost:${upstreamPort}`);
      assertNoPlaintext(
        [
          ...maskedArgs,
          ...Object.values(maskedEnv).filter((value): value is string => Boolean(value)),
        ],
        [ACCESS_KEY_ID, SECRET_ACCESS_KEY, SESSION_TOKEN],
      );
      const receiptsBeforeMasked = receipts.length;
      const maskedRun = await runCli(aws, maskedArgs, maskedEnv, root);
      assertNoPlaintext(
        [maskedRun.stdout, maskedRun.stderr],
        [ACCESS_KEY_ID, SECRET_ACCESS_KEY, SESSION_TOKEN],
      );
      assert.notEqual(maskedRun.status, 0, "masked signing secret must not authenticate");
      assert.ok(/SignatureDoesNotMatch/.test(maskedRun.stderr));
      assert.equal(
        receipts.length,
        receiptsBeforeMasked + 1,
        "the masked request must reach the fixture",
      );
      assert.equal(receipts.at(-1)?.matchesControlCredentials, false);
      assert.equal(
        receipts.at(-1)?.matchesMaskedInputs,
        true,
        "the fixture independently verifies the signature made with the masked secret and signed token",
      );
      assert.equal(receipts.at(-1)?.status, 403);

      const receiptsBeforeDenied = receipts.length;
      const deniedRun = await runCli(
        aws,
        endpointArgs("https://unapproved.invalid"),
        maskedEnv,
        root,
      );
      assert.notEqual(deniedRun.status, 0, "unapproved AWS endpoint must not succeed");
      assert.ok(
        deniedTargets.includes("unapproved.invalid:443"),
        "the local proxy must record denying the exact unapproved endpoint",
      );
      assertNoPlaintext(
        [deniedRun.stdout, deniedRun.stderr],
        [ACCESS_KEY_ID, SECRET_ACCESS_KEY, SESSION_TOKEN],
      );
      assert.equal(
        receipts.length,
        receiptsBeforeDenied,
        "denied endpoint must not reach the fixture",
      );
    } finally {
      try {
        await Promise.all([
          ...(proxyListening && proxy ? [close(proxy)] : []),
          ...(upstreamListening && upstream ? [close(upstream)] : []),
        ]);
      } finally {
        try {
          if (ca) await disposeMitmCA(ca);
        } finally {
          registry.clear();
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
);
