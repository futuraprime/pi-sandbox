import test from "node:test";

import { createSandboxManager, type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import assert from "node:assert/strict";

function runtimeConfig(domain: string): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [domain], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
  };
}

test("factory managers isolate configuration, violation stores, and reset", async () => {
  const first = createSandboxManager();
  const second = createSandboxManager();
  const firstInput = runtimeConfig("first.example");
  const secondInput = runtimeConfig("second.example");

  first.updateConfig(firstInput);
  second.updateConfig(secondInput);

  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.getSandboxViolationStore(), second.getSandboxViolationStore());
  assert.notStrictEqual(first.getConfig(), firstInput);
  assert.notStrictEqual(second.getConfig(), secondInput);

  firstInput.network.allowedDomains.push("caller-mutation.example");
  assert.deepEqual(first.getNetworkRestrictionConfig().allowedHosts, ["first.example"]);
  assert.deepEqual(second.getNetworkRestrictionConfig().allowedHosts, ["second.example"]);

  first.getSandboxViolationStore().addViolation({
    line: "deny file-write-data /first/private",
    command: "first-command",
    timestamp: new Date(),
  });
  assert.equal(first.getSandboxViolationStore().getCount(), 1);
  assert.equal(second.getSandboxViolationStore().getCount(), 0);

  await first.reset();
  assert.deepEqual(second.getNetworkRestrictionConfig().allowedHosts, ["second.example"]);
  assert.equal(second.getSandboxViolationStore().getCount(), 0);
  assert.equal(first.getSandboxViolationStore().getCount(), 1);

  // Runtime 0.0.72 reset clears owned resources but retains config and violations.
  assert.deepEqual(first.getNetworkRestrictionConfig().allowedHosts, ["first.example"]);
  await second.reset();
});

test(
  "pre-proxy initialization failure retains only that manager's config",
  { skip: process.platform !== "darwin" && process.platform !== "linux" },
  async () => {
    const first = createSandboxManager();
    const second = createSandboxManager();
    const failingConfig = runtimeConfig("first.example");
    failingConfig.network.tlsTerminate = {};
    failingConfig.network.mitmProxy = { socketPath: "/unused.sock", domains: [] };
    const secondConfig = runtimeConfig("second.example");
    second.updateConfig(secondConfig);

    try {
      await assert.rejects(first.initialize(failingConfig), /mutually exclusive/);
      assert.strictEqual(first.getConfig(), failingConfig);
      failingConfig.network.allowedDomains.push("caller-mutation.example");
      assert.deepEqual(first.getNetworkRestrictionConfig().allowedHosts, [
        "first.example",
        "caller-mutation.example",
      ]);
      assert.equal(first.getProxyPort(), undefined);
      assert.deepEqual(second.getNetworkRestrictionConfig().allowedHosts, ["second.example"]);

      await first.reset();
      assert.strictEqual(first.getConfig(), failingConfig);
      assert.deepEqual(second.getNetworkRestrictionConfig().allowedHosts, ["second.example"]);
    } finally {
      await Promise.all([first.reset(), second.reset()]);
    }
  },
);
