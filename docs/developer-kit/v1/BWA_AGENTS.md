# AGENTS.md — Biunivers Workspace Application v1

These instructions apply to AI coding agents working on this BWA repository.

## Delivery contract

- This project ships one OCI container image, not a Static App package or Docker Compose stack.
- Read `BIUNIVERS_WORKSPACE_APPLICATION_PROTOCOL_V1.md` completely and read this repository's README,
  Dockerfile, build workflow, tests, and license before editing.
- Treat the protocol file as frozen: do not rewrite, summarize, translate, or reformat it. It is a
  development input and does not need to be copied into the final image.
- Preserve `io.biunivers.workspace-application.protocol=1` and accurate OCI source/version/license
  labels.
- Serve UI on `0.0.0.0:8080`, expose side-effect-free `GET /health`, persist primary state in
  `/workspace`, and use `/tmp` for temporary files.
- Run as a host-selected non-root UID/GID with a read-only root filesystem and without privileged
  mode, Linux capabilities, host networking, published ports, or Docker socket.

## Boundaries

- Do not invent `biunivers.app.json`, Static App protocol files, parent-window APIs, private Manager
  endpoints, Compose fields, host mounts, or extra privileges.
- Do not access or infer unrelated host files. `/workspace` is the complete persistent filesystem
  view granted to this Instance.
- Never commit or bake passwords, access tokens, private keys, cookies, or production configuration
  into source, labels, image layers, tests, logs, or fixtures.
- Never print injected secrets to HTTP responses, diagnostics, health checks, logs, or Workspace.
- Treat Workspace files, HTTP input, environment variables, filenames, and external responses as
  untrusted input.
- Do not assume a successful file write published a Workspace HEAD. The host owns COW commit,
  conflict, abnormal-Upper, Fork, and lifecycle decisions.

## Implementation workflow

Before editing, inspect repository status and preserve unrelated changes. Identify the real PID 1,
HTTP listener, health path, persistent paths, environment-variable contract, and shutdown behavior.

While editing:

- Keep the smallest coherent single-container design.
- Bind HTTP to `0.0.0.0:8080`; keep browser URLs on the forwarded/current origin.
- Make iframe UI responsive and do not draw duplicate outer window controls.
- Flush application transactions on SIGTERM and exit within the host grace period.
- Put databases and user state under `/workspace`; put rebuildable cache under `/tmp`.
- Provide clear errors for missing configuration without echoing secret values.
- Do not make browser-page lifetime responsible for background-process correctness.

Before completion:

1. Build the exact release image.
2. Inspect OCI labels and RepoDigest.
3. Run as non-root with read-only root, writable `/workspace`, and writable `/tmp`.
4. Verify `/health`, `/`, static assets, iframe sizing, and WebSocket/SSE if used.
5. Verify Workspace persistence across container replacement and application flush on SIGTERM.
6. Scan source, labels, logs, image history, and Workspace output for secrets.
7. Run tests, lint, type checks, vulnerability checks, and the BWA publish checklist.

## Completion report

Report the image repository and tag, immutable digest when published, protocol and OCI labels,
required ordinary and sensitive environment-variable names (never values), persistent paths, tests,
and remaining limitations. Do not claim compatibility until the real image passes runtime, health,
non-root, read-only-root, iframe, Workspace persistence, and shutdown checks.
