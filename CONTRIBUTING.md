# Contributing

Run `npm run check` and `npm run pack:check` before opening a pull request. Tests use Node's built-in test runner, temporary directories, and a temporary Git repository; no network or third-party services are needed.

Keep the bundle format backwards compatible within `repropack/v1`. Changes to redaction, capture bounds, Git worktree cleanup, and replay checks need tests for both the success path and the refusal path. Please describe any privacy implications in the pull request.
