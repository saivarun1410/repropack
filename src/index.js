import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { collectContext, compareContext } from './context.js';
import { runCommand } from './process.js';
import { createRedactor, redactCommand } from './redact.js';
import { capturePatch, withIsolatedWorktree } from './isolation.js';
import { RepropackError } from './errors.js';

const FORMAT = 'repropack/v1';

export { RepropackError };

function digest(bundle) {
  const { integrity: _ignored, ...content } = bundle;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function checkBundle(bundle) {
  if (!bundle || bundle.format !== FORMAT || !bundle.command || !Array.isArray(bundle.command.argv) ||
      !bundle.context || !bundle.run || typeof bundle.run.exitCode !== 'number' ||
      typeof bundle.run.stdout !== 'string' || typeof bundle.run.stderr !== 'string' ||
      (bundle.patch !== undefined && typeof bundle.patch !== 'string') ||
      !bundle.integrity || bundle.integrity.algorithm !== 'sha256' ||
      bundle.integrity.digest !== digest(bundle)) {
    throw new RepropackError('Invalid or modified repropack bundle.');
  }
  return bundle;
}

export async function readBundle(file) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new RepropackError('Bundle is not valid JSON.');
    throw error;
  }
  return checkBundle(parsed);
}

async function saveBundle(file, bundle, overwrite) {
  await mkdir(dirname(file), { recursive: true });
  if (!overwrite) {
    try {
      await access(file);
      throw new RepropackError(`Output already exists: ${file}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** Run a command and write a portable, reviewed-first diagnostic bundle. */
export async function recordCommand({
  argv,
  output,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 120_000,
  maxOutputBytes = 100_000,
  echo = false,
  overwrite = false,
  includePatch = false,
} = {}) {
  if (!output) throw new TypeError('output is required');
  if (!Array.isArray(argv) || !argv.length || argv.some((part) => typeof part !== 'string' || !part)) {
    throw new TypeError('argv must be a non-empty array of strings');
  }
  const location = resolve(cwd, output);
  if (!overwrite) {
    try {
      await access(location);
      throw new RepropackError(`Output already exists: ${location}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const context = await collectContext(cwd, argv);
  const patch = includePatch ? await capturePatch(cwd) : undefined;
  const command = redactCommand(argv);
  const redact = createRedactor(env);
  command.argv = command.argv.map(redact);
  if (command.argv.some((part, index) => part !== argv[index])) command.redacted = true;
  const raw = await runCommand(argv, { cwd, env, timeoutMs, maxOutputBytes, echo });
  const bundle = {
    format: FORMAT,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    command,
    context,
    run: { ...raw, stdout: redact(raw.stdout), stderr: redact(raw.stderr) },
  };
  if (patch !== undefined) bundle.patch = patch;
  bundle.integrity = { algorithm: 'sha256', digest: digest(bundle) };
  await saveBundle(location, bundle, overwrite);
  return { bundle, file: location };
}

/** Re-run a recorded command and compare the result with the bundle. */
export async function replayBundle({
  file,
  argv,
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 120_000,
  maxOutputBytes = 100_000,
  strictOutput = false,
  force = false,
  echo = false,
  isolated = false,
} = {}) {
  const bundle = await readBundle(file);
  if (bundle.command.redacted && !argv) {
    return { status: 'blocked', reasons: ['Recorded command contains redacted arguments; pass an explicit command after --.'], bundle };
  }
  const command = argv || bundle.command.argv;
  async function execute(location) {
    const current = await collectContext(location, command);
    const drift = compareContext(bundle.context, current);
    if (drift.length && !force) return { status: 'blocked', reasons: drift, bundle };
    const raw = await runCommand(command, { cwd: location, env, timeoutMs, maxOutputBytes, echo });
    const redact = createRedactor(env);
    const run = { ...raw, stdout: redact(raw.stdout), stderr: redact(raw.stderr) };
    const exitMatches = run.exitCode === bundle.run.exitCode;
    const outputMatches = run.stdout === bundle.run.stdout && run.stderr === bundle.run.stderr;
    return {
      status: exitMatches && (!strictOutput || outputMatches) ? 'reproduced' : 'different',
      drift,
      exitMatches,
      outputMatches,
      run,
      bundle,
    };
  }
  return isolated ? withIsolatedWorktree(bundle, cwd, execute) : execute(cwd);
}

/** Compare two verified recordings to narrow down an intermittent failure. */
export function compareBundles(before, after) {
  checkBundle(before);
  checkBundle(after);
  const differences = [];
  const changed = (field, left, right) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) differences.push({ field, before: left, after: right });
  };
  changed('command', before.command.argv, after.command.argv);
  changed('exitCode', before.run.exitCode, after.run.exitCode);
  changed('timedOut', before.run.timedOut, after.run.timedOut);
  changed('stdout', before.run.stdout, after.run.stdout);
  changed('stderr', before.run.stderr, after.run.stderr);
  changed('gitHead', before.context.repository?.head, after.context.repository?.head);
  changed('trackedDiff', before.context.repository?.trackedDiffSha256, after.context.repository?.trackedDiffSha256);
  changed('runtime', before.context.runtime, after.context.runtime);
  changed('lockfiles', before.context.lockfiles, after.context.lockfiles);
  changed('patch', before.patch, after.patch);
  return differences;
}

function fence(value) {
  const longest = Math.max(3, ...[...value.matchAll(/`+/g)].map(([run]) => run.length + 1));
  return '`'.repeat(longest);
}

/** Generate a Markdown bug report from a verified bundle. */
export function createReport(bundle) {
  checkBundle(bundle);
  const command = bundle.command.argv.map((part) => JSON.stringify(part)).join(' ');
  const output = [
    '# Reproduction report',
    '',
    `Captured: ${bundle.createdAt}`,
    `Command: ${command}`,
    `Exit code: ${bundle.run.exitCode}${bundle.run.timedOut ? ' (timed out)' : ''}`,
    `Duration: ${bundle.run.durationMs} ms`,
    '',
    '## Environment',
    '',
    `- Platform: ${bundle.context.platform}/${bundle.context.arch}`,
    `- Node: ${bundle.context.node}`,
    `- Command runtime: ${bundle.context.runtime ? `${bundle.context.runtime.tool} ${bundle.context.runtime.version || '(version unavailable)'}` : 'not detected'}`,
    `- Git HEAD: ${bundle.context.repository?.head || 'unavailable'}`,
    `- Tracked changes: ${bundle.context.repository?.trackedChanges ?? 'unavailable'}`,
    `- Lockfiles: ${Object.keys(bundle.context.lockfiles).join(', ') || 'none in working directory'}`,
    '',
  ];
  for (const [name, value, truncated] of [
    ['stdout', bundle.run.stdout, bundle.run.stdoutTruncated],
    ['stderr', bundle.run.stderr, bundle.run.stderrTruncated],
  ]) {
    output.push(`## ${name}${truncated ? ' (tail; truncated)' : ''}`, '', fence(value), value || '(empty)', fence(value), '');
  }
  output.push('Review this report and its bundle for sensitive or personal data before sharing.', '');
  return output.join('\n');
}

export { collectContext, compareContext, createRedactor, redactCommand, runCommand };
