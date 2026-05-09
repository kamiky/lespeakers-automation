/**
 * Tiny CLI args parser shared by the automation scripts.
 *
 * Supports flags like `--prod` and key=value like `--country=fr` or `--max=20`.
 */

export type ParsedArgs = Record<string, string | boolean>;

export function parseCliArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const stripped = raw.slice(2);
    const eqIndex = stripped.indexOf('=');
    if (eqIndex === -1) {
      args[stripped] = true;
    } else {
      args[stripped.slice(0, eqIndex)] = stripped.slice(eqIndex + 1);
    }
  }
  return args;
}

export function getStringArg(args: ParsedArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

export function getBoolArg(args: ParsedArgs, key: string): boolean {
  return args[key] === true;
}

export function getIntArg(args: ParsedArgs, key: string): number | undefined {
  const raw = getStringArg(args, key);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${key} value: "${raw}"`);
  }
  return parsed;
}
