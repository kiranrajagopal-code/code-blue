// Bundled into www/native.js by `npm run build` — exposes Capacitor plugins to the plain-JS app.
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Haptics } from '@capacitor/haptics';
import { Share } from '@capacitor/share';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { App } from '@capacitor/app';
window.CBNative = { Capacitor, LocalNotifications, Haptics, Share, KeepAwake, App };
