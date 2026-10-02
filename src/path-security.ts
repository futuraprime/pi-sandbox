import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { canonicalizePath } from "./policy.ts";

export type VolumeCaseSensitivity = "sensitive" | "insensitive" | "unknown";

export interface CaseProbeFileSystem {
  readdir(path: string): string[];
  realpath(path: string): string;
  stat(path: string): { dev: number | bigint; ino: number | bigint; isDirectory(): boolean };
}

const nativeFileSystem: CaseProbeFileSystem = {
  readdir: (path) => readdirSync(path),
  realpath: (path) => realpathSync.native(path),
  stat: (path) => statSync(path),
};

export function getVolumeCaseSensitivity(
  path: string,
  fileSystem: CaseProbeFileSystem = nativeFileSystem,
): VolumeCaseSensitivity {
  let existingDirectory = resolve(path);
  let directoryStat: ReturnType<CaseProbeFileSystem["stat"]> | undefined;

  while (true) {
    try {
      const stat = fileSystem.stat(existingDirectory);
      if (stat.isDirectory()) {
        directoryStat = stat;
        break;
      }
      const parent = dirname(existingDirectory);
      if (parent === existingDirectory) return "unknown";
      existingDirectory = parent;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") return "unknown";
      const parent = dirname(existingDirectory);
      if (parent === existingDirectory) return "unknown";
      existingDirectory = parent;
    }
  }

  if (!directoryStat) return "unknown";

  let probePath: string | undefined;
  let current = existingDirectory;
  while (true) {
    const parent = dirname(current);
    if (parent === current) break;
    let parentStat: ReturnType<CaseProbeFileSystem["stat"]>;
    try {
      parentStat = fileSystem.stat(parent);
    } catch {
      break;
    }
    if (parentStat.dev !== directoryStat.dev) break;
    if (toggleAsciiCase(basename(current)) !== basename(current)) {
      probePath = current;
      break;
    }
    current = parent;
  }

  if (!probePath) {
    let entries: string[];
    try {
      entries = fileSystem.readdir(existingDirectory);
    } catch {
      return "unknown";
    }
    probePath = entries
      .filter((entry) => toggleAsciiCase(entry) !== entry)
      .map((entry) => join(existingDirectory, entry))
      .find((entry) => {
        try {
          return fileSystem.stat(entry).dev === directoryStat.dev;
        } catch {
          return false;
        }
      });
  }
  if (!probePath) return "unknown";

  const alternatePath = join(dirname(probePath), toggleAsciiCase(basename(probePath)));
  let originalStat: ReturnType<CaseProbeFileSystem["stat"]>;
  let originalRealPath: string;
  try {
    originalStat = fileSystem.stat(probePath);
    originalRealPath = fileSystem.realpath(probePath);
  } catch {
    return "unknown";
  }

  let alternateStat: ReturnType<CaseProbeFileSystem["stat"]>;
  try {
    alternateStat = fileSystem.stat(alternatePath);
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT" || code === "ENOTDIR" ? "sensitive" : "unknown";
  }

  let alternateRealPath: string;
  try {
    alternateRealPath = fileSystem.realpath(alternatePath);
  } catch {
    return "unknown";
  }

  const sameIdentity =
    originalStat.dev === alternateStat.dev &&
    originalStat.ino === alternateStat.ino &&
    String(originalStat.ino) !== "0";
  const sameRealPath = originalRealPath === alternateRealPath;
  if (sameIdentity && sameRealPath) return "insensitive";
  if (!sameIdentity && !sameRealPath) return "sensitive";
  return "unknown";
}

export function pathsEqualConsideringVolumeCase(
  firstPath: string,
  secondPath: string,
  cwd = process.cwd(),
): boolean {
  return pathsEqualConsideringVolumeCaseWithProbe(firstPath, secondPath, nativeFileSystem, cwd);
}

export function traversesProtectedProjectPiDirectory(
  path: string,
  directory: string,
  cwd = process.cwd(),
): boolean {
  return traversesProtectedProjectPiDirectoryWithProbe(path, directory, nativeFileSystem, cwd);
}

export function pathsEqualConsideringVolumeCaseWithProbe(
  firstPath: string,
  secondPath: string,
  fileSystem: CaseProbeFileSystem,
  cwd = process.cwd(),
): boolean {
  const first = canonicalizeSecurityPath(firstPath, cwd);
  const second = canonicalizeSecurityPath(secondPath, cwd);
  if (first === second) return true;
  if (first.toLowerCase() !== second.toLowerCase()) return false;
  return (
    getVolumeCaseSensitivity(first, fileSystem) !== "sensitive" ||
    getVolumeCaseSensitivity(second, fileSystem) !== "sensitive"
  );
}

export function traversesProtectedProjectPiDirectoryWithProbe(
  path: string,
  directory: string,
  fileSystem: CaseProbeFileSystem,
  cwd = process.cwd(),
): boolean {
  const canonicalPath = canonicalizeSecurityPath(path, cwd);
  const canonicalDirectory = canonicalizeSecurityPath(directory, cwd);
  const relativePath = relative(canonicalDirectory, canonicalPath);
  if (isPathWithinDirectory(relativePath)) {
    let current = canonicalDirectory;
    for (const segment of relativePath.split(sep)) {
      current = join(current, segment);
      if (segment === ".pi") return true;
      if (
        segment.toLowerCase() === ".pi" &&
        getVolumeCaseSensitivity(dirname(current), fileSystem) !== "sensitive"
      ) {
        return true;
      }
    }
  }
  return pathTraversesProjectPiDirectory(path, canonicalDirectory, cwd, fileSystem);
}

function pathTraversesProjectPiDirectory(
  filePath: string,
  projectDirectory: string,
  cwd: string,
  fileSystem: CaseProbeFileSystem,
): boolean {
  const expanded = filePath.replace(/^~(?=$|\/)/, homedir());
  const root = isAbsolute(expanded) ? parse(expanded).root : "";
  let current = root || canonicalizePath(cwd, cwd);

  for (const segment of (root ? expanded.slice(root.length) : expanded).split(sep)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }

    if (isPathWithinDirectory(relative(projectDirectory, current))) {
      if (segment === ".pi") return true;
      if (
        segment.toLowerCase() === ".pi" &&
        getVolumeCaseSensitivity(current, fileSystem) !== "sensitive"
      ) {
        return true;
      }
    }

    const next = join(current, segment);
    try {
      current = realpathSync.native(next);
    } catch {
      current = next;
    }
  }
  return false;
}

function isPathWithinDirectory(relativePath: string): boolean {
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function canonicalizeSecurityPath(filePath: string, cwd: string): string {
  const expanded = filePath.replace(/^~(?=$|\/)/, homedir());
  const root = isAbsolute(expanded) ? parse(expanded).root : "";
  let current = root || canonicalizePath(cwd, cwd);
  const segments = (root ? expanded.slice(root.length) : expanded).split(sep);

  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    try {
      current = realpathSync.native(next);
    } catch {
      current = next;
    }
  }
  return current;
}

function toggleAsciiCase(value: string): string {
  const index = value.search(/[a-z]/i);
  if (index < 0) return value;
  const character = value[index];
  const swapped =
    character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
  return value.slice(0, index) + swapped + value.slice(index + 1);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
