import { getValue, setValue } from "./store";

export type RemoteImagePolicy = "load" | "placeholder" | "off";

const DEFAULT_REMOTE_IMAGE_POLICY: RemoteImagePolicy = "placeholder";

let remoteImagePolicy: RemoteImagePolicy = DEFAULT_REMOTE_IMAGE_POLICY;
const listeners = new Set<() => void>();

export function getRemoteImagePolicy(): RemoteImagePolicy {
  return remoteImagePolicy;
}

export function setRemoteImagePolicy(p: RemoteImagePolicy): void {
  if (remoteImagePolicy === p) return;
  remoteImagePolicy = p;
  void setValue("remoteImagePolicy", p);
  for (const l of listeners) l();
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Load persisted settings into the in-memory cache. Call once at startup. */
export async function loadSettings(): Promise<void> {
  try {
    const stored = await getValue<RemoteImagePolicy>("remoteImagePolicy");
    if (stored === "load" || stored === "placeholder" || stored === "off") {
      remoteImagePolicy = stored;
    }
  } catch {
    // No store available (e.g. Node test env). Stick with defaults.
  }
}

/** Remote in the network sense: http(s) or protocol-relative. data:/blob:/file:
 * URIs and relative paths don't trigger a network fetch and aren't policy-gated. */
export function isRemoteUrl(url: string): boolean {
  if (!url) return false;
  return /^https?:\/\//i.test(url) || /^\/\//.test(url);
}

export function shouldRenderImage(url: string, policy: RemoteImagePolicy): boolean {
  if (!isRemoteUrl(url)) return true;
  return policy === "load";
}
