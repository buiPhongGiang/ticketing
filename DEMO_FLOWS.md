# Demo flows

Beat list for the 2:00 to 3:00 silent screen recording on Fuji, one caption per beat (8 words at most). Every beat starts from a screen that is one or two clicks away.

Setup before recording:

- App: `cd app && ENV_FILE=.env.fuji npm run web` (port 8081), three browser windows at phone size, one per wallet (Guest A, Guest B, Gate staff; switch once from the address chip, off camera).
- Console: `cd admin && npx vite --mode fuji --port 8093`, signed in off camera. Two browser profiles: Safe owner 1 (`TICKET_ORGANIZER_KEY`) and Safe owner 2 (`SAFE_OWNER_2_KEY`), both in the gitignored `.env.fuji`. Sign-in is a signature, no transaction.
- Event ids below are the ones seeded on 19 Nov 2026. A spare set already exists for a second take: Saigon Indie Night `#/e/6` (cancel), Rooftop Session `#/e/7` (settle through the Safe) and Soundcheck Session `#/e/8` (no-show), with the same tickets for Guest A and B. `node scripts/fuji-seed.mjs --restage` creates another set (3 minutes, then 9 and 12 minutes until the short events have ended).
- Guest A can buy at most 4 tickets of Neon Pulse (per-wallet limit) and has bought 2. Guest B has the full 4 left.

| # | Time | Where | Action | On screen | Caption |
|---|---|---|---|---|---|
| 0 | 0:00 | title frame | none | "Vé Gốc" over the app's dark backdrop | BIGBANG Hanoi: 9.8M VND tickets resold at 45M |
| 1 | 0:06 | title frame | none | three phones and the console appear | Fuji testnet · mock USDC · mock yield · test wallets |
| 2 | 0:12 | App · Guest A | Events, tap Neon Pulse Festival | "AVALANCHE FUJI" chip, tiers GA 25 / VIP 60 USDC | Every ticket is an NFT on Avalanche |
| 3 | 0:20 | App · Guest A | Buy · 25.00 USDC | "Bought 1 ticket", `BLOCK +0.5 S · RECEIPT +2.9 S · FEE 0.03 nAVAX` | Bought, in a block after half a second |
| 4 | 0:32 | App · Guest A | Ticket, Show QR | QR with a 3:00 countdown (copy the code) | The QR is the holder's signature |
| 5 | 0:42 | App · Guest A | Resell, type 30 | "Max 27.50 USDC", button disabled | The contract caps resale at +10% |
| 6 | 0:52 | App · Guest A, then Guest B | preset Cap +10%, List; B: Neon Pulse, Resale, Buy | "Bought #N on resale · 27.50 USDC" | Guest B buys it on the built-in market |
| 7 | 1:06 | App · Gate | paste A's old code, Check | NO ENTRY · Ticket changed hands | The old QR died with the resale |
| 8 | 1:16 | App · Guest B, then Gate | B: Show QR; Gate: paste, Check, Confirm entry | TICKET #N VALID, then WELCOME IN with block time and fee | The new holder walks in |
| 9 | 1:28 | App · Gate | paste the same code again | NO ENTRY · Already checked in | One ticket, one entry |
| 10 | 1:36 | Console · owner 1 | Neon Pulse overview (`#/e/0`) | 45+ checked in, ticket wall, float 2,8xx USDC with live mock yield, "SAFE 2 OF 3", resale stats, activity with Snowtrace links | The organizer is a 2-of-3 Safe |
| 11 | 1:46 | Console · owner 1 | Saigon Indie Night (`#/e/1/money`): Cancel event, then Refund all | "Refunded 12 tickets · 180.00 USDC", float back to 0 | Cancelled: every buyer refunded from escrow |
| 12 | 1:58 | App · Guest A | My tickets | USDC balance up by 30.00, Indie tickets gone | The money is back in the wallet |
| 13 | 2:06 | Console · owner 1, then App · Guest A | Soundcheck Session money (`#/e/4/money`); A: Soundcheck ticket, Refund 10.00 USDC | "NO-SHOW", "Gate quorum not met · 48 h hold", settle disabled; app: "Refunded 10.00 USDC" | Nobody scanned: refunds open, organizer waits |
| 14 | 2:20 | Console · owner 1, then owner 2 | Rooftop Session money (`#/e/2/money`): Settle, Settle again in the confirmation; same two clicks as owner 2 | owner 1: "Approved 1 of 2"; owner 2: "Settled · 155.20 USDC + … yield · executed by the Safe", platform fee 3 % shown | Two of three signers release the float |
| 15 | 2:36 | end frame | none | VeGoc `0xc5f9302d…b268d` on Fuji, Circle USDC deployment `0x7c4a9af8…6c8c`, Safe `0x96aDD8A7…bc41` | In Vietnam: sold in VND, yield off |

Notes for the recording:

- Captions 1 and 15 carry the disclosures the rules ask for (mocks first, Vietnamese law last). Keep caption 1 on screen for at least 5 seconds.
- Hold 1.5 to 2 seconds on NO ENTRY, WELCOME IN and each console result. Cut the waits for receipts to about half a second.
- Beat 14 amounts: Rooftop Session holds 160.00 USDC; 3 % is 4.80, so 155.20 goes to the Safe as proceeds.
- Do not record Snowtrace in a headless browser (Cloudflare challenge). The console's activity rows link to it.

Local rehearsal without spending test funds: `./scripts/dev-chain.sh`, `./scripts/demo-seed.sh`, then the app on 8081 and the console on 8093 (see README). The local chain has no Safe, so beat 14 is a single wallet there.
