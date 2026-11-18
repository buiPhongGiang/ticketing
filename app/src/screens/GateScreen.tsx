import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '../app-context';
import { config } from '../config';
import { formatAmount } from '../format';
import { clock, useEntry, useSecondsLeft } from '../hooks';
import type { ErrorCode, ScanVerdict } from '../lib/types';
import { codeOf, messageFor } from '../messages';
import { color, font } from '../theme';
import { Btn, Display, Icon, Mono, NetworkTag, short, T, UnresolvedBar } from '../ui';
import { receiptLine } from './TicketsScreen';

type Mode =
  | { m: 'scan' } | { m: 'checking' }
  | { m: 'verdict'; raw: string; verdict: ScanVerdict }
  | { m: 'sending'; raw: string; tokenId: string }
  | { m: 'sent'; entryId: string; tokenId: string; holder: string }
  | { m: 'error'; code: ErrorCode };

const MIN_SECONDS = 15;

export function GateScreen() {
  const app = useApp();
  const [mode, setMode] = useState<Mode>({ m: 'scan' });
  const [balance, setBalance] = useState<string | null>(null);
  const handling = useRef(false);

  useEffect(() => {
    let live = true;
    app.service.getBalances(app.wallet.address).then((b) => { if (live) setBalance(b.native); }).catch(() => {});
    return () => { live = false; };
  }, [app.service, app.wallet.address, mode.m]);

  const inspect = useCallback(async (raw: string) => {
    if (handling.current) return;
    handling.current = true;
    setMode({ m: 'checking' });
    try {
      setMode({ m: 'verdict', raw, verdict: await app.service.preflight(raw) });
    } catch (e) {
      setMode({ m: 'error', code: codeOf(e) });
    }
  }, [app.service]);

  const again = useCallback(() => { handling.current = false; setMode({ m: 'scan' }); }, []);

  async function confirm(raw: string, tokenId: string, holder: string) {
    setMode({ m: 'sending', raw, tokenId });
    try {
      const result = await app.service.checkIn(raw);
      if ('hash' in result) setMode({ m: 'sent', entryId: result.id, tokenId, holder });
      else setMode({ m: 'verdict', raw, verdict: result });
    } catch (e) {
      setMode({ m: 'error', code: codeOf(e) });
    }
  }

  const bar = (fg: string) => <GateBar balance={balance} tint={fg} />;
  if (mode.m === 'scan' || mode.m === 'checking') return <Scanner bar={bar} checking={mode.m === 'checking'} onCode={inspect} onExit={() => app.reset({ name: 'tickets' })} />;
  if (mode.m === 'sending') return <Verdict bar={bar} bg={color.amber} fg={color.ink} icon="clock" title="Sending" body="Do not admit yet." testID="gate-sending" />;
  if (mode.m === 'sent') return <Sent bar={bar} {...mode} onNext={again} />;
  if (mode.m === 'error') return <Verdict bar={bar} bg={color.ink} fg={color.white} icon="off" title="Could not check" body={messageFor(mode.code)} testID="gate-error"><Btn testID="next" label="Scan again" kind="light" onPress={again} /></Verdict>;

  const { verdict, raw } = mode;
  if (verdict.kind === 'invalid-qr') {
    return <Verdict bar={bar} bg={color.orange} fg={color.ink} icon="x" title="Unreadable" body="Not a ticket code." testID="gate-invalid"><Btn testID="next" label="Scan next ticket" kind="dark" onPress={again} /></Verdict>;
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
  return <Pass bar={bar} raw={raw} verdict={verdict} onConfirm={confirm} onCancel={again} />;
}

function GateBar({ balance, tint: fg }: { balance: string | null; tint: string }) {
  const app = useApp();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8, paddingHorizontal: 20, paddingVertical: 12 }}>
      <View style={{ gap: 2 }}>
        <NetworkTag tint={fg} />
        <Mono style={{ color: fg }}>Gate · {short(app.wallet.address)}</Mono>
      </View>
      <Mono testID="gate-balance" style={{ color: fg, alignSelf: 'flex-end' }}>{balance ? formatAmount(balance, config.nativeSymbol) : '…'}</Mono>
    </View>
  );
}

function Scanner({ bar, checking, onCode, onExit }: { bar: (fg: string) => React.ReactNode; checking: boolean; onCode: (raw: string) => void; onExit: () => void }) {
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
        <Pressable testID="exit-gate" accessibilityRole="button" onPress={onExit} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><T style={{ color: color.white, fontFamily: font.medium }}>Leave gate</T></Pressable>
      </View>
    </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Pass({ bar, raw, verdict, onConfirm, onCancel }: { bar: (fg: string) => React.ReactNode; raw: string; verdict: Extract<ScanVerdict, { kind: 'ok' | 'expiring' }>; onConfirm: (raw: string, tokenId: string, holder: string) => void; onCancel: () => void }) {
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
    <Verdict bar={bar} bg={color.amber} fg={color.ink} icon="clock" title={`Ticket #${payload.tokenId} valid`} body={verdict.kind === 'ok' && verdict.ticket ? `${verdict.ticket.event.name} · ${verdict.ticket.tierName}. Not admitted yet.` : 'Not admitted yet.'} testID="gate-valid">
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
        {entry.feeWei ? <Mono testID="gate-receipt" style={{ fontSize: 12, color: color.white }}>{receiptLine(entry.feeWei, entry.confirmedMs)}</Mono> : null}
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
