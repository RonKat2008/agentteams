import * as clack from '@clack/prompts';

/** Thrown when the user cancels a prompt (Ctrl+C or Esc); the menu turns it into "Cancelled." and exit code 0. */
export class CancelledError extends Error {
  constructor() { super('Cancelled.'); }
}

export interface Choice<T extends string> { value: T; label: string; hint?: string; disabled?: boolean }

/** Every prompt and message the menu uses, so tests can script answers instead of driving a terminal. */
export interface Prompter {
  intro: (title: string) => void;
  outro: (message: string) => void;
  cancelled: () => void;
  select: <T extends string>(message: string, choices: Choice<T>[], initial?: T) => Promise<T>;
  text: (message: string, opts?: { placeholder?: string; validate?: (v: string) => string | undefined }) => Promise<string>;
  confirm: (message: string, initial?: boolean) => Promise<boolean>;
  box: (body: string, title: string) => void;
  info: (message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  /** A plain output line from a command, drawn inside the menu's left rail. */
  line: (text: string) => void;
}

function unwrap<T>(value: T): Exclude<T, symbol> {
  if (clack.isCancel(value)) throw new CancelledError();
  return value as Exclude<T, symbol>;
}

export function clackPrompter({ color }: { color: boolean }): Prompter {
  const rail = color ? `\u001b[90m${clack.S_BAR}\u001b[39m` : clack.S_BAR;
  return {
    intro: (title) => clack.intro(title),
    outro: (message) => clack.outro(message),
    cancelled: () => clack.cancel('Cancelled.'),
    select: async (message, choices, initial) => unwrap(await clack.select({
      message, initialValue: initial,
      // clack's Option<T> is a conditional type it cannot resolve for a generic T.
      options: choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint, disabled: c.disabled })) as never,
    })),
    text: async (message, opts = {}) => unwrap(await clack.text({
      message, placeholder: opts.placeholder,
      validate: opts.validate && ((v) => opts.validate!(v ?? '')),
    })).trim(),
    confirm: async (message, initial = false) => unwrap(await clack.confirm({ message, initialValue: initial })),
    box: (body, title) => clack.box(body, title, { width: 'auto', rounded: true }),
    info: (message) => clack.log.info(message),
    success: (message) => clack.log.success(message),
    error: (message) => clack.log.error(message),
    line: (text) => process.stdout.write(`${rail}  ${text}\n`),
  };
}
