/**
 * A vendor-neutral seam between PushNotifier and whatever wakes the
 * device's OS notification stack. Expo is the only implementation today
 * (expo-push-client.ts), but the credentials this depends on (an Expo
 * project id, FCM/APNs creds uploaded to EAS) are a single vendor's - a
 * drop-in replacement (e.g. a small Cloudflare Worker holding the same
 * two credentials) only has to implement this interface, never touch
 * PushNotifier.
 */

export interface WakeMessage {
  /** Vendor-opaque device address; today an ExponentPushToken[...]. */
  token: string;
  /** Android notification channel hint; a vendor without channels ignores it. */
  channelId: string;
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
  /** The sealed push envelope - the only real content in the message. */
  blob: string;
}

export type WakeResult =
  | { delivered: true }
  | { delivered: false; reason: 'device-not-registered' }
  | { delivered: false; reason: 'send-failed'; detail: string };

export interface WakeChannel {
  send(message: WakeMessage): Promise<WakeResult>;
}
