import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../app-context';
import { config, demoMode } from '../config';
import { formatAmount } from '../format';
import { clock, useEntry, useSecondsLeft } from '../hooks';
import { createOfflineGate, type OfflineVerdict, type QueuedScan } from '../lib/offline';
import type { ErrorCode, QrPayload, ScanVerdict } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import type { IconKey } from '../art';
import { Badge, Btn, Display, Ic, Mono, NetworkTag, Screen, T, UnresolvedBar, short } from '../ui';
import { receiptLine } from './TicketsScreen';

type Mode =
  | { m: 'scan' } | { m: 'checking' }
  | { m: 'verdict'; raw: string; verdict: ScanVerdict }
  | { m: 'offline'; raw: string; verdict: OfflineVerdict }
  | { m: 'queued'; tokenId: string; label: string }
  | { m: 'sending'; raw: string; tokenId: string }
  | { m: 'sent'; entryId: string; tokenId: string; holder: string }
  | { m: 'error'; code: ErrorCode };

const MIN_SECONDS = 15;
/** How often the gate checks the connection, sends queued scans and refreshes the holder list. */
const SYNC_MS = 10_000;

/** Short staff-facing reason for a scan admitted offline that could not be recorded on chain. */
export const conflictText: Partial<Record<ErrorCode, string>> = {
  OwnerChanged: 'Vé đã bán lại sau khi quét',
  AlreadyCheckedIn: 'Vé đã vào cửa từ trước',
  SignatureExpired: 'Mã QR hết hạn trước khi đồng bộ',
};

export function GateScreen() {
  const app = useApp();
  const [mode, setMode] = useState<Mode>({ m: 'scan' });
  const [balance, setBalance] = useState<string | null>(null);
  const handling = useRef(false);
  const offline = useMemo(() => createOfflineGate({ store: AsyncStorage, chain: app.service, scope: `${config.chainId}:${config.contract.toLowerCase()}:${app.wallet.address.toLowerCase()}` }), [app.service, app.wallet.address]);
  const [online, setOnline] = useState<boolean | null>(null);
  const [queue, setQueue] = useState<QueuedScan[]>([]);
  const syncing = useRef(false);

  const [listAt, setListAt] = useState<number | null>(null);
  const reloadQueue = useCallback(async () => {
    try {
      setQueue(await offline.queue());
      setListAt((await offline.snapshot())?.takenAt ?? null);
    } catch {}
  }, [offline]);
  /** Online: send queued scans, then refresh the holder list. Offline: just say so. */
  const sync = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      try {
        await app.service.ping();
      } catch {
        setOnline(false);
        return;
      }
      setOnline(true);
      await offline.flush();
      await offline.refresh();
    } catch {
      // A failed read while online: keep the last list and try again on the next round.
    } finally {
      syncing.current = false;
      reloadQueue();
    }
  }, [app.service, offline, reloadQueue]);
  useEffect(() => {
    sync();
    const t = setInterval(sync, SYNC_MS);
    return () => clearInterval(t);
  }, [sync]);

  useEffect(() => {
    let live = true;
    app.service.getBalances(app.wallet.address).then((b) => { if (live) setBalance(b.native); }).catch(() => {});
    return () => { live = false; };
  }, [app.service, app.wallet.address, mode.m]);

  const inspect = useCallback(async (raw: string) => {
    if (handling.current) return;
    handling.current = true;
    setMode({ m: 'checking' });
    if (online !== false) {
      try {
        // Also refused if this device already admitted the ticket offline and the chain has not caught up.
        setMode({ m: 'verdict', raw, verdict: await offline.screenOnline(await app.service.preflight(raw)) });
        return;
      } catch (e) {
        if (codeOf(e) !== 'Network') { setMode({ m: 'error', code: codeOf(e) }); return; }
        setOnline(false);
      }
    }
    // No network: check the QR against the holder list kept on this device.
    setMode({ m: 'offline', raw, verdict: await offline.verify(raw) });
  }, [app.service, offline, online]);

  const again = useCallback(() => { handling.current = false; setMode({ m: 'scan' }); }, []);

  async function confirm(raw: string, tokenId: string, holder: string) {
    setMode({ m: 'sending', raw, tokenId });
    try {
      const screened = await offline.screenOnline({ kind: 'ok', payload: JSON.parse(raw), secondsLeft: MIN_SECONDS });
      if (screened.kind === 'rejected') { setMode({ m: 'verdict', raw, verdict: screened }); return; }
      const result = await app.service.checkIn(raw);
      if ('hash' in result) {
        await offline.markIn(tokenId);
        setMode({ m: 'sent', entryId: result.id, tokenId, holder });
      } else setMode({ m: 'verdict', raw, verdict: result });
    } catch (e) {
      setMode({ m: 'error', code: codeOf(e) });
    }
  }

  async function admitOffline(raw: string) {
    const v = await offline.admit(raw);
    await reloadQueue();
    if (v.kind === 'ok') setMode({ m: 'queued', tokenId: v.payload.tokenId, label: `${v.eventName} · ${v.tierName}` });
    else setMode({ m: 'offline', raw, verdict: v });
  }

  const waiting = queue.filter((q) => q.state === 'queued' || q.state === 'sent').length;
  const flagged = queue.filter((q) => q.state === 'conflict');
  const bar = (fg: string) => <GateBar balance={balance} tint={fg} online={online} waiting={waiting} flagged={flagged.length} listAt={listAt} />;
  if (mode.m === 'scan' || mode.m === 'checking') return <Scanner bar={bar} checking={mode.m === 'checking'} flagged={flagged} onCode={inspect} onExit={() => (app.leaveGate ? app.leaveGate() : app.reset({ name: 'tickets' }))} />;
  if (mode.m === 'sending') return <Verdict bar={bar} bg={color.amber} fg={color.ink} icon="clock" title="Đang gửi" body="Chưa cho vào." testID="gate-sending" />;
  if (mode.m === 'sent') return <Sent bar={bar} {...mode} onNext={again} />;
  if (mode.m === 'error') return <Verdict bar={bar} bg={color.ink} fg={color.white} icon="off" title="Chưa kiểm tra được" body={messageFor(mode.code)} testID="gate-error"><Btn testID="next" label="Quét lại" kind="light" onPress={again} /></Verdict>;
  if (mode.m === 'queued') {
    return (
      <Verdict bar={bar} bg={color.green} fg={color.white} icon="check" title="Mời vào" body={`Vé #${mode.tokenId} · ${mode.label}`} testID="gate-queued">
        <Mono testID="gate-queued-note" style={{ fontSize: 13, color: color.white }}>Đã kiểm ngoại tuyến · đồng bộ khi có mạng</Mono>
        <View style={{ flex: 1 }} />
        <Btn testID="next" label="Quét vé tiếp theo" kind="light" onPress={again} />
      </Verdict>
    );
  }

  const { verdict, raw } = mode;
  if (verdict.kind === 'invalid-qr') {
    return <Verdict bar={bar} bg={color.orange} fg={color.ink} icon="x" title="Không đọc được" body="Đây không phải mã vé." testID="gate-invalid"><Btn testID="next" label="Quét vé tiếp theo" kind="dark" onPress={again} /></Verdict>;
  }
  if (verdict.kind === 'no-snapshot') {
    return <Verdict bar={bar} bg={color.ink} fg={color.white} icon="off" title="Chưa có danh sách vé" body="Hãy kết nối mạng một lần để tải." testID="gate-no-snapshot"><Btn testID="next" label="Quét lại" kind="light" onPress={again} /></Verdict>;
  }
  if (verdict.kind === 'rejected') {
    return (
      <Verdict bar={bar} bg={color.orange} fg={color.ink} icon="x" title="Không cho vào" body={`${messageFor(verdict.code)}.`} testID="gate-rejected">
        <Mono testID="gate-reason" style={{ height: 0, opacity: 0 }}>{verdict.code}</Mono>
        {verdict.code === 'OwnerChanged' ? <View><Mono style={{ fontSize: 13, lineHeight: 18 }}>Mã QR của {short(verdict.payload.holder)}</Mono>{verdict.owner ? <Mono style={{ fontSize: 13, lineHeight: 18 }}>Vé hiện do {short(verdict.owner)} giữ</Mono> : null}</View> : null}
        <View style={{ flex: 1 }} />
        <Btn testID="next" label="Quét vé tiếp theo" kind="dark" onPress={again} />
      </Verdict>
    );
  }
  if (mode.m === 'offline') {
    const ov = mode.verdict as Extract<OfflineVerdict, { kind: 'ok' | 'expiring' }>;
    return <Pass bar={bar} raw={raw} verdict={ov} label={ov.kind === 'ok' ? `${ov.eventName} · ${ov.tierName}. Kiểm ngoại tuyến.` : undefined} onConfirm={(r) => admitOffline(r)} onCancel={again} />;
  }
  const v = verdict as Extract<ScanVerdict, { kind: 'ok' | 'expiring' }>;
  return <Pass bar={bar} raw={raw} verdict={v} label={v.kind === 'ok' && v.ticket ? `${v.ticket.event.name} · ${v.ticket.tierName}.` : undefined} onConfirm={confirm} onCancel={again} />;
}

/** Age of the offline holder list; past MAX_LIST_AGE_SEC the gate refuses offline checks. */
const age = (at: number) => `${Math.max(0, Math.floor((Date.now() - at) / 60_000))} phút`;

function GateBar({ balance, tint: fg, online, waiting, flagged, listAt }: { balance: string | null; tint: string; online: boolean | null; waiting: number; flagged: number; listAt: number | null }) {
  const app = useApp();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, paddingHorizontal: 20, paddingVertical: 12 }}>
      <View style={{ gap: 2 }}>
        <NetworkTag tint={fg} />
        <T style={{ color: fg, fontFamily: font.bold, fontSize: 14 }}>Soát vé{demoMode ? ` · ${short(app.wallet.address)}` : ''}</T>
        {/* When the holder list used for offline checks was last read. */}
        {listAt && online !== false ? <Mono testID="gate-list" style={{ color: fg }}>Danh sách cập nhật {age(listAt)} trước</Mono> : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        {online === false || waiting > 0 ? <Badge testID="gate-offline" tone={online === false ? 'amber' : 'line'} label={`${online === false ? 'Mất mạng' : 'Đang đồng bộ'} · ${waiting} lượt chờ gửi`} /> : null}
        {online === false && listAt ? <Badge testID="gate-offline-age" tone="amber" label={`Danh sách ${age(listAt)} trước`} /> : null}
        {flagged > 0 ? <Badge testID="gate-flagged" tone="orange" label={`${flagged} lượt cần xem lại`} /> : null}
        {online === false || !demoMode ? null : <Mono testID="gate-balance" style={{ color: fg }}>{balance ? formatAmount(balance, config.nativeSymbol) : '…'}</Mono>}
      </View>
    </View>
  );
}

function Scanner({ bar, checking, flagged, onCode, onExit }: { bar: (fg: string) => React.ReactNode; checking: boolean; flagged: QueuedScan[]; onCode: (raw: string) => void; onExit: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const cameraReady = Platform.OS !== 'web' && permission?.granted;
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: color.ink }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, paddingTop: insets.top, paddingBottom: insets.bottom }} keyboardShouldPersistTaps="handled">
      <StatusBar style="light" />
      {bar(color.white)}
      <UnresolvedBar />
      {/* No camera on web: no empty viewfinder, the paste field is the scanner. */}
      <View style={Platform.OS === 'web' ? { paddingHorizontal: 20 } : { flex: 1, minHeight: 320, backgroundColor: color.camera, alignItems: 'center', justifyContent: 'center' }}>
        {cameraReady ? (
          <CameraView testID="camera" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={checking ? undefined : ({ data }) => onCode(data)} />
        ) : Platform.OS !== 'web' ? (
          <View style={{ padding: 24, gap: 12, width: '100%' }}>
                        <Btn testID="camera-permission" label="Cho phép dùng camera" kind="light" onPress={requestPermission} />
          </View>
        ) : null}
        {checking ? <Display testID="gate-checking" size={24} style={{ color: color.white }}>Đang kiểm tra…</Display> : null}
      </View>
      <View style={{ padding: 20, gap: 8 }}>
        <Display size={24} style={{ color: color.white }}>Quét vé</Display>
        <TextInput testID="manual-code" accessibilityLabel="Nhập mã vé bằng tay" value={manual} onChangeText={setManual} autoCapitalize="none" autoCorrect={false} placeholder="Dán mã vé" placeholderTextColor={color.darkMuted}
          style={{ minHeight: 44, padding: 10, fontFamily: font.mono, fontSize: 13, color: color.white, borderWidth: 1, borderColor: color.darkMuted }} />
        {manual ? <Btn testID="manual-submit" label="Kiểm tra" kind="light" onPress={() => onCode(manual.trim())} /> : null}
        {flagged.length ? (
          <View testID="gate-conflicts" style={{ gap: 4, paddingVertical: 8 }}>
            <T style={{ color: color.orange, fontFamily: font.bold, fontSize: 13 }}>Đã cho vào khi mất mạng, chưa ghi nhận được</T>
            {flagged.map((q) => <Mono key={q.tokenId} style={{ color: color.white, fontSize: 13, lineHeight: 18 }}>#{q.tokenId} · {conflictText[q.conflict!] ?? messageFor(q.conflict)}</Mono>)}
          </View>
        ) : null}
        <Pressable testID="exit-gate" accessibilityRole="button" onPress={onExit} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><T style={{ color: color.white, fontFamily: font.medium }}>Rời cổng soát vé</T></Pressable>
      </View>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Pass({ bar, raw, verdict, label, onConfirm, onCancel }: { bar: (fg: string) => React.ReactNode; raw: string; verdict: { payload: QrPayload }; label?: string; onConfirm: (raw: string, tokenId: string, holder: string) => void; onCancel: () => void }) {
  const { payload } = verdict;
  const left = useSecondsLeft(payload.deadline);
  if (left < MIN_SECONDS) {
    return (
      <Verdict bar={bar} bg={color.amber} fg={color.ink} icon="clock" title="Mã QR sắp hết hạn" body="Nhờ khách tạo mã QR mới." testID="gate-expiring">
        <Countdown left={left} />
        <View style={{ flex: 1 }} />
        <Btn testID="confirm" label="Xác nhận cho vào" disabled />
        <Btn testID="next" label="Quét mã QR mới" kind="dark" onPress={onCancel} />
      </Verdict>
    );
  }
  return (
    <Verdict bar={bar} bg={color.amber} fg={color.ink} icon="clock" title={`Vé #${payload.tokenId} hợp lệ`} body={label ? `${label} Chưa cho vào.` : 'Chưa cho vào.'} testID="gate-valid">
      <Countdown left={left} />
      <View style={{ flex: 1 }} />
      <Btn testID="confirm" label="Xác nhận cho vào" kind="dark" onPress={() => onConfirm(raw, payload.tokenId, payload.holder)} />
      <Btn testID="cancel" label="Hủy" kind="secondary" onPress={onCancel} />
    </Verdict>
  );
}

const Countdown = ({ left }: { left: number }) => (
  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
    <Mono style={{ fontSize: 13 }}>Mã QR còn hiệu lực</Mono><Mono testID="gate-clock" style={{ fontSize: 13 }}>{clock(left)}</Mono>
  </View>
);

function Sent({ bar, entryId, tokenId, holder, onNext }: { bar: (fg: string) => React.ReactNode; entryId: string; tokenId: string; holder: string; onNext: () => void }) {
  const app = useApp();
  const entry = useEntry(entryId);
  const hash = entry ? short(entry.hash) : '';
  if (entry?.state === 'succeeded') {
    return (
      <Verdict bar={bar} bg={color.green} fg={color.white} icon="check" title="Mời vào" body={`Vé #${tokenId} đã vào cửa`} testID="gate-admitted">
        {demoMode ? <Mono style={{ fontSize: 13, color: color.white }}>Người giữ vé {short(holder)}</Mono> : null}
        {entry.feeWei ? <Mono testID="gate-receipt" style={{ fontSize: 16, lineHeight: 22, color: color.white }}>{receiptLine(entry.feeWei, entry.confirmedMs, entry.blockMs)}</Mono> : null}
        <View style={{ flex: 1 }} />
        <Btn testID="next" label="Quét vé tiếp theo" kind="light" onPress={onNext} />
      </Verdict>
    );
  }
  if (entry?.state === 'reverted') {
    return (
      <Verdict bar={bar} bg={color.orange} fg={color.ink} icon="x" title="Chưa cho vào được" body={`${messageFor(entry.reasonCode)}.`} testID="gate-reverted">
        <Mono style={{ fontSize: 13 }}>{hash}</Mono>
        <View style={{ flex: 1 }} />
        <Btn testID="next" label="Quét lại" kind="dark" onPress={onNext} />
      </Verdict>
    );
  }
  if (entry?.state === 'unknown') {
    return (
      <Verdict bar={bar} bg={color.ink} fg={color.white} icon="off" title="Chưa rõ kết quả" body="Hãy kiểm tra giao dịch. Đừng gửi lại." testID="gate-unknown">
        <Mono style={{ fontSize: 13, color: color.darkMuted }}>{hash}</Mono>
        <View style={{ flex: 1 }} />
        <Btn testID="lookup" label="Kiểm tra giao dịch" kind="light" onPress={() => app.service.lookup(entryId)} />
      </Verdict>
    );
  }
  return (
    <Verdict bar={bar} bg={color.amber} fg={color.ink} icon="clock" title="Đang xác nhận" body="Chưa cho vào." testID="gate-confirming">
      <Mono style={{ fontSize: 13 }}>{hash}</Mono>
    </Verdict>
  );
}

const markFor: Record<'check' | 'x' | 'clock' | 'off', IconKey> = { check: 'check', x: 'cross', clock: 'clock', off: 'offline' };

/** The verdict's mark, in the colour of its text. On a welcome it pops in and wiggles, so staff and guest both see it from a step away. */
function Burst({ name, play, tint }: { name: IconKey; play: boolean; tint: string }) {
  const pop = useRef(new Animated.Value(play ? 0 : 1)).current;
  const tilt = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!play) return;
    const native = Platform.OS !== 'web';
    Animated.sequence([
      Animated.spring(pop, { toValue: 1, friction: 4, tension: 120, useNativeDriver: native }),
      Animated.loop(Animated.sequence([
        Animated.timing(tilt, { toValue: 1, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: native }),
        Animated.timing(tilt, { toValue: -1, duration: 220, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
        Animated.timing(tilt, { toValue: 0, duration: 140, easing: Easing.in(Easing.quad), useNativeDriver: native }),
        Animated.delay(900),
      ]), { iterations: 3 }),
    ]).start();
  }, [play, pop, tilt]);
  const rotate = tilt.interpolate({ inputRange: [-1, 1], outputRange: ['-14deg', '14deg'] });
  return (
    <Animated.View style={{ alignSelf: 'flex-start', transform: [{ scale: pop }, { rotate }] }}>
      <Ic name={name} size={play ? 112 : 72} tint={tint} />
    </Animated.View>
  );
}

function Verdict({ bar, bg, fg, icon, title, body, testID, children }: { bar: (fg: string) => React.ReactNode; bg: string; fg: string; icon: 'check' | 'x' | 'clock' | 'off'; title: string; body: string; testID: string; children?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const celebrate = icon === 'check';
  return (
    <View testID={testID} style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top }}>
      <StatusBar style={fg === color.white ? 'light' : 'dark'} />
      {bar(fg)}
      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 28, paddingBottom: 20 + insets.bottom, gap: 16 }}>
        <Burst name={markFor[icon]} play={celebrate} tint={fg} />
        <Display size={52} style={{ color: fg }}>{title}</Display>
        <T style={{ fontSize: 18, lineHeight: 26, fontFamily: font.semibold, color: fg }}>{body}</T>
        {children}
      </View>
    </View>
  );
}

/**
 * Door staff on the published app: the PIN (GATE_PIN in the relayer's env, given out by the organizer) opens the gate.
 * The gate key stays on the relayer; this device only reads the chain and asks the relayer to send each check-in.
 */
export function GatePinScreen() {
  const app = useApp();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const open = async () => {
    if (!app.enterGate || !pin.trim()) return;
    setBusy(true);
    setError(null);
    try { await app.enterGate(pin.trim()); } catch (e) { setError(codeOf(e)); setBusy(false); }
  };
  return (
    <Screen title="Nhân viên soát vé" back nav="tickets" footer={<Btn testID="gate-pin-open" label="Mở cổng soát vé" kind="dark" busy={busy} disabled={!pin.trim()} onPress={open} />}>
      <T style={{ color: color.muted }}>Nhập mã PIN do ban tổ chức cấp để bắt đầu soát vé.</T>
      <TextInput testID="gate-pin" accessibilityLabel="Mã PIN soát vé" value={pin} onChangeText={setPin} onSubmitEditing={open} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="Mã PIN soát vé" placeholderTextColor={color.muted}
        style={{ minHeight: 52, paddingHorizontal: 12, fontFamily: font.mono, fontSize: 18, color: color.ink, borderWidth: 2, borderColor: color.ink, backgroundColor: color.white }} />
      {error ? <T testID="gate-pin-error" style={{ color: color.orange, fontFamily: font.medium }}>{messageFor(error)}</T> : null}
    </Screen>
  );
}
