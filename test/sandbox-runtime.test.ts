import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { mock, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { SandboxManager, type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import { wrapCommandWithSandboxMacOS } from "@carderne/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import {
  getDefaultWritePaths,
  containsGlobChars,
  globToRegex,
  removeTrailingGlobSuffix,
} from "@carderne/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  adaptMacosReadSpecificityProfile,
  adaptMacosWriteSpecificityProfile,
} from "../src/macos-write-specificity.ts";
import { canonicalizePath } from "../src/policy.ts";
import { getProtectedSandboxConfigPaths } from "../src/sandbox-command.ts";
import { resolveDerivedFilesystemAllowances } from "../src/sandbox-filesystem.ts";
import {
  buildGitSshCommand,
  buildRuntimeConfig,
  createNetworkAskCallback,
  createSandboxedBashOps,
  extractBlockedWritePath,
  initializeSandbox,
  resolveAllowances,
  supportsNodeEnvProxy,
} from "../src/sandbox-runtime.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function generatedMacosWrapper(
  config: SandboxRuntimeConfig,
  command = "printf profile-test",
  shell = "bash",
): string {
  const filesystem = config.filesystem!;
  return wrapCommandWithSandboxMacOS({
    command,
    binShell: shell,
    needsNetworkRestriction: false,
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: false,
    allowMachLookup: [],
    allowPty: false,
    allowBrowserProcess: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    readConfig: {
      denyOnly: [
        ...(filesystem.denyRead ?? []),
        ...(config.credentials?.files ?? [])
          .filter((file) => file.mode === "deny" || file.mode === "mask")
          .map((file) => file.path),
      ].map(removeTrailingGlobSuffix),
      allowWithinDeny: (filesystem.allowRead ?? []).map(removeTrailingGlobSuffix),
    },
    writeConfig: {
      allowOnly: [
        ...getDefaultWritePaths(),
        ...(filesystem.allowWrite ?? []).map(removeTrailingGlobSuffix),
      ],
      denyWithinAllow: (filesystem.denyWrite ?? []).map(removeTrailingGlobSuffix),
    },
  });
}

function decodedMacosProfile(wrapped: string): string {
  const prefix = "/usr/bin/sandbox-exec -p '";
  const prefixIndex = wrapped.indexOf(prefix);
  assert.notEqual(prefixIndex, -1);
  const start = prefixIndex + prefix.length - 1;
  let end = -1;
  for (let index = start + 1; index < wrapped.length; index += 1) {
    if (wrapped.startsWith(`'"'"'`, index)) index += 4;
    else if (wrapped[index] === "'") {
      end = index;
      break;
    }
  }
  assert.notEqual(end, -1);
  return wrapped.slice(start + 1, end).replaceAll(`'"'"'`, "'");
}

function macosSectionForms(profile: string, label: string): string[] {
  const marker = profile.indexOf(label);
  assert.notEqual(marker, -1);
  const start = marker + label.length;
  const sectionEnd = profile.indexOf("\n;", start);
  const section = profile.slice(start, sectionEnd < 0 ? undefined : sectionEnd);
  const forms: string[] = [];
  for (let index = 0; index < section.length; ) {
    while (/\s/.test(section[index] ?? "")) index += 1;
    if (index === section.length) break;
    const formStart = index;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (; index < section.length; index += 1) {
      const character = section[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0) {
        index += 1;
        forms.push(section.slice(formStart, index));
        break;
      }
    }
    assert.equal(depth, 0);
    assert.equal(quoted, false);
  }
  return forms;
}

function macosWriteForms(profile: string): string[] {
  return macosSectionForms(profile, "; File write\n");
}

function macosReadForms(profile: string): string[] {
  return macosSectionForms(profile, "; File read\n");
}

function generatedMacosReadWrapper(
  config: SandboxRuntimeConfig,
  command = "printf profile-test",
  shell = "bash",
): string {
  const filesystem = config.filesystem!;
  const credentialDenyRead =
    config.credentials?.files?.flatMap((file) =>
      file.mode === "deny" || file.mode === "mask" ? [file.path] : [],
    ) ?? [];
  return wrapCommandWithSandboxMacOS({
    command,
    binShell: shell,
    needsNetworkRestriction: false,
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: false,
    allowMachLookup: [],
    allowPty: false,
    allowBrowserProcess: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    readConfig: {
      denyOnly: [...(filesystem.denyRead ?? []), ...credentialDenyRead].map(
        removeTrailingGlobSuffix,
      ),
      allowWithinDeny: (filesystem.allowRead ?? []).map(removeTrailingGlobSuffix),
    },
    writeConfig: {
      allowOnly: [
        ...getDefaultWritePaths(),
        ...(filesystem.allowWrite ?? []).map(removeTrailingGlobSuffix),
      ],
      denyWithinAllow: (filesystem.denyWrite ?? []).map(removeTrailingGlobSuffix),
    },
  });
}

function createExecTestContext(
  t: TestContext,
  wrapCommand: (command: string) => string = (command) => `:; ${command}`,
  afterCleanup?: () => void,
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-exec-"));
  const backgroundPidPaths: string[] = [];
  let cleanupCount = 0;

  // Exercise exec without an OS sandbox session while modeling a successful
  // runtime wrapper so command cleanup remains observable.
  mock.method(SandboxManager, "wrapWithSandbox", async (command: string) => wrapCommand(command));
  mock.method(SandboxManager, "cleanupAfterCommand", () => {
    cleanupCount += 1;
    afterCleanup?.();
  });
  t.after(() => {
    try {
      for (const pidPath of backgroundPidPaths) terminateRecordedProcess(pidPath);
    } finally {
      mock.restoreAll();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  return {
    cwd,
    exec: createSandboxedBashOps().exec,
    cleanupCount: () => cleanupCount,
    trackBackgroundProcess: (pidPath: string) => backgroundPidPaths.push(pidPath),
  };
}

function terminateRecordedProcess(pidPath: string): void {
  try {
    const pid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ENOENT" && error.code !== "ESRCH")
    ) {
      throw error;
    }
  }
}

function backgroundNodeCommand(cwd: string, source: string): { command: string; pidPath: string } {
  const pidPath = join(cwd, "background.pid");
  const childSource = [
    `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
    source,
  ].join("\n");
  const command = [
    `${shellQuote(process.execPath)} -e ${shellQuote(childSource)} &`,
    `while [ ! -s ${shellQuote(pidPath)} ]; do sleep 0.01; done`,
  ].join(" ");
  return { command, pidPath };
}

test("buildRuntimeConfig passes policy-only credentials and canonicalizes file paths", () => {
  const cwd = mkdtempSync(join(process.cwd(), ".pi-sandbox-credentials-"));
  try {
    const runtime = buildRuntimeConfig(
      {
        ...DEFAULT_CONFIG,
        credentials: {
          files: [
            {
              path: "./protected/token.txt",
              mode: "deny",
            },
          ],
          envVars: [
            {
              name: "PI_SYNTHETIC_TOKEN",
              mode: "mask",
              injectHosts: ["api.example.com"],
            },
          ],
        },
      },
      undefined,
      "darwin",
      cwd,
    );

    assert.deepEqual(runtime.credentials, {
      files: [
        {
          path: canonicalizePath(join(cwd, "protected/token.txt")),
          mode: "deny",
        },
      ],
      envVars: [
        {
          name: "PI_SYNTHETIC_TOKEN",
          mode: "mask",
          injectHosts: ["api.example.com"],
        },
      ],
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildRuntimeConfig does not pass unknown credential values to the runtime", () => {
  const runtime = buildRuntimeConfig({
    ...DEFAULT_CONFIG,
    credentials: {
      envVars: [
        {
          name: "PI_SYNTHETIC_TOKEN",
          mode: "deny",
          value: "synthetic-secret-must-not-be-accepted",
        },
      ],
    } as never,
  });

  assert.equal(runtime.credentials, undefined);
});

test("buildRuntimeConfig rejects environment JWT decode before the runtime sees it", () => {
  const syntheticPlaintext = "synthetic-env-decode-value-must-not-be-logged";
  const warnings: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => warnings.push(String(args[0]));
  try {
    const runtime = buildRuntimeConfig({
      ...DEFAULT_CONFIG,
      credentials: {
        envVars: [
          {
            name: "PI_INVALID_JWT",
            mode: "mask",
            decode: "jwt",
            onExtractNoMatch: "deny",
            injectHosts: ["api.example.com"],
          },
          {
            name: "PI_MISSING_CLAIM",
            mode: "mask",
            decode: "jwt",
            maskClaims: ["access_token"],
            onExtractNoMatch: "error",
            injectHosts: ["api.example.com"],
          },
        ],
      } as never,
    });

    assert.equal(runtime.credentials, undefined);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((warning) => !warning.includes(syntheticPlaintext)));
  } finally {
    console.error = originalError;
  }
});

test("buildRuntimeConfig adds session allowances without mutating config", () => {
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, {
    domains: ["example.com"],
    readPaths: ["/read"],
    writePaths: ["/write"],
    unixSockets: [],
  });
  assert.deepEqual(runtime.network?.allowedDomains, []);
  assert.deepEqual(runtime.network?.deniedDomains, []);
  assert.equal(runtime.network?.strictAllowlist, false);
  assert.equal(runtime.filesystem?.allowRead?.includes("/read"), true);
  assert.equal(runtime.filesystem?.allowRead?.includes("/write"), true);
  assert.equal(runtime.filesystem?.allowWrite?.includes("/write"), true);
  assert.equal(DEFAULT_CONFIG.network?.allowedDomains?.includes("example.com"), false);
});

test("buildRuntimeConfig combines configured and session socket paths without mutation", () => {
  const cwd = mkdtempSync(join(process.cwd(), ".pi-sandbox-sockets-"));
  try {
    const configuredSocket = join(cwd, "configured.sock");
    const sessionSocket = join(cwd, "session", "agent.sock");
    const config = {
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network!,
        allowUnixSockets: [configuredSocket],
      },
    };
    const allowances = {
      domains: [],
      readPaths: [],
      writePaths: [],
      unixSockets: [sessionSocket],
    };
    const runtime = buildRuntimeConfig(config, allowances, "darwin", cwd);

    assert.deepEqual(runtime.network?.allowUnixSockets, [
      canonicalizePath(configuredSocket),
      canonicalizePath(sessionSocket),
    ]);
    assert.deepEqual(config.network?.allowUnixSockets, [configuredSocket]);
    assert.deepEqual(allowances.unixSockets, [sessionSocket]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("built-in PEM and key deny globs reach the runtime recursively", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-sandbox-runtime-key-deny-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, undefined, "darwin", cwd);
  const canonicalCwd = canonicalizePath(cwd);

  for (const extension of ["pem", "key"]) {
    const pattern = join(canonicalCwd, "**", `*.${extension}`);
    assert.equal(runtime.filesystem?.denyWrite?.includes(pattern), true, pattern);
    const matcher = new RegExp(globToRegex(pattern));
    assert.equal(matcher.test(join(canonicalCwd, `root.${extension}`)), true);
    assert.equal(matcher.test(join(canonicalCwd, "nested", "deep", `private.${extension}`)), true);
  }
});

test("buildRuntimeConfig canonicalizes non-glob filesystem paths", () => {
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyRead: ["/tmp"],
        allowRead: [],
        allowWrite: ["/tmp"],
        denyWrite: ["*.key"],
      },
    },
    undefined,
    process.platform,
    "/",
  );

  assert.deepEqual(runtime.filesystem?.denyRead, [canonicalizePath("/tmp")]);
  assert.equal(runtime.filesystem?.allowRead?.includes(canonicalizePath("/tmp")), true);
  assert.deepEqual(runtime.filesystem?.allowWrite, [canonicalizePath("/tmp")]);
  assert.deepEqual(runtime.filesystem?.denyWrite?.slice(0, 1), [join("/", "*.key")]);
  const protectedPaths = getProtectedSandboxConfigPaths("/");
  assert.equal(runtime.filesystem?.denyWrite?.includes(protectedPaths.projectPath), true);
  assert.equal(runtime.filesystem?.denyWrite?.includes(protectedPaths.globalPath), true);
});

test("buildRuntimeConfig resolves relative glob rules against the project cwd", (t) => {
  const cwd = mkdtempSync(join(process.cwd(), ".pi-sandbox-runtime-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        allowRead: ["packages/*"],
        denyRead: ["private/*"],
        allowWrite: ["output/*"],
        denyWrite: ["output/*.key"],
      },
    },
    undefined,
    process.platform,
    cwd,
  );

  const derived = resolveDerivedFilesystemAllowances(cwd);
  assert.deepEqual(runtime.filesystem?.allowRead, [
    join(cwd, "packages", "*"),
    ...derived.linkedGitMetadataRead,
    ...derived.linkedGitMetadataWrite,
    join(cwd, "output", "*"),
  ]);
  assert.deepEqual(runtime.filesystem?.denyRead, [join(cwd, "private", "*")]);
  assert.deepEqual(runtime.filesystem?.allowWrite, [
    join(cwd, "output", "*"),
    ...derived.linkedGitMetadataWrite,
  ]);
  assert.deepEqual(runtime.filesystem?.denyWrite?.slice(0, 1), [join(cwd, "output", "*.key")]);
  const protectedPaths = getProtectedSandboxConfigPaths(cwd);
  assert.equal(runtime.filesystem?.denyWrite?.includes(protectedPaths.projectPath), true);
  assert.equal(runtime.filesystem?.denyWrite?.includes(protectedPaths.globalPath), true);
});

test("buildRuntimeConfig emits mandatory write denies ahead of configured write grants", (t) => {
  const cwd = mkdtempSync(join(process.cwd(), ".pi-sandbox-mandatory-write-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  const protectedPaths = [
    join(cwd, ".git", "config"),
    join(cwd, ".git", "hooks"),
    join(cwd, ".gitmodules"),
    join(cwd, ".pi"),
    join(cwd, ".envrc"),
    join(cwd, ".vscode"),
    join(cwd, ".idea"),
  ];
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        allowWrite: [cwd, ...protectedPaths],
        denyWrite: [],
      },
    },
    undefined,
    process.platform,
    cwd,
  );

  for (const path of protectedPaths) {
    assert.equal(runtime.filesystem?.denyWrite?.includes(path), true, path);
  }
  assert.equal(runtime.filesystem?.allowWrite?.includes(cwd), true);
  assert.equal(runtime.filesystem?.allowWrite?.includes(join(cwd, ".pi")), true);
});

test("macOS write adapter narrows only less-specific ordinary denies", (t) => {
  const cwd = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-c2-write-quote-'")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: [cwd],
      allowWrite: [
        join(cwd, "area", "grant"),
        join(cwd, "area", "glob-grant", "*"),
        join(cwd, "glob-block", "literal-grant"),
        join(cwd, "literal-block", "glob-grant", "*"),
        join(cwd, "tie", "*"),
        join(cwd, "nested"),
        join(cwd, ".pi"),
        join(cwd, ".pi", "nested-grant"),
      ],
      denyRead: [],
      denyWrite: [
        cwd,
        join(cwd, "area", "**"),
        join(cwd, "glob-block", "**"),
        join(cwd, "literal-block"),
        join(cwd, "tie", "*"),
        join(cwd, "nested", "private"),
        join(cwd, ".pi"),
      ],
    },
  };
  const runtime = buildRuntimeConfig(config, undefined, "darwin", cwd);
  const original = generatedMacosWrapper(runtime);
  const originalForms = macosWriteForms(decodedMacosProfile(original));
  const adapted = adaptMacosWriteSpecificityProfile(original, runtime, "darwin");
  const profile = decodedMacosProfile(adapted);
  const forms = macosWriteForms(profile);
  const tag = profile.match(/^\(deny default \(with message "([^"]+)"\)\)$/m)?.[1];
  assert.ok(tag);

  const allowWrite = runtime.filesystem!.allowWrite!;
  const areaGrant = allowWrite.find((path) => path.endsWith("/area/grant"))!;
  const globGrant = allowWrite.find((path) => path.endsWith("/area/glob-grant/*"))!;
  const denyFor = (expression: string) =>
    forms.find(
      (form) =>
        form.startsWith(`(deny file-write*\n  ${expression}\n`) ||
        form.startsWith(`(deny file-write*\n  (require-all\n    ${expression}\n`),
    );
  const narrowableRootDeny = denyFor(`(subpath ${JSON.stringify(canonicalizePath(cwd))})`);
  assert.ok(narrowableRootDeny?.includes("(require-all"));
  assert.ok(narrowableRootDeny?.includes(`(require-not (subpath ${JSON.stringify(areaGrant)}))`));

  const areaDeny = denyFor(`(subpath ${JSON.stringify(join(cwd, "area"))})`);
  assert.ok(areaDeny?.includes(`(require-not (regex ${JSON.stringify(globToRegex(globGrant))}))`));
  const globDeny = denyFor(`(subpath ${JSON.stringify(join(cwd, "glob-block"))})`);
  assert.ok(
    globDeny?.includes(
      `(require-not (subpath ${JSON.stringify(join(cwd, "glob-block", "literal-grant"))}))`,
    ),
  );
  const literalDeny = denyFor(`(subpath ${JSON.stringify(join(cwd, "literal-block"))})`);
  const literalGlobGrant = allowWrite.find((path) => path.endsWith("/literal-block/glob-grant/*"))!;
  assert.ok(
    literalDeny?.includes(`(require-not (regex ${JSON.stringify(globToRegex(literalGlobGrant))}))`),
  );

  const tieGrant = allowWrite.find((path) => path.endsWith("/tie/*"))!;
  const tieExpression = `(regex ${JSON.stringify(globToRegex(tieGrant))})`;
  const tiedDeny = denyFor(tieExpression);
  assert.ok(tiedDeny);
  assert.ok(tiedDeny.includes(tieExpression));
  assert.equal(tiedDeny.includes(`(require-not ${tieExpression})`), false);
  const nestedDenyExpression = `(subpath ${JSON.stringify(join(cwd, "nested", "private"))})`;
  const nestedDeny = denyFor(nestedDenyExpression);
  assert.ok(nestedDeny);
  assert.ok(nestedDeny.includes(nestedDenyExpression));
  const nestedGrant = allowWrite.find((path) => path.endsWith("/nested"))!;
  const nestedGrantExpression = `(subpath ${JSON.stringify(nestedGrant)})`;
  assert.equal(nestedDeny.includes(`(require-not ${nestedGrantExpression})`), false);

  const mandatoryPiDeny = denyFor(`(subpath ${JSON.stringify(join(cwd, ".pi"))})`);
  assert.ok(mandatoryPiDeny);
  assert.doesNotMatch(mandatoryPiDeny, /require-not/);
  const originalLiteralSafeguards = originalForms.filter(
    (form) =>
      form.startsWith("(deny file-write-create\n  (literal ") ||
      form.startsWith("(deny file-write-unlink\n  (literal "),
  );
  assert.ok(originalLiteralSafeguards.length > 0);
  for (const operation of ["file-write-create", "file-write-unlink"]) {
    assert.ok(
      originalLiteralSafeguards.some((form) => form.startsWith(`(deny ${operation}\n  (literal `)),
      `expected generated literal ${operation} safeguards`,
    );
  }
  for (const safeguard of originalLiteralSafeguards) {
    assert.ok(forms.includes(safeguard), `adapted profile must preserve ${safeguard}`);
  }
  const builtInDeny = denyFor(`(subpath ${JSON.stringify(join(process.cwd(), ".bashrc"))})`);
  assert.ok(builtInDeny);
  assert.doesNotMatch(builtInDeny, /require-not/);
  assert.ok(profile.includes(cwd), "the decoded profile preserves apostrophes in configured paths");
  assert.equal(adaptMacosWriteSpecificityProfile(adapted, runtime, "darwin"), adapted);
});

test("macOS specificity provenance survives module reload", async (t) => {
  const cwd = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-specificity-reload-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        allowRead: [join(cwd, "read", "grant")],
        denyRead: [join(cwd, "read")],
        allowWrite: [join(cwd, "write", "grant")],
        denyWrite: [join(cwd, "write")],
      },
    },
    undefined,
    "darwin",
    cwd,
  );
  const readWrapped = generatedMacosReadWrapper(runtime);
  const writeWrapped = generatedMacosWrapper(runtime);
  const reloadedUrl = new URL("../src/macos-write-specificity.ts", import.meta.url);
  reloadedUrl.searchParams.set("reload", String(Date.now()));
  const reloaded = await import(reloadedUrl.href);
  assert.notEqual(reloaded.adaptMacosReadSpecificityProfile, adaptMacosReadSpecificityProfile);
  assert.notEqual(reloaded.adaptMacosWriteSpecificityProfile, adaptMacosWriteSpecificityProfile);

  const readAdapted = reloaded.adaptMacosReadSpecificityProfile(readWrapped, runtime, "darwin");
  const writeAdapted = reloaded.adaptMacosWriteSpecificityProfile(writeWrapped, runtime, "darwin");
  assert.notEqual(readAdapted, readWrapped);
  assert.notEqual(writeAdapted, writeWrapped);

  const clonedRuntime = { ...runtime };
  assert.throws(
    () => reloaded.adaptMacosReadSpecificityProfile(readWrapped, clonedRuntime, "darwin"),
    /provenance/i,
  );
  assert.equal(
    reloaded.adaptMacosWriteSpecificityProfile(writeWrapped, clonedRuntime, "darwin"),
    writeWrapped,
  );

  const originalAllowRead = runtime.filesystem!.allowRead![0]!;
  runtime.filesystem!.allowRead![0] = join(cwd, "read", "mutated");
  assert.throws(
    () => reloaded.adaptMacosReadSpecificityProfile(readWrapped, runtime, "darwin"),
    /changed/i,
  );
  runtime.filesystem!.allowRead![0] = originalAllowRead;

  const originalAllowWrite = runtime.filesystem!.allowWrite![0]!;
  runtime.filesystem!.allowWrite![0] = join(cwd, "write", "mutated");
  assert.equal(
    reloaded.adaptMacosWriteSpecificityProfile(writeWrapped, runtime, "darwin"),
    writeWrapped,
  );
  runtime.filesystem!.allowWrite![0] = originalAllowWrite;
});

test("macOS read adapter guards ordinary denies only against more-specific grants", (t) => {
  const cwd = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-c1-read-matrix-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const paths = {
    nestedGlobDeny: join(cwd, "area", "private", "**", "secret.txt"),
    literalDeny: join(cwd, "literal-zone"),
    globGrant: join(cwd, "literal-zone", "public", "**", "safe.txt"),
    globDeny: join(cwd, "glob-zone", "private", "**", "secret.txt"),
    literalGrant: join(cwd, "glob-zone", "private", "deep", "safe.txt"),
    tie: join(cwd, "tie", "**", "same.txt"),
    siblingDeny: join(cwd, "siblings", "private", "**", "secret.txt"),
    siblingGrant: join(cwd, "siblings", "public", "specific", "**", "safe.txt"),
    narrowerDeny: join(cwd, "deep", "private", "secret.txt"),
    broaderGrant: join(cwd, "deep"),
  };
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyRead: [
          paths.nestedGlobDeny,
          paths.literalDeny,
          paths.globDeny,
          paths.tie,
          paths.siblingDeny,
          paths.narrowerDeny,
        ],
        allowRead: [
          join(cwd, "area"),
          paths.globGrant,
          paths.literalGrant,
          paths.tie,
          paths.siblingGrant,
          paths.broaderGrant,
        ],
        allowWrite: [],
        denyWrite: [],
      },
    },
    undefined,
    "darwin",
    cwd,
  );
  const expression = (pattern: string) => {
    const normalized = removeTrailingGlobSuffix(pattern);
    return containsGlobChars(normalized)
      ? `(regex ${JSON.stringify(globToRegex(normalized))})`
      : `(subpath ${JSON.stringify(normalized)})`;
  };
  const original = generatedMacosReadWrapper(runtime);
  const originalProfile = decodedMacosProfile(original);
  const originalReadForms = macosReadForms(originalProfile);
  const originalWriteForms = macosWriteForms(originalProfile);
  const nestedDenyIndex = originalProfile.indexOf(expression(paths.nestedGlobDeny));
  const literalAllowIndex = originalProfile.indexOf(expression(join(cwd, "area")));
  assert.ok(nestedDenyIndex >= 0 && nestedDenyIndex < literalAllowIndex);
  const adapted = adaptMacosReadSpecificityProfile(original, runtime, "darwin");
  const profile = decodedMacosProfile(adapted);
  const marker = "; pi-sandbox read specificity\n";
  const finalRules = profile.slice(profile.lastIndexOf(marker) + marker.length);
  const finalRuleForms = macosSectionForms(profile, marker);
  const finalRuleFor = (operation: string, pattern: string) =>
    finalRuleForms.find(
      (form) =>
        form.startsWith(`(deny ${operation}\n  (require-all\n    ${expression(pattern)}\n`) ||
        form.startsWith(`(deny ${operation}\n  ${expression(pattern)}\n`),
    );

  assert.notEqual(adapted, original);
  assert.ok(finalRules.includes(`(require-not ${expression(paths.globGrant)})`));
  assert.ok(finalRules.includes(`(require-not ${expression(paths.literalGrant)})`));
  assert.ok(finalRules.includes(`(require-not ${expression(paths.siblingGrant)})`));
  const narrowerDenyRule = finalRuleFor("file-read*", paths.narrowerDeny);
  assert.ok(narrowerDenyRule);
  assert.ok(narrowerDenyRule.includes("(require-not (vnode-type DIRECTORY))"));
  assert.equal(narrowerDenyRule.includes(`(require-not ${expression(paths.broaderGrant)})`), false);
  const tieDataDeny = finalRuleFor("file-read-data", paths.tie);
  assert.ok(tieDataDeny);
  assert.equal(tieDataDeny.includes(`(require-not ${expression(paths.tie)})`), false);
  const tieDeny = finalRuleForms.find((form) =>
    form.startsWith(`(deny file-read*\n  (require-all\n    ${expression(paths.tie)}\n`),
  );
  assert.ok(tieDeny);
  assert.equal(
    tieDeny.includes(`(require-not ${expression(paths.tie)})`),
    false,
    "an equal-specificity grant must not override its deny",
  );
  assert.deepEqual(
    macosReadForms(profile).filter((form) => !form.startsWith("(deny file-read")),
    originalReadForms.filter((form) => !form.startsWith("(deny file-read")),
  );
  assert.deepEqual(macosWriteForms(profile), originalWriteForms);
  assert.equal(
    profile.match(/\(allow file-read-metadata\s+\(vnode-type DIRECTORY\)\)/g)?.length,
    1,
    "directory traversal metadata must remain unchanged",
  );
  assert.equal(adaptMacosReadSpecificityProfile(adapted, runtime, "darwin"), adapted);

  const rootGrant = join(cwd, "root-deny", "narrow-grant");
  const rootRuntime = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyRead: ["/"],
        allowRead: [rootGrant],
        allowWrite: [],
        denyWrite: [],
      },
    },
    undefined,
    "darwin",
    cwd,
  );
  const rootAdapted = adaptMacosReadSpecificityProfile(
    generatedMacosReadWrapper(rootRuntime),
    rootRuntime,
    "darwin",
  );
  const rootProfile = decodedMacosProfile(rootAdapted);
  const rootFinalRules = macosSectionForms(rootProfile, marker);
  const rootDeny = rootFinalRules.find((form) => form.startsWith("(deny file-read-data\n"));
  assert.ok(rootDeny);
  assert.ok(rootDeny.includes(`(require-not ${expression(rootGrant)})`));
  assert.ok(rootDeny.includes('(require-not (literal "/"))'));
  assert.ok(rootProfile.includes('(allow file-read* (literal "/"))'));
});

test("macOS read adapter leaves credential denies hard and preserves generated rules", (t) => {
  const cwd = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-c1-credential-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const credentialPath = join(cwd, "area", "credential.json");
  const maskedCredentialPath = join(cwd, "area", "masked-credential.json");
  mkdirSync(dirname(maskedCredentialPath), { recursive: true });
  writeFileSync(maskedCredentialPath, "credential fixture");
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      credentials: {
        files: [
          { path: credentialPath, mode: "deny" },
          { path: maskedCredentialPath, mode: "mask", injectHosts: ["example.invalid"] },
        ],
      },
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyRead: [join(cwd, "area", "**", "private.txt")],
        allowRead: [join(cwd, "area")],
        allowWrite: [join(cwd, "write")],
        denyWrite: [join(cwd, "write", "blocked")],
      },
    },
    undefined,
    "darwin",
    cwd,
  );
  const original = generatedMacosReadWrapper(runtime);
  const originalProfile = decodedMacosProfile(original);
  const adapted = adaptMacosReadSpecificityProfile(original, runtime, "darwin");
  const profile = decodedMacosProfile(adapted);
  const marker = "; pi-sandbox read specificity\n";
  const finalRules = profile.slice(profile.lastIndexOf(marker) + marker.length);
  const credentialMatcher = `(subpath ${JSON.stringify(credentialPath)})`;
  const maskedCredentialMatcher = `(subpath ${JSON.stringify(maskedCredentialPath)})`;
  const credentialDeny = `(deny file-read*\n  ${credentialMatcher}\n`;
  const maskedCredentialDeny = `(deny file-read*\n  ${maskedCredentialMatcher}\n`;

  assert.ok(finalRules.includes(credentialDeny));
  assert.ok(finalRules.includes(maskedCredentialDeny));
  assert.equal(finalRules.includes(`(require-not ${credentialMatcher})`), false);
  assert.equal(finalRules.includes(`(require-not ${maskedCredentialMatcher})`), false);
  const originalReadForms = macosReadForms(originalProfile);
  const adaptedReadForms = macosReadForms(profile);
  const originalCredentialDeny = originalReadForms.find(
    (form) => form.startsWith("(deny file-read*") && form.includes(credentialMatcher),
  );
  assert.ok(originalCredentialDeny);
  assert.ok(adaptedReadForms.includes(originalCredentialDeny));
  assert.deepEqual(
    adaptedReadForms.filter((form) => !form.startsWith("(deny file-read")),
    originalReadForms.filter((form) => !form.startsWith("(deny file-read")),
  );
  assert.deepEqual(macosWriteForms(profile), macosWriteForms(originalProfile));
  assert.equal(
    profile.match(/\(allow file-read-metadata\s+\(vnode-type DIRECTORY\)\)/g)?.length,
    1,
  );
});

test("macOS read adapter blocks when the correction cannot be verified", (t) => {
  const cwd = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-c1-read-guard-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        denyRead: [join(cwd, "**", "private.txt")],
        allowRead: [cwd],
        allowWrite: [],
        denyWrite: [],
      },
    },
    undefined,
    "darwin",
    cwd,
  );
  const wrapped = generatedMacosReadWrapper(runtime);
  assert.throws(
    () => adaptMacosReadSpecificityProfile(wrapped, { ...runtime }, "darwin"),
    /provenance/i,
  );
  const originalAllowRead = runtime.filesystem!.allowRead![0]!;
  runtime.filesystem!.allowRead![0] = join(cwd, "mutated");
  assert.throws(() => adaptMacosReadSpecificityProfile(wrapped, runtime, "darwin"), /changed/i);
  runtime.filesystem!.allowRead![0] = originalAllowRead;
  const malformed = wrapped.replace("/usr/bin/sandbox-exec -p '", "/usr/bin/sandbox-exec -p ");
  assert.throws(() => adaptMacosReadSpecificityProfile(malformed, runtime, "darwin"), /profile/i);
  const unexpected = wrapped.replace(
    "; File read\n",
    '; File read\n(deny file-read* (literal "/unexpected-shape"))\n',
  );
  assert.throws(() => adaptMacosReadSpecificityProfile(unexpected, runtime, "darwin"), /profile/i);
  assert.equal(adaptMacosReadSpecificityProfile(wrapped, runtime, "linux"), wrapped);
  assert.throws(
    () => adaptMacosReadSpecificityProfile(wrapped, undefined, "darwin"),
    /provenance/i,
  );
});

test("macOS write adapter fails closed for unsupported platforms, provenance, and profile shapes", (t) => {
  const cwd = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-c2-write-guard-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runtime = buildRuntimeConfig(
    {
      ...DEFAULT_CONFIG,
      filesystem: {
        ...DEFAULT_CONFIG.filesystem!,
        allowRead: [cwd],
        allowWrite: [join(cwd, "grant")],
        denyRead: [],
        denyWrite: [cwd],
      },
    },
    undefined,
    "darwin",
    cwd,
  );
  const wrapped = generatedMacosWrapper(runtime);
  assert.equal(adaptMacosWriteSpecificityProfile(wrapped, runtime, "linux"), wrapped);
  assert.equal(adaptMacosWriteSpecificityProfile(wrapped, { ...runtime }, "darwin"), wrapped);
  const originalAllowWrite = runtime.filesystem!.allowWrite![0]!;
  runtime.filesystem!.allowWrite![0] = join(cwd, "mutated-grant");
  assert.equal(adaptMacosWriteSpecificityProfile(wrapped, runtime, "darwin"), wrapped);
  runtime.filesystem!.allowWrite![0] = originalAllowWrite;
  const malformedProfileQuote = wrapped.replace(
    "/usr/bin/sandbox-exec -p '",
    "/usr/bin/sandbox-exec -p ",
  );
  assert.notEqual(malformedProfileQuote, wrapped);
  assert.equal(
    adaptMacosWriteSpecificityProfile(malformedProfileQuote, runtime, "darwin"),
    malformedProfileQuote,
  );

  const unexpected = wrapped.replace(
    "; File write\n",
    '; File write\n(deny file-write* (literal "/unexpected-shape"))\n',
  );
  assert.notEqual(unexpected, wrapped);
  assert.equal(adaptMacosWriteSpecificityProfile(unexpected, runtime, "darwin"), unexpected);
  const adapted = adaptMacosWriteSpecificityProfile(wrapped, runtime, "darwin");
  assert.notEqual(adapted, wrapped);
  assert.equal(adaptMacosWriteSpecificityProfile(adapted, runtime, "darwin"), adapted);
});

test(
  "createSandboxedBashOps adapts the generated profile using its real command and shell",
  {
    skip: process.platform !== "darwin",
  },
  async (t) => {
    const cwd = canonicalizePath(
      mkdtempSync(join(tmpdir(), "pi-sandbox-production-write-adapter-")),
    );
    const shellPath = join(cwd, "capture-shell");
    const capturePath = join(cwd, "wrapped-command");
    t.after(() => {
      mock.restoreAll();
      rmSync(cwd, { recursive: true, force: true });
    });
    writeFileSync(shellPath, '#!/bin/sh\nprintf \'%s\' "$2" > "$PI_SANDBOX_WRAPPED_CAPTURE"\n', {
      mode: 0o755,
    });

    const runtime = buildRuntimeConfig(
      {
        ...DEFAULT_CONFIG,
        filesystem: {
          ...DEFAULT_CONFIG.filesystem!,
          allowRead: [cwd, join(cwd, "secret", "public")],
          allowWrite: [join(cwd, "grant")],
          denyRead: [join(cwd, "secret")],
          denyWrite: [cwd],
        },
      },
      undefined,
      "darwin",
      cwd,
    );
    let observedCommand = "";
    let observedShell = "";
    mock.method(SandboxManager, "getConfig", () => runtime);
    mock.method(SandboxManager, "wrapWithSandbox", async (command: string, shell: string) => {
      observedCommand = command;
      observedShell = shell;
      return generatedMacosWrapper(runtime, command, shell);
    });
    mock.method(SandboxManager, "cleanupAfterCommand", () => {});

    const command = "printf production-adapter-test";
    const commandToWrap = `unset GIT_SSH_COMMAND; ${command}`;
    const result = await createSandboxedBashOps(shellPath).exec(command, cwd, {
      onData: () => {},
      env: { ...process.env, PI_SANDBOX_WRAPPED_CAPTURE: capturePath },
    });

    assert.deepEqual(result, { exitCode: 0 });
    assert.equal(observedCommand, commandToWrap);
    assert.equal(observedShell, shellPath);
    const generated = generatedMacosWrapper(runtime, commandToWrap, shellPath);
    const spawnedCommand = readFileSync(capturePath, "utf8");
    assert.notEqual(
      spawnedCommand,
      generated,
      "the production wrapper must use the adapted profile",
    );
    const profile = decodedMacosProfile(spawnedCommand);
    const rootDeny = macosWriteForms(profile).find(
      (form) =>
        form.startsWith("(deny file-write*") &&
        form.includes(`(subpath ${JSON.stringify(canonicalizePath(cwd))})`),
    );
    assert.ok(rootDeny);
    assert.ok(
      rootDeny.includes(
        `(require-not (subpath ${JSON.stringify(canonicalizePath(join(cwd, "grant")))}))`,
      ),
    );
    const readRules = macosSectionForms(profile, "; pi-sandbox read specificity\n");
    assert.ok(readRules.some((form) => form.startsWith("(deny file-read-data\n")));
    assert.ok(
      readRules.some(
        (form) =>
          form.startsWith("(deny file-read*\n") &&
          form.includes("(require-not (vnode-type DIRECTORY))"),
      ),
    );
  },
);

test(
  "createSandboxedBashOps blocks required read-policy correction when the generated profile is unknown",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const cwd = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-c1-production-guard-")));
    const shellPath = join(cwd, "capture-shell");
    const executionMarker = join(cwd, "spawned");
    t.after(() => {
      mock.restoreAll();
      rmSync(cwd, { recursive: true, force: true });
    });
    writeFileSync(shellPath, `#!/bin/sh\nprintf invoked > ${shellQuote(executionMarker)}\n`, {
      mode: 0o755,
    });

    const runtime = buildRuntimeConfig(
      {
        ...DEFAULT_CONFIG,
        filesystem: {
          ...DEFAULT_CONFIG.filesystem!,
          denyRead: [join(cwd, "private")],
          allowRead: [cwd],
          allowWrite: [],
          denyWrite: [],
        },
      },
      undefined,
      "darwin",
      cwd,
    );
    mock.method(SandboxManager, "getConfig", () => runtime);
    mock.method(SandboxManager, "wrapWithSandbox", async (command: string, shell: string) =>
      generatedMacosReadWrapper(runtime, command, shell).replace(
        "; File read\n",
        '; File read\n(allow file-read* (literal "/unknown-profile-shape"))\n',
      ),
    );
    const cleanup = mock.method(SandboxManager, "cleanupAfterCommand", () => {});

    await assert.rejects(
      createSandboxedBashOps(shellPath).exec("printf must-not-run", cwd, {
        onData: () => {},
        env: { ...process.env },
      }),
      /cannot verify the macOS read profile/i,
    );
    assert.throws(() => readFileSync(executionMarker), { code: "ENOENT" });
    assert.equal(
      cleanup.mock.callCount(),
      1,
      "wrapper resources are cleaned after fail-closed rejection",
    );
  },
);

test("runtime network callback applies shared specificity without deny-first short-circuiting", async () => {
  const callback = createNetworkAskCallback(["*", "api.example.com"], ["*.example.com"]);

  assert.equal(await callback({ host: "api.example.com", port: 443 }), true);
  assert.equal(await callback({ host: "other.example.com", port: 443 }), false);
  assert.equal(await callback({ host: "unrelated.test", port: 443 }), true);
});

test("buildRuntimeConfig exposes the bundled seccomp helper on Linux", () => {
  const runtime = buildRuntimeConfig(DEFAULT_CONFIG, undefined, "linux", "/");
  const runtimeEntryUrl = import.meta.resolve("@carderne/sandbox-runtime");
  const seccompPath = canonicalizePath(
    fileURLToPath(new URL("../vendor/seccomp", runtimeEntryUrl)),
  );

  assert.equal(runtime.filesystem?.allowRead?.includes(seccompPath), true);
});

test("write allowances also grant effective read access to the same paths", () => {
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem!,
      allowRead: [],
      allowWrite: ["/configured-write"],
    },
  };
  const effective = resolveAllowances(
    config,
    {
      domains: [],
      readPaths: [],
      writePaths: ["/session-write"],
      unixSockets: [],
    },
    "/",
  );

  // Configured and session write grants share this effective-read contract.
  assert.deepEqual(effective.readPaths, ["/configured-write", "/session-write"]);
  assert.deepEqual(effective.writePaths, ["/configured-write", "/session-write"]);
});

test("buildRuntimeConfig preserves allowPty at the runtime seam", () => {
  for (const allowPty of [true, false, undefined]) {
    const config = { ...DEFAULT_CONFIG, allowPty };
    assert.equal(buildRuntimeConfig(config).allowPty, allowPty);
  }
});

test("initializeSandbox passes allowPty unchanged to SandboxManager", async (t) => {
  const observed: Array<boolean | undefined> = [];
  mock.method(SandboxManager, "initialize", async (runtime: SandboxRuntimeConfig) => {
    observed.push(runtime.allowPty);
  });
  t.after(() => mock.restoreAll());

  for (const allowPty of [true, false, undefined]) {
    await initializeSandbox({ ...DEFAULT_CONFIG, allowPty });
  }

  assert.deepEqual(observed, [true, false, undefined]);
});

test("extractBlockedWritePath recognizes shell sandbox errors", () => {
  assert.equal(
    extractBlockedWritePath("bash: line 1: /private/file: Operation not permitted"),
    "/private/file",
  );
  assert.equal(extractBlockedWritePath("permission denied"), null);
});

test("extractBlockedWritePath handles Bash preflight output variants", () => {
  assert.equal(
    extractBlockedWritePath("/bin/bash: line 2: /tmp/project/file.txt: Operation not permitted"),
    "/tmp/project/file.txt",
  );
  assert.equal(
    extractBlockedWritePath("sh: /private/secret: Operation not permitted"),
    "/private/secret",
  );
  assert.equal(extractBlockedWritePath("bash: line 1: /tmp/file.txt: Permission denied"), null);
});

test("R-02 runtime redirection fixtures preserve direct and nested Bash output", async (t) => {
  const { cwd, exec } = createExecTestContext(t);
  const directTarget = join(cwd, "direct-write-target");
  const nestedTarget = join(cwd, "nested-write-target");
  const commands = [
    {
      command: `printf 'bash: line 1: ${directTarget}: Operation not permitted\\n' >&2; exit 1`,
      target: directTarget,
    },
    {
      command: `bash -c ${shellQuote(`printf 'bash: line 1: ${nestedTarget}: Operation not permitted\\n' >&2; exit 1`)}`,
      target: nestedTarget,
    },
  ];

  for (const { command, target } of commands) {
    let output = "";
    const result = await exec(command, cwd, {
      onData: (data: Buffer) => {
        output += data.toString();
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(extractBlockedWritePath(output), target);
  }
});

test("supportsNodeEnvProxy observes Node release boundaries", () => {
  assert.equal(supportsNodeEnvProxy("22.20.0"), false);
  assert.equal(supportsNodeEnvProxy("22.21.0"), true);
  assert.equal(supportsNodeEnvProxy("23.9.0"), false);
  assert.equal(supportsNodeEnvProxy("24.0.0"), true);
});

test("exec resolves when the command exits even if a daemonized grandchild holds the stdio pipes", async (t) => {
  const { cwd, exec, cleanupCount, trackBackgroundProcess } = createExecTestContext(t);
  const { command, pidPath } = backgroundNodeCommand(cwd, "setInterval(() => {}, 1000);");
  trackBackgroundProcess(pidPath);

  // The background process inherits stdout/stderr indefinitely. Exec should
  // return after its post-exit idle grace, not wait for natural pipe EOF.
  const started = Date.now();
  const { exitCode } = await exec(command, cwd, { onData: () => {} });
  const elapsed = Date.now() - started;

  assert.equal(exitCode, 0);
  assert.equal(cleanupCount(), 1);
  assert.ok(elapsed < 2000, `exec returned after ${elapsed}ms; expected early teardown`);
});

test("exec drains output that stays active after the direct child exits", async (t) => {
  const { cwd, exec, cleanupCount, trackBackgroundProcess } = createExecTestContext(t);
  const writerSource = `
let tick = 0;
const writer = setInterval(() => {
  tick += 1;
  process.stdout.write(\`stdout-\${tick}\\n\`);
  process.stderr.write(\`stderr-\${tick}\\n\`);
  if (tick === 6) clearInterval(writer);
}, 50);
setInterval(() => {}, 1000);
`;
  const { command, pidPath } = backgroundNodeCommand(cwd, writerSource);
  trackBackgroundProcess(pidPath);

  const chunks: Buffer[] = [];
  const started = Date.now();
  const { exitCode } = await exec(command, cwd, { onData: (data) => chunks.push(data) });
  const elapsed = Date.now() - started;
  const output = Buffer.concat(chunks).toString("utf8");

  assert.equal(exitCode, 0);
  assert.equal(cleanupCount(), 1);
  for (let tick = 1; tick <= 6; tick += 1) {
    assert.ok(output.includes(`stdout-${tick}\n`), `missing stdout token ${tick}`);
    assert.ok(output.includes(`stderr-${tick}\n`), `missing stderr token ${tick}`);
  }
  assert.ok(elapsed < 2000, `exec returned after ${elapsed}ms; expected idle teardown`);
});

test("Git SSH transport enforces host keys and OpenSSH uses the isolated HOME trust path", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-sandbox-isolated-home-"));
  try {
    const knownHostsPath = join(home, ".ssh", "known_hosts");
    const command = buildGitSshCommand(45678, home);
    assert.match(command, /StrictHostKeyChecking=yes/);
    assert.match(command, /UpdateHostKeys=no/);
    assert.ok(command.includes(`UserKnownHostsFile=${knownHostsPath}`));
    assert.match(command, /IdentityFile=none/);
    assert.match(command, /IdentityAgent=SSH_AUTH_SOCK/);
    assert.match(command, /ProxyCommand=\/usr\/bin\/nc -X 5 -x localhost:45678 %h %p/);
    assert.doesNotMatch(command, /StrictHostKeyChecking=(?:no|accept-new)/);

    // Exercise the generated command through OpenSSH's config parser. This
    // catches its `~` behavior, which resolves against the account home.
    const sshConfig = execFileSync("/bin/sh", ["-c", `${command} -G localhost`], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.ok(sshConfig.split("\n").includes(`userknownhostsfile ${knownHostsPath}`));

    const unavailableProxy = buildGitSshCommand(undefined, home);
    assert.match(unavailableProxy, /ProxyCommand=\/usr\/bin\/false/);
    assert.doesNotMatch(unavailableProxy, /ProxyCommand=\/usr\/bin\/nc/);
    assert.equal(buildGitSshCommand(45678), "'/usr/bin/false'");
    assert.equal(buildGitSshCommand(45678, `${home} unsafe`), "'/usr/bin/false'");
    assert.equal(buildGitSshCommand(45678, `${home}'unsafe`), "'/usr/bin/false'");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("Git SSH derives trust path from execution HOME and fails closed without one", async (t) => {
  let wrappedCommand = "";
  const { cwd, exec } = createExecTestContext(t, (command) => {
    wrappedCommand = command;
    return ":";
  });
  const home = mkdtempSync(join(tmpdir(), "pi-sandbox-exec-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (process.platform === "darwin") {
    mock.method(SandboxManager, "getSocksProxyPort", () => 45678);
  }

  await exec("git push git@example.com:org/repo", cwd, {
    onData: () => {},
    env: { ...process.env, HOME: home },
  });
  assert.ok(wrappedCommand.includes(join(home, ".ssh", "known_hosts")));

  const envWithoutHome = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== "HOME"),
  );
  await exec("git push git@example.com:org/repo", cwd, {
    onData: () => {},
    env: envWithoutHome,
  });
  assert.equal(
    wrappedCommand,
    "export GIT_SSH_COMMAND=/usr/bin/false; git push git@example.com:org/repo",
  );
});

test("ordinary SSH is not wrapped while recognized Git SSH receives a scoped transport", async (t) => {
  let wrappedCommand = "";
  const { cwd, exec } = createExecTestContext(t, (command) => {
    wrappedCommand = command;
    return ":";
  });

  await exec("ssh host", cwd, { onData: () => {} });
  assert.equal(wrappedCommand, "unset GIT_SSH_COMMAND; ssh host");
  assert.doesNotMatch(wrappedCommand, /ssh\(\)|ProxyCommand/);

  if (process.platform === "darwin") {
    mock.method(SandboxManager, "getSocksProxyPort", () => 45678);
  }
  await exec("git push git@example.com:org/repo", cwd, { onData: () => {} });
  assert.match(wrappedCommand, /^export GIT_SSH_COMMAND=/);
  assert.match(wrappedCommand, /StrictHostKeyChecking=yes/);
  if (process.platform === "darwin") {
    assert.match(wrappedCommand, /ProxyCommand=\\?\/usr\/bin\/nc -X 5 -x localhost:45678/);
  } else if (process.platform === "linux") {
    assert.match(wrappedCommand, /GIT_SSH_COMMAND:-\/usr\/bin\/false/);
  } else {
    assert.equal(
      wrappedCommand,
      "export GIT_SSH_COMMAND=/usr/bin/false; git push git@example.com:org/repo",
    );
  }
});

test("exec returns a nonzero exit code", async (t) => {
  const { cwd, exec, cleanupCount } = createExecTestContext(t);

  assert.deepEqual(await exec("exit 7", cwd, { onData: () => {} }), { exitCode: 7 });
  assert.equal(cleanupCount(), 1);
});

test("exec rejects after its command timeout", async (t) => {
  const { cwd, exec, cleanupCount } = createExecTestContext(t);

  await assert.rejects(
    exec("sleep 5", cwd, { onData: () => {}, timeout: 0.05 }),
    new Error("timeout:0.05"),
  );
  assert.equal(cleanupCount(), 1);
});

test("exec rejects when an in-flight command is aborted", async (t) => {
  const { cwd, exec, cleanupCount } = createExecTestContext(t);
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 50);
  t.after(() => clearTimeout(abortTimer));

  await assert.rejects(
    exec("sleep 5", cwd, { onData: () => {}, signal: controller.signal }),
    new Error("aborted"),
  );
  assert.equal(cleanupCount(), 1);
});

test("exec preserves wrapping failures without cleaning another command", async (t) => {
  const wrappingError = new Error("wrap failed");
  const { cwd, exec, cleanupCount } = createExecTestContext(t, () => {
    throw wrappingError;
  });

  await assert.rejects(exec("true", cwd, { onData: () => {} }), wrappingError);
  assert.equal(cleanupCount(), 0);
});

test("exec cleans up when process creation fails after wrapping", async (t) => {
  const { cwd, exec, cleanupCount } = createExecTestContext(t);
  const invalidEnv = {
    ...process.env,
    PI_SANDBOX_INVALID_ENV: Symbol("invalid"),
  } as unknown as NodeJS.ProcessEnv;

  await assert.rejects(
    exec("true", cwd, { onData: () => {}, env: invalidEnv }),
    /Cannot convert a Symbol value to a string/,
  );
  assert.equal(cleanupCount(), 1);
});

test("exec reports cleanup failures after a successful command", async (t) => {
  const cleanupError = new Error("cleanup failed");
  const { cwd, exec, cleanupCount } = createExecTestContext(t, undefined, () => {
    throw cleanupError;
  });

  await assert.rejects(exec("true", cwd, { onData: () => {} }), (error) => {
    assert.equal(error, cleanupError);
    return true;
  });
  assert.equal(cleanupCount(), 1);
});

test("exec preserves an execution failure when cleanup also fails", async (t) => {
  const cleanupError = new Error("cleanup failed");
  const { cwd, exec, cleanupCount } = createExecTestContext(t, undefined, () => {
    throw cleanupError;
  });

  await assert.rejects(exec("sleep 5", cwd, { onData: () => {}, timeout: 0.05 }), (error) => {
    assert.notEqual(error, cleanupError);
    assert.equal(error instanceof Error, true);
    assert.equal((error as Error).message, "timeout:0.05");
    return true;
  });
  assert.equal(cleanupCount(), 1);
});

test(
  "exec cleans up after an asynchronous child-process error",
  { skip: process.platform === "win32" },
  async (t) => {
    const { cwd, cleanupCount } = createExecTestContext(t);
    const fixtureDir = mkdtempSync(join(process.cwd(), ".pi-sandbox-async-spawn-"));
    t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));
    const shellPath = join(fixtureDir, "non-executable-shell");
    writeFileSync(shellPath, "#!/bin/sh\n", { mode: 0o600 });
    const exec = createSandboxedBashOps(shellPath).exec;

    await assert.rejects(exec("true", cwd, { onData: () => {} }), (error) => {
      assert.equal((error as NodeJS.ErrnoException).code, "EACCES");
      return true;
    });
    assert.equal(cleanupCount(), 1);
  },
);

test("exec does not clean up when the runtime returns an unchanged command", async (t) => {
  const { cwd, exec, cleanupCount } = createExecTestContext(t, (command) => command);

  assert.deepEqual(await exec("true", cwd, { onData: () => {} }), { exitCode: 0 });
  assert.equal(cleanupCount(), 0);
});
