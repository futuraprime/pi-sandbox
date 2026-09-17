import type { CredentialEnvVarConfig, CredentialFileConfig } from "@carderne/sandbox-runtime";

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMaskedEnvVars } from "@carderne/sandbox-runtime/dist/sandbox/credential-mask-env.js";
import {
  buildMaskedFileBinds,
  MaskedFileStore,
} from "@carderne/sandbox-runtime/dist/sandbox/credential-mask-files.js";
import { SentinelRegistry } from "@carderne/sandbox-runtime/dist/sandbox/credential-sentinel.js";
import { wrapCommandWithSandboxMacOS } from "@carderne/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import assert from "node:assert/strict";

import { domainMatchesPattern } from "../src/policy.ts";

const SYNTHETIC_SECRET = "pi-sandbox-synthetic-credential-7f3c";
const INJECT_HOST = "api.example.com";
const OTHER_HOST = "reachable-but-unlisted.example.com";

function hostMatches(host: string, pattern: string): boolean {
  return domainMatchesPattern(host, pattern);
}

function containsPlaintext(values: Iterable<string>, plaintext: string): boolean {
  return [...values].some((value) => value.includes(plaintext));
}

test("masked environment values stay fake and substitute only at explicitly configured hosts", () => {
  const registry = new SentinelRegistry();
  const envVars: CredentialEnvVarConfig[] = [
    {
      name: "PI_SYNTHETIC_TOKEN",
      mode: "mask",
      injectHosts: [INJECT_HOST],
    },
  ];
  const { setEnvVars, degradeToUnsetNames } = buildMaskedEnvVars(
    envVars,
    [INJECT_HOST, OTHER_HOST],
    registry,
    { PI_SYNTHETIC_TOKEN: SYNTHETIC_SECRET },
  );
  const fake = setEnvVars.PI_SYNTHETIC_TOKEN;

  assert.equal(degradeToUnsetNames.length, 0);
  assert.equal(typeof fake, "string");
  assert.equal(fake.includes(SYNTHETIC_SECRET), false, "sandbox env must not contain plaintext");

  const injectedHeaders = { authorization: `Bearer ${fake}` };
  registry.substituteInHeaders(injectedHeaders, INJECT_HOST, hostMatches);
  assert.equal(
    injectedHeaders.authorization?.includes(SYNTHETIC_SECRET),
    true,
    "the configured host receives the real credential only at proxy substitution",
  );

  const unlistedHeaders = { authorization: `Bearer ${fake}` };
  registry.substituteInHeaders(unlistedHeaders, OTHER_HOST, hostMatches);
  assert.equal(
    unlistedHeaders.authorization,
    `Bearer ${fake}`,
    "an unlisted reachable host keeps the fake sentinel",
  );
  assert.equal(
    containsPlaintext(
      [JSON.stringify(setEnvVars), unlistedHeaders.authorization],
      SYNTHETIC_SECRET,
    ),
    false,
    "captured sandbox values and unlisted output must not contain plaintext",
  );
});

test("macOS sandbox wrapper enforces environment deny and mask without plaintext output", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS sandbox wrapper");
    return;
  }

  const maskedRegistry = new SentinelRegistry();
  const { setEnvVars } = buildMaskedEnvVars(
    [
      {
        name: "PI_MASKED_TOKEN",
        mode: "mask",
        injectHosts: [INJECT_HOST],
      },
    ],
    [INJECT_HOST],
    maskedRegistry,
    { PI_MASKED_TOKEN: SYNTHETIC_SECRET },
  );
  const masked = wrapCommandWithSandboxMacOS({
    command: 'printf "%s" "$PI_MASKED_TOKEN"',
    needsNetworkRestriction: false,
    readConfig: { denyOnly: [] },
    writeConfig: undefined,
    setEnvVars,
    binShell: "sh",
  });
  const maskedRun = spawnSync("/bin/sh", ["-c", masked], {
    encoding: "utf8",
    env: { ...process.env, PI_MASKED_TOKEN: SYNTHETIC_SECRET },
  });
  assert.equal(maskedRun.status, 0, "masked child should complete");
  assert.equal(maskedRun.stdout, setEnvVars.PI_MASKED_TOKEN);
  assert.equal(
    containsPlaintext([maskedRun.stdout, maskedRun.stderr], SYNTHETIC_SECRET),
    false,
    "captured masked child output must not contain plaintext",
  );

  const denied = wrapCommandWithSandboxMacOS({
    command: 'printf "${PI_DENIED_TOKEN-unset}"',
    needsNetworkRestriction: false,
    readConfig: { denyOnly: [] },
    writeConfig: undefined,
    unsetEnvVars: ["PI_DENIED_TOKEN"],
    binShell: "sh",
  });
  const deniedRun = spawnSync("/bin/sh", ["-c", denied], {
    encoding: "utf8",
    env: { ...process.env, PI_DENIED_TOKEN: SYNTHETIC_SECRET },
  });
  assert.equal(deniedRun.status, 0, "denied child should complete");
  assert.equal(deniedRun.stdout, "unset");
  assert.equal(
    containsPlaintext([deniedRun.stdout, deniedRun.stderr], SYNTHETIC_SECRET),
    false,
    "captured denied child output must not contain plaintext",
  );
});

test("characterizes environment JWT decode mismatch requiring boundary rejection", () => {
  const syntheticPlaintext = "pi-sandbox-invalid-jwt-value-must-not-be-printed";
  const registry = new SentinelRegistry();
  const invalidJwt = buildMaskedEnvVars(
    [
      {
        name: "PI_INVALID_JWT",
        mode: "mask",
        decode: "jwt",
        onExtractNoMatch: "deny",
        injectHosts: [INJECT_HOST],
      },
    ],
    [INJECT_HOST],
    registry,
    { PI_INVALID_JWT: syntheticPlaintext },
  );

  // Runtime 0.0.72 leaves a failed JWT decode inherited rather than applying
  // onExtractNoMatch. The config boundary rejects this policy before this
  // runtime path can receive it; this direct characterization must not print
  // or otherwise expose the synthetic value.
  assert.deepEqual(invalidJwt.setEnvVars, {});
  assert.deepEqual(invalidJwt.degradeToUnsetNames, []);
  assert.equal(JSON.stringify(invalidJwt).includes(syntheticPlaintext), false);
});

test("denied environment values and structured extraction mismatch fail closed", () => {
  const registry = new SentinelRegistry();
  const denied = buildMaskedEnvVars(
    [
      {
        name: "PI_DENIED_TOKEN",
        mode: "deny",
        injectHosts: [INJECT_HOST],
      },
    ],
    [INJECT_HOST],
    registry,
    { PI_DENIED_TOKEN: SYNTHETIC_SECRET },
  );
  assert.deepEqual(denied.setEnvVars, {});

  const mismatch = buildMaskedEnvVars(
    [
      {
        name: "PI_STRUCTURED_TOKEN",
        mode: "mask",
        extract: "expected=(\\S+)",
        onExtractNoMatch: "deny",
        injectHosts: [INJECT_HOST],
      },
    ],
    [INJECT_HOST],
    registry,
    { PI_STRUCTURED_TOKEN: "prefix-without-a-matching-capture" },
  );
  assert.deepEqual(mismatch.setEnvVars, {});
  assert.deepEqual(mismatch.degradeToUnsetNames, ["PI_STRUCTURED_TOKEN"]);

  assert.throws(() =>
    buildMaskedEnvVars(
      [
        {
          name: "PI_STRUCTURED_ERROR",
          mode: "mask",
          extract: "expected=(\\S+)",
          onExtractNoMatch: "error",
          injectHosts: [INJECT_HOST],
        },
      ],
      [INJECT_HOST],
      registry,
      { PI_STRUCTURED_ERROR: "prefix-without-a-matching-capture" },
    ),
  );
});

test("file JWT decode mismatch honors fail-closed deny and error choices", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-credential-file-decode-"));
  const syntheticPlaintext = "pi-sandbox-file-jwt-value-must-not-be-printed";
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const missingClaimJwt = [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ sub: syntheticPlaintext }),
    "synthetic-signature",
  ].join(".");
  const cases = [
    {
      filename: "invalid-jwt.txt",
      content: `credential=${syntheticPlaintext}\neyJnot-json.eyJnot-json.signature\n`,
    },
    {
      filename: "missing-claim.txt",
      content: `credential=${missingClaimJwt}\n`,
    },
  ];

  try {
    for (const onExtractNoMatch of ["deny", "error"] as const) {
      for (const fileCase of cases) {
        const realPath = join(root, `${onExtractNoMatch}-${fileCase.filename}`);
        writeFileSync(realPath, fileCase.content, "utf8");
        const registry = new SentinelRegistry();
        const store = new MaskedFileStore();
        try {
          const build = () =>
            buildMaskedFileBinds(
              [
                {
                  path: realPath,
                  mode: "mask",
                  decode: "jwt",
                  maskClaims: ["access_token"],
                  onExtractNoMatch,
                  injectHosts: [INJECT_HOST],
                },
              ],
              [INJECT_HOST],
              registry,
              store,
            );

          if (onExtractNoMatch === "deny") {
            const result = build();
            assert.deepEqual(result.binds, []);
            assert.deepEqual(result.degradeToDenyPaths, [realpathSync(realPath)]);
          } else {
            assert.throws(build, (error: unknown) => {
              return !String(error).includes(syntheticPlaintext);
            });
          }
        } finally {
          store.dispose();
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("masked file material is fake while macOS wrapper denies the real path", (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS credential-file fallback");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-credential-file-"));
  const store = new MaskedFileStore();
  try {
    const realPath = join(root, "credential.txt");
    writeFileSync(realPath, `token=${SYNTHETIC_SECRET}\n`, "utf8");
    const registry = new SentinelRegistry();
    const files: CredentialFileConfig[] = [
      {
        path: realPath,
        mode: "mask",
        injectHosts: [INJECT_HOST],
      },
    ];
    const { binds } = buildMaskedFileBinds(files, [INJECT_HOST], registry, store);
    assert.equal(binds.length, 1);
    const fakeContent = readFileSync(binds[0].fakePath, "utf8");
    assert.equal(
      fakeContent.includes(SYNTHETIC_SECRET),
      false,
      "fake file must not contain plaintext",
    );

    const wrapped = wrapCommandWithSandboxMacOS({
      command: `cat ${JSON.stringify(realPath)}`,
      needsNetworkRestriction: false,
      readConfig: { denyOnly: [] },
      writeConfig: undefined,
      maskedFileBinds: binds,
      binShell: "sh",
    });
    assert.match(wrapped, /deny file-read\*/);
    assert.equal(wrapped.includes(realPath), true, "the real credential path is the denied path");
    assert.equal(
      wrapped.includes(binds[0].fakePath),
      false,
      "macOS must not deliver a fake file bind",
    );
    assert.equal(
      containsPlaintext([fakeContent, wrapped], SYNTHETIC_SECRET),
      false,
      "file reads and wrapper diagnostics must not contain plaintext",
    );

    const fileRun = spawnSync("/bin/sh", ["-c", wrapped], {
      encoding: "utf8",
      env: { ...process.env },
    });
    const spawnError = fileRun.error as NodeJS.ErrnoException | undefined;
    if (spawnError?.code === "EPERM") {
      assert.fail(
        "outer harness returned EPERM while spawning nested sandbox-exec; direct file-denial evidence is unavailable",
      );
    }
    assert.equal(spawnError, undefined, "direct nested sandbox-exec could not be spawned");
    assert.notEqual(fileRun.status, 0, "reading the real credential file must fail");
    assert.equal(fileRun.signal, null, "credential read should return a denial, not a signal");
    assert.equal(fileRun.stdout, "", "denied credential file must not produce stdout");
    assert.equal(
      containsPlaintext([fileRun.stdout, fileRun.stderr], SYNTHETIC_SECRET),
      false,
      "denied credential read must not disclose plaintext in child output",
    );
    assert.equal(
      fileRun.stderr.includes(realPath),
      true,
      "the child must report denial of the real path; otherwise nested execution may be blocked by the outer harness",
    );
  } finally {
    store.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
