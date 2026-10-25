// Run with: node test/logic.test.js
const L = require('../www/logic.js');
const assert = require('assert');
const M = 60000, T0 = 1_700_000_000_000;
let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n', e.message); process.exitCode = 1; } }

t('non-shockable: adrenaline due immediately, cycle at 2 min', () => {
  const ev = [{ type: 'start', t: T0, rhythm: 'PEA' }];
  const x = L.status(ev, {}, T0 + 10000);
  assert.strictEqual(x.adrDue, T0);
  assert.strictEqual(x.cycleDue, T0 + 2 * M);
  assert.strictEqual(L.mmss(x.cycleRemaining), '01:50');
});

t('adrenaline repeats at chosen interval (3 and 5 min), clamps out-of-range', () => {
  const ev = [{ type: 'start', t: T0, rhythm: 'Asystole' }, { type: 'adr', t: T0 + 30000, n: 1 }];
  assert.strictEqual(L.status(ev, {}, T0).adrDue, T0 + 30000 + 4 * M);
  assert.strictEqual(L.status(ev, { adrIntervalMin: 3 }, T0).adrDue, T0 + 30000 + 3 * M);
  assert.strictEqual(L.status(ev, { adrIntervalMin: 5 }, T0).adrDue, T0 + 30000 + 5 * M);
  assert.strictEqual(L.status(ev, { adrIntervalMin: 9 }, T0).adrDue, T0 + 30000 + 5 * M);
});

t('shockable AHA: no adrenaline until 2nd shock', () => {
  const ev = [{ type: 'start', t: T0, rhythm: 'VF' }, { type: 'shock', t: T0 + 5000, n: 1 }];
  assert.strictEqual(L.status(ev, {}, T0 + 6000).adrDue, null);
  ev.push({ type: 'rhythm', t: T0 + 2 * M, rhythm: 'VF' }, { type: 'shock', t: T0 + 2 * M + 5000, n: 2 });
  assert.notStrictEqual(L.status(ev, {}, T0 + 2 * M + 6000).adrDue, null);
});

t('shockable ERC: adrenaline only after 3rd shock', () => {
  const ev = [{ type: 'start', t: T0, rhythm: 'VF' }, { type: 'shock', t: T0, n: 1 }, { type: 'shock', t: T0 + 2 * M, n: 2 }];
  assert.strictEqual(L.status(ev, { guideline: 'ERC' }, T0 + 3 * M).adrDue, null);
  ev.push({ type: 'shock', t: T0 + 4 * M, n: 3 });
  assert.notStrictEqual(L.status(ev, { guideline: 'ERC' }, T0 + 4 * M).adrDue, null);
});

t('amiodarone 300 after 3rd shock, 150 after 5th; only while shockable', () => {
  let ev = [{ type: 'start', t: T0, rhythm: 'VF' }];
  for (let i = 1; i <= 2; i++) ev.push({ type: 'shock', t: T0 + i, n: i });
  assert.strictEqual(L.status(ev, {}, T0).aa.ready, false);
  ev.push({ type: 'shock', t: T0 + 3, n: 3 });
  let aa = L.status(ev, {}, T0).aa;
  assert.ok(aa.ready && /300/.test(aa.label));
  ev.push({ type: 'aa', t: T0 + 4, label: aa.label });
  assert.strictEqual(L.status(ev, {}, T0).aa.ready, false);
  ev.push({ type: 'shock', t: T0 + 5, n: 4 }, { type: 'shock', t: T0 + 6, n: 5 });
  aa = L.status(ev, {}, T0).aa;
  assert.ok(aa.ready && /150/.test(aa.label));
  ev.push({ type: 'rhythm', t: T0 + 7, rhythm: 'PEA' });
  assert.strictEqual(L.status(ev, {}, T0).aa.ready, false, 'not prompted in PEA');
});

t('lignocaine option labels', () => {
  const ev = [{ type: 'start', t: T0, rhythm: 'pVT' }, { type: 'shock', t: T0, n: 1 }, { type: 'shock', t: T0, n: 2 }, { type: 'shock', t: T0, n: 3 }];
  assert.ok(/Lignocaine 1/.test(L.status(ev, { antiarrhythmic: 'lignocaine' }, T0).aa.label));
});

t('rhythm entry restarts 2-min cycle; ROSC stops prompts; re-arrest restarts', () => {
  const ev = [{ type: 'start', t: T0, rhythm: 'PEA' }, { type: 'rhythm', t: T0 + 2 * M + 8000, rhythm: 'Asystole' }];
  assert.strictEqual(L.status(ev, {}, T0 + 3 * M).cycleDue, T0 + 4 * M + 8000);
  ev.push({ type: 'rosc', t: T0 + 5 * M });
  const x = L.status(ev, {}, T0 + 6 * M);
  assert.strictEqual(x.cycleDue, undefined); assert.strictEqual(x.adrDue, null);
  assert.strictEqual(L.alerts(ev, {}, T0 + 6 * M).length, 0);
  ev.push({ type: 'rearrest', t: T0 + 7 * M, rhythm: 'VF' });
  assert.strictEqual(L.status(ev, {}, T0 + 7 * M).cycleDue, T0 + 9 * M);
});

t('undo = drop last event', () => {
  const ev = [{ type: 'start', t: T0, rhythm: 'PEA' }, { type: 'adr', t: T0 + 1000, n: 1 }];
  assert.strictEqual(L.derive(ev).adrDoses, 1);
  assert.strictEqual(L.derive(ev.slice(0, -1)).adrDoses, 0);
});

t('alerts: prewarn 15 s before, cycle at 2 min, adrenaline at 4 min, sorted', () => {
  const ev = [{ type: 'start', t: T0, rhythm: 'PEA' }, { type: 'adr', t: T0, n: 1 }];
  const al = L.alerts(ev, {}, T0, 5 * M);
  const find = k => al.find(a => a.kind === k);
  assert.strictEqual(find('prewarn').at, T0 + 2 * M - 15000);
  assert.strictEqual(find('cycle').at, T0 + 2 * M);
  assert.strictEqual(find('adr').at, T0 + 4 * M);
  for (let i = 1; i < al.length; i++) assert.ok(al[i].at >= al[i - 1].at);
  assert.strictEqual(new Set(al.map(a => a.key)).size, al.length, 'unique keys');
});

t('backdated start: elapsed counts from real arrest time', () => {
  const ev = [{ type: 'start', t: T0 - 3 * M, rhythm: 'PEA', offsetMin: 3 }];
  assert.strictEqual(L.mmss(L.status(ev, {}, T0).elapsed), '03:00');
  const ev2 = [{ type: 'start', t: T0 - 3 * M, cycleAt: T0, rhythm: 'PEA', offsetMin: 3 }];
  assert.strictEqual(L.status(ev2, {}, T0).cycleDue, T0 + 2 * M, 'CPR cycle counts from when app started');
});

t('summary text includes key events', () => {
  const ev = [{ type: 'start', t: T0, rhythm: 'VF' }, { type: 'shock', t: T0 + 5000, n: 1, joules: 200 }, { type: 'end', t: T0 + 10 * M, outcome: 'ROSC' }];
  const txt = L.summaryText(ev, {}, { location: 'MICU bed 4' });
  assert.ok(/Shock #1 — 200 J/.test(txt) && /MICU bed 4/.test(txt) && /Duration: 10:00/.test(txt));
});

console.log(`\n${passed} passed`);
