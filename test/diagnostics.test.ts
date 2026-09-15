import test from "node:test";

import assert from "node:assert/strict";

import {
  diagnosticIdentity,
  finalizeDiagnostic,
  isGitUpstreamMutationCommand,
  isMateriallyDifferent,
  makeBrowserProcessFallbackDiagnostic,
  makeBrowserProcessViolationDiagnostic,
  makeSshAgentFallbackDiagnostic,
  parseDiagnosticBlock,
  parseFallbackDiagnosticFromOutput,
  parseViolationEvent,
  renderDiagnosticBlock,
  renderDiagnosticNotice,
  renderDiagnosticSummaryLines,
  selectPrimaryViolation,
  type SandboxDiagnostic,
  type SandboxIncident,
} from "../src/diagnostics.ts";
import {
  gitUpstreamMutationCommands,
  nonGitUpstreamMutationCommands,
} from "./git-upstream-command-fixtures.ts";

function makeDiagnostic(overrides: Partial<SandboxDiagnostic> = {}): SandboxDiagnostic {
  return {
    type: "read",
    target: "/tmp/file",
    rawTarget: "/tmp/file",
    rule: "denyRead",
    promptable: false,
    action: "blocked by denyRead; change policy",
    ...overrides,
  };
}

function makeIncident(overrides: Partial<SandboxIncident> = {}): SandboxIncident {
  const primary = makeDiagnostic();
  return {
    id: "incident-1",
    timestamp: new Date("2026-01-01T00:00:00Z"),
    source: "bash",
    commandPreview: "cat /tmp/file",
    commandKey: "cat /tmp/file",
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

const policy = {
  cwd: "/project",
  allowRead: ["/project"],
  denyRead: ["/project/private"],
  allowWrite: ["/project"],
  denyWrite: ["/project/private"],
  allowedDomains: ["*.example.com"],
  deniedDomains: ["private.example.com"],
};

test("identifies Git tracking mutations across direct, compound, wrapper, and nested forms", () => {
  for (const command of gitUpstreamMutationCommands) {
    assert.equal(isGitUpstreamMutationCommand(command), true, command);
  }
});

test("leaves ordinary operations and quoted prose alone", () => {
  for (const command of nonGitUpstreamMutationCommands) {
    assert.equal(isGitUpstreamMutationCommand(command), false, command);
  }
});

test("parses structured read, write, network, SSH-agent, browser, and ambiguous events", () => {
  assert.deepEqual(parseViolationEvent({ line: 'deny file-read-data "/project/read.txt"' }), {
    type: "read",
    target: "/project/read.txt",
    rawTarget: "/project/read.txt",
    rule: "allowRead",
    promptable: true,
    action: "allow and retry",
  });
  assert.equal(
    parseViolationEvent({ line: 'deny file-write-create "/project/write.txt"' }).type,
    "write",
  );
  assert.equal(
    parseViolationEvent({ line: "network-outbound blocked api.example.com:443" }).type,
    "network",
  );
  assert.equal(
    parseViolationEvent({ line: 'deny file-write-data "/tmp/agent.sock"' }, "/tmp/agent.sock").type,
    "ssh-auth",
  );
  assert.equal(
    parseViolationEvent({
      line: 'deny mach-register "org.chromium.Chromium.MachPortRendezvousServer.4312"',
    }).type,
    "browser-process",
  );
  assert.equal(parseViolationEvent({ line: "unrecognised runtime violation" }).type, "ambiguous");
});

test("reclassifies structured and fallback targets through shared policy precedence", () => {
  const deniedRead = finalizeDiagnostic(
    parseViolationEvent({ line: 'deny file-read-data "/project/private/key"' }),
    policy,
  );
  assert.equal(deniedRead.rule, "denyRead");
  assert.equal(deniedRead.promptable, false);

  const specificRead = finalizeDiagnostic(
    parseViolationEvent({ line: 'deny file-read-data "/project/private/public/file"' }),
    { ...policy, allowRead: ["/project/private/public"] },
  );
  assert.equal(specificRead.promptable, false);
  assert.equal(specificRead.action, "read access allowed");

  const fallback = parseFallbackDiagnosticFromOutput(
    "cat /project/private/key",
    "cat: /project/private/key: Operation not permitted",
    undefined,
  );
  assert.ok(fallback);
  const finalFallback = finalizeDiagnostic(fallback, policy);
  assert.equal(finalFallback.rule, "denyRead");
  assert.equal(finalFallback.promptable, false);

  const deniedDomain = finalizeDiagnostic(
    parseViolationEvent({ line: "network blocked private.example.com" }),
    policy,
  );
  assert.equal(deniedDomain.rule, "deniedDomains");
  assert.equal(deniedDomain.promptable, false);
});

test("selects promptable violations by type priority and detects changed retry targets", () => {
  const read = makeDiagnostic({ target: "/tmp/a", promptable: false });
  const promptableRead = makeDiagnostic({ target: "/tmp/b", promptable: true });
  const network = makeDiagnostic({ type: "network", target: "api.example.com" });
  const ssh = makeDiagnostic({ type: "ssh-auth", target: "current SSH agent" });

  assert.equal(selectPrimaryViolation([network, read, ssh])?.type, "ssh-auth");
  assert.equal(selectPrimaryViolation([read, promptableRead])?.target, "/tmp/b");
  assert.equal(isMateriallyDifferent(read, read), false);
  assert.equal(isMateriallyDifferent(read, promptableRead), true);
  assert.match(diagnosticIdentity(read), /^read::\/tmp\/a::denyRead$/);
});

test("renders and strictly parses final diagnostic metadata", () => {
  const primary = makeDiagnostic({
    type: "ssh-auth",
    target: "current SSH agent",
    rule: "ssh agent socket blocked",
    action: "allow SSH use for this session",
  });
  const block = renderDiagnosticBlock(
    makeIncident({
      violations: [primary, makeDiagnostic({ type: "network", target: "api.example.com" })],
      primaryViolation: primary,
      promptShown: true,
      promptChoice: "ssh-session",
      retried: true,
      finalOutcome: "success",
    }),
  );
  assert.ok(block);

  const parsed = parseDiagnosticBlock(`command output\n\n${block}`);
  assert.equal(parsed?.visibleText, "command output");
  assert.equal(parsed?.data.finalOutcome, "success");
  assert.equal(parsed?.data.otherViolations, 1);
  assert.match(renderDiagnosticNotice(parsed!.data), /retried successfully/);
  assert.equal(renderDiagnosticSummaryLines(parsed!.data).includes("Type: SSH auth"), true);

  assert.equal(parseDiagnosticBlock(block.replace("prompted: yes", "prompted: maybe")), null);
  assert.equal(
    parseDiagnosticBlock(block.replace("other_violations: 1", "other_violations: -1")),
    null,
  );
});

test("attributes browser and SSH-agent fallback output without broadening access", () => {
  assert.equal(
    makeBrowserProcessViolationDiagnostic('deny mach-lookup "com.apple.unrelated.service"'),
    null,
  );
  assert.equal(
    makeBrowserProcessFallbackDiagnostic(
      "org.chromium.Chromium.MachPortRendezvousServer.4312: bootstrap error 1100",
    )?.type,
    "browser-process",
  );
  assert.equal(
    makeSshAgentFallbackDiagnostic(
      "/tmp/agent.sock",
      "git ls-remote origin",
      "git@example.com: Permission denied (publickey).",
    )?.type,
    "ssh-auth",
  );
  assert.equal(
    makeSshAgentFallbackDiagnostic(
      "/tmp/agent.sock",
      "echo failure",
      "Permission denied (publickey)",
    ),
    null,
  );
  assert.equal(
    makeSshAgentFallbackDiagnostic(
      "/tmp/agent.sock",
      "printf 'Error connecting to agent: Operation not permitted'",
      "Error connecting to agent: Operation not permitted",
    ),
    null,
  );
  assert.equal(
    parseFallbackDiagnosticFromOutput("command", "sandbox: Operation not permitted", undefined)
      ?.type,
    "ambiguous",
  );
});
