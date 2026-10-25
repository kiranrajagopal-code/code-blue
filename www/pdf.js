/* Code Blue — PDF record (for transcription to the official Code Blue documentation sheet) */
(function (root) {
  'use strict';
  var OWNER = 'Dr. Kiran Rajagopal';

  function makePdf(c) {
    var L = root.CBLogic, P = root.CBPdf;
    var jsPDF = P.jsPDF, autoTable = P.autoTable;
    var st = L.mergeSettings(c.settings), ev = c.events, s = L.derive(ev);
    var end = s.ended ? s.endedAt : Date.now();
    var x = L.status(ev, st, end);
    var doc = new jsPDF({ unit: 'mm', format: 'a4' });
    var W = doc.internal.pageSize.getWidth(), M = 14;

    // header band
    doc.setFillColor(215, 38, 61); doc.rect(0, 0, W, 22, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
    doc.text('CODE BLUE RECORD', M, 14);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text('Reference for the official Code Blue documentation sheet', W - M, 14, { align: 'right' });
    doc.setTextColor(20);

    var adr = ev.filter(function (e) { return e.type === 'adr'; }).map(function (e) { return L.clock(e.t); });
    var aa = ev.filter(function (e) { return e.type === 'aa'; }).map(function (e) { return L.clock(e.t) + ' ' + e.label; });
    var shocks = ev.filter(function (e) { return e.type === 'shock'; }).map(function (e) { return L.clock(e.t); });
    var hsts = L.HS_TS.filter(function (h) { return s.hsts[h.key]; }).map(function (h) { return h.label; });
    var airway = L.AIRWAY_ITEMS.filter(function (a) { return s.airway[a.key]; }).map(function (a) { return a.label; });
    var roscEv = ev.filter(function (e) { return e.type === 'rosc'; }).pop();

    var rows = [
      ['Date', new Date(s.cprAt).toLocaleDateString('en-GB'), 'Location / bed', (c.meta && c.meta.location) || '—'],
      ['Time of arrest', L.clock(s.arrestAt), 'Code Blue / CPR started', L.clock(s.cprAt)],
      ['Initial rhythm', ev[0].rhythm || 'Not entered', 'Arrest to CPR', L.mmss(s.cprAt - s.arrestAt)],
      ['Code ended', s.ended ? L.clock(s.endedAt) : 'In progress', 'Total CPR time', L.mmss(end - s.cprAt)],
      ['Outcome', s.outcome || '—', 'ROSC at', roscEv ? L.clock(roscEv.t) : '—'],
      ['2-min cycles', String(x.cyclesDone), 'Compressor switches logged', String(s.switches)],
      ['Est. compressions', '~' + x.estCompressions + ' (at ' + st.metronomeBpm + '/min)', 'Shocks', s.shocks + (shocks.length ? ' (' + shocks.join(', ') + ')' : '')],
      ['Adrenaline 1 mg', s.adrDoses + (adr.length ? ' — ' + adr.join(', ') : ''), 'Antiarrhythmic', aa.length ? aa.join('; ') : '—'],
      ["Hs & Ts considered", hsts.length ? hsts.join(', ') : '—', 'Airway / access', airway.length ? airway.join(', ') : '—']
    ];
    autoTable(doc, {
      startY: 28, body: rows, theme: 'grid', margin: { left: M, right: M },
      styles: { fontSize: 9, cellPadding: 2, valign: 'middle' },
      columnStyles: { 0: { fontStyle: 'bold', fillColor: [244, 246, 249], cellWidth: 34 }, 1: { cellWidth: 56 }, 2: { fontStyle: 'bold', fillColor: [244, 246, 249], cellWidth: 38 } }
    });

    var y = doc.lastAutoTable.finalY + 8;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Event log', M, y);
    var log = L.logRows(ev).map(function (r) {
      var el = r.t - s.cprAt;
      return [L.clock(r.t, true), (el < 0 ? '-' : '+') + L.mmss(Math.abs(el)), r.text];
    });
    autoTable(doc, {
      startY: y + 3, head: [['Clock time', 'CPR +', 'Event']], body: log, theme: 'striped',
      margin: { left: M, right: M, bottom: 20 },
      headStyles: { fillColor: [30, 41, 59] }, styles: { fontSize: 9, cellPadding: 1.8 },
      columnStyles: { 0: { cellWidth: 28 }, 1: { cellWidth: 18 } },
      didParseCell: function (d) {
        if (d.section !== 'body') return;
        var t = d.row.raw[2];
        if (/^Adrenaline/.test(t)) d.cell.styles.textColor = [29, 78, 216];
        else if (/^Shock/.test(t)) d.cell.styles.textColor = [194, 65, 12];
        else if (/^Cycle/.test(t)) d.cell.styles.textColor = [21, 128, 61];
        else if (/^(CPR STARTED|ARREST|CODE ENDED|ROSC|RE-ARREST)/.test(t)) d.cell.styles.fontStyle = 'bold';
      }
    });

    // sign-off
    y = doc.lastAutoTable.finalY + 12;
    if (y > doc.internal.pageSize.getHeight() - 40) { doc.addPage(); y = 24; }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.text('Team leader: ______________________________', M, y);
    doc.text('Recorded by: ______________________________', M, y + 10);
    doc.text('Signature: _______________', W - M - 62, y);
    doc.text('Signature: _______________', W - M - 62, y + 10);

    // footer on every page
    var pages = doc.getNumberOfPages();
    for (var i = 1; i <= pages; i++) {
      doc.setPage(i);
      var H = doc.internal.pageSize.getHeight();
      doc.setDrawColor(220); doc.line(M, H - 14, W - M, H - 14);
      doc.setFontSize(8); doc.setTextColor(120);
      doc.text('Code Blue app · Developed by ' + OWNER + ' · Decision support only — follow current ACLS/ALS guidelines', M, H - 9);
      doc.text('Page ' + i + ' of ' + pages, W - M, H - 9, { align: 'right' });
    }
    return doc;
  }

  function fileName(c) {
    var d = new Date(c.events[0].t);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return 'CodeBlue_' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + '.pdf';
  }

  root.CBMakePdf = makePdf;
  root.CBPdfName = fileName;
  root.CBOwner = OWNER;
})(this);
