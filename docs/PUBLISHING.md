# Publishing to npm

Working notes for releasing this package to npm and having it listed in the
[Pi package gallery](https://pi.dev/packages). Written to be resumed cold.

## Status

| Step | State |
|---|---|
| `package.json` with `pi-package` keyword | done |
| `files` allowlist (tarball hygiene) | done |
| Tarball validated | done — 14 files, 31.0 kB, shasum `5812e4c7d1df4dccba34221a997af2bb3a474d76` |
| Repo pushed | done — commit `0f06446` |
| **First `npm publish`** | **not done — blocked on npm 2FA** |
| Trusted publishing (CI releases) | after first publish |

## The blocker

npm requires a second factor to publish. The account has `tfa.mode =
auth-and-writes` (visible via `npm profile get --json`) but **no factor is
actually registered**, so publishing fails with:

```
403 Forbidden - PUT https://registry.npmjs.org/nexus-h2a-speechtool
Two-factor authentication or granular access token with bypass 2fa enabled
is required to publish packages.
```

TOTP (authenticator app) can no longer be enrolled at all — first-party removal,
not a local problem:

```
$ npm profile enable-2fa auth-only
npm error 404 Not Found - POST https://registry.npmjs.org/-/npm/v1/user
npm error 404 Adding a new TOTP 2FA is no longer supported.
```

Only WebAuthn (security key / passkey) is accepted.

## Resume here

### 1. Register a WebAuthn factor

The cheapest route on Linux needs no hardware: register the passkey **from the
phone browser**, where the phone's own screen lock / biometrics acts as the
authenticator.

1. Open `https://npmjs.com/settings/<npm-user>/tfa` from the phone.
2. Log in, then choose **Enable 2FA** / **Add security key**.
3. Confirm with the phone's screen lock (Android: Google Password Manager;
   iOS: iCloud Keychain).
4. Save the **recovery codes** somewhere safe — they also work as a one-time
   password at a prompt.

Alternatives if that path fails:

- USB FIDO2 key (works with Firefox directly — the most robust option).
- Chrome/Chromium on the desktop with the cross-device QR flow (phone as key).
  On Pop!_OS 24.04 there is no `chromium` in apt and no snap; use
  `flatpak install flathub org.chromium.Chromium` or Google's `.deb`.
- Advanced, no hardware: expose the TPM 2.0 (`/dev/tpm0` exists on this machine)
  as a virtual FIDO2 key with a `tpm-fido` style daemon over `/dev/uhid`.

### 2. Publish

```bash
cd /path/to/Nexus-H2A-SpeechTool
npm publish --access public --browser=false
```

`--browser=false` matters on this machine: without it npm tries to open Firefox,
which has no WebAuthn authenticator on Linux. The command prints:

```
Authenticate your account at:
https://www.npmjs.com/auth/cli/<uuid>
```

Open that URL from the phone, confirm with biometrics, and **do not interrupt
the terminal** — the CLI is polling `doneUrl` and finishes the publish on its
own. (Verified in npm 11.19 `lib/utils/auth.js`: `otplease` handles `EOTP` with
`authUrl`/`doneUrl` via `webAuthOpener` → poll → retry with OTP. The challenge is
not bound to the machine running the command, so authenticating elsewhere works.)

### 3. Verify

```bash
npm view nexus-h2a-speechtool
```

```bash
pi -e npm:nexus-h2a-speechtool      # try without installing
pi install npm:nexus-h2a-speechtool # install
```

Gallery listing appears at `https://pi.dev/packages/nexus-h2a-speechtool`
shortly after the publish — there is no submission form, the gallery indexes npm
packages tagged with the `pi-package` keyword.

### 4. Make future releases OTP-free

```bash
npm trust github nexus-h2a-speechtool --file .github/workflows/ci.yml --allow-publish
```

Requires a working 2FA factor and a package that already exists on npm, so it
comes *after* the first manual publish. Note that `npm trust` itself needs an
interactive 2FA challenge.

## Dead ends (verified, do not retry)

- **Granular access token with "bypass 2FA"** — restricted for account and
  package management (npm changelogs 2026-07-08 and 2026-07-31) and reported
  broken for publishing even with `bypass_2fa: true` (npm/cli#9268, open).
- **TOTP / authenticator app** — permanently disabled for new setups
  (GitHub changelog 2025-09-29: "New TOTP setups for npm access will be
  permanently disabled").
- **`npm profile enable-2fa auth-and-writes` from the CLI** — with the profile
  already reporting that mode, npm exits early with "already enabled" and never
  prints the QR (`lib/commands/profile.js`).
- **`npm publish` from a non-TTY context** (scripts, agents) — `otplease` in
  `lib/utils/auth.js` rethrows immediately when stdin/stdout is not a TTY, so
  neither the OTP prompt nor the browser flow happens. The publish must run in
  an interactive terminal.
- **Firefox on Linux as the authenticator host** — no platform authenticator and
  no cross-device passkey flow; a USB security key is required there.

## Package facts worth keeping

- `pi-package` keyword in `package.json` is what makes the package eligible for
  the gallery; `pi.image` / `pi.video` add previews.
- Host-provided packages (`@earendil-works/pi-coding-agent`, `typebox`, …) belong
  in `peerDependencies`, never in `dependencies` — this package imports none.
- Published versions are immutable; unpublishing is only possible for 72 hours.
