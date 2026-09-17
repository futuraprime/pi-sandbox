import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import test from "node:test";

import { wrapCommandWithSandboxMacOS } from "@carderne/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config.ts";
import { augmentMacosBrowserProfile, buildRuntimeConfig } from "../src/sandbox-runtime.ts";

function generatedProfile(allowBrowserProcess: boolean): string {
  const wrapped = wrapCommandWithSandboxMacOS({
    command: "printf browser-test",
    needsNetworkRestriction: true,
    allowBrowserProcess,
    readConfig: undefined,
    writeConfig: { allowOnly: [], denyWithinAllow: [] },
  });
  const augmented = augmentMacosBrowserProfile(wrapped, allowBrowserProcess);
  const profileStart = augmented.indexOf(" -p '");
  assert.notEqual(profileStart, -1, "runtime should generate a sandbox profile");
  const contentStart = profileStart + " -p '".length;
  const contentEnd = augmented.indexOf("' /bin/bash -c '", contentStart);
  assert.notEqual(contentEnd, -1, "runtime should quote its sandbox profile");
  return augmented.slice(contentStart, contentEnd);
}

const macOnly = { skip: process.platform !== "darwin" };

test("macOS browser profile grants only scoped Chromium resources", macOnly, () => {
  const profile = generatedProfile(true);
  const darwinUserTempDir = realpathSync(
    execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim(),
  );

  assert.match(profile, /\(sysctl-name "kern\.hv_vmm_present"\)/);
  assert.match(profile, /\(allow network-bind \(local ip "\*:\*"\)\)/);
  assert.match(profile, /\(allow network-inbound \(local ip "\*:\*"\)\)/);
  assert.match(profile, /\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.match(profile, /\(allow system-socket \(socket-domain AF_UNIX\)\)/);
  assert.match(
    profile,
    new RegExp(
      `\\(allow network-bind \\(local unix-socket \\(subpath ${JSON.stringify(darwinUserTempDir)}\\)\\)\\)`,
    ),
  );
  assert.match(
    profile,
    new RegExp(
      `\\(allow network-outbound \\(remote unix-socket \\(subpath ${JSON.stringify(darwinUserTempDir)}\\)\\)\\)`,
    ),
  );
  assert.match(
    profile,
    new RegExp(
      `\\(allow file-read\\* file-write\\* \\(subpath ${JSON.stringify(darwinUserTempDir)}\\)\\)`,
    ),
  );
  assert.doesNotMatch(profile, /unix-socket \(path-regex #"\^\/"\)/);
  assert.equal(profile.includes("\\n"), false);
});

test("macOS browser profile augmentation is idempotent and preserves the command", macOnly, () => {
  const wrapped = wrapCommandWithSandboxMacOS({
    command: "printf 'browser test'",
    needsNetworkRestriction: true,
    allowBrowserProcess: true,
    readConfig: undefined,
    writeConfig: { allowOnly: [], denyWithinAllow: [] },
  });
  const augmented = augmentMacosBrowserProfile(wrapped, true);

  assert.equal(augmentMacosBrowserProfile(augmented, true), augmented);
  assert.equal(augmented.slice(augmented.indexOf(" -c ")), wrapped.slice(wrapped.indexOf(" -c ")));
});

test("macOS browser adapter ignores an unrelated inline profile", macOnly, () => {
  const unrelated = "/usr/bin/sandbox-exec -p '(version 1)\\n(deny default)' /bin/bash -c 'true'";
  assert.equal(augmentMacosBrowserProfile(unrelated, true), unrelated);
});

test("macOS browser grants are absent when browser mode is disabled", macOnly, () => {
  const profile = generatedProfile(false);
  const darwinUserTempDir = realpathSync(
    execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim(),
  );

  assert.doesNotMatch(profile, /kern\.hv_vmm_present/);
  assert.doesNotMatch(profile, /network-bind \(local ip "\*:\*"\)/);
  assert.doesNotMatch(profile, /network-inbound \(local ip "\*:\*"\)/);
  assert.doesNotMatch(profile, /network-outbound \(remote ip "localhost:\*"\)/);
  assert.doesNotMatch(profile, /socket-domain AF_UNIX/);
  assert.doesNotMatch(
    profile,
    new RegExp(darwinUserTempDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.doesNotMatch(profile, /unix-socket \(path-regex #"\^\/"\)/);
});

test("runtime integration carries browser mode without broad Unix sockets", () => {
  const runtime = buildRuntimeConfig(
    { ...DEFAULT_CONFIG, allowBrowserProcess: true },
    undefined,
    "darwin",
    process.cwd(),
  );

  assert.equal(runtime.allowBrowserProcess, true);
  assert.equal(runtime.network?.allowAllUnixSockets, undefined);
});
