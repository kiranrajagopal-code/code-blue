/* Code Blue — core logic (no UI). Works in browser (window.CBLogic) and Node (module.exports).
 * State is derived by replaying an event list, so "Undo" just removes the last event.
 * All times are epoch milliseconds.
 *
 * Timing model (as requested):
 *  - Main timer runs from the time CPR / Code Blue started.
 *  - Every 2 min from CPR start (fixed grid): SWITCH COMPRESSOR + CHECK PULSE (visual + ringing).
 *  - Adrenaline every 4 min (3–5 adjustable) from the last dose given.
 *    First dose: ASYSTOLE/PEA -> at CPR start; VT/VF -> after 2nd shock or 4 min after CPR start, whichever first.
 */
(function (root) {
  'use strict';

  var MIN = 60000;

  var DEFAULT_SETTINGS = {
    adrIntervalMin: 4,
    cycleMin: 2,
    guideline: 'AHA',             // VT/VF first adrenaline: 'AHA' after 2nd shock, 'ERC' after 3rd
    antiarrhythmic: 'amiodarone', // 'amiodarone' | 'lignocaine'
    prewarnSec: 15,
    metronome: false,
    metronomeBpm: 110
  };

  var RHYTHMS = ['ASYSTOLE', 'PEA', 'VT', 'VF'];
  var SHOCKABLE = ['VT', 'VF'];
  var NON_SHOCKABLE = ['ASYSTOLE', 'PEA'];

  var HS_TS = [
    { key: 'hypoxia', label: 'Hypoxia', group: 'H' },
    { key: 'hypovolaemia', label: 'Hypovolaemia', group: 'H' },
    { key: 'hplus', label: 'H+ (acidosis)', group: 'H' },
    { key: 'hypohyperK', label: 'Hypo/Hyperkalaemia & metabolic', group: 'H' },
    { key: 'hypothermia', label: 'Hypothermia', group: 'H' },
    { key: 'hypoglycaemia', label: 'Hypoglycaemia', group: 'H' },
    { key: 'tension', label: 'Tension pneumothorax', group: 'T' },
    { key: 'tamponade', label: 'Tamponade (cardiac)', group: 'T' },
    { key: 'toxins', label: 'Toxins', group: 'T' },
    { key: 'thrombosisP', label: 'Thrombosis — pulmonary', group: 'T' },
    { key: 'thrombosisC', label: 'Thrombosis — coronary', group: 'T' }
  ];

  var AIRWAY_ITEMS = [
    { key: 'bmv', label: 'BMV / 2-person bag-mask' },
    { key: 'sga', label: 'Supraglottic airway' },
    { key: 'ett', label: 'ETT placed' },
    { key: 'etco2', label: 'Waveform ETCO2 confirmed' },
    { key: 'continuous', label: 'Continuous compressions, 1 breath / 6 s' },
    { key: 'access', label: 'IV / IO access' }
  ];

  function isShockable(r) { return SHOCKABLE.indexOf(r) >= 0; }
  function isNonShockable(r) { return NON_SHOCKABLE.indexOf(r) >= 0; }

  function mergeSettings(s) {
    var out = {};
    for (var k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k];
    if (s) for (var j in s) if (s[j] !== undefined && s[j] !== null) out[j] = s[j];
    out.adrIntervalMin = Math.min(5, Math.max(3, Number(out.adrIntervalMin) || 4));
    return out;
  }

  function aaSchedule(drug) {
    if (drug === 'lignocaine') {
      return [
        { afterShock: 3, label: 'Lignocaine 1–1.5 mg/kg IV/IO' },
        { afterShock: 5, label: 'Lignocaine 0.5–0.75 mg/kg IV/IO' }
      ];
    }
    return [
      { afterShock: 3, label: 'Amiodarone 300 mg IV/IO' },
      { afterShock: 5, label: 'Amiodarone 150 mg IV/IO' }
    ];
  }

  /* Replay events -> state */
  function derive(events) {
    var s = {
      started: false, cprAt: null, arrestAt: null, anchor: null,
      ended: false, endedAt: null, outcome: null,
      rhythm: null, rosc: false,
      shocks: 0, shockNeedMetAt: null, adrDoses: 0, lastAdrAt: null, aaDoses: 0,
      switches: 0, cyclesAcked: {},
      hsts: {}, airway: {}
    };
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      switch (e.type) {
        case 'start':
          s.started = true; s.cprAt = e.t; s.anchor = e.t;
          s.arrestAt = e.arrestAt || e.t; s.rhythm = e.rhythm || null;
          break;
        case 'rhythm': s.rhythm = e.rhythm; break;
        case 'shock':
          s.shocks++;
          if (s.shocks === 2) s.shock2At = e.t;
          if (s.shocks === 3) s.shock3At = e.t;
          break;
        case 'adr': s.adrDoses++; s.lastAdrAt = e.t; break;
        case 'aa': s.aaDoses++; break;
        case 'cycle': s.switches++; s.cyclesAcked[e.k] = true; break;
        case 'rosc': s.rosc = true; s.rhythm = 'ROSC'; break;
        case 'rearrest':
          s.rosc = false; s.rhythm = e.rhythm || null; s.anchor = e.t; s.cyclesAcked = {};
          break;
        case 'end': s.ended = true; s.endedAt = e.t; s.outcome = e.outcome; break;
        case 'hst': s.hsts[e.key] = !!e.on; break;
        case 'airway': s.airway[e.key] = !!e.on; break;
      }
    }
    return s;
  }

  function adrenalineDue(s, st) {
    if (!s.started || s.ended || s.rosc) return { due: null, reason: '' };
    var interval = st.adrIntervalMin * MIN;
    if (s.lastAdrAt !== null) return { due: s.lastAdrAt + interval, reason: 'Every ' + st.adrIntervalMin + ' min from last dose' };
    if (isShockable(s.rhythm)) {
      var shockT = st.guideline === 'ERC' ? s.shock3At : s.shock2At;
      var byTime = s.anchor + interval;
      var due = shockT ? Math.min(shockT, byTime) : byTime;
      return { due: due, reason: 'VT/VF: after ' + (st.guideline === 'ERC' ? '3rd' : '2nd') + ' shock or ' + st.adrIntervalMin + ' min' };
    }
    return { due: s.anchor, reason: s.rhythm ? s.rhythm + ': give as soon as possible' : 'Give as soon as possible' };
  }

  function antiarrhythmicDue(s, st) {
    var sched = aaSchedule(st.antiarrhythmic);
    if (!s.started || s.ended || s.rosc || s.aaDoses >= sched.length) return null;
    var next = sched[s.aaDoses];
    return { label: next.label, afterShock: next.afterShock, ready: s.shocks >= next.afterShock && isShockable(s.rhythm), index: s.aaDoses };
  }

  /* Full status at time `now` */
  function status(events, settings, now) {
    var st = mergeSettings(settings);
    var s = derive(events);
    var out = { state: s, settings: st, now: now };
    if (!s.started) return out;
    var end = s.ended ? s.endedAt : now;
    out.elapsed = end - s.cprAt;             // main timer: from CPR start
    out.sinceArrest = end - s.arrestAt;
    out.noFlow = s.cprAt - s.arrestAt;
    var cyc = st.cycleMin * MIN;
    out.cyclesDone = Math.max(0, Math.floor((end - s.cprAt) / cyc));
    if (!s.ended && !s.rosc) {
      var k = Math.floor(Math.max(0, now - s.anchor) / cyc) + 1; // current cycle number since anchor
      out.cycleNo = k;
      out.cycleStart = s.anchor + (k - 1) * cyc;
      out.cycleDue = s.anchor + k * cyc;
      out.cycleRemaining = out.cycleDue - now;
      // last check point that passed and was not acknowledged
      if (k > 1 && !s.cyclesAcked[k - 1]) out.pendingCheck = k - 1;
    }
    var a = adrenalineDue(s, st);
    out.adrDue = a.due; out.adrReason = a.reason;
    if (a.due !== null) out.adrRemaining = a.due - now;
    out.aa = antiarrhythmicDue(s, st);
    out.estCompressions = Math.round((out.elapsed / MIN) * st.metronomeBpm);
    return out;
  }

  /* Upcoming/past alerts for notifications and foreground alarms. */
  function alerts(events, settings, now, horizonMs) {
    var st = mergeSettings(settings);
    var x = status(events, st, now);
    var s = x.state, list = [];
    if (!s.started || s.ended || s.rosc) return list;
    horizonMs = horizonMs || 20 * MIN;
    var cyc = st.cycleMin * MIN, i;
    // fixed 2-min grid: the most recent check point plus upcoming ones within horizon
    var firstK = Math.max(1, x.cycleNo - 1);
    for (var k = firstK; s.anchor + k * cyc <= now + horizonMs; k++) {
      var at = s.anchor + k * cyc;
      list.push({ key: 'pre@' + s.anchor + '@' + k, at: at - st.prewarnSec * 1000, kind: 'prewarn', title: 'Pulse check in ' + st.prewarnSec + ' s', body: 'Next compressor get ready.' });
      list.push({ key: 'cyc@' + s.anchor + '@' + k, at: at, kind: 'cycle', k: k, title: 'SWITCH COMPRESSOR · CHECK PULSE', body: 'Cycle ' + k + ' done (' + mmss(k * cyc) + ').' });
    }
    if (x.adrDue !== null && x.adrDue !== undefined) {
      var base = s.lastAdrAt === null ? 'first' : String(s.lastAdrAt);
      list.push({ key: 'adr@' + base, at: x.adrDue, kind: 'adr', title: 'GIVE ADRENALINE 1 mg', body: 'IV/IO now. Tap "Adrenaline given".' });
      for (i = 1; i <= 10; i++) {
        list.push({ key: 'adr@' + base + '+' + i, at: x.adrDue + i * MIN, kind: 'adr', title: 'ADRENALINE OVERDUE', body: '1 mg IV/IO. Tap "Adrenaline given".' });
      }
    }
    if (x.aa && x.aa.ready) {
      list.push({ key: 'aa@' + x.aa.index + '@' + s.shocks, at: lastEventTime(events), kind: 'aa', title: 'ANTIARRHYTHMIC', body: x.aa.label });
    }
    return list.filter(function (al) { return al.at <= now + horizonMs; }).sort(function (p, q) { return p.at - q.at; });
  }

  function lastEventTime(events) { return events.length ? events[events.length - 1].t : 0; }

  /* Formatting */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function mmss(ms) {
    var neg = ms < 0; ms = Math.abs(ms);
    var tot = Math.floor(ms / 1000);
    return (neg ? '-' : '') + pad(Math.floor(tot / 60)) + ':' + pad(tot % 60);
  }
  function clock(t, withSec) {   // 12-hour, e.g. 7:04 PM / 7:04:30 PM
    var d = new Date(t), h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + pad(d.getMinutes()) + (withSec ? ':' + pad(d.getSeconds()) : '') + ' ' + ap;
  }

  /* Build a timestamp from 12-hour picker values, on the same day as `now`;
   * if that lands in the future (e.g. code started before midnight), use the previous day. */
  function timeFrom12h(hour12, minute, ampm, now) {
    var h = Number(hour12) % 12 + (ampm === 'PM' ? 12 : 0);
    var d = new Date(now); d.setHours(h, Number(minute), 0, 0);
    var t = d.getTime();
    if (t > now + 60000) t -= 24 * 60 * MIN;
    return t;
  }

  function describe(e) {
    switch (e.type) {
      case 'start': return 'CPR STARTED — initial rhythm ' + (e.rhythm || 'not entered');
      case 'arrest': return 'Arrest';
      case 'rhythm': return 'Rhythm: ' + e.rhythm;
      case 'shock': return 'Shock #' + e.n + (e.joules ? ' — ' + e.joules + ' J' : '');
      case 'adr': return 'Adrenaline 1 mg IV/IO — dose ' + e.n;
      case 'aa': return e.label || 'Antiarrhythmic';
      case 'cycle': return 'Cycle ' + e.k + ': compressor switched (switch #' + e.n + '), pulse checked' + (e.pulse ? ' — pulse ' + e.pulse : '');
      case 'rosc': return 'ROSC';
      case 'rearrest': return 'RE-ARREST — CPR restarted' + (e.rhythm ? ' — ' + e.rhythm : '');
      case 'end': return 'CODE ENDED — ' + e.outcome;
      case 'hst': return (e.on ? 'Considered: ' : 'Unticked: ') + labelFor(HS_TS, e.key);
      case 'airway': return (e.on ? '' : 'Unticked: ') + labelFor(AIRWAY_ITEMS, e.key);
      case 'drug': return e.text;
      case 'note': return 'Note: ' + e.text;
      default: return e.type;
    }
  }
  function labelFor(list, key) { for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].label; return key; }

  /* Log rows: events plus the arrest time, sorted by time */
  function logRows(events) {
    var s = derive(events);
    if (!s.started) return [];
    var rows = events.map(function (e) { return { t: e.t, text: describe(e), type: e.type }; });
    if (s.arrestAt !== s.cprAt) rows.push({ t: s.arrestAt, text: 'ARREST (time entered)', type: 'arrest' });
    rows.sort(function (a, b) { return a.t - b.t; });
    return rows;
  }

  function summaryText(events, settings, meta) {
    var st = mergeSettings(settings);
    var s = derive(events);
    if (!s.started) return '';
    var end = s.ended ? s.endedAt : Date.now();
    var x = status(events, st, end);
    var L = [];
    L.push('CODE BLUE RECORD');
    if (meta && meta.location) L.push('Location/Bed: ' + meta.location);
    L.push('Date: ' + new Date(s.cprAt).toLocaleDateString('en-GB'));
    L.push('Time of arrest: ' + clock(s.arrestAt) + '   CPR started: ' + clock(s.cprAt) + '   (no-flow ' + mmss(s.cprAt - s.arrestAt) + ')');
    L.push('Initial rhythm: ' + (events[0].rhythm || 'not entered'));
    if (s.ended) L.push('Ended: ' + clock(s.endedAt) + '   CPR duration: ' + mmss(s.endedAt - s.cprAt) + '   Outcome: ' + s.outcome);
    L.push('2-min cycles: ' + x.cyclesDone + '   Compressor switches logged: ' + s.switches + '   Est. compressions: ~' + x.estCompressions + ' (at ' + st.metronomeBpm + '/min)');
    var adrTimes = events.filter(function (e) { return e.type === 'adr'; }).map(function (e) { return clock(e.t); });
    L.push('Adrenaline: ' + s.adrDoses + (adrTimes.length ? ' (' + adrTimes.join(', ') + ')' : ''));
    L.push('Shocks: ' + s.shocks + '   Antiarrhythmic doses: ' + s.aaDoses);
    L.push('');
    L.push('TIME         CPR+    EVENT');
    logRows(events).forEach(function (r) {
      var el = r.t - s.cprAt;
      L.push(clock(r.t, true) + '  ' + (el < 0 ? '-' + mmss(-el) : '+' + mmss(el)) + '  ' + r.text);
    });
    return L.join('\n');
  }

  var api = {
    MIN: MIN, DEFAULT_SETTINGS: DEFAULT_SETTINGS, RHYTHMS: RHYTHMS, SHOCKABLE: SHOCKABLE, NON_SHOCKABLE: NON_SHOCKABLE,
    HS_TS: HS_TS, AIRWAY_ITEMS: AIRWAY_ITEMS,
    isShockable: isShockable, isNonShockable: isNonShockable, mergeSettings: mergeSettings,
    aaSchedule: aaSchedule, derive: derive, status: status, alerts: alerts,
    mmss: mmss, clock: clock, timeFrom12h: timeFrom12h, describe: describe, logRows: logRows, summaryText: summaryText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CBLogic = api;
})(this);
