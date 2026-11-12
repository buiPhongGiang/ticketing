# Ticketing

Bán vé bằng blockchain. Mỗi vé là một NFT (ERC-721), chuyển được giữa các ví, và chỉ người giữ vé cuối cùng mới vào được cửa.

- `src/`: contract `EventTicket`. Mỗi sự kiện deploy một contract riêng.
- `admin/`: web quản trị cho ban tổ chức, đăng nhập bằng ví ngoài (Vite, React).
- `app/`: app di động (Expo, React Native) với các màn hình: Sự kiện, Vé của tôi, Cổng (ví soát vé), Tổng quan (ví ban tổ chức).

## Luồng

1. **Phát hành:** ban tổ chức gọi `mint(to, quantity)`, hoặc user tự mua bằng `buy(quantity)` với đúng số tiền `price × quantity`. Nếu `price = 0` thì không có bán công khai.
2. **Chuyển nhượng:** dùng `transferFrom` hoặc `safeTransferFrom` của ERC-721.
3. **Vào cửa:**
   - Người giữ vé ký một thông điệp EIP-712 `CheckIn(uint256 tokenId,uint256 deadline)` rồi đưa QR chứa chữ ký đó.
   - Nhân viên cổng (địa chỉ được `setScanner`) gọi `checkIn(tokenId, deadline, signature)`.
   - Contract kiểm tra chữ ký với `ownerOf(tokenId)` tại đúng lúc đó, nên chỉ chữ ký của người đang giữ vé mới được chấp nhận. QR của chủ cũ hết tác dụng khi vé đã bán, trừ khi vé quay lại đúng ví đó và QR còn hạn. Ví EOA và ví ERC-1271 đều được.
4. **Sau check-in:** vé bị đánh dấu đã dùng và không chuyển được nữa.

Ban tổ chức rút tiền bán vé bằng `withdraw(to)`.

## Dashboard

Tab **Tổng quan** chỉ hiện với ví là `owner()` của contract (trên chain local: ví "Ban tổ chức"). Màn hình chỉ đọc, không ký giao dịch, tự cập nhật mỗi 15 giây:

- Số vé đã vào cửa, chưa vào cửa, chưa phát hành, số ví đang giữ vé, giá vé và tiền còn trong contract ("Tiền chưa rút"). Đây không phải tổng doanh thu, vì `withdraw` làm số này giảm và vé `mint` không thu tiền.
- Tab **Tường vé**: mỗi vé là một ô (đã vào, chưa vào, chưa phát hành). Bấm vào ô để xem người giữ. Mỗi lần hiện 100 ô.
- Tab **Ví giữ vé**: mỗi ví giữ bao nhiêu vé, đã vào bao nhiêu.
- Tab **Hoạt động**: tối đa 20 sự kiện mới nhất (mua, phát hành, chuyển, vào cửa) kèm thời gian.

Mất mạng thì màn hình giữ số liệu cũ và ghi rõ đó là số liệu của lúc nào.

## Web quản trị

Trang web riêng cho ban tổ chức, không cần backend và không giữ khóa nào:

- **Đăng nhập:** ký một tin nhắn bằng ví trình duyệt (như MetaMask), không tạo giao dịch. Chữ ký được kiểm tra rồi so với `owner()` của contract. Phiên kéo dài tối đa 8 giờ và kết thúc khi đổi ví, đổi mạng hoặc đóng tab.
- **Tổng quan:** tường vé, số liệu, hoạt động và các ví giữ nhiều vé nhất.
- **Danh sách vé:** tìm theo số vé hoặc địa chỉ ví, lọc trạng thái, xuất CSV.
- **Phát hành vé**, **Nhân viên cổng** (cấp và thu hồi quyền), **Doanh thu** (vé bán, vé miễn phí, tiền đã thu, đã rút, chưa rút) và rút tiền.

```sh
./scripts/dev-chain.sh   # ghi admin/.env.dev
cd admin
npm ci
npm run dev              # http://localhost:8091
```

Trong ví, thêm mạng local (RPC `http://127.0.0.1:8545`, chain ID 31337) và nhập khóa thử công khai của anvil số 0, là ví ban tổ chức. Không dùng khóa này trên mạng thật.

Mạng thật: tạo `admin/.env.fuji` với cùng các biến và chạy `npx vite --mode fuji`. Đặt `VITE_DEPLOY_BLOCK` là block triển khai contract, nếu thiếu thì Doanh thu không hiện tổng. `VITE_LOG_CHUNK` là khoảng block lớn nhất RPC cho đọc mỗi lần, mặc định 100.

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

Cách nhanh cho Avalanche Fuji: tạo `.env.fuji` ở thư mục gốc (không commit) với `FUJI_RPC` và 4 ví thử `ORGANIZER_*`, `GUEST_A_*`, `GUEST_B_*`, `GATE_*` (`_ADDRESS`, `_KEY`), nạp AVAX thử cho ví ban tổ chức từ faucet (https://build.avax.network/console/primary-network/faucet), rồi chạy `LOG_CHUNK=2000 ./scripts/fuji-deploy.sh` (2000 khi dùng RPC publicnode.com, 100 với RPC chính thức). Script deploy, chia tiền cho các ví, cấp quyền ví cổng, tạo vài lượt mua mẫu và ghi `app/.env.fuji`, `admin/.env.fuji`. Trên Fuji, app chỉ nhúng khóa ví khách và ví cổng; ban tổ chức dùng web quản trị với ví của mình (ví dụ MetaMask).

Làm thủ công:

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
cd ../admin
npm test                  # đăng nhập, doanh thu, đọc log với anvil thật
npm run e2e               # web quản trị trong Chrome, ví giả ký thật trên anvil
```

## Giới hạn

- **Ví trong app chỉ để demo:** khóa nằm trên máy, gỡ app hoặc mất máy có thể mất vé. Không nạp tài sản thật. App chưa kết nối ví ngoài (WalletConnect).
- `Vé của tôi` duyệt qua `totalMinted` và `ownerOf`, đủ cho demo. Quy mô lớn cần indexer.
- Tên, giờ, địa điểm sự kiện không có trong contract, chúng đến từ cấu hình.
- Không có trần giá bán lại, phí bán lại, chợ bán lại, hay giới hạn số vé mỗi ví. Tiền mua bán lại không đi qua app.
- Mint, cấp quyền scanner và rút tiền nằm ở web quản trị. Tab Tổng quan trong app di động chỉ đọc.
- Màn hình đăng nhập web quản trị chỉ là cửa vào giao diện: quyền thật do `onlyOwner` của contract kiểm tra. Không có tài khoản nhân viên hay phân quyền nhiều cấp.
- Doanh thu cần đọc toàn bộ log từ lúc triển khai. Trên RPC công khai giới hạn 100 block mỗi lần gọi thì việc này rất chậm và có thể bị 429; khi chưa đọc đủ, trang không hiện tổng mà hiện tiến độ. Sự kiện thật nên dùng RPC riêng.
- Danh sách nhân viên cổng dựng từ event `ScannerSet`, nên cũng phụ thuộc phần log đã đọc.
- Dashboard quét toàn bộ vé, tốn 2 lệnh RPC mỗi vé cho mỗi lần cập nhật, đủ cho demo. Quy mô lớn cần indexer. Dữ liệu trên chain là công khai: việc ẩn tab không phải là phân quyền.
- Tab Hoạt động không phải toàn bộ lịch sử: lần đầu chỉ quét 1000 block gần nhất, sau đó đọc tiếp block mới, và app ghi rõ số block đã quét. RPC Fuji công khai giới hạn `eth_getLogs` 100 block mỗi lần gọi và trả HTTP 429 khi gọi dồn dập, nên chạy sự kiện thật cần RPC riêng.
- Nhân viên cổng là bên được tin cậy: một scanner giữ chữ ký còn hạn có thể check-in vé đó mà người giữ không có mặt. App đặt hạn QR 3 phút.
- Contract chưa được audit.
