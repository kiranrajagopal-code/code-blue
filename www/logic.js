/* Code Blue — core logic (no UI). Works in browser (window.CBLogic) and Node (module.exports).
 * State is derived by replaying an event list, so "Undo" just removes the last event.
 * All times are epoch milliseconds.
 */
(function (root) {
  'use strict';

  var MIN = 60000;

  var DEFAULT_SETTINGS = {
    adrIntervalMin: 4,          // adrenaline every N minutes (3–5)
    cycleMin: 2,                // CPR cycle / rhythm check interval
    guideline: 'AHA',           // 'AHA' = adrenaline after 2nd shock; 'ERC' = after 3rd shock
    antiarrhythmic: 'amiodarone', // 'amiodarone' | 'lignocaine'
    prewarnSec: 15,             // warning before rhythm check
    metronome: false,
    metronomeBpm: 110
  };

  var SHOCKABLE = ['VF', 'pVT'];
  var NON_SHOCKABLE = ['PEA', 'Asystole'];

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

  /* Antiarrhythmic dose schedule: dose index -> shocks needed and label. */
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
      started: false, startedAt: null, ended: false, endedAt: null, outcome: null,
      rhythm: null, rosc: false, cycleStart: null, cycles: 0,
      shocks: 0, adrDoses: 0, lastAdrAt: null, aaDoses: 0,
      everNonShockable: false, everShockable: false,
      hsts: {}, airway: {}, notes: 0
    };
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      switch (e.type) {
        case 'start':
          s.started = true; s.startedAt = e.t; s.cycleStart = e.cycleAt || e.t; s.cycles = 1;
          if (e.rhythm) applyRhythm(s, e.rhythm, e.t, true);
          break;
        case 'rhythm':
          applyRhythm(s, e.rhythm, e.t, false);
          break;
        case 'shock': s.shocks++; break;
        case 'adr': s.adrDoses++; s.lastAdrAt = e.t; break;
        case 'aa': s.aaDoses++; break;
        case 'rosc':
          s.rosc = true; s.rhythm = 'ROSC'; s.cycleStart = null; break;
        case 'rearrest':
          s.rosc = false; s.rhythm = null; s.cycleStart = e.t; s.cycles++;
          if (e.rhythm) applyRhythm(s, e.rhythm, e.t, true);
          break;
        case 'end':
          s.ended = true; s.endedAt = e.t; s.outcome = e.outcome; break;
        case 'hst': s.hsts[e.key] = !!e.on; break;
        case 'airway': s.airway[e.key] = !!e.on; break;
        case 'note': s.notes++; break;
      }
    }
    return s;
  }

  function applyRhythm(s, r, t, noNewCycle) {
    s.rhythm = r;
    if (isShockable(r)) s.everShockable = true;
    if (isNonShockable(r)) s.everNonShockable = true;
    if (!noNewCycle) { s.cycleStart = t; s.cycles++; }
  }

  /* When is the next adrenaline due? Returns {due: ms|null, reason} */
  function adrenalineDue(s, st) {
    if (!s.started || s.ended || s.rosc) return { due: null, reason: '' };
    var interval = st.adrIntervalMin * MIN;
    if (s.lastAdrAt !== null) return { due: s.lastAdrAt + interval, reason: 'Repeat every ' + st.adrIntervalMin + ' min' };
    // first dose
    if (s.everNonShockable || isNonShockable(s.rhythm)) return { due: s.startedAt, reason: 'Non-shockable: give ASAP' };
    var need = st.guideline === 'ERC' ? 3 : 2;
    if (s.shocks >= need) return { due: s.startedAt, reason: 'Shockable: due after shock ' + need };
    if (isShockable(s.rhythm)) return { due: null, reason: 'Shockable: first dose after shock ' + need + ' (' + s.shocks + ' given)' };
    return { due: null, reason: 'Enter rhythm' };
  }

  /* Next antiarrhythmic dose prompt */
  function antiarrhythmicDue(s, st) {
    var sched = aaSchedule(st.antiarrhythmic);
    if (!s.started || s.ended || s.rosc || s.aaDoses >= sched.length) return null;
    var next = sched[s.aaDoses];
    var ready = s.shocks >= next.afterShock && isShockable(s.rhythm);
    return { label: next.label, afterShock: next.afterShock, ready: ready, index: s.aaDoses };
  }

  /* Full status at time `now` */
  function status(events, settings, now) {
    var st = mergeSettings(settings);
    var s = derive(events);
    var out = { state: s, settings: st, now: now };
    if (!s.started) return out;
    var end = s.ended ? s.endedAt : now;
    out.elapsed = end - s.startedAt;
    if (s.cycleStart !== null && !s.ended && !s.rosc) {
      out.cycleDue = s.cycleStart + st.cycleMin * MIN;
      out.cycleRemaining = out.cycleDue - now;
      out.cycleElapsed = now - s.cycleStart;
    }
    var a = adrenalineDue(s, st);
    out.adrDue = a.due; out.adrReason = a.reason;
    if (a.due !== null) out.adrRemaining = a.due - now;
    out.aa = antiarrhythmicDue(s, st);
    return out;
  }

  /* Upcoming alerts (for notification scheduling + foreground beeps).
   * Each: {key, at, kind, title, body}. Overdue reminders repeat. */
  function alerts(events, settings, now, horizonMs) {
    var st = mergeSettings(settings);
    var x = status(events, st, now);
    var s = x.state;
    var list = [];
    if (!s.started || s.ended || s.rosc) return list;
    horizonMs = horizonMs || 20 * MIN;
    var i, at;
    if (x.cycleDue !== undefined) {
      var pre = x.cycleDue - st.prewarnSec * 1000;
      list.push({ key: 'pre@' + s.cycleStart, at: pre, kind: 'prewarn', title: 'Rhythm check in ' + st.prewarnSec + ' s', body: 'Next compressor get ready. Charge defibrillator if shockable.' });
      list.push({ key: 'cyc@' + s.cycleStart, at: x.cycleDue, kind: 'cycle', title: 'RHYTHM / PULSE CHECK', body: 'Pause < 10 s. Rotate compressor. Enter rhythm.' });
      for (i = 1; i <= 10; i++) {
        at = x.cycleDue + i * 30000;
        list.push({ key: 'cyc@' + s.cycleStart + '+' + i, at: at, kind: 'cycle', title: 'Rhythm check OVERDUE', body: 'Enter rhythm to restart the 2-min cycle.' });
      }
    }
    if (x.adrDue !== null && x.adrDue !== undefined) {
      var base = s.lastAdrAt === null ? 'first' : String(s.lastAdrAt);
      var firstAt = Math.max(x.adrDue, base === 'first' ? lastEventTime(events) : x.adrDue);
      list.push({ key: 'adr@' + base, at: firstAt, kind: 'adr', title: 'ADRENALINE DUE', body: '1 mg IV/IO now. Tap "Adrenaline given".' });
      for (i = 1; i <= 10; i++) {
        at = firstAt + i * 60000;
        list.push({ key: 'adr@' + base + '+' + i, at: at, kind: 'adr', title: 'Adrenaline OVERDUE', body: '1 mg IV/IO. Tap "Adrenaline given".' });
      }
    }
    if (x.aa && x.aa.ready) {
      var aat = lastEventTime(events);
      list.push({ key: 'aa@' + x.aa.index + '@' + s.shocks, at: aat, kind: 'aa', title: 'ANTIARRHYTHMIC', body: x.aa.label });
    }
    return list.filter(function (al) { return al.at <= now + horizonMs; }).sort(function (p, q) { return p.at - q.at; });
  }

  function lastEventTime(events) { return events.length ? events[events.length - 1].t : 0; }

  /* Formatting */
  function mmss(ms) {
    var neg = ms < 0; ms = Math.abs(ms);
    var tot = Math.floor(ms / 1000);
    var m = Math.floor(tot / 60), sec = tot % 60;
    return (neg ? '-' : '') + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  function clock(t) {
    var d = new Date(t);
    var h = d.getHours(), m = d.getMinutes(), sec = d.getSeconds();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function describe(e, st) {
    switch (e.type) {
      case 'start': return 'CODE STARTED' + (e.rhythm ? ' — ' + e.rhythm : '') + (e.offsetMin ? ' (backdated ' + e.offsetMin + ' min)' : '');
      case 'rhythm': return 'Rhythm: ' + e.rhythm + ' — CPR resumed, compressor rotated';
      case 'shock': return 'Shock #' + e.n + (e.joules ? ' — ' + e.joules + ' J' : '');
      case 'adr': return 'Adrenaline 1 mg IV/IO (dose ' + e.n + ')';
      case 'aa': return e.label || 'Antiarrhythmic';
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

  function summaryText(events, settings, meta) {
    var st = mergeSettings(settings);
    var s = derive(events);
    if (!s.started) return '';
    var lines = [];
    lines.push('CODE BLUE RECORD');
    if (meta && meta.location) lines.push('Location/Bed: ' + meta.location);
    if (meta && meta.leader) lines.push('Team leader: ' + meta.leader);
    lines.push('Date: ' + new Date(s.startedAt).toLocaleDateString() + '  Start: ' + clock(s.startedAt));
    if (s.ended) lines.push('End: ' + clock(s.endedAt) + '  Duration: ' + mmss(s.endedAt - s.startedAt) + '  Outcome: ' + s.outcome);
    lines.push('Shocks: ' + s.shocks + '  Adrenaline doses: ' + s.adrDoses + '  Antiarrhythmic doses: ' + s.aaDoses);
    lines.push('Settings: adrenaline q' + st.adrIntervalMin + ' min, ' + st.guideline + ', ' + st.antiarrhythmic);
    lines.push('');
    lines.push('TIME     +ELAPSED  EVENT');
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      lines.push(clock(e.t) + ' +' + mmss(e.t - s.startedAt) + '  ' + describe(e, st));
    }
    return lines.join('\n');
  }

  var api = {
    MIN: MIN, DEFAULT_SETTINGS: DEFAULT_SETTINGS, SHOCKABLE: SHOCKABLE, NON_SHOCKABLE: NON_SHOCKABLE,
    HS_TS: HS_TS, AIRWAY_ITEMS: AIRWAY_ITEMS,
    isShockable: isShockable, isNonShockable: isNonShockable, mergeSettings: mergeSettings,
    aaSchedule: aaSchedule, derive: derive, status: status, alerts: alerts,
    mmss: mmss, clock: clock, describe: describe, summaryText: summaryText
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CBLogic = api;
})(this);
