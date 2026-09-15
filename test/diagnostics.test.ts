import test from "node:test";

import assert from "node:assert/strict";

import { isGitUpstreamMutationCommand } from "../src/diagnostics.ts";
import {
  gitUpstreamMutationCommands,
  nonGitUpstreamMutationCommands,
} from "./git-upstream-command-fixtures.ts";

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
