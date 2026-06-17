import { InputError } from "../runtime/errors.js";

export type CliOptionValue = string | boolean | string[];

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, CliOptionValue>;
}

const normalizeOptionName = (name: string): string => name.replace(/-([a-z])/g, (_, char: string) =>
  char.toUpperCase()
);

const appendOption = (
  options: Record<string, CliOptionValue>,
  key: string,
  value: string | boolean
): void => {
  const existing = options[key];

  if (existing === undefined) {
    options[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    existing.push(String(value));
    return;
  }

  options[key] = [String(existing), String(value)];
};

export const parseArgs = (argv: string[]): ParsedArgs => {
  const positionals: string[] = [];
  const options: Record<string, CliOptionValue> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const raw = arg.slice(2);
    if (!raw) {
      throw new InputError("Empty option name.");
    }

    const equalsIndex = raw.indexOf("=");
    if (equalsIndex >= 0) {
      appendOption(
        options,
        normalizeOptionName(raw.slice(0, equalsIndex)),
        raw.slice(equalsIndex + 1)
      );
      continue;
    }

    const key = normalizeOptionName(raw);
    const next = argv[index + 1];

    if (next && !next.startsWith("--")) {
      appendOption(options, key, next);
      index += 1;
      continue;
    }

    appendOption(options, key, true);
  }

  return {
    positionals,
    options
  };
};

export const getStringOption = (
  options: Record<string, CliOptionValue>,
  key: string
): string | undefined => {
  const value = options[key];

  if (value === undefined || value === false) {
    return undefined;
  }

  if (value === true) {
    throw new InputError(`Option --${key} requires a value.`);
  }

  if (Array.isArray(value)) {
    const last = value.at(-1);
    if (last === undefined) {
      return undefined;
    }
    return last;
  }

  return value;
};

export const getStringListOption = (
  options: Record<string, CliOptionValue>,
  key: string
): string[] => {
  const value = options[key];

  if (value === undefined || value === false) {
    return [];
  }

  if (value === true) {
    throw new InputError(`Option --${key} requires a value.`);
  }

  return Array.isArray(value) ? value : [value];
};

export const getBooleanOption = (
  options: Record<string, CliOptionValue>,
  key: string
): boolean => options[key] === true;

