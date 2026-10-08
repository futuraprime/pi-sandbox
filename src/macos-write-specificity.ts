import type { SandboxRuntimeConfig } from "@carderne/sandbox-runtime";

import { wrapCommandWithSandboxMacOS } from "@carderne/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import {
  containsGlobChars,
  getDefaultWritePaths,
  globToRegex,
  normalizePathForSandbox,
  removeTrailingGlobSuffix,
} from "@carderne/sandbox-runtime/dist/sandbox/sandbox-utils.js";

import { pathPatternSpecificity } from "./policy.ts";

interface WritePolicyProvenance {
  allowWrite: string[];
  denyWrite: string[];
  ordinaryDenyWrite: string[];
  mandatoryDenyWrite: string[];
}

const provenance = new WeakMap<SandboxRuntimeConfig, WritePolicyProvenance>();
const writeSectionLabel = "; File write\n";
const shellProfilePrefix = "/usr/bin/sandbox-exec -p '";

type ProfileForm = { text: string; start: number; end: number };
type Matcher = { expression: string; specificity: number; identity: string };

export function registerMacosWritePolicyProvenance(
  config: SandboxRuntimeConfig,
  ordinaryDenyWrite: string[],
  mandatoryDenyWrite: string[],
): void {
  provenance.set(config, {
    allowWrite: [...(config.filesystem?.allowWrite ?? [])],
    denyWrite: [...(config.filesystem?.denyWrite ?? [])],
    ordinaryDenyWrite: [...ordinaryDenyWrite],
    mandatoryDenyWrite: [...mandatoryDenyWrite],
  });
}

function shellQuotedProfileBounds(command: string): { start: number; end: number } | null {
  const prefixIndex = command.indexOf(shellProfilePrefix);
  if (prefixIndex < 0 || command.indexOf(shellProfilePrefix, prefixIndex + 1) >= 0) return null;

  const start = prefixIndex + shellProfilePrefix.length - 1;
  for (let index = start + 1; index < command.length; index += 1) {
    if (command.startsWith(`'"'"'`, index)) {
      index += 4;
    } else if (command[index] === "'") {
      return command[index + 1] === " " ? { start, end: index } : null;
    }
  }
  return null;
}

function decodeShellQuotedProfile(command: string, bounds: { start: number; end: number }): string {
  return command.slice(bounds.start + 1, bounds.end).replaceAll(`'"'"'`, "'");
}

function shellQuoteProfile(profile: string): string {
  return `'${profile.replaceAll("'", `'"'"'`)}'`;
}

function profileWriteSection(profile: string): { forms: ProfileForm[] } | null {
  const marker = profile.indexOf(writeSectionLabel);
  if (marker < 0 || profile.indexOf(writeSectionLabel, marker + 1) >= 0) return null;
  const start = marker + writeSectionLabel.length;
  const nextSection = profile.indexOf("\n;", start);
  const end = nextSection < 0 ? profile.length : nextSection;
  const section = profile.slice(start, end);
  const forms: ProfileForm[] = [];

  for (let index = 0; index < section.length; ) {
    while (/\s/.test(section[index] ?? "")) index += 1;
    if (index === section.length) break;
    if (section[index] !== "(") return null;

    const formStart = index;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (; index < section.length; index += 1) {
      const character = section[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0) {
        index += 1;
        forms.push({
          text: section.slice(formStart, index),
          start: start + formStart,
          end: start + index,
        });
        break;
      }
    }
    if (depth !== 0 || quoted) return null;
  }
  return { forms };
}

function profileTag(profile: string): string | null {
  return profile.match(/^\(deny default \(with message "([^"]+)"\)\)$/m)?.[1] ?? null;
}

function matcher(pathPattern: string): Matcher {
  const normalized = normalizePathForSandbox(removeTrailingGlobSuffix(pathPattern));
  const isGlob = containsGlobChars(normalized);
  const expression = isGlob
    ? `(regex ${JSON.stringify(globToRegex(normalized))})`
    : `(subpath ${JSON.stringify(normalized)})`;
  const specificity = pathPatternSpecificity(pathPattern);
  return { expression, specificity, identity: `${isGlob ? "regex" : "subpath"}:${normalized}` };
}

function referenceWriteSection(
  config: SandboxRuntimeConfig,
  command: string,
  shell: string,
): { forms: ProfileForm[]; allowCount: number; denyCount: number; tag: string } | null {
  const filesystem = config.filesystem;
  if (!filesystem || filesystem.disabled || !filesystem.allowWrite || !filesystem.denyWrite)
    return null;

  const referenceCommand = wrapCommandWithSandboxMacOS({
    command,
    binShell: shell,
    needsNetworkRestriction: false,
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: false,
    allowMachLookup: [],
    allowPty: false,
    allowBrowserProcess: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
    readConfig: { denyOnly: [], allowWithinDeny: [] },
    writeConfig: {
      allowOnly: [
        ...getDefaultWritePaths(),
        ...filesystem.allowWrite.map(removeTrailingGlobSuffix),
      ],
      denyWithinAllow: filesystem.denyWrite.map(removeTrailingGlobSuffix),
    },
  });
  const bounds = shellQuotedProfileBounds(referenceCommand);
  if (!bounds) return null;
  const profile = decodeShellQuotedProfile(referenceCommand, bounds);
  const section = profileWriteSection(profile);
  const tag = profileTag(profile);
  if (!section || !tag) return null;

  const allowCount = [
    ...getDefaultWritePaths(),
    ...filesystem.allowWrite.map(removeTrailingGlobSuffix),
  ].length;
  const firstMove = section.forms.findIndex(({ text }) =>
    text.startsWith("(deny file-write-unlink"),
  );
  if (firstMove < allowCount) return null;
  return { ...section, allowCount, denyCount: firstMove - allowCount, tag };
}

function withAllowExclusions(form: string, tag: string, exclusions: string[]): string | null {
  const operation = form.match(/^\(deny ([^\s]+)/)?.[1];
  const pathMatcher = form.match(/^\(deny [^\s]+\n  (.+)\n  \(with message /s)?.[1];
  if (!operation || !pathMatcher) return null;
  return `(deny ${operation}\n  (require-all\n    ${pathMatcher}\n${exclusions
    .map((expression) => `    (require-not ${expression})`)
    .join("\n")}\n  )\n  (with message "${tag}"))`;
}

function moveDirectRuleIndexes(
  forms: ProfileForm[],
  moveStart: number,
  denyCount: number,
): number[] | null {
  const indexes: number[] = [];
  let cursor = moveStart;
  for (let group = 0; group < denyCount; group += 1) {
    const unlink = forms[cursor]?.text;
    const create = forms[cursor + 1]?.text;
    if (
      !unlink?.startsWith("(deny file-write-unlink\n  (") ||
      !create?.startsWith("(deny file-write-create\n  (") ||
      unlink.includes("\n  (literal ") ||
      create.includes("\n  (literal ")
    )
      return null;
    indexes.push(cursor, cursor + 1);
    cursor += 2;
    while (
      forms[cursor]?.text.startsWith("(deny file-write-") &&
      forms[cursor]?.text.includes("\n  (literal ")
    ) {
      cursor += 1;
    }
  }
  return cursor === forms.length ? indexes : null;
}

/**
 * Narrow only generated macOS write-deny matchers whose path specificity is
 * lower than an explicit write grant. The pinned runtime generates the guard
 * profile; unknown config, quoting, or profile shapes remain untouched.
 */
export function adaptMacosWriteSpecificityProfile(
  wrappedCommand: string,
  config: SandboxRuntimeConfig | undefined,
  platform: NodeJS.Platform = process.platform,
  command = "printf profile-test",
  shell = "bash",
): string {
  if (platform !== "darwin" || !config || (config.filesystem?.denyWrite?.length ?? 0) === 0)
    return wrappedCommand;
  const origin = provenance.get(config);
  if (!origin || !config.filesystem?.allowWrite || !config.filesystem.denyWrite)
    return wrappedCommand;
  if (
    JSON.stringify(origin.allowWrite) !== JSON.stringify(config.filesystem.allowWrite) ||
    JSON.stringify(origin.denyWrite) !== JSON.stringify(config.filesystem.denyWrite)
  )
    return wrappedCommand;

  try {
    const bounds = shellQuotedProfileBounds(wrappedCommand);
    if (!bounds) return wrappedCommand;
    const profile = decodeShellQuotedProfile(wrappedCommand, bounds);
    const section = profileWriteSection(profile);
    const tag = profileTag(profile);
    if (!section || !tag) return wrappedCommand;

    const reference = referenceWriteSection(config, command, shell);
    if (!reference || tag !== reference.tag || section.forms.length !== reference.forms.length)
      return wrappedCommand;
    if (section.forms.some((form, index) => form.text !== reference.forms[index]?.text))
      return wrappedCommand;

    const allowCount = reference.allowCount;
    const denyCount = reference.denyCount;
    const moveStart = allowCount + denyCount;
    const moveIndexes = moveDirectRuleIndexes(reference.forms, moveStart, denyCount);
    if (!moveIndexes || denyCount < config.filesystem.denyWrite.length) return wrappedCommand;

    const mandatoryMatchers = new Set(
      origin.mandatoryDenyWrite.map((pathPattern) => matcher(pathPattern).identity),
    );
    const ordinaryMatchers = new Set(
      origin.ordinaryDenyWrite.map((pathPattern) => matcher(pathPattern).identity),
    );
    const ordinaryIndices = config.filesystem.denyWrite
      .map((pathPattern, index) => ({ index, identity: matcher(pathPattern).identity }))
      .filter(({ identity }) => ordinaryMatchers.has(identity) && !mandatoryMatchers.has(identity))
      .map(({ index }) => index);
    const allowedMatchers = config.filesystem.allowWrite
      .map(matcher)
      .filter(
        (candidate, index, all) =>
          all.findIndex((other) => other.identity === candidate.identity) === index,
      );
    const replacements = new Map<number, string>();

    for (const index of ordinaryIndices) {
      const denied = matcher(config.filesystem.denyWrite[index]!);
      const exclusions = allowedMatchers
        .filter((allowed) => allowed.specificity > denied.specificity)
        .map(({ expression }) => expression);
      if (exclusions.length === 0) continue;
      const baseIndex = allowCount + index;
      for (const formIndex of [baseIndex, moveIndexes[index * 2]!, moveIndexes[index * 2 + 1]!]) {
        const replacement = withAllowExclusions(reference.forms[formIndex]!.text, tag, exclusions);
        if (!replacement) return wrappedCommand;
        replacements.set(formIndex, replacement);
      }
    }
    if (replacements.size === 0) return wrappedCommand;

    let modifiedProfile = profile;
    for (const [index, replacement] of [...replacements].sort(([left], [right]) => right - left)) {
      const form = section.forms[index]!;
      modifiedProfile = `${modifiedProfile.slice(0, form.start)}${replacement}${modifiedProfile.slice(form.end)}`;
    }
    return `${wrappedCommand.slice(0, bounds.start)}${shellQuoteProfile(modifiedProfile)}${wrappedCommand.slice(bounds.end + 1)}`;
  } catch {
    return wrappedCommand;
  }
}
