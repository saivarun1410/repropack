#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { compareBundles, createReport, readBundle, recordCommand, replayBundle } from '../src/index.js';

const usage = `repropack — portable command-line bug reproductions

Usage:
  repropack record [--out FILE] [--include-patch] [--timeout-ms N] [--max-output-bytes N] [--quiet] -- COMMAND [ARGS...]
  repropack replay FILE [--isolated] [--force] [--strict-output] [--timeout-ms N] [--quiet] [-- COMMAND [ARGS...]]
  repropack inspect FILE [--json]
  repropack verify FILE
  repropack report FILE [--out FILE]
  repropack compare BEFORE.json AFTER.json [--json]

record exits with the captured command's exit code. replay exits 0 when the result
matches, 2 when it differs, or 3 when context drift blocks replay.
`;

function parseOptions(args) {
  const separator = args.indexOf('--');
  const flags = separator < 0 ? args : args.slice(0, separator);
  const command = separator < 0 ? [] : args.slice(separator + 1);
  const options = { positional: [] };
  for (let index = 0; index < flags.length; index++) {
    const item = flags[index];
    if (item === '--out' || item === '--timeout-ms' || item === '--max-output-bytes') {
      if (!flags[index + 1]) throw new Error(`${item} needs a value`);
      options[item.slice(2)] = flags[++index];
    } else if (item === '--quiet' || item === '--force' || item === '--strict-output' || item === '--json' || item === '--include-patch' || item === '--isolated') {
      options[item.slice(2)] = true;
    } else if (item.startsWith('-')) {
      throw new Error(`Unknown option: ${item}`);
    } else {
      options.positional.push(item);
    }
  }
  return { options, command };
}

function positiveInteger(value, name) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  if (!action || ['--help', '-h', 'help'].includes(action)) {
    process.stdout.write(usage);
    return 0;
  }
  const { options, command } = parseOptions(args);
  const timeoutMs = positiveInteger(options['timeout-ms'], '--timeout-ms');
  const maxOutputBytes = positiveInteger(options['max-output-bytes'], '--max-output-bytes');
  if (action === 'compare') {
    if (options.positional.length !== 2) throw new Error('compare needs two bundle files');
    const before = await readBundle(options.positional[0]);
    const after = await readBundle(options.positional[1]);
    const differences = compareBundles(before, after);
    if (options.json) process.stdout.write(`${JSON.stringify(differences, null, 2)}\n`);
    else process.stdout.write(differences.length
      ? `${differences.map((item) => `${item.field}: changed`).join('\n')}\n`
      : 'No compared fields changed.\n');
    return differences.length ? 2 : 0;
  }
  if (action === 'record') {
    if (options.positional.length || !command.length) throw new Error('record needs a command after --');
    const output = options.out || `repropack-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const { bundle, file } = await recordCommand({
      argv: command, output, timeoutMs, maxOutputBytes, echo: !options.quiet,
      includePatch: Boolean(options['include-patch']),
    });
    process.stderr.write(`\nSaved ${file} (exit ${bundle.run.exitCode})\n`);
    return bundle.run.exitCode;
  }
  const file = options.positional[0];
  if (!file || options.positional.length !== 1) throw new Error(`${action} needs exactly one bundle file`);
  if (action === 'replay') {
    const outcome = await replayBundle({
      file, argv: command.length ? command : undefined, timeoutMs, maxOutputBytes,
      force: Boolean(options.force), strictOutput: Boolean(options['strict-output']), echo: !options.quiet,
      isolated: Boolean(options.isolated),
    });
    if (outcome.status === 'blocked') {
      process.stderr.write(`Replay blocked:\n${outcome.reasons.map((reason) => `  - ${reason}`).join('\n')}\n`);
      return 3;
    }
    process.stderr.write(`\n${outcome.status}: exit ${outcome.run.exitCode} (recorded ${outcome.bundle.run.exitCode}); output ${outcome.outputMatches ? 'matches' : 'differs'}\n`);
    return outcome.status === 'reproduced' ? 0 : 2;
  }
  const bundle = await readBundle(file);
  if (action === 'verify') {
    process.stdout.write(`Verified ${basename(file)}: SHA-256 ${bundle.integrity.digest}\n`);
    return 0;
  }
  if (action === 'inspect') {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    } else {
      process.stdout.write([
        `Bundle: ${resolve(file)}`,
        `Captured: ${bundle.createdAt}`,
        `Command: ${bundle.command.argv.map((part) => JSON.stringify(part)).join(' ')}`,
        `Exit: ${bundle.run.exitCode}${bundle.run.timedOut ? ' (timed out)' : ''}`,
        `Git HEAD: ${bundle.context.repository?.head || 'unavailable'}`,
        `Output: ${bundle.run.stdout.length} stdout chars, ${bundle.run.stderr.length} stderr chars`,
        `SHA-256: ${bundle.integrity.digest}`,
      ].join('\n') + '\n');
    }
    return 0;
  }
  if (action === 'report') {
    const report = createReport(bundle);
    if (options.out) {
      await writeFile(options.out, report, { flag: 'wx', mode: 0o600 });
      process.stdout.write(`Saved ${resolve(options.out)}\n`);
    } else {
      process.stdout.write(report);
    }
    return 0;
  }
  throw new Error(`Unknown command: ${action}`);
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  process.stderr.write(`repropack: ${error.message}\n`);
  process.exitCode = 1;
});
