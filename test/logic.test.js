// Run with: node test/logic.test.js
const L = require('../www/logic.js');
const assert = require('assert');
const M = 60000, T0 = new Date(2026, 9, 25, 19, 0, 0).getTime(); // 7:00 PM
let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n', e.message); process.exitCode = 1; } }
const start = (rhythm, extra) => Object.assign({ type: 'start', t: T0, arrestAt: T0 - 2 * M, rhythm }, extra);

t('main timer runs from CPR start; arrest time kept separately', () => {
  const x = L.status([start('PEA')], {}, T0 + 90000);
  assert.strictEqual(L.mmss(x.elapsed), '01:30');
  assert.strictEqual(L.mmss(x.sinceArrest), '03:30');
  assert.strictEqual(L.mmss(x.noFlow), '02:00');
});

t('2-min prompts on a fixed grid from CPR start (7:02, 7:04, 7:06…) regardless of rhythm entries', () => {
  const ev = [start('VF'), { type: 'rhythm', t: T0 + 70000, rhythm: 'VT' }];
  const al = L.alerts(ev, {}, T0, 7 * M).filter(a => a.kind === 'cycle');
  assert.deepStrictEqual(al.map(a => L.clock(a.at)), ['7:02 PM', '7:04 PM', '7:06 PM']);
  assert.ok(/SWITCH COMPRESSOR/.test(al[0].title) && /CHECK PULSE/.test(al[0].title));
});

t('pre-warning 10 s before each check', () => {
  const pre = L.alerts([start('PEA')], {}, T0, 3 * M).find(a => a.kind === 'prewarn');
  assert.strictEqual(pre.at, T0 + 2 * M - 10000);
});

t('unacknowledged check is pending; acknowledging counts a switch', () => {
  let ev = [start('PEA')];
  assert.strictEqual(L.status(ev, {}, T0 + 2 * M + 5000).pendingCheck, 1);
  ev.push({ type: 'cycle', t: T0 + 2 * M + 6000, k: 1, n: 1 });
  const x = L.status(ev, {}, T0 + 2 * M + 7000);
  assert.strictEqual(x.pendingCheck, undefined); assert.strictEqual(x.state.switches, 1);
});

t('no adrenaline alarm at CPR start, even with ASYSTOLE entered; card shows due, alarm rings at 4 min', () => {
  const ev = [start('ASYSTOLE')];
  const atStart = L.alerts(ev, {}, T0 + 1000, 0).filter(a => a.kind === 'adr' && a.at <= T0 + 1000);
  assert.strictEqual(atStart.length, 0, 'nothing rings at start');
  const x = L.status(ev, {}, T0 + 1000);
  assert.strictEqual(x.adrDue, T0, 'card shows due (visual)');
  assert.strictEqual(L.clock(x.adrAlarmAt), '7:04 PM');
  assert.strictEqual(L.alerts(ev, {}, T0, 5 * M).find(a => a.kind === 'adr').at, T0 + 4 * M);
});

t('unknown rhythm at start: no visual due; rhythm entered later makes it due', () => {
  const ev = [start(null)];
  assert.strictEqual(L.status(ev, {}, T0 + 1000).adrDue, null);
  ev.push({ type: 'rhythm', t: T0 + 40000, rhythm: 'PEA' });
  assert.strictEqual(L.status(ev, {}, T0 + 41000).adrDue, T0 + 40000);
});

t('after a dose: next alarm 4 min after the dose (7:00 → 7:04)', () => {
  const ev = [start('ASYSTOLE')];
  ev.push({ type: 'adr', t: T0, n: 1 });
  assert.strictEqual(L.clock(L.status(ev, {}, T0).adrDue), '7:04 PM');
  assert.strictEqual(L.status(ev, { adrIntervalMin: 3 }, T0).adrDue, T0 + 3 * M);
});

t('VT/VF: card due after 2nd shock; alarm at 4 min from CPR start', () => {
  const ev = [start('VF')];
  assert.strictEqual(L.status(ev, {}, T0).adrDue, null);
  assert.strictEqual(L.status(ev, {}, T0).adrAlarmAt, T0 + 4 * M);
  ev.push({ type: 'shock', t: T0 + 10000, n: 1 }, { type: 'shock', t: T0 + 2 * M + 10000, n: 2 });
  assert.strictEqual(L.status(ev, {}, T0 + 2 * M + 11000).adrDue, T0 + 2 * M + 10000);
});

t('adrenaline overdue reminders every minute; unique alert keys', () => {
  const ev = [start('PEA'), { type: 'adr', t: T0, n: 1 }];
  const al = L.alerts(ev, {}, T0, 7 * M);
  const adr = al.filter(a => a.kind === 'adr');
  assert.strictEqual(adr[0].at, T0 + 4 * M); assert.strictEqual(adr[1].at, T0 + 5 * M);
  assert.strictEqual(new Set(al.map(a => a.key)).size, al.length);
});

t('amiodarone 300 after 3rd shock, 150 after 5th, only in VT/VF', () => {
  const ev = [start('VF')];
  for (let i = 1; i <= 3; i++) ev.push({ type: 'shock', t: T0 + i, n: i });
  let aa = L.status(ev, {}, T0).aa; assert.ok(aa.ready && /300/.test(aa.label));
  ev.push({ type: 'aa', t: T0 + 4, label: aa.label }, { type: 'shock', t: T0 + 5, n: 4 }, { type: 'shock', t: T0 + 6, n: 5 });
  aa = L.status(ev, {}, T0).aa; assert.ok(aa.ready && /150/.test(aa.label));
  ev.push({ type: 'rhythm', t: T0 + 7, rhythm: 'PEA' });
  assert.strictEqual(L.status(ev, {}, T0).aa.ready, false);
});

t('ROSC stops prompts; re-arrest restarts the 2-min grid from that time', () => {
  const ev = [start('PEA'), { type: 'rosc', t: T0 + 5 * M }];
  assert.strictEqual(L.alerts(ev, {}, T0 + 6 * M).length, 0);
  ev.push({ type: 'rearrest', t: T0 + 7 * M, rhythm: 'VF' });
  assert.strictEqual(L.status(ev, {}, T0 + 7 * M).cycleDue, T0 + 9 * M);
});

t('12-hour time entry with AM/PM', () => {
  const now = new Date(2026, 9, 25, 19, 10).getTime();
  assert.strictEqual(L.clock(L.timeFrom12h(7, 5, 'PM', now)), '7:05 PM');
  assert.strictEqual(L.clock(L.timeFrom12h(12, 0, 'PM', now)), '12:00 PM');
  const nearMidnight = new Date(2026, 9, 26, 0, 3).getTime();
  const t1 = L.timeFrom12h(11, 58, 'PM', nearMidnight);
  assert.ok(t1 < nearMidnight && nearMidnight - t1 === 5 * M, 'previous day used');
});

t('undo = drop last event', () => {
  const ev = [start('PEA'), { type: 'adr', t: T0 + 1000, n: 1 }];
  assert.strictEqual(L.derive(ev.slice(0, -1)).adrDoses, 0);
});

t('summary: arrest & CPR times, adrenaline times, cycles, switches, log', () => {
  const ev = [start('ASYSTOLE'), { type: 'adr', t: T0, n: 1 }, { type: 'cycle', t: T0 + 2 * M, k: 1, n: 1 },
    { type: 'adr', t: T0 + 4 * M, n: 2 }, { type: 'end', t: T0 + 10 * M, outcome: 'ROSC' }];
  const s = L.summaryText(ev, {}, { location: 'MICU 4' });
  for (const re of [/Time of arrest: 6:58 PM/, /CPR started: 7:00 PM/, /Adrenaline: 2 \(7:00 PM, 7:04 PM\)/, /2-min cycles: 5/, /switches logged: 1/, /ARREST \(time entered\)/, /Initial rhythm: ASYSTOLE/])
    assert.ok(re.test(s), 'missing ' + re);
});

console.log(`\n${passed} passed`);
