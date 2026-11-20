import { useEffect, useState } from 'react';
import { addressUrl, client } from './chain';
import { config } from './config';
import { failureText } from './errors';
import { Empty, HashLink, Metric, Skeleton } from './ui';
import { readVenueDoor, venueProgress, type VenueDoor } from './venue';

/** Door scans recorded on the venue's own L1 and counted on this chain by VenueCheckIns (ICM). */
export function VenueDoorPanel({ eventId, refreshKey }: { eventId: number; refreshKey?: unknown }) {
  const address = config.venueCheckIns;
  const [door, setDoor] = useState<VenueDoor | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!address) return;
    let live = true;
    readVenueDoor(client, address, eventId, config.venueFromBlock, config.logChunk)
      .then((d) => { if (live) { setDoor(d); setError(null); } })
      .catch((e) => { if (live) setError(failureText(e)); });
    return () => { live = false; };
  }, [address, eventId, refreshKey]);
  if (!address) return null;

  const progress = door ? venueProgress(door) : null;
  const url = addressUrl(address);
  return (
    <section className="panel venue-door" data-testid="venue-door">
      <div className="panel-head">
        <h2 className="display">Venue door</h2>
        <span className="tag mono" title="Scans recorded by gate devices on the venue's own Avalanche L1, sent to this chain over ICM (Teleporter)">L1 {config.venueChain} → ICM</span>
      </div>
      {error && !door ? <p className="alert" role="alert">{error}</p> : !door ? <><Skeleton h={44} /><Skeleton /></> : (
        <>
          <div className="metrics four">
            <Metric label="Counted" id="venue-accepted" value={door.accepted} sub={`${door.paidAccepted} paid`} />
            <Metric label="Rejected" id="venue-rejected" value={door.rejected} sub="Checked against VeGoc" />
            <Metric label="Quorum" id="venue-quorum" value={`${door.venuePaid}/${door.paidSold}`} sub={door.met ? 'Met' : door.paidSold ? `${progress!.missing} more to half` : 'No paid tickets'} />
            <Metric label="Own gate" id="venue-own" value={door.veGocPaid} sub="Paid, scanned on VeGoc" />
          </div>
          <div className={`meter venue-meter ${door.met ? 'met' : ''}`} aria-hidden="true"><i style={{ width: `${progress!.pct}%` }} /></div>
          {door.batches.length === 0 ? <Empty id="venue-none">No batches from the venue L1 yet</Empty> : (
            <ul className="staff venue-batches">{door.batches.map((b) => (
              <li key={b.tx} data-testid={`venue-batch-${b.batch}`}>
                <span className="mono">Batch {b.batch} · {b.accepted} counted{b.rejected ? ` · ${b.rejected} rejected` : ''}</span>
                <HashLink hash={b.tx} />
              </li>
            ))}</ul>
          )}
          {url ? <a className="mono small muted venue-contract" href={url} target="_blank" rel="noreferrer">VenueCheckIns {address.slice(0, 10)}…</a> : null}
        </>
      )}
    </section>
  );
}
