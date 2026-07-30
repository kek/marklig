// Phone-side pairings: persisted list of paired desktops + the
// Tauri-command wrapper that drives a fresh handshake.

import { invoke } from "@tauri-apps/api/core";
import { getValue } from "./store";
import { SyncClient } from "./mobile-sync-client";

const activeSyncClients = new Map<string, SyncClient>();

export interface MobilePairing {
  pair_id_hex: string;
  friendly_name: string;
  verification_fingerprint: string;
  paired_at_unix: number;
  last_seen_at_unix: number;
  /** The desktop's address as of the last successful contact. A starting
   *  point, not the truth: DHCP moves it, and `SyncClient` rewrites this from
   *  mDNS when it does. */
  last_host?: string;
  /** The name the desktop announces itself under (`QrPayload`'s
   *  `mdns_instance_name`), so a moved `last_host` can be resolved afresh.
   *  Absent on pairings made before it was persisted — those have only the
   *  stored address, and must never be resolved by guesswork. */
  mdns_instance_name?: string;
}

export interface MobilePairingStartArgs {
  qrPayload: string;
  host: string;
  friendlyName: string;
}

export interface MobilePairResult {
  pair_id_hex: string;
  verification_fingerprint: string;
  friendly_name: string;
}

export async function startMobilePairing(
  args: MobilePairingStartArgs,
): Promise<MobilePairResult> {
  // Tauri invoke argument naming: the Rust side declares a single `args`
  // struct, so we pass it under that key. Field names are camelCase on
  // the JS side and Tauri converts them to snake_case for the Rust
  // struct deserialization.
  return invoke<MobilePairResult>("mobile_pairing_start", {
    args: {
      qr_payload: args.qrPayload,
      host: args.host,
      friendly_name: args.friendlyName,
    },
  });
}

export async function listMobilePairings(): Promise<MobilePairing[]> {
  const raw = await getValue<Record<string, MobilePairing>>("mobile.pairings");
  if (!raw || typeof raw !== "object") return [];
  return Object.values(raw).filter(
    (v): v is MobilePairing =>
      v != null &&
      typeof v.pair_id_hex === "string" &&
      typeof v.friendly_name === "string",
  );
}

export interface MobileSyncResult {
  files: number;
  folders: string[];
}

export async function syncNow(
  pairIdHex: string,
  host: string,
): Promise<MobileSyncResult> {
  return invoke<MobileSyncResult>("mobile_sync_now", {
    args: { pair_id_hex: pairIdHex, host },
  });
}

export interface SyncedFile {
  pair_id_hex: string;
  folder_id_hex: string;
  relpath: string;
  abs_path: string;
  synced_at_unix: number;
}

export async function listSyncedFiles(
  pairIdHex: string,
): Promise<SyncedFile[]> {
  const raw = await getValue<Record<string, SyncedFile[]>>(
    "mobile.synced_files",
  );
  if (!raw || typeof raw !== "object") return [];
  const scoped = raw[pairIdHex];
  return Array.isArray(scoped) ? scoped : [];
}

export async function syncedFolderLabels(
  pairIdHex: string,
): Promise<Record<string, string>> {
  const raw = await getValue<Record<string, Record<string, string>>>(
    "mobile.synced_folder_labels",
  );
  if (!raw || typeof raw !== "object") return {};
  return raw[pairIdHex] ?? {};
}

/** Remove a paired desktop from the phone's store and wipe its cached
 *  synced files. Phone-side only — the desktop is not notified (see
 *  issue #95). */
export async function unpairMobile(pairIdHex: string): Promise<void> {
  await invoke("mobile_unpair", { pairIdHex });
}

/** Read a synced file's plaintext via the Rust command (which bypasses
 *  the plugin-fs scope check by reading from the trusted synced root). */
export async function readSyncedFile(
  pairIdHex: string,
  folderIdHex: string,
  relpath: string,
): Promise<string> {
  return invoke<string>("mobile_read_synced_file", {
    pairIdHex,
    folderIdHex,
    relpath,
  });
}

export function startSyncClient(pairing: MobilePairing): void {
  if (activeSyncClients.has(pairing.pair_id_hex)) return;
  const client = new SyncClient(pairing);
  activeSyncClients.set(pairing.pair_id_hex, client);
  client.start();
}

export function stopSyncClient(pairIdHex: string): void {
  const client = activeSyncClients.get(pairIdHex);
  if (client) {
    client.stop();
    activeSyncClients.delete(pairIdHex);
  }
}
