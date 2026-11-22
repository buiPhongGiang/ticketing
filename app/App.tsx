import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold } from '@expo-google-fonts/inter';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Platform, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppContext, AppValue, Route } from './src/app-context';
import { config, demoMode, devKeys, exchangeOn, payOn, relayerUrl, socialOn } from './src/config';
import { NoticeWatcher } from './src/exchange-ui';
import { httpExchange } from './src/lib/exchange';
import { openedLink } from './src/links';
import { createTicketService } from './src/lib';
import { httpPay } from './src/lib/pay';
import { httpSocial } from './src/lib/social';
import { addressOnlySigner, httpGate, httpRelayer } from './src/lib/relayer';
import type { Address, KeyValueStore, LocalSigner } from './src/lib/types';
import { EventScreen } from './src/screens/EventScreen';
import { EventsScreen } from './src/screens/EventsScreen';
import { GatePinScreen, GateScreen } from './src/screens/GateScreen';
import { PayScreen } from './src/screens/PayScreen';
import { ReceiptScreen } from './src/screens/ReceiptScreen';
import { TxScreen } from './src/screens/TxScreen';
import { QrScreen } from './src/screens/QrScreen';
import { TicketScreen } from './src/screens/TicketScreen';
import { TicketsScreen } from './src/screens/TicketsScreen';
import { ResellScreen } from './src/screens/ResellScreen';
import { WalletScreen } from './src/screens/WalletScreen';
import { ListingScreen } from './src/screens/ListingScreen';
import { MarketScreen } from './src/screens/MarketScreen';
import { NoticesScreen } from './src/screens/NoticesScreen';
import { ProfileScreen, UserScreen } from './src/screens/ProfileScreen';
import { color } from './src/theme';
import { loadWallet, selectDevWallet } from './src/wallet';

const store: KeyValueStore = AsyncStorage;
const relayer = relayerUrl ? httpRelayer(relayerUrl) : undefined;
const pay = payOn ? httpPay(relayerUrl) : undefined;
/** Key-less gate (published build): the relayer holds the gate key and checks the PIN. */
const remoteGateOn = !demoMode && !!relayerUrl;
const GATE_SESSION = 'ticketing.gate.session';
type GateSession = { address: Address; pin: string };
/** /gate on the web opens the PIN screen directly. */
const gateLink = Platform.OS === 'web' && typeof window !== 'undefined' && /^\/gate\/?$/.test(window.location.pathname);

async function loadGateSession(): Promise<GateSession | null> {
  if (!remoteGateOn) return null;
  try { return JSON.parse((await AsyncStorage.getItem(GATE_SESSION)) ?? 'null'); } catch { return null; }
}

export default function App() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });
  const [wallet, setWallet] = useState<LocalSigner | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [gate, setGate] = useState<GateSession | null | undefined>(undefined);
  useEffect(() => {
    loadWallet().then(setWallet).catch((e) => setFailure(String(e?.message ?? e)));
    loadGateSession().then(setGate);
  }, []);
  const enterGate = useCallback(async (pin: string) => {
    const { address } = await httpGate(relayerUrl, pin).info();
    const session = { address, pin };
    await AsyncStorage.setItem(GATE_SESSION, JSON.stringify(session));
    setGate(session);
  }, []);
  const gateSigner = useMemo(() => (gate ? addressOnlySigner(gate.address) : null), [gate]);
  const leaveGate = useCallback(() => {
    AsyncStorage.removeItem(GATE_SESSION).catch(() => {});
    setGate(null);
  }, []);

  if (failure) return <View style={{ flex: 1, padding: 32, justifyContent: 'center' }}><Text testID="fatal">{failure}</Text></View>;
  if (!fontsLoaded || !wallet || gate === undefined) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator color={color.ink} /></View>;
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {gate && gateSigner ? <Root key={`gate:${gate.address}`} wallet={gateSigner} setWallet={setWallet} gate={gate} leaveGate={leaveGate} />
        : <Root key="guest" wallet={wallet} setWallet={setWallet} enterGate={remoteGateOn ? enterGate : undefined} />}
    </SafeAreaProvider>
  );
}

function Root({ wallet, setWallet, gate, enterGate, leaveGate }: { wallet: LocalSigner; setWallet: (w: LocalSigner) => void; gate?: GateSession; enterGate?: (pin: string) => Promise<void>; leaveGate?: () => void }) {
  const service = useMemo(() => createTicketService({ config, signer: wallet, store, relayer, gate: gate ? httpGate(relayerUrl, gate.pin) : undefined }), [wallet, gate]);
  const social = useMemo(() => (socialOn && !gate ? httpSocial(relayerUrl, wallet, { chainId: config.chainId, contract: config.contract }) : undefined), [wallet, gate]);
  const exchange = useMemo(() => (exchangeOn && !gate ? httpExchange(relayerUrl, wallet, { chainId: config.chainId, contract: config.contract }) : undefined), [wallet, gate]);
  // A shared link (/#/l/12, /#/e/3, …) opens its screen directly, with its tab underneath.
  const [stack, setStack] = useState<Route[]>(() => (gate ? [{ name: 'gate' }] : enterGate && gateLink ? [{ name: 'gate-pin' }] : openedLink() ?? [{ name: 'events' }]));
  const [isScanner, setIsScanner] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Pick up anything left unresolved by a previous run, at launch and when returning to the app.
  useEffect(() => {
    const resume = () => { service.resume().catch(() => {}); };
    resume();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') resume(); });
    return () => sub.remove();
  }, [service]);

  useEffect(() => {
    let live = true;
    if (gate) { setIsScanner(true); return; }
    service.isScanner(wallet.address).then((v) => { if (live) setIsScanner(v); }).catch(() => { if (live) setIsScanner(false); });
    return () => { live = false; };
  }, [service, wallet.address, refreshKey, gate]);

  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) { back(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [back, stack.length]);

  const value: AppValue = useMemo(() => ({
    wallet, service, isScanner, refreshKey, back, pay, store, social, exchange,
    go: (r) => setStack((s) => [...s, r]),
    reset: (r) => setStack([r]),
    refresh: () => setRefreshKey((k) => k + 1),
    devWallets: devKeys,
    useDevWallet: async (i) => { setWallet(await selectDevWallet(i)); setStack([{ name: 'tickets' }]); setRefreshKey((k) => k + 1); },
    enterGate, leaveGate,
  }), [wallet, service, isScanner, refreshKey, back, setWallet, enterGate, leaveGate, social, exchange]);

  const route = stack[stack.length - 1];
  const onGate = route.name === 'gate';
  return (
    <AppContext.Provider value={value}>
      {gate ? null : <NoticeWatcher />}
      {/* The gate paints its own full-screen colour, so it handles the safe area itself. */}
      <View style={{ flex: 1, backgroundColor: color.ink, alignItems: 'center' }}>
      <View style={{ flex: 1, width: '100%', maxWidth: 480 }}>
      <SafeAreaView key={wallet.address} edges={onGate ? [] : undefined} style={{ flex: 1, backgroundColor: onGate ? color.ink : color.white }}>
        {route.name === 'events' && <EventsScreen />}
        {route.name === 'event' && <EventScreen eventId={route.eventId} />}
        {route.name === 'tx' && <TxScreen entryId={route.entryId} />}
        {route.name === 'tickets' && <TicketsScreen notice={route.notice} />}
        {route.name === 'ticket' && <TicketScreen tokenId={route.tokenId} />}
        {route.name === 'resell' && <ResellScreen tokenId={route.tokenId} />}
        {route.name === 'qr' && <QrScreen tokenId={route.tokenId} />}
        {route.name === 'gate' && <GateScreen />}
        {route.name === 'gate-pin' && <GatePinScreen />}
        {route.name === 'wallet' && <WalletScreen />}
        {route.name === 'pay' && <PayScreen order={route.order} />}
        {route.name === 'receipt' && <ReceiptScreen code={route.code} />}
        {route.name === 'market' && <MarketScreen eventId={route.eventId} />}
        {route.name === 'listing' && <ListingScreen tokenId={route.tokenId} />}
        {route.name === 'me' && <ProfileScreen />}
        {route.name === 'user' && <UserScreen account={route.account} />}
        {route.name === 'notices' && <NoticesScreen />}
      </SafeAreaView>
      </View>
      </View>
    </AppContext.Provider>
  );
}
