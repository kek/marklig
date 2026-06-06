// Reconnecting WebSocket client for live sync. Foreground-only (connects
// on visibilitychange → visible, drops on hidden). Subscribes with
// per-folder cursors and applies ops via the mobile_apply_sync_op command.

import { invoke } from "@tauri-apps/api/core";
import { getValue, setValue } from "./store";
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
    if (this.ws || this.stopped) return;
    const host = this.pairing.last_host;
    if (!host) return;

    try {
      const cursors = await this.loadCursors();
      const ws = new WebSocket(`ws://${host}:${WS_PORT}`);
      this.ws = ws;

      ws.onopen = () => {
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
        this.handleDisconnect();
      };

      ws.onclose = () => {
        this.handleDisconnect();
      };
    } catch {
      this.handleDisconnect();
    }
  }

  private disconnect(): void {
    this.clearTimers();
    this.clearReconnect();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
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
