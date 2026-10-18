# Bundle format: `repropack/v1`

A bundle is UTF-8 JSON. Top-level fields are `format`, `id`, `createdAt`, `command`, `context`, `run`, optional `patch`, and `integrity`.

The `integrity.digest` is SHA-256 over `JSON.stringify(bundleWithoutIntegrity)`, where `bundleWithoutIntegrity` preserves the field insertion order produced by the writer. Format version changes are required for incompatible schema changes.

`command.argv` contains redacted arguments, and `command.redacted` signals that the original arguments cannot be recovered from the bundle. `context` contains platform, architecture, Node version, detected runtime version, Git state, and lockfile hashes. `run` contains the captured process result and bounded text output.

`patch` is present only with `--include-patch`. It is the raw `git diff HEAD --binary` output for tracked changes, capped at 1 MB. It is never automatically redacted because rewriting a patch could make it inapplicable or silently change the reproduction. Review it carefully before sharing.

The digest detects content modification but does not authenticate the author. Consumers should treat bundles as untrusted data and avoid replaying commands from unknown sources. `inspect`, `verify`, and `report` do not run the recorded command.
