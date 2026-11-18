# Demo flows

Beat list for the silent screen recording on Fuji: 2:10 to 2:40, one caption per beat, 8 words at most. Every beat starts from a screen that is one or two clicks away.

## Recording settings

- Viewport 1280×720 at device scale factor 1.5, so the file comes out at 1920×1080. Three phone-sized app windows side by side at full frame height for beats 2 to 9; the console full frame for beats 10 to 12.
- Captions are burned in as a bottom bar: the recorder overlays them on the frames when it assembles the video (ffmpeg `drawbox` + `drawtext`), never as a separate subtitle track. Bar text at least 28 px in the 1080p file.
- Key verdicts are at least 18 px on screen at 1080p: NO ENTRY and WELCOME IN are 60 px and more, the receipt line `BLOCK … · RECEIPT … · FEE …` is 16 px CSS, which is 24 px in the file.
- No file pickers, wallet pop-ups or terminals on camera. The app signs with its built-in test keys; the console signs through an injected test wallet. Wallet switches happen off camera.
- Explorer shots at most 4 seconds each, and only from a normal (headed) browser: Snowtrace shows a Cloudflare check to headless ones.
- Hold 1.5 to 2 seconds on NO ENTRY, WELCOME IN and each console result. Cut the waits for receipts to about half a second.

## Setup

- App: `cd app && ENV_FILE=.env.fuji npm run web` (port 8081). Three windows, one per wallet: Guest A, Guest B, Gate staff (switch once from the address chip, off camera).
- Console: `cd admin && npx vite --mode fuji --port 8093`, signed in off camera. Two browser profiles: Safe owner 1 (`TICKET_ORGANIZER_KEY`) and Safe owner 2 (`SAFE_OWNER_2_KEY`). Both keys, and owner 3's, are team keys in the same gitignored `.env.fuji` on one laptop. Sign-in is a signature, no transaction.
- Optional Circle USDC beat (3b), recorded as its own segment: stop the app, start it with `ENV_FILE=.env.fuji-usdc npm run web` on the same port, buy one ticket of Circle USDC Night as Guest A, stop it and start the main app again.
- Run the pre-record check below first. It must end with "Ready to record."

## Beats

| # | Time | Where | Action | On screen | Caption |
|---|---|---|---|---|---|
| 0 | 0:00 | title frame | none, held 5 s | "Vé Gốc" over the app's dark backdrop | Fuji testnet · mock USDC · mock yield · test wallets |
| 1 | 0:05 | title frame | none | three phones and the console appear | BIGBANG Hanoi: 9.8M VND tickets resold at 45M |
| 2 | 0:11 | App · Guest A | Events, tap Neon Pulse Festival | "12 Dec – 13 Dec", "AVALANCHE FUJI" chip, GA 25 / VIP 60 USDC | Every ticket is an NFT on Avalanche |
| 3 | 0:18 | App · Guest A | Buy · 25.00 USDC | "Bought 1 ticket", `BLOCK +0.5 S · RECEIPT +2.4 S · FEE … nAVAX` | Bought, in a block after half a second |
| 3b | 0:28 | App (Circle deployment) · Guest A | Circle USDC Night, Buy · 0.05 USDC | "Bought 1 ticket · 0.05 USDC" with the receipt line | Same purchase with Circle's own test USDC |
| 4 | 0:36 | App · Guest A | Ticket, Show QR | QR with a 3:00 countdown (copy the code) | The QR is the holder's signature |
| 5 | 0:44 | App · Guest A | Resell, type 30 | "Max 27.50 USDC", button disabled | The contract caps resale at +10% |
| 6 | 0:52 | App · Guest B, then Guest A | B: Neon Pulse, Join the line · 27.50 USDC ("You are #1 in line"); A: preset Cap +10%, List | A: "#N sold to the first in line · 27.50 USDC" | The seller cannot pick the buyer |
| 7 | 1:08 | App · Gate | paste A's old code, Check | NO ENTRY · Ticket changed hands | The old QR died with the resale |
| 8 | 1:17 | App · Guest B, then Gate | B: Show QR; Gate: paste, Check, Confirm entry | TICKET #N VALID, then WELCOME IN with block time and fee | The new holder walks in |
| 9 | 1:29 | App · Gate | paste the same code again | NO ENTRY · Already checked in | One ticket, one entry |
| 10 | 1:36 | Console · owner 1 | Neon Pulse overview (`#/e/0`) | checked-in count and ticket wall, float with live mock yield, "SAFE 2 OF 3", resale stats with "in line", activity | The organizer is a 2-of-3 Safe |
| 11 | 1:46 | Console · owner 1, then App · Guest A | Saigon Indie Night (`#/e/1/money`): Cancel event, Refund all; cut to A's My tickets | "Refunded 12 tickets · 180.00 USDC", float 0; A's USDC balance up by 30.00 | Cancelled: every buyer refunded from escrow |
| 12 | 2:02 | Console · owner 1, then owner 2 | Rooftop Session money (`#/e/2/money`): Settle, Settle again in the confirmation; the same two clicks as owner 2 | owner 1: "Approved 1 of 2"; owner 2: "Settled · … executed by the Safe", platform fee 3 % shown | Two of three signers release the money |
| 13 | 2:20 | end frame | none, held 6 s | VeGoc `0x6f5802cDeeA534B66067607875E2E284feC93EF2` on Fuji and the repo link | In Vietnam: paid in VND, cap stays on chain |

Beat 3b is optional; without it every later beat moves 8 seconds earlier and the video ends at 2:18.

Notes:

- Caption 0 carries the disclosure the rules ask for and stays at least 5 seconds. Caption 13 carries the Vietnamese-law consequence; the README's law row has the full sentence: with the USDC escrow off, automatic refunds, the no-show rule and the on-chain 3 % fee are off too, the fee is invoiced in VND, and the cap, the transfer block and the gate QR stay on chain.
- The no-show rule is not in the video (two money beats only). It is on slide 5 and in the README, with the Soundcheck Session transactions.
- Beat 11 numbers come from the seed: 12 tickets on Saigon Indie Night, Guest A holds 2 (30.00 USDC). Read the live numbers from the pre-record check.
- Beat 12: 3 % of the Rooftop float goes to the platform; the console's confirmation shows both lines before anything is sent.

## Pre-record checklist

Run on recording day, from the repo root:

```sh
node scripts/pre-record.mjs      # read-only; exits 1 if a beat cannot run
```

It checks, and prints the numbers for:

1. Gas: Guest A, Guest B and Gate staff at least 0.004 test AVAX; organizer (Safe owner 1) 0.002; Safe owner 2 0.0003. Top up from the [Fuji faucet](https://build.avax.network/console/primary-network/faucet) by hand if not.
2. Test USDC: Guest A and Guest B at least 100. The app's "+ Test USDC" gives 1,000 every 5 minutes.
3. Beats 2 to 9 (Neon Pulse, event 0): organized by the Safe, on sale; Guest A has a purchase left under the 4-per-wallet limit; no GA listing is open and nobody is in the GA line (so Guest B is first); the gate wallet is a scanner.
4. Beat 11: an event of the organizer wallet on sale in which Guest A holds tickets (Saigon Indie Night). One take only: cancelling is final.
5. Beat 12: an ended, unsettled Safe event with the gate quorum met (Rooftop Session), and both console profiles are owners of the 2-of-3 Safe. One take only: settling is final.
6. Beat 3b: an event on sale on the Circle USDC deployment and at least one ticket's worth of Circle USDC in Guest A's wallet.
7. No-show events, for the slide: which ones exist and whether their 48-hour hold is still running.

After a take, or if a check fails, restage the one-shot beats:

```sh
node scripts/fuji-seed.mjs --restage   # about 3 minutes, then 12 minutes until the new Rooftop Session has ended
node scripts/pre-record.mjs            # picks the new events up; use their ids in beats 11 and 12
```

`--restage` creates a new Saigon Indie Night (Guest A and B hold tickets, to cancel), a new Rooftop Session organized by the Safe that ends 12 minutes later with the quorum met (to settle), and a new Soundcheck Session that ends 9 minutes later with nobody scanned (a no-show for the slide). It does not touch Neon Pulse. Beat 6 resets itself: after the take Guest B holds the ticket and the line is empty again. Beat 3 uses one of Guest A's four Neon Pulse purchases per take; after four takes use Guest B as the buyer and Guest A as the one in line.

Local rehearsal without spending test funds: `./scripts/dev-chain.sh`, `./scripts/demo-seed.sh`, then the app on 8081 and the console on 8093 (see README). The local chain has no Safe, so beat 12 is a single wallet there.
