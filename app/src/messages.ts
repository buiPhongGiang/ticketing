import { demoMode } from './config';
import type { ErrorCode } from './lib/types';

const messages: Record<ErrorCode, string> = {
  SoldOut: 'Đã hết vé',
  SaleClosed: 'Chưa mở bán',
  WalletLimit: 'Bạn đã mua đủ số vé cho sự kiện này',
  EventCancelled: 'Sự kiện đã bị hủy',
  EventEnded: 'Sự kiện đã kết thúc',
  NotScanner: 'Thiết bị này không được soát vé sự kiện này',
  NotHolder: 'Vé này không phải của bạn',
  SignatureExpired: 'Mã QR đã hết hạn',
  InvalidSignature: 'Mã QR không hợp lệ',
  AlreadyCheckedIn: 'Vé đã vào cửa rồi',
  TicketUsed: 'Vé đã được dùng',
  TransferBlocked: 'Vé chỉ đổi chủ qua kênh bán lại',
  AboveCap: 'Cao hơn giá trần bán lại',
  NotListed: 'Vé không còn được rao bán',
  PriceChanged: 'Giá đã thay đổi',
  OwnListing: 'Đây là vé bạn đang rao',
  NotRefundable: 'Sự kiện này không mở hoàn tiền',
  FaucetCooldown: 'Tiền thử: thử lại sau 5 phút',
  DeadlineTooFar: 'Mã QR có hạn quá dài',
  HolderNotWallet: 'Vé chỉ cấp cho tài khoản cá nhân',
  CompNotResellable: 'Vé mời không bán lại được',
  WaitlistFirst: 'Đang có người xếp hàng chờ hạng vé này',
  ListingsOpen: 'Đang có vé bán lại, bạn mua ngay được',
  AlreadyWaiting: 'Bạn đã xếp hàng cho hạng vé này',
  NotWaiting: 'Bạn không ở trong hàng chờ',
  BadEvent: 'Không tìm thấy sự kiện',
  BadTier: 'Không tìm thấy hạng vé',
  OwnerChanged: 'Vé đã đổi chủ',
  NonexistentToken: 'Vé không tồn tại',
  InsufficientUsdc: 'Số dư không đủ',
  InsufficientFunds: demoMode ? 'Không đủ AVAX để trả phí' : 'Chưa thực hiện được. Bạn thử lại nhé',
  WrongNetwork: 'Sai sự kiện hoặc sai mạng',
  InFlight: 'Thao tác trước chưa xong',
  NotInSnapshot: 'Vé không có trong danh sách ngoại tuyến',
  StaleList: 'Danh sách ngoại tuyến quá cũ. Hãy kết nối lại',
  GatePin: 'Sai mã PIN soát vé',
  RateLimited: 'Thử quá nhiều lần. Chờ một phút nhé',
  RelayerLow: 'Hệ thống đang bận. Bạn thử lại sau',
  PayExpired: 'Mã thanh toán đã hết hạn. Bạn làm lại nhé',
  PayUnknown: 'Không tìm thấy khoản thanh toán',
  PayOff: 'Máy chủ này chưa bật thanh toán',
  CommentEmpty: 'Bạn chưa viết gì',
  NeedTicket: 'Chỉ người có vé mới bình luận được',
  Network: 'Không kết nối được mạng',
  Unknown: 'Có lỗi xảy ra',
};

export function messageFor(code: ErrorCode | undefined): string {
  return messages[code ?? 'Unknown'];
}

export function codeOf(error: unknown): ErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code in messages ? (code as ErrorCode) : 'Unknown';
}
