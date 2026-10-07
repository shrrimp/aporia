/**
 * The learner's test command, turned into an argument vector. It never goes through a shell:
 * no pipes, redirections, `&&`, globbing or variable expansion, so nothing in a lesson can turn
 * into a second command. A learner who needs those puts them in a script and runs the script.
 */
export class CommandError extends Error {
  override readonly name = 'CommandError';
}

/** Where a task's suite goes in the command, e.g. `ctest -R {suite}`. Without it, the whole command runs. */
export const SUITE_PLACEHOLDER = '{suite}';

const SHELL_ONLY = /[|&;<>()$`]/;

/**
 * Split a command line into words, POSIX-style: whitespace separates, '…' is literal, "…" allows
 * \" and \\, and a backslash outside quotes escapes the next character. Characters that only a
 * shell understands are refused outside quotes rather than silently passed on.
 */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else word += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) word += command[++i];
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\') {
      if (i + 1 >= command.length) throw new CommandError('the command ends with a lone backslash');
      word += command[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (SHELL_ONLY.test(ch)) {
      throw new CommandError(
        `"${ch}" only works in a shell, and the test command runs without one. Put the steps in a script and use the script as the test command.`,
      );
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quote) throw new CommandError(`unclosed ${quote} quote in the test command`);
  if (inWord) words.push(word);
  if (words.length === 0) throw new CommandError('the test command is empty');
  return words;
}

/**
 * A suite name from a lesson (written by the tutor) becomes an argument of the learner's own
 * command, so it is held to a narrow shape: a test name or filter, never an option.
 */
export const SUITE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:/*?[\]+=,-]{0,199}$/;

/** The argument vector for one checkpoint: the suite is substituted only where the learner put `{suite}`. */
export function checkpointArgv(command: string, suite: string): string[] {
  const argv = splitCommand(command);
  if (!argv.some((w) => w.includes(SUITE_PLACEHOLDER))) return argv;
  if (!SUITE_PATTERN.test(suite)) {
    throw new CommandError(`the suite "${suite.slice(0, 80)}" is not a plain test name or filter, so it was not passed to your test command`);
  }
  return argv.map((w) => w.replaceAll(SUITE_PLACEHOLDER, suite));
}
