export interface RepropackContext {
  platform: string;
  arch: string;
  node: string;
  repository: null | { head: string | null; branch: string | null; dirty: boolean; trackedChanges: number; trackedDiffSha256: string | null; cwdRelative: string };
  lockfiles: Record<string, string>;
  runtime: null | { tool: string; version: string | null };
}
export interface CommandRun {
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}
export interface Bundle {
  format: 'repropack/v1';
  id: string;
  createdAt: string;
  command: { argv: string[]; redacted: boolean };
  context: RepropackContext;
  run: CommandRun;
  patch?: string;
  integrity: { algorithm: 'sha256'; digest: string };
}
export interface RunOptions {
  argv: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  echo?: boolean;
}
export interface RecordOptions extends RunOptions {
  output: string;
  overwrite?: boolean;
  includePatch?: boolean;
}
export interface ReplayOptions extends Omit<RunOptions, 'argv'> {
  file: string;
  argv?: string[];
  strictOutput?: boolean;
  force?: boolean;
  isolated?: boolean;
}
export class RepropackError extends Error {}
export function recordCommand(options: RecordOptions): Promise<{ bundle: Bundle; file: string }>;
export function readBundle(file: string): Promise<Bundle>;
export function replayBundle(options: ReplayOptions): Promise<
  | { status: 'blocked'; reasons: string[]; bundle: Bundle }
  | { status: 'reproduced' | 'different'; drift: string[]; exitMatches: boolean; outputMatches: boolean; run: CommandRun; bundle: Bundle }
>;
export function createReport(bundle: Bundle): string;
export function compareBundles(before: Bundle, after: Bundle): Array<{ field: string; before: unknown; after: unknown }>;
export function collectContext(cwd: string, argv?: string[]): Promise<RepropackContext>;
export function compareContext(recorded: RepropackContext, current: RepropackContext): string[];
export function createRedactor(env?: Record<string, string | undefined>): (input: string) => string;
export function redactCommand(argv: string[]): { argv: string[]; redacted: boolean };
export function runCommand(argv: string[], options?: Omit<RunOptions, 'argv'>): Promise<CommandRun>;
