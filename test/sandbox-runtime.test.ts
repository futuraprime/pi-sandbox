import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { SandboxManager, type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
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
