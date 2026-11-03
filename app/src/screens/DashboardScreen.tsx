import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { config, eventInfo } from '../config';
import { formatAmount } from '../format';
import { useLoad, useMounted } from '../hooks';
import { dashboardReader } from '../dashboard-reader';
import type { DashboardSnapshot, DashboardTicket } from '../lib/dashboard';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Banner, Btn, Center, Display, Icon, Mono, Row, Screen, short, T } from '../ui';

const POLL_MS = 15_000;
const PAGE = 50;
/** A block narrower than this share of the bar has no room for its number. */
const MIN_LABEL_SHARE = 0.1;

const two = (n: number) => String(n).padStart(2, '0');
function timeOf(ms: number) {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function DashboardScreen() {
  const { data, error, loading, reload } = useLoad(() => dashboardReader.read(), []);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useMounted();

  // Skip a tick while a scan is still running: a new one would discard it, and a slow scan would never finish.
  const busy = useRef(loading);
  busy.current = loading;
  useEffect(() => {
    const timer = setInterval(() => { if (!busy.current) reload(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  async function refresh() {
    setRefreshing(true);
    await reload();
    if (mounted.current) setRefreshing(false);
  }

  const problem = error ? messageFor(codeOf(error) === 'Unknown' ? 'Network' : codeOf(error)) : null;
  return (
    <Screen title="Tổng quan" nav="dashboard" footer={<Btn testID="dash-refresh" label="Làm mới" kind="secondary" busy={refreshing} onPress={refresh} />}>
      <T style={{ color: color.muted }}>{eventInfo.name} · {eventInfo.when} · {eventInfo.venue}</T>
      {problem && data ? <Banner testID="dash-stale" tone="amber" icon="off" body={`${problem}. Số liệu dưới đây là của lúc ${timeOf(data.readAt)}.`} /> : null}
      {problem && !data ? <T testID="dash-error">{problem}</T> : null}
      {!data && !problem ? <Center /> : null}
      {data ? <Overview data={data} /> : null}
    </Screen>
  );
}

function Overview({ data }: { data: DashboardSnapshot }) {
  const [shown, setShown] = useState(PAGE);
  return <>
    <View style={{ backgroundColor: color.white, padding: 20, gap: 12 }}>
      <T style={{ fontFamily: font.medium }}>Đã vào cửa</T>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Display size={64} testID="dash-entered">{data.entered}</Display>
        <T style={{ color: color.muted }}>/ {data.issued} vé đã phát hành</T>
      </View>
      <Progress data={data} />
    </View>
    <View>
      <Row label="Chưa vào cửa" testID="dash-waiting" value={String(data.waiting)} />
      <Row label="Chưa phát hành" testID="dash-unsold" value={`${data.unsold} / ${data.maxSupply}`} />
      <Row label="Ví đang giữ vé" testID="dash-holders" value={String(data.holders)} />
      <Row label="Giá mỗi vé" value={data.priceWei === '0' ? 'Không bán công khai' : formatAmount(data.priceWei, config.nativeSymbol)} />
      <Row label="Tiền chưa rút" testID="dash-balance" value={formatAmount(data.balanceWei, config.nativeSymbol)} />
    </View>
    <Mono testID="dash-updated" style={{ color: color.muted }}>Cập nhật lúc {timeOf(data.readAt)}</Mono>
    <View style={{ gap: 4 }}>
      <Display>Danh sách vé</Display>
      {data.tickets.length === 0 ? <T testID="dash-empty" style={{ color: color.muted }}>Chưa có vé nào được phát hành.</T> : null}
      {data.tickets.slice(0, shown).map((t) => <TicketRow key={t.tokenId} ticket={t} />)}
    </View>
    {data.tickets.length > shown ? <Btn testID="dash-more" label={`Xem thêm (còn ${data.tickets.length - shown} vé)`} kind="secondary" onPress={() => setShown(shown + PAGE)} /> : null}
  </>;
}

function Progress({ data }: { data: DashboardSnapshot }) {
  const parts = [
    { name: 'Đã vào cửa', value: data.entered, bg: color.blue, fg: color.white },
    { name: 'Chưa vào cửa', value: data.waiting, bg: color.blueMid, fg: color.ink },
    { name: 'Chưa phát hành', value: data.unsold, bg: color.paper, fg: color.ink },
  ];
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  return (
    <View style={{ gap: 8 }}>
      <View testID="dash-bar" accessible accessibilityRole="image" accessibilityLabel={parts.map((p) => `${p.name}: ${p.value}`).join(', ')} style={{ flexDirection: 'row', gap: 2, height: 28 }}>
        {parts.filter((p) => p.value > 0).map((p) => (
          <View key={p.name} style={{ flexGrow: p.value, flexBasis: 0, minWidth: 4, backgroundColor: p.bg, borderRadius: 4, justifyContent: 'center', paddingHorizontal: 6 }}>
            {p.value / total >= MIN_LABEL_SHARE ? <Mono style={{ color: p.fg }}>{p.value}</Mono> : null}
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 }}>
        {parts.map((p) => (
          <View key={p.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 12, height: 12, borderRadius: 2, backgroundColor: p.bg, borderWidth: 1, borderColor: p.bg === color.paper ? color.muted : p.bg }} />
            <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{p.name}</T>
          </View>
        ))}
      </View>
    </View>
  );
}

function TicketRow({ ticket }: { ticket: DashboardTicket }) {
  return (
    <View testID={`dash-ticket-${ticket.tokenId}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, borderBottomWidth: 1, borderBottomColor: color.line }}>
      <T style={{ fontFamily: font.semibold, width: 48 }}>#{ticket.tokenId}</T>
      <Mono style={{ flex: 1 }}>{short(ticket.owner)}</Mono>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        {ticket.checkedIn ? <Icon name="check" size={16} tint={color.blue} /> : null}
        <T style={{ fontSize: 14, fontFamily: ticket.checkedIn ? font.semibold : font.body, color: ticket.checkedIn ? color.ink : color.muted }}>{ticket.checkedIn ? 'Đã vào' : 'Chưa vào'}</T>
      </View>
    </View>
  );
}
