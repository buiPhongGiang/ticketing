// Avalanche Data API (Glacier): which blocks hold transactions sent to an address, with their timestamps.
// https://developers.avacloud.io/data-api/evm-transactions/list-transactions  (no key needed at low request rates)
// Used only as a shortcut: it lists transactions sent *to* an address, so calls that reach the ticket contract through
// another contract are found by also asking for the organizer Safes, and anything it misses is found by the full
// eth_getLogs scan that runs afterwards.
import type { Address } from 'viem';

interface Page {
  transactions?: { nativeTransaction?: { blockNumber?: string; blockTimestamp?: number; txStatus?: string } }[];
  nextPageToken?: string;
}

/** Block number → unix timestamp for every successful transaction sent to one of `addresses` since `fromBlock`. */
export async function discoverBlocks(baseUrl: string, chainId: number, addresses: Address[], fromBlock: bigint, fetcher: typeof fetch = fetch, maxPages = 30): Promise<Map<bigint, number>> {
  const out = new Map<bigint, number>();
  for (const address of addresses) {
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const url = `${baseUrl}/v1/chains/${chainId}/addresses/${address}/transactions?pageSize=100&startBlock=${fromBlock}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const res = await fetcher(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`Data API ${res.status}`);
      const body = (await res.json()) as Page;
      for (const t of body.transactions ?? []) {
        const n = t.nativeTransaction;
        if (!n?.blockNumber || n.txStatus === '0') continue;
        out.set(BigInt(n.blockNumber), Number(n.blockTimestamp ?? 0));
      }
      token = body.nextPageToken;
      if (!token) break;
    }
  }
  return out;
}
