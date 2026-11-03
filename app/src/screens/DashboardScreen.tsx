import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useApp } from '../app-context';
import { config, eventInfo } from '../config';
import { dashboardReader } from '../dashboard-reader';
import { formatAmount, timeAgo } from '../format';
import { useLoad, useMounted } from '../hooks';
import { holdersOf, type ActivityEvent, type ActivityKind, type DashboardSnapshot, type DashboardTicket, type Holder } from '../lib/dashboard';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Banner, Btn, Center, Display, Icon, Mono, Nav, short, T, UnresolvedBar } from '../ui';

const POLL_MS = 15_000;
const WALL_PAGE = 100;
const LIST_PAGE = 50;
const RULE = '#2A2C37';
const EMPTY_CELL = '#5A5F70';

type Tab = 'wall' | 'holders' | 'activity';
const TABS: { key: Tab; label: string }[] = [
  { key: 'wall', label: 'Tường vé' },
  { key: 'holders', label: 'Ví giữ vé' },
  { key: 'activity', label: 'Hoạt động' },
];

const two = (n: number) => String(n).padStart(2, '0');
function timeOf(ms: number) {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
const problemOf = (error: unknown) => (error ? messageFor(codeOf(error) === 'Unknown' ? 'Network' : codeOf(error)) : null);

/** Keeps a read fresh. Skips a tick while one is running: a new read would discard it, so a slow scan would never finish. */
function usePolled<T>(load: () => Promise<T>) {
  const result = useLoad(load, []);
  const busy = useRef(result.loading);
  busy.current = result.loading;
  const { reload } = result;
  useEffect(() => {
    const timer = setInterval(() => { if (!busy.current) reload(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);
  return result;
}

export function DashboardScreen() {
  const { data, error, reload } = usePolled(() => dashboardReader.read());
  const [tab, setTab] = useState<Tab>('wall');
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useMounted();
  const problem = problemOf(error);

  async function refresh() {
    setRefreshing(true);
    await reload();
    if (mounted.current) setRefreshing(false);
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.ink }}>
      <StatusBar style="light" />
      <TopBar />
      <UnresolvedBar />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
        {problem && data ? <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}><Banner testID="dash-stale" tone="amber" icon="off" body={`${problem}. Số liệu dưới đây là của lúc ${timeOf(data.readAt)}.`} /></View> : null}
        {problem && !data ? <T testID="dash-error" style={{ color: color.white, padding: 16 }}>{problem}</T> : null}
        {!data && !problem ? <Center /> : null}
        {data ? <>
          <Stub data={data} offline={!!problem} />
          <Tabs active={tab} onChange={setTab} />
          {tab === 'wall' ? <Wall data={data} /> : null}
          {tab === 'holders' ? <HolderList holders={holdersOf(data.tickets)} /> : null}
          {tab === 'activity' ? <ActivityList /> : null}
          <Figures data={data} />
        </> : null}
      </ScrollView>
      <RefreshBar readAt={data?.readAt} refreshing={refreshing} onRefresh={refresh} />
      <Nav active="dashboard" />
    </View>
  );
}

function TopBar() {
  const app = useApp();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 16, paddingVertical: 12, minHeight: 56 }}>
      <Display size={28} style={{ color: color.white }}>Tổng quan</Display>
      <Pressable testID="wallet-chip" accessibilityRole="button" accessibilityLabel="Mở ví" onPress={() => app.go({ name: 'wallet' })}
        style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, backgroundColor: color.white }}>
        <Mono testID="wallet-address">{short(app.wallet.address)}</Mono>
      </Pressable>
    </View>
  );
}

/** The headline figure, printed on the same perforated stub as a ticket. */
function Stub({ data, offline }: { data: DashboardSnapshot; offline: boolean }) {
  return (
    <View style={{ marginHorizontal: 16, backgroundColor: color.blue }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 10, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
          <Display size={76} testID="dash-entered" style={{ lineHeight: 84, color: color.white }}>{data.entered}</Display>
          <Display size={38} style={{ lineHeight: 50, color: color.blueSub }}>/{data.issued}</Display>
        </View>
        <T style={{ fontSize: 13, lineHeight: 18, color: color.blueSub }}>đã vào cửa · {eventInfo.name}</T>
      </View>
      <View style={{ height: 2 }}>
        <View style={{ marginHorizontal: 16, borderTopWidth: 2, borderTopColor: color.blueSub, borderStyle: 'dashed' }} />
        <View style={{ position: 'absolute', left: -10, top: -9, width: 20, height: 20, borderRadius: 10, backgroundColor: color.ink }} />
        <View style={{ position: 'absolute', right: -10, top: -9, width: 20, height: 20, borderRadius: 10, backgroundColor: color.ink }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4, paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12 }}>
        <Mono style={{ fontSize: 11, color: color.blueSub }}>{eventInfo.when} · {eventInfo.venue}</Mono>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: offline ? color.amber : '#2FCB7E' }} />
          <Mono testID="dash-live" style={{ fontSize: 11, color: color.blueSub }}>{offline ? 'Mất kết nối' : 'Trực tiếp'}</Mono>
        </View>
      </View>
    </View>
  );
}

function Tabs({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: 20, paddingHorizontal: 16, marginTop: 8, borderBottomWidth: 1, borderBottomColor: RULE }}>
      {TABS.map((t) => {
        const on = t.key === active;
        return (
          <Pressable key={t.key} testID={`dash-tab-${t.key}`} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => onChange(t.key)}
            style={{ minHeight: 44, justifyContent: 'center', borderBottomWidth: 3, borderBottomColor: on ? color.white : 'transparent' }}>
            <T style={{ fontSize: 14, color: on ? color.white : color.darkMuted, fontFamily: on ? font.semibold : font.body }}>{t.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

const statusOf = (t: DashboardTicket) => (t.checkedIn ? 'Đã vào' : 'Chưa vào');

function Wall({ data }: { data: DashboardSnapshot }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [shown, setShown] = useState(WALL_PAGE);
  const total = Number(data.maxSupply);
  const cells = Array.from({ length: Math.min(total, shown) }, (_, i) => data.tickets[i] ?? null);
  const picked = data.tickets.find((t) => t.tokenId === selected);
  return (
    <View style={{ paddingTop: 12, gap: 10 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 13 }}>
        {cells.map((t, i) => (
          <View key={i} style={{ width: '20%', padding: 3 }}>
            {t ? <TicketCell ticket={t} selected={t.tokenId === selected} onPress={() => setSelected(t.tokenId)} /> : <View style={{ height: 44, borderWidth: 1.5, borderStyle: 'dashed', borderColor: EMPTY_CELL }} />}
          </View>
        ))}
      </View>
      {total > shown ? <View style={{ paddingHorizontal: 16 }}><Btn testID="dash-more" label={`Xem thêm (còn ${total - shown} ô)`} kind="light" onPress={() => setShown(shown + WALL_PAGE)} /></View> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 6, paddingHorizontal: 16 }}>
        <Key mark={<View style={{ width: 14, height: 14, backgroundColor: color.white, alignItems: 'center', justifyContent: 'center' }}><Icon name="check" size={10} /></View>} label="Đã vào" value={data.entered} />
        <Key mark={<View style={{ width: 14, height: 14, backgroundColor: color.blue }} />} label="Chưa vào" value={data.waiting} testID="dash-waiting" />
        <Key mark={<View style={{ width: 14, height: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: color.darkMuted }} />} label="Chưa phát hành" value={data.unsold} testID="dash-unsold" />
      </View>
      {picked ? (
        <View testID="dash-selected" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, padding: 12, backgroundColor: color.white }}>
          <T style={{ fontFamily: font.semibold }}>Vé #{picked.tokenId}</T>
          <Mono style={{ flex: 1 }}>{short(picked.owner)}</Mono>
          <T style={{ fontFamily: font.medium, fontSize: 14 }}>{statusOf(picked)}</T>
        </View>
      ) : data.tickets.length > 0 ? <T style={{ fontSize: 13, lineHeight: 18, color: color.darkMuted, paddingHorizontal: 16 }}>Bấm vào một ô để xem người giữ vé.</T> : <T testID="dash-empty" style={{ fontSize: 13, lineHeight: 18, color: color.darkMuted, paddingHorizontal: 16 }}>Chưa có vé nào được phát hành.</T>}
    </View>
  );
}

function TicketCell({ ticket, selected, onPress }: { ticket: DashboardTicket; selected: boolean; onPress: () => void }) {
  return (
    <Pressable testID={`dash-ticket-${ticket.tokenId}`} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`Vé ${ticket.tokenId}, ${statusOf(ticket)}`} onPress={onPress}
      style={{ height: 44, alignItems: 'center', justifyContent: 'center', backgroundColor: ticket.checkedIn ? color.white : color.blue, borderWidth: 2, borderColor: selected ? color.amber : 'transparent' }}>
      {ticket.checkedIn ? <Icon name="check" size={16} /> : <Mono style={{ fontSize: 11, color: color.white }}>{ticket.tokenId}</Mono>}
    </Pressable>
  );
}

function Key({ mark, label, value, testID }: { mark: React.ReactNode; label: string; value: number; testID?: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {mark}
      <T style={{ fontSize: 12, lineHeight: 18, color: color.darkMuted }}>{label}</T>
      <T testID={testID} style={{ fontSize: 12, lineHeight: 18, fontFamily: font.semibold, color: color.white }}>{value}</T>
    </View>
  );
}

function Figures({ data }: { data: DashboardSnapshot }) {
  const figures: { label: string; value: string; testID?: string }[] = [
    { label: 'TIỀN CHƯA RÚT', value: formatAmount(data.balanceWei, config.nativeSymbol), testID: 'dash-balance' },
    { label: 'GIÁ VÉ', value: data.priceWei === '0' ? 'Không bán' : formatAmount(data.priceWei, config.nativeSymbol) },
    { label: 'VÍ GIỮ VÉ', value: String(data.holders), testID: 'dash-holders' },
  ];
  return (
    <View style={{ flexDirection: 'row', marginTop: 14, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: RULE }}>
      {figures.map((f) => (
        <View key={f.label} style={{ flex: 1, gap: 3 }}>
          <Mono style={{ fontSize: 10, lineHeight: 13, color: color.darkMuted }}>{f.label}</Mono>
          <Mono testID={f.testID} style={{ fontSize: 13, lineHeight: 18, color: color.white }}>{f.value}</Mono>
        </View>
      ))}
    </View>
  );
}

function Thumb({ solid, icon, label }: { solid?: boolean; icon?: 'check'; label?: string }) {
  return <View style={{ width: 38, height: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: solid ? color.white : color.blue }}>{icon ? <Icon name={icon} size={20} /> : <Mono style={{ fontSize: 11, color: color.white }}>{label}</Mono>}</View>;
}

function Line({ testID, thumb, title, sub, right }: { testID?: string; thumb: React.ReactNode; title: string; sub: string; right?: React.ReactNode }) {
  return (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9, paddingHorizontal: 16 }}>
      {thumb}
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={{ fontFamily: font.semibold, fontSize: 14, lineHeight: 19, color: color.white }}>{title}</T>
        <Mono style={{ fontSize: 11, color: color.darkMuted }}>{sub}</Mono>
      </View>
      {right}
    </View>
  );
}

const Empty = ({ testID, children }: { testID: string; children: string }) => <T testID={testID} style={{ color: color.darkMuted, padding: 16 }}>{children}</T>;

function HolderList({ holders }: { holders: Holder[] }) {
  const [shown, setShown] = useState(LIST_PAGE);
  if (holders.length === 0) return <Empty testID="dash-empty">Chưa có ví nào giữ vé.</Empty>;
  return (
    <View style={{ paddingTop: 4 }}>
      {holders.slice(0, shown).map((h) => <Line key={h.owner} testID={`dash-holder-${h.owner}`} thumb={<Thumb label={String(h.tickets)} />} title={short(h.owner)} sub={`${h.tickets} vé · ${h.entered} đã vào`} />)}
      {holders.length > shown ? <View style={{ padding: 16 }}><Btn testID="dash-more" label={`Xem thêm (còn ${holders.length - shown} ví)`} kind="light" onPress={() => setShown(shown + LIST_PAGE)} /></View> : null}
    </View>
  );
}

const ACTIVITY_TITLE: Record<ActivityKind, (id: string) => string> = {
  checkIn: (id) => `Vào cửa · Vé #${id}`,
  buy: (id) => `Mua vé #${id}`,
  mint: (id) => `Phát hành vé #${id}`,
  transfer: (id) => `Chuyển vé #${id}`,
};

function ActivityList() {
  const { data, error } = usePolled(() => dashboardReader.readActivity());
  const problem = problemOf(error);
  if (problem && !data) return <T testID="dash-activity-error" style={{ color: color.white, padding: 16 }}>{problem}</T>;
  if (!data) return <Center />;
  const now = Math.floor(Date.now() / 1000);
  return (
    <View testID="dash-activity" style={{ paddingTop: 4 }}>
      {data.events.length === 0 ? <Empty testID="dash-activity-empty">Chưa có hoạt động nào.</Empty> : null}
      {data.events.map((e: ActivityEvent) => (
        <Line key={e.id} testID={`dash-event-${e.id}`} thumb={<Thumb solid={e.kind === 'checkIn'} icon={e.kind === 'checkIn' ? 'check' : undefined} label={e.tokenId} />} title={ACTIVITY_TITLE[e.kind](e.tokenId)} sub={short(e.wallet)} right={<T style={{ fontSize: 12, color: color.darkMuted }}>{timeAgo(e.timestamp, now)}</T>} />
      ))}
      <Mono testID="dash-window" style={{ fontSize: 11, color: color.darkMuted, paddingHorizontal: 16, paddingTop: 8 }}>Tối đa 20 mục mới nhất, trong {data.windowBlocks} block gần đây</Mono>
    </View>
  );
}

function RefreshBar({ readAt, refreshing, onRefresh }: { readAt?: number; refreshing: boolean; onRefresh: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, borderTopWidth: 1, borderTopColor: RULE }}>
      <Mono testID="dash-updated" style={{ flex: 1, fontSize: 11, color: color.darkMuted }}>{readAt ? `Cập nhật lúc ${timeOf(readAt)}` : ''}</Mono>
      <Pressable testID="dash-refresh" accessibilityRole="button" accessibilityState={{ busy: refreshing }} disabled={refreshing} onPress={onRefresh} style={{ minHeight: 44, justifyContent: 'center', paddingLeft: 12 }}>
        <T style={{ fontSize: 13, fontFamily: font.medium, color: color.white }}>{refreshing ? 'Đang tải…' : 'Làm mới'}</T>
      </Pressable>
    </View>
  );
}
