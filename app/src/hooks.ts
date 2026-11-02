import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from './app-context';
import type { JournalEntry } from './lib/types';

/** Loads on mount and whenever deps or a journal entry change. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const { service, refreshKey } = useApp();
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const reload = useCallback(async () => {
    const run = ++latest.current;
    setLoading(true);
    try {
      const value = await load();
      if (run === latest.current) { setData(value); setError(undefined); }
    } catch (e) {
      if (run === latest.current) setError(e);
    } finally {
      if (run === latest.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, refreshKey, ...deps]);
  useEffect(() => { reload(); return service.subscribe(() => { reload(); }); }, [reload, service]);
  return { data, error, loading, reload };
}

/** Follows one journal entry as the background watcher updates it. */
export function useEntry(entryId: string | undefined) {
  const { service } = useApp();
  const [entry, setEntry] = useState<JournalEntry | undefined>();
  useEffect(() => {
    if (!entryId) return;
    let live = true;
    let updated = false;
    const off = service.subscribe((e) => { if (e.id === entryId) { updated = true; setEntry(e); } });
    service.journal().then((all) => { if (live && !updated) setEntry(all.find((e) => e.id === entryId)); });
    return () => { live = false; off(); };
  }, [entryId, service]);
  return entry;
}

/** Transactions whose outcome is unknown, read from the journal so they show with no network. */
export function useUnresolved() {
  const { service } = useApp();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => service.journal().then((all) => { if (live) setEntries(all.filter((e) => e.state === 'unknown' || e.state === 'submitting')); });
    load();
    const off = service.subscribe(load);
    return () => { live = false; off(); };
  }, [service]);
  return entries;
}

/** False once the screen has gone, so a slow call cannot navigate from a screen the user already left. */
export function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}

/** Seconds until a unix deadline, ticking once a second. */
export function useSecondsLeft(deadline: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!deadline) return 0;
  return Math.max(0, Number(deadline) - Math.floor(now / 1000));
}

export const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
