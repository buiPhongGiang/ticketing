import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { devKeys } from './config';
import { createLocalSigner, createPrivateKey } from './lib';
import type { Hex, LocalSigner } from './lib/types';

const KEY = 'ticketing.wallet.key';
const DEV_INDEX = 'ticketing.wallet.devIndex';

// expo-secure-store has no web implementation. The web build exists only for automated tests.
const secure = Platform.OS === 'web'
  ? { get: (k: string) => AsyncStorage.getItem(k), set: (k: string, v: string) => AsyncStorage.setItem(k, v) }
  : { get: (k: string) => SecureStore.getItemAsync(k), set: (k: string, v: string) => SecureStore.setItemAsync(k, v) };

export async function loadWallet(): Promise<LocalSigner> {
  if (devKeys.length > 0) {
    const index = Number((await AsyncStorage.getItem(DEV_INDEX)) ?? '0');
    return createLocalSigner(devKeys[index] ?? devKeys[0]);
  }
  let key = (await secure.get(KEY)) as Hex | null;
  if (!key) {
    key = createPrivateKey();
    await secure.set(KEY, key);
  }
  return createLocalSigner(key);
}

export async function selectDevWallet(index: number): Promise<LocalSigner> {
  await AsyncStorage.setItem(DEV_INDEX, String(index));
  return createLocalSigner(devKeys[index]);
}
