# repropack

Turn a failing command into a portable, reviewable reproduction. `repropack` captures what ran, what failed, and enough project context to tell when a replay is using different code or dependencies. It also generates an issue-ready report and can replay inside a temporary Git worktree.

It is a CLI **and** a Node library. The command can be anything: `npm test`, `pytest`, `go test`, `cargo test`, a build script, or a single executable. No cloud service, API key, or project setup is required.

```sh
npm install -g repropack
repropack record --out failure.json -- npm test
repropack inspect failure.json
repropack replay failure.json
repropack report failure.json --out failure.md
repropack compare previous.json failure.json
```

The `record` command exits with the captured command's exit code, so existing scripts and CI jobs still recognize a failure. `replay` exits `0` when the recorded exit code repeats, `2` when it differs, and `3` when changed project context blocks a reliable comparison.

## What goes into a bundle

A single JSON file contains:

- The command arguments, redacted when they look like credentials.
- Exit code, signal, duration, timeout state, and bounded tails of stdout and stderr.
- Platform, architecture, Node version, and the invoked runtime version when recognized.
- Git commit, branch, count and hash of tracked working-tree changes. It stores **no remote URL**.
- SHA-256 hashes of common lockfiles in the working directory.
- A SHA-256 integrity digest of the bundle contents.

The format is documented in [docs/FORMAT.md](docs/FORMAT.md). `repropack verify failure.json` checks the digest. This detects accidental or deliberate modification of a file after capture; it is not a digital signature or proof of authorship.

## Isolated replay

When the failing command depends on uncommitted tracked changes, explicitly capture a patch:

```sh
repropack record --include-patch --out failure.json -- npm test
repropack replay failure.json --isolated
```

Isolated replay creates a temporary Git worktree at the recorded commit, applies the captured patch, runs the command there, and removes the worktree afterward. Your current checkout stays as it is. A bundle made with `--include-patch` can contain source code and secrets from your diff; inspect it before sharing. Untracked files are not captured. The receiving machine needs the Git commit and dependencies available locally. The command may still access external services or write outside its working directory.

Without `--isolated`, replay runs in the current directory and blocks if Git state, lockfile hashes, platform, architecture, or runtime version differ. `--force` allows a comparison despite drift and reports the differences. Add `--strict-output` to require identical redacted stdout and stderr, in addition to the exit code.

## Privacy and limits

Environment variable **values are never stored as an environment snapshot**. Values of common secret-named variables are replaced in logs when they are at least eight characters long. Credential-looking arguments and common `Bearer` or `token=` text are redacted. If an argument is redacted, replay requires you to provide the command again after `--`:

```sh
repropack replay failure.json -- node script.js --token "$TOKEN"
```

Redaction is a safeguard, not a guarantee. Logs, ordinary arguments, file names, and opt-in patches can contain secrets or personal data that a pattern cannot recognize. Review the bundle and report before sharing. Captured output defaults to the last 100 KB per stream; change it with `--max-output-bytes`. Commands time out after two minutes by default; change that with `--timeout-ms`.

Recording and replaying execute the given command with your current environment and privileges. `repropack` does not install dependencies, recreate containers, capture untracked files, or intercept network traffic. A matching exit code is evidence of the same kind of result, not proof of the same underlying cause; use `--strict-output` and read the report when that distinction matters.

## Library API

```js
import { recordCommand, replayBundle, createReport } from 'repropack';

const { bundle, file } = await recordCommand({
  argv: ['npm', 'test'],
  output: './failure.json',
  timeoutMs: 60_000,
});

console.log(createReport(bundle));
const result = await replayBundle({ file, strictOutput: true });
console.log(result.status); // reproduced, different, or blocked
```

`recordCommand`, `replayBundle`, `readBundle`, `createReport`, `compareBundles`, `collectContext`, `compareContext`, `createRedactor`, `redactCommand`, and `runCommand` are exported with TypeScript declarations.

`compare` shows which fields changed between two verified recordings and exits `2` when it finds differences. This is useful when a command fails intermittently or a CI run starts failing after a dependency change. `--json` prints the full diff for automation.

## Why this exists

Bug reports often omit the exact failing command, code revision, dirty state, runtime, or lockfile versions. That forces the maintainer to spend the first hour reconstructing context. `repropack` makes those details part of the artifact and tells the next developer when their environment has drifted. It takes inspiration from developer workflow projects such as [firstmate](https://github.com/kunchenguid/firstmate) and [no-mistakes](https://github.com/kunchenguid/no-mistakes): a small entry point can own the full path from action to verifiable result. `repropack` applies that idea to bug reproduction.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.
