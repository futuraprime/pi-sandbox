/**
 * Identify Git commands that mutate branch tracking configuration.
 *
 * This parser is intentionally only a command classifier. It does not execute
 * shell input or attempt to turn Bash into a general Git interface.
 */

type ShellWords = string[];

function shellCommandWords(command: string): ShellWords[] {
  const segments: ShellWords[] = [[]];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const finishWord = (): void => {
    if (word.length > 0) segments.at(-1)?.push(word);
    word = "";
  };
  const finishSegment = (): void => {
    finishWord();
    if (segments.at(-1)?.length === 0 && segments.length > 1) segments.pop();
    segments.push([]);
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];

    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (character === ";" || character === "\n") {
      finishSegment();
      continue;
    }
    if (character === "|" || character === "&") {
      // Redirections such as 2>&1 and >|file are not command separators.
      const previous = command[index - 1];
      if (
        (character === "&" && (previous === ">" || previous === "<" || next === ">")) ||
        (character === "|" && previous === ">")
      ) {
        word += character;
        continue;
      }
      finishSegment();
      if (next === character) index += 1;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      continue;
    }
    word += character;
  }

  if (escaped) word += "\\";
  finishWord();
  if (segments.at(-1)?.length === 0) segments.pop();
  return segments;
}

function trimShellGrouping(word: string): string {
  return word.replace(/^[({]+/, "").replace(/[)}]+$/, "");
}

function executableName(word: string | undefined): string {
  return (
    trimShellGrouping(word ?? "")
      .split("/")
      .pop()
      ?.toLowerCase() ?? ""
  );
}

function skipWrapper(words: ShellWords): number {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;

  while (index < words.length) {
    const executable = executableName(words[index]);
    if (executable === "command" || executable === "exec" || executable === "builtin") {
      index += 1;
      while (index < words.length && words[index]?.startsWith("-")) index += 1;
      continue;
    }
    if (executable === "env") {
      index += 1;
      while (index < words.length) {
        const word = words[index] ?? "";
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
          index += 1;
        } else if (word === "--") {
          index += 1;
          break;
        } else if (
          word === "-C" ||
          word === "--chdir" ||
          word === "-S" ||
          word === "--split-string"
        ) {
          index += 2;
        } else if (word.startsWith("-")) {
          index += 1;
        } else {
          break;
        }
      }
      continue;
    }
    if (executable === "sudo" || executable === "nice" || executable === "time") {
      index += 1;
      // These wrappers' options are not the command being classified. Their
      // common value-taking forms are skipped so a value named "git" cannot
      // be mistaken for the executable.
      while (index < words.length && words[index]?.startsWith("-")) {
        const option = words[index];
        index += 1;
        if (executable === "sudo" && ["-u", "-g", "-h", "-p", "-C"].includes(option)) index += 1;
      }
      continue;
    }
    if (executable === "!") {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

interface GitOperation {
  name: string;
  arguments: string[];
}

function gitOperation(words: ShellWords): GitOperation | null {
  const executableIndex = skipWrapper(words);
  if (executableName(words[executableIndex]) !== "git") return null;

  let operationIndex = executableIndex + 1;
  const optionsWithValues = new Set([
    "-C",
    "-c",
    "--config-env",
    "--exec-path",
    "--git-dir",
    "--namespace",
    "--super-prefix",
    "--work-tree",
  ]);
  while (words[operationIndex]?.startsWith("-")) {
    const option = words[operationIndex];
    if (option === "--") return null;
    operationIndex += optionsWithValues.has(option) ? 2 : 1;
  }

  const name = words[operationIndex];
  return name ? { name: name.toLowerCase(), arguments: words.slice(operationIndex + 1) } : null;
}

function isGitUpstreamOption(word: string): boolean {
  if (
    word === "--set-upstream" ||
    word.startsWith("--set-upstream=") ||
    word === "--set-upstream-to" ||
    word.startsWith("--set-upstream-to=") ||
    word === "--unset-upstream"
  ) {
    return true;
  }

  // Git accepts short-option clusters, for example `git push -vu` and
  // attached values such as `git branch -uorigin/main`.
  return /^-[^-]*u/.test(word);
}

function isTrackingConfigKey(word: string): boolean {
  return /^branch\..+\.(?:remote|merge)$/i.test(word);
}

function isTrackingConfigMutation(arguments_: string[]): boolean {
  const keyIndex = arguments_.findIndex(isTrackingConfigKey);
  if (keyIndex < 0) return false;

  const readOptions = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch"]);
  if (arguments_.some((word) => readOptions.has(word))) return false;

  const mutationOptions = new Set([
    "--add",
    "--replace-all",
    "--unset",
    "--unset-all",
    "--rename-section",
    "set",
    "unset",
  ]);
  if (arguments_.some((word) => mutationOptions.has(word))) return true;

  // `git config key value` is the shorthand for setting a key. A bare key is
  // the query form and must remain available.
  return arguments_.slice(keyIndex + 1).some((word) => word !== "--");
}

function isGitUpstreamMutationSegment(words: ShellWords): boolean {
  const operation = gitOperation(words);
  if (!operation) return false;
  if (operation.name === "branch" || operation.name === "push") {
    return operation.arguments.some(isGitUpstreamOption);
  }
  return operation.name === "config" && isTrackingConfigMutation(operation.arguments);
}

function nestedShellCommand(words: ShellWords): string | null {
  const executableIndex = skipWrapper(words);
  const executable = executableName(words[executableIndex]);
  if (!/^(?:ba|da|k|z)?sh$/.test(executable)) return null;

  for (let index = executableIndex + 1; index < words.length; index += 1) {
    const option = words[index] ?? "";
    if (!option.startsWith("-")) continue;
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(option)) return words[index + 1] ?? null;
  }
  return null;
}

/**
 * Return true when command execution would change Git branch tracking. Quoted
 * prose is tokenized as an argument to its printing command and is therefore
 * not mistaken for an executable Git command.
 */
export function isGitUpstreamMutationCommand(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  return shellCommandWords(command).some((words) => {
    if (isGitUpstreamMutationSegment(words)) return true;
    const nested = nestedShellCommand(words);
    return nested !== null && isGitUpstreamMutationCommand(nested);
  });
}
