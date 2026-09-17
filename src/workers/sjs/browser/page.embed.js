/**
 * Page-side half of the SpreadJS browser runtime. Served over HTTP and loaded
 * with `<script src="/runtime.js">` — deliberately NOT injected through
 * `Runtime.evaluate`:
 *
 *   Wrapping script source in a function (which any evaluate wrapper does) makes
 *   top-level declarations function-local. The SpreadJS UMD builds publish `GC`
 *   as a global `var`, so evaluating a bundle inside a wrapper leaves
 *   `typeof GC === 'undefined'` for everything afterwards — with NO exception
 *   thrown. An external script keeps every declaration on the real page global.
 *
 * The page never touches a filesystem. Byte transfers go over the loopback
 * server Node runs: reads by `fetch`, writes by `fetch(POST)`. Node supplies
 * fully-formed URLs (it owns path authorization and the host-route capability);
 * sandboxed user code only ever gets workspace-confined `/ws` URLs, which Node
 * re-authorizes per request.
 *
 * `window.__BUNDLES` is prepended by Node before this source is served.
 */

/** Per-process prefix injected by the worker: the SpreadJS UMD file URLs. */
const bundleUrls = window.__BUNDLES || [];

/** Errors that must surface as a specific worker error code. */
function fail(code, message) {
  const error = new Error(message);
  error.sjsCode = code;
  return error;
}

/** Readable message from an arbitrary thrown value (mirrors the worker's util). */
function messageOf(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) return error.message;
  return String(error);
}

/** Io-module errors carry their text in `errorMessage` (or only in `stack`). */
function ioErrorMessage(error) {
  if (error && typeof error === 'object') {
    const candidate = error.errorMessage || error.message;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    if (typeof error.stack === 'string' && error.stack.length > 0) return error.stack;
  }
  return messageOf(error);
}

/** One-line description of a value, for diagnosing blob shapes. */
function describeValue(value) {
  if (typeof value === 'string') return 'string(' + value.length + ')';
  if (typeof value !== 'object' || value === null) return String(value);
  const name = value.constructor && value.constructor.name ? value.constructor.name : 'object';
  return name + '{' + Object.keys(value).slice(0, 8).join(',') + '}';
}

// --------------------------------------------------------------------- fetch

/** GET a Node-supplied URL as bytes. */
async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw await failureFrom(response);
  return new Uint8Array(await response.arrayBuffer());
}

/** GET a Node-supplied URL as text. */
async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw await failureFrom(response);
  return await response.text();
}

/** POST bytes to a Node-supplied URL (Node writes them, atomically). */
async function postBytes(url, body) {
  const response = await fetch(url, { method: 'POST', body: body });
  if (!response.ok) throw await failureFrom(response);
  return response.status;
}

/** Turn a failed HTTP response into a coded error (Node decides the code). */
async function failureFrom(response) {
  let code = 'SJS_WORKER_FAILED';
  let message = 'HTTP ' + response.status + ' ' + response.url;
  try {
    const payload = await response.json();
    if (payload && typeof payload.code === 'string') code = payload.code;
    if (payload && typeof payload.message === 'string') message = payload.message;
  } catch (error) {
    /* not a classified failure: keep the generic message */
  }
  return fail(code, message);
}

// ------------------------------------------------------------------- guards

/**
 * Guard the Worksheet class against SpreadJS's two silent-data-loss traps.
 *
 * 1. A fresh worksheet is 200 rows x 20 columns, and `setValue`/`setFormula`/
 *    `setArray` beyond those bounds are SILENTLY DROPPED — no throw, no warning,
 *    and a read-back of the early rows still looks correct. Writing more rows
 *    than the default is ordinary usage, so the guards grow the sheet to fit the
 *    write instead (and throw loudly past the engine's own ceiling, which is
 *    still far better than dropping data).
 * 2. Excel and SpreadJS both reject `: \ / ? * [ ]` in a sheet name, but the
 *    engine reports only "Not supported exception", which a model cannot act on.
 *    The name setter validates up front and names the offending characters.
 *
 * Installed once per page, on the prototype, so code that reaches a sheet
 * through `spread.getSheet(i)` is covered as well as the `sheet()` helper.
 */
const MAX_ROWS = 1048576;
const MAX_COLUMNS = 16384;
// Grow past the target so a loop that writes N rows does not resize once per
// row: a per-row bump measured ~15x slower than a single upsizing on a 20k-row
// write, and pushed it past the 60s operation budget.
const GROWTH_STEP_ROWS = 512;
const GROWTH_STEP_COLUMNS = 64;

/** Next row/column count to resize to: enough for the index, then rounded up to
 * a doubling-or-step boundary so filling N rows resizes O(log N) times. */
function nextExtent(current, requested, ceiling, step) {
  return Math.min(ceiling, Math.max(requested + 1, current * 2, current + step));
}

/** Reject sheet names Excel itself refuses, with a message that says why. */
function assertUsableSheetName(value) {
  if (typeof value !== 'string') {
    throw fail('SJS_SHEET_NAME_INVALID', 'sheet name must be a string, got ' + typeof value);
  }
  const illegal = [...new Set([...value].filter((character) => ':\\/?*[]'.includes(character)))];
  if (illegal.length > 0) {
    throw fail(
      'SJS_SHEET_NAME_INVALID',
      'sheet name ' + JSON.stringify(value) + ' contains character(s) Excel does not allow in a sheet name: ' +
        illegal.join(' ') + ' (also avoid : \\ / ? * [ ])',
    );
  }
  if (value.length === 0) throw fail('SJS_SHEET_NAME_INVALID', 'sheet name must not be empty');
  if (value.length > 31) {
    throw fail('SJS_SHEET_NAME_INVALID', 'sheet name ' + JSON.stringify(value) + ' is ' + value.length + ' characters; Excel allows at most 31');
  }
  if (value.startsWith("'") || value.endsWith("'")) {
    throw fail('SJS_SHEET_NAME_INVALID', 'sheet name ' + JSON.stringify(value) + ' must not start or end with an apostrophe');
  }
}

function installWorksheetGuards() {
  const prototype = GC && GC.Spread && GC.Spread.Sheets && GC.Spread.Sheets.Worksheet && GC.Spread.Sheets.Worksheet.prototype;
  if (!prototype) return;
  if (prototype.__sjsGuardsInstalled === true) return;
  try {
    Object.defineProperty(prototype, '__sjsGuardsInstalled', { value: true, enumerable: false });
  } catch (error) {
    /* a frozen prototype would defeat the guards entirely; let the write fail loudly */
  }

  const grow = (sheet, row, col) => {
    if (typeof row === 'number' && isFinite(row) && row >= 0) {
      const rows = sheet.getRowCount();
      if (row >= rows) {
        if (row >= MAX_ROWS) throw fail('SJS_SHEET_LIMIT_EXCEEDED', 'row ' + row + ' is past the spreadsheet limit of ' + MAX_ROWS + ' rows');
        sheet.setRowCount(nextExtent(rows, row, MAX_ROWS, GROWTH_STEP_ROWS));
      }
    }
    if (typeof col === 'number' && isFinite(col) && col >= 0) {
      const columns = sheet.getColumnCount();
      if (col >= columns) {
        if (col >= MAX_COLUMNS) throw fail('SJS_SHEET_LIMIT_EXCEEDED', 'column ' + col + ' is past the spreadsheet limit of ' + MAX_COLUMNS + ' columns');
        sheet.setColumnCount(nextExtent(columns, col, MAX_COLUMNS, GROWTH_STEP_COLUMNS));
      }
    }
  };

  for (const method of ['setValue', 'setFormula']) {
    const original = prototype[method];
    if (typeof original !== 'function') continue;
    prototype[method] = function guarded(row, col, ...rest) {
      grow(this, row, col);
      return original.call(this, row, col, ...rest);
    };
  }

  const originalSetArray = prototype.setArray;
  if (typeof originalSetArray === 'function') {
    prototype.setArray = function guardedSetArray(row, col, values, ...rest) {
      const height = Array.isArray(values) ? values.length : 0;
      const width = Array.isArray(values) && Array.isArray(values[0]) ? values[0].length : 1;
      if (height > 0 && width > 0) {
        grow(this, (typeof row === 'number' ? row : 0) + height - 1, (typeof col === 'number' ? col : 0) + width - 1);
      }
      return originalSetArray.call(this, row, col, values, ...rest);
    };
  }

  const originalName = prototype.name;
  if (typeof originalName === 'function') {
    // `name()` is a getter and `name(value)` the setter, told apart by the
    // argument COUNT — so forward the real arguments verbatim. Calling
    // `original.call(this, undefined)` would look like a set-to-undefined and the
    // engine rejects it with "Not supported exception".
    prototype.name = function guardedName(...args) {
      if (args.length > 0) assertUsableSheetName(args[0]);
      return originalName.apply(this, args);
    };
  }
}

// -------------------------------------------------------------- used ranges

/**
 * Read the content used range (data + formula) of a sheet, or null when empty.
 *
 * CSV text comes only from cell values and formula results, so the union of the
 * `data` and `formula` used ranges is the precise bound — the `all` bitmask
 * instead reports colCount -1 on xlsx round-trips (it counts layout extent),
 * which would make a CSV export whole-width or, worse, silently drop to a single
 * cell. `getUsedRange(UsedRangeType.all)` additionally THROWS from inside
 * spread-sheets-charts, so `.all` must never be used here.
 */
function usedRangeOf(sheet) {
  try {
    const type = GC.Spread.Sheets.UsedRangeType;
    const range = sheet.getUsedRange(type.data | type.formula);
    if (range === null || range === undefined) return null;
    // SpreadJS exposes the origin column as `.col` / `.colCount`, not `.column`.
    const { row, rowCount, col, colCount } = range;
    if (typeof row !== 'number' || typeof col !== 'number') return null;
    // A negative count is SpreadJS's "extends to the end of the sheet" sentinel.
    // Never treat it as an empty range (silent single-cell export); clamp.
    const bounded = (count, origin, sheetCount) => {
      const n = typeof count === 'number' && isFinite(count) ? count : NaN;
      const span = isNaN(n) || n < 1 ? sheetCount - origin : n;
      return span >= 1 ? span : undefined;
    };
    const rows = bounded(rowCount, row, sheet.getRowCount());
    const columns = bounded(colCount, col, sheet.getColumnCount());
    if (rows === undefined || columns === undefined) return null;
    return { row: row, rowCount: rows, col: col, colCount: columns };
  } catch (error) {
    return null;
  }
}

/** Model-readable workbook summary (sheet metadata + used ranges). */
function summarize() {
  const workbook = currentWorkbook();
  const sheets = [];
  for (let i = 0; i < workbook.getSheetCount(); i++) {
    const sheet = workbook.getSheet(i);
    if (sheet === null || sheet === undefined) continue;
    const used = usedRangeOf(sheet);
    const entry = { name: sheet.name(), rowCount: sheet.getRowCount(), columnCount: sheet.getColumnCount() };
    if (used !== null) entry.usedRange = used;
    sheets.push(entry);
  }
  const active = workbook.getActiveSheet();
  return { sheets: sheets, activeSheet: active ? active.name() : undefined };
}

// -------------------------------------------------------------------- batch

/**
 * Put the workbook in batch mode for the duration of a script. Repainting the
 * grid, dispatching change events and recalculating dependents after every write
 * costs real time on a fill: a 20k-row script with formulas measured 3412ms
 * unbatched, 1808ms with paint+events suspended, and 959ms with calculation
 * suspended too — a 3.6x spread. The batch is undone before the workbook is
 * persisted, so the stored file always carries fully calculated values.
 *
 * Consequence to know about: while calculation is suspended, reading a formula's
 * value returns `null`. That matches how bulk work is actually written — fill
 * first, read afterwards — but a script that wants to verify mid-flight must
 * `spread.resumeCalcService()` before it reads (one recalculation, cheap).
 */
function beginBatch(workbook) {
  const can = (method) => typeof workbook[method] === 'function';
  const state = { paint: can('suspendPaint'), events: can('suspendEvent'), calc: can('suspendCalcService') };
  try {
    if (state.paint) workbook.suspendPaint();
    if (state.events) workbook.suspendEvent();
    if (state.calc) workbook.suspendCalcService();
  } catch (error) {
    /* a workbook that refuses batching still runs; it is only slower */
  }
  return state;
}

/** Undo beginBatch, resuming in the reverse order of the suspends. */
function endBatch(workbook, suspended) {
  try {
    if (suspended.calc) workbook.resumeCalcService();
    if (suspended.events) workbook.resumeEvent();
    if (suspended.paint) workbook.resumePaint();
  } catch (error) {
    /* resuming is best-effort inside a one-shot process that exits next */
  }
}

// ---------------------------------------------------------------- workbook

let workbook = null;

function currentWorkbook() {
  if (workbook === null) throw fail('SJS_WORKER_FAILED', 'no workbook is loaded in this page');
  return workbook;
}

/** Size and clear the host element, so a workbook is measured on the box it renders into. */
function prepareHost(width, height) {
  const host = document.getElementById('host');
  host.style.width = (width === undefined ? 1400 : width) + 'px';
  host.style.height = (height === undefined ? 900 : height) + 'px';
  host.innerHTML = '';
  return host;
}

/** Construct a workbook bound to the host. Constructor-time binding matters:
 *  the engine measures the host then and builds its layout from it. */
function newWorkbook(host, sheetCount) {
  if (workbook !== null) {
    try {
      workbook.destroy();
    } catch (error) {
      /* best-effort: the page is one-shot */
    }
  }
  workbook = sheetCount === undefined
    ? new GC.Spread.Sheets.Workbook(host)
    : new GC.Spread.Sheets.Workbook(host, { sheetCount: sheetCount });
  return workbook;
}

/** Wait for the engine to finish painting into its canvases. */
function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  });
}

// --------------------------------------------------------------- imports

/** Import raw file bytes into a fresh workbook through the io module. */
async function importBlobInto(target, bytes, name, fileType) {
  try {
    await new Promise((resolve, reject) => {
      const file = new File([bytes], name || 'in.xlsx');
      target.import(file, () => resolve(true), (error) => reject(fail('SJS_IMPORT_FAILED', 'spread.import failed: ' + ioErrorMessage(error))), { fileType: fileType });
    });
  } catch (error) {
    if (error && error.sjsCode) throw error;
    throw fail('SJS_IMPORT_FAILED', 'spread.import failed: ' + messageOf(error));
  }
}

/** Export a workbook to a Blob through the io module. */
function exportToBlob(target, options) {
  return new Promise((resolve, reject) => {
    try {
      target.export(
        (blob) => {
          if (!blob || typeof blob.arrayBuffer !== 'function') {
            reject(fail('SJS_EXPORT_FAILED', 'export blob has no arrayBuffer(): ' + describeValue(blob)));
            return;
          }
          resolve(blob);
        },
        (error) => reject(fail('SJS_EXPORT_FAILED', 'spread.export failed: ' + ioErrorMessage(error))),
        options,
      );
    } catch (error) {
      reject(fail('SJS_EXPORT_FAILED', 'spread.export threw: ' + messageOf(error)));
    }
  });
}

/** Export a workbook to a PDF Blob (fonts must be registered first). */
function savePdfToBlob(target, options) {
  return new Promise((resolve, reject) => {
    try {
      target.savePDF(
        (blob) => {
          if (!blob || typeof blob.arrayBuffer !== 'function') {
            reject(fail('SJS_PDF_EXPORT_FAILED', 'pdf blob has no arrayBuffer(): ' + describeValue(blob)));
            return;
          }
          resolve(blob);
        },
        (error) => reject(fail('SJS_PDF_EXPORT_FAILED', 'savePDF failed: ' + ioErrorMessage(error))),
        options,
      );
    } catch (error) {
      reject(fail('SJS_PDF_EXPORT_FAILED', 'savePDF threw: ' + messageOf(error)));
    }
  });
}

/**
 * Register the PDF fonts Node discovered, by fetching each one over HTTP.
 *
 * The constraint that made fonts.ts necessary does NOT go away in a browser:
 * `savePDF` is a pure-JS PDF writer inside SpreadJS, and it embeds only fonts
 * registered here. An unregistered CJK cell silently produces a "hollow" PDF
 * (Times-Roman, no FontFile). What DOES change is the mechanism: the browser
 * fetches the TTF directly, so no fs, no Buffer slicing and no cross-realm
 * ArrayBuffer repair.
 *
 * @param fonts [{ family, url, fallback }] — `fallback` marks the CJK-preferred face.
 */
async function registerPdfFonts(fonts) {
  const manager = GC.Spread && GC.Spread.Sheets && GC.Spread.Sheets.PDF && GC.Spread.Sheets.PDF.PDFFontsManager;
  if (manager === undefined || manager === null) {
    throw fail('SJS_PDF_UNAVAILABLE', 'PDF 功能不可用：未加载 spread-sheets-pdf（其必须先于 pdf 加载 print）。');
  }
  const registered = [];
  let fallbackBuffer = null;
  for (const font of fonts) {
    let buffer;
    try {
      buffer = await fetchBytes(font.url);
    } catch (error) {
      continue; // a font that cannot be fetched never blocks the export
    }
    try {
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      manager.registerFont(font.family, { normal: arrayBuffer });
      registered.push(font.family);
      if (font.fallback === true && fallbackBuffer === null) fallbackBuffer = arrayBuffer;
    } catch (error) {
      /* one unusable font never blocks the export */
    }
  }
  if (registered.length === 0) {
    throw fail(
      'SJS_PDF_FONT_UNAVAILABLE',
      '找不到可嵌入 PDF 的字体：需要至少一个 .ttf/.otf（不支持 .ttc）。' +
        '可用环境变量 GC_SJS_PDF_FONT_DIRS 指向含 simhei.ttf / arial.ttf 等的目录，避免导出空壳 PDF。',
    );
  }
  if (fallbackBuffer !== null) manager.fallbackFont = function () { return fallbackBuffer; };
  return registered;
}

// ------------------------------------------------------------------- shots

/** Fallbacks for geometry SpreadJS does not report. */
const DEFAULT_COLUMN_WIDTH = 62;
const DEFAULT_ROW_HEIGHT = 20;
const DEFAULT_ROW_HEADER_WIDTH = 40;
const DEFAULT_COLUMN_HEADER_HEIGHT = 20;
/** Measure-pass host size; only needed to build layout, never measured from. */
const MEASURE_WIDTH = 900;
const MEASURE_HEIGHT = 600;

/**
 * Right/bottom edges of every floating object whose geometry reads as finite.
 * Charts, shapes, pictures and slicers each paint at their OWN worksheet
 * coordinates and routinely sit outside the used cell range, so a canvas sized
 * to the cells alone would crop them out of the snapshot.
 */
function floatingObjectExtent(sheet) {
  let right = 0;
  let bottom = 0;
  for (const key of ['charts', 'shapes', 'pictures', 'slicers']) {
    const collection = sheet[key];
    if (!collection || typeof collection.all !== 'function') continue;
    let objects;
    try {
      objects = collection.all() || [];
    } catch (error) {
      continue;
    }
    for (const object of objects) {
      try {
        const x = Number(object.x());
        const y = Number(object.y());
        const width = Number(object.width());
        const height = Number(object.height());
        if (![x, y, width, height].every((value) => isFinite(value))) continue;
        right = Math.max(right, x + width);
        bottom = Math.max(bottom, y + height);
      } catch (error) {
        /* a floating object with different geometry accessors: ignore it */
      }
    }
  }
  return { right: right, bottom: bottom };
}

/**
 * Pixel size of the used cell block including the row/column headers the canvas
 * paints. A width/height the model does not report falls back to the sheet
 * default. Hidden rows/columns report zero, so they already contribute nothing.
 */
function cellExtent(sheet, used) {
  const area = GC.Spread && GC.Spread.Sheets ? GC.Spread.Sheets.SheetArea : undefined;
  const hidden = (method, index) => {
    try {
      return typeof sheet[method] === 'function' && sheet[method](index) === false;
    } catch (error) {
      return false;
    }
  };
  const size = (method, index, fallback) => {
    try {
      const value = sheet[method](index, area ? area.viewport : undefined);
      return typeof value === 'number' && isFinite(value) && value > 0 ? value : fallback;
    } catch (error) {
      return fallback;
    }
  };

  let columns = 0;
  for (let col = used.col; col < used.col + used.colCount; col++) {
    if (hidden('getColumnVisible', col)) continue;
    columns += size('getColumnWidth', col, DEFAULT_COLUMN_WIDTH);
  }
  let rows = 0;
  for (let row = used.row; row < used.row + used.rowCount; row++) {
    if (hidden('getRowVisible', row)) continue;
    rows += size('getRowHeight', row, DEFAULT_ROW_HEIGHT);
  }

  let rowHeaderWidth = DEFAULT_ROW_HEADER_WIDTH;
  try {
    const value = sheet.getColumnWidth(0, area ? area.rowHeader : undefined);
    if (typeof value === 'number' && isFinite(value) && value >= 0) rowHeaderWidth = value;
  } catch (error) {
    /* keep the default */
  }
  let columnHeaderHeight = DEFAULT_COLUMN_HEADER_HEIGHT;
  try {
    const value = sheet.getRowHeight(0, area ? area.colHeader : undefined);
    if (typeof value === 'number' && isFinite(value) && value >= 0) columnHeaderHeight = value;
  } catch (error) {
    /* keep the default */
  }

  return { width: rowHeaderWidth + columns, height: columnHeaderHeight + rows };
}

/**
 * Measure the content box of the active sheet WITHOUT rendering it.
 *
 * The box comes from the model — the used range's column widths and row heights
 * plus the headers — not from a rendered cell rect. A rendered measurement only
 * answers for cells inside the host's own viewport: once content outgrew it,
 * `getCellRect` returned an unusable rect and the whole screenshot failed, so
 * any sheet larger than the probe host could not be captured at all. Model
 * arithmetic has no viewport and is exact.
 */
function measureContent(json) {
  const host = document.createElement('div');
  host.id = 'sjs-measure';
  host.setAttribute('style', 'position:absolute;left:-20000px;top:0;width:' + MEASURE_WIDTH + 'px;height:' + MEASURE_HEIGHT + 'px;');
  document.body.appendChild(host);
  let probe = null;
  try {
    probe = new GC.Spread.Sheets.Workbook(host, { sheetCount: 0 });
    probe.fromJSON(json);
    const sheet = probe.getActiveSheet();
    const sheetName = sheet && typeof sheet.name === 'function' ? String(sheet.name() || '') : '';
    if (!sheet) return { used: null, contentWidth: 0, contentHeight: 0, sheetName: sheetName };
    const used = usedRangeOf(sheet);
    const cells = used === null ? { width: 0, height: 0 } : cellExtent(sheet, used);
    const floating = floatingObjectExtent(sheet);
    return {
      used: used,
      contentWidth: Math.max(cells.width, floating.right),
      contentHeight: Math.max(cells.height, floating.bottom),
      sheetName: sheetName,
    };
  } catch (error) {
    throw fail('SJS_PNG_RENDER_FAILED', '无法测量工作表内容（' + messageOf(error) + '）');
  } finally {
    try {
      if (probe) probe.destroy();
    } catch (error) {
      /* best-effort cleanup inside a one-shot page */
    }
    host.remove();
  }
}

/**
 * Pick the canvas that actually holds the sheet.
 *
 * There are ~11 canvases. "Largest alone" picks a 0-height overlay, "darkest
 * alone" picks the solid opaque background layer, and "most colourful" picks the
 * sheet-tab strip. The reliable rule is: the largest canvas whose computed
 * `z-index` is `auto` — SpreadJS stacks its overlay set at z-index 900, so the
 * content layer is the one left in normal flow.
 */
function contentCanvas(host) {
  const candidates = [];
  for (const canvas of host.querySelectorAll('canvas')) {
    let zIndex = 'auto';
    try {
      zIndex = getComputedStyle(canvas).zIndex;
    } catch (error) {
      zIndex = 'auto';
    }
    candidates.push({ canvas: canvas, area: canvas.width * canvas.height, zIndex: zIndex });
  }
  candidates.sort((a, b) => b.area - a.area);
  for (const candidate of candidates) {
    if (candidate.area > 10000 && candidate.zIndex === 'auto') return candidate.canvas;
  }
  return null;
}

// -------------------------------------------------------------- screenshot

/**
 * Render the active sheet of an .ssjson file and hand the PNG back to Node.
 *
 * The host is sized so that the canvas — the host minus the scrollbar the engine
 * reserves — is exactly the measured content plus a small pad, which is what
 * makes the reported width comparable with the model's own arithmetic.
 */
async function screenshotPng(sourceUrl, outputUrl, maxWidth, maxHeight, pad, scrollbar, emptyWidth, emptyHeight) {
  const text = await fetchText(sourceUrl);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw fail('SJS_INVALID_SSJSON', 'workbook file is not valid .ssjson JSON: ' + messageOf(error));
  }
  // Parse fresh per pass so the two workbooks never share a mutated object.
  const jsonFor = () => JSON.parse(JSON.stringify(parsed));

  const measure = measureContent(jsonFor());
  const contentWidth = Math.ceil(measure.contentWidth);
  const contentHeight = Math.ceil(measure.contentHeight);
  const clipped = contentWidth > maxWidth - scrollbar - pad || contentHeight > maxHeight - scrollbar - pad;
  const floorWidth = measure.used === null ? emptyWidth : 300;
  const floorHeight = measure.used === null ? emptyHeight : 200;
  const hostWidth = Math.min(maxWidth, Math.max(floorWidth, contentWidth + scrollbar + pad));
  const hostHeight = Math.min(maxHeight, Math.max(floorHeight, contentHeight + scrollbar + pad));

  const host = prepareHost(hostWidth, hostHeight);
  let target = null;
  let png = null;
  let canvasWidth = 0;
  let canvasHeight = 0;
  try {
    target = newWorkbook(host, 0);
    target.fromJSON(jsonFor());
    if (typeof target.refresh === 'function') target.refresh();
    await nextPaint();
    const canvas = contentCanvas(host);
    if (canvas === null) throw fail('SJS_PNG_RENDER_FAILED', '渲染后找不到画布');
    canvasWidth = canvas.width;
    canvasHeight = canvas.height;
    png = await new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (blob === null || blob === undefined) reject(fail('SJS_PNG_RENDER_FAILED', 'canvas 编码 PNG 失败'));
          else resolve(blob);
        }, 'image/png');
      } catch (error) {
        reject(fail('SJS_PNG_RENDER_FAILED', 'canvas 编码 PNG 失败: ' + messageOf(error)));
      }
    });
    if (png.size === 0) throw fail('SJS_PNG_RENDER_FAILED', 'canvas 输出为空 PNG');
    await postBytes(outputUrl, png);
  } catch (error) {
    if (error && error.sjsCode) throw error;
    throw fail('SJS_PNG_RENDER_FAILED', '截图渲染失败: ' + messageOf(error));
  }

  // The font actually in play. In a real browser there is no forced font (the
  // jsdom runtime flattened every cell to one registered CJK face so glyphs would
  // rasterize at all); report the sheet's own default font, which is what the
  // engine renders with, and fall back to the host's resolved font stack.
  let font = '';
  try {
    const sheet = target.getActiveSheet();
    const style = sheet && typeof sheet.getDefaultStyle === 'function' ? sheet.getDefaultStyle() : null;
    if (style && typeof style.font === 'string' && style.font.length > 0) font = style.font;
  } catch (error) {
    /* keep the fallback */
  }
  if (font.length === 0) {
    try {
      font = getComputedStyle(host).fontFamily || 'browser default';
    } catch (error) {
      font = 'browser default';
    }
  }

  return {
    bytes: png.size,
    width: canvasWidth,
    height: canvasHeight,
    clipped: clipped,
    sheet: measure.sheetName,
    used: measure.used,
    font: font,
  };
}

// ------------------------------------------------------------------- bridge

window.__H = {
  /** Load every UMD bundle in order and install the prototype guards. */
  boot: async function () {
    for (const url of bundleUrls) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => { resolve(true); };
        script.onerror = () => { reject(new Error('bundle failed to load: ' + url)); };
        document.head.appendChild(script);
      });
    }
    if (typeof window.GC === 'undefined') throw new Error('the SpreadJS bundles loaded but defined no GC global');
    installWorksheetGuards();
    return { bundles: bundleUrls.length };
  },

  /** Create a blank workbook and persist it as .ssjson. */
  createWorkbook: async function (targetUrl, width, height) {
    const host = prepareHost(width, height);
    const target = newWorkbook(host);
    if (target.getActiveSheet() === null || target.getActiveSheet() === undefined) target.addSheet(0);
    const text = JSON.stringify(target.toJSON());
    await postBytes(targetUrl, text);
    return { bytes: text.length };
  },

  /** Load an .ssjson document into a workbook bound to the host. */
  loadWorkbook: async function (sourceUrl, width, height) {
    const text = await fetchText(sourceUrl);
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw fail('SJS_INVALID_SSJSON', 'workbook file is not valid .ssjson JSON: ' + messageOf(error));
    }
    const host = prepareHost(width, height);
    const target = newWorkbook(host);
    try {
      target.fromJSON(json);
    } catch (error) {
      throw fail('SJS_INVALID_SSJSON', 'cannot parse workbook: ' + messageOf(error));
    }
    return { bytes: text.length };
  },

  /** Serialize the loaded workbook and let Node write it atomically. */
  persist: async function (targetUrl) {
    const text = JSON.stringify(currentWorkbook().toJSON());
    await postBytes(targetUrl, text);
    return { bytes: text.length };
  },

  summarize: async function () {
    return summarize();
  },

  /** Import an xlsx/csv file's bytes into a fresh workbook. */
  importFile: async function (sourceUrl, name, fileType) {
    const bytes = await fetchBytes(sourceUrl);
    const host = prepareHost(1400, 900);
    const target = newWorkbook(host);
    // CSV import lands in the active sheet; make sure a fresh workbook has one
    // (a host-bound workbook may construct with no default sheet).
    if (target.getActiveSheet() === null || target.getActiveSheet() === undefined) target.addSheet(0);
    const token = GC.Spread.Sheets.FileType[fileType];
    await importBlobInto(target, bytes, name, token);
    return { bytes: bytes.length };
  },

  /** Export the loaded workbook; Node writes the bytes. */
  exportFile: async function (outputUrl, format) {
    const target = currentWorkbook();
    const fileTypes = GC.Spread.Sheets.FileType;
    if (format === 'xlsx') {
      const blob = await exportToBlob(target, { fileType: fileTypes.excel });
      await postBytes(outputUrl, blob);
      return { bytes: blob.size };
    }
    if (format === 'csv') {
      const active = target.getActiveSheet();
      if (active === null || active === undefined) {
        throw fail('SJS_SHEET_NOT_FOUND', 'workbook has no active sheet to export');
      }
      const used = usedRangeOf(active);
      const options = used === null
        ? { fileType: fileTypes.csv, range: { sheetIndex: target.getActiveSheetIndex(), row: 0, column: 0, rowCount: 1, columnCount: 1 } }
        : { fileType: fileTypes.csv, range: { row: used.row, rowCount: used.rowCount, column: used.col, columnCount: used.colCount, sheetIndex: target.getActiveSheetIndex() } };
      const blob = await exportToBlob(target, options);
      await postBytes(outputUrl, blob);
      const result = { bytes: blob.size, sheet: active.name() };
      if (used !== null) result.usedRange = { row: used.row, rowCount: used.rowCount, column: used.col, columnCount: used.colCount };
      return result;
    }
    throw fail('SJS_BAD_REQUEST', 'unsupported export format ' + format);
  },

  /** Register fonts, then export the loaded workbook to PDF. */
  exportPdf: async function (outputUrl, fonts, title) {
    const registered = await registerPdfFonts(fonts);
    const blob = await savePdfToBlob(currentWorkbook(), { title: title });
    await postBytes(outputUrl, blob);
    return { bytes: blob.size, fonts: registered };
  },

  /** Render the loaded workbook's active sheet to PDF (a "visual" snapshot). */
  screenshotPdf: async function (outputUrl, fonts, title) {
    const registered = await registerPdfFonts(fonts);
    const blob = await savePdfToBlob(currentWorkbook(), { title: title });
    await postBytes(outputUrl, blob);
    return { bytes: blob.size, fonts: registered };
  },

  /** PNG of the active sheet of an .ssjson file (see screenshotPng). */
  screenshotPng: screenshotPng,

  /**
   * Run user code, persist the workbook, then materialize the return value.
   *
   * Order matters and is inherited from the jsdom worker: the file is written
   * FIRST, so a script whose return value cannot be serialized still leaves its
   * edits on disk — and the failure is reported as a serialization problem rather
   * than a lost write.
   */
  runCode: async function (code, persistUrl) {
    const spread = currentWorkbook();
    installWorksheetGuards();

    const sheet = function (name) {
      // Resolve by scanning indices rather than through the by-name dictionary:
      // fromJSON does not reliably register that dictionary, so getSheet(name)
      // can return undefined for a sheet that exists. getActiveSheet() is reliable.
      if (name === undefined || name === null || name.length === 0) {
        const active = spread.getActiveSheet();
        if (active !== undefined && active !== null) return active;
        throw fail('SJS_SHEET_NOT_FOUND', 'workbook has no active sheet');
      }
      for (let i = 0; i < spread.getSheetCount(); i++) {
        const candidate = spread.getSheet(i);
        if (candidate !== undefined && candidate !== null && typeof candidate.name === 'function' && candidate.name() === name) {
          return candidate;
        }
      }
      throw fail('SJS_SHEET_NOT_FOUND', 'sheet not found: ' + JSON.stringify(name));
    };

    const io = {
      readText: async function (path) {
        return await fetchText('/ws?p=' + encodeURIComponent(path));
      },
      writeText: async function (path, text) {
        await postBytes('/ws?p=' + encodeURIComponent(path), text);
      },
      readBytes: async function (path) {
        return Array.from(await fetchBytes('/ws?p=' + encodeURIComponent(path)));
      },
    };

    const sandboxConsole = {
      log: function (...args) { console.log.apply(console, args); },
      info: function (...args) { console.info.apply(console, args); },
      warn: function (...args) { console.warn.apply(console, args); },
      error: function (...args) { console.error.apply(console, args); },
    };

    let fn;
    try {
      fn = new Function('spread', 'workbook', 'GC', 'sheet', 'io', 'console', 'snapshot', 'return (async () => {\n' + code + '\n})();');
    } catch (error) {
      throw fail('SJS_SCRIPT_ERROR', 'syntax error: ' + messageOf(error));
    }

    const suspended = beginBatch(spread);
    let returned;
    try {
      try {
        returned = await fn(spread, spread, GC, sheet, io, sandboxConsole, summarize);
      } catch (error) {
        if (error && error.sjsCode) throw error;
        throw fail('SJS_SCRIPT_ERROR', 'script failed: ' + messageOf(error));
      }
    } finally {
      endBatch(spread, suspended);
    }

    // Persist with the batch released, so the stored file carries fully
    // calculated values.
    const text = JSON.stringify(spread.toJSON());
    await postBytes(persistUrl, text);

    if (returned === undefined) return { json: JSON.stringify(summarize()) };
    let json;
    try {
      json = JSON.parse(JSON.stringify(returned));
    } catch (error) {
      throw fail('SJS_NON_SERIALIZABLE_RESULT', 'value is not JSON-serializable (cyclic or non-plain object); return plain data such as arrays of numbers/strings');
    }
    if (json === undefined) {
      throw fail('SJS_NON_SERIALIZABLE_RESULT', 'value is not JSON-serializable (cyclic or non-plain object); return plain data such as arrays of numbers/strings');
    }
    const serialized = JSON.stringify(json);
    if (serialized.length > 200000) {
      throw fail('SJS_RESULT_TOO_LARGE', 'script returned more than 200_000 characters; return a compact summary or call snapshot()');
    }
    return { json: serialized, persisted: text.length };
  },
};
