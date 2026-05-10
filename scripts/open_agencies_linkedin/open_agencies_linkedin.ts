/**
 * open_agencies_linkedin.ts
 *
 * EXAMPLES (from `automation/`):
 *   yarn outreach:linkedin --input=./output/scrape_event_agencies_fr_paris_debug.json
 *   yarn outreach:linkedin --input=./output/scrape_event_agencies_fr_paris_debug.json --start=10
 *   yarn outreach:linkedin --input=./output/scrape_event_agencies_fr_paris_debug.json --limit=5
 *   yarn outreach:linkedin --input=./output/scrape_event_agencies_fr_paris_debug.json --force
 *   yarn outreach:linkedin --input=./output/scrape_event_agencies_fr_paris_debug.json --use-default-browser
 *
 * Manual LinkedIn outreach loop (no API). For each agency in the input JSON:
 *   1. Show the agency name + company LinkedIn URL, prompt YES/NO to open it
 *      in the browser. If yes, the URL is launched, then the user is asked:
 *        - did you connect on LinkedIn? (Y/N)
 *        - did you send the first message? (Y/N)
 *   2. Iterate over `employees[]`. For each profile, show name + title +
 *      description + URL, prompt YES/NO to open it, and ask the same two
 *      follow-up questions after opening.
 *
 * The script writes outreach state back into the SAME JSON file after every
 * answer (atomic write), so it is fully resumable: re-running with the same
 * `--input` skips already-handled rows by default.
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
import { loadAgenciesFromJson, writeJson } from '../../src/utils/output.js';

interface RunOptions {
  inputPath: string;
  outputPath: string;
  force: boolean;
  includeSkipped: boolean;
  start: number;
  limit?: number;
  useDefaultBrowser: boolean;
  skipEmployees: boolean;
  skipCompanies: boolean;
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
  console.log(`      LinkedIn  : ${agency.linkedin_company_url ?? '— (none)'}`);
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
}): Promise<AgencyOutcome> {
  const { rl, agency, idx, total, agencies, opts } = params;
  let changed = false;

  printAgencyHeader(agency, idx, total);

  // --- Company LinkedIn ----------------------------------------------------
  if (opts.skipCompanies) {
    console.log('  [company] --skip-companies set, skipping company prompt.');
  } else if (!agency.linkedin_company_url) {
    console.log('  [company] no linkedin_company_url, nothing to open.');
  } else if (!shouldPrompt(agency.linkedin_outreach_status, opts)) {
    console.log(
      `  [company] already ${agency.linkedin_outreach_status} (use --force or --include-skipped to re-ask).`,
    );
  } else {
    const ans = await askForUrl(rl, agency.linkedin_company_url, 'COMPANY LinkedIn', {
      useDefaultBrowser: opts.useDefaultBrowser,
      allowSkipRest: false,
    });
    if (isQuit(ans)) return { quit: true, changed };
    if (ans !== null) {
      applyAnswersToAgency(agency, ans);
      persist(agencies, opts.outputPath);
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
    persist(agencies, opts.outputPath);
    changed = true;
  }

  return { quit: false, changed };
}

function parseOptions(): RunOptions {
  const args = parseCliArgs(process.argv);
  const inputArg = getStringArg(args, 'input');
  if (!inputArg) {
    throw new Error('Missing required --input=<path-to-agencies.json>');
  }
  const inputPath = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }
  const outputArg = getStringArg(args, 'output');
  const outputPath = outputArg ? path.resolve(process.cwd(), outputArg) : inputPath;

  const startRaw = getIntArg(args, 'start');
  const start = typeof startRaw === 'number' ? Math.max(1, startRaw) - 1 : 0;
  const limit = getIntArg(args, 'limit');

  return {
    inputPath,
    outputPath,
    force: getBoolArg(args, 'force'),
    includeSkipped: getBoolArg(args, 'include-skipped'),
    start,
    limit,
    useDefaultBrowser: getBoolArg(args, 'use-default-browser'),
    skipEmployees: getBoolArg(args, 'no-employees'),
    skipCompanies: getBoolArg(args, 'no-companies'),
  };
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

async function main(): Promise<void> {
  const opts = parseOptions();
  console.log(`[input]  ${opts.inputPath}`);
  if (opts.outputPath !== opts.inputPath) {
    console.log(`[output] ${opts.outputPath}`);
  } else {
    console.log('[output] (in-place — same file as --input)');
  }
  if (opts.force) console.log('[opt]    --force : re-asking already-processed rows');
  if (opts.includeSkipped) console.log('[opt]    --include-skipped : re-asking previously skipped rows');
  if (opts.useDefaultBrowser) console.log('[opt]    --use-default-browser : opening with system default browser');
  if (opts.skipCompanies) console.log('[opt]    --no-companies : skipping company prompts');
  if (opts.skipEmployees) console.log('[opt]    --no-employees : skipping employee prompts');

  const agencies = loadAgenciesFromJson(opts.inputPath);
  console.log(`[load]   ${agencies.length} agency(ies) loaded`);

  const startIdx = Math.min(opts.start, agencies.length);
  const endIdx =
    opts.limit !== undefined
      ? Math.min(agencies.length, startIdx + opts.limit)
      : agencies.length;
  if (startIdx > 0 || endIdx < agencies.length) {
    console.log(`[range]  processing agencies ${startIdx + 1}..${endIdx}`);
  }

  const rl = readline.createInterface({ input, output });

  let quit = false;
  try {
    for (let i = startIdx; i < endIdx; i++) {
      const outcome = await processAgency({
        rl,
        agency: agencies[i],
        idx: i,
        total: agencies.length,
        agencies,
        opts,
      });
      if (outcome.quit) {
        quit = true;
        break;
      }
    }
  } finally {
    rl.close();
  }

  if (quit) {
    console.log('\n[quit] User asked to quit. Progress already persisted.');
  } else {
    console.log('\n[done] Reached end of agency list.');
  }

  // Reload from disk so the summary reflects the just-written state (defensive).
  const finalAgencies = loadAgenciesFromJson(opts.outputPath);
  summarize(finalAgencies);
}

main().catch((err) => {
  console.error('[error]', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
