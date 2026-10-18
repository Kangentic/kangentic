/**
 * A vendor-neutral seam between PushNotifier and whatever wakes the
 * device's OS notification stack. Expo is the only implementation today
 * (expo-push-client.ts), but the credentials this depends on (an Expo
 * project id, FCM/APNs creds uploaded to EAS) are a single vendor's - a
 * drop-in replacement (e.g. a small Cloudflare Worker holding the same
 * two credentials) only has to implement this interface, never touch
 * PushNotifier.
 */
import type { PUSH_CLEAR_DATA_KEY, PUSH_ENVELOPE_DATA_KEY } from '@kangentic/protocol';

export interface WakeMessage {
  /** Vendor-opaque device address; today an ExponentPushToken[...]. */
  token: string;
  /**
   * OS-visible placeholder text, OPTIONAL and omitted for Android.
   *
   * Both absent means a data-only message: nothing for the OS or a push
   * SDK to render on its own, leaving the app's own handler the single
   * display path. That is what stops an Android push being shown twice
   * (once generically by expo-notifications, once decrypted by Notifee).
   * Never real content either way - see PushNotifier's header.
   */
  title?: string;
  body?: string;
  /** The sealed payload (a notification envelope or a clear) - the only real content in the message. */
  blob: string;
  /**
   * The data key `blob` rides under: PUSH_ENVELOPE_DATA_KEY ('blob') for a
   * notification envelope, PUSH_CLEAR_DATA_KEY ('clear') for a sealed clear.
   * The phone reads the key before decrypting, so a clear never reaches the
   * code that shows a placeholder.
   */
  dataKey: typeof PUSH_ENVELOPE_DATA_KEY | typeof PUSH_CLEAR_DATA_KEY;
  /** 'high' wakes the device now; 'normal' waits for it to leave Doze on Android and is APNs priority 5 on iOS. */
  priority: 'high' | 'normal';
  /** iOS: lets the Notification Service Extension decrypt an alert push. Set for a visible notification only. */
  mutableContent: boolean;
  /** iOS: a background wake (aps.content-available) for a push with no alert. Set for an iOS clear only. */
  contentAvailable: boolean;
}

export type WakeResult =
  | { delivered: true }
  | { delivered: false; reason: 'device-not-registered' }
  | { delivered: false; reason: 'send-failed'; detail: string };

export interface WakeChannel {
  send(message: WakeMessage): Promise<WakeResult>;
}
