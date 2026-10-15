import test from "node:test";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";

import {
  permissionOptions,
  permissionPromptRemainingSeconds,
  permissionPromptTimeoutMs,
  promptDomainBlock,
  promptManualBypass,
  promptReadBlock,
  promptSshAuthBlock,
  promptWriteBlock,
  showPermissionPrompt,
  type ManualBypassChoice,
  type PermissionChoice,
} from "../src/ui.ts";

test("permissionPromptTimeoutMs defaults omission and enables only positive finite timeouts", () => {
  assert.equal(permissionPromptTimeoutMs(undefined), 600_000);
  assert.equal(permissionPromptTimeoutMs(0), undefined);
  assert.equal(permissionPromptTimeoutMs(-1), undefined);
  assert.equal(permissionPromptTimeoutMs(Number.NaN), undefined);
  assert.equal(permissionPromptTimeoutMs(Number.POSITIVE_INFINITY), undefined);
  assert.equal(permissionPromptTimeoutMs("30"), undefined);
  assert.equal(permissionPromptTimeoutMs(30), 30_000);
  assert.equal(permissionPromptTimeoutMs(Number.MAX_VALUE), 2_147_483_647);
});

test("permissionOptions displays Pi's configured global path", () => {
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-agent";
  try {
    assert.equal(permissionOptions("/workspace")[3]?.hint, "→ /tmp/custom-pi-agent/sandbox.json");
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
});

test("permissionPromptRemainingSeconds rounds up and stops at zero", () => {
  const deadlineMs = 10_000;
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 7_000), 3);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 7_001), 3);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 8_000), 2);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 9_999), 1);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 10_000), 0);
  assert.equal(permissionPromptRemainingSeconds(deadlineMs, 11_000), 0);
});

test("manual command prompts expose an explicit one-time unsandboxed choice", async () => {
  const prompt = openInteractivePrompt((pi, ctx) =>
    promptDomainBlock(pi, ctx, "api.example.com", undefined, {
      action: "run-once-unsandboxed",
      label: "Run once unsandboxed",
    }),
  );
  assert.ok(prompt.rendered().some((line) => line.includes("Run once unsandboxed")));
  prompt.component.handleInput("u");
  assert.deepEqual(await prompt.result, {
    action: "run-once-unsandboxed",
    value: "api.example.com",
  });

  const denied = openInteractivePrompt((pi, ctx) =>
    promptManualBypass(pi, ctx, "Network denied", "blocked.example", undefined, {
      action: "run-once-unsandboxed",
      label: "Run once unsandboxed",
    }),
  );
  assert.deepEqual(
    denied.rendered().filter((line) => line.includes("Allow for")),
    [],
  );
  denied.component.handleInput("u");
  assert.deepEqual(await denied.result, {
    action: "run-once-unsandboxed",
    value: "blocked.example",
  });
});

test("manual bypass warnings remain visible at width 50 and bypass skips rule validation", async () => {
  const warning =
    "The entire original command runs without sandbox restrictions, not just this target. " +
    "The command may have partly run; retrying repeats side effects.";
  const manual = openInteractivePrompt((pi, ctx) =>
    promptManualBypass(pi, ctx, "Network blocked", "blocked.example", undefined, {
      action: "retry-once-unsandboxed",
      label: "Retry once unsandboxed",
      warning,
    }),
  );
  const manualText = manual.component.render(50).join(" ").replaceAll("⚠", "").replace(/\s+/g, " ");
  assert.match(manualText, /entire original command runs without sandbox restrictions/);
  assert.match(manualText, /may have partly run; retrying repeats side effects/);
  manual.component.handleInput("u");
  await manual.result;

  const ssh = openInteractivePrompt((pi, ctx) =>
    promptSshAuthBlock(pi, ctx, undefined, {
      action: "retry-once-unsandboxed",
      label: "Retry once unsandboxed",
      warning,
    }),
  );
  const sshText = ssh.component.render(50).join(" ").replaceAll("⚠", "").replace(/\s+/g, " ");
  assert.match(sshText, /entire original command runs without sandbox restrictions/);
  assert.match(sshText, /may have partly run; retrying repeats side effects/);
  ssh.component.handleInput("u");
  await ssh.result;

  let validations = 0;
  const editedRule = openInteractivePrompt((pi, ctx) =>
    showPermissionPrompt<PermissionChoice | ManualBypassChoice>(
      pi,
      ctx,
      "Blocked",
      "original target",
      () => {
        validations += 1;
        return "Invalid edited rule";
      },
      undefined,
      [
        { label: "Allow for this session only", key: "s", action: "session" },
        {
          label: "Retry once unsandboxed",
          key: "u",
          action: "retry-once-unsandboxed",
        },
      ],
      "invalid edited rule",
    ),
  );
  editedRule.component.handleInput("u");
  assert.deepEqual(await editedRule.result, {
    action: "retry-once-unsandboxed",
    value: "original target",
  });
  assert.equal(validations, 0);
});

test("SSH prompts expose only abort and ssh-session results", async () => {
  const pi = { events: { emit: () => undefined } } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/workspace",
    hasUI: true,
    ui: {
      custom: async () => ({ action: "ssh-session", value: "SSH agent" }),
    },
  } as unknown as ExtensionContext;

  const result = await promptSshAuthBlock(pi, ctx);
  assert.deepEqual(result, { action: "ssh-session", value: "SSH agent" });
});

test(
  "showPermissionPrompt safely aborts when its timeout expires",
  { timeout: 1_000 },
  async () => {
    type TestComponent = { render(width: number): string[]; dispose?(): void };
    type PromptFactory<T> = (
      tui: { requestRender(): void },
      theme: { fg(color: string, text: string): string },
      keybindings: object,
      done: (result: T) => void,
    ) => TestComponent;

    let renderedLines: string[] = [];
    const pi = {
      events: { emit: () => undefined },
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: "/workspace",
      hasUI: true,
      ui: {
        custom: <T>(factory: PromptFactory<T>): Promise<T> =>
          new Promise<T>((resolve) => {
            let component: TestComponent | undefined;
            const done = (result: T): void => {
              component?.dispose?.();
              resolve(result);
            };
            component = factory(
              { requestRender: () => undefined },
              { fg: (_color, text) => text },
              {},
              done,
            );
            renderedLines = component.render(80);
          }),
      },
    } as unknown as ExtensionContext;

    const result = await showPermissionPrompt(
      pi,
      ctx,
      "Blocked",
      "example.test",
      () => null,
      0.001,
    );

    assert.ok(renderedLines.includes("⏳ Auto-abort in 1s (permission stays blocked)"));
    assert.deepEqual(result, { action: "abort", value: "example.test" });
  },
);

type InteractivePrompt = {
  component: { handleInput(data: string): void; render(width: number): string[]; dispose?(): void };
  result: Promise<unknown>;
  rendered: () => string[];
};

function openInteractivePrompt(
  invoke: (pi: ExtensionAPI, ctx: ExtensionContext) => Promise<unknown>,
  cwd = "/workspace",
): InteractivePrompt & { attention: () => number } {
  let component: InteractivePrompt["component"] | undefined;
  let renderedLines: string[] = [];
  let attentionCount = 0;
  const pi = {
    events: { emit: () => (attentionCount += 1) },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      custom: <T>(
        factory: (
          tui: any,
          theme: any,
          keybindings: object,
          done: (value: T) => void,
        ) => InteractivePrompt["component"],
      ): Promise<T> =>
        new Promise<T>((resolve) => {
          component = factory(
            {
              requestRender: () => {
                if (component) renderedLines = component.render(120);
              },
            },
            { fg: (_color: string, text: string) => text },
            {},
            (value) => {
              component?.dispose?.();
              resolve(value);
            },
          );
          renderedLines = component.render(120);
        }),
    },
  } as unknown as ExtensionContext;

  const result = invoke(pi, ctx);
  return {
    component: component!,
    result,
    rendered: () => renderedLines,
    attention: () => attentionCount,
  };
}

function replacePromptInput(prompt: InteractivePrompt, text: string): void {
  for (let i = 0; i < 200; i += 1) prompt.component.handleInput("\x7f");
  prompt.component.handleInput(text);
}

test("editable domain rules validate syntax, target matching, and session acceptance", async () => {
  const prompt = openInteractivePrompt((pi, ctx) => promptDomainBlock(pi, ctx, "api.example.com"));
  prompt.component.handleInput("\t");
  replacePromptInput(prompt, "bad domain");
  prompt.component.handleInput("\r");
  assert.ok(prompt.rendered().some((line) => line.includes("Invalid domain pattern")));

  replacePromptInput(prompt, "other.example.com");
  prompt.component.handleInput("\r");
  assert.ok(prompt.rendered().some((line) => line.includes("Rule must match the blocked")));

  replacePromptInput(prompt, "*.example.com");
  prompt.component.handleInput("\r");
  assert.deepEqual(await prompt.result, {
    action: "session",
    value: "*.example.com",
  });
  assert.equal(prompt.attention(), 1);
});

test("edited write rules reject non-matches and accept a matching rule", async () => {
  const cwd = "/tmp/prompt-project";
  const target = `${cwd}/packages/widget/src/output.js`;
  const prompt = openInteractivePrompt((pi, ctx) => promptWriteBlock(pi, ctx, target), cwd);
  prompt.component.handleInput("\t");
  replacePromptInput(prompt, "other/path");
  prompt.component.handleInput("\r");
  assert.ok(prompt.rendered().some((line) => line.includes("Rule must match the blocked")));
  replacePromptInput(prompt, "packages/widget");
  prompt.component.handleInput("\r");
  assert.deepEqual(await prompt.result, {
    action: "session",
    value: "packages/widget",
  });
});

test("filesystem prompts display ctx.cwd-relative rules and abort with the original target", async () => {
  const cwd = "/tmp/prompt-project";
  const target = `${cwd}/packages/widget/src/index.ts`;
  const prompt = openInteractivePrompt((pi, ctx) => promptReadBlock(pi, ctx, target), cwd);
  assert.ok(prompt.rendered().some((line) => line.includes("packages/widget/src/index.ts")));
  prompt.component.handleInput("\t");
  prompt.component.handleInput("partial-edit");
  prompt.component.handleInput("\x03");
  assert.deepEqual(await prompt.result, { action: "abort", value: target });
});

test("filesystem edits reset safely, reject non-matches, and accept matching project rules", async () => {
  const cwd = "/tmp/prompt-project";
  const target = `${cwd}/packages/widget/src/index.ts`;
  const prompt = openInteractivePrompt((pi, ctx) => promptReadBlock(pi, ctx, target), cwd);
  prompt.component.handleInput("\t");
  replacePromptInput(prompt, "other/path");
  prompt.component.handleInput("\r");
  assert.ok(prompt.rendered().some((line) => line.includes("Rule must match the blocked")));
  prompt.component.handleInput("\x1b");
  prompt.component.handleInput("s");
  assert.deepEqual(await prompt.result, {
    action: "session",
    value: "packages/widget/src/index.ts",
  });

  const projectPrompt = openInteractivePrompt((pi, ctx) => promptReadBlock(pi, ctx, target), cwd);
  projectPrompt.component.handleInput("\x1b[B");
  projectPrompt.component.handleInput("\x1b[B");
  projectPrompt.component.handleInput("\t");
  replacePromptInput(projectPrompt, "packages/widget");
  projectPrompt.component.handleInput("\r");
  projectPrompt.component.handleInput("\r");
  assert.deepEqual(await projectPrompt.result, {
    action: "project",
    value: "packages/widget",
  });
});

test("persistent choices require a second confirmation through key, navigation, and editing", async () => {
  const byKey = openInteractivePrompt((pi, ctx) =>
    showPermissionPrompt(pi, ctx, "Blocked", "example.test", () => null),
  );
  byKey.component.handleInput("P");
  let keySettled = false;
  void byKey.result.then(() => (keySettled = true));
  await Promise.resolve();
  assert.equal(keySettled, false);
  byKey.component.handleInput("\r");
  assert.equal(((await byKey.result) as { action: string }).action, "project");

  const byNavigation = openInteractivePrompt((pi, ctx) =>
    showPermissionPrompt(pi, ctx, "Blocked", "example.test", () => null),
  );
  byNavigation.component.handleInput("\x1b[B");
  byNavigation.component.handleInput("\x1b[B");
  byNavigation.component.handleInput("\r");
  let navigationSettled = false;
  void byNavigation.result.then(() => (navigationSettled = true));
  await Promise.resolve();
  assert.equal(navigationSettled, false);
  byNavigation.component.handleInput("\r");
  assert.equal(((await byNavigation.result) as { action: string }).action, "project");

  const afterEditing = openInteractivePrompt((pi, ctx) =>
    promptDomainBlock(pi, ctx, "api.example.test"),
  );
  afterEditing.component.handleInput("\x1b[B");
  afterEditing.component.handleInput("\x1b[B");
  afterEditing.component.handleInput("\t");
  replacePromptInput(afterEditing, "*.example.test");
  afterEditing.component.handleInput("\r");
  let editSettled = false;
  void afterEditing.result.then(() => (editSettled = true));
  await Promise.resolve();
  assert.equal(editSettled, false);
  afterEditing.component.handleInput("\r");
  assert.deepEqual(await afterEditing.result, {
    action: "project",
    value: "*.example.test",
  });
});

test("a prompt that never opens emits no attention after its deadline", async () => {
  let attention = 0;
  const pi = { events: { emit: () => (attention += 1) } } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/workspace",
    hasUI: true,
    ui: {
      custom: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return undefined;
      },
    },
  } as unknown as ExtensionContext;
  assert.deepEqual(await showPermissionPrompt(pi, ctx, "Blocked", "original", () => null, 0.001), {
    action: "abort",
    value: "original",
  });
  assert.equal(attention, 0);
});

test("attention is emitted once for a real prompt, while no-UI aborts without attention", async () => {
  const prompt = openInteractivePrompt((pi, ctx) =>
    showPermissionPrompt(pi, ctx, "Blocked", "example.test", () => null),
  );
  prompt.component.handleInput("s");
  await prompt.result;
  assert.equal(prompt.attention(), 1);

  let attention = 0;
  let customCalls = 0;
  const pi = { events: { emit: () => (attention += 1) } } as unknown as ExtensionAPI;
  const ctx = {
    cwd: "/workspace",
    hasUI: false,
    ui: { custom: () => (customCalls += 1) },
  } as unknown as ExtensionContext;
  assert.deepEqual(await showPermissionPrompt(pi, ctx, "Blocked", "original", () => null), {
    action: "abort",
    value: "original",
  });
  assert.equal(attention, 0);
  assert.equal(customCalls, 0);
});
