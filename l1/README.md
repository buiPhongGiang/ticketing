# vegoc: the venue's own Avalanche L1

`genesis.json` is the chain's genesis (byte-identical to the `genesisData` in its CreateChainTx on the P-Chain).
`upgrade.json` is the network upgrade every vegoc validator loads from `configs/chains/<blockchainID>/upgrade.json`.

| | |
|---|---|
| chainId / token | 510101 / VGC (gas only, no market value) |
| subnetID | `EW5oFkzj5Xk2TXitcaKALxWkBDQQ4yMD5jT6Uyh9cZP5HhUkn` (sovereign L1, ACP-77) |
| blockchainID | `6M7vAPShYSv6WnXxWwA7ZAsMmRFuRRkTLqe2Pj8TCxX6TuHqG` (= the CreateChainTx ID) |
| VM | Subnet-EVM v1.15.3, Warp on, Teleporter `0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf` |
| Precompile | TxAllowList `0x0200000000000000000000000000000000000002`, active from unix 1795199165 (21/11 01:26 VN) |

## What TxAllowList enforces and why

Only allow-listed wallets can send any transaction on vegoc; everyone else is refused by the node with
`cannot issue transaction from non-allow listed address`. A door log is only worth something if nobody outside the venue
can write to it or flood it, so the chain itself, not only the contract, is closed: the organizer (venue) decides
which gate devices exist, gate devices pay gas in VGC that the venue hands out, and ticket holders never need the
chain at all (they sign the QR in the app, the gate submits it). Ticket sales, resale and money stay on the C-Chain
in VeGoc; the scans go there over ICM (`GateLog` → `VenueCheckIns`). A Fuji contract can check `isGate` too, but it
cannot stop strangers from sending transactions next to it or make gas the venue's own.

| Role | Address | Who |
|---|---|---|
| Admin | `0x6732CcE43f5a68Ab29ee75F1e8eF9eD939C865Ab` | organizer / venue (owns GateLog) |
| Admin | `0x7855c958eC2e104D358aBAd285b50e7C759547F9` | team ops key (also PoA validator manager owner) |
| Enabled | `0x058b326D8A3B7f69FAC9cFB0a772a63e4d26FAA1` | gate device 1 |
| Enabled | `0x474044236309DC089A92c5AB9A3daF853831F1DC` | ICM relayer (delivers Fuji → vegoc) |
| Enabled | `0x87aCC06ef936961eA9A44e3e09f2194D2EED6463` | VGC treasury |

Permission run (`node scripts/vegoc-allowlist.mjs`, record in `docs/vegoc-allowlist.json`): the outsider is refused,
the organizer enables a new gate device, it records a holder-signed scan on GateLog and attests it to Fuji
(executed), then the organizer sets it back to None and its next scan is refused.

## How to verify (public endpoints, no access to our machines needed)

On vegoc itself, through its public read-only RPC:

The advertised endpoint was http://rpc.zillexa.com/vegoc/rpc. On 21 November 2026, Google and Cloudflare public DNS returned NXDOMAIN for that host. The P-Chain and Fuji checks below can be run independently.

```sh
L="http://rpc.zillexa.com/vegoc/rpc"
cast chain-id --rpc-url $L                                                                              # 510101
cast call 0xa469888cdfa2ffad68a9babbd92d29d95c577c36 'scanCount(uint256)(uint256)' 1 --rpc-url $L          # 6 door scans for event 1 (GateLog)
cast call 0x744e2be19b816f280e35ae441e6ba51f7b5d4c78 'records(uint256)(address,uint8,uint32,uint32)' 2 --rpc-url $L   # the Safe, 1 (happened), 16, 9 (AttendanceMirror)
cast call 0x0200000000000000000000000000000000000002 'readAllowList(address)(uint256)' 0x058b326D8A3B7f69FAC9cFB0a772a63e4d26FAA1 --rpc-url $L   # 1: gate device 1 is enabled
cast call 0x0200000000000000000000000000000000000002 'readAllowList(address)(uint256)' 0x2cC60000000000000000000000000000000000a7 --rpc-url $L   # 0: a stranger is not
```

On the P-Chain, through the public Fuji API:

```sh
P=https://api.avax-test.network/ext/bc/P
q() { curl -s -X POST -H 'content-type:application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" $P; }
q platform.getSubnet '{"subnetID":"EW5oFkzj5Xk2TXitcaKALxWkBDQQ4yMD5jT6Uyh9cZP5HhUkn"}'            # managerChainID = vegoc
q platform.getCurrentValidators '{"subnetID":"EW5oFkzj5Xk2TXitcaKALxWkBDQQ4yMD5jT6Uyh9cZP5HhUkn"}' # 1 validator
q platform.getTx '{"txID":"6M7vAPShYSv6WnXxWwA7ZAsMmRFuRRkTLqe2Pj8TCxX6TuHqG","encoding":"json"}' \
  | python3 -c "import json,sys,base64;sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)['result']['tx']['unsignedTx']['genesisData']))" \
  | cmp - l1/genesis.json && echo genesis matches
```

The upgrade is not on the P-Chain: Subnet-EVM reads it from each validator's chain config, so it must be identical
on every validator (here there is one). On Fuji the effect shows indirectly: Warp-signed messages from vegoc keep
arriving at VenueCheckIns, including the batch the new gate device sent (see `docs/vegoc-allowlist.json`).

## Limits

- One validator, on a team-run machine (`NodeID-QLF4neeFGhSaD3KNtzB6poha5KNTLU3iL`); its P-Chain balance needs top-ups.
- The advertised RPC is read-only (reads and `eth_call`, no transactions), so judges can read vegoc directly, and also see it through the P-Chain and through ICM deliveries on Fuji.
- PoA: the validator manager owner and one allow-list admin is the team key `0x7855…47F9`.
- Live since 21/11/2026 (chain ~00:30 VN, allow list 01:26 VN). Not production.
