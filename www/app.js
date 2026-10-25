/* Code Blue — UI + device integration */
(function () {
  'use strict';
  var L = window.CBLogic;
  var $ = function (id) { return document.getElementById(id); };
  var qsa = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };

  /* ---------- native plugins (present only inside the Android app) ---------- */
  var N = window.CBNative || {};
  var NATIVE = !!(N.Capacitor && N.Capacitor.isNativePlatform());
  var P = NATIVE ? N : {};
  var Notif = P.LocalNotifications, Haptics = P.Haptics, Share = P.Share, KeepAwake = P.KeepAwake, App = P.App;

  /* ---------- storage ---------- */
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var settings = L.mergeSettings(load('cb.settings', {}));
  var cur = load('cb.current', null); // {events, settings, meta, fired}
  var history = load('cb.history', []);
  var lastSummary = null;
  var appActive = true;

  function persist() { save('cb.current', cur); }
  function now() { return Date.now(); }

  /* ---------- audio ---------- */
  var actx = null;
  function audio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(freq, start, dur, vol) {
    var a = audio(); if (!a) return;
    var o = a.createOscillator(), g = a.createGain();
    o.type = 'square'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, a.currentTime + start);
    g.gain.exponentialRampToValueAtTime(vol || 0.6, a.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
    o.connect(g); g.connect(a.destination);
    o.start(a.currentTime + start); o.stop(a.currentTime + start + dur + 0.05);
  }
  var PATTERNS = {   // one "ring" of each alarm
    cycle: function () { for (var i = 0; i < 4; i++) tone(i % 2 ? 1000 : 1300, i * 0.18, 0.15); },
    adr: function () { tone(620, 0, 0.35); tone(880, 0.4, 0.35); },
    aa: function () { tone(900, 0, 0.3); tone(600, 0.35, 0.3); },
    prewarn: function () { tone(1000, 0, 0.15, 0.3); }
  };
  function vibrate(ms) {
    if (Haptics) { Haptics.vibrate({ duration: ms }).catch(function () {}); }
    else if (navigator.vibrate) navigator.vibrate(ms);
  }

  /* metronome */
  var metroTimer = null, metroNext = 0;
  function metroStart() {
    var a = audio(); if (!a) return;
    metroStop(); metroNext = a.currentTime + 0.1;
    metroTimer = setInterval(function () {
      var iv = 60 / (settings.metronomeBpm || 110);
      while (metroNext < a.currentTime + 0.2) {
        var o = a.createOscillator(), g = a.createGain();
        o.frequency.value = 1600; g.gain.setValueAtTime(0.25, metroNext); g.gain.exponentialRampToValueAtTime(0.0001, metroNext + 0.04);
        o.connect(g); g.connect(a.destination); o.start(metroNext); o.stop(metroNext + 0.05);
        metroNext += iv;
      }
    }, 50);
  }
  function metroStop() { if (metroTimer) clearInterval(metroTimer); metroTimer = null; }
  function metroSync() {
    var on = settings.metronome && cur && running();
    if (on && !metroTimer) metroStart(); if (!on && metroTimer) metroStop();
    $('btnMetro').textContent = 'Metronome: ' + (settings.metronome ? 'ON ' + settings.metronomeBpm + '/min' : 'OFF');
    $('btnMetro').classList.toggle('on', !!settings.metronome);
  }

  /* ---------- ringing alarms (visual banner + repeating sound until handled) ---------- */
  var alarm = null; // {kind, title, body, until, lastRing}
  function startAlarm(al) {
    var ringing = al.kind !== 'prewarn';
    alarm = { kind: al.kind, title: al.title, body: al.body, until: now() + (ringing ? 60000 : 0), lastRing: 0 };
    showBanner();
    ringOnce();
  }
  function ringOnce() {
    if (!alarm) return;
    (PATTERNS[alarm.kind] || PATTERNS.cycle)();
    vibrate(alarm.kind === 'prewarn' ? 200 : 800);
    alarm.lastRing = now();
  }
  function alarmStillValid(x) {
    if (!alarm) return false;
    if (alarm.kind === 'cycle') return !!x.pendingCheck;
    if (alarm.kind === 'adr') return x.adrRemaining !== undefined && x.adrRemaining <= 0;
    if (alarm.kind === 'aa') return !!(x.aa && x.aa.ready);
    return now() < alarm.until + 4000;
  }
  function stopAlarm() { alarm = null; $('banner').classList.add('hidden'); }
  function showBanner() {
    var b = $('banner');
    b.className = 'banner ' + alarm.kind;
    b.innerHTML = '';
    b.appendChild(document.createTextNode(alarm.title));
    if (alarm.body) { var s = document.createElement('small'); s.textContent = alarm.body; b.appendChild(s); }
    if (alarm.kind !== 'prewarn') { var x = document.createElement('span'); x.className = 'silence'; x.textContent = 'Tap to silence'; b.appendChild(x); }
  }
  $('banner').addEventListener('click', stopAlarm);

  /* ---------- notifications (alarms when screen locked / app in background) ---------- */
  var notifReady = false;
  function setupNotifications() {
    if (!Notif) return Promise.resolve();
    return Notif.requestPermissions().then(function () {
      return Notif.createChannel({ id: 'cb-alarms', name: 'Code Blue alarms', description: 'Pulse check and adrenaline alarms', importance: 5, visibility: 1, vibration: true, lights: true });
    }).then(function () { notifReady = true; checkExact(); }).catch(function () {});
  }
  function checkExact() {
    if (!Notif || !Notif.checkExactNotificationSetting) return;
    Notif.checkExactNotificationSetting().then(function (r) {
      $('exactWarn').classList.toggle('hidden', !r || r.exact_alarm === 'granted');
    }).catch(function () {});
  }
  $('btnExact').addEventListener('click', function () {
    if (Notif && Notif.changeExactNotificationSetting) Notif.changeExactNotificationSetting().then(checkExact).catch(function () {});
  });
  function cancelNotifications() {
    if (!Notif) return Promise.resolve();
    return Notif.getPending().then(function (r) {
      if (r && r.notifications && r.notifications.length) return Notif.cancel({ notifications: r.notifications.map(function (n) { return { id: n.id }; }) });
    }).catch(function () {});
  }
  function scheduleNotifications() {
    if (!Notif || !notifReady) return;
    cancelNotifications().then(function () {
      if (!cur || !running() || appActive) return;
      var t = now();
      var list = L.alerts(cur.events, cur.settings, t, 40 * L.MIN).filter(function (a) { return a.at > t + 500; }).slice(0, 60);
      if (!list.length) return;
      Notif.schedule({ notifications: list.map(function (a, i) {
        return { id: 1000 + i, title: a.title, body: a.body, channelId: 'cb-alarms', schedule: { at: new Date(a.at), allowWhileIdle: true }, autoCancel: true };
      }) }).catch(function () {});
    });
  }

  /* ---------- code state helpers ---------- */
  function running() { var s = L.derive(cur.events); return s.started && !s.ended; }
  function add(ev) {
    ev.t = ev.t || now();
    cur.events.push(ev);
    persist(); render(); scheduleNotifications();
    vibrate(40);
  }

  /* ---------- 12-hour time pickers ---------- */
  function buildTimePicker(el) {
    function sel(opts) {
      var s = document.createElement('select');
      opts.forEach(function (o) { var op = document.createElement('option'); op.value = o; op.textContent = o; s.appendChild(op); });
      return s;
    }
    var hrs = []; for (var h = 1; h <= 12; h++) hrs.push(String(h));
    var mins = []; for (var m = 0; m < 60; m++) mins.push((m < 10 ? '0' : '') + m);
    var hS = sel(hrs), mS = sel(mins), aS = sel(['AM', 'PM']);
    var colon = document.createElement('span'); colon.className = 'colon'; colon.textContent = ':';
    var nowB = document.createElement('button'); nowB.className = 'now'; nowB.textContent = 'Now'; nowB.type = 'button';
    el.appendChild(hS); el.appendChild(colon); el.appendChild(mS); el.appendChild(aS); el.appendChild(nowB);
    function setNow() {
      var d = new Date(), hh = d.getHours();
      aS.value = hh >= 12 ? 'PM' : 'AM'; hh = hh % 12; if (hh === 0) hh = 12;
      hS.value = String(hh); mS.value = mins[d.getMinutes()];
    }
    nowB.addEventListener('click', setNow);
    setNow();
    return {
      setNow: setNow,
      get: function (ref) { return L.timeFrom12h(hS.value, mS.value, aS.value, ref || now()); }
    };
  }
  var tpArrest = buildTimePicker($('tpArrest'));
  var tpCpr = buildTimePicker($('tpCpr'));

  /* ---------- HOME ---------- */
  $('btnStart').addEventListener('click', function () {
    audio();
    var t = now();
    var cprAt = tpCpr.get(), arrestAt = tpArrest.get(cprAt);
    var rhythm = $('initRhythm').value || null;
    var problems = [];
    if (cprAt - arrestAt > 3 * 60 * L.MIN) problems.push('Arrest time ' + L.clock(arrestAt) + ' does not fit CPR start ' + L.clock(cprAt) + ' — arrest must be before CPR. Check the time and AM/PM.');
    if (t - cprAt > 60 * L.MIN) problems.push('CPR start is more than 1 hour ago.');
    if (!rhythm) problems.push('Initial rhythm not selected.');
    var go = function () { beginCode(cprAt, Math.min(arrestAt, cprAt), rhythm); };
    if (problems.length) confirmBox('Please check', problems.join(' '), 'Start anyway', go, 'ok');
    else go();
  });
  function beginCode(cprAt, arrestAt, rhythm) {
    cur = { events: [], settings: JSON.parse(JSON.stringify(settings)), meta: { location: $('location').value.trim() }, fired: {} };
    cur.events.push({ type: 'start', t: cprAt, arrestAt: arrestAt, rhythm: rhythm });
    // do not ring for check points that passed before the app was started
    L.alerts(cur.events, cur.settings, now(), 0).forEach(function (a) { if (a.at < now() - 2000 && a.kind !== 'adr') cur.fired[a.key] = 1; });
    persist();
    if (KeepAwake) KeepAwake.keepAwake().catch(function () {});
    setupNotifications();
    logCount = -1;
    show('run'); render();
  }

  function renderHistory() {
    var h = $('history'); h.innerHTML = '';
    if (!history.length) { h.innerHTML = '<div class="muted">None yet</div>'; return; }
    history.slice().reverse().forEach(function (c) {
      var s = L.derive(c.events);
      var row = document.createElement('div'); row.className = 'h-item';
      var info = document.createElement('div');
      info.innerHTML = '<b></b><div class="sub"></div>';
      info.firstChild.textContent = new Date(s.cprAt).toLocaleDateString('en-GB') + ' ' + L.clock(s.cprAt) + (c.meta && c.meta.location ? ' · ' + c.meta.location : '');
      info.lastChild.textContent = (s.outcome || '') + ' · ' + L.mmss((s.endedAt || s.cprAt) - s.cprAt) + ' · ' + s.adrDoses + ' adrenaline · ' + s.shocks + ' shocks';
      var btn = document.createElement('button'); btn.textContent = 'View';
      btn.addEventListener('click', function () { showSummary(c); });
      row.appendChild(info); row.appendChild(btn); h.appendChild(row);
    });
  }

  /* ---------- RUN screen actions ---------- */
  qsa('.rhythms .rbtn[data-r]').forEach(function (b) {
    b.addEventListener('click', function () { add({ type: 'rhythm', rhythm: b.getAttribute('data-r') }); });
  });
  $('btnRosc').addEventListener('click', function () {
    confirmBox('ROSC?', 'Stops the 2-minute and adrenaline alarms. Tap RE-ARREST if needed.', 'Confirm ROSC', function () { stopAlarm(); add({ type: 'rosc' }); });
  });
  $('btnRearrest').addEventListener('click', function () {
    choose('Re-arrest — rhythm?', ['ASYSTOLE', 'PEA', 'VT', 'VF', 'Not known'], function (r) { add({ type: 'rearrest', rhythm: r === 'Not known' ? null : r }); });
  });
  $('btnCycleAck').addEventListener('click', function () {
    var x = L.status(cur.events, cur.settings, now());
    if (!x.pendingCheck) return;
    if (alarm && alarm.kind === 'cycle') stopAlarm();
    add({ type: 'cycle', k: x.pendingCheck, n: x.state.switches + 1 });
  });
  $('btnShock').addEventListener('click', function () {
    add({ type: 'shock', n: L.derive(cur.events).shocks + 1 });
  });
  $('btnAdr').addEventListener('click', function () {
    if (alarm && alarm.kind === 'adr') stopAlarm();
    add({ type: 'adr', n: L.derive(cur.events).adrDoses + 1 });
  });
  $('btnAA').addEventListener('click', function () {
    var x = L.status(cur.events, cur.settings, now());
    var sched = L.aaSchedule(cur.settings.antiarrhythmic);
    var next = x.aa || sched[Math.min(x.state.aaDoses, sched.length - 1)];
    if (alarm && alarm.kind === 'aa') stopAlarm();
    add({ type: 'aa', label: next.label });
  });
  $('btnUndo').addEventListener('click', function () {
    if (cur.events.length <= 1) return;
    var last = cur.events[cur.events.length - 1];
    confirmBox('Undo last entry?', L.clock(last.t, true) + ' — ' + L.describe(last), 'Undo', function () {
      cur.events.pop(); persist(); render(); scheduleNotifications();
    });
  });
  $('btnEnd').addEventListener('click', function () {
    choose('End code — outcome', ['ROSC', 'Death declared', 'Transferred / handed over', 'Other'], function (o) { endCode(o); });
  });
  $('btnEndRosc').addEventListener('click', function () { endCode('ROSC'); });

  qsa('#otherDrugs .chip').forEach(function (b) {
    b.addEventListener('click', function () {
      add({ type: 'drug', text: b.textContent });
      b.classList.add('flash'); setTimeout(function () { b.classList.remove('flash'); }, 500);
    });
  });
  $('btnNote').addEventListener('click', function () {
    var v = $('noteText').value.trim(); if (!v) return;
    add({ type: 'note', text: v }); $('noteText').value = '';
  });
  $('btnMetro').addEventListener('click', function () {
    audio(); settings.metronome = !settings.metronome; save('cb.settings', settings);
    if (cur) cur.settings.metronome = settings.metronome;
    metroSync();
  });

  /* tabs */
  qsa('.tab').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = b.getAttribute('data-tab'), was = b.classList.contains('on');
      qsa('.tab').forEach(function (x) { x.classList.remove('on'); });
      qsa('.tabpane').forEach(function (x) { x.classList.add('hidden'); });
      if (!was) { b.classList.add('on'); $(id).classList.remove('hidden'); }
    });
  });

  function buildChecklist(el, items, type, grouped) {
    el.innerHTML = '';
    var lastGroup = null;
    items.forEach(function (it) {
      if (grouped && it.group !== lastGroup) {
        var g = document.createElement('div'); g.className = 'grp'; g.textContent = it.group === 'H' ? "H's" : "T's"; el.appendChild(g); lastGroup = it.group;
      }
      var b = document.createElement('button'); b.className = 'ck'; b.setAttribute('data-key', it.key);
      b.innerHTML = '<span class="box"></span><span></span>';
      b.lastChild.textContent = it.label;
      b.addEventListener('click', function () {
        var s = L.derive(cur.events), map = type === 'hst' ? s.hsts : s.airway;
        add({ type: type, key: it.key, on: !map[it.key] });
      });
      el.appendChild(b);
    });
  }
  buildChecklist($('hstsList'), L.HS_TS, 'hst', true);
  buildChecklist($('airwayList'), L.AIRWAY_ITEMS, 'airway', false);

  /* ---------- end + summary ---------- */
  function endCode(outcome) {
    stopAlarm();
    add({ type: 'end', outcome: outcome });
    history.push(cur); if (history.length > 30) history = history.slice(-30); save('cb.history', history);
    var finished = cur; cur = null; save('cb.current', null);
    cancelNotifications(); metroStop();
    if (KeepAwake) KeepAwake.allowSleep().catch(function () {});
    showSummary(finished);
  }
  function showSummary(c) {
    lastSummary = L.summaryText(c.events, c.settings, c.meta);
    $('summaryText').textContent = lastSummary;
    show('summary');
  }
  $('btnShare').addEventListener('click', function () {
    if (!lastSummary) return;
    if (Share) Share.share({ title: 'Code Blue record', text: lastSummary, dialogTitle: 'Share code record' }).catch(function () {});
    else if (navigator.share) navigator.share({ title: 'Code Blue record', text: lastSummary }).catch(function () {});
    else copyText();
  });
  function copyText() {
    if (navigator.clipboard) navigator.clipboard.writeText(lastSummary).then(function () { startAlarm({ kind: 'prewarn', title: 'Copied' }); });
  }
  $('btnCopy').addEventListener('click', copyText);
  $('btnHome').addEventListener('click', function () { show('home'); renderHistory(); tpArrest.setNow(); tpCpr.setNow(); });

  /* ---------- modals ---------- */
  function modal(title, bodyEl, buttons) {
    $('modalTitle').textContent = title;
    var body = $('modalBody'); body.innerHTML = ''; if (bodyEl) body.appendChild(bodyEl);
    var bt = $('modalBtns'); bt.innerHTML = '';
    buttons.forEach(function (b) {
      var el = document.createElement('button'); el.className = 'btn ' + (b.cls || ''); el.textContent = b.text;
      el.addEventListener('click', function () { closeModal(); if (b.fn) b.fn(); });
      bt.appendChild(el);
    });
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); }
  $('modal').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
  function textEl(t) { var p = document.createElement('p'); p.className = 'sub'; p.textContent = t; return p; }
  function confirmBox(title, text, ok, fn, cls) { modal(title, textEl(text), [{ text: ok, cls: cls || 'danger', fn: fn }, { text: 'Cancel', cls: 'ghost' }]); }
  function choose(title, opts, fn) {
    modal(title, null, opts.map(function (o) { return { text: o, fn: function () { fn(o); } }; }).concat([{ text: 'Cancel', cls: 'ghost' }]));
  }

  function openSettings() {
    var box = document.createElement('div');
    function seg(label, key, opts, fmt) {
      var l = document.createElement('div'); l.className = 'label'; l.textContent = label; box.appendChild(l);
      var s = document.createElement('div'); s.className = 'seg';
      opts.forEach(function (o) {
        var b = document.createElement('button'); b.textContent = fmt ? fmt(o) : o;
        if (settings[key] === o) b.className = 'sel';
        b.addEventListener('click', function () {
          settings[key] = o; save('cb.settings', settings);
          if (cur) { cur.settings[key] = o; persist(); scheduleNotifications(); }
          qsa('button', s).forEach(function (x) { x.className = ''; }); b.className = 'sel';
          render(); metroSync();
        });
        s.appendChild(b);
      });
      box.appendChild(s);
    }
    seg('Adrenaline alarm', 'adrIntervalMin', [3, 4, 5], function (o) { return 'Every ' + o + ' min'; });
    seg('First adrenaline in VT/VF', 'guideline', ['AHA', 'ERC'], function (o) { return o === 'AHA' ? 'After 2nd shock' : 'After 3rd shock'; });
    seg('Antiarrhythmic', 'antiarrhythmic', ['amiodarone', 'lignocaine'], function (o) { return o === 'amiodarone' ? 'Amiodarone' : 'Lignocaine'; });
    seg('Compression rate (metronome & estimate)', 'metronomeBpm', [100, 110, 120], function (o) { return o + '/min'; });
    var l = document.createElement('div'); l.className = 'label'; l.textContent = 'Test'; box.appendChild(l);
    var test = document.createElement('button'); test.className = 'btn wide'; test.textContent = 'Test alarm sound & vibration';
    test.addEventListener('click', function () { audio(); startAlarm({ kind: 'prewarn', title: 'TEST ALARM', body: 'If you cannot hear this, raise media volume.' }); PATTERNS.cycle(); });
    box.appendChild(test);
    box.appendChild(textEl('Changes apply to the running code immediately. Keep media volume up during a code.'));
    modal('Settings', box, [{ text: 'Done', cls: 'ok' }]);
  }
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSettings2').addEventListener('click', openSettings);

  /* ---------- render ---------- */
  function show(id) {
    ['home', 'run', 'summary'].forEach(function (s) { $(s).classList.toggle('hidden', s !== id); });
    window.scrollTo(0, 0);
  }

  function render() {
    if (!cur) return;
    var t = now();
    var x = L.status(cur.events, cur.settings, t), s = x.state;
    if (!s.started) return;
    $('elapsed').textContent = L.mmss(Math.max(0, x.elapsed));
    $('startedAt').textContent = 'Arrest ' + L.clock(s.arrestAt) + ' · CPR ' + L.clock(s.cprAt) + (cur.meta && cur.meta.location ? ' · ' + cur.meta.location : '');
    $('cCycles').textContent = x.cyclesDone; $('cSwitch').textContent = s.switches; $('cAdr').textContent = s.adrDoses;

    $('roscPanel').classList.toggle('hidden', !s.rosc);
    $('livePanel').classList.toggle('hidden', s.rosc);
    if (s.rosc) {
      var re = cur.events.filter(function (e) { return e.type === 'rosc'; }).pop();
      $('roscSince').textContent = 'At ' + L.clock(re.t) + ' · ' + L.mmss(t - re.t) + ' ago';
    } else {
      var rem = x.cycleRemaining, total = cur.settings.cycleMin * L.MIN, pend = x.pendingCheck;
      var card = $('cycleCard');
      card.classList.toggle('due', !!pend);
      card.classList.toggle('soon', !pend && rem <= cur.settings.prewarnSec * 1000);
      $('cycleNo').textContent = x.cycleNo;
      $('cycleTime').textContent = L.mmss(rem + 999);
      $('cycleBar').style.width = Math.min(100, Math.max(0, (1 - rem / total) * 100)) + '%';
      $('cycleMsg').textContent = pend ? 'SWITCH COMPRESSOR · CHECK PULSE NOW' : 'Next: switch compressor · check pulse';
      $('cycleAt').textContent = 'at ' + L.clock(x.cycleDue);
      $('btnCycleAck').classList.toggle('hidden', !pend);
      var rb = $('rhythmBadge');
      rb.textContent = s.rhythm || 'Rhythm ?';
      rb.className = 'rhythm-badge' + (L.isShockable(s.rhythm) ? ' shock' : L.isNonShockable(s.rhythm) ? ' nonshock' : '');
      $('btnShock').classList.toggle('hot', L.isShockable(s.rhythm));
      $('shockNext').textContent = '#' + (s.shocks + 1);

      var ac = $('adrCard');
      ac.classList.remove('due', 'soon');
      if (x.adrDue === null) { $('adrTime').textContent = '—'; $('adrAt').textContent = ''; }
      else {
        var ar = x.adrRemaining;
        if (ar <= 0) { ac.classList.add('due'); $('adrTime').textContent = 'NOW'; $('adrAt').textContent = 'Due since ' + L.clock(x.adrDue) + (ar < -1000 ? ' (' + L.mmss(-ar) + ' overdue)' : ''); }
        else { if (ar <= 30000) ac.classList.add('soon'); $('adrTime').textContent = L.mmss(ar + 999); $('adrAt').textContent = 'Next dose at ' + L.clock(x.adrDue); }
      }
      $('adrReason').textContent = x.adrReason;
      var given = cur.events.filter(function (e) { return e.type === 'adr'; });
      var al = $('adrList'); al.innerHTML = '';
      given.forEach(function (e, i) { var sp = document.createElement('span'); sp.textContent = (i + 1) + ': ' + L.clock(e.t); al.appendChild(sp); });

      var aac = $('aaCard'), aa = x.aa;
      var showAA = aa && (aa.ready || (L.isShockable(s.rhythm) && s.shocks >= 2));
      aac.classList.toggle('hidden', !showAA);
      if (showAA) {
        $('aaName').textContent = aa.label;
        $('aaReason').textContent = aa.ready ? 'Due now (after shock ' + aa.afterShock + ')' : 'After shock ' + aa.afterShock;
        $('aaTime').textContent = aa.ready ? 'NOW' : '';
        aac.classList.toggle('due', aa.ready);
      }
    }
    qsa('#hstsList .ck').forEach(function (b) { var on = !!s.hsts[b.getAttribute('data-key')]; b.classList.toggle('on', on); b.firstChild.textContent = on ? '✓' : ''; });
    qsa('#airwayList .ck').forEach(function (b) { var on = !!s.airway[b.getAttribute('data-key')]; b.classList.toggle('on', on); b.firstChild.textContent = on ? '✓' : ''; });
    $('logStats').textContent = x.cyclesDone + ' cycles · ' + s.switches + ' switches · ~' + x.estCompressions + ' compressions';
    renderLog(s);
  }

  var logCount = -1;
  function renderLog(s) {
    if (cur.events.length === logCount) return;
    logCount = cur.events.length;
    var el = $('logList'); el.innerHTML = '';
    L.logRows(cur.events).reverse().forEach(function (r) {
      var row = document.createElement('div'); row.className = 'ev k-' + r.type;
      row.innerHTML = '<span class="t"></span><span class="el"></span><span></span>';
      var d = r.t - s.cprAt;
      row.children[0].textContent = L.clock(r.t);
      row.children[1].textContent = (d < 0 ? '-' : '+') + L.mmss(Math.abs(d));
      row.children[2].textContent = r.text;
      el.appendChild(row);
    });
  }

  /* ---------- tick: timers + foreground alarms ---------- */
  function tick() {
    if (!cur || !running()) return;
    render();
    var t = now();
    var x = L.status(cur.events, cur.settings, t);
    var list = L.alerts(cur.events, cur.settings, t, 0);
    var fired = cur.fired || (cur.fired = {});
    var toFire = null, changed = false;
    list.forEach(function (a) {
      if (a.at <= t && !fired[a.key]) { fired[a.key] = 1; changed = true; if (!toFire || a.at >= toFire.at) toFire = a; }
    });
    if (changed) persist();
    // a ringing alarm keeps priority over a pre-warning
    if (toFire && appActive && t - toFire.at < 10 * L.MIN && !(toFire.kind === 'prewarn' && alarm && alarm.kind !== 'prewarn')) startAlarm(toFire);
    // keep ringing until handled (max 60 s), then stop sound but keep visual on the card
    if (alarm) {
      if (!alarmStillValid(x)) stopAlarm();
      else if (alarm.kind !== 'prewarn' && t < alarm.until && t - alarm.lastRing > 1600 && appActive) ringOnce();
      else if (alarm.kind === 'prewarn' && t > alarm.until + 4000) stopAlarm();
    }
  }
  setInterval(tick, 250);

  /* ---------- app lifecycle ---------- */
  if (App) {
    App.addListener('appStateChange', function (st) {
      appActive = !!st.isActive;
      if (appActive) { cancelNotifications(); tick(); } else scheduleNotifications();
    });
    App.addListener('backButton', function () {
      if (!$('modal').classList.contains('hidden')) { closeModal(); return; }
      if (cur && running()) { startAlarm({ kind: 'prewarn', title: 'Code running', body: 'Use "End code" to finish. Home button keeps the timer running.' }); return; }
      if (!$('summary').classList.contains('hidden')) { show('home'); renderHistory(); return; }
      App.exitApp();
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (App) return;
    appActive = document.visibilityState === 'visible';
  });

  /* ---------- boot ---------- */
  renderHistory(); metroSync();
  if (NATIVE) setupNotifications();
  if (cur && cur.events && cur.events.length && cur.events[0].arrestAt !== undefined && running()) {
    if (KeepAwake) KeepAwake.keepAwake().catch(function () {});
    show('run'); render();
  } else { cur = null; show('home'); }
})();
