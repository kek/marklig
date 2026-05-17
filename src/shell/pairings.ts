// JS shape over the desktop pairing Tauri commands. Mirrors
// src-tauri/src/pairing.rs. Steps 6+7 build network transport and
// phone-side scanner that complete the pairing handshake; this module
// is the desktop-side surface that the UI talks to.

import { invoke } from "@tauri-apps/api/core";

export interface PairingMeta {
  pair_id_hex: string;
  friendly_name: string;
  paired_at_unix: number;
  last_seen_at_unix: number;
  verification_fingerprint: string;
  synced_folders: string[];
}

export interface PairingStarted {
  qr_payload: string;
  verification_fingerprint: string;
}

export async function startPairing(): Promise<PairingStarted> {
  return invoke<PairingStarted>("pairing_start");
}

export async function cancelPairing(): Promise<void> {
  await invoke("pairing_cancel");
}

export async function listPairings(): Promise<PairingMeta[]> {
  return invoke<PairingMeta[]>("pairing_list");
}

export async function unpair(pairIdHex: string): Promise<void> {
  await invoke("pairing_unpair", { pairIdHex });
}

export async function folderSyncEnable(
  pairIdHex: string,
  folder: string,
): Promise<void> {
  await invoke("folder_sync_enable", { pairIdHex, folder });
}

export async function folderSyncDisable(
  pairIdHex: string,
  folder: string,
): Promise<void> {
  await invoke("folder_sync_disable", { pairIdHex, folder });
}
