import { describe, expect, test } from 'vitest';
import { zeroHash, type Address, type Hex } from 'viem';
import { outcomeState, readDoorLog, readOutcome } from '../src/l1';

const GATE_LOG = '0xa469888cdfa2ffad68a9babbd92d29d95c577c36' as Address;
const RELAY = '0xe18c8961b7706fe149faa474a3f835e1530c34f7' as Address;
const MIRROR = '0x744e2be19b816f280e35ae441e6ba51f7b5d4c78' as Address;
const MSG = `0x${'b5'.repeat(32)}` as Hex;
const HOLDER = '0x9638F49A3cB7c002779724b427905F6Ab1D54BFA' as Address;

describe('venue L1 read directly', () => {
  test('door log: scans newest first, how many were sent on, how many still wait', async () => {
    const l1 = {
      async readContract({ address, functionName, args }: { address: Address; functionName: string; args: [bigint] }) {
        expect(address).toBe(GATE_LOG);
        expect(args[0]).toBe(1n);
        if (functionName === 'scans') return [{ tokenId: 31n, holder: HOLDER, at: 100n }, { tokenId: 32n, holder: HOLDER, at: 101n }, { tokenId: 33n, holder: HOLDER, at: 160n }];
        return functionName === 'sentUpTo' ? 2n : 1n;
      },
    };
    expect(await readDoorLog(l1 as never, GATE_LOG, 1)).toEqual({
      scans: [{ tokenId: 33, holder: HOLDER, at: 160 }, { tokenId: 32, holder: HOLDER, at: 101 }, { tokenId: 31, holder: HOLDER, at: 100 }],
      sent: 2, waiting: 1, batches: 1,
    });
  });

  test('outcome stages: running, ready to send, on its way, delivered (what the L1 stored wins)', () => {
    const none = { outcome: 0, paidSold: 0, paidCheckedIn: 0 };
    expect(outcomeState({ outcome: 0, paidSold: 13, paidCheckedIn: 0 }, zeroHash, none)).toEqual({ stage: 'running', outcome: 'none', paidSold: 13, paidCheckedIn: 0 });
    expect(outcomeState({ outcome: 2, paidSold: 4, paidCheckedIn: 0 }, zeroHash, none)).toEqual({ stage: 'ready', outcome: 'noshow', paidSold: 4, paidCheckedIn: 0 });
    expect(outcomeState({ outcome: 1, paidSold: 16, paidCheckedIn: 9 }, MSG, none)).toEqual({ stage: 'sent', outcome: 'happened', paidSold: 16, paidCheckedIn: 9, messageId: MSG });
    // The numbers on the L1 were fixed when the message was sent; later scans on the C-Chain do not change them.
    expect(outcomeState({ outcome: 1, paidSold: 16, paidCheckedIn: 11 }, MSG, { outcome: 1, paidSold: 16, paidCheckedIn: 9 }))
      .toEqual({ stage: 'delivered', outcome: 'happened', paidSold: 16, paidCheckedIn: 9, messageId: MSG });
    expect(outcomeState({ outcome: 3, paidSold: 5, paidCheckedIn: 0 }, MSG, { outcome: 3, paidSold: 5, paidCheckedIn: 0 }).outcome).toBe('cancelled');
  });

  test('outcome: the relay is read on Fuji, the record on the L1', async () => {
    const asked: string[] = [];
    const fuji = { async readContract({ address, functionName }: { address: Address; functionName: string }) { asked.push(`fuji ${functionName}`); expect(address).toBe(RELAY); return functionName === 'messageOf' ? MSG : [1, 16n, 9n]; } };
    const l1 = { async readContract({ address, functionName }: { address: Address; functionName: string }) { asked.push(`l1 ${functionName}`); expect(address).toBe(MIRROR); return [HOLDER, 1, 16, 9]; } };
    expect(await readOutcome(fuji as never, RELAY, l1 as never, MIRROR, 2)).toEqual({ stage: 'delivered', outcome: 'happened', paidSold: 16, paidCheckedIn: 9, messageId: MSG });
    expect(asked.sort()).toEqual(['fuji messageOf', 'fuji outcomeOf', 'l1 records']);
  });
});
