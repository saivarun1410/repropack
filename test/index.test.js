import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { recordCommand, readBundle, replayBundle, createReport, compareBundles, RepropackError } from '../src/index.js';

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'repropack-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, file: join(cwd, 'bundle.json') };
}

test('captures a failing command, redacts env secrets, and replays it', async (t) => {
  const { cwd, file } = await workspace(t);
  const env = { ...process.env, DEMO_API_KEY: 'private-value-123' };
  const argv = [process.execPath, '-e', 'console.log(process.env.DEMO_API_KEY); console.error("failed"); process.exit(7)'];
  const { bundle } = await recordCommand({ argv, output: file, cwd, env });
  assert.equal(bundle.run.exitCode, 7);
  assert.equal(bundle.run.stdout.includes('private-value-123'), false);
  assert.match(bundle.run.stdout, /REDACTED/);
  const saved = await readBundle(file);
  assert.equal(saved.integrity.digest, bundle.integrity.digest);
  const replay = await replayBundle({ file, cwd, env, strictOutput: true });
  assert.equal(replay.status, 'reproduced');
  assert.equal(replay.exitMatches, true);
  assert.equal(replay.outputMatches, true);
  assert.match(createReport(saved), /Exit code: 7/);
});

test('detects bundle modification and refuses to overwrite by default', async (t) => {
  const { cwd, file } = await workspace(t);
  const argv = [process.execPath, '-e', 'process.exit(0)'];
  await recordCommand({ argv, output: file, cwd });
  await assert.rejects(recordCommand({ argv, output: file, cwd }), /already exists/);
  const modified = JSON.parse(await readFile(file, 'utf8'));
  modified.run.exitCode = 99;
  await writeFile(file, JSON.stringify(modified));
  await assert.rejects(readBundle(file), RepropackError);
});

test('redacted command requires explicit replay command', async (t) => {
  const { cwd, file } = await workspace(t);
  const argv = [process.execPath, '-e', 'process.exit(0)', '--token', 'sensitive-argument'];
  await recordCommand({ argv, output: file, cwd });
  const saved = await readBundle(file);
  assert.equal(saved.command.redacted, true);
  assert.equal((await readFile(file, 'utf8')).includes('sensitive-argument'), false);
  const blocked = await replayBundle({ file, cwd });
  assert.equal(blocked.status, 'blocked');
  const reproduced = await replayBundle({ file, cwd, argv });
  assert.equal(reproduced.status, 'reproduced');
});

test('blocks replay when lockfile changes unless force is provided', async (t) => {
  const { cwd, file } = await workspace(t);
  await writeFile(join(cwd, 'package-lock.json'), '{"version":1}');
  await recordCommand({ argv: [process.execPath, '-e', 'process.exit(1)'], output: file, cwd });
  await writeFile(join(cwd, 'package-lock.json'), '{"version":2}');
  const blocked = await replayBundle({ file, cwd });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reasons.join(' '), /package-lock.json/);
  const forced = await replayBundle({ file, cwd, force: true });
  assert.equal(forced.status, 'reproduced');
});

test('bounds output and records timeout', async (t) => {
  const { cwd, file } = await workspace(t);
  const argv = [process.execPath, '-e', 'process.stdout.write("x".repeat(200)); setTimeout(() => {}, 10000)'];
  const { bundle } = await recordCommand({ argv, output: file, cwd, maxOutputBytes: 30, timeoutMs: 100 });
  assert.equal(bundle.run.exitCode, 124);
  assert.equal(bundle.run.timedOut, true);
  assert.equal(bundle.run.stdout.length, 30);
  assert.equal(bundle.run.stdoutTruncated, true);
});

test('CLI records, inspects, verifies and reports a bundle', async (t) => {
  const { cwd, file } = await workspace(t);
  const cli = join(import.meta.dirname, '..', 'bin', 'repropack.js');
  const command = [cli, 'record', '--out', file, '--quiet', '--', process.execPath, '-e', 'console.error("oops"); process.exit(5)'];
  const captured = spawnSync(process.execPath, command, { cwd, encoding: 'utf8' });
  assert.equal(captured.status, 5);
  assert.match(captured.stderr, /Saved/);
  const inspected = spawnSync(process.execPath, [cli, 'inspect', file], { cwd, encoding: 'utf8' });
  assert.equal(inspected.status, 0);
  assert.match(inspected.stdout, /Exit: 5/);
  const verified = spawnSync(process.execPath, [cli, 'verify', file], { cwd, encoding: 'utf8' });
  assert.equal(verified.status, 0);
  const reported = spawnSync(process.execPath, [cli, 'report', file], { cwd, encoding: 'utf8' });
  assert.match(reported.stdout, /oops/);
  const replayed = spawnSync(process.execPath, [cli, 'replay', file, '--quiet'], { cwd, encoding: 'utf8' });
  assert.equal(replayed.status, 0);
});

test('isolated replay restores recorded Git state without touching the working tree', async (t) => {
  const { cwd, file } = await workspace(t);
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('config', 'user.name', 'Repropack Test');
  git('config', 'user.email', 'test@example.test');
  await writeFile(join(cwd, 'message.txt'), 'before\n');
  git('add', 'message.txt');
  git('commit', '-qm', 'base');
  await writeFile(join(cwd, 'message.txt'), 'after\n');
  const argv = [process.execPath, '-e', 'process.stdout.write(require("fs").readFileSync("message.txt", "utf8")); process.exit(4)'];
  await recordCommand({ argv, output: file, cwd, includePatch: true });
  await writeFile(join(cwd, 'message.txt'), 'local newer change\n');
  const blocked = await replayBundle({ file, cwd });
  assert.equal(blocked.status, 'blocked');
  const replayed = await replayBundle({ file, cwd, isolated: true, strictOutput: true });
  assert.equal(replayed.status, 'reproduced');
  assert.equal(await readFile(join(cwd, 'message.txt'), 'utf8'), 'local newer change\n');
});

test('compares two runs and exposes changed results in the CLI', async (t) => {
  const { cwd, file } = await workspace(t);
  const next = join(cwd, 'next.json');
  await recordCommand({ argv: [process.execPath, '-e', 'console.log("a"); process.exit(1)'], output: file, cwd });
  await recordCommand({ argv: [process.execPath, '-e', 'console.log("b"); process.exit(2)'], output: next, cwd });
  const differences = compareBundles(await readBundle(file), await readBundle(next));
  assert.ok(differences.some((item) => item.field === 'exitCode'));
  assert.ok(differences.some((item) => item.field === 'stdout'));
  const cli = join(import.meta.dirname, '..', 'bin', 'repropack.js');
  const compared = spawnSync(process.execPath, [cli, 'compare', file, next], { cwd, encoding: 'utf8' });
  assert.equal(compared.status, 2);
  assert.match(compared.stdout, /exitCode: changed/);
});
