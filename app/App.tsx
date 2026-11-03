import { BeVietnamPro_400Regular, BeVietnamPro_500Medium, BeVietnamPro_600SemiBold } from '@expo-google-fonts/be-vietnam-pro';
import { BigShouldersDisplay_800ExtraBold } from '@expo-google-fonts/big-shoulders-display';
import { IBMPlexMono_400Regular } from '@expo-google-fonts/ibm-plex-mono';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, AppState, BackHandler, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AppContext, AppValue, Route } from './src/app-context';
import { config, devKeys } from './src/config';
import { dashboardReader } from './src/dashboard-reader';
import { createTicketService } from './src/lib';
import type { KeyValueStore, LocalSigner } from './src/lib/types';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { EventScreen } from './src/screens/EventScreen';
import { GateScreen } from './src/screens/GateScreen';
import { PurchaseScreen } from './src/screens/PurchaseScreen';
import { QrScreen } from './src/screens/QrScreen';
import { TicketScreen } from './src/screens/TicketScreen';
import { TicketsScreen } from './src/screens/TicketsScreen';
import { TransferScreen } from './src/screens/TransferScreen';
import { WalletScreen } from './src/screens/WalletScreen';
import { color } from './src/theme';
import { loadWallet, selectDevWallet } from './src/wallet';

const store: KeyValueStore = AsyncStorage;

export default function App() {
  const [fontsLoaded] = useFonts({ BeVietnamPro_400Regular, BeVietnamPro_500Medium, BeVietnamPro_600SemiBold, BigShouldersDisplay_800ExtraBold, IBMPlexMono_400Regular });
  const [wallet, setWallet] = useState<LocalSigner | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => { loadWallet().then(setWallet).catch((e) => setFailure(String(e?.message ?? e))); }, []);

  if (failure) return <View style={{ flex: 1, padding: 32, justifyContent: 'center' }}><Text testID="fatal">{failure}</Text></View>;
  if (!fontsLoaded || !wallet) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator color={color.ink} /></View>;
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Root wallet={wallet} setWallet={setWallet} />
    </SafeAreaProvider>
  );
}

function Root({ wallet, setWallet }: { wallet: LocalSigner; setWallet: (w: LocalSigner) => void }) {
  const service = useMemo(() => createTicketService({ config, signer: wallet, store }), [wallet]);
  const [stack, setStack] = useState<Route[]>([{ name: 'event' }]);
  const [isScanner, setIsScanner] = useState(false);
  const [isOrganizer, setIsOrganizer] = useState(false);
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
    service.isScanner(wallet.address).then((v) => { if (live) setIsScanner(v); }).catch(() => { if (live) setIsScanner(false); });
    return () => { live = false; };
  }, [service, wallet.address, refreshKey]);

  useEffect(() => {
    let live = true;
    dashboardReader.getOrganizer()
      .then((owner) => { if (live) setIsOrganizer(owner.toLowerCase() === wallet.address.toLowerCase()); })
      .catch(() => { if (live) setIsOrganizer(false); });
    return () => { live = false; };
  }, [wallet.address, refreshKey]);

  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) { back(); return true; }
      return false;
    });
    return () => sub.remove();
  }, [back, stack.length]);

  const value: AppValue = useMemo(() => ({
    wallet, service, isScanner, isOrganizer, refreshKey, back,
    go: (r) => setStack((s) => [...s, r]),
    reset: (r) => setStack([r]),
    refresh: () => setRefreshKey((k) => k + 1),
    devWallets: devKeys,
    useDevWallet: async (i) => { setWallet(await selectDevWallet(i)); setStack([{ name: 'tickets' }]); setRefreshKey((k) => k + 1); },
  }), [wallet, service, isScanner, isOrganizer, refreshKey, back, setWallet]);

  const route = stack[stack.length - 1];
  const gate = route.name === 'gate';
  return (
    <AppContext.Provider value={value}>
      {/* The gate paints its own full-screen colour, so it handles the safe area itself. */}
      <SafeAreaView key={wallet.address} edges={gate ? [] : undefined} style={{ flex: 1, backgroundColor: gate || route.name === 'dashboard' ? color.ink : color.paper }}>
        {route.name === 'event' && <EventScreen />}
        {route.name === 'purchase' && <PurchaseScreen entryId={route.entryId} />}
        {route.name === 'tickets' && <TicketsScreen bought={route.bought} />}
        {route.name === 'ticket' && <TicketScreen tokenId={route.tokenId} />}
        {route.name === 'transfer' && <TransferScreen tokenId={route.tokenId} />}
        {route.name === 'qr' && <QrScreen tokenId={route.tokenId} />}
        {route.name === 'gate' && <GateScreen />}
        {route.name === 'wallet' && <WalletScreen />}
        {route.name === 'dashboard' && <DashboardScreen />}
      </SafeAreaView>
    </AppContext.Provider>
  );
}
