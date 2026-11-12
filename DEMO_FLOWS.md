# Demo flows

Chain local (anvil), một sự kiện 20 vé ("Demo Night", giao diện tiếng Anh), giá 0.01 AVAX. Ví: #0 Ban tổ chức (`owner()`), #1, #2 khách, #3 nhân viên cổng.

## Chuẩn bị

```sh
# Terminal 1: chain + deploy (mỗi lần chạy lại là dữ liệu sạch)
./scripts/dev-chain.sh

# Terminal 2: dữ liệu mẫu (ví #1 mua 3 vé, ví #2 mua 2 vé)
./scripts/demo-seed.sh

# Terminal 3: web quản trị (8091 đang bị container khác chiếm nên dùng 8093)
cd admin && npx vite --mode dev --port 8093 --strictPort    # http://localhost:8093

# Terminal 4: app (Expo web)
cd app && npm run web                                       # http://localhost:8081
```

Ví trình duyệt cho web quản trị: MetaMask có mạng local (RPC `http://127.0.0.1:8545`, chain ID 31337) và đã nhập khóa thử công khai số 0 của anvil. Bản quay ngày 11/11/2026 dùng ví thử chèn vào trang (chuyển tiếp tới tài khoản #0 đã mở khóa của anvil) nên không có popup MetaMask.

## Flow 1 · Đăng nhập web quản trị — http://localhost:8093

1. "Sign in with wallet" → Chỉ ví ban tổ chức vào được
2. (bấm, ký trong ví) Địa chỉ ví ở góc trái dưới → Đã vào bằng ví ban tổ chức, không tốn phí
3. Ô "Not withdrawn" → Số liệu đọc thẳng từ contract
4. Ticket wall → Mỗi ô là một vé NFT
5. "Activity" → Lịch sử mua đọc từ event on-chain

## Flow 2 · Phát hành vé

1. Menu "Issue tickets" → Ban tổ chức mint vé tặng
2. Ô địa chỉ (gõ địa chỉ ví #2) → Kiểm tra địa chỉ hợp lệ
3. Ô số lượng (gõ 2) → Không vượt số vé còn lại
4. (bấm "Issue tickets", xác nhận trong MetaMask) → Chỉ báo xong khi chain xác nhận
5. "Overview" → Ticket wall có thêm 2 ô

## Flow 3 · Nhân viên cổng

1. Menu "Gate staff" → Danh sách ví được soát vé
2. Ví #3 → Ví soát vé đã cấp lúc deploy
3. (gõ địa chỉ ví #1, bấm "Grant access", xác nhận) → Cấp quyền là giao dịch on-chain
4. (bấm "Revoke" ví #1, xác nhận) → Thu hồi ngay

## Flow 4 · Doanh thu và rút tiền

1. Menu "Revenue" → Vé bán và vé tặng tách riêng
2. "Collected" → Tổng từ lịch sử mua
3. "Available" → Số dư contract
4. (bấm "Withdraw", xác nhận) → Có bước xác nhận trước khi rút
5. "Available" sau khi rút → Về 0, "Withdrawn" tăng

## Flow 5 · Danh sách vé

1. Menu "Tickets" → Mọi vé và người giữ
2. Ô tìm kiếm (gõ số vé, hoặc 4 ký tự cuối của ví) → Tìm theo số vé hoặc ví
3. Bộ lọc trạng thái → Lọc đã vào / chưa vào
4. "Export CSV" → Xuất danh sách cho cổng

## Flow 6 · App: mua vé, vào cửa, tổng quan — http://localhost:8081

1. Chọn ví #1, tab "Event", "Buy" → Khách tự mua bằng ví
2. Tab "My tickets" → Vé hiện kèm mã QR đã ký
3. Chọn ví #3, tab "Gate", dán mã QR → Nhân viên soát vé on-chain
4. Kết quả "Welcome in" → Vé bị đánh dấu, không chuyển được
5. Chọn ví #0, tab "Overview" → Ticket wall của ban tổ chức

## Flow 7 · Test (terminal)

```sh
forge test
cd app && npm test && npm run e2e
cd admin && npm test && npm run e2e
```
