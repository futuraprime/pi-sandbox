import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import assert from "node:assert/strict";

import {
  allowsAllDomains,
  canonicalizePath,
  decideDomainPolicy,
  decidePathPolicy,
  decideWritePolicy,
  domainIsAllowed,
  extractDomainsFromCommand,
  matchesPattern,
  resolveWritePermission,
} from "../src/policy.ts";

test("extracts and deduplicates literal HTTP domains", () => {
  assert.deepEqual(
    extractDomainsFromCommand("curl https://api.example.com/a http://api.example.com/b"),
    ["api.example.com"],
  );
});

test("matches exact, wildcard, and all-domain policies", () => {
  assert.equal(domainIsAllowed("github.com", ["github.com"]), true);
  assert.equal(domainIsAllowed("api.github.com", ["*.github.com"]), true);
  assert.equal(domainIsAllowed("notgithub.com", ["*.github.com"]), false);
  assert.equal(allowsAllDomains(["*"]), true);
});

test("extracts HTTP(S), SSH URL, and SCP-like Git domains without output false positives", () => {
  assert.deepEqual(
    extractDomainsFromCommand(
      [
        "curl https://api.example.com/a http://api.example.com/b",
        "git clone ssh://git@git.example.com/team/repo.git",
        "git fetch git@git.example.com:team/repo.git",
        "scp local.txt user@git.example.com:uploads/file.txt",
        'echo "https://ignored.example.com"',
        "printf unrelated.example.com",
      ].join("; "),
    ),
    ["api.example.com", "git.example.com"],
  );
});

test("selects Git remotes after option values without treating destinations or refspecs as hosts", () => {
  assert.deepEqual(
    extractDomainsFromCommand(
      [
        "git push ssh://ehensleigh@127.0.0.1:49274/tmp/remote.git HEAD:refs/heads/main",
        "git push git@git.example.com:team/repo.git +refs/heads/*:refs/heads/*",
        "git push git@git.example.com:team/repo.git :refs/heads/main",
        "git push git@git.example.com:team/repo.git main:release",
        "git clone -b main git@denied.example:team/repo.git checkout",
        "git clone --branch=main --origin upstream git@branch.example:team/repo.git checkout",
        "git clone -o upstream git@origin.example:team/repo.git checkout",
        "git clone git@source.example:team/repo.git git@destination.example:checkout",
        "git push -o ci.skip git@push.example:team/repo.git HEAD:refs/heads/main",
        "git push --push-option=ci.skip git@push-equals.example:team/repo.git HEAD:refs/heads/main",
        "git push --repo git@repo-option.example:team/repo.git HEAD:refs/heads/main",
        "git pull --rebase git@pull.example:team/repo.git",
        "git ls-remote --sort version:refname git@sort.example:team/repo.git",
        "git -C push clone git@cwd-separate.example:team/repo.git",
        "git -C push push git@cwd-push.example:team/repo.git HEAD:main",
        "git -Cpush clone git@cwd-attached.example:team/repo.git",
        "git --git-dir push push git@git-dir-separate.example:team/repo.git HEAD:main",
        "git --git-dir=push push git@git-dir-attached.example:team/repo.git HEAD:main",
        "git --work-tree push pull git@work-tree.example:team/repo.git",
        "git -c core.editor=push clone git@config-value.example:team/repo.git",
        "git --unknown-option push clone git@ambiguous.example:team/repo.git",
        "git clone --unknown=git@ambiguous-value.example:team/repo.git checkout",
      ].join("; "),
    ),
    [
      "127.0.0.1",
      "git.example.com",
      "denied.example",
      "branch.example",
      "origin.example",
      "source.example",
      "push.example",
      "push-equals.example",
      "repo-option.example",
      "pull.example",
      "sort.example",
      "cwd-separate.example",
      "cwd-push.example",
      "cwd-attached.example",
      "git-dir-separate.example",
      "git-dir-attached.example",
      "work-tree.example",
      "config-value.example",
      "ambiguous.example",
      "ambiguous-value.example",
    ],
  );
});

test("uses specificity-aware precedence for domains, including wildcard allows", () => {
  assert.equal(decideDomainPolicy("api.example.com", ["*"], ["api.example.com"]), "deny");
  assert.equal(
    decideDomainPolicy("api.example.com", ["api.example.com"], ["*.example.com"]),
    "allow",
  );
  assert.equal(decideDomainPolicy("api.example.com", ["*.example.com"], ["*.example.com"]), "deny");
  assert.equal(decideDomainPolicy("other.example.com", ["*.example.com"], []), "allow");
  assert.equal(decideDomainPolicy("unmatched.test", [], []), "prompt");
});

test("decides write policy from deny and allow lists", () => {
  assert.equal(decideWritePolicy("/tmp/file", ["/tmp"], ["/tmp/file"]), "deny");
  assert.equal(decideWritePolicy("/tmp/file", ["/tmp"], []), "allow");
  assert.equal(decideWritePolicy("/tmp/file", ["/var"], []), "prompt");
  assert.equal(decideWritePolicy("/tmp/file", [], []), "prompt");
});

test("uses canonical relative paths and specificity-aware filesystem precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-specificity-"));
  const target = join(root, "packages", "widget", "src", "index.ts");
  const equalDepthTarget = join(root, "longsegment", "file.txt");

  assert.equal(
    decidePathPolicy("packages/widget/src/index.ts", ["packages/widget"], [root], root),
    "allow",
  );
  assert.equal(decideWritePolicy(target, [join(root, "packages", "widget")], [root]), "allow");
  assert.equal(
    decideWritePolicy(
      equalDepthTarget,
      [join(root, "longsegment", "*")],
      [join(root, "*", "file.txt")],
    ),
    "deny",
  );
  assert.equal(decideWritePolicy(target, [root], [root]), "deny");
  assert.equal(decidePathPolicy(target, [], [root]), "deny");
  assert.equal(decidePathPolicy(join(root, "outside"), [], []), "prompt");
});

test("hard filesystem denies do not prompt while more-specific allows can override", async () => {
  const calls: string[] = [];
  const prompt = async () => {
    calls.push("prompt");
    return { action: "session" as const, value: "/tmp" };
  };

  assert.equal(decideWritePolicy("/tmp/project/file", ["/tmp/project"], ["/tmp"]), "allow");
  assert.equal(decideWritePolicy("/tmp/project/file", ["/tmp"], ["/tmp"]), "deny");
  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/secret",
      allowWrite: [],
      denyWrite: ["/tmp"],
      prompt,
      saveWritePermission: async () => {
        calls.push("apply");
      },
    }),
    { action: "deny" },
  );
  assert.deepEqual(calls, []);
});

test("hard denies remain prompt-free across direct path and network policy", async () => {
  const root = "/policy-hard-deny";
  assert.equal(decidePathPolicy(join(root, "read.txt"), [], [root], root), "deny");
  assert.equal(decideWritePolicy(join(root, "write.txt"), [], [root], root), "deny");
  assert.equal(decideDomainPolicy("api.example.com", [], ["api.example.com"]), "deny");

  let promptCalls = 0;
  assert.deepEqual(
    await resolveWritePermission({
      path: join(root, "write.txt"),
      allowWrite: [],
      denyWrite: [root],
      cwd: root,
      prompt: async () => {
        promptCalls += 1;
        return { action: "session" as const, value: root };
      },
      saveWritePermission: async () => {
        promptCalls += 1;
      },
    }),
    { action: "deny" },
  );
  assert.equal(promptCalls, 0);
});

test("resolves write permission without prompting for denied or allowed paths", async () => {
  const calls: string[] = [];
  const prompt = async () => {
    calls.push("prompt");
    return { action: "session" as const, value: "/tmp" };
  };
  const apply = async () => {
    calls.push("apply");
  };

  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: ["/tmp"],
      denyWrite: ["/tmp/file"],
      prompt,
      saveWritePermission: apply,
    }),
    { action: "deny" },
  );
  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: ["/tmp"],
      denyWrite: [],
      prompt,
      saveWritePermission: apply,
    }),
    { action: "allow" },
  );
  assert.deepEqual(calls, []);
});

test("resolves write permission prompt choices", async () => {
  const applied: string[] = [];
  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: [],
      denyWrite: [],
      prompt: async () => ({ action: "abort", value: "/tmp/file" }),
      saveWritePermission: async (choice, value) => {
        applied.push(`${choice}:${value}`);
      },
    }),
    { action: "abort", value: "/tmp/file" },
  );
  assert.deepEqual(applied.length, 0);

  assert.deepEqual(
    await resolveWritePermission({
      path: "/tmp/file",
      allowWrite: [],
      denyWrite: [],
      prompt: async () => ({ action: "session", value: "/tmp" }),
      saveWritePermission: async (choice, value) => {
        applied.push(`${choice}:${value}`);
      },
    }),
    { action: "granted", value: "/tmp" },
  );
  assert.deepEqual(applied, ["session:/tmp"]);
});

test("path patterns support directory prefixes and globs", () => {
  const root = canonicalizePath(mkdtempSync(join(tmpdir(), "pi-sandbox-policy-")));
  assert.equal(matchesPattern(join(root, "nested", "file.txt"), [root]), true);
  assert.equal(matchesPattern(join(root, "file.pem"), [join(root, "*.pem")]), true);
  assert.equal(matchesPattern(join(root, "file.txt"), [join(root, "*.pem")]), false);
});

test("canonicalizes symlinks and nonexistent descendants", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-sandbox-canonical-"));
  const real = join(root, "real");
  const link = join(root, "link");
  mkdirSync(real);
  symlinkSync(real, link);
  assert.equal(
    canonicalizePath(join(link, "new", "file")),
    join(canonicalizePath(real), "new", "file"),
  );
});
