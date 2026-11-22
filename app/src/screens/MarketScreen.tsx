import React, { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useApp } from '../app-context';
import { eventPhoto } from '../art';
import { agoVi, CapBadge, Chips, Person, QueueBox, ShareBtn, viMessage, whenVi } from '../exchange-ui';
import { formatVnd } from '../format';
import { useLoad } from '../hooks';
import { noteFits, type ListingNote } from '../lib/exchange';
import type { EventInfo, Ticket } from '../lib/types';
import { color, font } from '../theme';
import { Btn, Center, Display, Ic, Header, Screen, T } from '../ui';

type Sort = 'new' | 'cheap';

/** Every open resale listing of the events on sale, straight from the ticket contract. */
async function loadMarket(app: ReturnType<typeof useApp>) {
  const events = (await app.service.getEvents()).filter((e) => e.status === 'onsale');
  const lists = await Promise.all(events.filter((e) => e.listed > 0).map((e) => app.service.getListings(e.id)));
  return { events, listings: lists.flat() };
}

/** "Đêm nhạc" is found by "dem nhac". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
const byPrice = (a: Ticket, b: Ticket) => (BigInt(a.listPrice) < BigInt(b.listPrice) ? -1 : BigInt(a.listPrice) > BigInt(b.listPrice) ? 1 : 0);

export function MarketScreen({ eventId: firstEvent }: { eventId?: string }) {
  const app = useApp();
  const [eventId, setEventId] = useState<string | null>(firstEvent ?? null);
  const [tier, setTier] = useState<number | null>(null);
  const [sort, setSort] = useState<Sort>('new');
  const [atFace, setAtFace] = useState(false);
  const [query, setQuery] = useState('');
  const { data, error, reload } = useLoad(() => loadMarket(app), []);
  const ids = (data?.listings ?? []).map((l) => l.tokenId).join(',');
  const { data: notes } = useLoad(() => (app.exchange && ids ? app.exchange.notes(ids.split(',')) : Promise.resolve({} as Record<string, ListingNote>)), [ids]);
  const { data: waitlist, reload: reloadQueue } = useLoad(() => (eventId ? app.service.getWaitlist(eventId) : Promise.resolve(undefined)), [eventId]);

  const events = data?.events ?? [];
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  // A link can name an event that is no longer on sale: fall back to every event.
  useEffect(() => { if (data && eventId && !byId.has(eventId)) setEventId(null); }, [data, eventId, byId]);
  const q = fold(query.trim());
  const matches = (e?: EventInfo) => !!e && (!eventId || e.id === eventId) && (!q || fold(`${e.name} ${e.venue}`).includes(q));
  // A note counts only for the listing it was written for; anything else is ignored here as well as by the relayer.
  const noteOf = (l: Ticket) => (noteFits(notes?.[l.tokenId], l.owner, l.listPrice) ? notes![l.tokenId] : undefined);
  const age = (l: Ticket) => noteOf(l)?.posted ?? 0;

  const listings = (data?.listings ?? [])
    .filter((l) => matches(byId.get(l.eventId)) && (tier === null || !eventId || l.tier === tier) && (!atFace || BigInt(l.listPrice) <= BigInt(l.face)))
    .sort((a, b) => (sort === 'cheap' ? byPrice(a, b) : age(b) - age(a) || Number(b.tokenId) - Number(a.tokenId)));
  const chosen = eventId ? byId.get(eventId) : undefined;
  const shownEvents = events.filter((e) => matches(e));
  const narrowed = atFace || !!q || !!eventId;

  return (
    <Screen title="Chợ vé" nav="market" header={<Header title="Chợ vé" />}>
      <TextInput testID="market-search" accessibilityLabel="Tìm sự kiện hoặc địa điểm" value={query} onChangeText={setQuery} placeholder="Tìm sự kiện, địa điểm…" placeholderTextColor={color.muted} autoCorrect={false}
        style={{ minHeight: 48, paddingHorizontal: 14, fontFamily: font.body, fontSize: 15, color: color.ink, backgroundColor: color.paper }} />

      {events.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -20, flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: 20 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[{ id: null as string | null, name: 'Mọi sự kiện' }, ...events].map((e) => {
              const on = e.id === eventId;
              return (
                <Pressable key={e.id ?? 'all'} testID={`market-event-${e.id ?? 'all'}`} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => { setEventId(e.id); setTier(null); }}
                  style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: on ? color.ink : color.paper }}>
                  <T lines={1} style={{ fontFamily: font.semibold, fontSize: 14, color: on ? color.white : color.ink }}>{e.name}</T>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      ) : null}
      {chosen && chosen.tiers.length > 1 ? (
        <Chips testID="market-tier" value={tier} onChange={setTier} items={[{ value: null, label: 'Mọi hạng' }, ...chosen.tiers.map((t, i) => ({ value: i as number | null, label: t.name }))]} />
      ) : null}

      {error && !data ? <View style={{ gap: 12 }}><T testID="market-error">{viMessage(error)}</T><Btn label="Thử lại" kind="secondary" onPress={reload} /></View> : null}
      {!data && !error ? <Center /> : null}

      {data ? <>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <Display size={20} testID="market-count">{listings.length ? `${listings.length} vé đang bán` : 'Vé đang bán'}</Display>
          <Pressable testID="market-at-face" accessibilityRole="checkbox" accessibilityState={{ checked: atFace }} accessibilityLabel="Chỉ vé không quá giá gốc" onPress={() => setAtFace(!atFace)}
            style={{ minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: atFace ? color.green : color.paper }}>
            <T lines={1} style={{ fontFamily: font.semibold, fontSize: 14, color: atFace ? color.white : color.ink }}>≤ giá gốc</T>
          </Pressable>
        </View>
        {listings.length > 1 ? <Chips testID="market-sort" value={sort} onChange={setSort} items={[{ value: 'new', label: 'Mới nhất' }, { value: 'cheap', label: 'Rẻ nhất' }]} /> : null}
        {listings.map((l) => <ListingCard key={l.tokenId} listing={l} event={byId.get(l.eventId)!} note={noteOf(l)} mine={l.owner.toLowerCase() === app.wallet.address.toLowerCase()} onOpen={() => app.go({ name: 'listing', tokenId: l.tokenId })} />)}
        {listings.length === 0 ? (
          <View style={{ alignItems: 'center', gap: 8, paddingVertical: 20, paddingHorizontal: 12, backgroundColor: color.paper }}>
            <Ic name="ticket" size={40} tint={color.muted} />
            <Display testID="market-empty" size={20} style={{ textAlign: 'center' }}>{narrowed ? 'Không có vé nào khớp' : 'Chưa ai rao bán vé'}</Display>
            <T style={{ textAlign: 'center', color: color.muted }}>{chosen ? 'Xếp hàng bên dưới: vé kế tiếp được rao sẽ về người đứng đầu hàng.' : 'Chọn một sự kiện bên dưới để xếp hàng mua vé bán lại.'}</T>
          </View>
        ) : <T testID="market-rule" style={{ fontSize: 12, lineHeight: 16, color: color.muted }}>Giá trần do sổ vé đặt: giá gốc +10%. Nếu show huỷ, tiền hoàn là giá gốc.</T>}

        {chosen ? chosen.tiers.map((t, i) => ((tier === null || tier === i) && waitlist?.[i] ? (
          <QueueBox key={t.name} event={chosen} tier={i} state={waitlist[i]} open={data.listings.filter((l) => l.eventId === chosen.id && l.tier === i).length} onChanged={reloadQueue} />
        ) : null)) : shownEvents.length ? (
          <View testID="market-queues" style={{ gap: 8 }}>
            <Display size={20}>Hàng chờ vé bán lại</Display>
            <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Số người đang xếp hàng cho từng hạng vé, đọc từ sổ vé. Người bán không chọn được người mua.</T>
            {shownEvents.map((e) => (
              <Pressable key={e.id} testID={`market-queue-${e.id}`} accessibilityRole="button" accessibilityLabel={`Xem hàng chờ của ${e.name}`} onPress={() => { setEventId(e.id); setTier(null); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 8, backgroundColor: color.paper }}>
                <Image source={eventPhoto(e.id)} style={{ width: 48, height: 48 }} />
                <View style={{ flex: 1 }}>
                  <T lines={1} style={{ fontFamily: font.bold }}>{e.name}</T>
                  <T lines={2} style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{e.tiers.map((t, i) => `${t.name}: ${e.waiting[i] ?? 0} người chờ`).join(' · ')}</T>
                </View>
                <Ic name="next" size={18} tint={color.muted} />
              </Pressable>
            ))}
          </View>
        ) : q ? <T testID="market-no-event" style={{ color: color.muted }}>Không thấy sự kiện nào đang mở bán khớp với “{query.trim()}”.</T> : null}
        {chosen ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <ShareBtn testID="market-share" target={{ kind: 'market', id: chosen.id }} text={`Vé bán lại và hàng chờ · ${chosen.name}`} />
            <View style={{ flex: 1 }}><Btn testID="market-open-event" label="Mở trang sự kiện" kind="secondary" onPress={() => app.go({ name: 'event', eventId: chosen.id })} /></View>
          </View>
        ) : null}
      </> : null}
    </Screen>
  );
}

function ListingCard({ listing: l, event: e, note, mine, onOpen }: { listing: Ticket; event: EventInfo; note?: ListingNote; mine: boolean; onOpen: () => void }) {
  return (
    <Pressable testID={`market-listing-${l.tokenId}`} accessibilityRole="button" accessibilityLabel={`Vé ${l.tierName} ${e.name}, ${formatVnd(l.listPrice)}`} onPress={onOpen} style={{ backgroundColor: color.paper }}>
      <View style={{ flexDirection: 'row' }}>
        <View style={{ width: 92, minHeight: 112, overflow: 'hidden' }}>
          <Image source={eventPhoto(e.id)} resizeMode="cover" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />
        </View>
        <View style={{ flex: 1, padding: 12, gap: 4 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
            <T lines={1} style={{ flex: 1, fontFamily: font.bold }}>{e.name}</T>
            <T style={{ fontFamily: font.bold, color: color.blue }}>#{l.tokenId}</T>
          </View>
          <T lines={1} style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{l.tierName} · {whenVi(e.startsAt, e.endsAt)}</T>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8 }}>
            <Display size={22}>{formatVnd(l.listPrice)}</Display>
            <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>gốc {formatVnd(l.face)}</T>
          </View>
          <CapBadge price={l.listPrice} face={l.face} cap={l.cap} testID={`market-cap-${l.tokenId}`} />
        </View>
      </View>
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, gap: 6, borderTopWidth: 1, borderTopColor: color.white }}>
        {note?.text ? <T testID={`market-note-${l.tokenId}`} lines={2}>{note.text}</T> : null}
        <Person account={l.owner} size={28} sub={[mine ? 'Vé bạn đang rao' : null, note ? `Đăng ${agoVi(note.posted).toLowerCase()}` : null].filter(Boolean).join(' · ') || undefined} />
      </View>
    </Pressable>
  );
}
