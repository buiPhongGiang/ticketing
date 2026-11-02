import type { ErrorCode } from './lib/types';

/** Wording agreed in the design's error table. */
const messages: Record<ErrorCode, string> = {
  SoldOut: 'Đã hết vé',
  SaleClosed: 'Chưa mở bán công khai',
  WrongPayment: 'Số tiền không khớp. Tải lại giá rồi thử lại',
  NotScanner: 'Ví này chưa được cấp quyền soát vé',
  SignatureExpired: 'QR đã hết hạn. Nhờ khách ký QR mới',
  InvalidSignature: 'QR không hợp lệ. Nhờ khách tạo QR mới',
  OwnerChanged: 'Chủ vé đã thay đổi. Người đang giữ vé cần tạo QR mới',
  AlreadyCheckedIn: 'Vé này đã vào cửa',
  TicketUsed: 'Vé đã dùng, không chuyển được',
  WithdrawFailed: 'Không rút được tiền',
  NonexistentToken: 'Vé không tồn tại',
  InvalidRecipient: 'Địa chỉ ví nhận không hợp lệ',
  InsufficientFunds: 'Ví không đủ tiền trả cho giao dịch này',
  WrongNetwork: 'Mã này thuộc sự kiện hoặc mạng khác',
  InFlight: 'Có giao dịch trước chưa có kết quả. Đợi hoặc tra lại giao dịch đó rồi thử lại',
  Network: 'Không kết nối được mạng. Thử lại sau',
  Unknown: 'Không rõ lý do',
};

export function messageFor(code: ErrorCode | undefined): string {
  return messages[code ?? 'Unknown'];
}

export function codeOf(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code in messages ? (code as ErrorCode) : 'Unknown';
}
