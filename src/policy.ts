import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type PolicyDecision = "allow" | "deny" | "prompt";

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

export function domainPatternSpecificity(pattern: string): number {
  const normalized = normalizeDomain(pattern);
  if (normalized === "*") return 0;
  return normalized.replace(/^\*\./, "").split(".").filter(Boolean).length;
}

export function domainMatchesPattern(domain: string, pattern: string): boolean {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedPattern = normalizeDomain(pattern);
  if (!normalizedDomain || !normalizedPattern) return false;
  if (normalizedPattern === "*") return true;
  if (normalizedPattern.startsWith("*.")) {
    const base = normalizedPattern.slice(2);
    return normalizedDomain === base || normalizedDomain.endsWith("." + base);
  }
  return normalizedDomain === normalizedPattern;
}

export function domainSpecificity(domain: string, pattern: string): number | null {
  return domainMatchesPattern(domain, pattern) ? domainPatternSpecificity(pattern) : null;
}

function bestDomainSpecificity(domain: string, patterns: string[]): number | null {
  let best: number | null = null;
  for (const pattern of patterns) {
    const specificity = domainSpecificity(domain, pattern);
    if (specificity !== null && (best === null || specificity > best)) best = specificity;
  }
  return best;
}

export function decideDomainPolicy(
  domain: string,
  allowedDomains: string[],
  deniedDomains: string[] = [],
): PolicyDecision {
  const allowSpecificity = bestDomainSpecificity(domain, allowedDomains);
  const denySpecificity = bestDomainSpecificity(domain, deniedDomains);
  if (allowSpecificity === null && denySpecificity === null) return "prompt";
  if (denySpecificity === null) return "allow";
  if (allowSpecificity === null) return "deny";
  return allowSpecificity > denySpecificity ? "allow" : "deny";
}

export function allowsAllDomains(allowedDomains: string[] | undefined): boolean {
  return allowedDomains?.some((pattern) => normalizeDomain(pattern) === "*") ?? false;
}

export function domainIsAllowed(
  domain: string,
  allowedDomains: string[],
  deniedDomains: string[] = [],
): boolean {
  return decideDomainPolicy(domain, allowedDomains, deniedDomains) === "allow";
}

function expandPath(filePath: string, cwd = process.cwd()): string {
  const expanded = filePath.replace(/^~(?=$|\/)/, homedir());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function canonicalizePath(filePath: string, cwd = process.cwd()): string {
  const absolutePath = expandPath(filePath, cwd);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    const tail: string[] = [];
    let probe = absolutePath;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) return absolutePath;
      tail.unshift(basename(probe));
      probe = parent;
    }
    try {
      return resolve(realpathSync.native(probe), ...tail);
    } catch {
      return absolutePath;
    }
  }
}

function canonicalizeGlob(pattern: string, cwd: string): string {
  const absolutePattern = expandPath(pattern, cwd);
  const wildcardIndex = absolutePattern.search(/[*!?]/);
  if (wildcardIndex < 0) return canonicalizePath(absolutePattern, cwd);

  const slashIndex = absolutePattern.lastIndexOf("/", wildcardIndex);
  if (slashIndex < 0) return absolutePattern;
  const prefix = absolutePattern.slice(0, slashIndex + 1);
  const suffix = absolutePattern.slice(slashIndex + 1);
  return join(canonicalizePath(prefix, cwd), suffix);
}

function canonicalizePattern(pattern: string, cwd: string): string {
  return /[*?!]/.test(pattern) ? canonicalizeGlob(pattern, cwd) : canonicalizePath(pattern, cwd);
}

export function canonicalizePathPattern(pattern: string, cwd = process.cwd()): string {
  return canonicalizePattern(pattern, cwd);
}

export function pathPatternSpecificity(pattern: string, cwd = process.cwd()): number {
  const canonicalPattern = canonicalizePattern(pattern, cwd);
  return canonicalPattern
    .split("/")
    .filter(Boolean)
    .reduce((specificity, segment) => specificity + (/[*?!]/.test(segment) ? 0 : 1), 0);
}

function pathRuleSpecificity(pattern: string, cwd: string): number {
  // Count canonical path components, not characters. This makes
  // /tmp/longsegment/* and /tmp/*/file.txt equally specific: wildcard
  // components carry no weight.
  return pathPatternSpecificity(pattern, cwd);
}

export function pathSpecificity(
  filePath: string,
  pattern: string,
  cwd = process.cwd(),
): number | null {
  return matchesPattern(filePath, [pattern], cwd) ? pathRuleSpecificity(pattern, cwd) : null;
}

function bestPathSpecificity(filePath: string, patterns: string[], cwd: string): number | null {
  let best: number | null = null;
  for (const pattern of patterns) {
    const specificity = pathSpecificity(filePath, pattern, cwd);
    if (specificity !== null && (best === null || specificity > best)) best = specificity;
  }
  return best;
}

export function decidePathPolicy(
  filePath: string,
  allowedPaths: string[],
  deniedPaths: string[] = [],
  cwd = process.cwd(),
): PolicyDecision {
  const allowSpecificity = bestPathSpecificity(filePath, allowedPaths, cwd);
  const denySpecificity = bestPathSpecificity(filePath, deniedPaths, cwd);
  if (allowSpecificity === null && denySpecificity === null) return "prompt";
  if (denySpecificity === null) return "allow";
  if (allowSpecificity === null) return "deny";
  return allowSpecificity > denySpecificity ? "allow" : "deny";
}

export function decideWritePolicy(
  path: string,
  allowWrite: string[],
  denyWrite: string[],
  cwd = process.cwd(),
): PolicyDecision {
  return decidePathPolicy(path, allowWrite, denyWrite, cwd);
}

export async function resolveWritePermission({
  path,
  allowWrite,
  denyWrite,
  cwd = process.cwd(),
  prompt,
  saveWritePermission,
}: {
  path: string;
  allowWrite: string[];
  denyWrite: string[];
  cwd?: string;
  prompt: (path: string) => Promise<{
    action: "abort" | "session" | "project" | "global";
    value: string;
  }>;
  saveWritePermission: (
    choice: "session" | "project" | "global",
    value: string,
  ) => Promise<void | boolean>;
}) {
  const policy = decideWritePolicy(path, allowWrite, denyWrite, cwd);
  if (policy !== "prompt") return { action: policy };

  const choice = await prompt(path);
  if (choice.action === "abort") return { action: "abort", value: choice.value };

  const saved = await saveWritePermission(choice.action, choice.value);
  if (saved === false) return { action: "blocked", value: choice.value };
  return { action: "granted", value: choice.value };
}

type ShellToken = { value: string; quoted: boolean };

function shellSegments(command: string): string[][] {
  const segments: string[][] = [];
  let segment: ShellToken[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let tokenQuoted = false;
  let escaped = false;

  const finishToken = () => {
    if (!token) return;
    segment.push({ value: token, quoted: tokenQuoted });
    token = "";
    tokenQuoted = false;
  };
  const finishSegment = () => {
    finishToken();
    if (segment.length > 0) segments.push(segment.map(({ value }) => value));
    segment = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      tokenQuoted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenQuoted = true;
      continue;
    }
    if (character === ";" || character === "\n" || character === "|" || character === "&") {
      finishSegment();
      if ((character === "|" || character === "&") && next === character) index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      finishToken();
      continue;
    }
    token += character;
  }
  finishSegment();
  return segments;
}

function commandName(segment: string[]): { name: string; args: string[] } | null {
  let index = 0;
  while (index < segment.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[index])) index += 1;
  while (index < segment.length && ["sudo", "command", "env"].includes(segment[index])) index += 1;
  if (index >= segment.length) return null;
  const name = segment[index].split("/").pop() ?? segment[index];
  return { name: name.toLowerCase(), args: segment.slice(index + 1) };
}

function domainFromUrl(value: string): string | null {
  const candidate = value.replace(/^[([{<]+|[),;]}>'"]+$/g, "");
  if (!/^(?:https?|ssh):\/\//i.test(candidate)) return null;
  try {
    const hostname = new URL(candidate).hostname;
    return hostname ? normalizeDomain(hostname.replace(/^\[|\]$/g, "")) : null;
  } catch {
    return null;
  }
}

function domainFromScpTarget(value: string): string | null {
  const candidate = value.replace(/^[([{<]+|[),;]}>'"]+$/g, "");
  if (candidate.includes("://")) return null;
  const match = candidate.match(/^(?:[^@/:\s]+@)?([A-Za-z][A-Za-z0-9.-]*):(?:[^/\s]|\/)/);
  return match ? normalizeDomain(match[1]) : null;
}

const gitGlobalOptionsWithValues = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--shallow-file",
  "--attr-source",
  "--config-env",
]);

const gitGlobalFlags = new Set([
  "--bare",
  "--no-replace-objects",
  "--no-optional-locks",
  "--no-lazy-fetch",
  "--no-advice",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--paginate",
  "--no-pager",
  "--exec-path",
  "--html-path",
  "--man-path",
  "--info-path",
  "--version",
  "--help",
  "-h",
  "-v",
  "-p",
  "-P",
]);

function isGitCommand(
  name: string,
  args: string[],
  networkCommands: string[],
): { index: number; operation: string; uncertain?: boolean } | null {
  if (name !== "git") return null;
  let uncertain = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      const operation = args[index + 1];
      return operation && networkCommands.includes(operation)
        ? { index: index + 1, operation }
        : null;
    }
    if (arg === "-C" || arg === "-c" || gitGlobalOptionsWithValues.has(arg)) {
      if (args[index + 1] === undefined) return null;
      index += 1;
      continue;
    }
    if ((arg.startsWith("-C") || arg.startsWith("-c")) && arg.length > 2) continue;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const option = equals < 0 ? arg : arg.slice(0, equals);
      if (gitGlobalOptionsWithValues.has(option) || gitGlobalFlags.has(option)) continue;
      uncertain = true;
    } else if (arg.startsWith("-") && arg !== "-") {
      if (gitGlobalFlags.has(arg)) continue;
      uncertain = true;
    } else {
      return networkCommands.includes(arg) ? { index, operation: arg, uncertain } : null;
    }

    // An unrecognized global option may consume the next word. If a later token
    // resembles a network operation, inspect its remaining arguments conservatively.
    if (uncertain) {
      const candidateIndex = args.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index && networkCommands.includes(candidate),
      );
      return candidateIndex < 0
        ? null
        : { index: candidateIndex, operation: args[candidateIndex], uncertain: true };
    }
  }
  return null;
}

function domainFromSshHost(value: string): string | null {
  const candidate = value.replace(/^[([{<]+|[),;]}>'"]+$/g, "");
  if (candidate.startsWith("-") || candidate.includes("/") || candidate.includes(":")) return null;
  const match = candidate.match(/^(?:[^@/\s]+@)?([A-Za-z][A-Za-z0-9.-]*)$/);
  return match ? normalizeDomain(match[1]) : null;
}

const optionsWithSeparateValues = new Set([
  "-B",
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-i",
  "-J",
  "-L",
  "-l",
  "-o",
  "-P",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

function commandNetworkArguments(args: string[], firstOnly: boolean): string[] {
  const positional: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) {
      if (optionsWithSeparateValues.has(arg)) index += 1;
      continue;
    }
    positional.push(arg);
    if (firstOnly) break;
  }
  return positional;
}

const gitOptionValues: Record<string, Set<string>> = {
  clone: new Set([
    "-b",
    "--branch",
    "-o",
    "--origin",
    "-u",
    "--upload-pack",
    "-c",
    "--config",
    "--reference",
    "--reference-if-able",
    "--separate-git-dir",
    "--depth",
    "--shallow-since",
    "--shallow-exclude",
    "--filter",
    "--server-option",
    "-j",
    "--jobs",
  ]),
  fetch: new Set([
    "-u",
    "--upload-pack",
    "-o",
    "--server-option",
    "--depth",
    "--deepen",
    "--shallow-since",
    "--shallow-exclude",
    "--filter",
    "--negotiation-tip",
    "-j",
    "--jobs",
  ]),
  pull: new Set([
    "-u",
    "--upload-pack",
    "-o",
    "--server-option",
    "--depth",
    "--deepen",
    "--shallow-since",
    "--shallow-exclude",
    "--filter",
  ]),
  push: new Set(["--repo", "--receive-pack", "-e", "--exec", "-o", "--push-option"]),
  "ls-remote": new Set(["-u", "--upload-pack", "-o", "--server-option", "--sort"]),
  remote: new Set(["-t", "--track", "-m", "--master"]),
  submodule: new Set(["-b", "--branch", "--name", "--reference", "--depth", "--filter"]),
};

const gitFlagsWithoutValues = new Set([
  "-l",
  "--local",
  "-s",
  "--shared",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
  "-n",
  "--no-checkout",
  "--bare",
  "--mirror",
  "--no-hardlinks",
  "--no-tags",
  "--single-branch",
  "--no-single-branch",
  "--dissociate",
  "--recurse-submodules",
  "--shallow-submodules",
  "--reject-shallow",
  "--no-reject-shallow",
  "--progress",
  "--no-progress",
  "-p",
  "--prune",
  "-P",
  "--prune-tags",
  "--all",
  "--multiple",
  "--append",
  "--atomic",
  "--dry-run",
  "--force",
  "-f",
  "--keep",
  "-k",
  "--tags",
  "--unshallow",
  "--update-shallow",
  "--write-fetch-head",
  "--no-write-fetch-head",
  "--auto-maintenance",
  "--no-auto-maintenance",
  "--prefetch",
  "--refetch",
  "--no-recurse-submodules",
  "--commit",
  "--no-commit",
  "--edit",
  "--no-edit",
  "--ff",
  "--no-ff",
  "--ff-only",
  "--rebase",
  "--no-rebase",
  "--autostash",
  "--no-autostash",
  "--stat",
  "--no-stat",
  "--squash",
  "--no-squash",
  "--verify",
  "--no-verify",
  "--allow-unrelated-histories",
  "--branches",
  "--follow-tags",
  "--no-follow-tags",
  "--porcelain",
  "--delete",
  "-d",
  "--force-with-lease",
  "--force-if-includes",
  "-u",
  "--set-upstream",
  "--thin",
  "--no-thin",
  "--signed",
  "--no-signed",
  "-t",
  "-h",
  "--heads",
  "--refs",
  "--exit-code",
  "--get-url",
  "--symref",
  "--add",
  "--push",
  "--no-tags",
  "--fetch",
  "--reference-if-able",
]);

function gitPositionals(
  operation: string,
  args: string[],
): { values: string[]; remoteOptions: string[]; uncertain: boolean } {
  const values: string[] = [];
  const remoteOptions: string[] = [];
  const valueOptions = gitOptionValues[operation] ?? new Set<string>();
  const flags = gitFlagsWithoutValues;
  let optionsEnded = false;
  let uncertain = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const option = equals < 0 ? arg : arg.slice(0, equals);
      if (operation === "push" && option === "--repo") {
        if (equals < 0 && args[index + 1] !== undefined) remoteOptions.push(args[++index]);
        else if (equals >= 0) remoteOptions.push(arg.slice(equals + 1));
      } else if (equals < 0 && valueOptions.has(option)) index += 1;
      else if (!valueOptions.has(option) && !flags.has(option)) uncertain = true;
      continue;
    }
    if (!optionsEnded && /^-[^-]/.test(arg)) {
      const option = arg.slice(0, 2);
      if (valueOptions.has(arg)) index += 1;
      else if (valueOptions.has(option) && arg.length > 2) continue;
      else if (!flags.has(arg)) uncertain = true;
      continue;
    }
    values.push(arg);
  }
  return { values, remoteOptions, uncertain };
}

function possibleGitRemoteCandidates(args: string[]): string[] {
  return args.flatMap((arg) => {
    const candidates = [arg];
    const equals = arg.indexOf("=");
    if (arg.startsWith("--") && equals >= 0) candidates.push(arg.slice(equals + 1));
    else if (arg.startsWith("-") && arg.length > 2) {
      candidates.push(arg.slice(2).replace(/^=/, ""));
    }
    return candidates;
  });
}

function gitRemoteArguments(operation: string, args: string[], uncertainGlobal = false): string[] {
  if (uncertainGlobal) return possibleGitRemoteCandidates(args);
  const { values, remoteOptions, uncertain } = gitPositionals(operation, args);
  if (uncertain) {
    // Unknown options can take separate values; inspect all candidates rather than
    // silently skipping a remote when its position is ambiguous.
    return [...remoteOptions, ...possibleGitRemoteCandidates(args)];
  }
  if (operation === "remote") {
    return ["add", "set-url"].includes(values[0]) ? values.slice(2, 3) : [];
  }
  if (operation === "submodule") {
    return values[0] === "add" ? values.slice(1, 2) : [];
  }
  if (remoteOptions.length) return remoteOptions;
  // Network operations take a remote before clone destinations and push refspecs.
  return values.slice(0, 1);
}

export function extractDomainsFromCommand(command: string): string[] {
  const domains = new Set<string>();
  for (const segment of shellSegments(command)) {
    const parsed = commandName(segment);
    if (!parsed) continue;
    const { name, args } = parsed;
    const isHttpClient = ["curl", "wget", "fetch", "http"].includes(name);
    const isSshClient = ["ssh", "scp", "sftp", "rsync"].includes(name);
    const gitNetworkCommands = [
      "clone",
      "fetch",
      "pull",
      "push",
      "remote",
      "ls-remote",
      "submodule",
    ];
    const gitCommand = isGitCommand(name, args, gitNetworkCommands);
    const isGit = gitCommand !== null;
    if (!isHttpClient && !isSshClient && !isGit) continue;

    const gitArgs = isGit ? (gitCommand.uncertain ? args : args.slice(gitCommand.index + 1)) : [];
    const networkArgs = isGit
      ? gitRemoteArguments(gitCommand.operation, gitArgs, gitCommand.uncertain)
      : commandNetworkArguments(args, name === "ssh" || name === "sftp");
    for (const arg of networkArgs) {
      const urlDomain = domainFromUrl(arg);
      if (urlDomain) domains.add(urlDomain);
      if (isSshClient || isGit) {
        const scpDomain = domainFromScpTarget(arg);
        if (scpDomain) domains.add(scpDomain);
        if ((name === "ssh" || name === "sftp") && !scpDomain) {
          const hostDomain = domainFromSshHost(arg);
          if (hostDomain) domains.add(hostDomain);
        }
      }
    }
  }
  return [...domains];
}

export function matchesPattern(filePath: string, patterns: string[], cwd = process.cwd()): boolean {
  const absolutePath = canonicalizePath(filePath, cwd);
  return patterns.some((pattern) => {
    if (typeof pattern !== "string") return false;
    const absolutePattern = canonicalizePattern(pattern, cwd);
    if (/[*?!]/.test(pattern)) {
      const escaped = absolutePattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/[*!?]/g, ".*");
      return new RegExp(`^${escaped}$`).test(absolutePath);
    }
    const separator = absolutePattern.endsWith("/") ? "" : "/";
    return absolutePath === absolutePattern || absolutePath.startsWith(absolutePattern + separator);
  });
}
