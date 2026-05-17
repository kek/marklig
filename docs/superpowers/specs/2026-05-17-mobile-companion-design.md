# Märklig Mobile — v2 companion app design

**Date:** 2026-05-17
**Status:** Draft. Resolves the open sub-questions in issue #70 with defaults flagged `[default — confirm before build]`. Not a build plan yet; a separate plan under `docs/superpowers/plans/` follows after sign-off.
**Closes (when approved):** issue #70's stated next-step "A real spec under `docs/superpowers/specs/` once this design space narrows further."

---

## 1. Scope

A read-only Markdown reader for **Android**, with two ways to get a document on screen:

1. **Standalone** — open any `.md` from Files, share sheet, email, messaging. Local library view. No pairing required.
2. **Paired (LAN-only in v2.0)** — subscribe to one or more folders on a Märklig desktop. Content syncs E2E-encrypted over the local network when both devices are on it. No server, no subscription.

The same renderer (CodeMirror 6 + decoration producers + markdown-it + Shiki + KaTeX + Mermaid) runs on both desktop and phone. Pairing is the only trust relationship between devices.

Out of scope for v2.0: **server-backed sync (relay) — deferred to v2.1+, see §9**, iOS, edit-on-phone, Windows/Linux desktop pairing parity beyond what falls out for free, Mermaid-in-export (#56), auto-updater (#57). Each is its own follow-up.

## 2. Why this spec exists now

Issue #70 captures the *what* and the explicit *open* questions. Without resolving those, no implementation plan can start: every component (pairing, transport, file shell, library UI) blocks on one of them. This spec picks defaults to unblock planning. Each pick has a flagged `Decision` line; reversing any of them is a spec amendment, not a code change.

## 3. Tensions explicitly accepted

REQUIREMENTS.md §1 lists "Cloud sync, accounts, or any server-side component" as a **v1 non-goal**. **In v2.0 we honor that fully** — there is no server. Both standalone and paired modes are server-free: pairing happens via direct LAN handshake, sync flows over the local network only. The product stays free OSS with no infrastructure to pay for.

The relay/server-backed sync described as v2.1+ in §9 is where the non-goal would actually be revisited; we are explicitly *not* doing that now. If and when it ships, it will be a blind relay (server cannot decrypt) with an opt-in subscription, and standalone + LAN-paired modes will remain free.

## 4. Architecture

```
┌─────────────────────────┐         ┌─────────────────────────┐
│ Desktop (existing)      │         │ Android (new)           │
│ Tauri 2 + CM6 + md-it   │         │ Tauri Mobile 2 + same   │
│                         │         │  frontend (renderer)    │
│ - file shell (notify-   │         │ - SAF file shell        │
│   debouncer-full)       │         │ - library indexer       │
│ - per-folder Sync menu  │         │ - share-sheet handler   │
│ - pairing QR (display)  │         │ - pairing QR (scan)     │
│ - sync engine           │         │ - sync engine           │
│ - encryption keys in    │         │ - encryption keys in    │
│   OS keychain           │         │   Android Keystore      │
└────────────┬────────────┘         └────────────┬────────────┘
             │                                   │
             └───────────────┬───────────────────┘
                             │ E2E-encrypted, LAN only
              ┌──────────────▼──────────────┐
              │ mDNS discovery + direct     │
              │ TCP/WebRTC data channel     │
              │ no server, no internet      │
              └─────────────────────────────┘

       (v2.1+ only — not shipped in v2.0)
              ┌─────────────────────────────┐
              │ Blind relay [DEFERRED]      │
              │ Opt-in, subscription-gated. │
              │ See §9 for rationale and    │
              │ what would change.          │
              └─────────────────────────────┘
```

The renderer is the only large piece shared verbatim. File shell, pairing UX, sync engine, and library view are net-new per platform. v2.0 ships with no third infrastructure beyond the two apps.

## 5. Renderer reuse — what ports cleanly

Ports as-is:

- `src/editor/decorations/*` — all producers
- `src/editor/parser.ts`
- Math (KaTeX), Mermaid, Shiki (already lazy-imported, all wasm/JS — no native deps)
- `sanitizeHtml`/`sanitizeSvg` (DOMPurify)
- Reading-mode keymap and widget set

Does **not** port:

- `src/shell/files.ts` — uses Tauri desktop FS scoped to picked paths; Android SAF requires content-URI–based access via tree URIs.
- `src/shell/watcher.ts` — `notify-debouncer-full` is desktop-only. Android doesn't expose a stable fs watcher across SAF providers; we poll synced folders on visibility-change instead (see §7).
- `src/shell/recents.ts` macOS NSDocumentController half — Android has no equivalent; the in-app recents list still works.
- `reveal_in_file_manager` — Android lacks an equivalent; we surface "Open in…" via the share sheet instead.
- `src/shell/recovery.ts` — read-only on phone, no dirty buffers, no recovery.

The split is clean: renderer is portable, shell is per-platform. Issue #70 already names this; this spec confirms it as the build boundary.

## 6. Decisions on the deferred sub-questions

### 6.1 Pairing protocol

**Decision [default — confirm before build]:** **Noise XK** (`Noise_XK_25519_ChaChaPoly_BLAKE2s`) over a QR-conveyed responder public key, run over a direct LAN TCP connection.

Why XK and not X3DH or naive symmetric:

- XK gives mutual auth + forward secrecy from one short interaction (QR shows desktop's static pubkey + a one-shot ephemeral). No "first message" weakness like XX.
- X3DH (libsignal) adds prekey servers and identity-key publishing — too much infrastructure for two devices that already have a direct introduction channel (the QR) and are on the same LAN.
- Naive symmetric (shared secret in QR) gives no forward secrecy and no per-session keys; one phone backup leak compromises all history.

QR payload: `marklig-pair://v1/<base64url(responder_static_pubkey || mdns_instance_name || expiry_unix)>`. Expires in 5 minutes. Phone scans, resolves the desktop via mDNS service `_marklig-sync._tcp` matching `mdns_instance_name`, opens a TCP connection, and runs Noise XK. After handshake, both sides derive a long-term **pair key** (32 B) and a **pair id** (16 B). The pair key never leaves either device's secure store (macOS Keychain / Android Keystore).

If mDNS resolution fails (phone on cellular / different SSID at the moment of pairing), the pairing modal shows a "must be on the same network" hint and a manual IP entry fallback. No relay fallback in v2.0.

### 6.2 Transport mix

**Decision:** **LAN-direct only.** No relay in v2.0.

Sync flows over mDNS-discovered direct TCP (or WebRTC data channel where NAT/firewall on the LAN requires it; same envelope either way). When the phone is off the LAN, synced folders simply don't refresh — the cached content from the last successful sync stays readable offline. A subtle status indicator surfaces "last synced N hours ago, away from LAN."

This is the user's explicit scoping decision (2026-05-17). The original spec draft shipped relay + LAN together; deferring the relay drops a relay codebase, a hosting line item, a subscription/billing surface, and roughly half of the §11 build sequence. The "open my desktop notes on the train" use case becomes "the train if the phone's already synced," which is still useful for note review even if it's a narrower promise.

### 6.3 What syncs alongside content

**Decision [default — confirm before build]:** **Content only in v2.0.** No scroll position, no theme, no settings.

Reasoning: scroll-position sync sounds nice but is fiddly (per-file, per-device, conflict-free? last-write-wins is wrong on phone where the user just scrolled past). Theme/settings sync is a small UX win that doubles the encrypted-state surface. Defer both; revisit in v2.1 if users ask.

### 6.4 Android storage API

**Decision [default — confirm before build]:** **SAF tree URIs for standalone, app-private storage for synced folders.**

- Standalone-opened files arrive via share-sheet `Intent.ACTION_VIEW` with content URIs; the library "recents" list stores the persisted URI permission, not a path. The user opens a folder via SAF directory picker; we hold a tree URI and enumerate it.
- Synced folders live in `Context.getFilesDir()` (app-private). They aren't exposed in Files; that's a feature — synced content stays sandboxed from other apps and from device backups. "Export" exposes a single file to the share sheet on demand.

Reasoning: SAF is the only path that survives Android storage-permission tightening. Direct paths via `READ_MEDIA_*` are Play-policy-restricted for non-media apps. We pay an API-complexity tax once in the shell; the renderer never sees it.

### 6.5 iOS port timing

**Decision [default — confirm before build]:** **Not in v2.0. Plan a v2.1 iOS port after Android stabilizes (≥3 months of Android shipping).**

Reasoning: iOS reuses the renderer cleanly but requires the same Apple Developer cert dependency that blocks #57 and #60. The whole point of "Android first" in #70 is to sidestep that. We do not pre-build iOS scaffolding now; the file-shell abstraction we build for Android should be platform-agnostic in shape (`MobileFileShell` trait/interface), so an iOS port later is a parallel implementation, not a refactor.

### 6.6 Mermaid-in-export relation

**Decision:** **Independent.** #56 is a desktop-export concern. Mobile renders Mermaid live the same way desktop reading mode does (Shiki+Mermaid both already lazy-load). If a pre-export bundle strategy is ever needed as a fallback rendering path, that's a separate spec.

## 7. Sync engine

Tree model: each synced folder maps to a logical "pair-folder". State per pair-folder, on each side:

```
{
  pair_id: bytes(16),
  folder_id: bytes(16),
  files: {
    relpath: { hash: bytes(32), mtime_logical: u64, deleted: bool }
  }
}
```

Updates are op-based: `{op: "put"|"delete", relpath, hash, mtime_logical, ciphertext_ref?}`. `mtime_logical` is a Lamport-style counter per side, not wall-clock — wall-clock comparisons across devices are unreliable. Conflicts (both sides modified between syncs) resolve by `(higher_mtime_logical, lexicographically_larger_hash)` — deterministic, no user prompt in v2.0. Since phone is read-only, conflicts can only happen between two desktops paired to the same phone — see §10.

Content envelope: per-file ChaCha20-Poly1305, key = HKDF(pair_key, info=`"file:" || folder_id || relpath`). Nonce = random 12 B prefixed to ciphertext. The envelope is transport-agnostic — the same opaque ciphertext blob (referenced by a random `ciphertext_ref`) flows over the LAN socket in v2.0 and could flow through a relay in v2.1+ without re-encryption.

Refresh trigger on phone:
- App resume (visibility change → visible) — attempts an mDNS resolve; syncs if peer is reachable.
- Pull-to-refresh on library view.
- Live push from desktop while both are on the LAN and the desktop has unsent ops: desktop pushes over the established channel.

LAN discovery: mDNS service `_marklig-sync._tcp`. Peer instance name + per-pair fingerprint announce. Phone connects via direct TCP, or WebRTC data channel if the LAN routing requires it; same envelope either way.

## 8. Desktop changes

Net-new on desktop:

- **Per-folder "Sync this folder to phone…" menu action.** Lives in the folder context menu in the sidebar (sub-spec D folder tree). First invocation opens the pairing modal if no pair exists yet.
- **Pairing modal.** Shows QR with the payload from §6.1, plus a 6-digit verification code (truncated BLAKE2s of the pair-key) for users to read aloud to confirm.
- **Sync status surface.** A footer indicator: `idle / syncing / last synced 3m ago / phone off LAN`.
- **Settings → Pairings** pane: list paired phones, per-phone synced folders, "unpair" / "stop syncing this folder" buttons.

The frontend renderer is unchanged. Sync engine lives in Rust (`src-tauri/src/sync/`) — keeps the keys out of the webview, reuses `tokio` for the mDNS + LAN tasks.

## 9. Relay infrastructure — deferred to v2.1+

**Decision (2026-05-17):** No relay in v2.0. The "open my desktop notes anywhere with internet" promise is deferred until LAN-only sync has shipped and seen real use.

What v2.0 must preserve to keep this door open:

- The crypto envelope (§7) is transport-agnostic. The same ciphertext format that flows over LAN today can flow over a relay later without re-encryption.
- The pairing key + folder keys are durable — they survive the addition of a relay path.
- The sync ops format is queue-friendly: an op log can be replayed in order from any persistent store, not just a live socket.

What v2.1+ would need to add (out of scope here, sketched only to confirm the door isn't blocked):

- A blind-relay service (Rust + axum + Postgres + S3-style object store, or equivalent) that holds opaque ciphertext keyed by pair-id and forwards ops.
- A subscription/billing surface — Play Store policy means in-app billing for digital subscriptions on Android must go through Play Billing, not Stripe (this is the constraint that the original draft got wrong; flagged here so v2.1 design starts from the right point).
- A user-facing toggle "Allow relay sync" with subscription state.
- A small augmentation to the pairing QR to embed a relay pair-id alongside the LAN mDNS instance name (or a post-pairing "enable relay" handshake; equivalent).

None of this is committed. The v2.1 design will revisit pricing, hosting, and whether the relay code even lives in this repo.

## 10. Library view design

Two-pane home, **not** a mode toggle:

```
┌─────────────────────────────────────────┐
│ Library                              ⚙  │
├─────────────────────────────────────────┤
│ Recent files                            │
│   • notes.md            yesterday       │
│   • spec.md             2 days ago      │
│   • email.md            last week       │
│                                         │
│ Synced folders                          │
│   ▾ Work notes (laptop)                 │
│       project-x.md                      │
│       standup.md                        │
│   ▾ Personal (desktop)                  │
│       journal.md                        │
│                                         │
│ ──── nothing synced? ────               │
│ [+ Pair with a desktop]                 │
└─────────────────────────────────────────┘
```

When unpaired: synced-folders section becomes a single CTA card; recent files fill the rest. Never "half-empty." Issue #70 calls this out specifically; the rule is the empty-state copy must read as complete, not as a missing feature.

Two-desktop-paired case: each synced folder is labeled by which desktop it came from. Two desktops can sync the *same logical folder name* — they're distinct `folder_id`s and shown as two entries.

## 11. Build sequence

A separate plan document under `docs/superpowers/plans/` will own this. Sketch:

1. **Tauri Mobile init.** Add Android target to `src-tauri/`, get the existing renderer rendering a hard-coded sample `.md` in an Android emulator. ~Days. Gate: visual-regression baselines from `tests/e2e/visual-regression.spec.ts` survive Android Chrome WebView modulo expected platform diffs.
2. **`MobileFileShell` trait + SAF implementation.** Open-from-share-sheet flow first; folder pick / library indexer second. Gate: the share-sheet golden path renders a doc with no Tauri-IPC errors.
3. **Recents + library UI.** No sync yet — purely standalone. Ship-able as **v2.0-alpha** here; many users will get value from standalone alone.
4. **Crypto core (`marklig-sync-core` crate).** Noise XK + envelope format + sync ops. Tests against a desktop ↔ desktop loopback over a Unix socket first; phone wired in step 7.
5. **Desktop pairing UX.** QR modal, settings pane, per-folder menu action. Backed by step 4 in loopback mode.
6. **LAN transport.** mDNS discovery (`_marklig-sync._tcp`) + direct TCP, WebRTC fallback. Reuses step-4 envelope. Tested desktop ↔ desktop first.
7. **Phone pairing UX + sync wire-up.** Scan QR, resolve mDNS, run handshake, subscribe to folder, render synced content.
8. **Soft launch — v2.0.** Android internal track, then production.
9. *(v2.1+, deferred)* Relay path. Separate spec when this moment comes.

Each step is a multi-day PR at minimum. v2.0 (steps 1–8) is multi-month at sustained focus; dropping the relay roughly halves the engineering surface vs the earlier draft.

## 12. Risks

- **Tauri Mobile maturity.** Tauri 2 ships mobile, but ecosystem is younger than desktop. Plugin parity (notify, fs scoping) is not equal. Step 1 is partly a probe — if Tauri Mobile blocks on a needed primitive, this spec needs an alternative (likely Capacitor or a native shell wrapping the existing webview bundle).
- **Play Store policy on storage.** SAF is mandatory for non-media file access on recent Android versions; we've designed around this from the start (§6.4). Confirm via Play Console before public-track release.
- **mDNS unreliability on Android.** Some Android versions and OEM Wi-Fi stacks (notably older Samsung) suppress mDNS in doze mode. Mitigation: manual IP entry fallback in the pairing modal; an "is the desktop reachable?" diagnostic in Settings → Pairings.
- **Narrow "always works" surface.** LAN-only means the train/coffee-shop reading promise depends on having pre-synced before leaving. Cached content stays readable, so this is degraded UX, not broken UX — but it's the visible cost of dropping the relay.
- **Same-LAN edge cases.** Guest VLANs / AP isolation block peer-to-peer on the same SSID. Same mitigation as mDNS suppression: clear error copy + manual IP fallback.

## 13. What this spec does not commit to

iOS timeline beyond "v2.1+." Whether `marklig-sync-core` is a crate published on crates.io or a path dependency. UI specifics on phone beyond §10 wireframe. The phone's edit story — explicitly v3+. The eventual relay design (§9 deliberately punted).
