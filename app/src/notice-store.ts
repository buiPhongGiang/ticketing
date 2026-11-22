// How many notifications are unread, shared between the watcher that finds them and the tab bar that shows the dot.
// Kept apart from the screens so the tab bar can read it without importing them.
import { useSyncExternalStore } from 'react';

let unread = 0;
const listeners = new Set<() => void>();

export function setUnread(n: number) {
  if (n === unread) return;
  unread = n;
  for (const l of listeners) l();
}

export function useUnread(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => unread, () => 0);
}
