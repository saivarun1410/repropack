import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RepropackError } from './errors.js';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, timeout: 20_000, maxBuffer: 20_000_000 });
}

export async function capturePatch(cwd) {
  try {
    const { stdout } = await git(cwd, ['diff', 'HEAD', '--binary']);
    if (Buffer.byteLength(stdout) > 1_000_000) throw new RepropackError('Tracked patch exceeds 1 MB.');
    return stdout;
  } catch (error) {
    if (error instanceof RepropackError) throw error;
    throw new RepropackError(`Cannot capture Git patch: ${error.message}`);
  }
}

async function applyPatch(cwd, patch) {
  const child = spawn('git', ['apply', '--binary', '-'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  child.stdin.end(patch);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) throw new RepropackError(`Cannot apply captured patch: ${stderr.trim()}`);
}

export async function withIsolatedWorktree(bundle, cwd, callback) {
  if (!bundle.context.repository?.head) throw new RepropackError('Isolated replay requires a Git recording.');
  if (bundle.context.repository.dirty && bundle.patch === undefined) {
    throw new RepropackError('This recording had tracked changes but no patch. Record with --include-patch.');
  }
  const { stdout } = await git(cwd, ['rev-parse', '--show-toplevel']);
  const root = stdout.trim();
  const parent = await mkdtemp(join(tmpdir(), 'repropack-worktree-'));
  const worktree = join(parent, 'repo');
  let attached = false;
  try {
    await git(root, ['worktree', 'add', '--detach', worktree, bundle.context.repository.head]);
    attached = true;
    if (bundle.patch) await applyPatch(worktree, bundle.patch);
    return await callback(join(worktree, bundle.context.repository.cwdRelative || ''));
  } finally {
    let cleanupError;
    if (attached) {
      try {
        await git(root, ['worktree', 'remove', '--force', worktree]);
      } catch (error) {
        cleanupError = error;
      }
    }
    await rm(parent, { recursive: true, force: true });
    if (cleanupError) throw new RepropackError(`Temporary Git worktree cleanup failed: ${cleanupError.message}`);
  }
}
