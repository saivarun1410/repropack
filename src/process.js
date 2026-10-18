import { spawn } from 'node:child_process';

function appendTail(current, chunk, limit) {
  const combined = Buffer.concat([current, chunk]);
  return combined.length > limit ? combined.subarray(combined.length - limit) : combined;
}

export async function runCommand(argv, {
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = 120_000,
  maxOutputBytes = 100_000,
  echo = false,
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== 'string' || !item)) {
    throw new TypeError('argv must be a non-empty array of strings');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new TypeError('maxOutputBytes must be positive');
  const started = performance.now();
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  const child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    stdout = appendTail(stdout, chunk, maxOutputBytes);
    if (echo) process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    stderr = appendTail(stderr, chunk, maxOutputBytes);
    if (echo) process.stderr.write(chunk);
  });
  let killTimer;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killTimer.unref();
  }, timeoutMs);
  timer.unref();
  const outcome = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  return {
    exitCode: timedOut ? 124 : (outcome.code ?? (outcome.error?.code === 'ENOENT' ? 127 : 1)),
    signal: outcome.signal || null,
    timedOut,
    durationMs: Math.round(performance.now() - started),
    stdout: stdout.toString('utf8'),
    stderr: outcome.error ? `${stderr.toString('utf8')}\n${outcome.error.message}`.trim() : stderr.toString('utf8'),
    stdoutTruncated: stdoutBytes > maxOutputBytes,
    stderrTruncated: stderrBytes > maxOutputBytes,
  };
}
