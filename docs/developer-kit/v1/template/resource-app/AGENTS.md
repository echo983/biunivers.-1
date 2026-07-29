# AGENTS.md

This repository is a third-party Biunivers static application.

These instructions apply to AI coding agents and other automated contributors working anywhere in
this repository.

When this file is being maintained inside the Biunivers developer-kit source rather than inside a
third-party application repository, treat it as a distributable template and do not apply the
third-party application identity to the Biunivers host repository.

## Delivery contract

- The shipped application is the repository root.
- `index.html` must exist at the repository root and run from an HTTP static server.
- Biunivers does not run `npm install`, a build command, a migration, or an application backend.
- If the project uses a build tool, commit the complete runnable production output to the repository
  root before delivery.
- Keep all packaged asset URLs relative to the application directory.
- Do not assume the application is deployed at an origin root.
- The application runs inside a Biunivers-managed iframe and window.
- Do not draw duplicate outer minimize, maximize, restore, or close controls.

## Files that must not be rewritten

`BIUNIVERS_APP_PROTOCOL_V1.md` is a frozen protocol copy used for installation verification.

If present, these are frozen protocol copies too:

- `BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md`
- `BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md`

Do not reformat, translate, summarize, fix, or regenerate these files. Copy official replacements
byte-for-byte when an authorized protocol update is required.

`appId` is the stable application identity. Do not change it during an ordinary update. Increase the
SemVer `version` in `biunivers.app.json` for a release that changes application behavior or branding.

## Security boundaries

- Never commit passwords, access keys, private keys, cookies, bearer tokens, or production secrets.
- Manifest configuration is public browser data. Do not use it for secrets.
- Do not access `window.parent` except through a published Biunivers protocol implemented by this
  repository.
- Do not invent private `postMessage` methods, manifest fields, Host APIs, or internal application
  types.
- Do not read or modify the parent DOM.
- Do not persist resource sessions, instance credentials, content URLs, or file handles in URLs,
  localStorage, IndexedDB, logs, analytics, crash reports, or remote services.
- A resource session grants access only to the resource explicitly selected or delivered by the
  host. It does not grant filesystem enumeration.
- Do not attempt to guess Entry IDs, session IDs, content URLs, or credentials.
- Treat file names, file content, Markdown, media metadata, and external API responses as untrusted
  input.

## Resource applications

Only follow this section when the repository includes
`BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md`.

- Read that protocol completely before changing resource code.
- Prefer `biunivers.resource-session/1` for new file-capable applications.
- Use `resource.getCapabilities` before relying on resource methods.
- Treat `NO_LAUNCH_CONTEXT` as a normal desktop launch.
- Use `resource.claimLaunch` for a host-delivered resource.
- Use `resource.open` for an explicit user-driven file selection.
- Use `resource.saveAs` for an explicit user-driven save target.
- Send both the instance authorization and resource-session header on content GET and PUT.
- Use a single HTTP Range for random access to large content and handle `206` and `416`.
- Renew active sessions approximately every 60 seconds.
- Release sessions when switching or closing resources.
- Handle expiry, revocation, host restart, and write conflicts without silent data loss.
- Use the session's actual `access`; a Handler declaration is only a maximum requested capability.
- Keep one transport for the lifetime of a resource. Add Host API v1 fallback only when legacy-host
  compatibility is an explicit requirement.

## Implementation workflow

Before editing:

1. Read `README.md`, `biunivers.app.json`, and all present `BIUNIVERS_*_PROTOCOL_V1.md` files.
2. Read `biunivers.open-resource.json` when present.
3. Inspect existing tests, scripts, build configuration, and repository status.
4. Preserve unrelated user changes.

While editing:

- Make the smallest coherent change that satisfies the request.
- Preserve the static, backend-free delivery model unless the user explicitly changes the product
  scope.
- Keep the interface usable at the manifest minimum and default window sizes.
- Provide visible keyboard focus and avoid unnecessary horizontal scrolling.
- Detect optional browser capabilities and show a useful error when unavailable.
- Keep configuration keys declared in the manifest and provide defaults for optional values.
- Preserve unsaved user work when an operation fails or a write conflicts.

Before reporting completion:

1. Validate every JSON file.
2. Validate the Manifest and optional Handler declaration against the developer-kit schemas.
3. Run existing tests, lint, type checks, and builds that apply.
4. Serve the repository root over HTTP and check for missing assets and console errors when browser
   testing is available.
5. Check minimum, default, resized, maximized, minimized, restored, and reopened behavior as
   applicable.
6. For resource applications, test ordinary launch, launch with a resource, user cancellation,
   renew, release, read-only access, save conflict, and expired-session recovery as applicable.
7. Confirm frozen protocol copies still match the official developer-kit files byte-for-byte.
8. Confirm no secret or credential was added.

## Completion report

Report:

- the user-visible outcome;
- the resulting app identity and version;
- protocols and optional browser capabilities used;
- tests and manual checks performed;
- any remaining limitation or required user action.

Do not claim Biunivers compatibility unless the root entry, Manifest, frozen protocol copies, relative
assets, window behavior, and any declared resource workflow have been verified.
