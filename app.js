/* ══════════════════════════════════════════════════════════
   GLOBAL DISASTER MONITOR — app.js
   ══════════════════════════════════════════════════════════ */
const COLORS = { eq: '#ff2d55', wf: '#ff9500', fl: '#30a0ff', st: '#b06bff' };
const TYPE_LABEL = { eq: 'QUAKE', st: 'STORM', wf: 'FIRE', fl: 'FLOOD' };
const TYPE_KICKER = { eq: 'EARTHQUAKE · USGS', st: 'SEVERE STORM · NASA EONET',
                      wf: 'WILDFIRE · NASA EONET', fl: 'FLOOD · EONET/GDACS' };
const TYPE_ICON = { eq: '🌍', st: '🌀', wf: '🔥', fl: '🌊' };
const REFRESH_MS = 300000;
const EMPTY = { type: 'FeatureCollection', features: [] };

const API = {
  quake: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  storm: 'https://eonet.gsfc.nasa.gov/api/v3/events?category=severeStorms&status=open&days=30',
  fire:  'https://eonet.gsfc.nasa.gov/api/v3/events?category=wildfires&status=open&days=30',
  flood: 'https://eonet.gsfc.nasa.gov/api/v3/events?category=floods&status=open&days=90',
  gdacs: 'result.geojson'
};

const EQ_RAMP = [
  [0, '#ffe98a'], [2, '#ffd45c'], [3, '#ffab2e'], [4, '#ff7a2f'],
  [5, '#ff4a3d'], [6, '#ff2d55'], [7, '#e0148c'], [8.5, '#b41ec8']
];
const eqColorExpr = ['interpolate', ['linear'], ['coalesce', ['get', 'mag'], 0], ...EQ_RAMP.flat()];
function eqColorJS(mag) {
  const m = Number(mag) || 0;
  for (let i = EQ_RAMP.length - 1; i >= 0; i--) if (m >= EQ_RAMP[i][0]) return EQ_RAMP[i][1];
  return EQ_RAMP[0][1];
}

/* ══════════════════════════════════════════════════════════
   GEO UTILS
   ══════════════════════════════════════════════════════════ */
function normLon(v) {
  let x = Number(v);
  if (!isFinite(x)) return null;
  return ((x + 180) % 360 + 360) % 360 - 180;
}
function normLat(v) {
  const y = Number(v);
  if (!isFinite(y) || y < -90.0001 || y > 90.0001) return null;
  return Math.max(-90, Math.min(90, y));
}
function safeLngLat(lng, lat) {
  const x = normLon(lng), y = normLat(lat);
  if (x === null || y === null) return null;
  if (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9) return null;
  return [x, y];
}
function ringCentroid(ring) {
  if (!Array.isArray(ring) || !ring.length) return null;
  let min = Infinity, max = -Infinity;
  for (const p of ring) {
    const x = Number(p && p[0]);
    if (!isFinite(x)) continue;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  const shift = (max - min) > 180;
  let sx = 0, sy = 0, n = 0;
  for (const p of ring) {
    let x = Number(p && p[0]); const y = Number(p && p[1]);
    if (!isFinite(x) || !isFinite(y)) continue;
    if (shift && x < 0) x += 360;
    sx += x; sy += y; n++;
  }
  if (!n) return null;
  return safeLngLat(sx / n, sy / n);
}
function extractPoint(geom) {
  if (!geom || !geom.coordinates) return null;
  const c = geom.coordinates;
  switch (geom.type) {
    case 'Point': {
      const ll = safeLngLat(c[0], c[1]);
      if (!ll) return null;
      const depth = Number(c[2]);
      return { lng: ll[0], lat: ll[1], depth: isFinite(depth) ? depth : null };
    }
    case 'MultiPoint':
    case 'LineString': {
      const ll = ringCentroid(c);
      return ll ? { lng: ll[0], lat: ll[1], depth: null } : null;
    }
    case 'Polygon': {
      const ll = ringCentroid(c[0]);
      return ll ? { lng: ll[0], lat: ll[1], depth: null } : null;
    }
    case 'MultiPolygon': {
      const ll = ringCentroid(c[0] && c[0][0]);
      return ll ? { lng: ll[0], lat: ll[1], depth: null } : null;
    }
    default: return null;
  }
}
function unwrapLine(coords) {
  const out = []; let prev = null;
  for (const c of coords) {
    const ll = safeLngLat(c[0], c[1]);
    if (!ll) continue;
    let lng = ll[0];
    if (prev !== null) {
      while (lng - prev > 180) lng -= 360;
      while (prev - lng > 180) lng += 360;
    }
    out.push([lng, ll[1]]); prev = lng;
  }
  return out;
}
function angularDist(lat1, lon1, lat2, lon2) {
  const R = Math.PI / 180;
  const a = lat1 * R, b = lat2 * R, d = (lon2 - lon1) * R;
  const v = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(d);
  return Math.acos(Math.max(-1, Math.min(1, v))) / R;
}
function stormCat(kts) {
  if (kts == null || isNaN(kts)) return { label: 'Storm System', short: 'STORM', color: '#b06bff', rank: 0 };
  if (kts < 34)  return { label: 'Tropical Depression', short: 'TD', color: '#5ec8ff', rank: 1 };
  if (kts < 64)  return { label: 'Tropical Storm',      short: 'TS', color: '#7dffb0', rank: 2 };
  if (kts < 83)  return { label: 'Category 1',          short: 'C1', color: '#ffe066', rank: 3 };
  if (kts < 96)  return { label: 'Category 2',          short: 'C2', color: '#ffb84d', rank: 4 };
  if (kts < 113) return { label: 'Category 3',          short: 'C3', color: '#ff7a45', rank: 5 };
  if (kts < 137) return { label: 'Category 4',          short: 'C4', color: '#ff3b6b', rank: 6 };
  return               { label: 'Category 5',           short: 'C5', color: '#d633ff', rank: 7 };
}
function timeAgo(iso) {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff)) return '-';
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'เมื่อสักครู่';
  if (m < 60) return `${m} นาทีที่แล้ว`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ชม.ที่แล้ว`;
  return `${Math.floor(h / 24)} วันที่แล้ว`;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const $ = id => document.getElementById(id);

/* ══════════════════════════════════════════════════════════
   BASEMAP THEMES
   ══════════════════════════════════════════════════════════ */
const THEMES = {
  news: {
    bg: '#1d3049', landcover: '#24405c', water: '#0b1b30', waterway: '#1a4972',
    roadMinor: 'rgba(255,255,255,0.10)', roadMajor: 'rgba(255,255,255,0.22)',
    boundary: 'rgba(150,200,255,0.55)', boundaryState: 'rgba(255,255,255,0.14)',
    building: '#2a4361',
    labelCity: 'rgba(232,242,255,0.9)', labelCountry: 'rgba(198,222,255,0.78)', halo: '#0c1a2b',
    sky: '#14304f', horizon: '#3a6ea5', fog: '#16283f'
  },
  midnight: {
    bg: '#070d18', landcover: '#0c1622', water: '#050b16', waterway: '#0f2a44',
    roadMinor: 'rgba(255,255,255,0.06)', roadMajor: 'rgba(255,255,255,0.12)',
    boundary: 'rgba(120,165,225,0.32)', boundaryState: 'rgba(255,255,255,0.07)',
    building: '#111d2e',
    labelCity: 'rgba(190,210,245,0.62)', labelCountry: 'rgba(170,195,235,0.5)', halo: '#05080f',
    sky: '#08172a', horizon: '#1e3358', fog: '#070d18'
  },
  graphite: {
    bg: '#2b3138', landcover: '#333a42', water: '#1a1f26', waterway: '#2c3a48',
    roadMinor: 'rgba(255,255,255,0.13)', roadMajor: 'rgba(255,255,255,0.26)',
    boundary: 'rgba(215,225,240,0.5)', boundaryState: 'rgba(255,255,255,0.15)',
    building: '#3a424b',
    labelCity: 'rgba(240,244,250,0.9)', labelCountry: 'rgba(220,228,240,0.8)', halo: '#20252b',
    sky: '#26303c', horizon: '#4a5a6b', fog: '#252b33'
  },
  satellite: {
    raster: true, bg: '#0a1420',
    labelCity: 'rgba(255,255,255,0.95)', labelCountry: 'rgba(255,255,255,0.85)', halo: 'rgba(0,0,0,0.85)',
    boundary: 'rgba(255,255,255,0.5)', boundaryState: 'rgba(255,255,255,0.2)',
    sky: '#0e2338', horizon: '#2c5b8f', fog: '#0a1420'
  }
};

const STYLE = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
    esriImagery: {
      type: 'raster',
      tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256, maxzoom: 17, attribution: 'Imagery &copy; Esri'
    },
    esriDark: {
      type: 'raster',
      tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256, maxzoom: 16, attribution: 'Tiles &copy; Esri'
    }
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#1d3049' } },
    { id: 'raster-imagery', type: 'raster', source: 'esriImagery',
      layout: { visibility: 'none' }, paint: { 'raster-opacity': 1, 'raster-saturation': -0.12 } },
    { id: 'raster-dark', type: 'raster', source: 'esriDark',
      layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.9, 'raster-saturation': -0.2 } },

    { id: 'landcover', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover',
      paint: { 'fill-color': '#24405c', 'fill-opacity': 0.45 } },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'], paint: { 'fill-color': '#0b1b30' } },
    { id: 'waterway', type: 'line', source: 'openmaptiles', 'source-layer': 'waterway', minzoom: 5,
      paint: { 'line-color': '#1a4972', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 12, 2] } },
    { id: 'road-minor', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 10,
      paint: { 'line-color': 'rgba(255,255,255,0.10)', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 16, 3] } },
    { id: 'road-major', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 5,
      filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
      paint: { 'line-color': 'rgba(255,255,255,0.22)', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 14, 3] } },
    { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14,
      paint: { 'fill-color': '#2a4361', 'fill-opacity': 0.6 } },

    { id: 'boundary-state', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary', minzoom: 4,
      filter: ['==', ['get', 'admin_level'], 4],
      paint: { 'line-color': 'rgba(255,255,255,0.14)', 'line-width': 0.7 } },
    { id: 'boundary-country', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary',
      filter: ['<=', ['get', 'admin_level'], 2],
      paint: { 'line-color': 'rgba(150,200,255,0.55)',
               'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.6, 6, 1.5], 'line-opacity': 0.95 } },

    { id: 'label-country', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', maxzoom: 8,
      filter: ['==', ['get', 'class'], 'country'],
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9.5, 6, 14],
        'text-transform': 'uppercase', 'text-letter-spacing': 0.14
      },
      paint: { 'text-color': 'rgba(198,222,255,0.78)', 'text-halo-color': '#0c1a2b', 'text-halo-width': 1.4 } },
    { id: 'label-city', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place', minzoom: 3.5,
      filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
      layout: {
        'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 3.5, 10, 12, 14.5]
      },
      paint: { 'text-color': 'rgba(232,242,255,0.9)', 'text-halo-color': '#0c1a2b', 'text-halo-width': 1.4 } }
  ]
};

const VECTOR_BASE = ['landcover','water','waterway','road-minor','road-major','building'];
const LABEL_LAYERS = ['label-country','label-city'];

/* ══════════════════════════════════════════════════════════
   MAP INIT (mobile-aware)
   ══════════════════════════════════════════════════════════ */
const isPhone = () => window.matchMedia('(max-width: 760px)').matches;

/* ที่ zoom z ลูกโลกกว้าง ≈ 512·2^z px → หาค่า z ที่พอดีจอ */
function globeFitZoom() {
  const el = $('map');
  const w = el.clientWidth || window.innerWidth;
  const h = el.clientHeight || window.innerHeight;
  const usableH = h - (isPhone() ? 110 : 90);
  const s = Math.min(w, Math.max(usableH, 180));
  const z = Math.log2((s * 0.86) / 512);
  return Math.max(0.15, Math.min(2.4, z));
}

const map = new maplibregl.Map({
  container: 'map',
  style: STYLE,
  center: [100.5018, 13.7563],
  zoom: globeFitZoom(),
  minZoom: 0,
  maxZoom: 14,
  dragRotate: false, pitchWithRotate: false, touchPitch: false,
  attributionControl: { compact: true }
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

function setPaint(id, prop, val) {
  if (val != null && map.getLayer(id)) { try { map.setPaintProperty(id, prop, val); } catch (e) {} }
}
function setVis(id, v) {
  if (map.getLayer(id)) { try { map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none'); } catch (e) {} }
}
function setVisible(ids, v) { ids.forEach(id => setVis(id, v)); }

function applyLabelVisibility() {
  setVisible(LABEL_LAYERS, $('labelToggle').checked);
}

function applyTheme(key) {
  const t = THEMES[key] || THEMES.news;
  const isSat = !!t.raster;

  setVis('raster-imagery', isSat);
  setVis('raster-dark', false);
  VECTOR_BASE.forEach(id => setVis(id, !isSat));

  setPaint('bg', 'background-color', t.bg);
  if (!isSat) {
    setPaint('landcover', 'fill-color', t.landcover);
    setPaint('water', 'fill-color', t.water);
    setPaint('waterway', 'line-color', t.waterway);
    setPaint('road-minor', 'line-color', t.roadMinor);
    setPaint('road-major', 'line-color', t.roadMajor);
    setPaint('building', 'fill-color', t.building);
  }
  setPaint('boundary-country', 'line-color', t.boundary);
  setPaint('boundary-state', 'line-color', t.boundaryState);
  setPaint('label-city', 'text-color', t.labelCity);
  setPaint('label-city', 'text-halo-color', t.halo);
  setPaint('label-country', 'text-color', t.labelCountry);
  setPaint('label-country', 'text-halo-color', t.halo);

  try {
    map.setSky({
      'sky-color': t.sky, 'sky-horizon-blend': 0.6,
      'horizon-color': t.horizon, 'horizon-fog-blend': 0.7,
      'fog-color': t.fog, 'fog-ground-blend': 0.85,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.4, 8, 0]
    });
  } catch (e) {}

  document.body.style.background = t.bg;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.bg);
  applyLabelVisibility();
}

let autoFellBack = false;
map.on('error', e => {
  if (!autoFellBack && e && e.sourceId === 'openmaptiles') {
    autoFellBack = true;
    console.warn('Vector tiles มีปัญหา → ใช้ raster สำรอง');
    VECTOR_BASE.forEach(id => setVis(id, false));
    setVis('raster-dark', true);
  }
  const msg = String((e && e.error && e.error.message) || '');
  if (msg.includes('glyph') || msg.includes('font')) {
    LABEL_LAYERS.forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
  }
});

/* ══════════════════════════════════════════════════════════
   DATA LAYERS
   ══════════════════════════════════════════════════════════ */
const styleReady = new Promise(resolve => {
  map.on('style.load', () => {
    try { map.setProjection({ type: 'globe' }); } catch (e) { console.warn('Globe ไม่รองรับ:', e); }
    applyTheme('news');
    initLayers();
    resolve();
  });
});

function initLayers() {
  ['eq', 'wf', 'fl', 'st', 'sttrack'].forEach(k => map.addSource(k, { type: 'geojson', data: EMPTY }));

  map.addLayer({ id: 'st-track-glow', type: 'line', source: 'sttrack',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'],
             'line-width': ['interpolate', ['linear'], ['zoom'], 1, 5, 6, 12],
             'line-opacity': 0.16, 'line-blur': 4 } });
  map.addLayer({ id: 'st-track', type: 'line', source: 'sttrack',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'],
             'line-width': ['interpolate', ['linear'], ['zoom'], 1, 1.4, 6, 3],
             'line-opacity': 0.8, 'line-dasharray': [2.5, 1.6] } });

  map.addLayer({ id: 'fl-glow', type: 'circle', source: 'fl',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 9, 6, 20],
             'circle-color': COLORS.fl, 'circle-opacity': 0.18, 'circle-blur': 1 } });
  map.addLayer({ id: 'fl-core', type: 'circle', source: 'fl',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 4, 6, 8],
             'circle-color': COLORS.fl, 'circle-opacity': 0.92,
             'circle-stroke-width': 1.3, 'circle-stroke-color': 'rgba(255,255,255,0.8)' } });

  map.addLayer({ id: 'wf-heat', type: 'heatmap', source: 'wf', maxzoom: 7,
    paint: {
      'heatmap-weight': 0.55,
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 1, 0.7, 6, 2.2],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(0,0,0,0)', 0.15, 'rgba(110,30,0,0.4)', 0.35, 'rgba(190,65,0,0.6)',
        0.55, 'rgba(255,125,0,0.75)', 0.75, '#ff9500', 0.9, '#ffc247', 1, '#fff3c9'],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 1, 9, 4, 22, 7, 40],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 4.5, 0.9, 7, 0]
    } });
  map.addLayer({ id: 'wf-glow', type: 'circle', source: 'wf', minzoom: 4,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 7, 8, 16],
             'circle-color': COLORS.wf, 'circle-blur': 1,
             'circle-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0, 6, 0.18] } });
  map.addLayer({ id: 'wf-core', type: 'circle', source: 'wf', minzoom: 4,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 8, 7],
             'circle-color': COLORS.wf,
             'circle-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0, 5.5, 0.94],
             'circle-stroke-width': 1, 'circle-stroke-color': 'rgba(255,255,255,0.75)',
             'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 4, 0, 5.5, 1] } });

  map.addLayer({ id: 'st-glow', type: 'circle', source: 'st',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'],
               1, ['interpolate', ['linear'], ['coalesce', ['get','kts'], 0], 0, 10, 60, 20, 140, 34],
               6, ['interpolate', ['linear'], ['coalesce', ['get','kts'], 0], 0, 20, 60, 42, 140, 72]],
             'circle-color': ['get', 'color'], 'circle-opacity': 0.16, 'circle-blur': 1 } });
  map.addLayer({ id: 'st-core', type: 'circle', source: 'st',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'],
               1, ['interpolate', ['linear'], ['coalesce', ['get','kts'], 0], 0, 4, 60, 9, 140, 15],
               6, ['interpolate', ['linear'], ['coalesce', ['get','kts'], 0], 0, 8, 60, 18, 140, 30]],
             'circle-color': ['get', 'color'], 'circle-opacity': 0.93,
             'circle-stroke-width': 1.6, 'circle-stroke-color': 'rgba(255,255,255,0.88)',
             'circle-sort-key': ['*', -1, ['coalesce', ['get','kts'], 0]] } });

  map.addLayer({ id: 'eq-glow', type: 'circle', source: 'eq',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        1, ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 0, 5, 5, 20, 8, 44],
        6, ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 0, 10, 5, 42, 8, 88]],
      'circle-color': eqColorExpr,
      'circle-opacity': ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 0, 0.07, 4, 0.15, 7, 0.3],
      'circle-blur': 1
    } });
  map.addLayer({ id: 'eq-ring', type: 'circle', source: 'eq',
    filter: ['>=', ['coalesce', ['get','mag'], 0], 4.5],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        1, ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 4.5, 11, 7, 22, 9, 30],
        6, ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 4.5, 22, 7, 44, 9, 60]],
      'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 1.2,
      'circle-stroke-color': eqColorExpr, 'circle-stroke-opacity': 0.55
    } });
  map.addLayer({ id: 'eq-core', type: 'circle', source: 'eq',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        1, ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 0, 2, 3, 4.5, 5, 9, 7, 15, 9, 22],
        6, ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 0, 4, 3, 9, 5, 18, 7, 30, 9, 44]],
      'circle-color': eqColorExpr,
      'circle-opacity': ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 0, 0.72, 4, 0.9, 6, 1],
      'circle-stroke-width': ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 0, 0.6, 4, 1.2, 6, 2.2],
      'circle-stroke-color': ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0],
        0, 'rgba(255,255,255,0.35)', 4, 'rgba(255,255,255,0.7)', 6, 'rgba(255,255,255,0.98)'],
      'circle-sort-key': ['*', -1, ['coalesce', ['get','mag'], 0]]
    } });
  map.addLayer({ id: 'eq-hot', type: 'circle', source: 'eq',
    filter: ['>=', ['coalesce', ['get','mag'], 0], 6],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        1, ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 6, 3, 9, 7],
        6, ['interpolate', ['linear'], ['coalesce', ['get','mag'], 0], 6, 6, 9, 14]],
      'circle-color': '#fff6d8', 'circle-opacity': 0.95, 'circle-blur': 0.35
    } });

  ['eq-core', 'st-core', 'wf-core', 'fl-core'].forEach(id => {
    map.on('mouseenter', id, () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', id, () => map.getCanvas().style.cursor = '');
    map.on('click', id, e => { if (!BC.on) showPopup(featToEvent(e.features[0])); });
  });
}

/* ══════════════════════════════════════════════════════════
   PULSE + occlusion
   ══════════════════════════════════════════════════════════ */
let pulseMarkers = [];
let isGlobe = true;

function renderPulses(features) {
  pulseMarkers.forEach(p => p.marker.remove());
  pulseMarkers = [];
  const scale = isPhone() ? 0.75 : 1;
  features.filter(f => (f.properties.mag || 0) >= 5).forEach(f => {
    const mag = f.properties.mag;
    const size = (28 + (mag - 5) * 11) * scale;
    const col = eqColorJS(mag);
    const [lng, lat] = f.geometry.coordinates;
    const el = document.createElement('div');
    el.className = 'pulse-marker';
    el.style.color = col;
    el.innerHTML = `
      <div class="pulse-ring" style="width:${size}px;height:${size}px;left:${-size/2}px;top:${-size/2}px;"></div>
      <div class="pulse-ring" style="width:${size}px;height:${size}px;left:${-size/2}px;top:${-size/2}px;"></div>`;
    const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([lng, lat]).addTo(map);
    pulseMarkers.push({ marker, mag, lng, lat });
  });
  updateOcclusion();
}
function updateOcclusion() {
  if (!pulseMarkers.length) return;
  const c = map.getCenter();
  const near = map.getZoom() > 5;
  pulseMarkers.forEach(p => {
    const vis = (!isGlobe || near) ? true : angularDist(c.lat, c.lng, p.lat, p.lng) < 87;
    p.marker.getElement().style.visibility = vis ? 'visible' : 'hidden';
  });
}
map.on('move', updateOcclusion);
map.on('zoom', updateOcclusion);

function syncPulses() {
  const minMag = parseFloat($('magFilter').value);
  const on = $('eqToggle').checked;
  pulseMarkers.forEach(p => {
    p.marker.getElement().style.display = (on && p.mag >= minMag) ? '' : 'none';
  });
  updateOcclusion();
}

/* ══════════════════════════════════════════════════════════
   EVENT MODEL + POPUP
   ══════════════════════════════════════════════════════════ */
let allEvents = [];
let activePopup = null;

function featToEvent(f) {
  const p = f.properties || {};
  const c = f.geometry.coordinates;
  return {
    id: p.id, type: p.type, title: p.title,
    lng: Number(c[0]), lat: Number(c[1]),
    depth: p.depth != null ? Number(p.depth) : null,
    mag: p.mag != null ? Number(p.mag) : null,
    kts: p.kts != null ? Number(p.kts) : null,
    time: p.time || p.date,
    place: p.place, location: p.location, url: p.url
  };
}
function eventColor(ev) {
  return ev.type === 'eq' ? eqColorJS(ev.mag)
       : ev.type === 'st' ? stormCat(ev.kts).color : COLORS[ev.type];
}

function showPopup(ev) {
  if (activePopup) activePopup.remove();
  const plusCode = (typeof OpenLocationCode !== 'undefined')
    ? OpenLocationCode.encode(ev.lat, ev.lng, 10) : `${ev.lat},${ev.lng}`;
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(plusCode)}`;
  const coordLine = `<span class="pop-meta">${ev.lat.toFixed(3)}°, ${ev.lng.toFixed(3)}°</span>`;
  let html;

  if (ev.type === 'eq') {
    const col = eqColorJS(ev.mag);
    html = `
      <div class="pop-title" style="color:${col};">🌍 Magnitude ${ev.mag ?? '-'}</div>
      <div style="margin-bottom:7px;"><span class="pop-chip" style="color:${col};">
        ${ev.mag >= 7 ? 'MAJOR' : ev.mag >= 6 ? 'STRONG' : ev.mag >= 5 ? 'MODERATE' : ev.mag >= 4 ? 'LIGHT' : 'MINOR'}
      </span></div>
      <hr class="pop-sep">
      <div class="pop-row">
        📍 ${esc(ev.place)}<br>
        🕐 ${ev.time ? new Date(ev.time).toLocaleString('th-TH') : '-'}
        <span class="pop-meta">· ${timeAgo(ev.time)}</span><br>
        📏 ความลึก ${ev.depth != null ? ev.depth.toFixed(1) : '-'} กม.<br>
        ${coordLine}
      </div>
      <hr class="pop-sep">
      <a class="pop-link" style="color:${col};" href="${ev.url}" target="_blank" rel="noopener">ดูรายละเอียด USGS →</a>`;
  } else if (ev.type === 'st') {
    const c = stormCat(ev.kts);
    html = `
      <div class="pop-title" style="color:${c.color};">🌀 ${esc(ev.title)}</div>
      <div style="margin-bottom:7px;"><span class="pop-chip" style="color:${c.color};">${c.short} · ${c.label}</span></div>
      <hr class="pop-sep">
      <div class="pop-row">
        💨 ความเร็วลม <b>${ev.kts != null ? ev.kts : '-'}</b> kts
        <span class="pop-meta">(~${ev.kts != null ? Math.round(ev.kts * 1.852) : '-'} กม./ชม.)</span><br>
        🗓 ${ev.time ? String(ev.time).split('T')[0] : '-'}
        <span class="pop-meta">· ${timeAgo(ev.time)}</span><br>
        ${coordLine}
      </div>
      <hr class="pop-sep">
      <a class="pop-link" style="color:${c.color};" href="${mapsUrl}" target="_blank" rel="noopener">ดูบน Google Maps →</a>`;
  } else {
    const icon = TYPE_ICON[ev.type];
    const col = COLORS[ev.type];
    html = `
      <div class="pop-title" style="color:${col};">${icon} ${esc(ev.title)}</div>
      <hr class="pop-sep">
      <div class="pop-row">
        <span id="popLoc">📍 ${ev.location ? esc(ev.location) : '<span class="pop-meta">กำลังค้นหาตำแหน่ง…</span>'}</span><br>
        ${ev.time ? `🗓 ${String(ev.time).split('T')[0]} <span class="pop-meta">· ${timeAgo(ev.time)}</span><br>` : ''}
        ${coordLine}
      </div>
      <hr class="pop-sep">
      <a class="pop-link" style="color:${col};" href="${mapsUrl}" target="_blank" rel="noopener">ดูบน Google Maps →</a>`;
  }

  activePopup = new maplibregl.Popup({ maxWidth: isPhone() ? '270px' : '300px', offset: 12 })
    .setLngLat([ev.lng, ev.lat]).setHTML(html).addTo(map);

  if ((ev.type === 'wf' || ev.type === 'fl') && !ev.location) {
    const pop = activePopup;
    reverseGeocode(ev.lat, ev.lng).then(geo => {
      if (!pop.isOpen()) return;
      const el = pop.getElement().querySelector('#popLoc');
      if (!el) return;
      el.innerHTML = geo.province
        ? `📍 ${esc(geo.province)}${geo.country && geo.country !== geo.province ? ` <span class="pop-meta">(${esc(geo.country)})</span>` : ''}`
        : `📍 <span class="pop-meta">พื้นที่ไม่มีชื่อเรียก (นอกเขตปกครอง)</span>`;
    });
  }
}

function focusEvent(ev) {
  map.flyTo({ center: [ev.lng, ev.lat], zoom: Math.max(map.getZoom(), 4.5), duration: 1400, essential: true });
  map.once('moveend', () => showPopup(ev));
}

/* ══════════════════════════════════════════════════════════
   GEOCODING
   ══════════════════════════════════════════════════════════ */
const GEOCODE_API_KEY = '69fdad57cf850933585115gmlce2259';
const geoCache = {};
async function reverseGeocode(lat, lng) {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  if (geoCache[key]) return geoCache[key];
  try {
    const r = await fetch(`https://geocode.maps.co/reverse?lat=${lat}&lon=${lng}&api_key=${GEOCODE_API_KEY}`);
    if (r.ok) {
      const d = await r.json();
      const a = d.address || {};
      const province = a.county || a.state_district || a.province || a.state || a.country || null;
      if (province) { const res = { province, country: a.country || '' }; geoCache[key] = res; return res; }
    }
  } catch (e) { console.warn('Geocode error:', e); }
  const res = { province: null, country: '' };
  geoCache[key] = res;
  return res;
}

/* ══════════════════════════════════════════════════════════
   DATA LOADERS
   ══════════════════════════════════════════════════════════ */
let dropped = 0;

async function loadEarthquakes() {
  const data = await (await fetch(API.quake)).json();
  const features = [];
  for (const f of data.features) {
    const pt = extractPoint(f.geometry);
    if (!pt) { dropped++; continue; }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pt.lng, pt.lat] },
      properties: {
        id: f.id, type: 'eq', mag: f.properties.mag,
        title: `M${f.properties.mag ?? '?'} ${f.properties.place || ''}`.trim(),
        place: f.properties.place, time: f.properties.time,
        url: f.properties.url, depth: pt.depth
      }
    });
  }
  map.getSource('eq').setData({ type: 'FeatureCollection', features });
  renderPulses(features);
  $('eqCount').innerText = features.length;
  return features.map(featToEvent);
}

async function loadStorms() {
  const data = await (await fetch(API.storm)).json();
  const points = [], tracks = [];
  (data.events || []).forEach(ev => {
    const geos = (ev.geometry || []).filter(g => g && g.coordinates)
      .slice().sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    if (!geos.length) return;
    const last = geos[geos.length - 1];
    const pt = extractPoint(last);
    if (!pt) { dropped++; return; }
    const kts = last.magnitudeValue != null ? Number(last.magnitudeValue) : null;
    const cat = stormCat(kts);

    points.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pt.lng, pt.lat] },
      properties: {
        id: ev.id, type: 'st', title: ev.title, kts, color: cat.color,
        date: last.date, url: (ev.sources && ev.sources[0]) ? ev.sources[0].url : null
      }
    });

    const raw = [];
    for (const g of geos) { const p = extractPoint(g); if (p) raw.push([p.lng, p.lat]); }
    const line = unwrapLine(raw);
    if (line.length > 1) {
      tracks.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: line },
                    properties: { id: ev.id, title: ev.title, color: cat.color } });
    }
  });
  map.getSource('st').setData({ type: 'FeatureCollection', features: points });
  map.getSource('sttrack').setData({ type: 'FeatureCollection', features: tracks });
  $('stCount').innerText = points.length;
  return points.map(featToEvent);
}

function eonetToPoints(events, type) {
  const features = [];
  for (const ev of events || []) {
    const geos = (ev.geometry || []).filter(g => g && g.coordinates);
    if (!geos.length) continue;
    const g = geos[geos.length - 1];
    const pt = extractPoint(g);
    if (!pt) { dropped++; continue; }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [pt.lng, pt.lat] },
      properties: { id: ev.id, type, title: ev.title, date: g.date }
    });
  }
  return features;
}

async function loadWildfires() {
  const data = await (await fetch(API.fire)).json();
  const features = eonetToPoints(data.events, 'wf');
  map.getSource('wf').setData({ type: 'FeatureCollection', features });
  $('wfCount').innerText = features.length;
  return features.map(featToEvent);
}

async function loadFloods() {
  try {
    const data = await (await fetch(API.flood)).json();
    const features = eonetToPoints(data.events, 'fl');
    if (!features.length) return loadFloodsFromGDACS();
    map.getSource('fl').setData({ type: 'FeatureCollection', features });
    $('flCount').innerText = features.length;
    return features.map(featToEvent);
  } catch (err) {
    console.error('EONET floods → fallback GDACS', err);
    return loadFloodsFromGDACS();
  }
}

async function loadFloodsFromGDACS() {
  try {
    const data = await (await fetch(API.gdacs)).json();
    const today = new Date();
    const endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    const startDate = new Date(endDate); startDate.setDate(endDate.getDate() - 60);
    const features = [];
    for (const f of (data.features || [])) {
      const p = f.properties || {};
      const t = new Date(p.datemodified);
      if (p.eventtype !== 'FL') continue;
      if (!['Orange', 'Red'].includes(p.alertlevel)) continue;
      if (!(t >= startDate && t <= endDate)) continue;
      const pt = extractPoint(f.geometry);
      if (!pt) { dropped++; continue; }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pt.lng, pt.lat] },
        properties: {
          id: p.eventid, type: 'fl', title: p.name || 'Flood', date: p.datemodified,
          location: `${p.name || ''}${p.country ? `, ${p.country}` : ''}`
        }
      });
    }
    map.getSource('fl').setData({ type: 'FeatureCollection', features });
    $('flCount').innerText = features.length;
    return features.map(featToEvent);
  } catch (err) {
    console.error('GDACS ERROR:', err);
    $('flCount').innerText = '0';
    return [];
  }
}

/* ══════════════════════════════════════════════════════════
   EVENT FEED
   ══════════════════════════════════════════════════════════ */
let activeTab = 'all';

function severityScore(ev) {
  if (ev.type === 'eq') return (ev.mag || 0) * 10;
  if (ev.type === 'st') return stormCat(ev.kts).rank * 12 + 5;
  return 1;
}

function baseFiltered() {
  const q = $('feedSearch').value.trim().toLowerCase();
  const minMag = parseFloat($('magFilter').value);
  const on = {
    eq: $('eqToggle').checked, st: $('stToggle').checked,
    wf: $('wfToggle').checked, fl: $('flToggle').checked
  };
  return allEvents.filter(ev => {
    if (!on[ev.type]) return false;
    if (ev.type === 'eq' && (ev.mag || 0) < minMag) return false;
    if (q && !(`${ev.title} ${ev.place || ''} ${ev.location || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderFeed() {
  const list = $('feedList');
  const sort = $('feedSort').value;
  const base = baseFiltered();

  const byType = { eq: 0, st: 0, wf: 0, fl: 0 };
  base.forEach(e => { if (byType[e.type] != null) byType[e.type]++; });
  $('tabAll').innerText = base.length;
  $('tabEq').innerText  = byType.eq;
  $('tabSt').innerText  = byType.st;
  $('tabWf').innerText  = byType.wf;
  $('tabFl').innerText  = byType.fl;

  let items = activeTab === 'all' ? base : base.filter(e => e.type === activeTab);
  items.sort((a, b) => sort === 'time'
    ? new Date(b.time || 0) - new Date(a.time || 0)
    : severityScore(b) - severityScore(a) || new Date(b.time || 0) - new Date(a.time || 0));

  $('feedCount').innerText = items.length;
  items = items.slice(0, 150);

  if (!items.length) {
    list.innerHTML = `<div class="feed-empty">ไม่พบเหตุการณ์ตามเงื่อนไข</div>`;
    return;
  }

  list.innerHTML = items.map((ev, i) => {
    const color = eventColor(ev);
    const val = ev.type === 'eq' ? `M${(ev.mag ?? 0).toFixed(1)}`
              : ev.type === 'st' ? stormCat(ev.kts).short : '';
    return `
      <div class="feed-item" data-i="${i}">
        <span class="feed-bar" style="background:${color};box-shadow:0 0 7px ${color};"></span>
        <div class="feed-body">
          <div class="feed-title">${esc(ev.title)}</div>
          <div class="feed-meta">
            <span class="feed-tag" style="color:${color};">${TYPE_LABEL[ev.type]}</span>
            <span>${timeAgo(ev.time)}</span>
          </div>
        </div>
        ${val ? `<span class="feed-val" style="color:${color};">${val}</span>` : ''}
      </div>`;
  }).join('');

  [...list.querySelectorAll('.feed-item')].forEach(el => {
    el.onclick = () => {
      list.querySelectorAll('.feed-item').forEach(x => x.classList.remove('active'));
      el.classList.add('active');
      focusEvent(items[+el.dataset.i]);
    };
  });
}

document.querySelectorAll('#feedTabs .tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('#feedTabs .tab').forEach(t => t.classList.remove('on'));
    tab.classList.add('on');
    activeTab = tab.dataset.t;
    $('feedList').scrollTop = 0;
    renderFeed();
  };
});

/* ══════════════════════════════════════════════════════════
   TICKER
   ══════════════════════════════════════════════════════════ */
function renderTicker() {
  const top = [];
  allEvents.filter(e => e.type === 'eq' && (e.mag || 0) >= 5)
    .sort((a, b) => b.mag - a.mag).slice(0, 3)
    .forEach(e => top.push(`🌍 M${e.mag} — ${e.place}`));
  allEvents.filter(e => e.type === 'st')
    .sort((a, b) => (b.kts || 0) - (a.kts || 0)).slice(0, 3)
    .forEach(e => top.push(`🌀 ${e.title} — ${stormCat(e.kts).label} (${e.kts ?? '-'} kts)`));
  const fires = allEvents.filter(e => e.type === 'wf').length;
  if (fires) top.push(`🔥 ไฟป่าที่ยังดำเนินอยู่ ${fires} จุดทั่วโลก`);
  const list = top.length ? top.slice(0, 6) : ['ไม่มีการแจ้งเตือนระดับสูงในขณะนี้'];
  $('ticker').innerHTML = `<span>${list.map(esc).join('  •  ')}</span>`;
  updateViewport();
}

/* ══════════════════════════════════════════════════════════
   AUTO-SPIN GLOBE
   ══════════════════════════════════════════════════════════ */
let spinEnabled = false;
let userInteracting = false;
let resumeTimer = null;
let secsPerRev = 120;

function spinGlobe() {
  if (!spinEnabled || userInteracting) return;
  const zoom = map.getZoom();
  if (zoom > 5) return;
  let degPerSec = 360 / secsPerRev;
  if (zoom > 3) degPerSec *= (5 - zoom) / 2;
  const c = map.getCenter();
  c.lng -= degPerSec;
  map.easeTo({ center: c, duration: 1000, easing: n => n });
}
map.on('moveend', spinGlobe);

function pauseSpin() { userInteracting = true; clearTimeout(resumeTimer); }
function resumeSpinSoon(delay = 3500) {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => { userInteracting = false; spinGlobe(); }, delay);
}
['mousedown', 'touchstart', 'wheel'].forEach(evt =>
  map.on(evt, () => { pauseSpin(); resumeSpinSoon(); }));
['dragend', 'pitchend', 'rotateend', 'zoomend'].forEach(evt =>
  map.on(evt, () => resumeSpinSoon()));

function setSpin(on) {
  spinEnabled = on;
  $('spinToggle').checked = on;
  if (on) { userInteracting = false; spinGlobe(); }
}

/* ══════════════════════════════════════════════════════════
   BROADCAST MODE
   ══════════════════════════════════════════════════════════ */
const BC = { on: false, idx: 0, rotateTimer: null, idleTimer: null, prevSpin: false, prevGlobe: true };

function bcHeadline(ev) {
  if (ev.type === 'eq') {
    const sev = ev.mag >= 7 ? 'MAJOR' : ev.mag >= 6 ? 'STRONG' : ev.mag >= 5 ? 'MODERATE' : 'LIGHT';
    return {
      kicker: `${TYPE_KICKER.eq} <span class="sub">· ${sev}</span>`,
      title: `M${(ev.mag ?? 0).toFixed(1)} — ${ev.place || 'ไม่ระบุตำแหน่ง'}`,
      sub: `ลึก ${ev.depth != null ? ev.depth.toFixed(0) : '-'} กม. · ${timeAgo(ev.time)} · ${ev.lat.toFixed(2)}°, ${ev.lng.toFixed(2)}°`
    };
  }
  if (ev.type === 'st') {
    const c = stormCat(ev.kts);
    return {
      kicker: `${TYPE_KICKER.st} <span class="sub">· ${c.short}</span>`,
      title: ev.title,
      sub: `${c.label} · ลม ${ev.kts ?? '-'} kts (~${ev.kts != null ? Math.round(ev.kts * 1.852) : '-'} กม./ชม.) · ${timeAgo(ev.time)}`
    };
  }
  return {
    kicker: TYPE_KICKER[ev.type],
    title: ev.title,
    sub: `${ev.location ? ev.location + ' · ' : ''}${timeAgo(ev.time)} · ${ev.lat.toFixed(2)}°, ${ev.lng.toFixed(2)}°`
  };
}

function bcTopEvents() {
  return allEvents.slice()
    .sort((a, b) => severityScore(b) - severityScore(a) || new Date(b.time || 0) - new Date(a.time || 0))
    .slice(0, 10);
}

function bcRenderLower() {
  const items = bcTopEvents();
  const lower = $('bcLower');
  if (!items.length) {
    $('bcKicker').innerText = 'GLOBAL DISASTER MONITOR';
    $('bcTitle').innerText = 'ไม่มีเหตุการณ์ในขณะนี้';
    $('bcSub').innerText = '';
    return;
  }
  BC.idx = ((BC.idx % items.length) + items.length) % items.length;
  const ev = items[BC.idx];
  const h = bcHeadline(ev);
  lower.style.setProperty('--c', eventColor(ev));
  $('bcKicker').innerHTML = `${TYPE_ICON[ev.type]} ${h.kicker}`;
  $('bcTitle').innerText = h.title;
  $('bcSub').innerText = h.sub;
  lower.style.animation = 'none';
  void lower.offsetWidth;
  lower.style.animation = '';
}

function bcRenderStats() {
  const c = { eq: 0, st: 0, wf: 0, fl: 0 };
  allEvents.forEach(e => { if (c[e.type] != null) c[e.type]++; });
  $('bcStats').innerHTML = `
    <div class="bc-stat" style="--c:${COLORS.eq}"><span class="lbl">EARTHQUAKES 24H</span><span class="val">${c.eq}</span></div>
    <div class="bc-stat" style="--c:${COLORS.st}"><span class="lbl">ACTIVE STORMS</span><span class="val">${c.st}</span></div>
    <div class="bc-stat" style="--c:${COLORS.wf}"><span class="lbl">WILDFIRES</span><span class="val">${c.wf}</span></div>
    <div class="bc-stat" style="--c:${COLORS.fl}"><span class="lbl">FLOODS</span><span class="val">${c.fl}</span></div>`;
}

function bcTickClock() {
  const now = new Date();
  $('bcTime').innerText = now.toLocaleTimeString('th-TH', { hour12: false });
  $('bcZone').innerText = `LOCAL · UTC ${now.toISOString().substr(11, 8)}`;
}

function bcMarkActive() {
  document.body.classList.remove('idle');
  clearTimeout(BC.idleTimer);
  BC.idleTimer = setTimeout(() => { if (BC.on) document.body.classList.add('idle'); }, 3500);
}

function enterBroadcast() {
  if (BC.on) return;
  BC.on = true;
  document.body.classList.add('broadcast');
  $('panel').classList.remove('open');
  $('bcToggle').checked = true;
  if (activePopup) { activePopup.remove(); activePopup = null; }

  BC.prevSpin = spinEnabled;
  BC.prevGlobe = isGlobe;

  if (!isGlobe) {
    isGlobe = true;
    $('globeToggle').checked = true;
    try { map.setProjection({ type: 'globe' }); } catch (e) {}
  }
  applyMapPadding();
  map.easeTo({ zoom: Math.min(map.getZoom(), globeFitZoom()), duration: 1200 });
  setSpin(true);

  BC.idx = 0;
  bcRenderLower();
  bcRenderStats();
  bcTickClock();
  clearInterval(BC.rotateTimer);
  BC.rotateTimer = setInterval(() => { BC.idx++; bcRenderLower(); }, 7000);

  document.addEventListener('mousemove', bcMarkActive);
  document.addEventListener('touchstart', bcMarkActive, { passive: true });
  bcMarkActive();

  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  setTimeout(() => { updateViewport(); refitGlobe(true); }, 400);
}

function exitBroadcast() {
  if (!BC.on) return;
  BC.on = false;
  document.body.classList.remove('broadcast', 'idle');
  $('bcToggle').checked = false;
  clearInterval(BC.rotateTimer);
  clearTimeout(BC.idleTimer);
  document.removeEventListener('mousemove', bcMarkActive);
  document.removeEventListener('touchstart', bcMarkActive);

  setSpin(BC.prevSpin);
  if (!BC.prevGlobe) {
    isGlobe = false;
    $('globeToggle').checked = false;
    try { map.setProjection({ type: 'mercator' }); } catch (e) {}
  }
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  setTimeout(() => { updateViewport(); refitGlobe(false); }, 400);
}

$('bcToggle').onchange = e => e.target.checked ? enterBroadcast() : exitBroadcast();
$('bcExit').onclick = () => exitBroadcast();

document.addEventListener('keydown', e => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'Escape' && BC.on) exitBroadcast();
  else if (e.key.toLowerCase() === 'b') BC.on ? exitBroadcast() : enterBroadcast();
  else if (e.key === 'ArrowRight' && BC.on) { BC.idx++; bcRenderLower(); }
  else if (e.key === 'ArrowLeft' && BC.on) { BC.idx--; bcRenderLower(); }
});
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && BC.on) exitBroadcast();
});
setInterval(bcTickClock, 1000);

/* ══════════════════════════════════════════════════════════
   MOBILE VIEWPORT — แก้ 100vh / safe-area / แถบเบราว์เซอร์บัง
   ══════════════════════════════════════════════════════════ */
const rootStyle = document.documentElement.style;

function applyMapPadding() {
  const cs = getComputedStyle(document.documentElement);
  const px = v => parseFloat(cs.getPropertyValue(v)) || 0;
  const top = px('--ticker-h') + px('--safe-t') + 10;
  const mob = isPhone();

  let pad;
  if (BC.on) {
    pad = mob
      ? { top: top + 30, bottom: 150, left: 12, right: 12 }
      : { top: top + 10, bottom: 130, left: 40, right: 210 };
  } else if (mob) {
    pad = { top, bottom: 62 + px('--safe-b'), left: 8, right: 8 };
  } else {
    pad = { top, bottom: 30, left: 268, right: window.innerWidth > 1100 ? 336 : 20 };
  }
  try { map.setPadding(pad, { duration: 0 }); } catch (e) {}
}

let lastH = 0;
function updateViewport() {
  const vv = window.visualViewport;
  const h = Math.round(vv ? vv.height : window.innerHeight);
  rootStyle.setProperty('--app-h', h + 'px');

  const t = document.querySelector('.breaking');
  if (t) rootStyle.setProperty('--ticker-h', t.offsetHeight + 'px');

  if (Math.abs(h - lastH) > 1) { lastH = h; map.resize(); }
  applyMapPadding();
}

function refitGlobe(force) {
  if (!isGlobe) return;
  const fit = globeFitZoom();
  if (force || map.getZoom() <= fit + 0.6) {
    map.easeTo({ zoom: fit, duration: force ? 600 : 0 });
  }
}

if (window.visualViewport) {
  visualViewport.addEventListener('resize', updateViewport);
  visualViewport.addEventListener('scroll', updateViewport);
}
window.addEventListener('resize', () => { updateViewport(); refitGlobe(false); });
window.addEventListener('orientationchange', () => {
  setTimeout(() => { updateViewport(); refitGlobe(true); }, 320);
});

/* ── Bottom sheet (มือถือ) ── */
const panelEl = $('panel');
const handleEl = $('sheetHandle');
handleEl.addEventListener('click', () => {
  panelEl.classList.toggle('open');
  setTimeout(applyMapPadding, 340);
});
let sheetStartY = null;
panelEl.addEventListener('touchstart', e => {
  sheetStartY = panelEl.scrollTop <= 0 ? e.touches[0].clientY : null;
}, { passive: true });
panelEl.addEventListener('touchend', e => {
  if (sheetStartY !== null && e.changedTouches[0].clientY - sheetStartY > 60) {
    panelEl.classList.remove('open');
    setTimeout(applyMapPadding, 340);
  }
  sheetStartY = null;
}, { passive: true });

/* ══════════════════════════════════════════════════════════
   UI BINDINGS
   ══════════════════════════════════════════════════════════ */
const EQ_LAYERS = ['eq-glow', 'eq-ring', 'eq-core', 'eq-hot'];

function refreshWildfireLayers() {
  const on = $('wfToggle').checked;
  setVisible(['wf-heat'], on && $('heatToggle').checked);
  setVisible(['wf-glow', 'wf-core'], on);
}
function refreshStormLayers() {
  const on = $('stToggle').checked;
  setVisible(['st-glow', 'st-core'], on);
  setVisible(['st-track', 'st-track-glow'], on && $('trackToggle').checked);
}
function applyMagFilter() {
  const v = parseFloat($('magFilter').value);
  $('magValue').innerText = `M ${v.toFixed(1)}`;
  if (map.getLayer('eq-core')) {
    const f = ['>=', ['coalesce', ['get', 'mag'], -1], v];
    map.setFilter('eq-core', f);
    map.setFilter('eq-glow', f);
    map.setFilter('eq-ring', ['all', f, ['>=', ['coalesce', ['get','mag'], 0], 4.5]]);
    map.setFilter('eq-hot',  ['all', f, ['>=', ['coalesce', ['get','mag'], 0], 6]]);
  }
  syncPulses();
}

$('eqToggle').onchange = e => { setVisible(EQ_LAYERS, e.target.checked); syncPulses(); renderFeed(); };
$('stToggle').onchange = () => { refreshStormLayers(); renderFeed(); };
$('wfToggle').onchange = () => { refreshWildfireLayers(); renderFeed(); };
$('flToggle').onchange = e => { setVisible(['fl-glow','fl-core'], e.target.checked); renderFeed(); };
$('heatToggle').onchange = refreshWildfireLayers;
$('trackToggle').onchange = refreshStormLayers;
$('labelToggle').onchange = applyLabelVisibility;
$('magFilter').oninput = () => { applyMagFilter(); renderFeed(); };
$('feedSearch').oninput = renderFeed;
$('feedSort').onchange = renderFeed;
$('themeSel').onchange = e => applyTheme(e.target.value);
$('spinToggle').onchange = e => setSpin(e.target.checked);
$('spinSpeed').oninput = e => {
  secsPerRev = parseInt(e.target.value, 10);
  $('spdValue').innerText = `${secsPerRev}s/รอบ`;
};
$('globeToggle').onchange = e => {
  isGlobe = e.target.checked;
  map.setProjection({ type: isGlobe ? 'globe' : 'mercator' });
  if (isGlobe) refitGlobe(true);
  updateOcclusion();
};

let countdownTimer;
function startCountdown() {
  clearInterval(countdownTimer);
  let left = REFRESH_MS / 1000;
  const el = $('next');
  const tick = () => {
    el.innerText = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    if (--left < 0) clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

/* ══════════════════════════════════════════════════════════
   MAIN
   ══════════════════════════════════════════════════════════ */
async function loadData() {
  await styleReady;
  $('status').innerText = 'Updating...';
  dropped = 0;

  const res = await Promise.allSettled([loadEarthquakes(), loadStorms(), loadWildfires(), loadFloods()]);
  allEvents = [];
  res.forEach(r => {
    if (r.status === 'fulfilled') allEvents.push(...(r.value || []));
    else console.error(r.reason);
  });
  if (dropped) console.warn(`⚠️ ข้ามข้อมูลพิกัดไม่ถูกต้อง ${dropped} รายการ`);

  syncPulses();
  applyMagFilter();
  renderFeed();
  renderTicker();
  if (BC.on) { bcRenderStats(); bcRenderLower(); }

  $('status').innerText = 'Live';
  $('time').innerText = new Date().toLocaleTimeString('th-TH');
  startCountdown();
}

updateViewport();
styleReady.then(() => { updateViewport(); refitGlobe(true); });
loadData();
setInterval(loadData, REFRESH_MS);