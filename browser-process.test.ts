import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { generateSandboxProfile } from "@carderne/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { describe, expect, it } from "vitest";

const describeMacOS = process.platform === "darwin" ? describe : describe.skip;

function browserProfile(enabled: boolean): string {
  return generateSandboxProfile({
    needsNetworkRestriction: true,
    allowBrowserProcess: enabled,
    readConfig: undefined,
    writeConfig: { allowOnly: [], denyWithinAllow: [] },
    logTag: "PI_SANDBOX_BROWSER_TEST",
  });
}

describeMacOS("macOS browser process policy", () => {
  const darwinUserTempDir = realpathSync(
    execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
    }).trim(),
  );

  it("supplies Chromium permissions without broad Unix socket access", () => {
    const profile = browserProfile(true);

    expect(profile).toContain('(sysctl-name "kern.hv_vmm_present")');
    expect(profile).toContain('(allow network-bind (local ip "*:*")');
    expect(profile).toContain("(allow system-socket (socket-domain AF_UNIX))");
    expect(profile).toContain(
      `(allow network-bind (local unix-socket (subpath "${darwinUserTempDir}")))`,
    );
    expect(profile).toContain(`(allow file-read* file-write* (subpath "${darwinUserTempDir}"))`);
    expect(profile).not.toContain('unix-socket (path-regex #"^/")');
  });

  it("keeps Chromium permissions disabled outside browser mode", () => {
    const profile = browserProfile(false);

    expect(profile).not.toContain('(sysctl-name "kern.hv_vmm_present")');
    expect(profile).not.toContain('(allow network-bind (local ip "*:*")');
    expect(profile).not.toContain("(allow system-socket (socket-domain AF_UNIX))");
    expect(profile).not.toContain(darwinUserTempDir);
  });
});
