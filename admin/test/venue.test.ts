import { describe, expect, test } from 'vitest';
import type { Address } from 'viem';
import { readVenueDoor, venueProgress } from '../src/venue';

const AT = '0xeb34aca78c23374e36e3a03cf9bcc311186e14f0' as Address;

function fakeClient(batches: number, logs: { batch: bigint; accepted: bigint; rejected: bigint; block: bigint; tx: string }[]) {
  const ranges: [bigint, bigint][] = [];
  const client = {
    async readContract({ functionName, args }: { functionName: string; args: [bigint] }) {
      expect(args[0]).toBe(1n);
      if (functionName === 'tallies') return [5, 5, 1, batches];
      return [5n, 12n, 0n, false];
    },
    async getBlockNumber() { return 1250n; },
    async getLogs({ fromBlock, toBlock, args }: { fromBlock: bigint; toBlock: bigint; args: { eventId: bigint } }) {
      expect(args.eventId).toBe(1n);
      ranges.push([fromBlock, toBlock]);
      return logs.filter((l) => l.block >= fromBlock && l.block <= toBlock)
        .map((l) => ({ args: { batch: l.batch, accepted: l.accepted, rejected: l.rejected }, transactionHash: l.tx, blockNumber: l.block }));
    },
  };
  return { client: client as never, ranges };
}

describe('venue door (VenueCheckIns over ICM)', () => {
  test('progress towards the one-half quorum', () => {
    expect(venueProgress({ venuePaid: 5, paidSold: 12 })).toEqual({ pct: 42, missing: 1 });
    expect(venueProgress({ venuePaid: 6, paidSold: 12 })).toEqual({ pct: 50, missing: 0 });
    expect(venueProgress({ venuePaid: 2, paidSold: 5 })).toEqual({ pct: 40, missing: 1 });
    expect(venueProgress({ venuePaid: 0, paidSold: 0 })).toEqual({ pct: 0, missing: 0 });
    expect(venueProgress({ venuePaid: 9, paidSold: 4 }).pct).toBe(100);
  });

  test('reads tallies, quorum and batch receipts in chunks, newest first', async () => {
    const { client, ranges } = fakeClient(3, [
      { batch: 1n, accepted: 2n, rejected: 0n, block: 1010n, tx: '0x01' },
      { batch: 2n, accepted: 2n, rejected: 1n, block: 1100n, tx: '0x02' },
      { batch: 3n, accepted: 1n, rejected: 0n, block: 1240n, tx: '0x03' },
    ]);
    const d = await readVenueDoor(client, AT, 1, 1000n, 100n);
    expect(ranges).toEqual([[1000n, 1099n], [1100n, 1199n], [1200n, 1250n]]);
    expect(d).toMatchObject({ accepted: 5, paidAccepted: 5, rejected: 1, venuePaid: 5, paidSold: 12, veGocPaid: 0, met: false });
    expect(d.batches.map((b) => b.batch)).toEqual([3, 2, 1]);
    expect(d.batches[1]).toEqual({ batch: 2, accepted: 2, rejected: 1, tx: '0x02', block: 1100n });
  });

  test('skips the log scan when no batch has arrived', async () => {
    const { client, ranges } = fakeClient(0, []);
    const d = await readVenueDoor(client, AT, 1, 1000n, 100n);
    expect(ranges).toEqual([]);
    expect(d.batches).toEqual([]);
  });
});
