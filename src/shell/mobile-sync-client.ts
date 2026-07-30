// Reconnecting WebSocket client for live sync. Foreground-only (connects
// on visibilitychange → visible, drops on hidden). Subscribes with
// per-folder cursors and applies ops via the mobile_apply_sync_op command.
//
// The address is not fixed. `last_host` was frozen in at pair time, so a DHCP
// lease change used to break reconnect for good; the desktop now announces
// itself by name over mDNS while its pairing server is armed, and this client
// resolves that name when — and only when — the stored address stops working.

import { invoke } from "@tauri-apps/api/core";
import { getValue, setValue } from "./store";
import { resolvePeerAddress, type DialTarget } from "./mdns";
import type { MobilePairing } from "./mobile-pairings";

const WS_PORT = 14_200;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_INITIAL_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

/** Window CustomEvent name emitted when a live op is applied. */
export const LIVE_OP_EVENT = "sync:live-op";
/** Window CustomEvent name emitted when replay is complete. */
export const CAUGHT_UP_EVENT = "sync:caught-up";

type SyncCursors = Record<string, number>;

export class SyncClient {
  private pairing: MobilePairing;
  private ws: WebSocket | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Set when a connection attempt failed before the socket ever opened, and
   *  cleared on the next open. While set, the address is resolved afresh
   *  instead of reusing the stored one. */
  private hostSuspect = false;
  /** `this.ws` used to be the in-flight marker, but connect() may now await a
   *  resolve before it has a socket to assign — long enough for a reconnect
   *  timer and a visibilitychange to both get through. */
  private connecting = false;
  private boundVisibility: () => void;

  constructor(pairing: MobilePairing) {
    this.pairing = pairing;
    this.boundVisibility = () => {
      if (document.visibilityState === "visible") {
        void this.connect();
      } else {
        this.disconnect();
      }
    };
  }

  start(): void {
    this.stopped = false;
    document.addEventListener("visibilitychange", this.boundVisibility);
    if (document.visibilityState === "visible") {
      void this.connect();
    }
  }

  stop(): void {
    this.stopped = true;
    document.removeEventListener("visibilitychange", this.boundVisibility);
    this.disconnect();
  }

  private async connect(): Promise<void> {
    if (this.ws || this.connecting || this.stopped) return;
    this.connecting = true;

    try {
      const target = await this.dialTarget();
      if (!target) return;
      const cursors = await this.loadCursors();
      // Both awaits above give stop() and a hidden visibilitychange time to
      // land; opening a socket after either would leak a connection.
      if (this.stopped) return;

      const ws = new WebSocket(`ws://${target.host}:${target.port}`);
      this.ws = ws;
      // A socket that never opened is what makes the address suspect. One that
      // opened and later dropped says the desktop went away, which is not
      // evidence its address moved.
      let opened = false;

      ws.onopen = () => {
        opened = true;
        this.hostSuspect = false;
        this.backoffMs = BACKOFF_INITIAL_MS;
        ws.send(
          JSON.stringify({
            type: "subscribe",
            pair_id: this.pairing.pair_id_hex,
            cursors,
          }),
        );
        this.startPing();
      };

      ws.onmessage = (e) => {
        void this.handleFrame(e.data as string);
      };

      ws.onerror = () => {
        if (!opened) this.hostSuspect = true;
        this.handleDisconnect();
      };

      ws.onclose = () => {
        if (!opened) this.hostSuspect = true;
        this.handleDisconnect();
      };
    } catch {
      this.handleDisconnect();
    } finally {
      this.connecting = false;
    }
  }

  /** Where to dial.
   *
   *  The stored address is tried first and kept until an attempt fails to
   *  open: resolving on every connect would spend the resolve timeout on
   *  every reconnect after the desktop sleeps, which is the common case for a
   *  phone, and buy nothing while the address is still right. A failed dial
   *  is the signal, and it is exactly the symptom of the bug being fixed.
   *
   *  A resolve that finds nothing falls back to the stored address rather
   *  than giving up — and a pairing that predates `mdns_instance_name` is
   *  never resolved at all, since asking for no name would dial whichever
   *  desktop answered first. */
  private async dialTarget(): Promise<DialTarget | null> {
    const stored = this.pairing.last_host;
    if (!this.hostSuspect && stored) return { host: stored, port: WS_PORT };

    const instance = this.pairing.mdns_instance_name;
    if (instance) {
      const resolved = await resolvePeerAddress(instance);
      if (resolved) {
        await this.rememberHost(resolved.host);
        return resolved;
      }
    }
    return stored ? { host: stored, port: WS_PORT } : null;
  }

  /** Record a freshly resolved address as the one to try first next time, so
   *  a phone that has caught up with a DHCP change pays for the resolve once.
   *  Also updates the pairing object this client was handed — the same object
   *  the synced view reads `last_host` from for its own sync calls. */
  private async rememberHost(host: string): Promise<void> {
    if (this.pairing.last_host === host) return;
    this.pairing.last_host = host;
    // Spread the raw stored record, not a `MobilePairing`: it also carries the
    // pair key, which the interface does not name and must survive the write.
    const all =
      (await getValue<Record<string, Record<string, unknown>>>(
        "mobile.pairings",
      )) ?? {};
    const record = all[this.pairing.pair_id_hex];
    if (!record) return;
    all[this.pairing.pair_id_hex] = { ...record, last_host: host };
    await setValue("mobile.pairings", all);
  }

  private disconnect(): void {
    this.clearTimers();
    this.clearReconnect();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      // Drop the handlers before closing: a close we asked for is not a dial
      // that failed, and must not mark the address suspect.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      ws.close();
    }
  }

  private handleDisconnect(): void {
    this.ws = null;
    this.clearTimers();
    if (!this.stopped && document.visibilityState === "visible") {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPing(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (!this.ws) return;
      this.ws.send(JSON.stringify({ type: "ping" }));
      this.pongTimer = setTimeout(() => {
        this.handleDisconnect();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private async handleFrame(text: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.type as string) {
      case "op_put":
        await this.applyPut(msg);
        break;
      case "op_delete":
        await this.applyDelete(msg);
        break;
      case "caught_up":
        window.dispatchEvent(
          new CustomEvent(CAUGHT_UP_EVENT, {
            detail: { pairIdHex: this.pairing.pair_id_hex },
          }),
        );
        break;
      case "pong":
        if (this.pongTimer !== null) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        break;
      case "error":
        if (
          typeof msg.reason === "string" &&
          msg.reason.includes("blob missing") &&
          typeof msg.folder_id_hex === "string"
        ) {
          await this.resetCursor(msg.folder_id_hex);
        }
        break;
    }
  }

  private async applyPut(msg: Record<string, unknown>): Promise<void> {
    const folderIdHex = msg.folder_id_hex as string;
    const relpath = msg.relpath as string;
    const mtimeLogical = msg.mtime_logical as number;

    await invoke("mobile_apply_sync_op", {
      pairIdHex: this.pairing.pair_id_hex,
      folderIdHex,
      relpath,
      mtimeLogical,
      ciphertextB64: msg.ciphertext_b64 as string,
      kind: "put",
    });

    await this.advanceCursor(folderIdHex, mtimeLogical);

    window.dispatchEvent(
      new CustomEvent(LIVE_OP_EVENT, {
        detail: {
          pairIdHex: this.pairing.pair_id_hex,
          folderIdHex,
          relpath,
          kind: "put",
        },
      }),
    );
  }

  private async applyDelete(msg: Record<string, unknown>): Promise<void> {
    const folderIdHex = msg.folder_id_hex as string;
    const relpath = msg.relpath as string;
    const mtimeLogical = msg.mtime_logical as number;

    await invoke("mobile_apply_sync_op", {
      pairIdHex: this.pairing.pair_id_hex,
      folderIdHex,
      relpath,
      mtimeLogical,
      ciphertextB64: null,
      kind: "delete",
    });

    await this.advanceCursor(folderIdHex, mtimeLogical);

    window.dispatchEvent(
      new CustomEvent(LIVE_OP_EVENT, {
        detail: {
          pairIdHex: this.pairing.pair_id_hex,
          folderIdHex,
          relpath,
          kind: "delete",
        },
      }),
    );
  }

  private async loadCursors(): Promise<SyncCursors> {
    const all =
      (await getValue<Record<string, SyncCursors>>("mobile.sync_cursors")) ??
      {};
    return all[this.pairing.pair_id_hex] ?? {};
  }

  private async advanceCursor(
    folderIdHex: string,
    mtime: number,
  ): Promise<void> {
    const all =
      (await getValue<Record<string, SyncCursors>>("mobile.sync_cursors")) ??
      {};
    const pair = all[this.pairing.pair_id_hex] ?? {};
    if (mtime > (pair[folderIdHex] ?? 0)) {
      pair[folderIdHex] = mtime;
      all[this.pairing.pair_id_hex] = pair;
      await setValue("mobile.sync_cursors", all);
    }
  }

  private async resetCursor(folderIdHex: string): Promise<void> {
    const all =
      (await getValue<Record<string, SyncCursors>>("mobile.sync_cursors")) ??
      {};
    const pair = all[this.pairing.pair_id_hex] ?? {};
    pair[folderIdHex] = 0;
    all[this.pairing.pair_id_hex] = pair;
    await setValue("mobile.sync_cursors", all);
  }
}
