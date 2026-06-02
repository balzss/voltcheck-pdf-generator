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

    // The generator supports two Autel report layouts. We auto-detect which
    // one was uploaded and build the matching VoltCheck report:
    //   - "cara"    → SOH Blitz Test (CARA Approved Battery Health Check):
    //                 has an SOH health grade + gauges + energy/range bars.
    //   - "noncara" → Battery Pack Test Report: a raw pack diagnostic with NO
    //                 SOH grade. The report presents the pack data it does have
    //                 and simply omits the CARA badge (no approval is implied).
    const kind = detectKind(text);

    let data;
    if (kind === "noncara") {
      data = await parseNonCara(pdf);
      if (!data.moduleTemps.length && !data.moduleCells.length && !data.vehicle) {
        throw new Error(
          "Nem találhatóak a várt mezők a PDF-ben. Biztos, hogy ez egy Autel akkumulátor jelentés?"
        );
      }
      renderNonCara(data);
    } else if (kind === "cara") {
      data = parseReport(text);
      if (!data.soh && !data.vehicle) {
        throw new Error(
          "Nem találhatóak a várt mezők a PDF-ben. Biztos, hogy ez az Autel SOH Blitz Test jelentés?"
        );
      }
      data.gaugeImage = await extractGaugeArtwork(pdf);
      data.barValues  = await extractBarValueArtwork(pdf);
      renderReport(data);
    } else {
      throw new Error(
        "Ismeretlen PDF típus. Tölts fel egy Autel SOH Blitz Test vagy Battery Pack Test jelentést."
      );
    }

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
  const vinRaw = d.vin && d.vin !== "--" ? d.vin : "";
  const vin = vinRaw.replace(/[^\w-]/g, "");
  const parts = ["voltcheck", "jelentes", vin, stamp].filter(Boolean);
  return parts.join("-");
}

/* ============================================================
   Report-type detection
   The two Autel layouts carry distinctive title/section strings:
     - CARA "SOH Blitz Test" → "Battery Status Report" / "SOH Blitz Test",
       and an SOH percentage in the Pack Information block.
     - non-CARA "Battery Pack Test Report" → "Battery Pack Info" /
       "Cell Voltage Information" and no SOH percentage.
   ============================================================ */
function detectKind(text) {
  if (/SOH Blitz Test/i.test(text) || /Battery Status Report/i.test(text)) return "cara";
  if (/Battery Pack Test Report/i.test(text) ||
      /Cell Voltage Information/i.test(text) ||
      /Battery Pack Info/i.test(text)) return "noncara";
  // Fallback: a text SOH percentage only appears in the CARA layout.
  if (/SOH\*?:\s*[\d.]+\s*%/.test(text)) return "cara";
  return "unknown";
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


/* ============================================================
   ============================================================
   NON-CARA REPORT  ("Battery Pack Test Report")
   ============================================================
   A raw battery-pack diagnostic. Unlike the SOH Blitz Test it has no
   SOH health grade, no gauges and no energy/range bars, so it carries no
   CARA badge. The VoltCheck report mirrors the CARA layout's look &
   branding as closely as the data allows and presents what this test
   actually measures: pack-level stats, a per-module temperature table and
   a per-module cell-voltage table — all extracted faithfully, including
   Autel's own OK/Warning/Critical colour coding (read straight from the
   rendered pixels).
   ============================================================ */

/* Small Hungarian phrase map for the free-text "Results:" / "Maintenance
   advice:" strings. Known Autel phrases are translated; anything else is
   passed through unchanged so we never invent or drop information. */
const NC_PHRASES = [
  ["The temperatures of all battery modules are OK.", "Az összes akkumulátormodul hőmérséklete megfelelő."],
  ["The cell voltages of all battery modules are OK.", "Az összes akkumulátormodul cellafeszültsége megfelelő."],
  ["Check the thermal management system", "Ellenőrizze a hőkezelő rendszert"],
];
function ncTranslate(s) {
  if (!s) return s;
  let out = s;
  for (const [en, hu] of NC_PHRASES) out = out.split(en).join(hu);
  return out;
}

/* ============================================================
   parseNonCara — geometry-aware extraction
   Renders every page to a canvas (for warning-colour sampling) and walks
   the positioned text items. Field labels like "Rated Voltage: 342V" come
   as single items; the pack-info stats are split label/value pairs we join
   by row; the two tables are reconstructed from item coordinates.
   ============================================================ */
async function parseNonCara(pdf) {
  const SCALE = 3;
  const pageItems = [];   // per-page array of { s, x, y, p }
  const canvases  = [];   // per-page { ctx, viewport }

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;

    const content = await page.getTextContent();
    const items = content.items
      .filter(i => i.str && i.str.trim())
      .map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], p }));
    pageItems.push(items);
    canvases.push({ ctx, viewport });
  }

  const all = pageItems.flat();
  const flat = all.map(i => i.s).join("\n");

  // Reading-order ordinal so we can split items into the temperature
  // section vs. the cell-voltage section (module labels Mn appear in both).
  const ord = it => it.p * 100000 + (1000 - it.y);
  const cellTitle = all.find(i => /^Cell Voltage Information/.test(i.s));
  const cellTitleOrd = cellTitle ? ord(cellTitle) : Infinity;

  const m1 = (re, def = "") => { const m = flat.match(re); return m ? m[1].trim() : def; };

  // Sample the rendered colour of a value item → 'ok' | 'warn' | 'crit',
  // preserving Autel's own classification (black / orange / red).
  const classify = (it) => {
    const { ctx, viewport } = canvases[it.p - 1];
    const t = pdfjsLib.Util.transform(viewport.transform, [1, 0, 0, 1, it.x, it.y]);
    const cx = Math.round(t[4]), cy = Math.round(t[5]);
    const x0 = Math.max(0, cx - 4);
    const y0 = Math.max(0, cy - 16);
    const w  = Math.min(ctx.canvas.width  - x0, 90);
    const h  = Math.min(ctx.canvas.height - y0, 22);
    if (w <= 0 || h <= 0) return "ok";
    const data = ctx.getImageData(x0, y0, w, h).data;
    let red = 0, orange = 0, ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.min(r, g, b) > 170) continue;          // background / light grid
      ink++;
      if (r > 140 && g < 100 && b < 100) red++;        // Autel red  (#e30613)
      else if (r > 160 && g > 90 && b < 120 && g < r - 30) orange++; // amber
    }
    if (!ink) return "ok";
    if (red    / ink > 0.3) return "crit";
    if (orange / ink > 0.3) return "warn";
    return "ok";
  };

  // ---- Pack-info stats: pair a label item with the value on its row ----
  const rightValue = (label) => {
    if (!label) return null;
    const cands = all
      .filter(i => i.p === label.p && Math.abs(i.y - label.y) < 5 && i.x > label.x + 1)
      .sort((a, b) => a.x - b.x);
    return cands[0] || null;
  };
  const stat = (labelText) => {
    const label = all.find(i => i.s === labelText || i.s.replace(/\s+/g, " ") === labelText);
    const v = rightValue(label);
    return v ? { value: v.s, warn: classify(v) } : null;
  };

  // ---- Temperature table ----
  // Module labels Mn in the left column, before the cell-voltage section.
  const tempMods = all
    .filter(i => /^M\d+$/.test(i.s) && i.x < 70 && ord(i) < cellTitleOrd)
    .sort((a, b) => ord(a) - ord(b));
  const moduleTemps = tempMods.map(m => {
    const idx = parseInt(m.s.slice(1), 10);
    const totalV = all.find(i => i.p === m.p && Math.abs(i.y - m.y) < 4 &&
                                 i.x > 90 && i.x < 170 && /V$/.test(i.s));
    const sensor = all.find(i => i.p === m.p && i.y > m.y && i.y - m.y < 18 &&
                                 i.x > 330 && /^T\d+$/.test(i.s));
    const tempItem = all.find(i => i.p === m.p && i.y < m.y && m.y - i.y < 18 &&
                                   i.x > 330 && /°?C$/.test(i.s));
    return {
      idx,
      totalV: totalV ? totalV.s : "",
      sensor: sensor ? sensor.s : "",
      temp:   tempItem ? tempItem.s : "",
      warn:   tempItem ? classify(tempItem) : "ok",
    };
  });

  // ---- Cell-voltage table ----
  // Each module's cell values sit on the row just below its Mn label.
  const cellMods = all
    .filter(i => /^M\d+$/.test(i.s) && i.x < 70 && ord(i) >= cellTitleOrd)
    .sort((a, b) => ord(a) - ord(b));
  const moduleCells = cellMods.map(m => {
    const idx = parseInt(m.s.slice(1), 10);
    const vals = all
      .filter(i => i.p === m.p && i.y < m.y && m.y - i.y < 15 &&
                   /^[\d.]+V$/.test(i.s) && i.x > 80)
      .sort((a, b) => a.x - b.x)
      .map(v => ({ value: v.s, warn: classify(v) }));
    return { idx, cells: vals };
  }).filter(r => r.cells.length);

  // "Results:" lines (one per table) and the maintenance advice.
  const resultLines = all.filter(i => /^Results:/.test(i.s)).sort((a, b) => ord(a) - ord(b));

  return {
    // headline / vehicle
    title:        m1(/^(\d{4}\/[^\n]*?Battery Pack Test Report)/m) || "Akkumulátorcsomag teszt jelentés",
    vehicle:      (all.find(i => /^\d{4}\/.+\/.+\/.+/.test(i.s)) || {}).s || "",
    vin:          m1(/\nVIN:\s*(.+)/),
    batteryCode:  m1(/Battery Code:\s*(.+)/),
    maxStorable:  m1(/Maximum Storable Energy:\s*(.+)/),
    odometer:     m1(/Odometer Reading:\s*(.+)/),
    licensePlate: m1(/License Plate:\s*(.+)/),
    ratedVoltage: m1(/Rated Voltage:\s*(.+)/),
    ratedCapacity:m1(/Rated Capacity:\s*(.+)/),

    // customer / device / shop
    custName:     m1(/\nName:\s*(.+)/),
    scanner:      m1(/Scanner:\s*(.+)/),
    version:      m1(/Version:\s*(.+)/),
    serialNumber: m1(/Serial Number:\s*(.+)/),
    shopName:     m1(/Shop Name:\s*(.+)/),
    shopEmail:    m1(/Email:\s*(.+)/),
    shopAddress:  m1(/Address:\s*(.+)/),
    technician:   m1(/Technician:\s*(.+)/),
    reportId:     m1(/Report ID:\s*(.+)/),
    creationDate: m1(/Creation Date:\s*(.+)/),

    // pack-info stats
    totalVoltage: stat("Total voltage:"),
    totalCurrent: stat("Total current:"),
    cellVMax:     stat("Cell maximum voltage:"),
    cellVMin:     stat("Cell minimum voltage:"),
    tempMax:      stat("Maximum temperature:"),
    tempMin:      stat("Minimum temperature:"),
    voltageDelta: stat("Voltage delta:"),
    modules:      stat("Modules:"),
    soc:          stat("SOC"),

    maintenance:  m1(/(Maintenance advice:[^\n]*)/),
    tempResults:  resultLines[0] ? resultLines[0].s : "",
    cellResults:  resultLines[1] ? resultLines[1].s : "",

    moduleTemps,
    moduleCells,
  };
}

/* ============================================================
   Render (non-CARA)
   Content here is dynamic (variable module / cell counts), so instead of
   the fixed page templates the CARA report uses, we build pages on the fly
   and measure: append a block, and if it overflows the page's flow box
   (.nc-flow has a fixed height + overflow:hidden, so scrollHeight tells us),
   start a fresh page. Tables carry their header onto each continuation page.
   ============================================================ */

const NC_LOGO = `<svg class="vc-logo" viewBox="0 0 56 56" aria-hidden="true"><polygon points="30,4 14,32 26,32 22,52 42,22 30,22" fill="#00E676"/></svg>`;
const NC_LOGO_SM = `<svg class="vc-logo-sm" viewBox="0 0 56 56" aria-hidden="true"><polygon points="30,4 14,32 26,32 22,52 42,22 30,22" fill="#00E676"/></svg>`;

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

function ncFooter() {
  const f = el("footer", "rep-footer");
  f.innerHTML =
    `<div class="foot-accent"></div>` +
    `<div class="foot-left">${NC_LOGO_SM}<span>VoltCheck</span></div>` +
    `<div class="foot-mid"><a>voltcheck.hu</a></div>` +
    `<div class="foot-right" data-pageno></div>`;
  return f;
}

function ncHeader(d, full) {
  const v = s => (s && s !== "--") ? s : "—";
  if (full) {
    const h = el("header", "rep-header");
    h.innerHTML =
      `<div class="brand-left">${NC_LOGO}` +
        `<div class="brand-text"><span class="brand-name">VoltCheck<span class="brand-dot"></span></span>` +
        `<span class="brand-tag">Akkumulátor diagnosztika</span></div></div>` +
      `<div class="brand-right"><div class="autel-mark">AUTEL<sup>®</sup></div>` +
        `<div class="meta-right"><div>Jelentés azonosító: <b>${v(d.reportId)}</b></div>` +
        `<div>Készítés: <b>${v(d.creationDate)}</b></div></div></div>`;
    return h;
  }
  const h = el("header", "rep-header rep-header-sm");
  h.innerHTML =
    `<div class="brand-left">${NC_LOGO}` +
      `<div class="brand-text"><span class="brand-name">VoltCheck<span class="brand-dot"></span></span></div></div>` +
    `<div class="meta-right"><div><b>${v(d.vehicle)}</b></div>` +
      `<div>Készítés: <b>${v(d.creationDate)}</b></div>` +
      `<div>Jelentés azonosító: <b>${v(d.reportId)}</b></div></div>`;
  return h;
}

function ncMakePage(d, full) {
  const page = el("section", "page page-nc");
  const flow = el("div", "nc-flow");
  page.appendChild(flow);
  flow.appendChild(ncHeader(d, full));
  page.appendChild(ncFooter());
  return { el: page, flow };
}

/* key/value grid like the CARA report's .kv-grid; each pair may carry a
   warn class ('warn' | 'crit') that tints the value. */
function ncKvGrid(pairs) {
  const grid = el("div", "kv-grid");
  for (const p of pairs) {
    if (p == null) continue;
    const row = el("div");
    const span = el("span", null, p.label);
    const b = el("b", p.warn && p.warn !== "ok" ? `nc-${p.warn}` : null, p.value || "—");
    row.append(span, b);
    grid.appendChild(row);
  }
  return grid;
}

function ncBlock(title, ...children) {
  const block = el("section", "block");
  block.appendChild(el("h3", "block-title", title));
  for (const c of children) if (c) block.appendChild(c);
  return block;
}

function ncStat(s, fallback = "—") {
  return s && s.value ? { value: s.value, warn: s.warn } : { value: fallback };
}

function renderNonCara(d) {
  preview.innerHTML = "";
  const root = el("div", "report");
  preview.appendChild(root); // mount now so layout measurements are live
  // The preview wrapper must be visible (not display:none) DURING the build,
  // otherwise every clientHeight/scrollHeight reads 0 and pagination can't
  // detect overflow.
  previewW.hidden = false;

  const ctl = {
    pages: [],
    cur: null,
    newPage(full) { this.cur = ncMakePage(d, full); root.appendChild(this.cur.el); this.pages.push(this.cur); },
    overflow() { return this.cur.flow.scrollHeight > this.cur.flow.clientHeight + 1; },
    add(node) {
      this.cur.flow.appendChild(node);
      if (this.overflow()) { this.cur.flow.removeChild(node); this.newPage(false); this.cur.flow.appendChild(node); }
    },
  };

  ctl.newPage(true);

  // Title only — the report describes what it is (a pack diagnostic) and
  // simply omits the CARA badge; it does not enumerate what it is not.
  const head = el("div");
  head.appendChild(el("h1", "rep-title", "Akkumulátorcsomag-jelentés"));
  head.appendChild(el("h2", "rep-subtitle", "Akkumulátor pakk teszt"));
  ctl.add(head);

  // Vehicle / device info.
  const vv = s => (s && s !== "--") ? s : "—";
  ctl.add(ncBlock("Jármű adatok", ncKvGrid([
    { label: "Modell:", value: vv(d.vehicle) },
    { label: "Kilométeróra-állás:", value: vv(d.odometer) },
    { label: "Alvázszám:", value: vv(d.vin) },
    { label: "Rendszám:", value: vv(d.licensePlate) },
    { label: "Akkumulátor kód:", value: vv(d.batteryCode) },
    { label: "Névleges feszültség:", value: vv(d.ratedVoltage) },
    { label: "Max. tárolható energia:", value: vv(d.maxStorable) },
    { label: "Névleges kapacitás:", value: vv(d.ratedCapacity) },
  ])));
  ctl.add(ncBlock("Eszköz és ügyfél adatok", ncKvGrid([
    { label: "Szkenner:", value: vv(d.scanner) },
    { label: "Ügyfél:", value: vv(d.custName) },
    { label: "Szoftver verzió:", value: vv(d.version) },
    { label: "Technikus:", value: vv(d.technician) },
    { label: "Sorozatszám:", value: vv(d.serialNumber) },
    { label: "Műhely:", value: vv(d.shopName) },
  ])));

  // Pack info: stats grid + maintenance advice.
  const pack = el("section", "block");
  pack.appendChild(el("h3", "block-title", "Akkumulátorcsomag információk"));
  pack.appendChild(ncKvGrid([
    { label: "Teljes feszültség:", ...ncStat(d.totalVoltage) },
    { label: "Teljes áram:", ...ncStat(d.totalCurrent) },
    { label: "Max. cellafeszültség:", ...ncStat(d.cellVMax) },
    { label: "Min. cellafeszültség:", ...ncStat(d.cellVMin) },
    { label: "Maximum hőmérséklet:", ...ncStat(d.tempMax) },
    { label: "Minimum hőmérséklet:", ...ncStat(d.tempMin) },
    { label: "Feszültség különbség:", ...ncStat(d.voltageDelta) },
    { label: "Modulok száma:", ...ncStat(d.modules) },
    { label: "SOC:", ...ncStat(d.soc) },
  ]));
  if (d.maintenance) {
    const adv = el("p", "nc-advice");
    const txt = ncTranslate(d.maintenance.replace(/^Maintenance advice:\s*/i, ""));
    adv.innerHTML = `<b>Karbantartási javaslat:</b> ${txt}`;
    pack.appendChild(adv);
  }
  ctl.add(pack);

  // ---------- Temperature table (splittable across pages) ----------
  ncPlaceTable(ctl, {
    title: "Modul hőmérséklet információk",
    result: d.tempResults,
    head: ["Modul", "Teljes feszültség", "Hőmérséklet"],
    units: d.moduleTemps.map(r => ncTempRow(r)),
  });

  // ---------- Cell-voltage table ----------
  const maxCells = d.moduleCells.reduce((m, r) => Math.max(m, r.cells.length), 0);
  ncPlaceTable(ctl, {
    title: "Cellafeszültség információk",
    result: d.cellResults,
    legend: true,
    head: ["Modul", ...Array.from({ length: maxCells }, (_, i) => `#${i + 1}`)],
    units: d.moduleCells.map(r => ncCellRow(r, maxCells)),
  });

  // ---------- Sign-off form + disclaimer ----------
  ctl.add(ncForm());

  // Fill in page numbers now that we know the total.
  ctl.pages.forEach((pg, i) => {
    const s = pg.el.querySelector("[data-pageno]");
    if (s) s.textContent = `Oldal ${i + 1} / ${ctl.pages.length}`;
  });

  currentReport = root;
  previewW.hidden = false;
}

/* Build a table section (title pill + optional results line + legend +
   table head) and flow its row "units" across pages, repeating the header. */
function ncPlaceTable(ctl, { title, result, legend, head, units }) {
  const buildShell = (continued) => {
    const wrap = el("section", "block");
    wrap.appendChild(el("h3", "block-title", continued ? `${title} (folytatás)` : title));
    if (!continued && result) {
      const r = el("p", "nc-result");
      r.innerHTML = `<b>Eredmény:</b> ${ncTranslate(result.replace(/^Results:\s*/i, ""))}`;
      wrap.appendChild(r);
    }
    if (!continued && legend) wrap.appendChild(ncLegend());
    const table = el("table", "mod-table");
    const thead = el("thead");
    const tr = el("tr");
    head.forEach((h, i) => {
      const th = el("th", null, h);
      if (i === 0) th.classList.add("nc-th-mod");
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    const tbody = el("tbody");
    table.append(thead, tbody);
    wrap.appendChild(table);
    return { wrap, tbody };
  };

  let shell = buildShell(false);
  ctl.add(shell.wrap);
  for (const unit of units) {
    shell.tbody.appendChild(unit);
    if (ctl.overflow()) {
      shell.tbody.removeChild(unit);
      ctl.newPage(false);
      shell = buildShell(true);
      ctl.cur.flow.appendChild(shell.wrap);
      shell.tbody.appendChild(unit);
    }
  }
}

function ncLegend() {
  const l = el("div", "nc-legend");
  l.innerHTML =
    `<span><i class="nc-dot nc-dot-ok"></i>OK</span>` +
    `<span><i class="nc-dot nc-dot-warn"></i>Figyelmeztetés</span>` +
    `<span><i class="nc-dot nc-dot-crit"></i>Azonnali beavatkozás szükséges</span>`;
  return l;
}

function ncTempRow(r) {
  const tr = el("tr");
  tr.appendChild(el("td", "row-label", `M${r.idx}`));
  tr.appendChild(el("td", "row-modval", r.totalV || "—"));
  const td = el("td", "nc-temp-cell");
  if (r.sensor) td.appendChild(el("span", "nc-sensor", r.sensor));
  const b = el("b", r.warn && r.warn !== "ok" ? `nc-${r.warn}` : null, r.temp || "—");
  td.appendChild(b);
  tr.appendChild(td);
  return tr;
}

function ncCellRow(r, maxCells) {
  const tr = el("tr");
  tr.appendChild(el("td", "row-label", `M${r.idx}`));
  for (let i = 0; i < maxCells; i++) {
    const c = r.cells[i];
    const td = el("td", "cell");
    if (c) {
      td.textContent = c.value;
      if (c.warn && c.warn !== "ok") td.classList.add(`nc-${c.warn}`);
    }
    tr.appendChild(td);
  }
  return tr;
}

function ncForm() {
  const block = el("section", "block disclaimer");
  block.appendChild(el("h3", "block-title", "Aláírás és jogi nyilatkozat"));
  const form = el("div", "nc-form");
  form.innerHTML =
    `<div><span>Ügyfél neve:</span><span class="nc-line"></span></div>` +
    `<div><span>Technikus:</span><span class="nc-line"></span></div>` +
    `<div><span>Dátum:</span><span class="nc-line"></span></div>`;
  block.appendChild(form);
  const ol = el("ol");
  ol.innerHTML =
    `<li>Ez a jelentés akkumulátorcsomag-diagnosztikai mérés, amely a jármű akkumulátorcsomagjának ` +
    `mért feszültség- és hőmérsékletadatait tartalmazza a vizsgálat időpontjában.</li>` +
    `<li>A jelentésben szereplő adatok a jármű gyártójának BMS adataiból vagy azokból származtatott ` +
    `adatokból származnak, és csak tájékoztató jellegűek. A VoltCheck nem vállal garanciát az adatok ` +
    `hitelességére, pontosságára vagy teljességére, sem az akkumulátor tényleges fizikai állapotára.</li>` +
    `<li>Ez a jelentés csak a jármű vizsgálatához és karbantartásához nyújt tájékoztatást. A VoltCheck ` +
    `nem vállal felelősséget az adatok használatából eredő balesetekért, vagyoni károkért vagy ` +
    `személyi sérülésekért.</li>`;
  block.appendChild(ol);
  block.appendChild(el("p", "form-note", "Megjegyzés: Kérjük, mentsen egy másolatot a jelentésről saját nyilvántartásához."));
  return block;
}


