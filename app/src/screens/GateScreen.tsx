import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../app-context';
import { config } from '../config';
import { formatAmount } from '../format';
import { clock, useEntry, useSecondsLeft } from '../hooks';
import { createOfflineGate, type OfflineVerdict, type QueuedScan } from '../lib/offline';
import type { ErrorCode, QrPayload, ScanVerdict } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Badge, Btn, Display, Icon, Mono, NetworkTag, short, T, UnresolvedBar } from '../ui';
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
  OwnerChanged: 'Resold since the scan',
  AlreadyCheckedIn: 'Already in on chain',
  SignatureExpired: 'QR expired before sync',
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
  if (mode.m === 'scan' || mode.m === 'checking') return <Scanner bar={bar} checking={mode.m === 'checking'} flagged={flagged} onCode={inspect} onExit={() => app.reset({ name: 'tickets' })} />;
  if (mode.m === 'sending') return <Verdict bar={bar} bg={color.amber} fg={color.ink} icon="clock" title="Sending" body="Do not admit yet." testID="gate-sending" />;
  if (mode.m === 'sent') return <Sent bar={bar} {...mode} onNext={again} />;
  if (mode.m === 'error') return <Verdict bar={bar} bg={color.ink} fg={color.white} icon="off" title="Could not check" body={messageFor(mode.code)} testID="gate-error"><Btn testID="next" label="Scan again" kind="light" onPress={again} /></Verdict>;
  if (mode.m === 'queued') {
    return (
      <Verdict bar={bar} bg={color.green} fg={color.white} icon="check" title="Welcome in" body={`Ticket #${mode.tokenId} · ${mode.label}`} testID="gate-queued">
        <Mono testID="gate-queued-note" style={{ fontSize: 13, color: color.white }}>Checked offline · syncs when online</Mono>
        <View style={{ flex: 1 }} />
        <Btn testID="next" label="Scan next ticket" kind="light" onPress={again} />
      </Verdict>
    );
  }

  const { verdict, raw } = mode;
  if (verdict.kind === 'invalid-qr') {
    return <Verdict bar={bar} bg={color.orange} fg={color.ink} icon="x" title="Unreadable" body="Not a ticket code." testID="gate-invalid"><Btn testID="next" label="Scan next ticket" kind="dark" onPress={again} /></Verdict>;
  }
  if (verdict.kind === 'no-snapshot') {
    return <Verdict bar={bar} bg={color.ink} fg={color.white} icon="off" title="No ticket list" body="Connect once to load it." testID="gate-no-snapshot"><Btn testID="next" label="Scan again" kind="light" onPress={again} /></Verdict>;
  }
  if (verdict.kind === 'rejected') {
    return (
      <Verdict bar={bar} bg={color.orange} fg={color.ink} icon="x" title="No entry" body={`${messageFor(verdict.code)}.`} testID="gate-rejected">
        <Mono testID="gate-reason" style={{ height: 0, opacity: 0 }}>{verdict.code}</Mono>
        {verdict.code === 'OwnerChanged' ? <View><Mono style={{ fontSize: 13, lineHeight: 18 }}>QR from {short(verdict.payload.holder)}</Mono>{verdict.owner ? <Mono style={{ fontSize: 13, lineHeight: 18 }}>Now held by {short(verdict.owner)}</Mono> : null}</View> : null}
        <View style={{ flex: 1 }} />
        <Btn testID="next" label="Scan next ticket" kind="dark" onPress={again} />
      </Verdict>
    );
  }
  if (mode.m === 'offline') {
    const ov = mode.verdict as Extract<OfflineVerdict, { kind: 'ok' | 'expiring' }>;
    return <Pass bar={bar} raw={raw} verdict={ov} label={ov.kind === 'ok' ? `${ov.eventName} · ${ov.tierName}. Offline check.` : undefined} onConfirm={(r) => admitOffline(r)} onCancel={again} />;
  }
  const v = verdict as Extract<ScanVerdict, { kind: 'ok' | 'expiring' }>;
  return <Pass bar={bar} raw={raw} verdict={v} label={v.kind === 'ok' && v.ticket ? `${v.ticket.event.name} · ${v.ticket.tierName}.` : undefined} onConfirm={confirm} onCancel={again} />;
}

/** Age of the offline holder list; past MAX_LIST_AGE_SEC the gate refuses offline checks. */
const age = (at: number) => `${Math.max(0, Math.floor((Date.now() - at) / 60_000))} min`;

function GateBar({ balance, tint: fg, online, waiting, flagged, listAt }: { balance: string | null; tint: string; online: boolean | null; waiting: number; flagged: number; listAt: number | null }) {
  const app = useApp();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, paddingHorizontal: 20, paddingVertical: 12 }}>
      <View style={{ gap: 2 }}>
        <NetworkTag tint={fg} />
        <Mono style={{ color: fg }}>Gate · {short(app.wallet.address)}</Mono>
        {/* When the holder list used for offline checks was last read. */}
        {listAt && online !== false ? <Mono testID="gate-list" style={{ color: fg }}>List {age(listAt)} old</Mono> : null}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        {online === false || waiting > 0 ? <Badge testID="gate-offline" tone={online === false ? 'amber' : 'line'} label={`${online === false ? 'Offline' : 'Syncing'} · ${waiting} queued`} /> : null}
        {online === false && listAt ? <Badge testID="gate-offline-age" tone="amber" label={`List ${age(listAt)} old`} /> : null}
        {flagged > 0 ? <Badge testID="gate-flagged" tone="orange" label={`${flagged} to check`} /> : null}
        {online === false ? null : <Mono testID="gate-balance" style={{ color: fg }}>{balance ? formatAmount(balance, config.nativeSymbol) : '…'}</Mono>}
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
                        <Btn testID="camera-permission" label="Allow camera" kind="light" onPress={requestPermission} />
          </View>
        ) : null}
        {checking ? <Display testID="gate-checking" style={{ color: color.white }}>Checking</Display> : null}
      </View>
      <View style={{ padding: 20, gap: 8 }}>
        <Display style={{ color: color.white }}>Scan QR</Display>
        <TextInput testID="manual-code" accessibilityLabel="Enter code manually" value={manual} onChangeText={setManual} autoCapitalize="none" autoCorrect={false} placeholder="Paste code" placeholderTextColor={color.darkMuted}
          style={{ minHeight: 44, padding: 10, fontFamily: font.mono, fontSize: 12, color: color.white, borderWidth: 1, borderColor: color.darkMuted }} />
        {manual ? <Btn testID="manual-submit" label="Check" kind="light" onPress={() => onCode(manual.trim())} /> : null}
        {flagged.length ? (
          <View testID="gate-conflicts" style={{ gap: 4, paddingVertical: 8 }}>
            <Mono style={{ color: color.orange, fontSize: 11, letterSpacing: 1 }}>ADMITTED OFFLINE · NOT ON CHAIN</Mono>
            {flagged.map((q) => <Mono key={q.tokenId} style={{ color: color.white, fontSize: 13, lineHeight: 18 }}>#{q.tokenId} · {conflictText[q.conflict!] ?? messageFor(q.conflict)}</Mono>)}
          </View>
        ) : null}
        <Pressable testID="exit-gate" accessibilityRole="button" onPress={onExit} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><T style={{ color: color.white, fontFamily: font.medium }}>Leave gate</T></Pressable>
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
      <Verdict bar={bar} bg={color.amber} fg={color.ink} icon="clock" title="QR expiring" body="Ask for a new QR." testID="gate-expiring">
        <Countdown left={left} />
        <View style={{ flex: 1 }} />
        <Btn testID="confirm" label="Confirm entry" disabled />
        <Btn testID="next" label="Scan a new QR" kind="dark" onPress={onCancel} />
      </Verdict>
    );
  }
  return (
    <Verdict bar={bar} bg={color.amber} fg={color.ink} icon="clock" title={`Ticket #${payload.tokenId} valid`} body={label ? `${label} Not admitted yet.` : 'Not admitted yet.'} testID="gate-valid">
      <Countdown left={left} />
      <View style={{ flex: 1 }} />
      <Btn testID="confirm" label="Confirm entry" kind="dark" onPress={() => onConfirm(raw, payload.tokenId, payload.holder)} />
      <Btn testID="cancel" label="Cancel" kind="secondary" onPress={onCancel} />
    </Verdict>
  );
}

const Countdown = ({ left }: { left: number }) => (
  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
    <Mono style={{ fontSize: 13 }}>QR valid for</Mono><Mono testID="gate-clock" style={{ fontSize: 13 }}>{clock(left)}</Mono>
  </View>
);

function Sent({ bar, entryId, tokenId, holder, onNext }: { bar: (fg: string) => React.ReactNode; entryId: string; tokenId: string; holder: string; onNext: () => void }) {
  const app = useApp();
  const entry = useEntry(entryId);
  const hash = entry ? short(entry.hash) : '';
  if (entry?.state === 'succeeded') {
    return (
      <Verdict bar={bar} bg={color.green} fg={color.white} icon="check" title="Welcome in" body={`Ticket #${tokenId} checked in`} testID="gate-admitted">
        <Mono style={{ fontSize: 13, color: color.white }}>Holder {short(holder)}</Mono>
        {entry.feeWei ? <Mono testID="gate-receipt" style={{ fontSize: 16, lineHeight: 22, color: color.white }}>{receiptLine(entry.feeWei, entry.confirmedMs, entry.blockMs)}</Mono> : null}
        <View style={{ flex: 1 }} />
        <Btn testID="next" label="Scan next ticket" kind="light" onPress={onNext} />
      </Verdict>
    );
  }
  if (entry?.state === 'reverted') {
    return (
      <Verdict bar={bar} bg={color.orange} fg={color.ink} icon="x" title="Not admitted" body={`${messageFor(entry.reasonCode)}.`} testID="gate-reverted">
        <Mono style={{ fontSize: 13 }}>{hash}</Mono>
        <View style={{ flex: 1 }} />
        <Btn testID="next" label="Scan again" kind="dark" onPress={onNext} />
      </Verdict>
    );
  }
  if (entry?.state === 'unknown') {
    return (
      <Verdict bar={bar} bg={color.ink} fg={color.white} icon="off" title="Result unknown" body="Look it up. Do not resend." testID="gate-unknown">
        <Mono style={{ fontSize: 13, color: color.darkMuted }}>{hash}</Mono>
        <View style={{ flex: 1 }} />
        <Btn testID="lookup" label="Look up transaction" kind="light" onPress={() => app.service.lookup(entryId)} />
      </Verdict>
    );
  }
  return (
    <Verdict bar={bar} bg={color.amber} fg={color.ink} icon="clock" title="Confirming" body="Do not admit yet." testID="gate-confirming">
      <Mono style={{ fontSize: 13 }}>{hash}</Mono>
    </Verdict>
  );
}

function Verdict({ bar, bg, fg, icon, title, body, testID, children }: { bar: (fg: string) => React.ReactNode; bg: string; fg: string; icon: 'check' | 'x' | 'clock' | 'off'; title: string; body: string; testID: string; children?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View testID={testID} style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top }}>
      <StatusBar style={fg === color.white ? 'light' : 'dark'} />
      {bar(fg)}
      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 28, paddingBottom: 20 + insets.bottom, gap: 16 }}>
        <Icon name={icon} size={72} tint={fg} />
        <Display size={64} style={{ color: fg }}>{title}</Display>
        <T style={{ fontSize: 17, lineHeight: 24, fontFamily: font.medium, color: fg }}>{body}</T>
        {children}
      </View>
    </View>
  );
}
