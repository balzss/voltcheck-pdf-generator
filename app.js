/* ============================================================
   VoltCheck PDF Generator — main app
   - Reads an Autel SOH Blitz Test PDF via PDF.js
   - Extracts headline fields, pack/cell stats, module rows
   - Renders a VoltCheck-branded HTML report (4 pages)
   - Exports to PDF via html2pdf.js
   ============================================================ */

const $ = (sel, root = document) => root.querySelector(sel);

const drop      = $("#drop");
const fileInput = $("#file");
const errorBox  = $("#error");
const downloadB = $("#download");
const previewW  = $("#previewWrap");
const preview   = $("#preview");
const dropSub   = $("#dropSub");

let currentReport = null;
/* Used as the print dialog's suggested filename — most browsers default
   to document.title when saving as PDF. */
const ORIGINAL_TITLE = document.title;
let currentTitle = "voltcheck-jelentes";

/* ---------- File pick / drag-drop ----------
   The <label id="drop"> already opens the file dialog natively when clicked. */
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

["dragenter", "dragover"].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); })
);
["dragleave", "drop"].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); })
);
drop.addEventListener("drop", e => {
  const f = e.dataTransfer.files?.[0];
  if (f) handleFile(f);
});

downloadB.addEventListener("click", () => {
  if (!currentReport) return;
  // The print dialog uses document.title as the default filename for
  // "Save as PDF" — set it just before printing and restore afterwards.
  const prevTitle = document.title;
  document.title = currentTitle;
  window.print();
  // afterprint fires once the dialog closes (Chrome, Firefox, Safari)
  const restore = () => {
    document.title = prevTitle;
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
});

/* ---------- File handling ---------- */
async function handleFile(file) {
  errorBox.hidden = true;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    return showError("Csak PDF fájlt lehet feltölteni.");
  }
  dropSub.textContent = `Beolvasás: ${file.name}…`;
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const text = await extractText(pdf);
    const data = parseReport(text);
    if (!data.soh && !data.vehicle) {
      throw new Error(
        "Nem találhatóak a várt mezők a PDF-ben. Biztos, hogy ez az Autel SOH Blitz Test jelentés?"
      );
    }
    data.gaugeImage = await extractGaugeArtwork(pdf);
    data.barValues  = await extractBarValueArtwork(pdf);
    renderReport(data);
    currentTitle = buildFilename(data);
    downloadB.hidden = false;
    dropSub.textContent = `Beolvasva: ${file.name}`;
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
  }
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}

function buildFilename(d) {
  const stamp = (d.creationDate || d.testTime || "").replace(/[^\d]/g, "").slice(0, 12);
  const vin = (d.vin || "").replace(/[^\w-]/g, "");
  const parts = ["voltcheck", "jelentes", vin, stamp].filter(Boolean);
  return parts.join("-");
}

/* ============================================================
   PDF -> text
   We walk every text item, keep document order, and split into
   "lines" whenever the Y position changes by more than a small
   threshold. Returns one big newline-joined string for regex parsing.
   ============================================================ */
async function extractText(pdf) {
  const allLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let lastY = null;
    let line = [];
    for (const item of content.items) {
      if (!item.str) continue;
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2.5) {
        if (line.length) allLines.push(line.join(" "));
        line = [];
      }
      line.push(item.str);
      lastY = y;
    }
    if (line.length) allLines.push(line.join(" "));
  }
  return allLines.join("\n");
}

/* ============================================================
   Crop just the 3 gauge semicircles (arc + grade letter + arrow)
   out of the source PDF page 1. We can't reproduce Autel's grade
   letters or arrow positions ourselves — they're vector paths
   rather than extractable text — so we keep the original pixels.

   Vertical bounds:
     top    = below the "Pack Information" green pill
     bottom = just above the first English label row ("Battery
              Health Status" etc.), which sits directly above
              the "SOH*:" metric line.
   ============================================================ */
async function extractGaugeArtwork(pdf) {
  const SCALE = 3;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: SCALE });

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  const content = await page.getTextContent();
  let packInfoY = null;
  let sohY = null;

  for (const item of content.items) {
    const str = (item.str || "").trim();
    const m = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const y = m[5];
    if (str === "Pack Information") packInfoY = y;
    if (/^SOH\*?:/.test(str)) {
      sohY = sohY === null ? y : Math.min(sohY, y);
    }
  }

  if (packInfoY === null || sohY === null) return null;

  // 18pt past the Pack Information baseline clears the pill.
  // 58pt above the SOH*: baseline cuts the English gauge labels
  // ("Battery Health Status" etc.) AND the thin underline stroke
  // that sits just above the metric rows.
  const topY    = packInfoY + 18 * SCALE;
  const bottomY = sohY      - 52 * SCALE;
  if (bottomY <= topY) return null;

  // Trim 4% off each horizontal edge so the page's faint vertical
  // margin guide lines don't end up in the cropped strip.
  const leftX  = viewport.width * 0.04;
  const rightX = viewport.width * 0.96;

  const crop = document.createElement("canvas");
  crop.width  = rightX - leftX;
  crop.height = bottomY - topY;
  crop.getContext("2d").drawImage(canvas, -leftX, -topY);

  return crop.toDataURL("image/png");
}

/* ============================================================
   Crop ONLY the numeric value groups for the energy/range bar
   ("38 kWh | 40 kWh" and "256.5 km | 270 km") out of source page 1.

   These values are vector-drawn (not extractable text), so we can't
   read them — but we can lift the exact pixels and drop them onto our
   own generated bar (whose green fill is driven by SOH). That keeps the
   numbers 100% faithful to the source while everything else is generated.

   We don't hard-code positions. Instead:
     1. Bracket the bar region with text anchors we CAN read — the last
        metric row ("Battery Voltage" / "Max Voltage Delta") above it and
        the "*:" disclaimer below it.
     2. Detect the solid horizontal bar band by its color (Autel green or
        track grey) — this works for any SOH fill level.
     3. The energy values are the text block just above the bar; the range
        values are the block just below it. Find each block's tight bounding
        box by scanning for "ink" pixels and crop to it.
   ============================================================ */
async function extractBarValueArtwork(pdf) {
  const SCALE = 3;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: SCALE });

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  const content = await page.getTextContent();
  let metricsBottomY = null;
  let disclaimerY    = null;
  for (const item of content.items) {
    const str = (item.str || "").trim();
    if (!str) continue;
    const y = pdfjsLib.Util.transform(viewport.transform, item.transform)[5];
    if (/^(Battery Voltage|Max Voltage Delta):/.test(str)) {
      metricsBottomY = metricsBottomY === null ? y : Math.max(metricsBottomY, y);
    }
    if (/^\*\s*:/.test(str)) {
      disclaimerY = disclaimerY === null ? y : Math.min(disclaimerY, y);
    }
  }
  if (metricsBottomY === null || disclaimerY === null) return null;

  const W = canvas.width;
  const top = Math.max(0, Math.round(metricsBottomY));
  const bot = Math.min(canvas.height - 1, Math.round(disclaimerY));
  const { data } = ctx.getImageData(0, 0, W, canvas.height);

  const isInk = i => Math.min(data[i], data[i + 1], data[i + 2]) < 200;
  const isBar = i => {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const green = Math.abs(r - 76) < 50 && Math.abs(g - 176) < 50 && Math.abs(b - 80) < 50;
    const grey  = Math.abs(r - 209) < 22 && Math.abs(g - 209) < 22 && Math.abs(b - 209) < 22;
    return green || grey;
  };

  // Sampling window across most of the page width to detect the bar band.
  const sx0 = Math.round(W * 0.05), sx1 = Math.round(W * 0.99), sStep = 4;
  const samples = Math.ceil((sx1 - sx0) / sStep);
  const barFrac = y => {
    let n = 0;
    for (let x = sx0; x < sx1; x += sStep) if (isBar((y * W + x) * 4)) n++;
    return n / samples;
  };
  // The bar is the TALLEST contiguous run of bar-colored rows. We can't just
  // take the first/last matching row: thin light-grey rules (a metric-row
  // underline above, a divider below) also match the grey test, but they're
  // isolated single rows — the real bar is a tall solid band.
  let barTop = null, barBottom = null, runStart = null, best = -1;
  for (let y = top; y <= bot + 1; y++) {
    if (y <= bot && barFrac(y) > 0.6) {
      if (runStart === null) runStart = y;
    } else if (runStart !== null) {
      if (y - 1 - runStart > best) { best = y - 1 - runStart; barTop = runStart; barBottom = y - 1; }
      runStart = null;
    }
  }
  if (barTop === null) return null;

  // The value numbers live on the right side of the page.
  const vx0 = Math.round(W * 0.62), vx1 = Math.round(W * 0.995);
  // The value group always contains DARK text (the "max" part: "40 kWh",
  // "270 km"). The source's own triangle marker between the text and the bar
  // is pure green (no dark ink), so keying on dark rows skips it cleanly; and
  // because we take the FIRST dark block out from the bar, we also stop short
  // of the dark disclaimer paragraph below the range row.
  const isDark = i => Math.max(data[i], data[i + 1], data[i + 2]) < 150;
  const rowDark = y => {
    let n = 0;
    for (let x = vx0; x < vx1; x++) if (isDark((y * W + x) * 4)) n++;
    return n;
  };
  const GAP = Math.round(1.5 * SCALE);  // small: separates the text line from the triangle
  const MARGIN = Math.round(2 * SCALE);

  // Walk away from the bar (dir = -1 up for energy, +1 down for range) to the
  // first dark-text block, then crop the full group's bounding box — over ALL
  // ink, so the green "now" value (e.g. "38 kWh") is kept alongside the dark
  // "max" value.
  const cropValue = (fromY, dir, limitY) => {
    let y = fromY;
    while (y !== limitY && rowDark(y) < 2) y += dir;
    if (rowDark(y) < 2) return null;
    let a = y, bEdge = y, gap = 0;
    while (y !== limitY) {
      if (rowDark(y) >= 2) { bEdge = y; gap = 0; }
      else if (++gap > GAP) break;
      y += dir;
    }
    let yTop = Math.min(a, bEdge) - MARGIN, yBot = Math.max(a, bEdge) + MARGIN;
    yTop = Math.max(0, yTop); yBot = Math.min(canvas.height - 1, yBot);
    let xL = vx1, xR = vx0;
    for (let yy = yTop; yy <= yBot; yy++) {
      for (let xx = vx0; xx < vx1; xx++) {
        if (isInk((yy * W + xx) * 4)) { if (xx < xL) xL = xx; if (xx > xR) xR = xx; }
      }
    }
    if (xR <= xL) return null;
    xL = Math.max(0, xL - MARGIN); xR = Math.min(W - 1, xR + MARGIN);

    const c = document.createElement("canvas");
    c.width = xR - xL; c.height = yBot - yTop;
    c.getContext("2d").drawImage(canvas, -xL, -yTop);
    return { url: c.toDataURL("image/png"), w: c.width, h: c.height };
  };

  return {
    energy: cropValue(barTop - MARGIN, -1, top),
    range:  cropValue(barBottom + MARGIN, +1, bot),
  };
}

/* ============================================================
   Field extraction
   ============================================================ */
function parseReport(text) {
  // Normalize whitespace inside each line but keep newlines
  const norm = text
    .split("\n")
    .map(l => l.replace(/[ \t]+/g, " ").trim())
    .join("\n");

  // Also keep a single-line variant for cross-line module label matches like
  //   "M3 (#9-\n#12) 14.92 V ..."   →   "M3 (#9- #12) 14.92 V ..."
  const flat = norm.replace(/\n/g, " ").replace(/\s+/g, " ");

  const m1 = (re, def = "", src = norm) => {
    const m = src.match(re);
    return m ? m[1].trim() : def;
  };

  // Page-1 paired-label end-anchor (next known label or end of line)
  const NEXT_LABEL = "(?=\\s+(?:Test Time|Testing Organization|VIN|Customer|S\\/N|Rated Voltage|Rated Capacity|Version|Odometer Reading|Creation Date|Report ID)\\b|$)";

  const out = {
    /* --- Vehicle info ---
       The first line after "Vehicle Information" looks like
         "2020/07-/Nissan/Leaf Test Time: 2026-05-30 13:20:58"
       so we explicitly stop before " Test Time:". */
    vehicle:        m1(/Vehicle Information\s*\n(.+?)\s+Test Time:/) ||
                    m1(/^(\d{4}\/\S+(?:\s+\S+)*?)\s+Test Time:/m),
    testTime:       m1(new RegExp(`Test Time:\\s*(.+?)${NEXT_LABEL}`)),
    odometer:       m1(new RegExp(`Odometer Reading:\\s*(.+?)${NEXT_LABEL}`)),
    testOrg:        m1(new RegExp(`Testing Organization:\\s*(.+?)${NEXT_LABEL}`)),
    vin:            m1(new RegExp(`VIN:\\s*(.+?)${NEXT_LABEL}`)),
    customer:       m1(new RegExp(`Customer:\\s*(.*?)${NEXT_LABEL}`)),
    ratedVoltage:   m1(new RegExp(`Rated Voltage:\\s*(.+?)${NEXT_LABEL}`)),
    sn:             m1(new RegExp(`S\\/N:\\s*(.+?)${NEXT_LABEL}`)),
    ratedCapacity:  m1(new RegExp(`Rated Capacity:\\s*(.+?)${NEXT_LABEL}`)),
    version:        m1(new RegExp(`Version:\\s*(.+?)${NEXT_LABEL}`)),

    /* --- Pack Information headline values --- */
    soh:             m1(/SOH\*?:\s*([\d.]+)\s*%/),
    soc:             m1(/SOC:\s*([\d.]+)\s*%/),
    batteryTemp:     m1(/Battery Temperature:\s*([\d.\-]+\s*°?C)/),
    maxTempDelta:    m1(/Max Temperature Delta:\s*([\d.\-]+\s*°?C)/),
    batteryVoltage:  m1(/Battery Voltage:\s*([\d.]+\s*V)/),
    maxVoltageDelta: m1(/Max Voltage Delta:\s*([\d.]+\s*mV)/),

    /* --- Energy / range bars --- */
    energyNow:   m1(/(\d+(?:\.\d+)?)\s*kWh\s*\|\s*\d+(?:\.\d+)?\s*kWh/),
    energyMax:   m1(/\d+(?:\.\d+)?\s*kWh\s*\|\s*(\d+(?:\.\d+)?)\s*kWh/),
    rangeNow:    m1(/(\d+(?:\.\d+)?)\s*km\s*\|\s*\d+(?:\.\d+)?\s*km/),
    rangeMax:    m1(/\d+(?:\.\d+)?\s*km\s*\|\s*(\d+(?:\.\d+)?)\s*km/),

    /* --- DTCs --- */
    dtcFault:     !/No fault codes detected/i.test(norm),

    /* --- Footer-ish metadata --- */
    creationDate: m1(new RegExp(`Creation Date:\\s*(.+?)${NEXT_LABEL}`)),
    reportId:     m1(new RegExp(`Report ID:\\s*(.+?)${NEXT_LABEL}`)),

    /* --- Module voltage stats (page 2) --- */
    moduleVMax:   m1(/Maximum Module Voltage:\s*([\d.]+\s*V)/),
    moduleVMin:   m1(/Minimum Module Voltage:\s*([\d.]+\s*V)/),
    moduleVAvg:   m1(/Average Module Voltage:\s*([\d.]+\s*V)/),
    moduleVDelta: m1(/Module Voltage Delta:\s*([\d.]+\s*[mV]?V)/),
    moduleVStd:   m1(/Standard Module Voltage Delta:\s*([\d.]+\s*[mV]?V)/),
    cellVMax:     m1(/Maximum Cell Voltage:\s*([\d.]+\s*V)/),
    cellVMin:     m1(/Minimum Cell Voltage:\s*([\d.]+\s*V)/),
    cellVAvg:     m1(/Average Cell Voltage:\s*([\d.]+\s*V)/),
    cellVDelta:   m1(/Cell Voltage Delta:\s*([\d.]+\s*m?V)/),
    cellVStd:     m1(/Standard Cell Voltage Delta:\s*([\d.]+\s*m?V)/),

    /* --- Module temperature stats --- */
    tempMax: m1(/Max Temperature:\s*([\d.\-]+\s*°?C)/),
    tempMin: m1(/Min Temperature:\s*([\d.\-]+\s*°?C)/),
    tempAvg: m1(/Average Temperature:\s*([\d.\-]+\s*°?C)/),

    /* --- Module / cell table rows (parsed against `flat`) --- */
    moduleRows:      parseModuleVoltageRows(flat),
    temperatureRows: parseTemperatureRows(flat),
  };

  /* --- Energy / range "load bar" fill ---
     The bar fill fraction (for BOTH the energy and range annotations) is
     simply SOH — that's the one number we extract reliably as text, so the
     bar graphic is fully generated. The numeric value labels themselves
     ("38 kWh | 40 kWh", "256.5 km | 270 km") are vector-drawn in the source
     and not recoverable as text, so they're cropped from the PDF instead
     (see extractBarValueArtwork). */
  const sohN = parseFloat(out.soh);
  out.barFillPct = isFinite(sohN) ? Math.max(0, Math.min(100, sohN)) : null;

  return out;
}

/* Parse module voltage rows.
   Each row has the form:  M<i> (#<a>-#<b>) <moduleV> V <c1> V <c2> V <c3> V <c4> V
   Some BMSes have more cells per module — accept 1–8 cell values. */
function parseModuleVoltageRows(flat) {
  const re = /M(\d+)\s*\(#(\d+)\s*-\s*#(\d+)\)\s+((?:[\d.]+\s*V\s+){2,9})/g;
  const rows = [];
  let m;
  while ((m = re.exec(flat)) !== null) {
    const moduleIdx = parseInt(m[1], 10);
    const cellFrom = parseInt(m[2], 10);
    const cellTo = parseInt(m[3], 10);
    const nums = m[4].match(/[\d.]+/g) || [];
    if (nums.length < 2) continue;
    const moduleV = parseFloat(nums[0]);
    const cellV = nums.slice(1).map(parseFloat);
    rows.push({ moduleIdx, cellFrom, cellTo, moduleV, cellV });
  }
  return rows;
}

/* Parse temperature rows:  M<i> (T<a>-T<b>) <temp> °C
   The temperature table in the source uses one column per sensor row;
   we capture the single temperature value for now. */
function parseTemperatureRows(flat) {
  const re = /M(\d+)\s*\(T(\d+)\s*-\s*T(\d+)\)\s+([\d.\-]+)\s*°?C/g;
  const rows = [];
  let m;
  while ((m = re.exec(flat)) !== null) {
    rows.push({
      moduleIdx: parseInt(m[1], 10),
      sensorFrom: parseInt(m[2], 10),
      sensorTo: parseInt(m[3], 10),
      temp: parseFloat(m[4]),
    });
  }
  return rows;
}

/* ============================================================
   Render
   ============================================================ */
function renderReport(d) {
  const tpl = document.getElementById("reportTemplate");
  const frag = tpl.content.cloneNode(true);
  const root = frag.querySelector(".report");

  /* ---------- Simple text slots ---------- */
  const fields = {
    vehicle:        d.vehicle || "—",
    testTime:       d.testTime || "—",
    odometer:       d.odometer || "—",
    testOrg:        d.testOrg || "—",
    vin:            d.vin || "—",
    customer:       d.customer || "—",
    ratedVoltage:   d.ratedVoltage || "—",
    sn:             d.sn || "—",
    ratedCapacity:  d.ratedCapacity || "—",
    version:        d.version || "—",

    soh:            d.soh ? `${d.soh} %` : "—",
    soc:            d.soc ? `${d.soc} %` : "—",
    batteryTemp:    d.batteryTemp || "—",
    maxTempDelta:   d.maxTempDelta || "—",
    batteryVoltage: d.batteryVoltage || "—",
    maxVoltageDelta:d.maxVoltageDelta || "—",

    energyNow:      d.energyNow ? `${d.energyNow} kWh` : "—",
    energyMax:      d.energyMax ? `${d.energyMax} kWh` : "—",
    rangeNow:       d.rangeNow ? `${d.rangeNow} km` : "—",
    rangeMax:       d.rangeMax ? `${d.rangeMax} km` : "—",

    dtc:            d.dtcFault ? "Hibakódok észlelve" : "Nincs észlelt hibakód",

    creationDate:   d.creationDate || "—",
    reportId:       d.reportId || "—",

    moduleVMax:   d.moduleVMax   || "—",
    moduleVMin:   d.moduleVMin   || "—",
    moduleVAvg:   d.moduleVAvg   || "—",
    moduleVDelta: d.moduleVDelta || "—",
    moduleVStd:   d.moduleVStd   || "—",
    cellVMax:     d.cellVMax     || "—",
    cellVMin:     d.cellVMin     || "—",
    cellVAvg:     d.cellVAvg     || "—",
    cellVDelta:   d.cellVDelta   || "—",
    cellVStd:     d.cellVStd     || "—",

    tempMax: d.tempMax || "—",
    tempMin: d.tempMin || "—",
    tempAvg: d.tempAvg || "—",
  };
  root.querySelectorAll("[data-f]").forEach(el => {
    el.textContent = fields[el.dataset.f] ?? "—";
  });

  /* ---------- Gauge artwork (cropped from the source PDF) ---------- */
  if (d.gaugeImage) {
    root.querySelectorAll("[data-gauges-img]").forEach(img => {
      img.src = d.gaugeImage;
    });
  }

  /* ---------- Energy / range load bar ----------
     Generated bar: the fill and both triangle markers sit at the SOH
     boundary. The numeric value groups are the original PDF's own pixels,
     cropped and dropped onto the bar (see extractBarValueArtwork). */
  const fillPct = d.barFillPct == null ? 0 : d.barFillPct;
  root.querySelectorAll("[data-bar-fill]").forEach(el => { el.style.width = fillPct + "%"; });
  root.querySelectorAll("[data-bar-marker]").forEach(el => { el.style.left = fillPct + "%"; });
  if (d.barValues) {
    [["energy", d.barValues.energy], ["range", d.barValues.range]].forEach(([key, v]) => {
      root.querySelectorAll(`[data-barval="${key}"]`).forEach(img => {
        if (v) { img.src = v.url; img.style.aspectRatio = `${v.w} / ${v.h}`; }
        else   { img.remove(); }
      });
    });
  }

  /* ---------- DTC ---------- */
  if (d.dtcFault) {
    root.querySelectorAll("[data-dtc]").forEach(el => {
      el.classList.add("has-fault");
      el.querySelector(".dtc-icon").textContent = "!";
    });
  }

  /* ---------- Module / cell voltage table (kept on a single page) ----------
     Splitting the table across pages 2 and 3 looked like a "page break in
     the middle of the table" to the reader, so we keep all rows together
     on page 2. Page 3's voltage table tbody just stays empty. */
  const PAGE2_ROWS = Infinity;
  const allCellVals = d.moduleRows.flatMap(r => r.cellV);
  const cellMin = Math.min(...allCellVals);
  const cellMax = Math.max(...allCellVals);

  const tBody1 = root.querySelector('[data-table="voltage-1"] tbody');
  const tBody2 = root.querySelector('[data-table="voltage-2"] tbody');
  d.moduleRows.forEach((row, i) => {
    const target = i < PAGE2_ROWS ? tBody1 : tBody2;
    if (target) target.appendChild(buildModuleRow(row, cellMin, cellMax));
  });

  /* ---------- Temperature table (heat-mapped like the voltage table) ---------- */
  const tBodyT = root.querySelector('[data-table="temperature"] tbody');
  if (tBodyT && d.temperatureRows.length) {
    const tempVals = d.temperatureRows.map(r => r.temp);
    const tMin = Math.min(...tempVals);
    const tMax = Math.max(...tempVals);
    d.temperatureRows.forEach(row => tBodyT.appendChild(buildTempRow(row, tMin, tMax)));
  }

  /* ---------- Mount ---------- */
  preview.innerHTML = "";
  preview.appendChild(root);
  currentReport = root;
  previewW.hidden = false;
}

/* ---------- Module row builder ----------
   row = { moduleIdx, cellFrom, cellTo, moduleV, cellV: [...] }
   We render 8 cell columns total, padding empty cells with placeholder dashes. */
function buildModuleRow(row, cellMin, cellMax) {
  const tr = document.createElement("tr");

  const label = document.createElement("td");
  label.className = "row-label";
  label.textContent = `M${row.moduleIdx} (#${row.cellFrom}-#${row.cellTo})`;
  tr.appendChild(label);

  const mv = document.createElement("td");
  mv.className = "row-modval";
  mv.textContent = row.moduleV.toFixed(2) + " V";
  tr.appendChild(mv);

  for (let i = 0; i < 8; i++) {
    const td = document.createElement("td");
    td.className = "cell";
    const v = row.cellV[i];
    if (v == null) {
      td.textContent = "";
    } else {
      td.textContent = formatCellV(v) + " V";
      // Tint cell by where its value falls in the [min,max] band
      const tint = cellMax > cellMin ? (v - cellMin) / (cellMax - cellMin) : 0;
      td.style.setProperty("--tint", tint.toFixed(3));
    }
    tr.appendChild(td);
  }
  return tr;
}

function formatCellV(v) {
  // Match Autel's mix: show 3 decimals unless the value is exact to 2
  const s = v.toString();
  return s.includes(".") ? v.toString() : v.toFixed(2);
}

function buildTempRow(row, tMin, tMax) {
  const tr = document.createElement("tr");
  const label = document.createElement("td");
  label.className = "row-label";
  label.textContent = `M${row.moduleIdx} (T${row.sensorFrom}-T${row.sensorTo})`;
  tr.appendChild(label);
  for (let i = 0; i < 8; i++) {
    const td = document.createElement("td");
    if (i === 0) {
      td.className = "cell";
      td.textContent = `${row.temp} °C`;
      // If every module reads the same temperature, render the single tier
      // as a mid-strength tint so the heat-map isn't fully transparent.
      const tint = tMax > tMin ? (row.temp - tMin) / (tMax - tMin) : 0.5;
      td.style.setProperty("--tint", tint.toFixed(3));
    }
    tr.appendChild(td);
  }
  return tr;
}


