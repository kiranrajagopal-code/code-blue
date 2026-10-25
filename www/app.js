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
    g.gain.exponentialRampToValueAtTime(vol || 0.5, a.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + dur);
    o.connect(g); g.connect(a.destination);
    o.start(a.currentTime + start); o.stop(a.currentTime + start + dur + 0.05);
  }
  var PATTERNS = {
    cycle: function () { for (var i = 0; i < 3; i++) tone(1200, i * 0.25, 0.18); },
    adr: function () { tone(700, 0, 0.45); tone(700, 0.6, 0.45); },
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
      var bpm = settings.metronomeBpm || 110, iv = 60 / bpm;
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

  /* ---------- banner ---------- */
  var bannerTimer = null;
  function banner(kind, title, body) {
    var b = $('banner');
    b.className = 'banner ' + kind;
    b.innerHTML = '';
    b.appendChild(document.createTextNode(title));
    if (body) { var s = document.createElement('small'); s.textContent = body; b.appendChild(s); }
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(function () { b.classList.add('hidden'); }, kind === 'prewarn' ? 4000 : 8000);
  }
  $('banner').addEventListener('click', function () { this.classList.add('hidden'); });

  function fireAlert(al) {
    (PATTERNS[al.kind] || PATTERNS.cycle)();
    vibrate(al.kind === 'prewarn' ? 200 : 700);
    banner(al.kind, al.title, al.body);
  }

  /* ---------- notifications (alerts when screen locked / app in background) ---------- */
  var notifReady = false;
  function setupNotifications() {
    if (!Notif) return Promise.resolve();
    return Notif.requestPermissions().then(function () {
      return Notif.createChannel({ id: 'cb-alerts', name: 'Code Blue alerts', description: 'Rhythm check and drug timers', importance: 5, visibility: 1, vibration: true, lights: true });
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
      var list = L.alerts(cur.events, cur.settings, t, 30 * L.MIN).filter(function (a) { return a.at > t + 500; }).slice(0, 40);
      if (!list.length) return;
      Notif.schedule({ notifications: list.map(function (a, i) {
        return { id: 1000 + i, title: a.title, body: a.body, channelId: 'cb-alerts', schedule: { at: new Date(a.at), allowWhileIdle: true }, autoCancel: true };
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

  /* ---------- HOME ---------- */
  var startRhythm = '', offMin = 0;
  qsa('#startRhythm .chip').forEach(function (b) {
    b.addEventListener('click', function () {
      qsa('#startRhythm .chip').forEach(function (x) { x.classList.remove('sel'); });
      b.classList.add('sel'); startRhythm = b.getAttribute('data-r');
    });
  });
  function offRender() { $('offVal').textContent = offMin === 0 ? 'Now' : offMin + ' min ago'; }
  $('offMinus').addEventListener('click', function () { offMin = Math.max(0, offMin - 1); offRender(); });
  $('offPlus').addEventListener('click', function () { offMin = Math.min(60, offMin + 1); offRender(); });

  $('btnStart').addEventListener('click', function () {
    audio();
    var t = now();
    cur = { events: [], settings: JSON.parse(JSON.stringify(settings)), meta: { location: $('location').value.trim() }, fired: {} };
    var ev = { type: 'start', t: t - offMin * L.MIN, cycleAt: t, rhythm: startRhythm || null };
    if (offMin) ev.offsetMin = offMin;
    cur.events.push(ev); persist();
    if (KeepAwake) KeepAwake.keepAwake().catch(function () {});
    setupNotifications();
    show('run'); render();
  });

  function renderHistory() {
    var h = $('history'); h.innerHTML = '';
    if (!history.length) { h.innerHTML = '<div class="muted">None yet</div>'; return; }
    history.slice().reverse().forEach(function (c, idx) {
      var s = L.derive(c.events);
      var row = document.createElement('div'); row.className = 'h-item';
      var d = new Date(s.startedAt);
      var info = document.createElement('div');
      info.innerHTML = '<b></b><div class="sub"></div>';
      info.firstChild.textContent = d.toLocaleDateString() + ' ' + L.clock(s.startedAt).slice(0, 5) + (c.meta && c.meta.location ? ' · ' + c.meta.location : '');
      info.lastChild.textContent = (s.outcome || '') + ' · ' + L.mmss((s.endedAt || s.startedAt) - s.startedAt) + ' · ' + s.shocks + ' shocks · ' + s.adrDoses + ' adr';
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
    confirmBox('ROSC?', 'Stops the cycle and drug timers. You can tap RE-ARREST if needed.', 'Confirm ROSC', function () { add({ type: 'rosc' }); });
  });
  $('btnRearrest').addEventListener('click', function () {
    choose('Re-arrest — rhythm?', ['VF', 'pVT', 'PEA', 'Asystole', 'Unknown'], function (r) { add({ type: 'rearrest', rhythm: r === 'Unknown' ? null : r }); });
  });
  $('btnShock').addEventListener('click', function () {
    var s = L.derive(cur.events);
    add({ type: 'shock', n: s.shocks + 1 });
  });
  $('btnAdr').addEventListener('click', function () {
    var s = L.derive(cur.events);
    add({ type: 'adr', n: s.adrDoses + 1 });
  });
  $('btnAA').addEventListener('click', function () {
    var x = L.status(cur.events, cur.settings, now());
    var sched = L.aaSchedule(cur.settings.antiarrhythmic);
    var next = x.aa || sched[Math.min(x.state.aaDoses, sched.length - 1)];
    add({ type: 'aa', label: next.label });
  });
  $('btnUndo').addEventListener('click', function () {
    if (cur.events.length <= 1) return;
    var last = cur.events[cur.events.length - 1];
    confirmBox('Undo last entry?', L.clock(last.t) + ' — ' + L.describe(last, cur.settings), 'Undo', function () {
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
      if (!was) { b.classList.add('on'); $(id).classList.remove('hidden'); if (id === 'tLog') setTimeout(function () { $(id).scrollIntoView({ behavior: 'smooth' }); }, 50); }
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
    if (navigator.clipboard) navigator.clipboard.writeText(lastSummary).then(function () { banner('prewarn', 'Copied'); });
  }
  $('btnCopy').addEventListener('click', copyText);
  $('btnHome').addEventListener('click', function () { show('home'); renderHistory(); });

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
  function confirmBox(title, text, ok, fn) { modal(title, textEl(text), [{ text: ok, cls: 'danger', fn: fn }, { text: 'Cancel', cls: 'ghost' }]); }
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
    seg('Adrenaline interval', 'adrIntervalMin', [3, 4, 5], function (o) { return 'Every ' + o + ' min'; });
    seg('First adrenaline in VF/pVT', 'guideline', ['AHA', 'ERC'], function (o) { return o === 'AHA' ? 'After 2nd shock (AHA)' : 'After 3rd shock (ERC)'; });
    seg('Antiarrhythmic', 'antiarrhythmic', ['amiodarone', 'lignocaine'], function (o) { return o === 'amiodarone' ? 'Amiodarone' : 'Lignocaine'; });
    seg('Metronome rate', 'metronomeBpm', [100, 110, 120], function (o) { return o + '/min'; });
    var l = document.createElement('div'); l.className = 'label'; l.textContent = 'Test'; box.appendChild(l);
    var test = document.createElement('button'); test.className = 'btn wide'; test.textContent = 'Test alert sound & vibration';
    test.addEventListener('click', function () { audio(); fireAlert({ kind: 'cycle', title: 'TEST ALERT', body: 'If you cannot hear this, raise media volume.' }); });
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
    $('elapsed').textContent = L.mmss(x.elapsed);
    $('startedAt').textContent = 'Started ' + L.clock(s.startedAt).slice(0, 5) + (cur.meta && cur.meta.location ? ' · ' + cur.meta.location : '');
    $('cShocks').textContent = s.shocks; $('cAdr').textContent = s.adrDoses; $('cAA').textContent = s.aaDoses;
    $('cAAlbl').textContent = cur.settings.antiarrhythmic === 'lignocaine' ? 'ligno' : 'amio';

    $('roscPanel').classList.toggle('hidden', !s.rosc);
    $('livePanel').classList.toggle('hidden', s.rosc);
    if (s.rosc) {
      var re = cur.events.filter(function (e) { return e.type === 'rosc'; }).pop();
      $('roscSince').textContent = 'At ' + L.clock(re.t).slice(0, 5) + ' · ' + L.mmss(t - re.t) + ' ago';
    } else {
      // cycle
      var rem = x.cycleRemaining, total = cur.settings.cycleMin * L.MIN;
      var card = $('cycleCard');
      card.classList.toggle('due', rem <= 0);
      card.classList.toggle('soon', rem > 0 && rem <= cur.settings.prewarnSec * 1000);
      $('cycleTime').textContent = rem <= 0 ? '+' + L.mmss(-rem) : L.mmss(rem + 999);
      $('cycleBar').style.width = Math.min(100, Math.max(0, (1 - rem / total) * 100)) + '%';
      $('cycleMsg').textContent = rem <= 0 ? 'RHYTHM / PULSE CHECK — rotate compressor' : (rem <= cur.settings.prewarnSec * 1000 ? 'Prepare: next compressor, charge if shockable' : 'Next rhythm / pulse check');
      $('cycleNo').textContent = '#' + s.cycles;
      var rb = $('rhythmBadge');
      rb.textContent = s.rhythm || 'Rhythm ?';
      rb.className = 'rhythm-badge' + (L.isShockable(s.rhythm) ? ' shock' : L.isNonShockable(s.rhythm) ? ' nonshock' : '');
      // shock
      $('btnShock').classList.toggle('hot', L.isShockable(s.rhythm));
      $('shockNext').textContent = '#' + (s.shocks + 1);
      // adrenaline
      var ac = $('adrCard');
      ac.classList.remove('due', 'soon');
      if (x.adrDue === null) { $('adrTime').textContent = '—'; }
      else {
        var ar = x.adrRemaining;
        if (ar <= 0) { ac.classList.add('due'); $('adrTime').textContent = s.lastAdrAt === null ? 'NOW' : '+' + L.mmss(-ar); }
        else { if (ar <= 30000) ac.classList.add('soon'); $('adrTime').textContent = L.mmss(ar + 999); }
      }
      $('adrReason').textContent = (s.lastAdrAt !== null ? 'Last ' + L.mmss(t - s.lastAdrAt) + ' ago · ' : '') + x.adrReason;
      // antiarrhythmic
      var aac = $('aaCard'), aa = x.aa;
      var showAA = aa && (aa.ready || (L.isShockable(s.rhythm) && s.shocks >= 2));
      aac.classList.toggle('hidden', !showAA);
      if (showAA) {
        $('aaName').textContent = aa.label;
        $('aaReason').textContent = aa.ready ? 'Due now (after shock ' + aa.afterShock + ')' : 'After shock ' + aa.afterShock;
        $('aaTime').textContent = aa.ready ? 'NOW' : '';
        aac.classList.toggle('due', aa.ready);
        $('btnAA').textContent = 'GIVEN';
      }
    }
    // checklists
    qsa('#hstsList .ck').forEach(function (b) { b.classList.toggle('on', !!s.hsts[b.getAttribute('data-key')]); b.firstChild.textContent = s.hsts[b.getAttribute('data-key')] ? '✓' : ''; });
    qsa('#airwayList .ck').forEach(function (b) { b.classList.toggle('on', !!s.airway[b.getAttribute('data-key')]); b.firstChild.textContent = s.airway[b.getAttribute('data-key')] ? '✓' : ''; });
    renderLog(s);
  }

  var logCount = -1;
  function renderLog(s) {
    if (cur.events.length === logCount) return;
    logCount = cur.events.length;
    var el = $('logList'); el.innerHTML = '';
    cur.events.slice().reverse().forEach(function (e) {
      var row = document.createElement('div'); row.className = 'ev';
      row.innerHTML = '<span class="t"></span><span class="el"></span><span></span>';
      row.children[0].textContent = L.clock(e.t).slice(0, 5);
      row.children[1].textContent = '+' + L.mmss(e.t - s.startedAt);
      row.children[2].textContent = L.describe(e, cur.settings);
      el.appendChild(row);
    });
  }

  /* ---------- tick: timers + foreground alerts ---------- */
  function tick() {
    if (!cur || !running()) return;
    render();
    var t = now();
    var list = L.alerts(cur.events, cur.settings, t, 0);
    var fired = cur.fired || (cur.fired = {});
    var toFire = null, changed = false;
    list.forEach(function (a) {
      if (a.at <= t && !fired[a.key]) { fired[a.key] = 1; changed = true; if (!toFire || a.at >= toFire.at) toFire = a; }
    });
    if (changed) persist();
    if (toFire && appActive && t - toFire.at < 10 * L.MIN) fireAlert(toFire);
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
      if (cur && running()) { banner('prewarn', 'Code running', 'Use "End code" to finish. Home button keeps the timer running.'); return; }
      if (!$('summary').classList.contains('hidden')) { show('home'); renderHistory(); return; }
      App.exitApp();
    });
  }
  document.addEventListener('visibilitychange', function () {
    if (App) return; // native uses appStateChange
    appActive = document.visibilityState === 'visible';
  });

  /* ---------- boot ---------- */
  renderHistory(); metroSync();
  if (NATIVE) setupNotifications();
  if (cur && cur.events && cur.events.length && running()) {
    if (KeepAwake) KeepAwake.keepAwake().catch(function () {});
    show('run'); render();
  } else { cur = null; show('home'); }
})();
