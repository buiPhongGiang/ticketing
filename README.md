# Ticketing

Bán vé bằng blockchain. Mỗi vé là một NFT (ERC-721), chuyển được giữa các ví, và chỉ người giữ vé cuối cùng mới vào được cửa.

Mỗi sự kiện deploy một contract `EventTicket` riêng.

## Luồng

1. **Phát hành:** ban tổ chức gọi `mint(to, quantity)`, hoặc user tự mua bằng `buy(quantity)` với đúng số tiền `price × quantity`. Nếu `price = 0` thì không có bán công khai.
2. **Chuyển nhượng:** dùng `transferFrom` hoặc `safeTransferFrom` của ERC-721.
3. **Vào cửa:**
   - Người giữ vé ký một thông điệp EIP-712 `CheckIn(uint256 tokenId,uint256 deadline)` rồi đưa QR chứa chữ ký đó.
   - Nhân viên cổng (địa chỉ được `setScanner`) gọi `checkIn(tokenId, deadline, signature)`.
   - Contract kiểm tra chữ ký với `ownerOf(tokenId)` tại đúng lúc đó, nên chỉ chữ ký của người đang giữ vé mới được chấp nhận. QR của chủ cũ hết tác dụng khi vé đã bán, trừ khi vé quay lại đúng ví đó và QR còn hạn. Ví EOA và ví ERC-1271 đều được.
4. **Sau check-in:** vé bị đánh dấu đã dùng và không chuyển được nữa.

Ban tổ chức rút tiền bán vé bằng `withdraw(to)`.

## Build và test

```sh
git submodule update --init --recursive
forge test
```

## Deploy

```sh
export TICKET_NAME="My Show" TICKET_SYMBOL=SHOW TICKET_SUPPLY=1000 \
  TICKET_PRICE_WEI=1000000000000000 ORGANIZER=0x...
forge script script/Deploy.s.sol --rpc-url <RPC_URL> --private-key <KEY> --broadcast
```

## Giới hạn

- Không có trần giá bán lại, phí bán lại, chợ bán lại, hay giới hạn số vé mỗi ví.
- Nhân viên cổng là bên được tin cậy: một scanner giữ chữ ký còn hạn có thể check-in vé đó mà người giữ không có mặt. Nên đặt `deadline` ngắn, khoảng vài phút.
- Contract chưa được audit.
