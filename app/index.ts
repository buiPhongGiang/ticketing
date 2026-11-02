// Must load before viem: it provides crypto.getRandomValues on Hermes.
import 'react-native-get-random-values';
import { registerRootComponent } from 'expo';

import App from './App';

registerRootComponent(App);
