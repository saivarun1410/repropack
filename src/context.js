import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const LOCKFILES = [
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'uv.lock', 'poetry.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock',
  'composer.lock', 'gradle.lockfile',
];
const VERSION_COMMANDS = {
  node: ['--version'], npm: ['--version'], pnpm: ['--version'], yarn: ['--version'],
  bun: ['--version'], python: ['--version'], python3: ['--version'],
  go: ['version'], java: ['-version'], cargo: ['--version'], rustc: ['--version'],
  ruby: ['--version'], php: ['--version'],
};

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 3000, maxBuffer: 2_000_000 });
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

export async function collectContext(cwd, argv) {
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  let repository = null;
  if (root) {
    const [head, branch, porcelain, diff, prefix] = await Promise.all([
      git(cwd, ['rev-parse', 'HEAD']),
      git(cwd, ['branch', '--show-current']),
      git(cwd, ['status', '--porcelain', '--untracked-files=no']),
      git(cwd, ['diff', 'HEAD', '--binary']),
      git(cwd, ['rev-parse', '--show-prefix']),
    ]);
    repository = {
      head,
      branch: branch || null,
      dirty: Boolean(porcelain),
      trackedChanges: porcelain ? porcelain.split('\n').length : 0,
      trackedDiffSha256: diff === null ? null : createHash('sha256').update(diff).digest('hex'),
      cwdRelative: prefix || '',
    };
  }
  const lockfiles = {};
  for (const name of LOCKFILES) {
    try {
      const content = await readFile(join(cwd, name));
      lockfiles[name] = createHash('sha256').update(content).digest('hex');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  let runtime = null;
  const executable = argv?.[0];
  const tool = executable && basename(executable).replace(/\.exe$/i, '');
  if (tool && VERSION_COMMANDS[tool]) {
    try {
      const { stdout, stderr } = await execFileAsync(executable, VERSION_COMMANDS[tool], {
        cwd, timeout: 2000, maxBuffer: 20_000,
      });
      runtime = { tool, version: (stdout || stderr).trim().split('\n')[0] };
    } catch {
      runtime = { tool, version: null };
    }
  }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    repository,
    lockfiles,
    runtime,
  };
}

export function compareContext(recorded, current) {
  const drift = [];
  if (recorded.platform !== current.platform) drift.push(`platform: ${recorded.platform} → ${current.platform}`);
  if (recorded.arch !== current.arch) drift.push(`architecture: ${recorded.arch} → ${current.arch}`);
  if (recorded.node.split('.')[0] !== current.node.split('.')[0]) drift.push(`Node major: ${recorded.node} → ${current.node}`);
  if (recorded.repository?.head && current.repository?.head && recorded.repository.head !== current.repository.head) {
    drift.push(`Git HEAD: ${recorded.repository.head.slice(0, 12)} → ${current.repository.head.slice(0, 12)}`);
  }
  if (Boolean(recorded.repository) !== Boolean(current.repository)) drift.push('Git repository availability changed');
  if (recorded.repository?.trackedDiffSha256 && current.repository?.trackedDiffSha256 &&
      recorded.repository.trackedDiffSha256 !== current.repository.trackedDiffSha256) {
    drift.push('Tracked working-tree changes differ');
  }
  for (const [name, hash] of Object.entries(recorded.lockfiles)) {
    if (current.lockfiles[name] !== hash) drift.push(`${name} changed or missing`);
  }
  if (recorded.runtime?.version && current.runtime?.version && recorded.runtime.version !== current.runtime.version) {
    drift.push(`${recorded.runtime.tool} version: ${recorded.runtime.version} → ${current.runtime.version}`);
  }
  if (recorded.runtime?.tool && current.runtime?.tool && recorded.runtime.tool !== current.runtime.tool) {
    drift.push(`Executable changed: ${recorded.runtime.tool} → ${current.runtime.tool}`);
  }
  return drift;
}
