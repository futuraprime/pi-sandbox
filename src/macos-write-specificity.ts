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

interface ReadPolicyProvenance {
  filesystemDisabled: boolean;
  allowRead: string[];
  denyRead: string[];
  credentialFiles: string;
}

const provenance = new WeakMap<SandboxRuntimeConfig, WritePolicyProvenance>();
const readProvenance = new WeakMap<SandboxRuntimeConfig, ReadPolicyProvenance>();
const readSectionLabel = "; File read\n";
const writeSectionLabel = "; File write\n";
const readSpecificityMarker = "; pi-sandbox read specificity";
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

export function registerMacosReadPolicyProvenance(config: SandboxRuntimeConfig): void {
  readProvenance.set(config, {
    filesystemDisabled: config.filesystem?.disabled === true,
    allowRead: [...(config.filesystem?.allowRead ?? [])],
    denyRead: [...(config.filesystem?.denyRead ?? [])],
    credentialFiles: JSON.stringify(config.credentials?.files ?? []),
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

function profileSection(profile: string, label: string): { forms: ProfileForm[] } | null {
  const marker = profile.indexOf(label);
  if (marker < 0 || profile.indexOf(label, marker + 1) >= 0) return null;
  const start = marker + label.length;
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

function profileReadSection(profile: string): { forms: ProfileForm[] } | null {
  return profileSection(profile, readSectionLabel);
}

function profileWriteSection(profile: string): { forms: ProfileForm[] } | null {
  return profileSection(profile, writeSectionLabel);
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

function referenceReadSection(
  config: SandboxRuntimeConfig,
  command: string,
  shell: string,
): { forms: ProfileForm[]; tag: string } | null {
  const filesystem = config.filesystem;
  if (!filesystem || filesystem.disabled || !filesystem.allowRead || !filesystem.denyRead)
    return null;
  if (config.network?.tlsTerminate) return null;

  const credentialFiles = config.credentials?.files ?? [];
  const credentialDenyRead = credentialFiles
    .filter((file) => file.mode === "deny")
    .map((file) => file.path);
  const maskedCredentialFiles = credentialFiles
    .filter((file) => file.mode === "mask")
    .map((file) => file.path);
  const denyOnly = [
    ...new Set([...filesystem.denyRead, ...credentialDenyRead]),
    ...maskedCredentialFiles,
  ].map(removeTrailingGlobSuffix);
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
    readConfig: {
      denyOnly,
      allowWithinDeny: filesystem.allowRead.map(removeTrailingGlobSuffix),
    },
    writeConfig: {
      allowOnly: [
        ...getDefaultWritePaths(),
        ...(filesystem.allowWrite ?? []).map(removeTrailingGlobSuffix),
      ],
      denyWithinAllow: (filesystem.denyWrite ?? []).map(removeTrailingGlobSuffix),
    },
  });
  const bounds = shellQuotedProfileBounds(referenceCommand);
  if (!bounds) return null;
  const profile = decodeShellQuotedProfile(referenceCommand, bounds);
  const section = profileReadSection(profile);
  const tag = profileTag(profile);
  if (!section || !tag) return null;
  return { ...section, tag };
}

function readSpecificityFailure(reason: string): Error {
  return new Error(
    `Sandbox Bash blocked: cannot verify the macOS read profile (${reason}); the stock read profile may allow denied files.`,
  );
}

/**
 * Re-emit generated read denies after all profile grants, excluding only
 * strictly more-specific explicit grants. Directory metadata remains usable
 * for traversal, while file data (including directory listings) stays denied.
 * Credential file denies stay hard.
 */
export function adaptMacosReadSpecificityProfile(
  wrappedCommand: string,
  config: SandboxRuntimeConfig | undefined,
  platform: NodeJS.Platform = process.platform,
  command = "printf profile-test",
  shell = "bash",
): string {
  if (platform !== "darwin") return wrappedCommand;

  const bounds = shellQuotedProfileBounds(wrappedCommand);
  const profile = bounds ? decodeShellQuotedProfile(wrappedCommand, bounds) : undefined;
  const section = profile ? profileReadSection(profile) : null;
  const hasPotentialReadConflict = Boolean(
    section?.forms.some(({ text }) => text.startsWith("(deny file-read*")) &&
    section.forms.some(
      ({ text }) =>
        text.startsWith("(allow file-read*\n  (") ||
        text.startsWith("(allow file-read* file-write*\n  ("),
    ),
  );
  if (!config) {
    if (hasPotentialReadConflict)
      throw readSpecificityFailure("configuration provenance is unavailable");
    return wrappedCommand;
  }

  const origin = readProvenance.get(config);
  const filesystem = config.filesystem;
  if (!origin) {
    const policyRequired =
      !filesystem?.disabled &&
      ((filesystem?.denyRead?.length ?? 0) > 0 || (config.credentials?.files?.length ?? 0) > 0);
    if (policyRequired || hasPotentialReadConflict)
      throw readSpecificityFailure("configuration provenance is unavailable");
    return wrappedCommand;
  }
  if (
    origin.filesystemDisabled !== (filesystem?.disabled === true) ||
    JSON.stringify(origin.allowRead) !== JSON.stringify(filesystem?.allowRead ?? []) ||
    JSON.stringify(origin.denyRead) !== JSON.stringify(filesystem?.denyRead ?? []) ||
    origin.credentialFiles !== JSON.stringify(config.credentials?.files ?? [])
  ) {
    throw readSpecificityFailure("registered policy arrays changed");
  }
  if (origin.filesystemDisabled) return wrappedCommand;
  const policyRequired = origin.denyRead.length > 0 || origin.credentialFiles !== "[]";
  if (!policyRequired) return wrappedCommand;
  if (!filesystem?.allowRead || !filesystem.denyRead || config.network?.tlsTerminate) {
    throw readSpecificityFailure("unsupported runtime configuration");
  }
  if (!bounds || !profile || !section)
    throw readSpecificityFailure("generated profile shape is unsupported");

  const tag = profileTag(profile);
  const reference = referenceReadSection(config, command, shell);
  if (
    !tag ||
    !reference ||
    tag !== reference.tag ||
    section.forms.length !== reference.forms.length
  )
    throw readSpecificityFailure("generated read section does not match pinned 0.0.72");

  const hasExistingGuards = profile.includes(readSpecificityMarker);
  if (
    (!hasExistingGuards &&
      section.forms.some((form, index) => form.text !== reference.forms[index]?.text)) ||
    (hasExistingGuards && profile.split(readSpecificityMarker).length !== 2)
  ) {
    throw readSpecificityFailure("generated read section does not match pinned 0.0.72");
  }

  const uniqueMatchers = (patterns: string[]) =>
    patterns
      .map(matcher)
      .filter(
        (candidate, index, all) =>
          all.findIndex((other) => other.identity === candidate.identity) === index,
      );
  const allowedMatchers = uniqueMatchers(filesystem.allowRead);
  const ordinaryDenies = uniqueMatchers(origin.denyRead);
  const credentialDenies = uniqueMatchers(
    (config.credentials?.files ?? []).map((file) => file.path),
  );
  const credentialIdentities = new Set(credentialDenies.map(({ identity }) => identity));
  const ordinaryByExpression = new Map(ordinaryDenies.map((denied) => [denied.expression, denied]));
  const expectedForms = reference.forms.map((form) => ({ ...form }));

  for (const [index, form] of expectedForms.entries()) {
    if (!form.text.startsWith("(deny file-read*\n")) continue;
    const pathMatcher = form.text.match(/^\(deny file-read\*\n  (.+)\n  \(with message /s)?.[1];
    const denied = pathMatcher ? ordinaryByExpression.get(pathMatcher) : undefined;
    if (!denied || credentialIdentities.has(denied.identity)) continue;
    const exclusions = allowedMatchers
      .filter((allowed) => allowed.specificity > denied.specificity)
      .map(({ expression }) => expression);
    if (exclusions.length === 0) continue;
    const guarded = withAllowExclusions(form.text, tag, exclusions);
    if (!guarded) throw readSpecificityFailure("generated deny matcher is unsupported");
    expectedForms[index] = { ...form, text: guarded };
  }

  const finalRules = [
    ...ordinaryDenies.flatMap((denied) => {
      const exclusions = allowedMatchers
        .filter((allowed) => allowed.specificity > denied.specificity)
        .map(({ expression }) => expression);
      const dataExclusions =
        denied.identity === "subpath:/" ? [...exclusions, '(literal "/")'] : exclusions;
      return [
        readGuardRule("file-read*", denied.expression, tag, exclusions, true),
        readGuardRule("file-read-data", denied.expression, tag, dataExclusions),
      ];
    }),
    ...credentialDenies.map(
      (denied) => `(deny file-read*\n  ${denied.expression}\n  (with message "${tag}"))`,
    ),
  ];
  const appended = `\n${readSpecificityMarker}\n${finalRules.join("\n")}`;
  const formsMatchAdapted = expectedForms.every(
    (form, index) => section.forms[index]?.text === form.text,
  );
  if (hasExistingGuards) {
    if (!formsMatchAdapted || !profile.endsWith(appended)) {
      throw readSpecificityFailure("existing downstream guard section was modified");
    }
    return wrappedCommand;
  }

  let modifiedProfile = profile;
  for (const [index, form] of [...expectedForms.entries()].sort(
    ([left], [right]) => right - left,
  )) {
    const originalForm = section.forms[index]!;
    if (form.text !== originalForm.text) {
      modifiedProfile = `${modifiedProfile.slice(0, originalForm.start)}${form.text}${modifiedProfile.slice(originalForm.end)}`;
    }
  }
  modifiedProfile += appended;
  return `${wrappedCommand.slice(0, bounds.start)}${shellQuoteProfile(modifiedProfile)}${wrappedCommand.slice(bounds.end + 1)}`;
}

function readGuardRule(
  operation: string,
  pathExpression: string,
  tag: string,
  exclusions: string[],
  excludeDirectories = false,
): string {
  const constraints = [
    pathExpression,
    ...(excludeDirectories ? ["(require-not (vnode-type DIRECTORY))"] : []),
    ...exclusions.map((expression) => `(require-not ${expression})`),
  ];
  const matcherExpression =
    constraints.length === 1
      ? constraints[0]!
      : `(require-all\n${constraints.map((constraint) => `    ${constraint}`).join("\n")}\n  )`;
  return `(deny ${operation}\n  ${matcherExpression}\n  (with message "${tag}"))`;
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
