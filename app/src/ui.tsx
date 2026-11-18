import React from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextStyle, View, ViewStyle } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { StatusBar } from 'expo-status-bar';
import { useApp } from './app-context';
import { eventInfo } from './config';
import { useUnresolved } from './hooks';
import { color, font } from './theme';

export const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function T({ style, children, testID }: { style?: TextStyle | TextStyle[]; children: React.ReactNode; testID?: string }) {
  return <Text testID={testID} style={[{ fontFamily: font.body, fontSize: 15, lineHeight: 22, color: color.ink }, style as TextStyle]}>{children}</Text>;
}
export const Display = ({ size = 34, style, children, testID }: { size?: number; style?: TextStyle; children: React.ReactNode; testID?: string }) => (
  <T testID={testID} style={[{ fontFamily: font.display, fontSize: size, lineHeight: Math.ceil(size * 1.32), textTransform: 'uppercase' }, style as TextStyle]}>{children}</T>
);
export const Mono = ({ style, children, testID }: { style?: TextStyle; children: React.ReactNode; testID?: string }) => (
  <T testID={testID} style={[{ fontFamily: font.mono, fontSize: 12, lineHeight: 16 }, style as TextStyle]}>{children}</T>
);

type IconName = 'back' | 'check' | 'x' | 'clock' | 'off' | 'lock';
export function Icon({ name, size = 24, tint = color.ink }: { name: IconName; size?: number; tint?: string }) {
  const p = { stroke: tint, strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
      {name === 'back' && <Path d="M15 5l-7 7 7 7" {...p} />}
      {name === 'check' && <Path d="M4 12.5l5.5 5.5L20 6.5" {...p} />}
      {name === 'x' && <><Path d="M6 6l12 12" {...p} /><Path d="M18 6L6 18" {...p} /></>}
      {name === 'clock' && <><Circle cx="12" cy="12" r="9" {...p} /><Path d="M12 7v5l3.5 2" {...p} /></>}
      {name === 'off' && <><Path d="M3 3l18 18" {...p} /><Path d="M8.5 16.5a5 5 0 0 1 7 0" {...p} /><Path d="M5 12.5a10 10 0 0 1 4-2.6" {...p} /><Path d="M19 12.5a10 10 0 0 0-5-2.8" {...p} /></>}
      {name === 'lock' && <><Rect x="5" y="11" width="14" height="9" rx="1" {...p} /><Path d="M8 11V7a4 4 0 0 1 8 0v4" {...p} /></>}
    </Svg>
  );
}

type BtnKind = 'primary' | 'secondary' | 'dark' | 'light';
const btnStyles: Record<BtnKind, { bg: string; fg: string; border: string }> = {
  primary: { bg: color.blue, fg: color.white, border: color.blue },
  secondary: { bg: 'transparent', fg: color.ink, border: color.ink },
  dark: { bg: color.ink, fg: color.white, border: color.ink },
  light: { bg: color.white, fg: color.ink, border: color.white },
};
export function Btn({ label, onPress, kind = 'primary', disabled, busy, testID }: { label: string; onPress?: () => void; kind?: BtnKind; disabled?: boolean; busy?: boolean; testID?: string }) {
  const s = btnStyles[kind];
  const off = disabled || busy;
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled: !!off, busy: !!busy }} disabled={off} onPress={onPress}
      style={[styles.btn, off && !busy ? { backgroundColor: color.line, borderColor: color.line } : { backgroundColor: s.bg, borderColor: s.border }]}>
      {busy ? <ActivityIndicator color={s.fg} /> : <T style={{ fontFamily: font.semibold, fontSize: 16, color: off ? color.ink : s.fg, textAlign: 'center' }}>{label}</T>}
    </Pressable>
  );
}

export function Row({ label, value, mono, testID }: { label: string; value: string; mono?: boolean; testID?: string }) {
  return (
    <View style={styles.row}>
      <T style={{ color: color.muted, flexShrink: 0 }}>{label}</T>
      {mono ? <Mono testID={testID} style={{ fontSize: 13 }}>{value}</Mono> : <T testID={testID} style={{ fontFamily: font.medium, flexShrink: 1, textAlign: 'right' }}>{value}</T>}
    </View>
  );
}

function Dashes({ tint }: { tint: string }) {
  return (
    <View style={{ flexDirection: 'row', overflow: 'hidden', gap: 5, marginHorizontal: 16, height: 2 }}>
      {Array.from({ length: 50 }, (_, i) => <View key={i} style={{ width: 7, height: 2, backgroundColor: tint }} />)}
    </View>
  );
}

export function TicketCard({ tokenId, status, holder, tone = 'live', testID, compact }: { tokenId: string; status: string; holder: string; tone?: 'live' | 'gone' | 'used'; testID?: string; compact?: boolean }) {
  const t = {
    live: { bg: color.blue, fg: color.white, sub: color.blueSub },
    gone: { bg: color.white, fg: color.ink, sub: color.muted },
    used: { bg: color.ink, fg: color.white, sub: color.darkMuted },
  }[tone];
  const frame = [{ backgroundColor: t.bg }, tone === 'gone' && { borderWidth: 2, borderColor: color.muted, borderStyle: 'dashed' as const }];
  if (compact) {
    return (
      <View testID={testID} style={[...frame, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: 20, paddingVertical: 10 }]}>
        <View style={{ flexShrink: 1, gap: 2 }}>
          <T style={{ fontFamily: font.semibold, color: t.fg }}>{status}</T>
          {tone === 'live' ? null : <Mono style={{ color: t.sub }}>{short(holder)}</Mono>}
        </View>
        <Display size={56} style={{ color: t.fg }}>#{tokenId}</Display>
      </View>
    );
  }
  return (
    <View testID={testID} style={frame}>
      <View style={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 16, gap: 4 }}>
        <Display style={{ color: t.fg }}>{eventInfo.name}</Display>
        <T style={{ fontSize: 14, lineHeight: 20, color: t.sub }}>{eventInfo.when} · {eventInfo.venue}</T>
      </View>
      <Dashes tint={t.sub} />
      <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 20, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <View style={{ flexShrink: 1, gap: 2 }}>
          <T style={{ fontFamily: font.semibold, color: t.fg }}>{status}</T>
          <Mono style={{ color: t.sub }}>{short(holder)}</Mono>
        </View>
        <Display size={56} style={{ color: t.fg }}>#{tokenId}</Display>
      </View>
      <View style={[styles.notch, { left: -11 }]} />
      <View style={[styles.notch, { right: -11 }]} />
    </View>
  );
}

export function Banner({ tone, icon, title, body, testID }: { tone: 'amber' | 'orange' | 'green'; icon: IconName; title?: string; body?: string; testID?: string }) {
  const bg = { amber: color.amber, orange: color.orange, green: color.green }[tone];
  const fg = tone === 'green' ? color.white : color.ink;
  return (
    <View testID={testID} style={{ backgroundColor: bg, padding: title ? 20 : 16, gap: 12 }}>
      {title ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}><Icon name={icon} size={28} tint={fg} /><Display style={{ color: fg, flexShrink: 1 }}>{title}</Display></View>
      ) : null}
      {title ? (body ? <T style={{ fontFamily: font.medium, color: fg }}>{body}</T> : null) : (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}><Icon name={icon} tint={fg} /><T style={{ fontFamily: font.semibold, color: fg, flexShrink: 1 }}>{body}</T></View>
      )}
    </View>
  );
}

export function Header({ title, back }: { title: string; back?: boolean }) {
  const app = useApp();
  return (
    <View style={styles.header}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 }}>
        {back ? <Pressable testID="back" accessibilityRole="button" accessibilityLabel="Back" onPress={app.back} style={styles.iconBtn}><Icon name="back" /></Pressable> : null}
        <Display size={28} style={{ flexShrink: 1 }}>{title}</Display>
      </View>
      <Pressable testID="wallet-chip" accessibilityRole="button" accessibilityLabel="Open wallet" onPress={() => app.go({ name: 'wallet' })} style={styles.chip}>
        <Mono testID="wallet-address">{short(app.wallet.address)}</Mono>
      </Pressable>
    </View>
  );
}

type NavKey = 'event' | 'tickets' | 'gate' | 'dashboard';
export function Nav({ active }: { active: NavKey }) {
  const app = useApp();
  const items: { key: NavKey; label: string }[] = [
    { key: 'event', label: 'Event' },
    { key: 'tickets', label: 'My tickets' },
    ...(app.isScanner ? [{ key: 'gate' as const, label: 'Gate' }] : []),
    ...(app.isOrganizer ? [{ key: 'dashboard' as const, label: 'Overview' }] : []),
  ];
  return (
    <View style={{ flexDirection: 'row', backgroundColor: color.white }}>
      {items.map((i) => {
        const on = i.key === active;
        return (
          <Pressable key={i.key} testID={`nav-${i.key}`} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => app.reset({ name: i.key })}
            style={[styles.navItem, { borderTopColor: on ? color.blue : 'transparent' }]}>
            <T style={{ fontSize: 14, color: on ? color.blue : color.muted, fontFamily: on ? font.semibold : font.body }}>{i.label}</T>
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
      <T style={{ fontFamily: font.semibold }}>Unconfirmed transaction</T>
      <Btn testID="unresolved-lookup" label="Look up transaction" kind="dark" busy={busy} onPress={async () => {
        setBusy(true);
        await Promise.all(entries.map((e) => app.service.lookup(e.id).catch(() => null)));
        setBusy(false);
      }} />
    </View>
  );
}

export function Screen({ title, back, nav, children, footer, ownLookup }: { title: string; back?: boolean; nav: 'event' | 'tickets' | 'dashboard'; children: React.ReactNode; footer?: React.ReactNode; ownLookup?: boolean }) {
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: color.paper }}>
      <StatusBar style="dark" />
      <Header title={title} back={back} />
      {ownLookup ? null : <UnresolvedBar />}
      <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16, gap: 16 }}>{children}</ScrollView>
      {footer ? <View style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 8 }}>{footer}</View> : null}
      <Nav active={nav} />
    </KeyboardAvoidingView>
  );
}

export const Center = ({ children }: { children?: React.ReactNode }) => <View style={{ padding: 32, alignItems: 'center', gap: 12 } as ViewStyle}>{children ?? <ActivityIndicator color={color.ink} />}</View>;

const styles = StyleSheet.create({
  btn: { minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.line },
  notch: { position: 'absolute', top: 88, width: 20, height: 20, borderRadius: 10, backgroundColor: color.paper },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 20, paddingVertical: 12, minHeight: 56 },
  iconBtn: { width: 44, height: 44, marginLeft: -10, alignItems: 'center', justifyContent: 'center' },
  chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, backgroundColor: color.white, borderWidth: 1, borderColor: color.line },
  navItem: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', borderTopWidth: 3 },
});
