import React from 'react';
import { Pressable, View } from 'react-native';
import { useApp } from '../app-context';
import { eventDate, formatUsdc } from '../format';
import { useLoad } from '../hooks';
import type { EventInfo } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Badge, Btn, Center, Display, Mono, Screen, T } from '../ui';

export function EventsScreen() {
  const app = useApp();
  const { data: events, error, reload } = useLoad(() => app.service.getEvents(), []);
  const shown = events ? [...events].sort((a, b) => rank(a) - rank(b) || a.startsAt - b.startsAt) : undefined;
  return (
    <Screen title="Vé Gốc" nav="events">
      <Mono testID="tagline" style={{ color: color.muted, fontSize: 11, letterSpacing: 1, marginTop: -8 }}>FACE-VALUE TICKETS · RESALE CAPPED AT +10%</Mono>
      {error && !events ? <View style={{ gap: 12 }}><T testID="load-error">{messageFor(codeOf(error) === 'Unknown' ? 'Network' : codeOf(error))}</T><Btn label="Try again" kind="secondary" onPress={reload} /></View> : null}
      {!events && !error ? <Center /> : null}
      {events?.length === 0 ? <Display testID="no-events">No events yet</Display> : null}
      {shown?.map((e) => <EventPoster key={e.id} event={e} onPress={() => app.go({ name: 'event', eventId: e.id })} />)}
    </Screen>
  );
}

const rank = (e: EventInfo) => (e.status === 'onsale' ? 0 : e.status === 'cancelled' ? 1 : 2);

export function statusBadge(e: EventInfo) {
  if (e.status === 'cancelled') return <Badge label="Cancelled · refunds open" tone="orange" testID={`event-${e.id}-status`} />;
  if (e.status === 'ended' && e.refundOpen) return <Badge label="No-show · refunds open" tone="orange" testID={`event-${e.id}-status`} />;
  if (e.status === 'ended') return <Badge label="Ended" tone="line" testID={`event-${e.id}-status`} />;
  const supply = e.tiers.reduce((n, t) => n + t.supply, 0);
  return e.issued >= supply ? <Badge label="Sold out" tone="ink" /> : <Badge label="On sale" tone="amber" testID={`event-${e.id}-status`} />;
}

function EventPoster({ event: e, onPress }: { event: EventInfo; onPress: () => void }) {
  const from = e.tiers.reduce((m, t) => (BigInt(t.price) < m ? BigInt(t.price) : m), BigInt(e.tiers[0]?.price ?? 0));
  const supply = e.tiers.reduce((n, t) => n + t.supply, 0);
  const pct = supply ? Math.min(100, Math.round((e.issued / supply) * 100)) : 0;
  const dark = e.status === 'onsale';
  const fg = dark ? color.white : color.ink;
  const sub = dark ? color.darkMuted : color.muted;
  return (
    <Pressable testID={`event-${e.id}`} accessibilityRole="button" accessibilityLabel={`Open ${e.name}`} onPress={onPress}
      style={{ backgroundColor: dark ? color.ink : color.white, borderWidth: dark ? 0 : 2, borderColor: color.line }}>
      <View style={{ padding: 20, paddingBottom: 16, gap: 6 }}>
        {statusBadge(e)}
        <Display size={40} style={{ color: fg }}>{e.name}</Display>
        <T style={{ color: sub }}>{eventDate(e.startsAt)} · {e.venue}</T>
      </View>
      <View style={{ height: 4, backgroundColor: dark ? '#2A2C37' : color.line }}>
        <View style={{ width: `${pct}%`, height: 4, backgroundColor: dark ? color.amber : color.muted }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 20, paddingVertical: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
          <Mono style={{ color: sub }}>FROM</Mono>
          <Display size={28} style={{ color: dark ? color.amber : fg }}>{formatUsdc(from)}</Display>
          <Mono style={{ color: sub }}>USDC</Mono>
        </View>
        <T style={{ color: sub, fontFamily: font.medium, fontSize: 14 }}>{e.issued}/{supply} sold</T>
      </View>
    </Pressable>
  );
}
