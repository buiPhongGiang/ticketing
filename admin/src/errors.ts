// Short Vietnamese words for whatever a wallet, RPC or contract threw.

const CONTRACT_ERRORS: Record<string, string> = {
  BadEvent: 'Kiểm tra lại tên và ngày giờ.',
  BadTier: 'Kiểm tra lại các hạng vé.',
  NotOrganizer: 'Ví này không phải ban tổ chức của sự kiện.',
  NotScanner: 'Ví này không phải nhân viên soát vé.',
  NotHolder: 'Ví này không giữ vé đó.',
  SaleClosed: 'Đã ngừng bán.',
  SoldOut: 'Không còn đủ vé.',
  WalletLimit: 'Ví đã mua đủ số vé cho phép.',
  EventCancelled: 'Sự kiện đã huỷ.',
  EventEnded: 'Sự kiện đã kết thúc.',
  EventNotEnded: 'Sự kiện chưa kết thúc.',
  NotRefundable: 'Sự kiện này không mở hoàn tiền.',
  AlreadySettled: 'Đã quyết toán rồi.',
  DisputeWindow: 'Chưa đủ một nửa số vé vào cửa. Quyết toán mở sau khi kết thúc 48 giờ.',
  DeadlineTooFar: 'Mã QR có hạn quá dài.',
  HolderNotWallet: 'Vé chỉ gửi được tới ví thường, không gửi tới hợp đồng.',
  CompNotResellable: 'Vé mời không bán lại được.',
  BatchTooLarge: 'Quá nhiều vé trong một lần hoàn.',
  SignatureExpired: 'Chữ ký đã hết hạn.',
  InvalidSignature: 'Chữ ký không hợp lệ.',
  AlreadyCheckedIn: 'Vé đã vào cửa.',
  TicketUsed: 'Vé đã dùng.',
  TransferBlocked: 'Vé chỉ đổi chủ qua bán lại.',
  AboveCap: 'Giá vượt trần bán lại.',
  NotListed: 'Vé không được rao bán.',
  PriceChanged: 'Giá đã đổi.',
  OwnListing: 'Đây là vé bạn đang rao.',
  ERC721NonexistentToken: 'Vé không còn tồn tại.',
  ERC721InvalidReceiver: 'Ví nhận không hợp lệ.',
  ERC20InsufficientBalance: 'Không đủ USDC.',
  ERC20InsufficientAllowance: 'Chưa cấp quyền chi USDC.',
  Insufficient: 'Quỹ giữ hộ không đủ số dư.',
  NotFinal: 'Sự kiện còn đang diễn ra. Kết quả chỉ chốt sau khi kết thúc hoặc huỷ.',
  AlreadyRelayed: 'Kết quả đã được gửi sang chuỗi của địa điểm.',
};

/** `override` replaces the words for a contract error where the action gives it a narrower meaning. */
export function failureText(error: unknown, override: Record<string, string> = {}): string {
  const seen = new Set<unknown>();
  let e = error as any;
  let reverted = false;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    if (e.code === 4001 || e.name === 'UserRejectedRequestError') return 'Bạn đã từ chối trong ví.';
    const name: string | undefined = e.data?.errorName ?? e.errorName;
    if (name && (override[name] ?? CONTRACT_ERRORS[name])) return override[name] ?? CONTRACT_ERRORS[name];
    const msg = String(e.shortMessage ?? e.message ?? '');
    // Sentences this console wrote itself (chain.ts, App.tsx) pass through as they are.
    if (e.plain === true && msg) return msg;
    if (/GS0\d\d/.test(msg)) return 'Safe từ chối: chưa đủ chữ ký của các chủ ví.';
    if (/reverted/i.test(msg)) reverted = true;
    if (/insufficient funds/i.test(msg)) return 'Ví không đủ AVAX trả phí giao dịch.';
    if (/429|rate limit|too many requests/i.test(msg)) return 'Mạng đang bận. Thử lại sau ít phút.';
    if (/WaitForTransactionReceiptTimeout|timed? ?out/i.test(e.name ?? '') || /timed? ?out/i.test(msg)) return 'Chưa có kết quả. Kiểm tra trên explorer trước khi gửi lại.';
    if (/Failed to fetch|HTTP request failed|fetch failed/i.test(msg)) return 'Không kết nối được mạng.';
    e = e.cause;
  }
  return reverted ? 'Hợp đồng từ chối giao dịch.' : 'Giao dịch không thành công.';
}
