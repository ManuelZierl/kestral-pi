# Kestral Pi

Optional headless agent engine for Kestral. It installs as an ordinary app,
holds no Kestral credentials or grants, and sends model and tool requests back
through the host's versioned agent-worker protocol.

This project owns its dependencies, lockfile, tests, build, and package output.
It does not require a Kestral source checkout.

Build and test with **Node.js 22.19.0** and npm 10 or newer. The CI job pins
Node.js 22.19.0; other Node 22 releases are not publication-validation
environments.

```sh
npm ci
npm run check
npm test
```

`npm test` rebuilds `dist/` before running the unit and spawned-worker tests.
Install the resulting `dist` directory through **Apps -> Install an app**.

The package has an unsandboxed native backend. Release builds require the host
process to opt in with `KESTRAL_ALLOW_UNSAFE_NATIVE_BACKENDS=true` before the app
can activate. Kestral grants still mediate every host-routed model and tool call,
but they cannot prevent an unsandboxed native backend from directly reading or
writing the operating system account's files, opening network connections, or
performing other actions allowed to that account. This direct OS authority is
outside Kestral's grant boundary. Install only package bytes you trust.

Chat may pass an exact `tools.allow_capabilities` list to `agent.run`. The host
intersects that list with the calling app's current grants before exposing tools
to the worker. The engine still holds no authority of its own.

The worker rejects input lines over 4 MiB and refuses to emit events over the
host's 2 MiB line limit. Production dependency licenses are generated into
`THIRD-PARTY-NOTICES.txt` and included in the installable package.

The manual lifecycle attestation format and dispatch procedure are documented
in [RELEASE-EVIDENCE.md](RELEASE-EVIDENCE.md). It records the exact package
identity and digest; it does not grant the worker additional authority.

## App-Owned Data

Kestral Pi declares `data: { "kind": "none" }` in its package manifest. The
engine has no app-owned durable database or files. The host-owned `agent`
configuration section, `agent-transcript` artifacts, secrets, and private
surface-state envelopes are distinct host concerns and do not change that
declaration. Worker requests, callback state, and transient transcripts exist
only in invocation-scoped memory. Package and dependency downloads are build or
host activity, not app-owned data retained by the engine.
