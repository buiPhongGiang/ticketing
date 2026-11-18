import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { createTicketReader, logIndex, readEvents, readListings, readScanners, type EventsSnapshot } from './chain';
import { scannerCandidates, type IndexState } from './logs';
import type { Ticket } from './model';

export const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 120_000;

export interface EventDetail {
  eventId: number;
  tickets: Ticket[];
  listings: Ticket[];
  scanners: Address[];
}

export interface ChainData {
  snapshot: EventsSnapshot | null;
  index: IndexState | null;
  detail: EventDetail | null;
  /** Set when the last read failed; the numbers on screen are then from the read before. */
  error: boolean;
  indexError: boolean;
  refresh: () => Promise<void>;
}

/** Polls every 15 s, backing off up to 2 min while the RPC fails. Event-level reads only for the open event. */
export function useChainData(eventId: number | null): ChainData {
  const [snapshot, setSnapshot] = useState<EventsSnapshot | null>(null);
  const [index, setIndex] = useState<IndexState | null>(null);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [error, setError] = useState(false);
  const [indexError, setIndexError] = useState(false);
  const readTickets = useRef(createTicketReader()).current;
  const failures = useRef(0);
  const eventRef = useRef(eventId);
  eventRef.current = eventId;

  const refresh = useCallback(async () => {
    const id = eventRef.current;
    let failed = false;
    const [events, idx] = await Promise.allSettled([readEvents(), logIndex.sync(setIndex)]);
    if (events.status === 'fulfilled') setSnapshot(events.value); else failed = true;
    const state = idx.status === 'fulfilled' ? idx.value : logIndex.state();
    setIndex(state);
    setIndexError(idx.status === 'rejected');
    if (id !== null && events.status === 'fulfilled' && id < events.value.events.length) {
      try {
        const [tickets, listings, scanners] = await Promise.all([readTickets(id, state.mints), readListings(id), readScanners(id, scannerCandidates(state, id))]);
        if (eventRef.current === id) setDetail({ eventId: id, tickets, listings, scanners });
      } catch {
        failed = true;
      }
    }
    failures.current = failed ? failures.current + 1 : 0;
    setError(failed);
  }, [readTickets]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let running = false;
    const tick = async () => {
      if (!running) {
        running = true;
        try { await refresh(); } finally { running = false; }
      }
      if (stopped) return;
      const delay = failures.current ? Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures.current) : POLL_MS;
      timer = setTimeout(tick, delay);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh, eventId]);

  // Opening another event drops the previous event's detail at once.
  const current = detail && detail.eventId === eventId ? detail : null;
  return { snapshot, index, detail: current, error, indexError, refresh };
}

/** Chain time in seconds, advanced by the client clock since the last read. Re-renders every `everyMs`. */
export function useChainNow(snapshot: EventsSnapshot | null, everyMs = 1000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  const wall = Date.now() / 1000;
  if (!snapshot) return wall;
  // An idle dev chain has an old latest block, and the next block takes the wall clock; a chain moved ahead with
  // evm_increaseTime runs ahead of it. The later of the two is when the next transaction would land.
  return Math.max(wall, snapshot.blockTime + Math.max(0, (Date.now() - snapshot.readAt) / 1000));
}
