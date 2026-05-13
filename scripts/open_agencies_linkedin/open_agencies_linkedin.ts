/**
 * open_agencies_linkedin.ts
 *
 * EXAMPLES (from `automation/`):
 *   yarn outreach:linkedin --country=fr
 *   yarn outreach:linkedin --country=fr --prod
 *   yarn outreach:linkedin --country=fr --city=paris
 *   yarn outreach:linkedin --country=fr --city=paris --prod --start=10
 *   yarn outreach:linkedin --country=fr --city=paris --limit=5 --force
 *   yarn outreach:linkedin --country=fr --city=paris --employees
 *   yarn outreach:linkedin --country=fr --prod --use-default-browser
 *
 * Resolves JSON the same way as scrape_event_agencies steps: canonical files
 *   output/<debug|prod>/scrape_event_agencies_<country>_<citySlug>.json
 * With `--city` omitted, every matching per-city JSON for that country in the mode
 * folder is processed in sorted filename order.
 *
 * Manual LinkedIn outreach loop (no API). For each agency in the input JSON:
 *   1. Show the agency name + company LinkedIn URL, prompt YES/NO to open it
 *      in the browser. If yes, the URL is launched, then the user is asked:
 *        - did you connect on LinkedIn? (Y/N)
 *        - did you send the first message? (Y/N)
 *   2. By default, employee profile URLs are skipped. Pass `--employees` to also
 *      iterate over `employees[]` with the same prompts and follow-up questions.
 *
 * The script writes outreach state back into the SAME JSON file after every
 * answer (atomic write), so it is fully resumable: re-running with the same
 * country/city/prod skips already-handled rows by default.
 *
 * Fields written (per agency / per employee):
 *   - linkedin_outreach_status : 'opened' | 'skipped'
 *   - linkedin_outreach_at     : ISO timestamp
 *   - linkedin_connected       : boolean (only set after `opened`)
 *   - linkedin_first_message   : boolean (only set after `opened`)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { stdin as input, stdout as output } from 'node:process';

import { type Agency, type AgencyEmployee } from '../../src/types/agency.js';
import {
  getBoolArg,
  getIntArg,
  getStringArg,
  parseCliArgs,
} from '../../src/utils/cli.js';
import {
  OUTPUT_DIR,
  getModeOutputDir,
  loadAgenciesFromJson,
  slugifyCityForFilename,
  writeJson,
  type Mode,
} from '../../src/utils/output.js';

interface RunOptions {
  force: boolean;
  includeSkipped: boolean;
  start: number;
  limit?: number;
  useDefaultBrowser: boolean;
  skipEmployees: boolean;
  skipCompanies: boolean;
}

/** One resolved JSON to read (and usually write back in-place). */
interface OutreachTarget {
  inputPath: string;
  outputPath: string;
}

interface PromptStop {
  reason: 'quit';
}

const QUIT_SENTINEL: PromptStop = { reason: 'quit' };

function isQuit(v: unknown): v is PromptStop {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { reason?: unknown }).reason === 'quit'
  );
}

const SEPARATOR = '─'.repeat(72);
const SUB_SEPARATOR = '·'.repeat(72);

/** Returns the first non-empty string. */
function firstNonEmpty(...vals: Array<string | null | undefined>): string {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return '';
}

/**
 * Open a URL using the system's default mechanism.
 * On macOS uses Google Chrome by default; pass `useDefault=true` to fall back
 * to the user's default browser.
 */
function openUrl(url: string, useDefault: boolean): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === 'darwin') {
    cmd = 'open';
    args = useDefault ? [url] : ['-a', 'Google Chrome', url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = useDefault ? ['/c', 'start', '', url] : ['/c', 'start', 'chrome', url];
  } else {
    cmd = useDefault ? 'xdg-open' : 'google-chrome';
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', (err) => {
      console.warn(`[warn] Could not open URL via "${cmd}": ${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.warn(
      `[warn] Failed to open URL "${url}": ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * LinkedIn company pages open on the People tab (`…/people`) for faster outreach context.
 * Idempotent if `/people` is already present (any case). Preserves query/hash when possible.
 */
function linkedinCompanyPeopleTabUrl(companyUrl: string): string {
  const raw = companyUrl.trim();
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    let path = u.pathname.replace(/\/+$/, '');
    if (/\/people$/i.test(path)) {
      return u.toString();
    }
    u.pathname = `${path}/people`;
    return u.toString();
  } catch {
    const main = raw.match(/^[^?#]*/)?.[0] ?? raw;
    const rest = raw.slice(main.length);
    const base = main.replace(/\/+$/, '');
    if (/\/people$/i.test(base)) return raw;
    return `${base}/people${rest}`;
  }
}

/**
 * Prompt the user with a constrained set of single-letter choices.
 * Returns the lowercased answer (matched against `choices`) or `QUIT_SENTINEL`
 * if the user typed `q`.
 */
async function promptChoice(
  rl: readline.Interface,
  question: string,
  choices: string[],
  defaultChoice?: string,
): Promise<string | PromptStop> {
  const display = choices
    .map((c) => (c === defaultChoice ? c.toUpperCase() : c))
    .join('/');
  const fullPrompt = `${question} [${display}] `;
  for (;;) {
    const raw = await rl.question(fullPrompt);
    const ans = raw.trim().toLowerCase();
    if (!ans && defaultChoice) return defaultChoice;
    if (ans === 'q' && choices.includes('q')) return QUIT_SENTINEL;
    if (choices.includes(ans)) return ans;
    console.log(`  > Please answer one of: ${choices.join(', ')}`);
  }
}

/** Yes/No prompt; defaults to `defaultYes ? 'y' : 'n'`. */
async function promptYesNo(
  rl: readline.Interface,
  question: string,
  defaultYes: boolean,
): Promise<boolean | PromptStop> {
  const ans = await promptChoice(rl, question, ['y', 'n', 'q'], defaultYes ? 'y' : 'n');
  if (isQuit(ans)) return ans;
  return ans === 'y';
}

function nowIso(): string {
  return new Date().toISOString();
}

function persist(agencies: Agency[], outputPath: string): void {
  writeJson(outputPath, agencies);
}

/** Pretty-print the agency header before asking the first question. */
function printAgencyHeader(agency: Agency, idx: number, total: number): void {
  const rank = `${idx + 1}/${total}`;
  const label = firstNonEmpty(agency.company_name, agency.name);
  console.log('');
  console.log(SEPARATOR);
  console.log(`[${rank}] ${label}`);
  if (agency.name && agency.name !== label) {
    console.log(`      Maps name : ${agency.name}`);
  }
  if (agency.city || agency.country_code) {
    console.log(
      `      Location  : ${[agency.city, agency.country_code?.toUpperCase()].filter(Boolean).join(', ')}`,
    );
  }
  if (agency.website) console.log(`      Website   : ${agency.website}`);
  if (agency.phone) console.log(`      Phone     : ${agency.phone}`);
  if (agency.contact_emails && agency.contact_emails.length > 0) {
    console.log(`      Emails    : ${agency.contact_emails.join(', ')}`);
  }
  if (agency.linkedin_company_url) {
    console.log(`      LinkedIn  : ${linkedinCompanyPeopleTabUrl(agency.linkedin_company_url)}`);
  } else {
    console.log(`      LinkedIn  : — (none)`);
  }
  if (agency.linkedin_outreach_status) {
    const flags = [
      `status=${agency.linkedin_outreach_status}`,
      `connected=${formatTriBool(agency.linkedin_connected)}`,
      `1st_msg=${formatTriBool(agency.linkedin_first_message)}`,
    ].join(' · ');
    console.log(`      Previous  : ${flags}`);
  }
  console.log(SEPARATOR);
}

function printEmployeeHeader(
  employee: AgencyEmployee,
  idx: number,
  total: number,
): void {
  const name = firstNonEmpty(employee.name, employee.metadata_title, '(unknown)');
  const role = `[${employee.role_bucket}]`;
  console.log('');
  console.log(SUB_SEPARATOR);
  console.log(`  [employee ${idx + 1}/${total}] ${name}  ${role}`);
  if (employee.job) console.log(`      Title       : ${employee.job}`);
  if (employee.metadata_description) {
    console.log(`      Description : ${employee.metadata_description}`);
  }
  console.log(`      LinkedIn    : ${employee.linkedin_url}`);
  if (employee.linkedin_outreach_status) {
    const flags = [
      `status=${employee.linkedin_outreach_status}`,
      `connected=${formatTriBool(employee.linkedin_connected)}`,
      `1st_msg=${formatTriBool(employee.linkedin_first_message)}`,
    ].join(' · ');
    console.log(`      Previous    : ${flags}`);
  }
  console.log(SUB_SEPARATOR);
}

function formatTriBool(v: boolean | undefined): string {
  if (v === true) return 'Y';
  if (v === false) return 'N';
  return '?';
}

/** Should we (re-)prompt for this row given current flags + CLI options? */
function shouldPrompt(
  status: 'opened' | 'skipped' | undefined,
  opts: { force: boolean; includeSkipped: boolean },
): boolean {
  if (opts.force) return true;
  if (!status) return true;
  if (status === 'skipped' && opts.includeSkipped) return true;
  return false;
}

interface OutreachAnswers {
  status: 'opened' | 'skipped';
  connected?: boolean;
  firstMessage?: boolean;
}

/**
 * Show the open prompt + (if opened) the two follow-up questions, returning
 * the answers. Returns `QUIT_SENTINEL` if the user wants to quit.
 * Returns `null` if the user picks `s` (skip rest of this group).
 */
async function askForUrl(
  rl: readline.Interface,
  url: string,
  label: string,
  opts: { useDefaultBrowser: boolean; allowSkipRest: boolean },
): Promise<OutreachAnswers | null | PromptStop> {
  const choices = opts.allowSkipRest ? ['y', 'n', 's', 'q'] : ['y', 'n', 'q'];
  const choice = await promptChoice(
    rl,
    `Open ${label} in browser?` +
      (opts.allowSkipRest ? ' (s = skip remaining employees of this agency)' : ''),
    choices,
    'y',
  );
  if (isQuit(choice)) return choice;
  if (choice === 's') return null;
  if (choice === 'n') return { status: 'skipped' };

  console.log(`  > opening ${url}`);
  openUrl(url, opts.useDefaultBrowser);

  const connectedAns = await promptYesNo(rl, '  Did you CONNECT on LinkedIn?', false);
  if (isQuit(connectedAns)) return connectedAns;
  const firstMsgAns = await promptYesNo(
    rl,
    '  Did you send the FIRST MESSAGE?',
    false,
  );
  if (isQuit(firstMsgAns)) return firstMsgAns;

  return {
    status: 'opened',
    connected: connectedAns,
    firstMessage: firstMsgAns,
  };
}

function applyAnswersToAgency(agency: Agency, ans: OutreachAnswers): void {
  agency.linkedin_outreach_status = ans.status;
  agency.linkedin_outreach_at = nowIso();
  if (ans.status === 'opened') {
    agency.linkedin_connected = ans.connected ?? false;
    agency.linkedin_first_message = ans.firstMessage ?? false;
  }
}

function applyAnswersToEmployee(employee: AgencyEmployee, ans: OutreachAnswers): void {
  employee.linkedin_outreach_status = ans.status;
  employee.linkedin_outreach_at = nowIso();
  if (ans.status === 'opened') {
    employee.linkedin_connected = ans.connected ?? false;
    employee.linkedin_first_message = ans.firstMessage ?? false;
  }
}

interface AgencyOutcome {
  /** True if user chose to quit during this agency. */
  quit: boolean;
  /** True if any field was modified (and persisted). */
  changed: boolean;
}

async function processAgency(params: {
  rl: readline.Interface;
  agency: Agency;
  idx: number;
  total: number;
  agencies: Agency[];
  opts: RunOptions;
  outputPath: string;
}): Promise<AgencyOutcome> {
  const { rl, agency, idx, total, agencies, opts, outputPath } = params;
  let changed = false;

  printAgencyHeader(agency, idx, total);

  // --- Company LinkedIn ----------------------------------------------------
  if (opts.skipCompanies) {
    console.log('  [company] --no-companies set, skipping company prompt.');
  } else if (!agency.linkedin_company_url) {
    console.log('  [company] no linkedin_company_url, nothing to open.');
  } else if (!shouldPrompt(agency.linkedin_outreach_status, opts)) {
    console.log(
      `  [company] already ${agency.linkedin_outreach_status} (use --force or --include-skipped to re-ask).`,
    );
  } else {
    const companyOpenUrl = linkedinCompanyPeopleTabUrl(agency.linkedin_company_url);
    const ans = await askForUrl(rl, companyOpenUrl, 'COMPANY LinkedIn', {
      useDefaultBrowser: opts.useDefaultBrowser,
      allowSkipRest: false,
    });
    if (isQuit(ans)) return { quit: true, changed };
    if (ans !== null) {
      applyAnswersToAgency(agency, ans);
      persist(agencies, outputPath);
      changed = true;
    }
  }

  // --- Employees -----------------------------------------------------------
  if (opts.skipEmployees) {
    return { quit: false, changed };
  }

  const employees = agency.employees ?? [];
  if (employees.length === 0) {
    console.log('  [employees] none.');
    return { quit: false, changed };
  }

  for (let i = 0; i < employees.length; i++) {
    const employee = employees[i];
    if (!employee.linkedin_url) continue;

    if (!shouldPrompt(employee.linkedin_outreach_status, opts)) {
      console.log(
        `  [employee ${i + 1}/${employees.length}] already ${employee.linkedin_outreach_status} — skipping.`,
      );
      continue;
    }

    printEmployeeHeader(employee, i, employees.length);
    const ans = await askForUrl(rl, employee.linkedin_url, 'EMPLOYEE LinkedIn', {
      useDefaultBrowser: opts.useDefaultBrowser,
      allowSkipRest: true,
    });
    if (isQuit(ans)) return { quit: true, changed };
    if (ans === null) {
      console.log('  > skipping remaining employees of this agency.');
      break;
    }
    applyAnswersToEmployee(employee, ans);
    persist(agencies, outputPath);
    changed = true;
  }

  return { quit: false, changed };
}

const CITY_SLUG_IN_FILENAME = /^[a-z0-9_-]+$/;

/**
 * Per-city canonical pipeline JSONs for a country under `output/<mode>/`
 * (same naming as scrape_event_agencies steps 0–3), sorted by basename.
 */
function listCanonicalCityJsonPaths(modeOutputDir: string, country: string): string[] {
  if (!fs.existsSync(modeOutputDir)) return [];
  const prefix = `scrape_event_agencies_${country}_`;
  const paths: string[] = [];
  for (const name of fs.readdirSync(modeOutputDir)) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('scrape_event_agencies_with_')) continue;
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length, -'.json'.length);
    if (!rest || !CITY_SLUG_IN_FILENAME.test(rest)) continue;
    paths.push(path.join(modeOutputDir, name));
  }
  paths.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return paths;
}

function parseRunFlags(argv: string[]): RunOptions {
  const args = parseCliArgs(argv);
  const startRaw = getIntArg(args, 'start');
  const start = typeof startRaw === 'number' ? Math.max(1, startRaw) - 1 : 0;
  const limit = getIntArg(args, 'limit');

  return {
    force: getBoolArg(args, 'force'),
    includeSkipped: getBoolArg(args, 'include-skipped'),
    start,
    limit,
    useDefaultBrowser: getBoolArg(args, 'use-default-browser'),
    skipEmployees: !getBoolArg(args, 'employees'),
    skipCompanies: getBoolArg(args, 'no-companies'),
  };
}

function resolveOutreachTargets(argv: string[]): {
  targets: OutreachTarget[];
  country: string;
  mode: Mode;
} {
  const args = parseCliArgs(argv);
  if (getStringArg(args, 'input')) {
    throw new Error(
      '`--input` is no longer supported. Use --country=<code> [--city=<name>] [--prod], e.g. --country=fr --city=paris or --country=fr --prod',
    );
  }

  const country = getStringArg(args, 'country')?.toLowerCase();
  if (!country) {
    throw new Error(
      'Missing required --country=<code>. Example: --country=fr --city=paris (or omit --city to process every per-city JSON for that country).',
    );
  }

  const mode: Mode = getBoolArg(args, 'prod') ? 'prod' : 'debug';
  const modeOutputDir = getModeOutputDir(OUTPUT_DIR, mode);
  const cityArg = getStringArg(args, 'city');
  const outputArg = getStringArg(args, 'output');

  let inputPaths: string[];
  if (cityArg) {
    const slug = slugifyCityForFilename(cityArg.trim());
    const single = path.join(modeOutputDir, `scrape_event_agencies_${country}_${slug}.json`);
    if (!fs.existsSync(single)) {
      throw new Error(
        `Expected JSON not found: ${single}\n` +
          `Check --country / --city / --prod, or create the file via the scrape_event_agencies pipeline.`,
      );
    }
    inputPaths = [single];
  } else {
    inputPaths = listCanonicalCityJsonPaths(modeOutputDir, country);
    if (inputPaths.length === 0) {
      throw new Error(
        `No per-city JSON matching scrape_event_agencies_${country}_*.json under ${modeOutputDir}.`,
      );
    }
  }

  if (outputArg && inputPaths.length > 1) {
    throw new Error(
      '`--output` is only allowed with `--city=<name>` (single input file). For multi-city runs, updates are written in-place to each JSON.',
    );
  }

  const resolvedOutput = outputArg ? path.resolve(process.cwd(), outputArg) : undefined;
  const targets: OutreachTarget[] = inputPaths.map((inputPath) => ({
    inputPath,
    outputPath: resolvedOutput ?? inputPath,
  }));

  return { targets, country, mode };
}

function summarize(agencies: Agency[]): void {
  const totalAgencies = agencies.length;
  const companyOpened = agencies.filter((a) => a.linkedin_outreach_status === 'opened').length;
  const companySkipped = agencies.filter((a) => a.linkedin_outreach_status === 'skipped').length;
  const companyConnected = agencies.filter((a) => a.linkedin_connected === true).length;
  const companyMsg = agencies.filter((a) => a.linkedin_first_message === true).length;

  let empTotal = 0;
  let empOpened = 0;
  let empSkipped = 0;
  let empConnected = 0;
  let empMsg = 0;
  for (const a of agencies) {
    for (const e of a.employees ?? []) {
      empTotal += 1;
      if (e.linkedin_outreach_status === 'opened') empOpened += 1;
      if (e.linkedin_outreach_status === 'skipped') empSkipped += 1;
      if (e.linkedin_connected === true) empConnected += 1;
      if (e.linkedin_first_message === true) empMsg += 1;
    }
  }

  console.log('');
  console.log(SEPARATOR);
  console.log('[summary]');
  console.log(
    `  Companies : ${companyOpened} opened · ${companySkipped} skipped · ${companyConnected} connected · ${companyMsg} 1st-msg · / ${totalAgencies} total`,
  );
  console.log(
    `  Employees : ${empOpened} opened · ${empSkipped} skipped · ${empConnected} connected · ${empMsg} 1st-msg · / ${empTotal} total`,
  );
  console.log(SEPARATOR);
}

async function runOutreachOnJson(
  rl: readline.Interface,
  opts: RunOptions,
  target: OutreachTarget,
): Promise<'quit' | 'done'> {
  const { inputPath, outputPath } = target;
  console.log(`[input]  ${inputPath}`);
  if (outputPath !== inputPath) {
    console.log(`[output] ${outputPath}`);
  } else {
    console.log('[output] (in-place — same file as input)');
  }

  const agencies = loadAgenciesFromJson(inputPath);
  console.log(`[load]   ${agencies.length} agency(ies) loaded`);

  const startIdx = Math.min(opts.start, agencies.length);
  const endIdx =
    opts.limit !== undefined
      ? Math.min(agencies.length, startIdx + opts.limit)
      : agencies.length;
  if (startIdx > 0 || endIdx < agencies.length) {
    console.log(`[range]  processing agencies ${startIdx + 1}..${endIdx}`);
  }

  let quit = false;
  for (let i = startIdx; i < endIdx; i++) {
    const outcome = await processAgency({
      rl,
      agency: agencies[i],
      idx: i,
      total: agencies.length,
      agencies,
      opts,
      outputPath,
    });
    if (outcome.quit) {
      quit = true;
      break;
    }
  }

  if (quit) {
    console.log('\n[quit] User asked to quit. Progress already persisted.');
    return 'quit';
  }
  console.log('\n[done] Reached end of agency list for this file.');
  const finalAgencies = loadAgenciesFromJson(outputPath);
  summarize(finalAgencies);
  return 'done';
}

async function main(): Promise<void> {
  const { targets, country, mode } = resolveOutreachTargets(process.argv);
  const opts = parseRunFlags(process.argv);

  console.log(`[country] ${country}`);
  console.log(`[mode]    ${mode}  (${getModeOutputDir(OUTPUT_DIR, mode)})`);
  if (targets.length > 1) {
    console.log(`[files]   ${targets.length} JSON file(s) (sorted):`);
    for (const t of targets) console.log(`          ${t.inputPath}`);
  }
  if (opts.force) console.log('[opt]    --force : re-asking already-processed rows');
  if (opts.includeSkipped) console.log('[opt]    --include-skipped : re-asking previously skipped rows');
  if (opts.useDefaultBrowser) console.log('[opt]    --use-default-browser : opening with system default browser');
  if (opts.skipCompanies) console.log('[opt]    --no-companies : skipping company prompts');
  if (opts.skipEmployees) {
    console.log('[scope]  company LinkedIn only (default); pass --employees to include employee profiles');
  } else {
    console.log('[scope]  company + employee LinkedIn URLs (--employees)');
  }

  if (opts.skipCompanies && opts.skipEmployees) {
    console.warn(
      '[warn] --no-companies with default scope (no --employees): no LinkedIn URLs will be opened.',
    );
  }

  const rl = readline.createInterface({ input, output });

  try {
    for (let fi = 0; fi < targets.length; fi++) {
      const t = targets[fi];
      if (targets.length > 1) {
        console.log('\n' + '='.repeat(72));
        console.log(`[file ${fi + 1}/${targets.length}] ${path.basename(t.inputPath)}`);
        console.log('='.repeat(72));
      }
      const status = await runOutreachOnJson(rl, opts, t);
      if (status === 'quit') break;
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error('[error]', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
