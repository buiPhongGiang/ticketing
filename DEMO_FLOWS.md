# Demo flows

Order used for the demo video (Fuji). App: Expo web, wallets Guest A / Guest B / Gate staff switched from the address chip. Console: organizer wallet signs in once (signature only).

| # | Where | Action | On screen |
|---|---|---|---|
| 1 | App · Guest A | Events → Neon Pulse Festival | tiers GA 25 / VIP 60 USDC, max 4 per wallet |
| 2 | App · Guest A | My tickets → + Test USDC | balance +1,000 USDC (faucet, mock) |
| 3 | App · Guest A | Event → GA → Buy · 25.00 USDC | "Bought 1 ticket", network fee, new ticket |
| 4 | App · Guest A | Ticket → Show QR | QR with 3:00 countdown (keep it) |
| 5 | App · Guest A | Ticket → Resell → type 30 | "Max 27.50 USDC", button disabled |
| 6 | App · Guest A | preset Cap +10% → List | ticket shows "Listed · 27.50 USDC" |
| 7 | App · Guest B | Event → Resale → Buy | "Bought #N on resale · 27.50 USDC" |
| 8 | App · Gate | Gate → paste A's old QR → Check | NO ENTRY · Ticket changed hands |
| 9 | App · Guest B | Ticket → Show QR; Gate pastes it | TICKET #N VALID → Confirm → WELCOME IN |
| 10 | App · Gate | paste the same QR again | NO ENTRY · Already checked in |
| 11 | Console | Overview of Neon Pulse | ticket wall, float + live mock yield, resale stats, activity with Snowtrace links |
| 12 | Console | Saigon Indie Night → Money → Cancel → Refund all | refunds sent, float back to 0 |
| 13 | App · Guest A | My tickets | (refunded) USDC balance back |
| 14 | Console | Rooftop Session (ended) → Settle | principal + mock yield to organizer |

Local rehearsal: `./scripts/dev-chain.sh`, `./scripts/demo-seed.sh`, then app on 8081 and console on 8093 (see README).
