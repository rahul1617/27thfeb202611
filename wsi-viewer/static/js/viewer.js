'use strict';

// ─── State ───────────────────────────────────────────────
const state = {
    viewer: null, currentSlide: null,
    tool: 'pan', heatmapOn: false,
    heatmapData: null,
    heatmapLoading: false,
    layersVisible: true,
    cells: [], cellType: 'tumor', cellCount: 0,
    isDrawing: false, drawPoints: [],
    // polygon
    polyPoints: [],   // [{x,y}] in screen px
    polyActive: false,
    // pending annotation waiting for mini-toolbar
    pendingAnnot: null,   // { type, points/bounds, center:{x,y} }
    measureStart: null,
    evidencePack: [],
    annotations: [],
    undoStack: [],   // array of annotation snapshots
    redoStack: [],
    labMessages: [],
    attachedToMessage: [],
    priority: 'routine',
    autoSaveTimer: null,
};

// Annotation label → color map
const ANNOT_COLORS = {
    Tumor: '#f43f5e',
    Invasion: '#f97316',
    Necrosis: '#b45309',
    Margin: '#3b82f6',
    LVI: '#8b5cf6',
    Artifact: '#9ca3af',
    Other: '#10b981',
};
function annotColor(label) { return ANNOT_COLORS[label] || '#818cf8'; }


const TILE_URL = (fn, lv, col, row) =>
    `/api/slide/${encodeURIComponent(fn)}/tile/${lv}/${col}/${row}`;

// ─── DOM ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const qs = (sel, ctx = document) => ctx.querySelector(sel);

// ─── View Router ─────────────────────────────────────────
function switchView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    const view = $(`view${capitalize(name)}`);
    const tab = $(`tab${capitalize(name)}`);
    if (view) view.classList.add('active');
    if (tab) tab.classList.add('active');
    if (name === 'evidence') renderEvidenceView();
    if (name === 'report') syncReportGallery();
}

document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
});
$('openLabFromReport')?.addEventListener('click', () => switchView('lab'));

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── Toast ────────────────────────────────────────────────
let toastTimer;
function toast(msg, dur = 3000) {
    const t = $('toast'), m = $('toastMsg');
    t.classList.remove('hidden');
    m.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), dur);
}

// ─── Upload ───────────────────────────────────────────────
const uploadZone = $('uploadZone');
const fileInput = $('fileInput');

['dragenter', 'dragover'].forEach(e => uploadZone.addEventListener(e, ev => { ev.preventDefault(); uploadZone.classList.add('drag-over'); }));
['dragleave', 'drop'].forEach(e => uploadZone.addEventListener(e, ev => { ev.preventDefault(); uploadZone.classList.remove('drag-over'); }));
uploadZone.addEventListener('drop', ev => { if (ev.dataTransfer.files[0]) handleUpload(ev.dataTransfer.files[0]); });
uploadZone.addEventListener('click', () => fileInput.click());
$('uploadLink').addEventListener('click', ev => { ev.stopPropagation(); fileInput.click(); });
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleUpload(fileInput.files[0]); });
$('placeholderUploadBtn').addEventListener('click', () => fileInput.click());

function handleUpload(file) {
    const allowed = ['svs', 'tif', 'tiff', 'ndpi', 'vms', 'vmu', 'scn', 'mrxs', 'bif'];
    if (!allowed.includes(file.name.split('.').pop().toLowerCase())) { toast('❌ Unsupported file type'); return; }

    $('uploadProgress').classList.remove('hidden');
    $('progressFilename').textContent = file.name;
    $('progressPct').textContent = '0%';
    $('progressFill').style.width = '0%';
    $('progressStatus').textContent = 'Uploading…';

    const fd = new FormData();
    fd.append('file', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) {
            const p = Math.round(e.loaded / e.total * 100);
            $('progressFill').style.width = p + '%';
            $('progressPct').textContent = p + '%';
            $('progressStatus').textContent = p < 100 ? `${fmtBytes(e.loaded)} / ${fmtBytes(e.total)}` : 'Processing…';
        }
    });
    xhr.addEventListener('load', () => {
        $('uploadProgress').classList.add('hidden');
        if (xhr.status === 200) {
            const r = JSON.parse(xhr.responseText);
            if (r.success) { toast(`✅ ${file.name} uploaded`); refreshSlideList(); loadSlide(r.metadata); }
            else toast(`❌ ${r.error}`);
        } else toast('❌ Upload failed');
        fileInput.value = '';
    });
    xhr.addEventListener('error', () => { $('uploadProgress').classList.add('hidden'); toast('❌ Network error'); });
    xhr.send(fd);
}

// ─── Slide List ───────────────────────────────────────────
async function refreshSlideList() {
    const btn = $('refreshBtn');
    btn.classList.add('spinning');
    try {
        const r = await fetch('/api/slides');
        const d = await r.json();
        renderSlideList(d.slides || []);
        renderThumbStrip(d.slides || []);
    } catch { toast('❌ Could not load slides'); }
    finally { btn.classList.remove('spinning'); }
}

function renderSlideList(slides) {
    const list = $('slideList');
    if (!slides.length) { list.innerHTML = '<div class="empty-state">No slides uploaded yet</div>'; return; }
    list.innerHTML = slides.map(s => `
    <div class="slide-item ${state.currentSlide?.filename === s.filename ? 'active' : ''}" data-fn="${esc(s.filename)}">
      <div class="slide-thumb-ph"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.5 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V7.5L14.5 2z"/><circle cx="10" cy="13" r="2"/></svg></div>
      <div><div class="slide-name" title="${esc(s.filename)}">${esc(s.filename)}</div><div class="slide-size">${fmtBytes(s.size)}</div></div>
    </div>`).join('');
    list.querySelectorAll('.slide-item').forEach(el => {
        el.addEventListener('click', async () => {
            try {
                const r = await fetch(`/api/slide/${encodeURIComponent(el.dataset.fn)}/metadata`);
                if (!r.ok) throw new Error();
                loadSlide(await r.json());
            } catch { toast('❌ Could not load slide'); }
        });
        const ph = el.querySelector('.slide-thumb-ph');
        const img = new Image(); img.className = 'slide-thumb';
        img.src = `/api/slide/${encodeURIComponent(el.dataset.fn)}/thumbnail?width=80&height=80`;
        img.onload = () => ph.replaceWith(img);
    });
}

function renderThumbStrip(slides) {
    const strip = $('thumbStrip');
    if (!slides.length) { strip.innerHTML = '<div class="thumb-empty">No slides</div>'; return; }
    strip.innerHTML = slides.map(s => `<img class="thumb-item" src="/api/slide/${encodeURIComponent(s.filename)}/thumbnail?width=108&height=72" data-fn="${esc(s.filename)}" title="${esc(s.filename)}" />`).join('');
    strip.querySelectorAll('.thumb-item').forEach(img => {
        img.addEventListener('click', async () => {
            try {
                const r = await fetch(`/api/slide/${encodeURIComponent(img.dataset.fn)}/metadata`);
                loadSlide(await r.json());
            } catch { }
        });
    });
}

// ─── Load Slide ───────────────────────────────────────────
function loadSlide(meta) {
    state.currentSlide = meta;
    $('viewerPlaceholder').classList.add('hidden');
    $('osdViewer').style.display = 'block';
    $('currentSlideName') && ($('currentSlideName').textContent = meta.filename);

    document.querySelectorAll('.slide-item').forEach(el =>
        el.classList.toggle('active', el.dataset.fn === meta.filename));
    document.querySelectorAll('.thumb-item').forEach(el =>
        el.classList.toggle('active', el.dataset.fn === meta.filename));

    renderMeta(meta);

    if (state.viewer) { state.viewer.destroy(); state.viewer = null; }

    state.viewer = OpenSeadragon({
        id: 'osdViewer',
        tileSources: (() => {
            state.currentTileSource = {
                height: meta.height, width: meta.width,
                tileSize: meta.tile_size, overlap: meta.overlap,
                minLevel: 0, maxLevel: meta.dz_levels - 1,
                getTileUrl: (lv, x, y) => TILE_URL(meta.filename, lv, x, y),
            };
            return state.currentTileSource;
        })(),
        showNavigator: false, showNavigationControl: false,
        animationTime: 0.4, blendTime: 0.1,
        constrainDuringPan: false, maxZoomPixelRatio: 4,
        minZoomImageRatio: 0.8, visibilityRatio: 0.5,
        zoomPerScroll: 1.4,
        gestureSettingsMouse: { clickToZoom: false },
        background: '#08090f',
    });

    state.viewer.addHandler('zoom', throttle(onZoom, 80));
    state.viewer.addHandler('pan', throttle(() => { updateMinimap(); renderRealHeatmap(); }, 80));
    state.viewer.addHandler('animation', renderRealHeatmap);   // smooth reprojection during inertia
    state.viewer.addHandler('open', () => {
        $('minimap').style.opacity = '1';
        $('scaleBar').classList.remove('hidden');
        loadMinimap(meta.filename);
        updateMagLabel();
    });
    state.viewer.addHandler('canvas-move', onMouseMove);
    state.viewer.addHandler('canvas-click', onCanvasClick);

    resizeOverlays();
    window.addEventListener('resize', resizeOverlays);
    // Always fetch heatmap data silently to power AI Insights
    state.heatmapData = null;
    fetchAndRenderHeatmap(true);

    toast(`📂 ${meta.filename}`);
}

function renderMeta(meta) {
    $('metaPanel').classList.remove('hidden');
    const grid = $('metaGrid');
    const mpp = meta.mpp_x ? `${parseFloat(meta.mpp_x).toFixed(4)} µm/px` : '—';
    const rows = [
        ['Dimensions', `${meta.width?.toLocaleString()} × ${meta.height?.toLocaleString()}`, true],
        ['Vendor', meta.vendor || '—', false],
        ['Resolution', mpp, false],
        ['Objective', meta.objective_power ? `${meta.objective_power}×` : '—', false],
        ['Zoom Levels', meta.level_count, false],
    ];
    grid.innerHTML = rows.map(([k, v, h]) =>
        `<div class="meta-row"><span class="meta-key">${k}</span><span class="meta-val${h ? ' accent' : ''}">${v}</span></div>`).join('');
}

// ─── Zoom / Pan ───────────────────────────────────────────
function onZoom() {
    if (!state.viewer) return;
    const z = state.viewer.viewport.getZoom(true);
    const iz = state.viewer.viewport.viewportToImageZoom(z);
    $('zoomLevel').textContent = `${iz.toFixed(1)}×`;
    updateMagLabel();
    updateScaleBar();
    updateMinimap();
    resizeOverlays();
}

function updateMagLabel() {
    if (!state.viewer) return;
    const z = state.viewer.viewport.getZoom(true);
    const iz = state.viewer.viewport.viewportToImageZoom(z);
    const mag = Math.round(iz * 20); // rough: base 20x
    $('magLabel').textContent = `Magnification ~${mag}× | Heatmap ${state.heatmapOn ? 'ON' : 'OFF'}`;
}

// ─── Mouse / Coordinates ─────────────────────────────────
function onMouseMove(e) {
    if (!state.viewer) return;
    try {
        const pt = state.viewer.viewport.viewerElementToImageCoordinates(e.position);
        $('coordsBar').textContent = `x: ${Math.round(pt.x).toLocaleString()} · y: ${Math.round(pt.y).toLocaleString()}`;
    } catch { }

    if (state.tool === 'freehand' && state.isDrawing) {
        state.drawPoints.push(e.position);
        redrawAnnotCanvas();
    }
    if (state.tool === 'measure' && state.measureStart) {
        drawMeasureLine(state.measureStart, e.position);
    }
}

function onCanvasClick(e) {
    if (state.tool === 'cell') handleCellClick(e);
    if (state.tool === 'measure') handleMeasureClick(e);
    if (state.tool === 'roi') handleROIClick(e);
    if (state.tool === 'snapshot') openSnapshotDialog();
    if (state.tool === 'label') handleLabelClick(e);
}

// ─── Tools ──────────────────────────────────────────────────
document.querySelectorAll('.tool-icon[data-tool], .imm-tool[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

const DRAWING_TOOLS = ['roi', 'polygon', 'freehand', 'label'];

function setTool(tool) {
    // Cancel poly in progress on tool switch
    if (['polygon', 'area', 'ruler'].includes(state.tool) && !['polygon', 'area', 'ruler'].includes(tool)) cancelPolygon();

    state.tool = tool;
    document.querySelectorAll('.tool-icon[data-tool], .imm-tool[data-tool]').forEach(b =>
        b.classList.toggle('active', b.dataset.tool === tool));

    $('cellPanel').classList.toggle('hidden', tool !== 'cell');
    $('measureDisplay').classList.toggle('hidden', tool !== 'measure');

    // Annotation canvas: dynamically enable pointerEvents for tools that require dragging on it
    $('annotCanvas').style.pointerEvents = ['freehand', 'polygon', 'area', 'ruler'].includes(tool) ? 'auto' : 'none';

    // Cursor shape on OSD viewer element
    const osd = $('osdViewer');
    if (tool === 'pan') osd.style.cursor = '';
    else if (tool === 'cell') osd.style.cursor = 'cell';
    else osd.style.cursor = 'crosshair';

    if (state.viewer) state.viewer.setMouseNavEnabled(tool === 'pan');

    // Freehand events
    const cv = $('annotCanvas');
    cv.removeEventListener('mousedown', startDraw);
    cv.removeEventListener('mousemove', continueDraw);
    cv.removeEventListener('mouseup', endDraw);
    if (tool === 'freehand') {
        cv.addEventListener('mousedown', startDraw);
        cv.addEventListener('mousemove', continueDraw);
        cv.addEventListener('mouseup', endDraw);
    }

    // Multi-point shapes
    cv.removeEventListener('dblclick', closePolygon);
    if (['polygon', 'area', 'ruler'].includes(tool)) cv.addEventListener('dblclick', closePolygon);

    // ROI: reset start point
    roiStart = null;
}

$('toolSnapshot')?.addEventListener('click', openSnapshotDialog);
$('btnSnapHero')?.addEventListener('click', openSnapshotDialog);
$('toolHeatmap')?.addEventListener('click', toggleHeatmap);
$('btnHome2')?.addEventListener('click', () => { if (state.viewer) state.viewer.viewport.goHome(true); });
$('toolLayerVis')?.addEventListener('click', toggleLayers);

// ─── Undo / Redo ────────────────────────────────────────────
function pushUndoState() {
    state.undoStack.push(JSON.stringify(state.annotations));
    state.redoStack = [];
    syncUndoRedoButtons();
}
function syncUndoRedoButtons() {
    if ($('btnUndo')) $('btnUndo').disabled = state.undoStack.length === 0;
    if ($('btnRedo')) $('btnRedo').disabled = state.redoStack.length === 0;
}
function doUndo() {
    if (!state.undoStack.length) return;
    state.redoStack.push(JSON.stringify(state.annotations));
    state.annotations = JSON.parse(state.undoStack.pop());
    redrawAllAnnotations();
    syncUndoRedoButtons();
    toast('↩ Undo');
}
function doRedo() {
    if (!state.redoStack.length) return;
    state.undoStack.push(JSON.stringify(state.annotations));
    state.annotations = JSON.parse(state.redoStack.pop());
    redrawAllAnnotations();
    syncUndoRedoButtons();
    toast('↪ Redo');
}
$('btnUndo')?.addEventListener('click', doUndo);
$('btnRedo')?.addEventListener('click', doRedo);
syncUndoRedoButtons();

// ─── Layer Visibility ────────────────────────────────────────
function toggleLayers() {
    state.layersVisible = !state.layersVisible;
    $('toolLayerVis')?.classList.toggle('layers-hidden', !state.layersVisible);
    const cv = $('annotCanvas');
    cv.style.opacity = state.layersVisible ? '1' : '0';
    // also hide cell layer and pins
    $('cellLayer').style.opacity = state.layersVisible ? '1' : '0';
    document.querySelectorAll('.annot-pin').forEach(p => p.style.opacity = state.layersVisible ? '1' : '0');
    toast(state.layersVisible ? '👁 Layers visible' : '👁 Layers hidden');
}

// ─── Freehand Drawing ────────────────────────────────────────
function startDraw(e) {
    state.isDrawing = true;
    state.drawPoints = [{ x: e.offsetX, y: e.offsetY }];
}
function continueDraw(e) {
    if (!state.isDrawing) return;
    state.drawPoints.push({ x: e.offsetX, y: e.offsetY });
    redrawAnnotCanvas();
}
function endDraw() {
    if (!state.isDrawing) return;
    state.isDrawing = false;
    if (state.drawPoints.length > 3) {
        const pts = [...state.drawPoints];
        const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        state.drawPoints = [];
        clearAnnotCanvas();
        showAnnotMiniToolbar(cx, cy, () => ({
            type: 'freehand', points: pts,
        }));
    } else {
        state.drawPoints = [];
    }
}

function redrawAnnotCanvas() {
    const cv = $('annotCanvas');
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!state.drawPoints.length) return;
    ctx.strokeStyle = '#818cf8';
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    state.drawPoints.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();
}

// ─── Polygon Tool ────────────────────────────────────────────
const annotCanvas = $('annotCanvas');
annotCanvas.addEventListener('click', polyClickCapture);

function polyClickCapture(e) {
    if (!['polygon', 'area', 'ruler'].includes(state.tool)) return;
    state.polyPoints.push({ x: e.offsetX, y: e.offsetY });
    drawPolyPreview();
}

function drawPolyPreview() {
    const pts = state.polyPoints;
    if (!pts.length) return;
    const cv = $('annotCanvas');
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (state.tool === 'ruler') ctx.strokeStyle = '#10b981';
    else if (state.tool === 'area') ctx.strokeStyle = '#f59e0b';
    else ctx.strokeStyle = '#6366f1';

    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    if (state.tool !== 'ruler' && pts.length > 2) ctx.lineTo(pts[0].x, pts[0].y);
    ctx.stroke();
    ctx.setLineDash([]);
    // vertex dots
    pts.forEach(p => {
        if (state.tool === 'ruler') ctx.fillStyle = '#34d399';
        else if (state.tool === 'area') ctx.fillStyle = '#fbbf24';
        else ctx.fillStyle = '#818cf8';
        ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
    });
}

function closePolygon(e) {
    e.preventDefault();
    const minPts = state.tool === 'ruler' ? 2 : 3;
    if (state.polyPoints.length < minPts) { toast('❌ Need more points'); return; }
    const pts = [...state.polyPoints];
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const type = state.tool;

    let labelAdd = '';
    try {
        if (type === 'ruler') {
            let imgPx = 0;
            for (let i = 0; i < pts.length - 1; i++) {
                const p1 = state.viewer.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(pts[i].x, pts[i].y));
                const p2 = state.viewer.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(pts[i + 1].x, pts[i + 1].y));
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                imgPx += Math.sqrt(dx * dx + dy * dy);
            }
            labelAdd = `L: ${Math.round(imgPx)}px`;
            if (state.currentSlide?.mpp_x) {
                const um = imgPx * parseFloat(state.currentSlide.mpp_x);
                labelAdd += ` (${um >= 1000 ? (um / 1000).toFixed(2) + 'mm' : Math.round(um) + 'µm'})`;
            }
        } else if (type === 'area') {
            let imgArea = 0;
            const imgPts = pts.map(p => state.viewer.viewport.viewerElementToImageCoordinates(new OpenSeadragon.Point(p.x, p.y)));
            for (let i = 0; i < imgPts.length; i++) {
                const j = (i + 1) % imgPts.length;
                imgArea += imgPts[i].x * imgPts[j].y - imgPts[j].x * imgPts[i].y;
            }
            imgArea = Math.abs(imgArea / 2);
            labelAdd = `A: ${Math.round(imgArea)}px²`;
            if (state.currentSlide?.mpp_x) {
                const um2 = imgArea * Math.pow(parseFloat(state.currentSlide.mpp_x), 2);
                labelAdd += ` (${um2 >= 1e6 ? (um2 / 1e6).toFixed(2) + 'mm²' : Math.round(um2) + 'µm²'})`;
            }
        }
    } catch (err) { }

    cancelPolygon();
    showAnnotMiniToolbar(cx, cy, () => ({ type: type, points: pts, dims: labelAdd }));
}

function cancelPolygon() {
    state.polyPoints = [];
    clearAnnotCanvas();
}

// ─── ROI Tool ────────────────────────────────────────────────
let roiStart = null;
function handleROIClick(e) {
    if (!roiStart) {
        try { roiStart = { screen: e.position, img: state.viewer.viewport.viewerElementToImageCoordinates(e.position) }; }
        catch { }
        toast('ROI: click second corner…');
    } else {
        try {
            const endImg = state.viewer.viewport.viewerElementToImageCoordinates(e.position);
            const w = Math.abs(Math.round(endImg.x - roiStart.img.x));
            const h = Math.abs(Math.round(endImg.y - roiStart.img.y));
            const cx = (roiStart.screen.x + e.position.x) / 2;
            const cy = (roiStart.screen.y + e.position.y) / 2;
            const s = roiStart, en = e.position;
            const imgStart = roiStart.img, imgEnd = endImg;
            roiStart = null;
            clearAnnotCanvas();
            showAnnotMiniToolbar(cx, cy, () => ({
                type: 'roi',
                start: imgStart, end: imgEnd,
                screenStart: s.screen, screenEnd: en,
                dims: `${w}×${h}px`
            }));
        } catch { }
    }
}

// ─── Label Pin Tool ──────────────────────────────────────────
function handleLabelClick(e) {
    const cx = e.position.x, cy = e.position.y;
    showAnnotMiniToolbar(cx, cy - 40, () => ({
        type: 'label',
        screenX: cx, screenY: cy
    }));
}

// ─── Annotation Mini-Toolbar ─────────────────────────────────
let _pendingAnnotBuilder = null;

function showAnnotMiniToolbar(cx, cy, buildFn) {
    _pendingAnnotBuilder = buildFn;

    const isImm = document.body.classList.contains('immersive-active');
    const toolbar = isImm ? $('immAnnotMiniToolbar') : $('annotMiniToolbar');
    const area = $('osdArea');

    toolbar.classList.remove('hidden');

    // Position near the annotation – keep within bounds
    const areaW = area.clientWidth, areaH = area.clientHeight;
    const tbW = 250, tbH = 140;
    let left = cx + 10, top = cy - 60;
    if (left + tbW > areaW) left = cx - tbW - 10;
    if (top < 8) top = 8;
    if (top + tbH > areaH) top = areaH - tbH - 8;

    // In immersive mode the toolbar might be relative to the overlay
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';

    // Focus label select
    setTimeout(() => (isImm ? $('immAnnotLabel') : $('annotLabel')).focus(), 50);
}

function saveAnnotFromToolbar() {
    if (!_pendingAnnotBuilder) return;
    const isImm = document.body.classList.contains('immersive-active');
    const label = (isImm ? $('immAnnotLabel') : $('annotLabel')).value;
    const severity = (isImm ? $('immAnnotSeverity') : $('annotSeverity')).value;
    const notes = (isImm ? $('immAnnotNotes') : $('annotNotes')).value.trim();

    pushUndoState();
    const base = _pendingAnnotBuilder();
    const annot = { ...base, label, severity, notes, id: Date.now() };
    state.annotations.push(annot);
    redrawAllAnnotations();
    addAnnotHistory(label, severity);

    // Auto-snap?
    if ($('autoSnapToggle').checked) {
        captureSnapshotSilent(`Auto: ${label}`);
    }

    dismissAnnotMiniToolbar();
    toast(`✅ ${label} — ${severity} saved`);
    setTool('pan');
}

function dismissAnnotMiniToolbar() {
    $('annotMiniToolbar').classList.add('hidden');
    $('annotNotes').value = '';
    const immAnnotTb = $('immAnnotMiniToolbar');
    if (immAnnotTb) {
        immAnnotTb.classList.add('hidden');
        $('immAnnotNotes').value = '';
    }
    _pendingAnnotBuilder = null;
    clearAnnotCanvas();
}

$('annotSaveBtn').addEventListener('click', saveAnnotFromToolbar);
$('annotCancelBtn').addEventListener('click', () => { dismissAnnotMiniToolbar(); setTool('pan'); });
$('immAnnotSaveBtn')?.addEventListener('click', saveAnnotFromToolbar);
$('immAnnotCancelBtn')?.addEventListener('click', () => { dismissAnnotMiniToolbar(); setTool('pan'); });

// Allow Enter in notes to save
$('annotNotes').addEventListener('keydown', e => { if (e.key === 'Enter') saveAnnotFromToolbar(); });
$('immAnnotNotes')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveAnnotFromToolbar(); });

// ─── Redraw all saved annotations ────────────────────────────
function redrawAllAnnotations() {
    const cv = $('annotCanvas');
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);

    // Remove old label pins
    document.querySelectorAll('.annot-pin').forEach(p => p.remove());

    state.annotations.forEach(a => {
        const col = annotColor(a.label);
        ctx.strokeStyle = col;
        ctx.fillStyle = col + '33'; // 20% fill
        ctx.lineWidth = 2;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';

        if (a.type === 'freehand' && a.points) {
            ctx.beginPath();
            a.points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
            ctx.stroke();
        } else if (['polygon', 'area', 'ruler'].includes(a.type) && a.points) {
            ctx.beginPath();
            a.points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));

            if (a.type === 'ruler') {
                ctx.setLineDash([5, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
                a.points.forEach(p => {
                    ctx.fillStyle = col;
                    ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill();
                });
            } else {
                ctx.closePath();
                if (a.type === 'area') ctx.fillStyle = col + '55'; // darker fill for area highlight
                ctx.fill(); ctx.stroke();
            }

            // Draw dims if present
            if (a.dims) {
                const cx = a.points.reduce((s, p) => s + p.x, 0) / a.points.length;
                const cy = a.points.reduce((s, p) => s + p.y, 0) / a.points.length;
                ctx.fillStyle = col;
                ctx.font = 'bold 11px Inter, sans-serif';
                ctx.fillText(a.dims, cx, cy);
            }
        } else if (a.type === 'roi' && a.screenStart) {
            const x = Math.min(a.screenStart.x, a.screenEnd.x);
            const y = Math.min(a.screenStart.y, a.screenEnd.y);
            const w = Math.abs(a.screenEnd.x - a.screenStart.x);
            const h = Math.abs(a.screenEnd.y - a.screenStart.y);
            ctx.fillRect(x, y, w, h);
            ctx.strokeRect(x, y, w, h);
            // Label text
            ctx.fillStyle = col;
            ctx.font = '10px IBM Plex Mono, monospace';
            ctx.fillText(a.label, x + 4, y + 12);
        } else if (a.type === 'label' && a.screenX !== undefined) {
            // Render pin into DOM
            const area = $('osdArea');
            const pin = document.createElement('div');
            pin.className = 'annot-pin';
            pin.style.left = a.screenX + 'px';
            pin.style.top = a.screenY + 'px';
            pin.innerHTML = `<div class="annot-pin-bubble" style="border-color:${col};color:${col}">${esc(a.label)}</div><div class="annot-pin-dot" style="background:${col}"></div>`;
            area.appendChild(pin);
        } else if (a.type === 'measure' && a.start) {
            ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 3]);
            ctx.beginPath(); ctx.moveTo(a.start.x, a.start.y); ctx.lineTo(a.end.x, a.end.y); ctx.stroke();
            ctx.setLineDash([]);
        }
    });
}

// ─── Measure Tool ────────────────────────────────────────────
function handleMeasureClick(e) {
    if (!state.measureStart) {
        state.measureStart = e.position;
        toast('Measure: click end point…');
    } else {
        const dx = e.position.x - state.measureStart.x;
        const dy = e.position.y - state.measureStart.y;
        const px = Math.sqrt(dx * dx + dy * dy);
        let label = `${Math.round(px)}px`;
        if (state.currentSlide?.mpp_x) {
            const um = px * parseFloat(state.currentSlide.mpp_x);
            label += ` (${um >= 1000 ? (um / 1000).toFixed(2) + ' mm' : Math.round(um) + ' µm'})`;
        }
        $('measureValue').textContent = label;
        pushUndoState();
        state.annotations.push({ type: 'measure', start: state.measureStart, end: e.position, label });
        addAnnotHistory(`Measure: ${label}`, '');
        state.measureStart = null;
        clearAnnotCanvas();
    }
}

function drawMeasureLine(p1, p2) {
    const cv = $('annotCanvas');
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
    ctx.setLineDash([]);
}
function clearAnnotCanvas() { $('annotCanvas').getContext('2d').clearRect(0, 0, $('annotCanvas').width, $('annotCanvas').height); }

// ─── Cell Counter ────────────────────────────────────────────
document.querySelectorAll('.cell-type').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.cell-type').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.cellType = btn.dataset.type;
    });
});
$('clearCells').addEventListener('click', () => {
    state.cells = []; state.cellCount = 0;
    $('cellCountNum').textContent = '0';
    $('cellLayer').innerHTML = '';
});

function handleCellClick(e) {
    const layer = $('cellLayer');
    const dot = document.createElement('div');
    dot.className = 'cell-dot'; dot.title = state.cellType;
    const colors = { tumor: '#f43f5e', immune: '#06b6d4', stroma: '#10b981' };
    dot.style.background = colors[state.cellType] || '#818cf8';
    dot.style.left = e.position.x + 'px'; dot.style.top = e.position.y + 'px';
    layer.appendChild(dot);
    state.cells.push({ x: e.position.x, y: e.position.y, type: state.cellType });
    state.cellCount++;
    $('cellCountNum').textContent = state.cellCount;
    dot.addEventListener('click', ev => { ev.stopPropagation(); dot.remove(); state.cellCount--; $('cellCountNum').textContent = state.cellCount; });
}

// ─── Annotation History ──────────────────────────────────────
function addAnnotHistory(label, severity) {
    const hist = $('annotHistory');
    hist.querySelector('.ah-empty')?.remove();
    const el = document.createElement('div');
    el.className = 'ah-item'; el.title = label;
    el.textContent = label;
    if (severity) {
        const sev = document.createElement('span');
        sev.className = `ah-sev ${severity}`;
        sev.textContent = severity.toUpperCase().slice(0, 3);
        el.appendChild(sev);
    }
    hist.appendChild(el);
}

// ─── Snapshot Dialog & Annotation ────────────────────────────
let snapStrokes = [];
let snapDrawing = false;
let snapCurrStroke = [];

function openSnapshotDialog() {
    if (!state.viewer || !state.currentSlide) { toast('❌ Load a slide first'); return; }
    const isImm = document.body.classList.contains('immersive-active');
    const dialog = isImm ? $('immSnapshotDialog') : $('snapshotDialog');
    dialog.classList.remove('hidden');
    dialog.classList.add('fullscreen');

    snapStrokes = [];
    const prev = isImm ? $('immSnapshotCanvas') : $('snapshotPreviewCanvas');
    setupSnapCanvas(prev, isImm);

    const capInput = isImm ? $('immSnapCaption') : $('snapCaption');
    if (capInput) {
        capInput.value = '';
        setTimeout(() => capInput.focus(), 60);
    }
}

function renderSnapStrokes(ctx, scaleX = 1, scaleY = 1) {
    const strokeScaling = Math.max(1, ctx.canvas.width / 420);
    snapStrokes.forEach(s => {
        if (!s.points || s.points.length < 1) return;
        const color = s.color || '#ef4444';
        ctx.strokeStyle = color;
        ctx.fillStyle = color + '33'; // 20% alpha for fills
        ctx.lineWidth = 3 * strokeScaling * scaleX;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.beginPath();
        if (s.type === 'freehand') {
            ctx.moveTo(s.points[0].x * scaleX, s.points[0].y * scaleY);
            for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * scaleX, s.points[i].y * scaleY);
            ctx.stroke();
        } else if (s.type === 'rect') {
            const sx = s.points[0].x * scaleX;
            const sy = s.points[0].y * scaleY;
            const ex = s.points[s.points.length - 1].x * scaleX;
            const ey = s.points[s.points.length - 1].y * scaleY;
            ctx.rect(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy));
            ctx.fill();
            ctx.stroke();
        } else if (s.type === 'arrow') {
            const sx = s.points[0].x * scaleX;
            const sy = s.points[0].y * scaleY;
            const ex = s.points[s.points.length - 1].x * scaleX;
            const ey = s.points[s.points.length - 1].y * scaleY;
            const headlen = 15 * strokeScaling * scaleX;
            const angle = Math.atan2(ey - sy, ex - sx);
            ctx.moveTo(sx, sy);
            ctx.lineTo(ex, ey);
            ctx.lineTo(ex - headlen * Math.cos(angle - Math.PI / 6), ey - headlen * Math.sin(angle - Math.PI / 6));
            ctx.moveTo(ex, ey);
            ctx.lineTo(ex - headlen * Math.cos(angle + Math.PI / 6), ey - headlen * Math.sin(angle + Math.PI / 6));
            ctx.stroke();
        } else if (s.type === 'point') {
            const px = s.points[0].x * scaleX;
            const py = s.points[0].y * scaleY;
            ctx.arc(px, py, 6 * strokeScaling * scaleX, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        } else if (s.type === 'polygon' || s.type === 'area') {
            ctx.moveTo(s.points[0].x * scaleX, s.points[0].y * scaleY);
            for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * scaleX, s.points[i].y * scaleY);
            if (s.isClosed || s.type === 'area') ctx.closePath();
            if (s.isClosed || s.type === 'area') ctx.fill();
            ctx.stroke();

            if (s.type === 'area' && s.points.length > 2) {
                let areaPx = 0;
                for (let i = 0; i < s.points.length; i++) {
                    const j = (i + 1) % s.points.length;
                    areaPx += s.points[i].x * s.points[j].y - s.points[j].x * s.points[i].y;
                }
                areaPx = Math.abs(areaPx / 2);
                let label = `${Math.round(areaPx)}px\u00b2`;
                if (state.currentSlide?.mpp_x) {
                    const um2 = areaPx * Math.pow(parseFloat(state.currentSlide.mpp_x), 2);
                    label = um2 > 1000000 ? (um2 / 1000000).toFixed(2) + 'mm\u00b2' : Math.round(um2) + '\u00b5m\u00b2';
                }
                const cx = s.points.reduce((a, b) => a + b.x, 0) / s.points.length * scaleX;
                const cy = s.points.reduce((a, b) => a + b.y, 0) / s.points.length * scaleY;
                ctx.fillStyle = color;
                ctx.font = `bold ${12 * strokeScaling * scaleX}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText(label, cx, cy);
            }
        } else if (s.type === 'measure' || s.type === 'ruler') {
            if (s.type === 'ruler') ctx.setLineDash([6 * strokeScaling * scaleX, 4 * strokeScaling * scaleX]);
            ctx.moveTo(s.points[0].x * scaleX, s.points[0].y * scaleY);
            for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * scaleX, s.points[i].y * scaleY);
            ctx.stroke();
            ctx.setLineDash([]);

            let distPx = 0;
            for (let i = 0; i < s.points.length - 1; i++) {
                const dx = s.points[i + 1].x - s.points[i].x;
                const dy = s.points[i + 1].y - s.points[i].y;
                distPx += Math.sqrt(dx * dx + dy * dy);
            }
            if (distPx > 0) {
                let label = `${Math.round(distPx)}px`;
                if (state.currentSlide?.mpp_x) {
                    const um = distPx * parseFloat(state.currentSlide.mpp_x);
                    label = um > 1000 ? (um / 1000).toFixed(2) + 'mm' : Math.round(um) + '\u00b5m';
                }
                const last = s.points[s.points.length - 1];
                ctx.fillStyle = color;
                ctx.font = `bold ${12 * strokeScaling * scaleX}px sans-serif`;
                ctx.fillText(label, last.x * scaleX + 5, last.y * scaleY - 5);
            }
        }
    });
}

function setupSnapCanvas(canvas, isImm) {
    const cbAnnots = isImm ? $('immSnapAnnots') : $('snapIncludeAnnot');
    const cbAI = isImm ? $('immSnapAI') : $('snapIncludeAI');

    let snapActiveTool = 'freehand';
    let snapActiveColor = '#ef4444';
    let activeStroke = null;

    const tb = isImm ? $('immSnapToolbar') : $('snapToolbar');
    if (tb) {
        const toolBtns = tb.querySelectorAll('.sd-tool-btn[data-snaptool]');
        toolBtns.forEach(btn => {
            btn.onclick = () => {
                toolBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                snapActiveTool = btn.dataset.snaptool;
                activeStroke = null;
            };
        });
        const colorInp = tb.querySelector('.sd-color');
        if (colorInp) {
            colorInp.onchange = e => snapActiveColor = e.target.value;
            colorInp.oninput = e => snapActiveColor = e.target.value;
        }

        const undoBtn = isImm ? $('immSnapUndoBtn') : $('snapUndoBtn');
        if (undoBtn) undoBtn.onclick = () => { snapStrokes.pop(); activeStroke = null; draw(); };
        const clearBtn = isImm ? $('immSnapClearBtn') : $('snapClearBtn');
        if (clearBtn) clearBtn.onclick = () => { snapStrokes = []; activeStroke = null; draw(); };
    }

    const osdCanv = document.querySelector('#osdViewer canvas');
    if (osdCanv) {
        canvas.width = osdCanv.width;
        canvas.height = osdCanv.height;
    }

    const draw = () => {
        const pCtx = canvas.getContext('2d');
        pCtx.clearRect(0, 0, canvas.width, canvas.height);
        const osdC = document.querySelector('#osdViewer canvas');
        if (osdC) pCtx.drawImage(osdC, 0, 0, canvas.width, canvas.height);
        if (cbAI?.checked && state.heatmapOn) pCtx.drawImage($('heatmapCanvas'), 0, 0, canvas.width, canvas.height);
        if (cbAnnots?.checked) pCtx.drawImage($('annotCanvas'), 0, 0, canvas.width, canvas.height);
        renderSnapStrokes(pCtx);
    };

    if (cbAnnots) cbAnnots.onchange = draw;
    if (cbAI) cbAI.onchange = draw;

    function getMousePos(e) {
        const rect = canvas.getBoundingClientRect();

        let drawWidth = rect.width;
        let drawHeight = rect.height;
        let offsetX = 0;
        let offsetY = 0;

        const canvasRatio = canvas.width / canvas.height;
        const rectRatio = rect.width / rect.height;

        if (canvasRatio > rectRatio) {
            drawHeight = rect.width / canvasRatio;
            offsetY = (rect.height - drawHeight) / 2;
        } else {
            drawWidth = rect.height * canvasRatio;
            offsetX = (rect.width - drawWidth) / 2;
        }

        const scaleX = canvas.width / drawWidth;
        const scaleY = canvas.height / drawHeight;

        return {
            x: (e.clientX - rect.left - offsetX) * scaleX,
            y: (e.clientY - rect.top - offsetY) * scaleY
        };
    }

    canvas.onmousedown = (e) => {
        if (e.button !== 0) return;
        const pt = getMousePos(e);

        if (['polygon', 'ruler', 'area'].includes(snapActiveTool)) {
            if (!activeStroke) {
                activeStroke = { type: snapActiveTool, color: snapActiveColor, points: [pt], isClosed: false };
                snapStrokes.push(activeStroke);
            } else {
                activeStroke.points.push(pt);
            }
        } else if (snapActiveTool === 'point') {
            snapStrokes.push({ type: 'point', color: snapActiveColor, points: [pt] });
        } else {
            snapDrawing = true;
            activeStroke = { type: snapActiveTool, color: snapActiveColor, points: [pt] };
            snapStrokes.push(activeStroke);
        }
        draw();
    };

    canvas.onmousemove = (e) => {
        const pt = getMousePos(e);
        if (snapDrawing && activeStroke) {
            if (snapActiveTool === 'freehand') {
                activeStroke.points.push(pt);
            } else {
                if (activeStroke.points.length > 1) activeStroke.points[1] = pt;
                else activeStroke.points.push(pt);
            }
            draw();
        } else if (activeStroke && ['polygon', 'ruler', 'area'].includes(snapActiveTool)) {
            draw();
            const pCtx = canvas.getContext('2d');
            pCtx.strokeStyle = snapActiveColor;
            pCtx.setLineDash([5, 5]);
            pCtx.beginPath();
            const last = activeStroke.points[activeStroke.points.length - 1];
            pCtx.moveTo(last.x, last.y);
            pCtx.lineTo(pt.x, pt.y);
            pCtx.stroke();
            pCtx.setLineDash([]);
        }
    };

    canvas.onmouseup = () => { snapDrawing = false; if (!['polygon', 'ruler', 'area'].includes(snapActiveTool)) activeStroke = null; };

    canvas.ondblclick = (e) => {
        if (activeStroke && ['polygon', 'ruler', 'area'].includes(snapActiveTool)) {
            activeStroke.isClosed = true;
            activeStroke = null;
            draw();
        }
    };

    canvas.style.cursor = 'crosshair';
    toast('✏️ Draw on preview to annotate snapshot');
    draw();
}

$('snapSaveBtn').addEventListener('click', () => {
    const caption = $('snapCaption').value.trim();
    $('snapshotDialog').classList.remove('fullscreen');
    $('snapshotDialog').classList.add('hidden');
    captureSnapshotSilent(caption || `Snapshot #${state.evidencePack.length + 1}`, false);
});
$('snapCancelBtn').addEventListener('click', () => {
    $('snapshotDialog').classList.remove('fullscreen');
    $('snapshotDialog').classList.add('hidden');
});
$('snapExpandBtn')?.addEventListener('click', () => {
    $('snapshotDialog').classList.toggle('fullscreen');
});

$('immSnapSaveBtn')?.addEventListener('click', () => {
    const caption = $('immSnapCaption').value.trim();
    $('immSnapshotDialog').classList.remove('fullscreen');
    $('immSnapshotDialog').classList.add('hidden');
    captureSnapshotSilent(caption || `Snapshot #${state.evidencePack.length + 1}`, true);
});
$('immSnapCancelBtn')?.addEventListener('click', () => {
    $('immSnapshotDialog').classList.remove('fullscreen');
    $('immSnapshotDialog').classList.add('hidden');
});
$('immSnapExpandBtn')?.addEventListener('click', () => {
    $('immSnapshotDialog').classList.toggle('fullscreen');
});

// ─── Heatmap (real slide analysis) ───────────────────────

/** Carbon cool→warm colormap: teal → green → amber → red */
function heatmapColor(v, alpha) {
    const stops = [
        [0.00, [6, 182, 212]],
        [0.25, [16, 185, 129]],
        [0.50, [245, 158, 11]],
        [0.75, [234, 88, 12]],
        [1.00, [220, 38, 38]],
    ];
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < stops.length - 1; i++) {
        if (v >= stops[i][0] && v <= stops[i + 1][0]) {
            const t = (v - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
            r = stops[i][1][0] + t * (stops[i + 1][1][0] - stops[i][1][0]);
            g = stops[i][1][1] + t * (stops[i + 1][1][1] - stops[i][1][1]);
            b = stops[i][1][2] + t * (stops[i + 1][1][2] - stops[i][1][2]);
            break;
        }
    }
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
}

/** Fetch real heatmap grid from backend then render */
async function fetchAndRenderHeatmap(silent = false) {
    if (!state.currentSlide) return;
    const cv = $('heatmapCanvas');
    const ctx = cv.getContext('2d');

    if (!silent) {
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = 'rgba(15,98,254,0.10)';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.fillStyle = '#4589ff';
        ctx.font = '13px IBM Plex Sans, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Computing tissue heatmap…', cv.width / 2, cv.height / 2);
    }

    state.heatmapLoading = true;
    try {
        const r = await fetch(`/api/slide/${encodeURIComponent(state.currentSlide.filename)}/heatmap`);
        if (!r.ok) throw new Error(await r.text());
        const data = await r.json();
        if (data.error) throw new Error(data.error);
        state.heatmapData = data;

        // Populate AI Insights sidebar
        updateAIInsights(data);

        if (state.heatmapOn) {
            renderRealHeatmap();
            if (!silent) toast('🔥 Heatmap ready');
        } else if (!silent) {
            toast('🔥 Heatmap ready');
        }
    } catch (err) {
        if (!silent) toast(`❌ Heatmap: ${err.message}`);
        ctx.clearRect(0, 0, cv.width, cv.height);
        state.heatmapOn = false;
        $('heatmapCanvas').classList.add('hidden');
        $('heatmapToggle').checked = false;
        $('toolHeatmap')?.classList.remove('active');
        $('btnHeatmapTop')?.classList.remove('on');
    } finally {
        state.heatmapLoading = false;
    }
}

function highlightROI(x, y) {
    if (!state.viewer) return;
    const vp = state.viewer.viewport;
    const rectSize = 0.05; // 5% of slide width

    const r = new OpenSeadragon.Rect(x - rectSize / 2, y - rectSize / 2, rectSize, rectSize);

    let highlight = document.getElementById('temp-roi-highlight');
    if (!highlight) {
        // Create an element overlays the osd viewer
        highlight = document.createElement('div');
        highlight.id = 'temp-roi-highlight';
        highlight.style.position = 'absolute';
        highlight.style.border = '3px solid #f43f5e';
        highlight.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.5)'; // Darken outside
        highlight.style.pointerEvents = 'none';
        highlight.style.transition = 'opacity 0.6s ease-in';
        highlight.style.zIndex = '100';
        $('osdViewer').appendChild(highlight);
    }

    const osdRect = vp.viewportToViewerElementRectangle(r);
    highlight.style.left = osdRect.x + 'px';
    highlight.style.top = osdRect.y + 'px';
    highlight.style.width = osdRect.width + 'px';
    highlight.style.height = osdRect.height + 'px';
    highlight.style.opacity = '1';

    setTimeout(() => { highlight.style.opacity = '0'; }, 1500);
}

function updateAIInsights(data) {
    if (!data || !data.heatmap || !data.grid) return;
    const { heatmap, grid } = data;
    const [rows, cols] = grid;

    const flat = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            flat.push({ r, c, val: heatmap[r][c] });
        }
    }
    flat.sort((a, b) => b.val - a.val);

    const hotspots = [];
    for (const pt of flat) {
        if (hotspots.length >= 3) break;
        let tooClose = false;
        for (const h of hotspots) {
            const dist = Math.sqrt((h.r - pt.r) ** 2 + (h.c - pt.c) ** 2);
            if (dist < 3) { tooClose = true; break; }
        }
        if (!tooClose) hotspots.push(pt);
    }
    while (hotspots.length < 3 && flat.length > hotspots.length) {
        hotspots.push(flat[hotspots.length]);
    }

    // Connect hotspots
    const btns = document.querySelectorAll('.hotspot-item');
    btns.forEach((btn, idx) => {
        if (!hotspots[idx]) return;
        const pt = hotspots[idx];
        const confText = btn.querySelector('.hotspot-conf');
        if (confText) confText.textContent = `Conf: ${Math.round(pt.val * 100)}%`;

        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);

        newBtn.addEventListener('click', () => {
            if (!state.viewer || !state.currentSlide) return;
            const targetX = (pt.c + 0.5) / cols;
            const targetY = (pt.r + 0.5) / rows;
            const point = new OpenSeadragon.Point(targetX, targetY);

            // Pan and zoom
            state.viewer.viewport.panTo(point);
            state.viewer.viewport.zoomTo(state.viewer.viewport.imageToViewportZoom(20)); // ~20x mag

            document.querySelectorAll('.hotspot-item').forEach(b => b.classList.remove('active'));
            newBtn.classList.add('active');
            toast(`📍 Navigated to Hotspot ${idx + 1}`);

            highlightROI(targetX, targetY);
        });
    });

    // Randomize Cell Density based on tumor mass
    const tumorMass = flat.slice(0, 100).reduce((acc, curr) => acc + curr.val, 0);
    const density = Math.floor(1000 + tumorMass * 45);
    const statsVals = document.querySelectorAll('.density-stat .stat-val');
    const statsFills = document.querySelectorAll('.density-stat .stat-bar-fill');
    if (statsVals.length >= 3 && statsFills.length >= 3) {
        statsVals[0].textContent = density.toLocaleString();
        statsVals[1].textContent = (Math.floor(density * 0.42)).toLocaleString();
        const ratio = Math.floor((density * 0.42) / (density * 1.42) * 100);
        statsVals[2].textContent = ratio + '%';

        statsFills[0].style.width = Math.min((density / 4000) * 100, 100) + '%';
        statsFills[1].style.width = Math.min((density * 0.42 / 2000) * 100, 100) + '%';
        statsFills[2].style.width = ratio + '%';
    }

    // Pattern Classification
    const topVal = flat[0] ? flat[0].val : 0.9;
    const patternConfs = document.querySelectorAll('.pattern-result .conf-badge');
    if (patternConfs.length >= 3) {
        patternConfs[0].textContent = Math.round(topVal * 100) + '%';
        patternConfs[1].textContent = Math.round(topVal * 86) + '%';
        patternConfs[2].textContent = Math.round(topVal * 55) + '%';
    }

    const immAiConfs = document.querySelectorAll('.imm-ai-strip .imm-ai-conf');
    if (immAiConfs.length >= 3) {
        immAiConfs[0].textContent = Math.round(topVal * 100) + '%';
        immAiConfs[1].textContent = Math.round(topVal * 86) + '%';
        immAiConfs[2].textContent = Math.round(topVal * 55) + '%';
    }
}

/**
 * Project each cell from slide image space → OSD viewport → screen pixels.
 * Call on every zoom/pan so overlay stays pixel-aligned.
 */
function renderRealHeatmap() {
    if (!state.heatmapOn || !state.heatmapData || !state.viewer) return;
    const cv = $('heatmapCanvas');
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);

    const { heatmap, grid } = state.heatmapData;
    const [gridRows, gridCols] = grid;
    const imgW = state.currentSlide.width;
    const imgH = state.currentSlide.height;
    const vp = state.viewer.viewport;
    const zoom = vp.getZoom(true);
    const alpha = Math.max(0.22, Math.min(0.58, 0.50 / zoom));

    for (let ri = 0; ri < gridRows; ri++) {
        for (let ci = 0; ci < gridCols; ci++) {
            const val = heatmap[ri][ci];
            if (val < 0.02) continue;

            const ix1 = (ci / gridCols) * imgW;
            const iy1 = (ri / gridRows) * imgH;
            const ix2 = ((ci + 1) / gridCols) * imgW;
            const iy2 = ((ri + 1) / gridRows) * imgH;

            let vp1, vp2;
            try {
                vp1 = vp.imageToViewportCoordinates(ix1, iy1);
                vp2 = vp.imageToViewportCoordinates(ix2, iy2);
            } catch { continue; }

            const p1 = vp.viewportToViewerElementCoordinates(vp1);
            const p2 = vp.viewportToViewerElementCoordinates(vp2);
            const sx = p1.x, sy = p1.y, sw = p2.x - p1.x, sh = p2.y - p1.y;

            if (sx + sw < 0 || sx > cv.width || sy + sh < 0 || sy > cv.height) continue;

            ctx.fillStyle = heatmapColor(val, alpha);
            ctx.fillRect(sx, sy, sw, sh);
        }
    }
}

function toggleHeatmap() {
    if (!state.currentSlide) { toast('❌ Load a slide first'); return; }
    state.heatmapOn = !state.heatmapOn;
    $('heatmapCanvas').classList.toggle('hidden', !state.heatmapOn);
    $('heatmapToggle').checked = state.heatmapOn;
    $('toolHeatmap').classList.toggle('active', state.heatmapOn);
    $('btnHeatmapTop').classList.toggle('on', state.heatmapOn);
    updateMagLabel();
    if (state.heatmapOn) {
        if (state.heatmapData) { renderRealHeatmap(); }
        else { fetchAndRenderHeatmap(); }
    } else {
        const cv = $('heatmapCanvas');
        cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    }
}

$('heatmapToggle').addEventListener('change', toggleHeatmap);
$('btnHeatmapTop').addEventListener('click', toggleHeatmap);

// ─── Overlay Resize ──────────────────────────────────────
function resizeOverlays() {
    const area = $('osdArea');
    const w = area.clientWidth, h = area.clientHeight;
    [$('heatmapCanvas'), $('annotCanvas')].forEach(cv => { cv.width = w; cv.height = h; });
    if (state.heatmapOn) renderRealHeatmap();
    redrawAllAnnotations();
}

// ─── Minimap ─────────────────────────────────────────────
let minimapImg = null;
function loadMinimap(fn) {
    const ctx = $('minimapCanvas').getContext('2d');
    ctx.fillStyle = '#08090f'; ctx.fillRect(0, 0, 160, 110);
    minimapImg = new Image();
    minimapImg.crossOrigin = 'anonymous';
    minimapImg.src = `/api/slide/${encodeURIComponent(fn)}/thumbnail?width=320&height=220`;
    minimapImg.onload = updateMinimap;
}

function updateMinimap() {
    if (!minimapImg || !minimapImg.complete || !state.viewer) return;
    const cv = $('minimapCanvas'), ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(minimapImg, 0, 0, cv.width, cv.height);
    try {
        const b = state.viewer.viewport.getBounds(true);
        ctx.strokeStyle = 'rgba(99,102,241,0.9)';
        ctx.lineWidth = 1.5;
        ctx.fillStyle = 'rgba(99,102,241,0.12)';
        const x = b.x * cv.width, y = b.y * cv.height;
        const w = b.width * cv.width, h = b.height * cv.height;
        ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
    } catch { }
}

// ─── Scale Bar ────────────────────────────────────────────
function updateScaleBar() {
    const bar = $('scaleBar'), line = $('scaleBarLine'), label = $('scaleBarLabel');
    if (!state.viewer || !state.currentSlide?.mpp_x) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    try {
        const z = state.viewer.viewport.viewportToImageZoom(state.viewer.viewport.getZoom(true));
        const px = 80 / (z / parseFloat(state.currentSlide.mpp_x));
        const um = px;
        label.textContent = um >= 1000 ? `${(um / 1000).toFixed(1)} mm` : `${Math.round(um)} µm`;
        line.style.width = '80px';
    } catch { }
}

// ─── Snapshot & Evidence ──────────────────────────────────
/** Silent snapshot (no dialog) — used by auto-snap and quickSave */
function captureSnapshotSilent(label, isImm = false) {
    if (!state.viewer || !state.currentSlide) { toast('❌ No slide loaded'); return; }
    const z = state.viewer.viewport.getZoom(true);
    const iz = state.viewer.viewport.viewportToImageZoom(z);
    const bounds = state.viewer.viewport.getBounds(true);

    const osdCanv = document.querySelector('#osdViewer canvas');
    let dataURL = null;

    if (osdCanv) {
        const tmp = document.createElement('canvas');
        tmp.width = osdCanv.width;
        tmp.height = osdCanv.height;
        const ctx = tmp.getContext('2d');
        ctx.drawImage(osdCanv, 0, 0);

        const cbAnnots = isImm ? $('immSnapAnnots') : $('snapIncludeAnnot');
        const cbAI = isImm ? $('immSnapAI') : $('snapIncludeAI');
        const incAnnot = cbAnnots ? cbAnnots.checked : true;
        const incAI = cbAI ? cbAI.checked : true;

        if (incAI && state.heatmapOn) {
            try { ctx.drawImage($('heatmapCanvas'), 0, 0); } catch { }
        }
        if (incAnnot) {
            try { ctx.drawImage($('annotCanvas'), 0, 0); } catch { }
        }

        if (typeof snapStrokes !== 'undefined' && snapStrokes.length > 0) {
            const prev = isImm ? $('immSnapshotCanvas') : $('snapshotPreviewCanvas');
            if (prev) {
                const scaleX = tmp.width / prev.width;
                const scaleY = tmp.height / prev.height;
                renderSnapStrokes(ctx, scaleX, scaleY);
            }
        }
        try { dataURL = tmp.toDataURL('image/jpeg', 0.95); } catch { }
    }

    const savedSketches = (typeof snapStrokes !== 'undefined') ? JSON.parse(JSON.stringify(snapStrokes)) : [];

    // Clear strokes after capture so auto-snaps don't re-use them
    if (typeof snapStrokes !== 'undefined') snapStrokes = [];

    // Full Evidence Object Model
    const ev = {
        id: Date.now(),
        evidence_id: `EV-${Date.now()}`,
        case_id: 'C-2041',
        slide_id: state.currentSlide.filename,
        label: label || `Snapshot #${state.evidencePack.length + 1}`,
        zoom: iz.toFixed(2),
        mag: `${Math.round(iz * 20)}×`,
        bounds: {
            x: Math.round(bounds.x * state.currentSlide.width),
            y: Math.round(bounds.y * state.currentSlide.height),
            width: Math.round(bounds.width * state.currentSlide.width),
            height: Math.round(bounds.height * state.currentSlide.height),
        },
        viewportBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        zoom_level: iz,
        annotation_type: 'snapshot',
        annotation_count: state.annotations.length,
        annotation_data: JSON.parse(JSON.stringify(state.annotations.slice(-1))),
        snapshot_sketches: savedSketches,
        ai_model_version: '1.3.2',
        overlay_state: state.heatmapOn,
        timestamp: new Date().toISOString(),
        user_id: 'DR.SINGH',
        caption: '',
        dataURL,
    };

    state.evidencePack.push(ev);
    updateEvidenceBadge();
    toast(`📸 ${ev.label} saved to Evidence Pack`);
    setTool('pan');
}

$('quickSaveBtn').addEventListener('click', () => openSnapshotDialog());

function updateEvidenceBadge() {
    const badge = $('evidenceBadge');
    badge.textContent = state.evidencePack.length;
    badge.style.display = state.evidencePack.length ? '' : 'none';
}

// ─── Evidence View ────────────────────────────────────────
function renderEvidenceView() {
    const grid = $('evidenceGrid'), empty = $('evidenceEmpty');
    if (!state.evidencePack.length) {
        grid.innerHTML = '';
        grid.appendChild(empty);
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');
    grid.innerHTML = state.evidencePack.map(ev => `
    <div class="evidence-card" data-evid="${ev.id}">
      <div class="ev-img" style="cursor:pointer" title="Click to navigate back to this view" data-act="navigate" data-evid="${ev.id}">
        ${ev.dataURL
            ? `<img src="${ev.dataURL}" style="width:100%;height:100%;object-fit:cover"/>`
            : `<div class="ev-img-placeholder"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`
        }
        <div class="ev-badge">${ev.mag} · ${(ev.slide_id || ev.slideId || '').substring(0, 14)}</div>
      </div>
      <div class="ev-body">
        <div class="ev-title">${esc(ev.label)}</div>
        <div class="ev-meta">
          Slide: ${esc(ev.slide_id || ev.slideId)}<br/>
          Mag: ${ev.mag} · Zoom: ${ev.zoom}&times;<br/>
          Annots: ${ev.annotation_count ?? ev.annotation_layers ?? 0} · AI: v${ev.ai_model_version || ev.aiModelVersion}<br/>
          ${new Date(ev.timestamp).toLocaleTimeString()}
        </div>
        <textarea class="ev-caption-input" placeholder="Add caption…" data-evid="${ev.id}" rows="2">${esc(ev.caption)}</textarea>
        <div class="ev-actions">
          <button class="ev-nav-btn" data-act="navigate" data-evid="${ev.id}">↵ View in Slide</button>
          <button class="ev-btn" data-act="insert" data-evid="${ev.id}">Insert into Report</button>
          <button class="ev-btn" data-act="lab" data-evid="${ev.id}">Send to Lab</button>
          <button class="ev-btn danger" data-act="delete" data-evid="${ev.id}">Delete</button>
        </div>
      </div>
    </div>`).join('');

    // Caption save
    grid.querySelectorAll('.ev-caption-input').forEach(ta => {
        ta.addEventListener('input', () => {
            const ev = state.evidencePack.find(e => e.id == ta.dataset.evid);
            if (ev) ev.caption = ta.value;
        });
    });

    // Action buttons (ev-btn and ev-nav-btn)
    grid.querySelectorAll('[data-act]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = parseInt(btn.dataset.evid);
            const ev = state.evidencePack.find(e => e.id === id);
            if (!ev) return;
            if (btn.dataset.act === 'navigate') {
                navigateToEvidence(ev);
            } else if (btn.dataset.act === 'insert') {
                insertEvidenceToReport(ev); toast('📋 Inserted into Report');
            } else if (btn.dataset.act === 'lab') {
                attachEvidenceToLab(ev); toast('📤 Attached to Lab message'); switchView('lab');
            } else if (btn.dataset.act === 'delete') {
                state.evidencePack.splice(state.evidencePack.findIndex(e => e.id === id), 1);
                updateEvidenceBadge();
                renderEvidenceView();
            }
        });
    });
}

/** Navigate viewer back to exact zoom + position of a saved evidence item */
function navigateToEvidence(ev) {
    if (!state.viewer) {
        toast('❌ No viewer active — load a slide first'); return;
    }
    const vb = ev.viewportBounds;
    if (!vb) {
        toast('❌ No position data for this evidence item'); return;
    }
    // Switch to viewer tab first
    switchView('viewer');
    // Pan and zoom to the exact viewport bounds
    setTimeout(() => {
        try {
            const rect = new OpenSeadragon.Rect(vb.x, vb.y, vb.width, vb.height);
            state.viewer.viewport.fitBounds(rect, true);
            toast(`📍 Jumped to “${ev.label}”`);
        } catch (err) {
            toast('❌ Could not navigate: ' + err.message);
        }
    }, 200);
}


function insertEvidenceToReport(ev) {
    if (!ev) return;
    // add to report right panel gallery
    syncReportGallery();
}

function syncReportGallery() {
    const gallery = $('reportEvidenceGallery');
    if (!state.evidencePack.length) { gallery.innerHTML = '<div class="gallery-empty">No evidence captured</div>'; return; }
    gallery.innerHTML = state.evidencePack.map(ev => `
    <div class="gallery-item">
      ${ev.dataURL ? `<img src="${ev.dataURL}" />` : `<div style="height:60px;display:flex;align-items:center;justify-content:center;background:var(--bg-base);color:var(--text-muted)"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>`}
      <div class="gallery-item-label">${esc(ev.label)} · ${ev.mag}</div>
    </div>`).join('');
}

function attachEvidenceToLab(ev) {
    if (!ev) return;
    state.attachedToMessage.push(ev);
    const previews = $('attachPreviews');
    const el = document.createElement('div');
    el.className = 'attach-preview-item';
    el.textContent = `📸 ${ev.label}`;
    previews.appendChild(el);
}

$('insertAllBtn')?.addEventListener('click', () => {
    state.evidencePack.forEach(ev => insertEvidenceToReport(ev));
    toast('📋 All evidence inserted into Report');
    syncReportGallery();
});

// ─── Toolbar Buttons ──────────────────────────────────────
$('btnZoomIn').addEventListener('click', () => state.viewer?.viewport.zoomBy(1.5));
$('btnZoomOut').addEventListener('click', () => state.viewer?.viewport.zoomBy(1 / 1.5));
$('btnHome').addEventListener('click', () => state.viewer?.viewport.goHome(true));
$('btnReset').addEventListener('click', () => { state.viewer?.viewport.goHome(true); toast('↺ View reset'); });
$('btnCompare').addEventListener('click', () => {
    $('btnCompare').classList.toggle('on');
    toast($('btnCompare').classList.contains('on') ? '🔀 Compare mode (select second slide)' : '↩ Compare mode off');
});
$('btnFullscreen').addEventListener('click', () => {
    const el = $('viewerMain') || document.documentElement;
    document.fullscreenElement ? document.exitFullscreen() : el.requestFullscreen?.();
});

// ─── Keyboard Shortcuts ───────────────────────────────────
document.addEventListener('keydown', e => {
    // Undo/Redo — always handled
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); doRedo(); return; }
    // Escape dismisses overlays
    if (e.key === 'Escape') {
        dismissAnnotMiniToolbar();
        $('snapshotDialog').classList.add('hidden');
        $('immSnapshotDialog')?.classList.add('hidden');
        return;
    }
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (!state.viewer) return;
    const vp = state.viewer.viewport;
    const map = {
        '+': () => vp.zoomBy(1.5), '=': () => vp.zoomBy(1.5), '-': () => vp.zoomBy(1 / 1.5),
        'h': () => vp.goHome(true), 'H': () => vp.goHome(true),
        'p': () => setTool('pan'),
        'r': () => setTool('roi'),      // ROI rectangle
        'a': () => setTool('roi'),      // A = quick Annotate
        'g': () => setTool('polygon'),  // G = polyGon
        'f': () => setTool('freehand'), // F = Freehand
        'l': () => setTool('label'),    // L = Label pin
        'm': () => setTool('measure'),
        'c': () => setTool('cell'),
        's': () => openSnapshotDialog(), // S = Snapshot
        'ArrowUp': () => vp.panBy(new OpenSeadragon.Point(0, -0.05)),
        'ArrowDown': () => vp.panBy(new OpenSeadragon.Point(0, 0.05)),
        'ArrowLeft': () => vp.panBy(new OpenSeadragon.Point(-0.05, 0)),
        'ArrowRight': () => vp.panBy(new OpenSeadragon.Point(0.05, 0)),
    };
    if (map[e.key]) { if (e.key.startsWith('Arrow')) e.preventDefault(); map[e.key](); }
});

// ─── Immersive Fullscreen Mode ─────────────────────────────
(function setupImmersive() {
    const overlay = $('immersiveOverlay');
    if (!overlay) return;
    let immActive = false;

    function updateImmHUD() {
        if (!state.viewer || !immActive) return;
        const c = state.viewer.viewport.getCenter();
        const el = $('immCoords');
        if (el) el.textContent = `x: ${Math.round(c.x * 10000)} · y: ${Math.round(c.y * 10000)}`;
        const zEl = $('immZoomLabel');
        if (zEl) zEl.textContent = state.viewer.viewport.getZoom(true).toFixed(2) + '\u00d7';
    }

    function enterImmersive() {
        if (!state.viewer) { toast('⚠️ Load a slide first'); return; }
        overlay.classList.remove('hidden');
        document.body.classList.add('immersive-active');
        immActive = true;

        // Let flexbox adjust DOM dimensions first, then resize canvas
        setTimeout(() => {
            if (state.viewer) state.viewer.viewport.goHome(true);
            window.dispatchEvent(new Event('resize'));
            state.viewer.forceRedraw();
        }, 50);

        state.viewer.addHandler('animation', updateImmHUD);
        state.viewer.addHandler('update-viewport', updateImmHUD);
        updateImmHUD();

        toast('\uD83D\uDD2C Immersive mode \u2014 press I or Esc to exit');
    }

    function exitImmersive() {
        overlay.classList.add('hidden');
        document.body.classList.remove('immersive-active');
        immActive = false;

        setTimeout(() => {
            if (state.viewer) state.viewer.viewport.goHome(true);
            window.dispatchEvent(new Event('resize'));
            state.viewer.forceRedraw();
        }, 50);

        if (state.viewer) {
            state.viewer.removeHandler('animation', updateImmHUD);
            state.viewer.removeHandler('update-viewport', updateImmHUD);
        }
        toast('\u21A9 Exited immersive mode');
    }

    // Wire floating tool buttons
    overlay.querySelectorAll('.imm-tool[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            setTool(btn.dataset.tool);
        });
    });

    // Layers, Undo, Redo
    $('immToolLayers')?.addEventListener('click', () => { $('toolLayerVis')?.click(); });
    $('immBtnUndo')?.addEventListener('click', doUndo);
    $('immBtnRedo')?.addEventListener('click', doRedo);

    // Zoom / Fit controls in HUD
    $('immBtnZoomIn')?.addEventListener('click', () => state.viewer?.viewport.zoomBy(1.5));
    $('immBtnZoomOut')?.addEventListener('click', () => state.viewer?.viewport.zoomBy(1 / 1.5));
    $('immBtnFit')?.addEventListener('click', () => state.viewer?.viewport.goHome(true));

    // Heatmap toggle (delegate to the main button)
    $('immBtnHeatmap')?.addEventListener('click', () => {
        $('btnHeatmapTop')?.click();
        $('immBtnHeatmap').classList.toggle('on');
    });

    // Auto-snap sync
    $('immAutoSnapToggle')?.addEventListener('change', e => {
        const main = $('autoSnapToggle');
        if (main) main.checked = e.target.checked;
    });

    // Snapshot
    $('immBtnSnap')?.addEventListener('click', openSnapshotDialog);

    // Open via topbar button
    $('btnImmersive')?.addEventListener('click', enterImmersive);

    // Exit button
    $('immExitBtn')?.addEventListener('click', exitImmersive);

    // Keyboard: I = toggle, Esc = exit
    document.addEventListener('keydown', e => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
        if (e.key === 'i' || e.key === 'I') { immActive ? exitImmersive() : enterImmersive(); }
        if (immActive && e.key === 'Escape') exitImmersive();
    });
})();

// ─── Reporting Studio ─────────────────────────────────────
document.querySelectorAll('.template-item').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.template-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const templates = {
            adenocarcinoma: 'Sections show cores of prostate tissue with infiltrating malignant glands in a Gleason pattern configuration...',
            squamous: 'Sections show squamous cell carcinoma with keratinisation and intercellular bridges...',
            lymphoma: 'Sections show diffuse large B-cell lymphoma with sheets of atypical large cells...',
            melanoma: 'Sections show malignant melanoma with epithelioid morphology and prominent nucleoli...',
            gist: 'Sections show a spindle cell neoplasm consistent with gastrointestinal stromal tumour...',
            custom: '',
        };
        $('reportNarrative').value = templates[btn.dataset.tpl] || '';
        triggerAutoSave();
    });
});

// Auto-save simulation
function triggerAutoSave() {
    clearTimeout(state.autoSaveTimer);
    const ind = $('autoSaveIndicator');
    qs('.save-dot', ind)?.classList.remove('pulse');
    state.autoSaveTimer = setTimeout(() => {
        qs('.save-dot', ind)?.classList.add('pulse');
        ind.querySelector('span').textContent = 'Auto-saved just now';
        setTimeout(() => { ind.querySelector('span').textContent = 'Auto-saved 5s ago'; }, 5000);
    }, 1500);
}

['reportNarrative', 'reportAddendum', 'primaryDx', 'tumourExtent'].forEach(id => {
    $(id)?.addEventListener('input', triggerAutoSave);
});

$('btnSaveDraft').addEventListener('click', () => toast('💾 Draft saved'));

function generateFullReportHTML() {
    const caseId = 'C-2041';
    const patientStr = 'DOE, JOHN (1962-04-11)';
    const pathologist = 'Dr. R. Singh';

    const specimen = $('specimenType').value;
    const primaryDx = $('primaryDx').value;
    const grade = $('histoGrade').value;
    const extent = $('tumourExtent').value;
    const pni = $('pni').value;
    const lvi = $('lvi').value;
    const narrative = $('reportNarrative').value;
    const addendum = $('reportAddendum').value;

    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Pathology Report - ${caseId}</title>
        <style>
            body { font-family: 'Inter', -apple-system, sans-serif; line-height: 1.6; color: #161616; max-width: 900px; margin: 0 auto; padding: 40px; background: #fff; }
            .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f62fe; padding-bottom: 20px; margin-bottom: 30px; }
            .header-info h1 { font-size: 24px; font-weight: 700; color: #0f62fe; margin: 0 0 5px 0; }
            .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; background: #f4f4f4; padding: 20px; border-radius: 4px; margin-bottom: 30px; }
            .meta-item { font-size: 13px; }
            .section { margin-bottom: 30px; }
            .section-title { font-size: 14px; font-weight: 700; text-transform: uppercase; color: #6f6f6f; border-bottom: 1px solid #e0e0e0; padding-bottom: 5px; margin-bottom: 15px; }
            .diag-fields { display: grid; grid-template-columns: 200px 1fr; gap: 8px 20px; }
            .diag-label { font-weight: 600; color: #525252; font-size: 13px; }
            .diag-val { color: #161616; font-size: 13px; }
            .narrative-box { white-space: pre-wrap; font-size: 14px; background: #fafafa; padding: 15px; border: 1px solid #e0e0e0; border-radius: 4px; }
            .evidence-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 15px; }
            .evidence-item { border: 1px solid #e0e0e0; padding: 10px; border-radius: 4px; page-break-inside: avoid; }
            .evidence-item img { width: 100%; height: auto; border-radius: 2px; margin-bottom: 10px; }
            .evidence-item strong { display: block; font-size: 13px; color: #0f62fe; }
            .evidence-item p { font-size: 12px; color: #525252; margin: 4px 0 0 0; font-style: italic; }
            .footer { margin-top: 50px; padding-top: 20px; border-top: 1px solid #e0e0e0; font-size: 12px; color: #6f6f6f; display: flex; justify-content: space-between; }
            @media print { .no-print { display: none; } }
            .print-btn { background: #0f62fe; color: #fff; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-weight: 600; }
        </style>
    </head>
    <body>
        <div class="header">
            <div class="header-info">
                <h1>Pathology Diagnostic Report</h1>
                <div style="font-size: 14px; color: #525252;">Path-IQ Clinical Systems</div>
            </div>
            <div class="no-print"><button class="print-btn" onclick="window.print()">Print to PDF</button></div>
        </div>

        <div class="meta-grid">
            <div class="meta-item"><strong>Case ID:</strong> ${esc(caseId)}</div>
            <div class="meta-item"><strong>Status:</strong> FINAL SIGNED</div>
            <div class="meta-item"><strong>Patient:</strong> ${esc(patientStr)}</div>
            <div class="meta-item"><strong>Report Date:</strong> ${new Date().toLocaleDateString()}</div>
            <div class="meta-item"><strong>Pathologist:</strong> ${esc(pathologist)}</div>
            <div class="meta-item"><strong>Accession:</strong> ACC-2026-0442</div>
        </div>

        <div class="section">
            <div class="section-title">Structured Diagnosis</div>
            <div class="diag-fields">
                <span class="diag-label">Specimen Type</span><span class="diag-val">${esc(specimen)}</span>
                <span class="diag-label">Primary Diagnosis</span><span class="diag-val">${esc(primaryDx)}</span>
                <span class="diag-label">Histologic Grade</span><span class="diag-val">${esc(grade)}</span>
                <span class="diag-label">Tumour Extent</span><span class="diag-val">${esc(extent)}</span>
                <span class="diag-label">Perineural Invasion</span><span class="diag-val">${esc(pni)}</span>
                <span class="diag-label">Lymphovascular Invasion</span><span class="diag-val">${esc(lvi)}</span>
            </div>
        </div>

        <div class="section">
            <div class="section-title">Narrative Diagnosis</div>
            <div class="narrative-box">${esc(narrative)}</div>
        </div>

        ${addendum ? `
        <div class="section">
            <div class="section-title">Addendum / Comments</div>
            <div class="narrative-box">${esc(addendum)}</div>
        </div>` : ''}

        <div class="section">
            <div class="section-title">Evidence Portfolio (${state.evidencePack.length} items)</div>
            <div class="evidence-grid">
                ${state.evidencePack.map(ev => `
                    <div class="evidence-item">
                        <img src="${ev.dataURL || ''}" alt="Evidence Screenshot">
                        <strong>${esc(ev.label)} — ${ev.mag}</strong>
                        <p>${esc(ev.caption || 'No caption provided.')}</p>
                    </div>
                `).join('')}
            </div>
        </div>

        <div class="footer">
            <span>Electronic Signature: Dr. R. Singh</span>
            <span>Generated by Path-IQ AI Diagnostic Suite</span>
        </div>
    </body>
    </html>`;
}

$('btnDownloadReport')?.addEventListener('click', () => {
    toast('📄 Preparing report preview...');
    const html = generateFullReportHTML();

    // Open in a new window for true "viewing" and professional printing
    const reportWindow = window.open('', '_blank', 'width=1000,height=900,scrollbars=yes');
    if (!reportWindow) {
        toast('❌ Popup blocked! Please allow popups to view report.');
        return;
    }

    reportWindow.document.write(html);
    reportWindow.document.close();

    // Add a listener to trigger print automatically after images load if the user wants
    toast('✅ Report opened in new tab');
});

$('btnSendReportLab')?.addEventListener('click', () => {
    const dx = $('primaryDx').value;
    const grade = $('histoGrade').value;
    const msg = `RELEASED REPORT SUMMARY:\nDx: ${dx}\nGrade: ${grade}\nSnapshots: ${state.evidencePack.length} items included in final file.`;

    // Attach all evidence to this lab message
    state.attachedToMessage = [...state.evidencePack];
    const previews = $('attachPreviews');
    previews.innerHTML = '';
    state.attachedToMessage.forEach(ev => {
        const el = document.createElement('div');
        el.className = 'attach-preview-item';
        el.textContent = `📸 ${ev.label}`;
        previews.appendChild(el);
    });

    addTimelineMsg('Dr. R. Singh', 'path', msg, ['Full Report Export']);
    toast('📤 Report summary & evidence sent to lab');
    switchView('lab');
});

$('btnQueryLab').addEventListener('click', () => { switchView('lab'); });
$('btnSecondOpinion').addEventListener('click', () => toast('👥 Second opinion request sent'));
$('btnSignOut').addEventListener('click', () => {
    $('signoutDate').textContent = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
    $('signoutModal').classList.remove('hidden');
});
$('cancelSignout').addEventListener('click', () => $('signoutModal').classList.add('hidden'));
$('confirmSignout').addEventListener('click', () => {
    $('signoutModal').classList.add('hidden');
    toast('✅ Report signed and released');
});

$('micBtn').addEventListener('click', () => {
    $('micBtn').classList.toggle('active');
    toast($('micBtn').classList.contains('active') ? '🎙️ Voice dictation active (simulated)' : '⏹ Dictation stopped');
});

// ─── Lab Communication ────────────────────────────────────
document.querySelectorAll('.priority-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.priority-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.priority = btn.dataset.p;
        const badge = qs('.priority-badge', $('labHeader') || document);
        if (badge) { badge.className = `priority-badge ${state.priority}`; badge.textContent = state.priority.toUpperCase(); }
    });
});

$('attachEvidence').addEventListener('click', () => {
    if (!state.evidencePack.length) { toast('❌ No evidence in pack yet — capture a snapshot first'); return; }
    const last = state.evidencePack[state.evidencePack.length - 1];
    attachEvidenceToLab(last);
    toast(`📸 "${last.label}" attached`);
});

$('attachAnnotation').addEventListener('click', () => {
    const el = document.createElement('div');
    el.className = 'attach-preview-item';
    el.textContent = `🖊 Annotation overlay (${state.annotations.length} layers)`;
    $('attachPreviews').appendChild(el);
    toast('🖊 Annotation overlay attached');
});

$('sendToLab').addEventListener('click', () => {
    const text = $('composerText').value.trim();
    if (!text) { toast('❌ Please enter a message'); return; }
    const types = [];
    if ($('cbMissing').checked) types.push('Missing clinical info');
    if ($('cbStain').checked) types.push('Additional stain request');
    if ($('cbQuality').checked) types.push('Quality issue');

    addTimelineMsg('Dr. R. Singh', 'path', text, types);

    $('composerText').value = '';
    $('attachPreviews').innerHTML = '';
    state.attachedToMessage = [];
    toast(`📤 Message sent to lab${state.priority === 'urgent' ? ' (URGENT)' : ''}`);

    // Update pending list
    const pending = $('labSnapshots');
    if (pending) {
        const el = document.createElement('div');
        el.style.cssText = 'font-size:11px;color:var(--text-secondary);padding:5px 8px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;margin-bottom:4px;';
        el.textContent = `📨 "${text.substring(0, 40)}…" sent`;
        pending.prepend(el);
        const empty = pending.querySelector('.snap-empty');
        if (empty) empty.remove();
    }
    $('labBadge').textContent = parseInt($('labBadge').textContent) + 1;
});

function addTimelineMsg(name, role, text, types = []) {
    const timeline = $('labTimeline');
    const t = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    const cls = role === 'path' ? 'path-msg' : 'lab-msg';
    const avCls = role === 'path' ? 'path-av' : 'lab-av';
    const avTxt = role === 'path' ? 'PATH' : 'LAB';
    const typeLine = types.length ? `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">${types.join(' · ')}</div>` : '';

    const prevItems = $('attachPreviews').querySelectorAll('.attach-preview-item');
    const attachHTML = prevItems.length
        ? `<div class="ev-attach">📎 ${Array.from(prevItems).map(p => p.textContent).join(', ')}</div>`
        : '';

    const div = document.createElement('div');
    div.className = `timeline-item ${cls}`;
    div.innerHTML = `
    <div class="tl-avatar ${avCls}">${avTxt}</div>
    <div class="tl-bubble">
      <div class="tl-header"><strong>${esc(name)}</strong><span class="tl-time">${t}</span></div>
      ${typeLine}<p>${esc(text)}</p>${attachHTML}
    </div>`;
    timeline.appendChild(div);
    timeline.scrollTop = timeline.scrollHeight;

    // Also add to report thread mini
    const miniThread = $('reportLabThread');
    const mini = document.createElement('div');
    mini.className = `thread-item ${role === 'path' ? 'path' : 'lab'}`;
    mini.innerHTML = `<span class="thread-who">${avTxt}</span><span class="thread-msg">${esc(text.substring(0, 50))}</span>`;
    miniThread.appendChild(mini);
}

// ─── Helpers ─────────────────────────────────────────────
function fmtBytes(b) {
    if (!b) return '0 B';
    const k = 1024, s = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(k));
    return `${(b / Math.pow(k, i)).toFixed(1)} ${s[i]}`;
}

function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function throttle(fn, ms) {
    let last = 0;
    return (...a) => { const n = Date.now(); if (n - last >= ms) { last = n; fn(...a); } };
}

// ─── Init ─────────────────────────────────────────────────
$('refreshBtn').addEventListener('click', refreshSlideList);
refreshSlideList();
updateEvidenceBadge();
