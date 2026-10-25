// Bundled into www/native.js by `npm run build` — exposes Capacitor plugins and the PDF library to the plain-JS app.
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Haptics } from '@capacitor/haptics';
import { Share } from '@capacitor/share';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { App } from '@capacitor/app';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
window.CBNative = { Capacitor, LocalNotifications, Haptics, Share, KeepAwake, App, Filesystem, Directory };
window.CBPdf = { jsPDF, autoTable };
