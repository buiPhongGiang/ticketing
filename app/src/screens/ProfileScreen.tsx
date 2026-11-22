import React, { useMemo } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useApp } from '../app-context';
import { config, explorer } from '../config';
import { agoVi, Avatar, myQueues, ShareBtn, viMessage, whenVi } from '../exchange-ui';
import { formatVnd } from '../format';
import { useLoad } from '../hooks';
import { accountReader, tally } from '../lib/account';
import { guestLabel } from '../lib/exchange';
import type { JournalEntry } from '../lib/types';
import { useUnread } from '../notice-store';
import { color, font } from '../theme';
import { Btn, Center, Display, Ic, Screen, T } from '../ui';

function Counts({ items }: { items: [label: string, value: number | undefined, testID: string][] }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {items.map(([label, value, testID]) => (
        <View key={label} style={{ flex: 1, padding: 12, gap: 2, backgroundColor: color.paper }}>
          <Display size={24} testID={testID}>{value ?? '…'}</Display>
          <T style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>{label}</T>
        </View>
      ))}
    </View>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <View style={{ gap: 8 }}><Display size={18}>{title}</Display>{children}</View>
);
const rowStyle = { minHeight: 56, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingHorizontal: 14, paddingVertical: 10, backgroundColor: color.paper };

/** What one of this device's transactions did, in plain words. */
export function activityLine(e: JournalEntry): string {
  const money = e.amount ? formatVnd(e.amount) : '';
  const q = Number(e.quantity ?? 1);
  switch (e.kind) {
    case 'buy': return `Mua ${q} vé · ${money}`;
    case 'resale': return `Mua vé bán lại #${e.tokenId} · ${money}`;
    case 'list': return e.soldTo ? `Bán vé #${e.tokenId} cho người đầu hàng chờ · ${money}` : `Rao bán vé #${e.tokenId} · ${money}`;
    case 'unlist': return `Gỡ bán vé #${e.tokenId}`;
    case 'refund': return `Nhận hoàn tiền vé #${e.tokenId} · ${money}`;
    case 'checkIn': return `Vào cổng bằng vé #${e.tokenId}`;
    case 'waitJoin': return `Xếp hàng mua vé bán lại · cọc ${money}`;
    case 'waitLeave': return `Rời hàng chờ · nhận lại ${money}`;
    case 'credit': return `Rút tiền cọc dư · ${money}`;
    default: return 'Nhận tiền dùng thử';
  }
}
const stateLine: Partial<Record<JournalEntry['state'], string>> = { submitting: 'Đang gửi', pending: 'Đang xác nhận', unknown: 'Chưa rõ kết quả', reverted: 'Không thành công' };

/** The guest's own page: what they hold and offer, the lines they stand in, and everything this device did, each with its proof. */
export function ProfileScreen() {
  const app = useApp();
  const unread = useUnread();
  const { data: tickets, error } = useLoad(() => app.service.listTickets(), []);
  const { data: journal } = useLoad(() => app.service.journal(), []);
  const { data: events } = useLoad(() => app.service.getEvents(), []);
  const { data: queues } = useLoad(() => myQueues(app.service), [app.wallet.address]);
  const held = tickets?.filter((t) => t.status !== 'sold');
  const listed = held?.filter((t) => t.listPrice !== '0' && t.event.status === 'onsale') ?? [];
  const places = (queues ?? []).flatMap((q) => q.states.map((s) => ({ eventId: q.eventId, ...s })));
  const nameOf = (eventId: string) => events?.find((e) => e.id === eventId);
  const recent = [...(journal ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);

  return (
    <Screen title="Tôi" nav="me">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Avatar account={app.wallet.address} size={64} />
        <View style={{ flex: 1 }}>
          <Display size={24} testID="me-name">{guestLabel(app.wallet.address)}</Display>
          <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Tài khoản tạo sẵn trên máy này. Người khác thấy bạn dưới tên này.</T>
        </View>
      </View>

      <Pressable testID="me-notices" accessibilityRole="button" onPress={() => app.go({ name: 'notices' })} style={[rowStyle, unread ? { backgroundColor: color.amberSoft } : null]}>
        <Ic name="bell" size={18} />
        <T style={{ flex: 1, fontFamily: font.semibold }}>{unread ? `${unread} thông báo mới` : 'Thông báo'}</T>
        <Ic name="next" size={18} tint={color.muted} />
      </Pressable>

      {error && !tickets ? <T testID="me-error">{viMessage(error)}</T> : null}
      <Counts items={[['Vé đang giữ', held?.length, 'me-held'], ['Đang rao bán', held ? listed.length : undefined, 'me-listed'], ['Đã vào cổng', held?.filter((t) => t.checkedIn).length, 'me-checked']]} />

      <Section title="Vé đang rao">
        {listed.map((t) => (
          <Pressable key={t.tokenId} testID={`me-listing-${t.tokenId}`} accessibilityRole="button" onPress={() => app.go({ name: 'listing', tokenId: t.tokenId })} style={rowStyle}>
            <View style={{ flex: 1 }}>
              <T lines={1} style={{ fontFamily: font.semibold }}>{t.event.name}</T>
              <T lines={1} style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>#{t.tokenId} · {t.tierName} · thêm ghi chú cho người mua</T>
            </View>
            <T style={{ fontFamily: font.bold }}>{formatVnd(t.listPrice)}</T>
            <Ic name="next" size={18} tint={color.muted} />
          </Pressable>
        ))}
        {held && listed.length === 0 ? <T testID="me-listings-empty" style={{ color: color.muted }}>Bạn chưa rao vé nào. Không đi được thì mở vé và chọn bán lại, giá không quá giá gốc +10%.</T> : null}
      </Section>

      <Section title="Hàng chờ của tôi">
        {places.map((p) => {
          const e = nameOf(p.eventId);
          return (
            <Pressable key={`${p.eventId}:${p.tier}`} testID={`me-queue-${p.eventId}-${p.tier}`} accessibilityRole="button" onPress={() => app.go({ name: 'market', eventId: p.eventId })} style={rowStyle}>
              <Ic name="hourglass" size={18} />
              <View style={{ flex: 1 }}>
                <T lines={1} style={{ fontFamily: font.semibold }}>{e?.name ?? `Sự kiện ${p.eventId}`}</T>
                <T lines={1} style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{e?.tiers[p.tier]?.name ?? ''} · thứ {p.position} trong {p.waiting} người · cọc {formatVnd(p.deposit)}</T>
              </View>
              <Ic name="next" size={18} tint={color.muted} />
            </Pressable>
          );
        })}
        {queues && places.length === 0 ? <T testID="me-queues-empty" style={{ color: color.muted }}>Bạn không xếp hàng ở đâu. Hết vé thì vào Chợ vé, chọn sự kiện và xếp hàng mua.</T> : null}
      </Section>

      <Section title="Hoạt động">
        {recent.map((e) => (
          <View key={e.id} testID={`me-activity-${e.kind}`} style={[rowStyle, { alignItems: 'flex-start' }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <T style={{ fontFamily: font.semibold }}>{activityLine(e)}</T>
              <T style={{ fontSize: 13, lineHeight: 18, color: e.state === 'reverted' ? color.orange : color.muted }}>{[nameOf(e.eventId ?? '')?.name, agoVi(Math.floor(e.createdAt / 1000)), stateLine[e.state]].filter(Boolean).join(' · ')}</T>
            </View>
            {explorer ? (
              <Pressable testID="me-proof" accessibilityRole="link" accessibilityLabel="Mở bằng chứng công khai của thao tác này" onPress={() => Linking.openURL(`${explorer}/tx/${e.hash}`)} style={{ minHeight: 44, justifyContent: 'center' }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><T style={{ fontFamily: font.semibold, fontSize: 13, color: color.blue }}>Bằng chứng</T><Ic name="external" size={14} tint={color.blue} /></View>
              </Pressable>
            ) : null}
          </View>
        ))}
        {journal && recent.length === 0 ? <T testID="me-activity-empty" style={{ color: color.muted }}>Chưa có gì. Mỗi lần mua, bán hay xếp hàng trên máy này sẽ hiện ở đây kèm bằng chứng công khai.</T> : null}
      </Section>

      <View style={{ gap: 8 }}>
        <Btn testID="me-account" label="Tài khoản và biên lai" kind="secondary" onPress={() => app.go({ name: 'wallet' })} />
        <ShareBtn testID="me-share" target={{ kind: 'user', id: app.wallet.address }} text={`Trang của ${guestLabel(app.wallet.address)} trên Vé Gốc`} />
      </View>
    </Screen>
  );
}

/** Another account's public page: counts read from the ticket contract and the tickets it offers now. No scores. */
export function UserScreen({ account }: { account: string }) {
  const app = useApp();
  const reader = useMemo(() => accountReader(config), []);
  const { data: tickets, error, reload } = useLoad(() => reader.ticketsOf(account), [account]);
  const { data: events } = useLoad(() => app.service.getEvents(), []);
  const counts = tickets ? tally(tickets) : undefined;
  const offers = (tickets ?? []).filter((t) => t.listPrice !== '0' && events?.find((e) => e.id === t.eventId)?.status === 'onsale');
  const me = account.toLowerCase() === app.wallet.address.toLowerCase();
  return (
    <Screen title={guestLabel(account)} back nav="market">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Avatar account={account} size={64} />
        <View style={{ flex: 1 }}>
          <Display size={24} testID="user-name">{guestLabel(account)}</Display>
          <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{me ? 'Đây là trang người khác thấy về bạn.' : 'Tên lấy từ mã tài khoản, không ai tự đặt được.'}</T>
        </View>
      </View>
      {error && !tickets ? <View style={{ gap: 12 }}><T testID="user-error">{viMessage(error)}</T><Btn label="Thử lại" kind="secondary" onPress={reload} /></View> : null}
      {!tickets && !error ? <Center /> : null}
      {counts ? <>
        <Counts items={[['Vé đang giữ', counts.held, 'user-held'], ['Đang rao bán', counts.listed, 'user-listed'], ['Đã vào cổng', counts.checkedIn, 'user-checked']]} />
        <T testID="user-source" style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>Ba con số này đọc thẳng từ sổ vé công khai tại lúc bạn mở trang. Ở đây không có điểm uy tín hay đánh giá tự đặt.</T>
        <Section title="Vé đang rao">
          {offers.map((t) => {
            const e = events!.find((x) => x.id === t.eventId)!;
            return (
              <Pressable key={t.tokenId} testID={`user-listing-${t.tokenId}`} accessibilityRole="button" onPress={() => app.go({ name: 'listing', tokenId: t.tokenId })} style={rowStyle}>
                <View style={{ flex: 1 }}>
                  <T lines={1} style={{ fontFamily: font.semibold }}>{e.name}</T>
                  <T lines={1} style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>#{t.tokenId} · {e.tiers[t.tier]?.name ?? ''} · {whenVi(e.startsAt, e.endsAt)}</T>
                </View>
                <T style={{ fontFamily: font.bold }}>{formatVnd(t.listPrice)}</T>
                <Ic name="next" size={18} tint={color.muted} />
              </Pressable>
            );
          })}
          {events && offers.length === 0 ? <T testID="user-listings-empty" style={{ color: color.muted }}>Hiện không rao vé nào.</T> : null}
        </Section>
      </> : null}
    </Screen>
  );
}
