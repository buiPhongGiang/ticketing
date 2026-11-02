# Ticketing

Bán vé bằng blockchain. Mỗi vé là một NFT (ERC-721), chuyển được giữa các ví, và chỉ người giữ vé cuối cùng mới vào được cửa.

- `src/`: contract `EventTicket`. Mỗi sự kiện deploy một contract riêng.
- `app/`: app di động (Expo, React Native) với 3 màn hình: Sự kiện, Vé của tôi, Cổng.

## Luồng

1. **Phát hành:** ban tổ chức gọi `mint(to, quantity)`, hoặc user tự mua bằng `buy(quantity)` với đúng số tiền `price × quantity`. Nếu `price = 0` thì không có bán công khai.
2. **Chuyển nhượng:** dùng `transferFrom` hoặc `safeTransferFrom` của ERC-721.
3. **Vào cửa:**
   - Người giữ vé ký một thông điệp EIP-712 `CheckIn(uint256 tokenId,uint256 deadline)` rồi đưa QR chứa chữ ký đó.
   - Nhân viên cổng (địa chỉ được `setScanner`) gọi `checkIn(tokenId, deadline, signature)`.
   - Contract kiểm tra chữ ký với `ownerOf(tokenId)` tại đúng lúc đó, nên chỉ chữ ký của người đang giữ vé mới được chấp nhận. QR của chủ cũ hết tác dụng khi vé đã bán, trừ khi vé quay lại đúng ví đó và QR còn hạn. Ví EOA và ví ERC-1271 đều được.
4. **Sau check-in:** vé bị đánh dấu đã dùng và không chuyển được nữa.

Ban tổ chức rút tiền bán vé bằng `withdraw(to)`.

## Chạy thử trên máy

Cần Foundry và Node 22 trở lên (`app/.nvmrc`).

```sh
git submodule update --init --recursive
forge build

# Terminal 1: chain local, deploy một sự kiện, ghi app/.env.dev
./scripts/dev-chain.sh

# Terminal 2
cd app
npm ci
npm run ios
```

App có sẵn 4 ví thử (Ban tổ chức, Khách A, Khách B, Cổng), đổi bằng cách bấm vào địa chỉ ví ở góc trên. Các ví này chỉ xuất hiện trên chain local 31337.

Chạy trên điện thoại thật: `RPC_HOST=<IP máy tính trong mạng LAN> ./scripts/dev-chain.sh`, rồi mở bằng Expo Go. Quét QR bằng camera cần điện thoại thật; trên Simulator hãy dùng "Sao chép mã" và ô dán mã ở màn hình Cổng.

## Chạy trên mạng thật (ví dụ Fuji)

```sh
export TICKET_NAME="My Show" TICKET_SYMBOL=SHOW TICKET_SUPPLY=1000 \
  TICKET_PRICE_WEI=1000000000000000 ORGANIZER=0x...
forge script script/Deploy.s.sol --rpc-url <RPC_URL> --private-key <KEY> --broadcast
cast send <CONTRACT> 'setScanner(address,bool)' <VÍ_CỔNG> true --rpc-url <RPC_URL> --private-key <KEY>
```

Rồi tạo `app/.env.fuji`:

```sh
EXPO_PUBLIC_CHAIN_ID=43113
EXPO_PUBLIC_RPC_URL=<RPC_URL>
EXPO_PUBLIC_CONTRACT=<CONTRACT>
EXPO_PUBLIC_NATIVE_SYMBOL=AVAX
EXPO_PUBLIC_NETWORK_NAME=Fuji
EXPO_PUBLIC_EVENT_NAME="<TÊN>"
EXPO_PUBLIC_EVENT_WHEN="<NGÀY GIỜ>"
EXPO_PUBLIC_EVENT_VENUE="<ĐỊA ĐIỂM>"
```

và chạy bằng `ENV_FILE=.env.fuji npm run ios`.

Mỗi máy tự sinh một ví trong app. Mở ví trong app để lấy địa chỉ rồi nạp AVAX thử nghiệm. Ví của máy soát vé cần được `setScanner` và có tiền trả phí.

## Test

```sh
forge test                # contract
cd app
npm test                  # logic chain với anvil thật
npm run e2e               # toàn bộ flow trong Chrome (Expo web, 390×844)
```

## Giới hạn

- **Ví trong app chỉ để demo:** khóa nằm trên máy, gỡ app hoặc mất máy có thể mất vé. Không nạp tài sản thật. App chưa kết nối ví ngoài (WalletConnect).
- `Vé của tôi` duyệt qua `totalMinted` và `ownerOf`, đủ cho demo. Quy mô lớn cần indexer.
- Tên, giờ, địa điểm sự kiện không có trong contract, chúng đến từ cấu hình.
- Không có trần giá bán lại, phí bán lại, chợ bán lại, hay giới hạn số vé mỗi ví. Tiền mua bán lại không đi qua app.
- Mint, cấp quyền scanner và rút tiền làm bằng script, không có màn hình.
- Nhân viên cổng là bên được tin cậy: một scanner giữ chữ ký còn hạn có thể check-in vé đó mà người giữ không có mặt. App đặt hạn QR 3 phút.
- Contract chưa được audit.
