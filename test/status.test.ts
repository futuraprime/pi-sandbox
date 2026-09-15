import test from "node:test";

import assert from "node:assert/strict";

import {
  MAX_DEBUG_INCIDENTS,
  formatCommandPreview,
  recordIncident,
  type SandboxDiagnostic,
  type SandboxIncident,
} from "../src/diagnostics.ts";
import {
  formatSandboxDebug,
  formatSandboxStatus,
  getSandboxStatusPresentation,
  renderSandboxDiagnosticResult,
} from "../src/status.ts";

function diagnostic(target: string): SandboxDiagnostic {
  return {
    type: "write",
    target,
    rawTarget: target,
    rule: "allowWrite",
    promptable: true,
    action: "allow and retry",
  };
}

function incident(index: number, retained = true): SandboxIncident {
  const violation = diagnostic(`/tmp/file-${index}`);
  return {
    id: `incident-${index}`,
    timestamp: new Date(`2026-01-01T00:00:0${index}Z`),
    source: "user_bash",
    commandPreview: formatCommandPreview(`printf   command-${index}`),
    commandKey: `printf command-${index}`,
    attributed: retained,
    violations: retained ? [violation] : [],
    primaryViolation: retained ? violation : undefined,
    promptShown: false,
    promptChoice: "none",
    promptCount: 0,
    retried: false,
    finalOutcome: "failure",
    configMutation: "none",
  };
}

test("retains only attributed or prompted incidents and keeps the newest five", () => {
  const incidents: SandboxIncident[] = [];
  assert.equal(MAX_DEBUG_INCIDENTS, 5);
  assert.equal(recordIncident(incidents, incident(0, false)), false);
  for (let index = 1; index <= 6; index += 1) {
    assert.equal(recordIncident(incidents, incident(index)), true);
  }
  assert.deepEqual(
    incidents.map((item) => item.id),
    ["incident-2", "incident-3", "incident-4", "incident-5", "incident-6"],
  );
});

test("records prompted incidents and renders debug entries newest first", () => {
  const incidents: SandboxIncident[] = [];
  const prompted = incident(1, false);
  prompted.promptShown = true;
  prompted.promptChoice = "session";
  assert.equal(recordIncident(incidents, prompted), true);

  const retained = incident(2);
  retained.retried = true;
  retained.configMutation = ".pi/sandbox.json";
  assert.equal(recordIncident(incidents, retained), true);

  const output = formatSandboxDebug(incidents);
  assert.ok(output.indexOf("command-2") < output.indexOf("command-1"));
  assert.match(output, /choice: session/);
  assert.match(output, /config mutation: \.pi\/sandbox\.json/);
  assert.match(output, /rule=allowWrite/);
  assert.doesNotMatch(output, /<sandbox_diagnostic>/);
  assert.match(formatSandboxDebug([], false), /^Sandbox is disabled/);
});

test("uses compact lifecycle status states and clears on shutdown", () => {
  const theme = { fg: (_tone: string, text: string) => `<${text}>` };
  assert.equal(formatSandboxStatus("enabled", theme), "<🔒>");
  assert.equal(formatSandboxStatus("disabled", theme), "<ꗃ>");
  assert.equal(formatSandboxStatus("pending", theme), "<ꗃ>");
  assert.equal(formatSandboxStatus("unsupported", theme), "<ꗃ>");
  assert.equal(formatSandboxStatus("error", theme), "<ꗃ>");
  assert.equal(formatSandboxStatus("shutdown", theme), undefined);
  assert.equal(getSandboxStatusPresentation("enabled").description, "Sandbox enabled");
});

test("collapsed intervention presentation never includes raw diagnostic metadata", () => {
  const diagnosticData = {
    type: "network" as const,
    target: "api.example.com",
    rule: "allowedDomains",
    prompted: false,
    choice: "none" as const,
    retried: false,
    finalOutcome: "failure" as const,
    otherViolations: 0,
    action: "host not allowed; approve network access",
  };
  const result = {
    content: [
      {
        type: "text",
        text: `clean output\n<sandbox_diagnostic>\nsecret metadata\n</sandbox_diagnostic>`,
      },
    ],
    details: { sandboxDiagnostic: diagnosticData },
  };
  const theme = {
    fg: (_tone: string, text: string) => text,
    bold: (text: string) => text,
  };
  const collapsed = renderSandboxDiagnosticResult(result, "collapsed", theme)
    .render(100)
    .join("\n");
  assert.match(collapsed, /Sandbox intervention/);
  assert.doesNotMatch(collapsed, /clean output|sandbox_diagnostic|secret metadata/);
});
