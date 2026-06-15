import { describe, expect, it } from "vitest";

import {
  diagnosticIdentity,
  formatCommandPreview,
  isMateriallyDifferent,
  makeSshAgentFallbackDiagnostic,
  renderDiagnosticBlock,
  retainIncident,
  selectPrimaryViolation,
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

describe("makeSshAgentFallbackDiagnostic", () => {
  it("classifies agent operation-not-permitted failures as ssh-auth", () => {
    const diagnostic = makeSshAgentFallbackDiagnostic(
      "/var/run/com.apple.launchd.sock",
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
        "Error connecting to agent: Operation not permitted",
      ),
    ).toBeNull();
  });
});
