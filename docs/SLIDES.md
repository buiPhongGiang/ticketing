# Slides: 10-slide outline

Text ready to paste. One idea per slide; numbers are the ones in the README and on Fuji.

## 1. Title

**Vé Gốc**: concert tickets whose resale price is capped on chain at face value +10 %.

Team1 Vietnam UniHack 2026 · topic 9 "Capped-resale NFT tickets with yielding float" · live on Avalanche Fuji (testnet).

## 2. Problem

BIGBANG Hanoi, 24 and 25 Oct 2026: Diamond VIP tickets with a face value of 9.8 million VND were advertised by resellers for 45 million, about 4.6 times.

Sources: CafeF (seat map and prices, 3 Aug 2026); DTiNews (13 Aug 2026).

Ticketbox alone sold more than 1 million concert and festival tickets in Vietnam in 2025 (VOV, 17 Dec 2025, citing Ticketbox).

## 3. Solution in one sentence

A ticket is an NFT that can only change hands through a built-in market at face value +10 % at most, goes to the first wallet in line, and opens the gate only with a QR signed by whoever holds it right now.

## 4. How it works

Diagram (from `docs/ARCHITECTURE.md`, "System"):

```
Guest app ──buy / list / join line──▶ VeGoc (ERC-721, cap, waitlist, gate) ──▶ FloatVault (escrow per event)
Gate phone ──checkIn(holder's EIP-712 signature)──▶ VeGoc
Organizer console ──through a 2-of-3 Safe──▶ settle: 97 % to the organizer, 3 % platform fee
Relayer ──buyFor(buyer's signature)──▶ VeGoc   (the buyer needs no AVAX)
```

Three rules in code:
- Resale above face +10 % reverts; transfers outside the market revert.
- A seller cannot pick the buyer: the first wallet in line gets the next listed ticket.
- Scans decide the money: at least half of the paid tickets scanned, the organizer is paid; fewer, every unscanned holder can take a refund and the organizer waits 48 hours.

## 5. Demo screenshots

- `docs/img/app-screens.png`: event, purchase receipt with block time and fee, "Max 27.50" refused at 30, Guest B first in line, NO ENTRY for the old QR, WELCOME IN, no-show refund.
- `docs/img/console-overview.png`: Neon Pulse Festival organized by the Safe, ticket wall, escrow, resale stats.
- No-show, one line: Soundcheck Session ended with nobody scanned; holders refunded, `settle` reverted `DisputeWindow` for 48 hours.

## 6. Why on-chain, why Avalanche (measured)

- On-chain: the cap, the transfer block, the escrow and the refund rules cannot be changed by the organizer or the platform after a sale. A buyer can check on Snowtrace that the money is still in the vault.
- Avalanche, measured on Fuji (medians of three rounds, 19 Nov 2026): a check-in is in a block 0.3 s after sending, a purchase 0.8 s; the receipt from a public RPC after 2.5 to 3.2 s.
- Cost at the C-Chain mainnet base fee (7.5 nAVAX): a purchase with Circle's USDC 255,310 gas = 0.0019 AVAX; a check-in 55,870 gas = 0.0004 AVAX. 10,000 purchases and check-ins: 23.4 AVAX.
- Circle issues USDC natively on the C-Chain and Fuji; the same contracts run against it (second deployment). Canonical Safe v1.4.1; Avalanche Data API for the console's activity feed.

## 7. Where the money comes from

- The platform takes 3 % of each settled event's primary sales (`feeBps = 300`, paid by `settle` to the Safe). Nothing on cancel or no-show refunds.
- Worked example (our assumption: 10,000 seats at 2,000,000 VND): 20 billion VND sales, 600 million VND fee.
- Market ceiling, our assumption on the Ticketbox figure: 1 million tickets × 2,000,000 VND × 3 % = 60 billion VND a year.
- Comparison: Eventbrite 3.7 % + 1.79 USD per ticket plus 2.9 % processing (US pricing page).

## 8. Vietnamese law: what stays on chain

- Crypto assets are not a lawful means of payment (State Bank). Resolution 05/2025/NQ-CP: crypto trading only in VND through providers licensed by the Ministry of Finance; no licence confirmed as of 15 Sep 2026 (Finwire).
- So in Vietnam: tickets are paid in VND through a licensed payment intermediary. The USDC escrow is off, and with it automatic refunds, the no-show rule and the on-chain 3 % fee. The fee is invoiced in VND.
- What stays on chain: the resale cap, the transfer block and the gate QR.
- The USDC escrow applies only where paying in a stablecoin is legal. No legal review yet.

## 9. What is mock, and the limits

- Testnet only, not audited. MockUSDC with a faucet on the main deployment; mock 5 % yield paid from a funded reserve; three built-in test wallets; the audience is seeded by script.
- The three Safe owner keys are team keys on one laptop.
- An organizer who buys half the paid tickets and scans them can still fake the quorum; it costs them the 3 % fee on those tickets.
- With nobody in line, a listing goes to the first taker, so a scalper's named customer can still win the race.
- A contract wallet (Safe, ERC-4337, EIP-7702) cannot hold a ticket; relayed purchases (`buyFor`) let a plain wallet buy without gas. Embedded wallet with phone sign-in: not built.
- If the gate fails, the organizer must extend the event (`extendEvent`, up to 24 h) or unscanned holders can refund.

## 10. Team, links, addresses

- buiPhongGiang.
- Repo: github.com/buiPhongGiang/ticketing · Video: _link_
- Avalanche Fuji (43113):
  - VeGoc `0x6f5802cDeeA534B66067607875E2E284feC93EF2`
  - FloatVault `0x74Fb6051201c3E0CdF2D37B1753Ae35D51360A06`
  - Safe 2 of 3 `0x96aDD8A7c64d93818cc71eb6E97Db478a091bc41`
  - Circle USDC deployment: VeGoc `0xe5c2aa021be8bc725b35a6e9cd30ab8e43c6ebeb`, FloatVault `0x426174f593a19db398131b84d62a3b9eef23f7e4`
