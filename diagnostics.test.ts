import { describe, expect, it } from "vitest";

import {
  diagnosticIdentity,
  formatCommandPreview,
  grantSshSessionAccess,
  isMateriallyDifferent,
  isGitUpstreamMutationCommand,
  makeBrowserProcessFallbackDiagnostic,
  makeBrowserProcessViolationDiagnostic,
  makeSshAgentFallbackDiagnostic,
  parseDiagnosticBlock,
  renderDiagnosticBlock,
  renderDiagnosticNotice,
  renderDiagnosticSummaryLines,
  retainIncident,
  runSshAuthPreflight,
  selectPrimaryViolation,
  shouldPreflightSshAuth,
  socketPathMatches,
  trimIncidents,
  type SandboxDiagnostic,
  type SandboxIncident,
} from "./diagnostics";

function makeDiagnostic(overrides: Partial<SandboxDiagnostic> = {}): SandboxDiagnostic {
  return {
    type: "read",
    target: "/tmp/file",
    rule: "denyRead",
    promptable: false,
    action: "blocked by denyRead; change policy",
    ...overrides,
  };
}

function makeIncident(overrides: Partial<SandboxIncident> = {}): SandboxIncident {
  const primary = makeDiagnostic();
  return {
    id: "1",
    timestamp: new Date("2026-01-01T00:00:00Z"),
    source: "bash",
    commandPreview: "git push origin main",
    commandKey: "git push origin main",
    attributed: true,
    violations: [primary],
    primaryViolation: primary,
    promptShown: false,
    promptChoice: "none",
    promptCount: 0,
    retried: false,
    finalOutcome: "failure",
    configMutation: "none",
    ...overrides,
  };
}

describe("selectPrimaryViolation", () => {
  it("prefers ssh-auth over read/write/network", () => {
    const primary = selectPrimaryViolation([
      makeDiagnostic({ type: "network", target: "github.com", rule: "allowedDomains" }),
      makeDiagnostic({ type: "read", target: "~/.gitconfig", rule: "denyRead" }),
      makeDiagnostic({
        type: "ssh-auth",
        target: "current SSH agent",
        rule: "ssh agent socket blocked",
        promptable: true,
      }),
    ]);

    expect(primary?.type).toBe("ssh-auth");
  });

  it("prefers promptable violations when type priority ties", () => {
    const primary = selectPrimaryViolation([
      makeDiagnostic({ target: "/tmp/a", promptable: false }),
      makeDiagnostic({ target: "/tmp/b", promptable: true }),
    ]);

    expect(primary?.target).toBe("/tmp/b");
  });
});

describe("material difference", () => {
  it("uses type target and rule", () => {
    expect(
      isMateriallyDifferent(
        makeDiagnostic({ target: "/tmp/a", rule: "denyRead" }),
        makeDiagnostic({ target: "/tmp/a", rule: "denyRead" }),
      ),
    ).toBe(false);

    expect(
      isMateriallyDifferent(
        makeDiagnostic({ target: "/tmp/a", rule: "denyRead" }),
        makeDiagnostic({ target: "/tmp/b", rule: "denyRead" }),
      ),
    ).toBe(true);

    expect(
      isMateriallyDifferent(
        makeDiagnostic({ target: "/tmp/a", rule: "denyRead" }),
        makeDiagnostic({ target: "/tmp/a", rule: "allowRead" }),
      ),
    ).toBe(true);
    expect(diagnosticIdentity(makeDiagnostic())).toContain("read::/tmp/file::denyRead");
  });
});

describe("renderDiagnosticBlock", () => {
  it("renders final-state fields and other violations count", () => {
    const primary = makeDiagnostic({
      type: "ssh-auth",
      target: "current SSH agent",
      rule: "ssh agent socket blocked",
      action: "allow SSH use for this session",
    });
    const block = renderDiagnosticBlock(
      makeIncident({
        violations: [
          primary,
          makeDiagnostic({ type: "network", target: "github.com", rule: "allowedDomains" }),
        ],
        primaryViolation: primary,
        promptShown: true,
        promptChoice: "ssh-session",
        retried: true,
        finalOutcome: "success",
      }),
    );

    expect(block).toContain("<sandbox_diagnostic>");
    expect(block).toContain("type: ssh-auth");
    expect(block).toContain("choice: ssh-session");
    expect(block).toContain("final_outcome: success");
    expect(block).toContain("other_violations: 1");
  });

  it("parses a trailing diagnostic block and produces a cleaner notice", () => {
    const block = renderDiagnosticBlock(
      makeIncident({
        promptShown: true,
        promptChoice: "ssh-session",
        retried: true,
        finalOutcome: "success",
        primaryViolation: makeDiagnostic({
          type: "ssh-auth",
          target: "current SSH agent",
          rule: "ssh agent socket blocked",
          action: "allow SSH use for this session",
        }),
      }),
    );

    const parsed = parseDiagnosticBlock(`git output\n\n${block}`);
    expect(parsed?.visibleText).toBe("git output");
    expect(parsed?.data.type).toBe("ssh-auth");
    expect(renderDiagnosticNotice(parsed!.data)).toContain("/sandbox-debug");
    expect(renderDiagnosticSummaryLines(parsed!.data)).toContain("Type: SSH auth");
  });
});

describe("incident retention and trimming", () => {
  it("retains attributed or prompted incidents", () => {
    expect(retainIncident(makeIncident({ attributed: true, promptShown: false }))).toBe(true);
    expect(retainIncident(makeIncident({ attributed: false, promptShown: true }))).toBe(true);
    expect(retainIncident(makeIncident({ attributed: false, promptShown: false }))).toBe(false);
  });

  it("trims to the last N incidents", () => {
    expect(trimIncidents([1, 2, 3, 4, 5, 6], 5)).toEqual([2, 3, 4, 5, 6]);
  });
});

describe("formatCommandPreview", () => {
  it("squashes whitespace and truncates long commands", () => {
    expect(formatCommandPreview("git   push\norigin   main")).toBe("git push origin main");
    expect(formatCommandPreview(`echo ${"x".repeat(120)}`)).toMatch(/\.\.\.$/);
  });
});

describe("isGitUpstreamMutationCommand", () => {
  it.each([
    "git branch -u origin/main main",
    "git branch -uorigin/main main",
    "git branch --set-upstream-to origin/main main",
    "git branch --set-upstream-to=origin/main main",
    "git -C ./repo branch -u origin/main main",
    "GIT_DIR=.git /usr/bin/git branch --set-upstream-to=origin/main main",
    "git -c alias.branch=!bad branch -u origin/main main",
    "git push -u origin main",
    "git push -vu origin main",
    "git push --set-upstream origin main",
    "git push origin main --set-upstream",
    "echo ready && git push -u origin main",
    "git branch -u origin/main main; echo done",
    "env git push -u origin main",
    "command git branch --set-upstream-to=origin/main main",
    "(git push -u origin main)",
    'sh -c "git branch -u origin/main main"',
    "git branch --unset-upstream main",
    "git config branch.main.remote origin",
    "git config --unset branch.main.merge",
    "git config unset Branch.main.Remote",
  ])("identifies tracking mutations: %s", (command) => {
    expect(isGitUpstreamMutationCommand(command)).toBe(true);
  });

  it.each([
    "git push origin main",
    "git branch main",
    "git branch --track feature origin/feature",
    "git switch --track -c feature origin/feature",
    "git checkout --track -b feature origin/feature",
    "git config --get branch.main.remote",
    "git config branch.main.remote",
    "git config unrelated.setting value",
    "git remote set-head origin -a",
    'printf "git push -u origin main"',
    "echo 'git branch -u origin/main main'",
  ])("leaves non-tracking commands alone: %s", (command) => {
    expect(isGitUpstreamMutationCommand(command)).toBe(false);
  });
});

describe("shouldPreflightSshAuth", () => {
  it.each([
    'git commit -m "change" && git push origin main',
    "echo ready; git fetch origin",
    "pnpm test || ssh deploy@example.com",
    "printf ready | git ls-remote git@example.com:team/repo.git",
    "git clone ssh://git@example.com/team/repo.git & echo queued",
    "echo ready\ngit pull origin main",
    "build |& ssh-add -l",
    "TOKEN=value /usr/bin/git push origin main && echo done",
    "git -C ./repo push origin main && echo done",
  ])("preflights compound SSH-capable command: %s", (command) => {
    expect(shouldPreflightSshAuth(command)).toBe(true);
  });

  it.each([
    "git push origin main",
    "ssh deploy@example.com",
    "pnpm test && pnpm run check",
    'echo "ssh" && npm test',
    "printf 'git push' && echo done",
    'echo "a; ssh host"',
    "git clone https://example.com/team/repo.git && echo done",
    "git fetch 'https://example.com/team/repo.git' || echo failed",
    "ssh-agent && echo ready",
    "git commit -m push && npm test",
    "echo ready 2>&1",
    "echo ready &>output.log",
    "echo ready <&0",
    "git push origin main >|output.log",
  ])("leaves commands that do not need compound SSH preflight alone: %s", (command) => {
    expect(shouldPreflightSshAuth(command)).toBe(false);
  });
});

describe("grantSshSessionAccess", () => {
  const socket = "/tmp/ssh-agent.sock";

  it("adds the socket before reinitialising the sandbox", async () => {
    const allowedSockets: string[] = [];
    const granted = await grantSshSessionAccess({
      socketPath: socket,
      allowedSockets,
      reinitialize: async () => allowedSockets.includes(socket),
      platform: "darwin",
    });

    expect(granted).toBe(true);
    expect(allowedSockets).toEqual([socket]);
  });

  it("does not add a path-scoped allowance on Linux", async () => {
    const allowedSockets: string[] = [];
    const granted = await grantSshSessionAccess({
      socketPath: socket,
      allowedSockets,
      reinitialize: async () => true,
      platform: "linux",
    });

    expect(granted).toBe(false);
    expect(allowedSockets).toEqual([]);
  });

  it.each([
    async () => false,
    async () => {
      throw new Error("reset failed");
    },
  ])("rolls back a new allowance when reinitialisation fails", async (reinitialize) => {
    const allowedSockets: string[] = [];
    const granted = await grantSshSessionAccess({
      socketPath: socket,
      allowedSockets,
      reinitialize,
      platform: "darwin",
    });

    expect(granted).toBe(false);
    expect(allowedSockets).toEqual([]);
  });
});

describe("socketPathMatches", () => {
  it.each([
    ["the same socket", "/tmp/ssh-agent.sock", "/tmp/ssh-agent.sock", true],
    ["a socket below an allowed directory", "/tmp/ssh", "/tmp/ssh/agent.123", true],
    ["a sibling with a shared prefix", "/tmp/ssh", "/tmp/ssh-other/agent.123", false],
    ["a normalised path", "/tmp/ssh/./agent", "/tmp/ssh/agent", true],
  ])("matches %s", (_label, allowed, actual, expected) => {
    expect(socketPathMatches(allowed, actual)).toBe(expected);
  });
});

describe("runSshAuthPreflight", () => {
  const command = "git commit -m change && git push origin main";
  const socket = "/tmp/ssh-agent.sock";

  it("requests and grants access once before continuing", async () => {
    const events: string[] = [];
    const result = await runSshAuthPreflight({
      command,
      sshAuthSock: socket,
      allowedSockets: [],
      allowAllSockets: false,
      requestAccess: async (socketPath) => {
        events.push(`grant:${socketPath}`);
        return true;
      },
      platform: "darwin",
    });

    expect(result).toBe("allowed");
    expect(events).toEqual([`grant:${socket}`]);
  });

  it("blocks when access is denied", async () => {
    const result = await runSshAuthPreflight({
      command,
      sshAuthSock: socket,
      allowedSockets: [],
      allowAllSockets: false,
      requestAccess: async () => false,
      platform: "darwin",
    });

    expect(result).toBe("blocked");
  });

  it("recognises a configured socket directory", async () => {
    const result = await runSshAuthPreflight({
      command,
      sshAuthSock: "/tmp/ssh-agent/agent.123",
      allowedSockets: ["/tmp/ssh-agent"],
      allowAllSockets: false,
      requestAccess: async () => true,
      platform: "darwin",
    });

    expect(result).toBe("not-needed");
  });

  it("does not offer path-scoped access on Linux", async () => {
    let prompts = 0;
    const result = await runSshAuthPreflight({
      command,
      sshAuthSock: socket,
      allowedSockets: [socket],
      allowAllSockets: false,
      requestAccess: async () => {
        prompts++;
        return true;
      },
      platform: "linux",
    });

    expect(result).toBe("blocked");
    expect(prompts).toBe(0);
  });

  it.each([
    { allowedSockets: [socket], allowAllSockets: false },
    { allowedSockets: [], allowAllSockets: true },
  ])("does not prompt when socket access already exists", async (access) => {
    let prompts = 0;
    const result = await runSshAuthPreflight({
      command,
      sshAuthSock: socket,
      ...access,
      platform: "darwin",
      requestAccess: async () => {
        prompts++;
        return true;
      },
    });

    expect(result).toBe("not-needed");
    expect(prompts).toBe(0);
  });
});

describe("browser process diagnostics", () => {
  it("classifies Chromium Mach service registration violations", () => {
    const diagnostic = makeBrowserProcessViolationDiagnostic(
      'Sandbox: Chromium deny(1) mach-register "org.chromium.Chromium.MachPortRendezvousServer.4312"',
    );

    expect(diagnostic).toMatchObject({
      type: "browser-process",
      target: "Chromium Mach service",
      rawTarget: "org.chromium.Chromium.MachPortRendezvousServer.4312",
      rule: "allowBrowserProcess",
      promptable: false,
    });
    expect(diagnostic?.action).toContain("trusted global config");
  });

  it("does not classify unrelated Mach violations as browser failures", () => {
    expect(
      makeBrowserProcessViolationDiagnostic(
        'Sandbox: node deny(1) mach-lookup "com.apple.example.service"',
      ),
    ).toBeNull();
  });

  it("classifies Chromium bootstrap error 1100 output as a fallback", () => {
    const diagnostic = makeBrowserProcessFallbackDiagnostic(
      "org.chromium.Chromium.MachPortRendezvousServer.4312: " +
        "bootstrap_check_in failed: BOOTSTRAP_NOT_PRIVILEGED (error 1100)",
    );

    expect(diagnostic).toMatchObject({
      type: "browser-process",
      rule: "allowBrowserProcess",
      rawTarget: "org.chromium.Chromium.MachPortRendezvousServer.4312",
    });
  });

  it("requires both the Chromium service and bootstrap denial in fallback output", () => {
    expect(
      makeBrowserProcessFallbackDiagnostic("unrelated process failed with error 1100"),
    ).toBeNull();
    expect(
      makeBrowserProcessFallbackDiagnostic(
        "org.chromium.Chromium.MachPortRendezvousServer.4312 started",
      ),
    ).toBeNull();
  });
});

describe("makeSshAgentFallbackDiagnostic", () => {
  it("classifies agent operation-not-permitted failures as ssh-auth", () => {
    const diagnostic = makeSshAgentFallbackDiagnostic(
      "/var/run/com.apple.launchd.sock",
      "ssh-add -l",
      "Error connecting to agent: Operation not permitted",
    );

    expect(diagnostic).toMatchObject({
      type: "ssh-auth",
      target: "current SSH agent",
      rawTarget: "/var/run/com.apple.launchd.sock",
      promptable: true,
    });
  });

  it("returns null when no agent socket is present", () => {
    expect(
      makeSshAgentFallbackDiagnostic(
        undefined,
        "ssh-add -l",
        "Error connecting to agent: Operation not permitted",
      ),
    ).toBeNull();
  });

  it("classifies git publickey failures only for clearly SSH-targeted commands", () => {
    const diagnostic = makeSshAgentFallbackDiagnostic(
      "/var/run/com.apple.launchd.sock",
      "git ls-remote origin",
      "git@github.com: Permission denied (publickey).",
    );

    expect(diagnostic).toMatchObject({
      type: "ssh-auth",
      target: "current SSH agent",
    });
  });

  it("does not classify unrelated publickey text without an SSH-targeted command", () => {
    expect(
      makeSshAgentFallbackDiagnostic(
        "/var/run/com.apple.launchd.sock",
        "echo permission denied",
        "Permission denied (publickey).",
      ),
    ).toBeNull();
  });
});
