import React from 'react';
import { Image, Pressable, ScrollView, Share, View } from 'react-native';
import { useApp } from '../app-context';
import { eventPhoto } from '../art';
import { eventWhen, formatVnd } from '../format';
import { useLoad } from '../hooks';
import type { EventInfo } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { CommentCount, LikeButton, useSocialFeed } from '../social-ui';
import type { EventSocial } from '../lib/social';
import { Badge, Btn, Center, Display, Ic, Going, Header, Screen, T } from '../ui';

export function EventsScreen() {
  const app = useApp();
  const { data: events, error, reload } = useLoad(() => app.service.getEvents(), []);
  const shown = events ? [...events].sort((a, b) => rank(a) - rank(b) || a.startsAt - b.startsAt) : undefined;
  const live = shown?.filter((e) => e.status === 'onsale') ?? [];
  const social = useSocialFeed(shown?.map((e) => e.id) ?? []);
  return (
    <Screen title="Vé Gốc" nav="events" bare header={<Header title="Vé Gốc" />}>
      {live.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 14, gap: 14 }} style={{ borderBottomWidth: 1, borderBottomColor: color.paper }}>
          {live.map((e) => (
            <Pressable key={e.id} testID={`story-${e.id}`} accessibilityRole="button" accessibilityLabel={`Mở ${e.name}`} onPress={() => app.go({ name: 'event', eventId: e.id })} style={{ width: 72, alignItems: 'center', gap: 6 }}>
              <View style={{ width: 68, height: 68, borderRadius: 34, padding: 3, backgroundColor: color.blue }}>
                <Image source={eventPhoto(e.id)} style={{ width: '100%', height: '100%', borderRadius: 31, borderWidth: 2, borderColor: color.white }} />
              </View>
              <T lines={1} style={{ fontSize: 12, lineHeight: 16 }}>{e.name}</T>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {error && !events ? <View style={{ gap: 12, padding: 20 }}><T testID="load-error">{messageFor(codeOf(error) === 'Unknown' ? 'Network' : codeOf(error))}</T><Btn label="Thử lại" kind="secondary" onPress={reload} /></View> : null}
      {!events && !error ? <Center /> : null}
      {events?.length === 0 ? <Center><Ic name="calendar" size={40} tint={color.muted} /><Display testID="no-events" size={22}>Chưa có sự kiện</Display></Center> : null}
      {shown?.map((e) => <EventPost key={e.id} event={e} onOpen={() => app.go({ name: 'event', eventId: e.id })} social={social.on ? { state: social.of(e.id), set: (s) => social.set(e.id, s) } : undefined} />)}
    </Screen>
  );
}

const rank = (e: EventInfo) => (e.status === 'onsale' ? 0 : e.status === 'cancelled' ? 1 : 2);

const supplyOf = (e: EventInfo) => e.tiers.reduce((n, t) => n + t.supply, 0);

export function statusBadge(e: EventInfo) {
  if (e.status === 'cancelled') return <Badge label="Đã hủy · đang hoàn tiền" tone="orange" testID={`event-${e.id}-status`} />;
  if (e.status === 'ended' && e.refundOpen) return <Badge label="Không diễn ra · đang hoàn tiền" tone="orange" testID={`event-${e.id}-status`} />;
  if (e.status === 'ended') return <Badge label="Đã kết thúc" tone="ink" testID={`event-${e.id}-status`} />;
  return e.issued >= supplyOf(e) ? <Badge label="Hết vé" tone="ink" /> : <Badge label="Đang bán" tone="amber" testID={`event-${e.id}-status`} />;
}

export async function shareEvent(e: EventInfo) {
  const message = `${e.name} · ${eventWhen(e.startsAt, e.endsAt)} · ${e.venue}`;
  try { await Share.share({ message, title: e.name }); } catch { /* the user closed the sheet, or the browser has no share sheet */ }
}

/** One event as a post in the feed: who runs it, a big photo, how many are going, and the way in. */
function EventPost({ event: e, onOpen, social }: { event: EventInfo; onOpen: () => void; social?: { state: EventSocial; set: (s: EventSocial) => void } }) {
  const from = e.tiers.reduce((m, t) => (BigInt(t.price) < m ? BigInt(t.price) : m), BigInt(e.tiers[0]?.price ?? 0));
  const left = supplyOf(e) - e.issued;
  const onSale = e.status === 'onsale' && left > 0;
  const fewLeft = onSale && left <= Math.max(10, supplyOf(e) * 0.25);
  return (
    <View style={{ borderBottomWidth: 8, borderBottomColor: color.paper }}>
      <Pressable testID={`event-${e.id}`} accessibilityRole="button" accessibilityLabel={`Mở ${e.name}`} onPress={onOpen}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12 }}>
        <Image source={eventPhoto(e.id)} style={{ width: 40, height: 40, borderRadius: 20 }} />
        <View style={{ flex: 1 }}>
          <T lines={1} style={{ fontFamily: font.bold, fontSize: 15 }}>{e.name}</T>
          <T lines={1} style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>{eventWhen(e.startsAt, e.endsAt)} · {e.venue}</T>
        </View>
      </View>
      <View style={{ height: 300 }}>
        <Image source={eventPhoto(e.id)} resizeMode="cover" style={{ width: '100%', height: '100%', opacity: e.status === 'onsale' ? 1 : 0.6 }} />
        <View style={{ position: 'absolute', left: 12, top: 12 }}>{statusBadge(e)}</View>
        {fewLeft ? (
          <View style={{ position: 'absolute', left: 12, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: color.amber, paddingLeft: 6, paddingRight: 10, paddingVertical: 5 }}>
            <Ic name="fire" size={18} />
            <T style={{ fontFamily: font.bold, fontSize: 13, lineHeight: 18 }}>Còn {left} vé</T>
          </View>
        ) : null}
      </View>
      </Pressable>
      {social ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 16, paddingTop: 6 }}>
          <LikeButton eventId={e.id} state={social.state} onChange={social.set} />
          <CommentCount eventId={e.id} count={social.state.comments} onPress={onOpen} />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: social ? 2 : 12, paddingBottom: 14 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Going count={e.issued} />
          {onSale ? <T style={{ fontSize: 13, lineHeight: 18, color: color.muted }}>Từ <T style={{ fontFamily: font.bold, fontSize: 13, color: color.ink }}>{formatVnd(from)}</T></T> : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={`Chia sẻ ${e.name}`} onPress={() => shareEvent(e)} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          {/* The speech bubble now means comments; sharing gets an arrow. */}
          <Ic name="share" size={20} tint={color.muted} />
        </Pressable>
        {onSale ? (
          <Pressable accessibilityRole="button" onPress={onOpen} style={{ minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', backgroundColor: color.blue }}>
            <T style={{ fontFamily: font.bold, fontSize: 14, color: color.white }}>Mua vé</T>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
