# ui-gaps: what is already on this branch (read after rebasing)

For the agents working on `ui-gaps-social` and `ui-gaps-admin`. One line per thing already built here, so nobody builds it twice.

## Guest app (`app/`)
- VND checkout: `src/screens/PayScreen.tsx` (mock VietQR / MoMo sheet), `src/screens/ReceiptScreen.tsx` ("Kiểm tra"), `src/lib/pay.ts`, routes `pay` and `receipt` in `src/app-context.ts` + `App.tsx`. Turned on by `EXPO_PUBLIC_PAY=vnd-mock` (`payOn` in `src/config.ts`); then no balance and no test-money button are shown.
- Account screen (`WalletScreen.tsx`, non-demo): a "Payments" list of receipts. Ticket screen: a "Payment receipt" row. After a refund: a mock bank payout receipt (`TxScreen.tsx`).
- Likes and comments on events: `src/lib/social.ts`, `src/social-ui.tsx` (`useSocialFeed`, `LikeButton`, `CommentCount`, `Comments`), used in `EventsScreen.tsx` (row under the photo) and `EventScreen.tsx` (heart next to "going", thread at the bottom). `EXPO_PUBLIC_SOCIAL=1` (`socialOn`). Only ticket holders can comment. The share buttons now show "↗"; the speech bubble means comments.
- `LocalSigner.signMessage(text)` exists (EIP-191), used for likes and comments.

## Relayer (`app/scripts/`)
- `payments.ts`: `/pay/create`, `/pay/status`, `/pay/payout`, `/pay/ledger`, `/webhook/payment` (HMAC), `/mock-bank/transfer`. `social.ts`: `/social/feed`, `/social/comments`, `/social/like`, `/social/comment`.
- `relay-server.ts`: `backend.handle(path, body, { raw, signature, ip })`; limits for the routes above live in `gateCheck`; logs carry time, IP, route, status and error code only. A new backend module is wired in `scripts/relayer.ts` (`backend.handle` chain) and needs its routes added to `gateCheck`, or they answer 404.
- `src/lib/relayer.ts`: `relayer.pay.*` (quote, fund, minted, record, refundOf), `relayer.eventExists`, `relayer.holdsTicket`.

## Contracts
- `src/PaymentReceipts.sol`, on Fuji at `0xfedAB7C39c280c027A4966e16fb6Df1F29C26a84` (verified); recorder = the relayer `0x058b…FAA1`.

## Console (`admin/`), already here; `ui-gaps-admin` owns it from now on
- "Đối soát" tab: `src/recon.ts`, `src/ReconPanel.tsx` (needs `VITE_RECEIPTS`, `VITE_RECEIPTS_FROM_BLOCK`, `VITE_RELAYER_URL`).
- Read-only visit ("Look around without a wallet"): `App.tsx` (`VISITOR`, `readOnly` passed down), `ReadOnlyNote` in `EventConsole.tsx`; `VITE_ORGANIZERS` filters what a visitor sees.
- Gate staff tab: `ExtendPanel` (extendEvent), the venue L1 read directly (`src/l1.ts`, `DoorLogBlock` in `VenueDoor.tsx`; `VITE_VENUE_RPC`, `VITE_GATE_LOG`), `OutcomePanel` (AttendanceRelay on Fuji, AttendanceMirror on vegoc; `VITE_ATTENDANCE_RELAY`, `VITE_MIRROR`).
- `useTx.run` takes a VeGoc call or an `OpenCall` (any contract, never through the Safe) and an optional map of error words.
- e2e: read-only visit and extend (`e2e/admin.spec.ts`, last two tests).

## Previews on the Pi
- `ui-gaps`: app :7106, console :7107, relayer 127.0.0.1:7108 (`team1-ticketing-gaps-relayer`, `/data/team1/ticketing-gaps`).
