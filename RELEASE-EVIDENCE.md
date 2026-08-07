# Lifecycle Evidence

This repository publishes format-1 evidence for the external Kestral Pi app.
The evidence is an attestation produced after a real manual Kestral host run.
The workflow validates the attestation and package contract; it does not run
Kestral or Tauri lifecycle tests. Dispatch requires the exact app
`source_commit` and an explicit `tauri_tested: true` manual attestation.

## Package Contract

The generator binds evidence to all of these package declarations:

- App ID `com.ma-zierl.kestral-pi` and the package version in `package.json`.
- Repository `https://github.com/ManuelZierl/kestral-pi` and the clean checked-out source HEAD.
- Canonical Kestral package digest for `dist/`.
- Backend `{ "kind": "agent-worker", "authority_mode": "unsandboxed", "protocol_version": 1, "entry": "backend/worker.mjs" }`.
- Exactly the `agent.run` capability and `agent-transcript` artifact type.
- App data `{ "kind": "none" }`.

An unsafe backend is not treated as a backend-free package. Activation requires
the host's explicit `KESTRAL_ALLOW_UNSAFE_NATIVE_BACKENDS=true` opt-in (or the
equivalent debug/command-line opt-in). The worker has no Kestral credentials or
grants, but its unsandboxed process retains the OS account's direct authority.
That authority is outside Kestral's grant boundary.

## Two-Commit Boundary

Use the clean app source commit that produced `dist/` as the evidence source
commit. The Kestral release record is filled in by a later metadata-only core
commit, so the core commit tested is not changed to record its own hash or
evidence URL. Do not combine those two core commits.

## Manual Observations

Before dispatching **Release evidence**, run the lifecycle checks against the
exact package, lowercase 40-hex app `source_commit`, and exact Kestral host
commit named in the dispatch inputs. Set `tauri_tested` to `true` after the
real Tauri run. Keep the workflow's `observations` input in this exact JSON
shape. Every check is
required, must have `status: "passed"`, and must describe what the retained
run proved:

```json
{
  "tested_at": "2026-08-06T12:00:00Z",
  "platforms": ["windows-x86_64", "linux-x86_64"],
  "lifecycle": {
    "package_inspection": { "status": "passed", "observation": "..." },
    "permission_denial": { "status": "passed", "observation": "..." },
    "activation": { "status": "passed", "observation": "..." },
    "representative_action": { "status": "passed", "observation": "..." },
    "restart": { "status": "passed", "observation": "..." },
    "update_data_preservation": { "status": "passed", "observation": "..." },
    "disable_enable": { "status": "passed", "observation": "..." },
    "keep_data_uninstall": { "status": "passed", "observation": "..." },
    "purge_data_uninstall": { "status": "passed", "observation": "..." }
  }
}
```

The observations must cover:

1. Package inspection reads the manifest and verifies file integrity without executing the worker.
2. A denied `agent.run` invocation is refused and no denied grant appears.
3. Activation is refused without the unsafe-backend opt-in and succeeds after the explicit opt-in.
4. A direct `agent.run` denial followed by approval proves the grant condition and normal action path.
5. Restart reactivates the app and preserves the relevant host-owned run/artifact state.
6. An update preserves the `agent-transcript` artifact and reports that there is no app-owned data to migrate because the package declares `data: none`.
7. Disable stops availability and authority; re-enable starts the worker and permits the approved path again.
8. Keep-data uninstall removes the app and worker; reinstall succeeds and confirms that no app-owned data was retained because the package declares `data: none`.
9. Purge-data uninstall confirms that no app-owned data, package config, or app secret remains. Host-owned ledger/artifact records are separate and must be reported accurately.

The input rejects unknown fields, missing checks, duplicate platforms, malformed
timestamps, failed statuses, and empty observations. `workflow_url` is not an
input: the generator derives it from `GITHUB_SERVER_URL`,
`GITHUB_REPOSITORY`, and `GITHUB_RUN_ID`.

## Dispatch Gates

The workflow checks out Kestral's public schema at pinned commit
`82a983a268911e7a1958b4c6eab06dde334070b1` into `.kestral-contract`. It never
uses a parent-relative schema path. It runs the existing type-check, unit and
worker tests, schema validation, package digest, notices, and reproducibility
checks. It then verifies the clean source HEAD, app ID, version, backend
contract, capability/artifact declarations, no-app-data declaration, expected
canonical digest, and generated evidence shape.

Dispatch with a new `release_tag` matching the workflow's conservative syntax.
The tag must not already exist as either a GitHub release or remote
`refs/tags/<tag>`. Publication creates a new GitHub release and uploads an
asset whose name includes the app version and source commit. The evidence
output is also opened with exclusive-create semantics. Existing releases,
assets, and evidence files are never overwritten. Start the dispatch from a
ref whose `GITHUB_SHA` matches `source_commit`; a mismatch is rejected.

This is honest manual attestation: the workflow validates what was recorded,
but cannot prove that a human actually performed the host lifecycle run.
