import type { ImageSourcePropType } from 'react-native';
import type { IconName } from './icon-data';

/** Default artwork per event: the contract stores no image, so each event id gets one of these photos (see assets/CREDITS.md). */
const photos: ImageSourcePropType[] = [
  require('../assets/events/neon.jpg'),
  require('../assets/events/indie.jpg'),
  require('../assets/events/rooftop.jpg'),
  require('../assets/events/lantern.jpg'),
  require('../assets/events/soundcheck.jpg'),
  require('../assets/events/crowd.jpg'),
];

export const eventPhoto = (eventId: string): ImageSourcePropType => photos[Number(eventId) % photos.length] ?? photos[0];

/**
 * What an icon means in the app, and the outline glyph (Lucide) that draws it. One family, one stroke: nothing
 * here is an emoji or a picture.
 */
export const glyphs = {
  home: 'house', store: 'store', ticket: 'ticket', scan: 'scan-line', user: 'user', people: 'users',
  heart: 'heart', speech: 'message-circle', share: 'share-2', qr: 'qr-code', wallet: 'wallet', receipt: 'receipt-text',
  hourglass: 'hourglass', check: 'circle-check', cross: 'circle-x', clock: 'clock', offline: 'wifi-off', info: 'info', bell: 'bell',
  calendar: 'calendar', pin: 'map-pin', shield: 'shield-check', fire: 'flame', money: 'banknote', chart: 'chart-column',
  back: 'chevron-left', next: 'chevron-right', close: 'x', tick: 'check', copy: 'copy', external: 'external-link', plus: 'plus', minus: 'minus',
  refresh: 'refresh-cw', lock: 'lock', search: 'search', tag: 'tag', link: 'link', note: 'pencil', alert: 'triangle-alert', send: 'send',
} as const satisfies Record<string, IconName>;

export type IconKey = keyof typeof glyphs;
