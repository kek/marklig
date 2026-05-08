import { Store } from "@tauri-apps/plugin-store";

let storePromise: Promise<Store> | null = null;

export function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load("viewer.store.json");
  }
  return storePromise;
}

export async function getValue<T>(key: string): Promise<T | undefined> {
  const s = await getStore();
  return await s.get<T>(key);
}

export async function setValue<T>(key: string, value: T): Promise<void> {
  const s = await getStore();
  await s.set(key, value);
  await s.save();
}
