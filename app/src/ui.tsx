import React from 'react';
import { ActivityIndicator, Image, ImageSourcePropType, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useApp } from './app-context';
import { glyphs, type IconKey } from './art';
import { Glyph } from './glyph';
import { demoMode, explorer, networkLabel } from './config';
import { useUnresolved } from './hooks';
import { useUnread } from './notice-store';
import { color, font } from './theme';

export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function T({ style, children, testID, lines }: { style?: TextStyle | TextStyle[]; children: React.ReactNode; testID?: string; lines?: number }) {
  return <Text testID={testID} numberOfLines={lines} style={[{ fontFamily: font.body, fontSize: 15, lineHeight: 22, color: color.ink }, style as TextStyle]}>{children}</Text>;
}
/** Bold sentence-case headings, tight tracking, as in the big social apps. */
export const Display = ({ size = 28, style, children, testID, lines }: { size?: number; style?: TextStyle; children: React.ReactNode; testID?: string; lines?: number }) => (
  <T testID={testID} lines={lines} style={[{ fontFamily: font.display, fontSize: size, lineHeight: Math.ceil(size * 1.15), letterSpacing: -size * 0.025 }, style as TextStyle]}>{children}</T>
);
export const Mono = ({ style, children, testID }: { style?: TextStyle; children: React.ReactNode; testID?: string }) => (
  <T testID={testID} style={[{ fontFamily: font.mono, fontSize: 13, lineHeight: 18 }, style as TextStyle]}>{children}</T>
);

/**
 * An outline icon by what it means in the app (see `glyphs` in art.ts). Decorative: the label next to it, or the
 * button's accessibilityLabel, is what a screen reader says. Sizes: 18 inline, 22 leading a card, 24 in the tab
 * bar, 40 in an empty state.
 */
export const Ic = ({ name, size = 18, tint = color.ink, fill }: { name: IconKey; size?: number; tint?: string; fill?: string }) => (
  <Glyph name={glyphs[name]} size={size} color={tint} fill={fill} />
);

/** The marks a banner or a verdict uses, in the colour of its text. */
type MarkName = 'back' | 'check' | 'x' | 'clock' | 'off' | 'lock';
const markFor: Record<MarkName, IconKey> = { back: 'back', check: 'check', x: 'cross', clock: 'clock', off: 'offline', lock: 'lock' };
export function Icon({ name, size = 24, tint = color.ink }: { name: MarkName; size?: number; tint?: string }) {
  return <Ic name={markFor[name]} size={size} tint={tint} />;
}

type BtnKind = 'primary' | 'secondary' | 'dark' | 'light';
const btnStyles: Record<BtnKind, { bg: string; fg: string; border: string }> = {
  primary: { bg: color.blue, fg: color.white, border: color.blue },
  secondary: { bg: 'transparent', fg: color.ink, border: color.ink },
  dark: { bg: color.ink, fg: color.white, border: color.ink },
  light: { bg: color.white, fg: color.ink, border: color.white },
};
export function Btn({ label, onPress, kind = 'primary', disabled, busy, testID, accessibilityLabel }: { label: string; onPress?: () => void; kind?: BtnKind; disabled?: boolean; busy?: boolean; testID?: string; accessibilityLabel?: string }) {
  const s = btnStyles[kind];
  const off = disabled || busy;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled: !!off, busy: !!busy }} disabled={off} onPress={onPress}
      style={[styles.btn, off && !busy ? { backgroundColor: color.paper, borderColor: color.paper } : { backgroundColor: s.bg, borderColor: s.border }]}>
      {busy ? <ActivityIndicator color={s.fg} /> : <T lines={1} style={{ fontFamily: font.bold, fontSize: 16, color: off ? color.muted : s.fg, textAlign: 'center' }}>{label}</T>}
    </Pressable>
  );
}

export function Row({ label, value, mono, testID }: { label: string; value: string; mono?: boolean; testID?: string }) {
  return (
    <View style={styles.row}>
      <T style={{ color: color.muted, flexShrink: 0 }}>{label}</T>
      {mono ? <Mono testID={testID}>{value}</Mono> : <T testID={testID} style={{ fontFamily: font.semibold, flexShrink: 1, textAlign: 'right' }}>{value}</T>}
    </View>
  );
}

/** A small round button over a photo or in a header. */
export function RoundBtn({ label, onPress, testID, children, light }: { label: string; onPress?: () => void; testID?: string; children: React.ReactNode; light?: boolean }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: light ? 'rgba(255,255,255,0.18)' : color.white }}>
      {children}
    </Pressable>
  );
}

export type CardTone = 'live' | 'listed' | 'gone' | 'used' | 'void';
const cardTones: Record<CardTone, { bg: string; fg: string; sub: string; dash: string; dim?: boolean }> = {
  live: { bg: color.blue, fg: color.white, sub: color.blueSub, dash: 'rgba(220,220,255,0.5)' },
  listed: { bg: color.amber, fg: color.ink, sub: color.ink, dash: 'rgba(18,19,26,0.35)' },
  gone: { bg: color.paper, fg: color.ink, sub: color.muted, dash: color.line, dim: true },
  used: { bg: color.ink, fg: color.white, sub: color.darkMuted, dash: color.muted },
  void: { bg: color.paper, fg: color.muted, sub: color.muted, dash: color.line, dim: true },
};

export function TicketCard({ tokenId, eventName, when, tierName, status, holder, photo, tone = 'live', testID, compact }: {
  tokenId: string; eventName: string; when: string; tierName: string; status: string; holder?: string; photo?: ImageSourcePropType; tone?: CardTone; testID?: string; compact?: boolean;
}) {
  const t = cardTones[tone];
  const img = photo ? <Image source={photo} resizeMode="cover" style={{ width: '100%', height: '100%', opacity: t.dim ? 0.55 : 1 }} /> : null;
  if (compact) {
    return (
      <View testID={testID} style={{ backgroundColor: t.bg }}>
        <View style={{ flexDirection: 'row', minHeight: 112 }}>
          {img ? <View style={{ width: 104 }}>{img}</View> : null}
          <View style={{ flex: 1, paddingHorizontal: 14, paddingVertical: 12, justifyContent: 'space-between', gap: 6 }}>
            <View style={{ gap: 2 }}>
              <Display size={18} lines={1} style={{ color: t.fg }}>{eventName}</Display>
              <T lines={1} style={{ fontSize: 13, lineHeight: 18, color: t.sub }}>{when}</T>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
              <T lines={1} style={{ flexShrink: 1, fontFamily: font.semibold, fontSize: 13, lineHeight: 18, color: t.fg }}>{status}</T>
              <Display size={26} style={{ color: t.fg }}>#{tokenId}</Display>
            </View>
          </View>
        </View>
        {holder ? <Mono style={{ color: t.sub, paddingHorizontal: 14, paddingBottom: 10 }}>{short(holder)}</Mono> : null}
      </View>
    );
  }
  return (
    <View testID={testID} style={{ backgroundColor: t.bg }}>
      {img ? <View style={{ height: 140 }}>{img}</View> : null}
      <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14, gap: 4 }}>
        <T style={{ fontFamily: font.semibold, fontSize: 13, lineHeight: 18, color: t.sub }}>{tierName}</T>
        <Display size={26} style={{ color: t.fg }}>{eventName}</Display>
        <T style={{ fontSize: 14, lineHeight: 20, color: t.sub }}>{when}</T>
      </View>
      <View style={{ height: 0, borderTopWidth: 2, borderStyle: 'dashed', borderColor: t.dash, marginHorizontal: 16 }} />
      <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 16, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flexShrink: 1, gap: 2 }}>
          <T style={{ fontFamily: font.bold, color: t.fg }}>{status}</T>
          {holder ? <Mono style={{ color: t.sub }}>{short(holder)}</Mono> : null}
        </View>
        <Display size={36} style={{ color: t.fg }}>#{tokenId}</Display>
      </View>
    </View>
  );
}

export function Badge({ label, tone = 'ink', testID }: { label: string; tone?: 'ink' | 'blue' | 'amber' | 'orange' | 'green' | 'line'; testID?: string }) {
  const bg = { ink: color.ink, blue: color.blue, amber: color.amber, orange: color.orange, green: color.green, line: 'transparent' }[tone];
  const fg = tone === 'amber' || tone === 'line' || tone === 'orange' ? color.ink : color.white;
  return (
    <View testID={testID} style={{ alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, backgroundColor: bg, borderWidth: tone === 'line' ? 1 : 0, borderColor: color.ink }}>
      <T lines={1} style={{ color: fg, fontFamily: font.bold, fontSize: 12, lineHeight: 16 }}>{label}</T>
    </View>
  );
}

/** Short tx hash that opens the block explorer when one is configured. */
export function TxLink({ hash, tint = color.muted }: { hash: string; tint?: string }) {
  const label = short(hash);
  if (!explorer) return <Mono style={{ color: tint }}>{label}</Mono>;
  return (
    <Pressable testID="tx-link" accessibilityRole="link" onPress={() => Linking.openURL(`${explorer}/tx/${hash}`)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Mono style={{ color: tint, textDecorationLine: 'underline' }}>{label}</Mono>
        <Ic name="external" size={14} tint={tint} />
      </View>
    </Pressable>
  );
}

export function Banner({ tone, icon, title, body, testID }: { tone: 'amber' | 'orange' | 'green'; icon: MarkName; title?: string; body?: string; testID?: string }) {
  const bg = { amber: color.amber, orange: color.orange, green: color.green }[tone];
  const fg = tone === 'green' ? color.white : color.ink;
  return (
    <View testID={testID} style={{ backgroundColor: bg, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Icon name={icon} size={title ? 40 : 30} tint={fg} />
      <View style={{ flex: 1, gap: 2 }}>
        {title ? <Display size={22} style={{ color: fg }}>{title}</Display> : null}
        {body ? <T style={{ fontFamily: title ? font.medium : font.semibold, color: fg }}>{body}</T> : null}
      </View>
    </View>
  );
}

export function Header({ title, back }: { title: string; back?: boolean }) {
  const app = useApp();
  return (
    <View style={styles.header}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 }}>
        {back ? <Pressable testID="back" accessibilityRole="button" accessibilityLabel="Quay lại" onPress={app.back} style={styles.backBtn}><Icon name="back" size={26} /></Pressable> : null}
        <Display size={back ? 20 : 28} lines={1} style={{ flexShrink: 1 }}>{title}</Display>
      </View>
      <Pressable testID="wallet-chip" accessibilityRole="button" accessibilityLabel={demoMode ? 'Mở ví' : 'Mở tài khoản'} onPress={() => app.go({ name: 'wallet' })} style={styles.chip}>
        <Ic name={demoMode ? 'wallet' : 'user'} size={22} />
        {/* A guest never sees an address; the demo build shows which test key is active. */}
        {demoMode ? <View><NetworkTag /><Mono testID="wallet-address" style={{ fontSize: 11, lineHeight: 14 }}>{short(app.wallet.address)}</Mono></View> : null}
      </Pressable>
    </View>
  );
}

/** Which chain the demo build talks to. Guests outside the demo never see a network. */
export function NetworkTag({ tint = color.muted }: { tint?: string }) {
  if (!demoMode) return null;
  return (
    <View testID="network" style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color.blue }} />
      <T style={{ fontFamily: font.semibold, fontSize: 9, lineHeight: 12, letterSpacing: 0.6, color: tint }}>{networkLabel.toUpperCase()}</T>
    </View>
  );
}

type NavKey = 'events' | 'market' | 'tickets' | 'me' | 'gate';
const navIcon: Record<NavKey, IconKey> = { events: 'home', market: 'store', tickets: 'ticket', me: 'user', gate: 'scan' };
export function Nav({ active }: { active: NavKey }) {
  const app = useApp();
  const unread = useUnread();
  // At the gate (door staff, no guest key) there is nothing to trade and no page of one's own.
  const guest = !app.leaveGate;
  const items: { key: NavKey; label: string }[] = [
    { key: 'events', label: 'Trang chủ' },
    ...(guest ? [{ key: 'market' as const, label: 'Chợ vé' }] : []),
    { key: 'tickets', label: 'Vé của tôi' },
    ...(guest ? [{ key: 'me' as const, label: 'Tôi' }] : []),
    ...(app.isScanner ? [{ key: 'gate' as const, label: 'Soát vé' }] : []),
  ];
  return (
    <View style={{ flexDirection: 'row', backgroundColor: color.white, borderTopWidth: 1, borderTopColor: color.paper, paddingTop: 4 }}>
      {items.map((i) => {
        const on = i.key === active;
        return (
          <Pressable key={i.key} testID={`nav-${i.key}`} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => app.reset({ name: i.key })} style={styles.navItem}>
            <View>
              {/* The active tab differs by colour only: same icon, same stroke. */}
              <Ic name={navIcon[i.key]} size={24} tint={on ? color.blue : color.muted} />
              {i.key === 'me' && unread > 0 ? <View testID="nav-unread" accessibilityLabel={`${unread} thông báo mới`} style={{ position: 'absolute', top: -2, right: -6, width: 12, height: 12, borderRadius: 6, backgroundColor: color.orange, borderWidth: 2, borderColor: color.white }} /> : null}
            </View>
            <T style={{ fontSize: 11, lineHeight: 14, color: on ? color.blue : color.muted, fontFamily: on ? font.bold : font.medium }}>{i.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Keeps every unknown outcome reachable, even after a restart and with no network. */
export function UnresolvedBar() {
  const app = useApp();
  const entries = useUnresolved();
  const [busy, setBusy] = React.useState(false);
  if (entries.length === 0) return null;
  return (
    <View testID="unresolved" style={{ backgroundColor: color.amber, paddingHorizontal: 20, paddingVertical: 12, gap: 8 }}>
      <T style={{ fontFamily: font.bold }}>Đang chờ kết quả</T>
      <Btn testID="unresolved-lookup" label="Kiểm tra lại" kind="dark" busy={busy} onPress={async () => {
        setBusy(true);
        await Promise.all(entries.map((e) => app.service.lookup(e.id).catch(() => null)));
        setBusy(false);
      }} />
    </View>
  );
}

export function Screen({ title, back, nav, children, footer, ownLookup, header, bare }: {
  title: string; back?: boolean; nav: 'events' | 'tickets' | 'market' | 'me'; children: React.ReactNode; footer?: React.ReactNode; ownLookup?: boolean;
  /** Replaces the standard header, e.g. a full-width photo. */
  header?: React.ReactNode;
  /** Content runs edge to edge, without side padding. */
  bare?: boolean;
}) {
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: color.white }}>
      <StatusBar style="dark" />
      {header ?? <Header title={title} back={back} />}
      {ownLookup ? null : <UnresolvedBar />}
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={bare ? { paddingBottom: 16 } : { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16, gap: 16 }}>{children}</ScrollView>
      {footer ? <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16, gap: 8, borderTopWidth: 1, borderTopColor: color.paper }}>{footer}</View> : null}
      <Nav active={nav} />
    </KeyboardAvoidingView>
  );
}

export const Center = ({ children }: { children?: React.ReactNode }) => <View style={{ padding: 32, alignItems: 'center', gap: 12 } as ViewStyle}>{children ?? <ActivityIndicator color={color.ink} />}</View>;

/** How many tickets are out for an event. */
export function Going({ count, tint = color.ink, testID }: { count: number; tint?: string; testID?: string }) {
  if (count <= 0) return null;
  return (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <Ic name="people" size={18} tint={tint} />
      <T style={{ fontFamily: font.semibold, fontSize: 13, lineHeight: 18, color: tint }}>{count.toLocaleString('vi-VN')} người đi</T>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 20, paddingVertical: 10, minHeight: 60 },
  backBtn: { width: 44, height: 44, marginLeft: -10, alignItems: 'center', justifyContent: 'center' },
  chip: { minHeight: 44, minWidth: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 8, borderRadius: 22, backgroundColor: color.paper, flexShrink: 0 },
  navItem: { flex: 1, minHeight: 58, alignItems: 'center', justifyContent: 'center', gap: 2 },
});
