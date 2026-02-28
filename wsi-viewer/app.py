import os
import io
import json
import math
import numpy as np
import openslide
from openslide import OpenSlide
from openslide.deepzoom import DeepZoomGenerator
from flask import Flask, request, jsonify, send_file, render_template, abort
from flask_cors import CORS
from werkzeug.utils import secure_filename
from PIL import Image

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'uploads')
ALLOWED_EXTENSIONS = {'svs', 'tif', 'tiff', 'ndpi', 'vms', 'vmu', 'scn', 'mrxs', 'svslide', 'bif'}

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 10 * 1024 * 1024 * 1024  # 10 GB max

# Store open slides {filename: OpenSlide}
_slide_cache = {}
_dz_cache = {}
_heatmap_cache = {}   # filename → heatmap JSON dict (computed once per slide)


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def get_slide(filename):
    if filename not in _slide_cache:
        path = os.path.join(UPLOAD_FOLDER, filename)
        if not os.path.exists(path):
            return None, None
        slide = OpenSlide(path)
        dz = DeepZoomGenerator(slide, tile_size=256, overlap=1, limit_bounds=True)
        _slide_cache[filename] = slide
        _dz_cache[filename] = dz
    return _slide_cache[filename], _dz_cache[filename]


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/login')
def login():
    return render_template('login.html')

@app.route('/histolab')
def histolab():
    return render_template('histolab.html')


@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400

    if not allowed_file(file.filename):
        return jsonify({'error': 'File type not allowed'}), 400

    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)

    # Open slide and get metadata
    try:
        slide = OpenSlide(filepath)
        dz = DeepZoomGenerator(slide, tile_size=256, overlap=1, limit_bounds=True)
        _slide_cache[filename] = slide
        _dz_cache[filename] = dz

        w, h = slide.dimensions
        props = dict(slide.properties)

        # Extract common metadata
        metadata = {
            'filename': filename,
            'width': w,
            'height': h,
            'level_count': slide.level_count,
            'level_dimensions': [list(d) for d in slide.level_dimensions],
            'level_downsamples': list(slide.level_downsamples),
            'vendor': props.get('openslide.vendor', 'Unknown'),
            'mpp_x': props.get('openslide.mpp-x', None),
            'mpp_y': props.get('openslide.mpp-y', None),
            'objective_power': props.get('openslide.objective-power', None),
            'dz_levels': dz.level_count,
            'dz_level_tiles': [[c for c in dz.level_tiles[i]] for i in range(dz.level_count)],
            'tile_size': 256,
            'overlap': 1,
        }
        return jsonify({'success': True, 'metadata': metadata})
    except Exception as e:
        os.remove(filepath)
        return jsonify({'error': str(e)}), 500


@app.route('/api/slides', methods=['GET'])
def list_slides():
    files = []
    for f in os.listdir(UPLOAD_FOLDER):
        if allowed_file(f):
            filepath = os.path.join(UPLOAD_FOLDER, f)
            size = os.path.getsize(filepath)
            files.append({'filename': f, 'size': size})
    return jsonify({'slides': files})


@app.route('/api/slide/<filename>/metadata', methods=['GET'])
def slide_metadata(filename):
    filename = secure_filename(filename)
    slide, dz = get_slide(filename)
    if slide is None:
        abort(404)

    w, h = slide.dimensions
    props = dict(slide.properties)

    metadata = {
        'filename': filename,
        'width': w,
        'height': h,
        'level_count': slide.level_count,
        'level_dimensions': [list(d) for d in slide.level_dimensions],
        'level_downsamples': list(slide.level_downsamples),
        'vendor': props.get('openslide.vendor', 'Unknown'),
        'mpp_x': props.get('openslide.mpp-x', None),
        'mpp_y': props.get('openslide.mpp-y', None),
        'objective_power': props.get('openslide.objective-power', None),
        'dz_levels': dz.level_count,
        'dz_level_tiles': [[c for c in dz.level_tiles[i]] for i in range(dz.level_count)],
        'tile_size': 256,
        'overlap': 1,
    }
    return jsonify(metadata)


@app.route('/api/slide/<filename>/thumbnail', methods=['GET'])
def slide_thumbnail(filename):
    filename = secure_filename(filename)
    slide, _ = get_slide(filename)
    if slide is None:
        abort(404)

    width = int(request.args.get('width', 512))
    height = int(request.args.get('height', 512))

    thumb = slide.get_thumbnail((width, height))
    buf = io.BytesIO()
    thumb.save(buf, format='JPEG', quality=85)
    buf.seek(0)
    return send_file(buf, mimetype='image/jpeg')


@app.route('/api/slide/<filename>/tile/<int:level>/<int:col>/<int:row>', methods=['GET'])
def get_tile(filename, level, col, row):
    filename = secure_filename(filename)
    slide, dz = get_slide(filename)
    if slide is None:
        abort(404)

    try:
        tile = dz.get_tile(level, (col, row))
        buf = io.BytesIO()
        tile.save(buf, format='JPEG', quality=85)
        buf.seek(0)
        return send_file(buf, mimetype='image/jpeg')
    except Exception as e:
        abort(404)


@app.route('/api/slide/<filename>/region', methods=['GET'])
def get_region(filename):
    """Get a specific region at a given level."""
    filename = secure_filename(filename)
    slide, _ = get_slide(filename)
    if slide is None:
        abort(404)

    try:
        x = int(request.args.get('x', 0))
        y = int(request.args.get('y', 0))
        level = int(request.args.get('level', 0))
        w = int(request.args.get('w', 512))
        h = int(request.args.get('h', 512))

        region = slide.read_region((x, y), level, (w, h))
        region = region.convert('RGB')
        buf = io.BytesIO()
        region.save(buf, format='JPEG', quality=85)
        buf.seek(0)
        return send_file(buf, mimetype='image/jpeg')
    except Exception as e:
        abort(400)


# ─── Real Heatmap from Slide ──────────────────────────────────────────────────
@app.route('/api/slide/<filename>/heatmap', methods=['GET'])
def slide_heatmap(filename):
    """
    Analyses actual H&E slide content and returns a 2-D heatmap.
    Each cell value (0-1) combines:
      - tissue_fraction  : non-white (non-background) pixels
      - nuclear_density  : dark purple hematoxylin (nuclei)
      - eosin_fraction   : pink cytoplasm / stroma
    """
    filename = secure_filename(filename)
    slide, _ = get_slide(filename)
    if slide is None:
        return jsonify({'error': 'Slide not found'}), 404

    try:
        # ── Serve from cache if already computed ───────────────────────────
        if filename in _heatmap_cache:
            return jsonify(_heatmap_cache[filename])

        # ── 1. Fetch a manageable thumbnail ──────────────────────────────────
        THUMB_SIZE   = 256          # px – fast enough for large SVS files
        GRID_ROWS    = 32
        GRID_COLS    = 32

        thumb = slide.get_thumbnail((THUMB_SIZE, THUMB_SIZE))
        img   = np.array(thumb.convert('RGB'), dtype=np.float32)

        th, tw = img.shape[:2]

        cell_h = max(1, th // GRID_ROWS)
        cell_w = max(1, tw // GRID_COLS)

        # ── 2. Per-cell analysis ─────────────────────────────────────────────
        heatmap = []
        for row_i in range(GRID_ROWS):
            row_data = []
            for col_j in range(GRID_COLS):
                y1 = row_i * cell_h
                y2 = min(th, y1 + cell_h)
                x1 = col_j * cell_w
                x2 = min(tw, x1 + cell_w)
                if y2 <= y1 or x2 <= x1:
                    row_data.append(0.0)
                    continue

                cell = img[y1:y2, x1:x2]
                R, G, B = cell[:,:,0], cell[:,:,1], cell[:,:,2]
                brightness = (R + G + B) / 3.0
                n_pixels   = brightness.size

                # Background: very bright / white glass
                bg_mask   = brightness > 218
                tissue_frac = 1.0 - (bg_mask.sum() / n_pixels)

                # Nuclear / hematoxylin: dark + bluish-purple
                # Characteristic: low R, relatively higher B than G, dark
                hem_mask = (
                    (brightness < 160) &
                    (B > R * 0.85) &
                    (~bg_mask)
                )
                nuclear_frac = hem_mask.sum() / n_pixels

                # Eosin (cytoplasm/stroma): pink-red, moderate brightness
                eosin_mask = (
                    (R > G + 10) & (R > B + 10) &
                    (brightness > 100) & (brightness < 220) &
                    (~bg_mask)
                )
                eosin_frac = eosin_mask.sum() / n_pixels

                # Combine – weight nuclear more as it indicates high-density areas
                score = (
                    0.35 * tissue_frac +
                    0.50 * min(1.0, nuclear_frac * 6) +
                    0.15 * min(1.0, eosin_frac * 2)
                )
                row_data.append(round(float(np.clip(score, 0.0, 1.0)), 4))
            heatmap.append(row_data)

        # ── 3. Smooth heatmap (3x3 box blur) ─────────────────────────────────
        arr = np.array(heatmap, dtype=np.float32)
        kernel = np.ones((3, 3), dtype=np.float32) / 9.0
        # Manual 2-D convolution with reflect padding
        pad = np.pad(arr, 1, mode='reflect')
        smoothed = np.zeros_like(arr)
        for di in range(3):
            for dj in range(3):
                smoothed += kernel[di, dj] * pad[di:di+GRID_ROWS, dj:dj+GRID_COLS]

        # ── 4. Normalise to 0-1 ───────────────────────────────────────────────
        mn, mx = smoothed.min(), smoothed.max()
        if mx > mn:
            smoothed = (smoothed - mn) / (mx - mn)

        result = {
            'heatmap'   : smoothed.tolist(),
            'grid'      : [GRID_ROWS, GRID_COLS],
            'slide_dims': list(slide.dimensions),
        }
        _heatmap_cache[filename] = result   # cache for subsequent requests
        return jsonify(result)

    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'trace': traceback.format_exc()}), 500


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5050, threaded=True)
