/* ============================================================================
   Choreo-Planer PWA – zentrale Logik
   Tech: Alpine.js + Wavesurfer.js v7 + Dexie.js + Supabase
   Alles CDN/ESM, kein Build-Step.
   ========================================================================== */

import Alpine from 'https://cdn.jsdelivr.net/npm/alpinejs@3/dist/module.esm.js';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import Dexie from 'https://cdn.jsdelivr.net/npm/dexie@4/+esm';
import WaveSurfer from 'https://cdn.jsdelivr.net/npm/wavesurfer.js@7/dist/wavesurfer.esm.js';
import RegionsPlugin from 'https://cdn.jsdelivr.net/npm/wavesurfer.js@7/dist/plugins/regions.esm.js';

/* ---------- App-Version (hochzählend; zur Cache-/Update-Kontrolle) ---------- */
const APP_VERSION = 13;

/* ---------- Supabase ---------- */
const SUPABASE_URL = 'https://qgklrvagzfvqbbpgpfdl.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFna2xydmFnemZ2cWJicGdwZmRsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxMTkyNjksImV4cCI6MjA5NzY5NTI2OX0.3Jo7IBQYHDOr1hNRzuV3zxnof0zI4lD2kF6XqT2QjIs';
// Gemeinsamer Editor-Login: das Team teilt sich EIN Passwort. Bearbeiten nur
// nach Login (authenticated), Lesen/Training für alle (anon).
const EDITOR_EMAIL = 'editor@choreo.app';
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Token für Roh-fetch/XHR-Schreibzugriffe. Default = anon (nur Lesen); nach
// Login wird hier das JWT des eingeloggten Editors hinterlegt (sonst blockt RLS).
let accessToken = SUPABASE_ANON_KEY;

const LOCK_TIMEOUT_MS = 30000;     // Zombie-Lock-Schwelle
const HEARTBEAT_MS = 15000;        // Lock-Refresh-Intervall
const DEBOUNCE_MS = 1000;          // Editor-Tipp-Debounce
const STORAGE_BUCKET = 'audio-tracks';

/* ---------- Dexie (Offline-Cache + Sync-Queue) ---------- */
const db = new Dexie('ChoreoAppDB');
db.version(1).stores({
  audioCache: 'projectId',
  syncQueue: '++id, table, timestamp',
  projects: 'id',
  segments: 'id, project_id'
});
// v2: Offline-Spiegel für die neuen Tabellen (Tempo/Personen/Abschnitte/Schritte)
db.version(2).stores({
  audioCache: 'projectId',
  syncQueue: '++id, table, timestamp',
  projects: 'id',
  segments: 'id, project_id',
  tempoSections: 'id, project_id',
  persons: 'id, project_id',
  parts: 'id, project_id',
  memberships: 'id, part_id',
  steps: 'id, project_id'
});

/* ---------- Modul-Zustand (nicht in Alpine-Reaktivität, um WS-Proxy-Probleme zu vermeiden) ---------- */
let ws = null;
let wsRegions = null;
let gridCanvas = null;             // eigenes Beat-Grid (Overlay über dem Waveform)
let gridCtx = null;
let gridRaf = 0;                   // requestAnimationFrame-Drossel fürs Neuzeichnen
let app = null;                    // Referenz auf die Alpine-Komponente
let heartbeatTimer = null;
let currentObjectUrl = null;
const debounceTimers = {};         // segId -> timeout
const pendingEdits = {};           // segId -> { feld: wert } (für visibilitychange-Flush)
const tempoSaveTimers = {};        // tempoId -> timeout (debounced Speichern)
const tempoPending = {};           // tempoId -> { feld: wert }
let lastActiveSegmentId = null;
let loadToken = 0;                 // verhindert Race bei schnellem Projektwechsel
let audioSource = null;           // 'cache' | 'network' – woher der aktuelle Blob stammt
let audioRefetchTried = false;    // verhindert Endlosschleife bei kaputtem Blob
let audioTimeout = null;          // Sicherheits-Timeout gegen ewiges "Lade Audio"

/* ---------- Hilfen ---------- */
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
const restHeaders = () => ({
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${accessToken}`,
  'Content-Type': 'application/json'
});

/* ============================================================================
   Alpine-Komponente
   ========================================================================== */
Alpine.data('choreo', () => ({
  /* --- Identität --- */
  userId: '',
  userName: '',
  nameModalOpen: false,
  nameInput: '',

  /* --- UI --- */
  version: APP_VERSION,
  menuOpen: false,
  settingsOpen: false,

  /* --- Auth / Editor-Freischaltung --- */
  isEditor: false,
  loginOpen: false,
  loginPassword: '',
  loginError: '',
  loggingIn: false,

  online: navigator.onLine,
  toast: '',
  _toastTimer: null,

  /* --- Daten --- */
  projects: [],
  project: null,
  segments: [],
  tempoSections: [],                // Tempo-/Takt-Abschnitte des offenen Projekts

  /* --- Playback / Modus --- */
  currentMode: 'training',          // 'training' | 'editor'
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  activeSegmentId: null,
  zoom: 0,                          // minPxPerSec (0 = fit)
  _projSaveTimer: null,
  _projPending: null,

  /* --- Audio-Lade-Status --- */
  audioLoading: false,
  audioError: null,

  /* --- Lock --- */
  lockOwned: false,
  lockedByOther: null,

  /* --- Upload-Form --- */
  form: { title: '', bpm: 120, time_signature: '4/4', file: null },
  uploading: false,
  uploadProgress: 0,
  uploadError: null,
  _xhr: null,

  /* --- abgeleitet --- */
  get sortedSegments() {
    return [...this.segments].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  },
  get sortedTempo() {
    return [...this.tempoSections].sort((a, b) => Number(a.start_sec) - Number(b.start_sec));
  },
  // Abschnitt, der die aktuelle Abspielposition enthält (für Topbar/Anzeige)
  get activeTempo() {
    const t = this.currentTime;
    const list = this.sortedTempo;
    for (const s of list) {
      const e = s.end_sec == null ? Infinity : Number(s.end_sec);
      if (t >= Number(s.start_sec) - 1e-6 && t < e) return s;
    }
    return list[0] || null;
  },
  // Takt-Länge (Abstand dicker Linien) eines Abschnitts in Sekunden
  barLengthOf(sec) {
    if (!sec) return 0;
    const bpb = parseInt(String(sec.time_signature || '4/4').split('/')[0], 10) || 4;
    return (60 / (Number(sec.bpm) || 120)) * bpb;
  },

  /* ===================== Init ===================== */
  async init() {
    app = this;

    // Auth-Session wiederherstellen (gemeinsamer Editor-Login)
    await this.initAuth();

    // Identität
    this.userId = localStorage.getItem('choreo_user_id') || (() => {
      const u = uuid(); localStorage.setItem('choreo_user_id', u); return u;
    })();
    this.userName = localStorage.getItem('choreo_user_name') || '';
    if (!this.userName) this.nameModalOpen = true;

    // Netz-Listener
    window.addEventListener('online', () => { this.online = true; this.setStatus('Wieder online – synchronisiere…'); this.processSyncQueue(); });
    window.addEventListener('offline', () => { this.online = false; this.setStatus('Offline'); });

    // Datenverlust-Prävention beim Sperren/Verlassen
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.flushPending();
      } else {
        if (this.online) this.processSyncQueue();
        if (this.currentMode === 'editor' && this.online) this.verifyLockStillOurs();
      }
    });
    window.addEventListener('pagehide', () => { this.flushPending(); this.releaseLockBeacon(); });

    // Tastatur (PC-Usability): Leertaste = Play/Pause, Pfeile = ±5s
    window.addEventListener('keydown', (e) => {
      if (this.isTypingTarget(e.target)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.togglePlay();
      } else if (e.code === 'ArrowLeft' && ws) {
        e.preventDefault();
        ws.setTime(Math.max(0, ws.getCurrentTime() - 5));
      } else if (e.code === 'ArrowRight' && ws) {
        e.preventDefault();
        ws.setTime(Math.min(this.duration, ws.getCurrentTime() + 5));
      }
    });

    // Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    // Daten laden
    await this.loadProjects();
    if (this.online) this.processSyncQueue();

    const last = localStorage.getItem('choreo_last_project');
    const target = this.projects.find(p => p.id === last) || this.projects[0];
    if (target) await this.openProject(target);
  },

  saveName() {
    const n = this.nameInput.trim();
    if (!n) return;
    this.userName = n;
    localStorage.setItem('choreo_user_name', n);
    this.nameModalOpen = false;
  },

  /* ===================== Auth / Editor-Login ===================== */
  async initAuth() {
    try {
      const { data } = await sb.auth.getSession();
      const session = data && data.session;
      this.isEditor = !!session;
      accessToken = (session && session.access_token) || SUPABASE_ANON_KEY;
    } catch (e) { /* offline o.ä. -> bleibt Lese-Modus */ }
    // hält Token & Editor-Status aktuell (Login, Logout, Token-Refresh)
    sb.auth.onAuthStateChange((_event, session) => {
      this.isEditor = !!session;
      accessToken = (session && session.access_token) || SUPABASE_ANON_KEY;
    });
  },

  openLogin() { this.loginError = ''; this.loginPassword = ''; this.loginOpen = true; },
  closeLogin() { this.loginOpen = false; },

  async doLogin() {
    const pw = this.loginPassword;
    if (!pw || this.loggingIn) return;
    this.loggingIn = true; this.loginError = '';
    try {
      const { error } = await sb.auth.signInWithPassword({ email: EDITOR_EMAIL, password: pw });
      if (error) throw error;
      this.loginPassword = '';
      this.loginOpen = false;
      this.setStatus('Editor-Modus freigeschaltet');
      // direkt in den Editor wechseln, wenn ein Projekt offen ist
      if (this.project && this.currentMode === 'training') await this.enterEditor();
    } catch (e) {
      this.loginError = 'Passwort falsch (oder offline). Bitte erneut versuchen.';
    } finally {
      this.loggingIn = false;
    }
  },

  async logout() {
    if (this.currentMode === 'editor') await this.exitEditor();
    try { await sb.auth.signOut(); } catch (e) {}
    this.isEditor = false;
    accessToken = SUPABASE_ANON_KEY;
    this.setStatus('Abgemeldet – nur noch Lesen/Training');
  },

  /* ===================== Projekte ===================== */
  async loadProjects() {
    try {
      const { data, error } = await sb.from('projects').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      this.projects = data || [];
      await db.projects.clear().catch(() => {});
      await db.projects.bulkPut(this.projects).catch(() => {});
    } catch (e) {
      // Offline -> aus Cache
      this.projects = await db.projects.toArray().catch(() => []);
      if (!this.projects.length) this.setStatus('Offline – keine Projekte im Cache');
    }
  },

  async openProject(p) {
    if (this.currentMode === 'editor') await this.releaseLock();
    this.currentMode = 'training';
    this.menuOpen = false;
    this.project = p;
    localStorage.setItem('choreo_last_project', p.id);
    this.activeSegmentId = null;
    lastActiveSegmentId = null;
    this.isPlaying = false;
    this.currentTime = 0;
    this.duration = 0;

    const token = ++loadToken;
    this.destroyWs();
    await this.loadSegments(p.id);
    await this.loadTempoSections(p.id);
    if (token !== loadToken) return;      // anderes Projekt wurde inzwischen gewählt
    this.createWs(p);
    await this.loadAudio(p);
  },

  /* ===================== Tempo-Abschnitte laden ===================== */
  async loadTempoSections(pid) {
    try {
      const { data, error } = await sb.from('tempo_sections').select('*').eq('project_id', pid).order('start_sec');
      if (error) throw error;
      this.tempoSections = data || [];
      await db.tempoSections.where('project_id').equals(pid).delete().catch(() => {});
      await db.tempoSections.bulkPut(this.tempoSections).catch(() => {});
    } catch (e) {
      this.tempoSections = await db.tempoSections.where('project_id').equals(pid).toArray().catch(() => []);
    }
    // Fallback: ältere Projekte ohne Abschnitt -> aus Legacy-Spalten ableiten (nur lokal)
    if (!this.tempoSections.length && this.project) {
      this.tempoSections = [{
        id: uuid(), project_id: pid, sort_index: 0, label: null,
        start_sec: 0, end_sec: null,
        bpm: Number(this.project.bpm) || 120,
        time_signature: this.project.time_signature || '4/4',
        offset_sec: Number(this.project.grid_offset) || 0
      }];
    }
  },

  /* ===================== Audio (Hybrid-Cache) =====================
     Spinner/Status werden über die Wavesurfer-Events 'ready'/'decode'/'error'
     gesteuert, NICHT über das load()-Promise (das in v7 hängen bleiben kann). */
  async loadAudio(project) {
    this.audioLoading = true;
    this.audioError = null;
    audioRefetchTried = false;
    const token = loadToken;

    // Sicherheits-Timeout: nie ewig "Lade Audio…" anzeigen
    clearTimeout(audioTimeout);
    audioTimeout = setTimeout(() => {
      if (token === loadToken && this.audioLoading) {
        this.audioLoading = false;
        this.audioError = 'Audio-Dekodierung hat zu lange gedauert. Erneut versuchen? (Tipp: MP3/WAV sind am kompatibelsten.)';
      }
    }, 40000);

    // 1. lokal vorhanden? -> 2. Blob an Wavesurfer
    const cached = await db.audioCache.get(project.id).catch(() => null);
    if (token !== loadToken) return;
    if (cached && cached.blob) {
      audioSource = 'cache';
      this.wsLoadBlob(cached.blob).catch((e) => this.handleAudioError(e));
      return;
    }
    // 3. nicht vorhanden -> von Supabase laden
    await this.loadAudioFromNetwork(project, token);
  },

  async loadAudioFromNetwork(project, token) {
    audioSource = 'network';
    try {
      const res = await fetch(project.audio_url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      await db.audioCache.put({ projectId: project.id, blob, cachedAt: Date.now() }).catch(() => {});
      if (token !== loadToken) return;
      this.wsLoadBlob(blob).catch((e) => this.handleAudioError(e));
    } catch (e) {
      if (token !== loadToken) return;
      clearTimeout(audioTimeout);
      this.audioLoading = false;
      this.audioError = navigator.onLine
        ? ('Audio konnte nicht geladen werden: ' + e.message)
        : 'Offline – dieses Audio ist nicht im Cache verfügbar.';
    }
  },

  onAudioReady() {
    clearTimeout(audioTimeout);
    this.audioLoading = false;
    this.audioError = null;
    if (ws) this.duration = ws.getDuration();
    this.renderRegions();
    this.resizeGridCanvas();
    this.scheduleGridDraw();
  },

  handleAudioError(err) {
    // 4. iOS-Eviction / korrupter Blob: aus dem Cache werfen und einmal neu laden
    if (audioSource === 'cache' && !audioRefetchTried && this.project && navigator.onLine) {
      audioRefetchTried = true;
      db.audioCache.delete(this.project.id).catch(() => {});
      this.loadAudioFromNetwork(this.project, loadToken);
      return;
    }
    clearTimeout(audioTimeout);
    this.audioLoading = false;
    this.audioError = navigator.onLine
      ? 'Audio konnte nicht dekodiert werden. Erneut versuchen? (Tipp: MP3/WAV sind am kompatibelsten.)'
      : 'Offline – dieses Audio ist nicht im Cache verfügbar.';
  },

  wsLoadBlob(blob) {
    if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
    currentObjectUrl = URL.createObjectURL(blob);
    return ws.load(currentObjectUrl);
  },

  /* ===================== Wavesurfer ===================== */
  createWs(project) {
    const container = document.getElementById('waveform');
    const h = Math.max(60, container.clientHeight - 6);

    ws = WaveSurfer.create({
      container,
      height: h,
      waveColor: '#5a5a5a',
      progressColor: '#6c8cff',
      cursorColor: '#ffffff',
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      minPxPerSec: this.zoom || 1,
      fillParent: true
    });
    wsRegions = ws.registerPlugin(RegionsPlugin.create());

    // eigenes Beat-Grid als Overlay-Canvas (Multi-Tempo)
    this.setupGridCanvas(container);

    // 'ready'/'decode' sind die verlässlichen Signale (das load()-Promise kann hängen)
    ws.on('ready', () => this.onAudioReady());
    ws.on('decode', () => this.onAudioReady());
    ws.on('play', () => { this.isPlaying = true; });
    ws.on('pause', () => { this.isPlaying = false; });
    ws.on('finish', () => { this.isPlaying = false; });
    ws.on('timeupdate', (t) => this.onTimeUpdate(t));
    ws.on('error', (err) => this.handleAudioError(err));
    // Grid an Scroll/Zoom/Redraw von Wavesurfer koppeln
    ws.on('scroll', () => this.scheduleGridDraw());
    ws.on('zoom', () => this.scheduleGridDraw());
    ws.on('redraw', () => this.scheduleGridDraw());

    wsRegions.on('region-updated', (r) => this.onRegionMoved(r));
    wsRegions.on('region-clicked', (r, e) => { e.stopPropagation(); ws.setTime(r.start); this.selectSegment(r.id); });
  },

  /* ===================== Eigenes Beat-Grid (Canvas-Overlay) ===================== */
  setupGridCanvas(container) {
    if (gridCanvas) { try { gridCanvas.remove(); } catch (e) {} }
    gridCanvas = document.createElement('canvas');
    gridCanvas.className = 'grid-canvas';
    container.appendChild(gridCanvas);
    gridCtx = gridCanvas.getContext('2d');
    if (!this._gridResize) {
      this._gridResize = () => { this.resizeGridCanvas(); this.drawGrid(); };
      window.addEventListener('resize', this._gridResize);
    }
  },

  resizeGridCanvas() {
    if (!gridCanvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = gridCanvas.clientWidth, h = gridCanvas.clientHeight;
    gridCanvas.width = Math.max(1, Math.round(w * dpr));
    gridCanvas.height = Math.max(1, Math.round(h * dpr));
    if (gridCtx) gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },

  // sichtbarer Zeitausschnitt + Pixel/Sekunde aus Wavesurfer ableiten
  gridViewport() {
    if (!ws) return null;
    const dur = ws.getDuration();
    if (!dur) return null;
    let pxPerSec = 0;
    try {
      const wrapper = ws.getWrapper();
      const contentW = wrapper ? wrapper.scrollWidth : 0;
      if (contentW) pxPerSec = contentW / dur;
    } catch (e) {}
    if (!pxPerSec) return null;
    const startT = (ws.getScroll() || 0) / pxPerSec;
    return { startT, pxPerSec };
  },

  scheduleGridDraw() {
    if (gridRaf) return;
    gridRaf = requestAnimationFrame(() => { gridRaf = 0; this.drawGrid(); });
  },

  // Zeichnet pro Tempo-Abschnitt das Beat-Raster (Takt 1 dick, Beats dünn).
  // Lücken zwischen Abschnitten bleiben leer.
  drawGrid() {
    if (!gridCtx || !gridCanvas) return;
    const w = gridCanvas.clientWidth, h = gridCanvas.clientHeight;
    gridCtx.clearRect(0, 0, w, h);
    const vp = this.gridViewport();
    if (!vp) return;
    const { startT, pxPerSec } = vp;
    const endT = startT + w / pxPerSec;
    const dur = ws.getDuration() || 0;

    gridCtx.font = '10px -apple-system, sans-serif';
    gridCtx.textBaseline = 'top';

    for (const sec of this.sortedTempo) {
      const bpm = Number(sec.bpm) || 120;
      const bpb = parseInt(String(sec.time_signature || '4/4').split('/')[0], 10) || 4;
      const spb = 60 / bpm;
      if (spb <= 0) continue;
      const off = Number(sec.offset_sec) || 0;
      const secStart = Number(sec.start_sec) || 0;
      const secEnd = sec.end_sec == null ? dur : Number(sec.end_sec);
      const from = Math.max(secStart, startT);
      const to = Math.min(secEnd, endT);
      if (to <= from) continue;
      let k = Math.ceil((from - off) / spb - 1e-6);   // erster sichtbarer Beat-Index
      for (; ; k++) {
        const t = off + k * spb;
        if (t > to + 1e-6) break;
        if (t < secStart - 1e-6) continue;
        const x = Math.round((t - startT) * pxPerSec) + 0.5;
        const isBar = (((k % bpb) + bpb) % bpb) === 0;
        gridCtx.beginPath();
        gridCtx.strokeStyle = isBar ? 'rgba(195,204,255,0.85)' : 'rgba(150,160,180,0.30)';
        gridCtx.lineWidth = isBar ? 2 : 1;
        gridCtx.moveTo(x, isBar ? 0 : h * 0.5);
        gridCtx.lineTo(x, h);
        gridCtx.stroke();
        if (isBar) {
          gridCtx.fillStyle = 'rgba(195,204,255,0.9)';
          gridCtx.fillText(String(Math.floor(k / bpb) + 1), x + 3, 2);
        }
      }
    }
  },

  /* ===================== Tempo-Abschnitte: CRUD + Feinjustage ===================== */
  addTempoSection() {
    if (!this.project) return;
    const list = this.sortedTempo;
    const last = list[list.length - 1];
    let start = 0;
    if (last) start = last.end_sec == null ? Math.min(this.duration || 0, (Number(last.start_sec) || 0) + 1) : Number(last.end_sec);
    // offenes Ende des letzten Abschnitts schließen, damit nichts überlappt
    if (last && last.end_sec == null) this.patchTempo(last, { end_sec: Math.round(start * 1000) / 1000 });
    const sec = {
      id: uuid(), project_id: this.project.id,
      sort_index: this.tempoSections.length,
      label: 'Lied ' + (this.tempoSections.length + 1),
      start_sec: Math.round(start * 1000) / 1000, end_sec: null,
      bpm: last ? Number(last.bpm) : 120,
      time_signature: last ? last.time_signature : '4/4',
      offset_sec: Math.round(start * 1000) / 1000
    };
    this.tempoSections.push(sec);
    db.tempoSections.put(sec).catch(() => {});
    this.persistTempoInsert(sec);
    this.drawGrid();
  },

  async persistTempoInsert(sec) {
    try {
      const { error } = await sb.from('tempo_sections').insert(sec);
      if (error) throw error;
    } catch (e) {
      await this.queue('tempo_sections', 'insert', sec.id, sec);
      this.setStatus('Offline – Abschnitt gespeichert, wird synchronisiert');
    }
  },

  // lokal sofort anwenden + debounced nach Supabase (mit Offline-Queue)
  patchTempo(sec, patch) {
    Object.assign(sec, patch);
    db.tempoSections.put(JSON.parse(JSON.stringify(sec))).catch(() => {});
    this.drawGrid();
    tempoPending[sec.id] = Object.assign(tempoPending[sec.id] || {}, patch);
    clearTimeout(tempoSaveTimers[sec.id]);
    tempoSaveTimers[sec.id] = setTimeout(async () => {
      const payload = tempoPending[sec.id]; delete tempoPending[sec.id];
      if (!payload) return;
      try {
        const { error } = await sb.from('tempo_sections')
          .update(Object.assign({}, payload, { updated_at: new Date().toISOString() }))
          .eq('id', sec.id);
        if (error) throw error;
      } catch (e) {
        this.queue('tempo_sections', 'update', sec.id, payload);
        this.setStatus('Offline – Änderung gespeichert, wird synchronisiert');
      }
    }, 500);
  },

  async deleteTempoSection(sec) {
    if (this.tempoSections.length <= 1) { this.setStatus('Mindestens ein Abschnitt muss bleiben'); return; }
    if (!confirm(`Abschnitt „${sec.label || ''}" löschen? Schritte darin gehen verloren.`)) return;
    this.tempoSections = this.tempoSections.filter(s => s.id !== sec.id);
    db.tempoSections.delete(sec.id).catch(() => {});
    this.drawGrid();
    try {
      const { error } = await sb.from('tempo_sections').delete().eq('id', sec.id);
      if (error) throw error;
    } catch (e) {
      await this.queue('tempo_sections', 'delete', sec.id, null);
    }
  },

  setTimeSig(sec, v) { this.patchTempo(sec, { time_signature: v }); },
  onBpmInput(sec, v) {
    let n = parseFloat(v); if (isNaN(n)) return;
    n = Math.min(400, Math.max(20, Math.round(n * 100) / 100));
    this.patchTempo(sec, { bpm: n });
  },
  nudgeBpm(sec, d) {
    let n = (Number(sec.bpm) || 120) + d;
    n = Math.min(400, Math.max(20, Math.round(n * 100) / 100));
    this.patchTempo(sec, { bpm: n });
  },
  // Takt-Abstand direkt nudgen -> rechnet auf BPM zurück (für krumme Werte)
  nudgeBarLength(sec, deltaSec) {
    const bpb = parseInt(String(sec.time_signature || '4/4').split('/')[0], 10) || 4;
    const next = Math.max(0.05, this.barLengthOf(sec) + deltaSec);
    const bpm = Math.min(400, Math.max(20, Math.round((60 * bpb / next) * 100) / 100));
    this.patchTempo(sec, { bpm });
  },
  nudgeOffset(sec, d) {
    const v = Math.max(0, Math.round(((Number(sec.offset_sec) || 0) + d) * 1000) / 1000);
    this.patchTempo(sec, { offset_sec: v });
  },
  offsetToCursor(sec) {
    this.patchTempo(sec, { offset_sec: ws ? Math.round(ws.getCurrentTime() * 1000) / 1000 : 0 });
  },
  resetOffset(sec) { this.patchTempo(sec, { offset_sec: 0 }); },

  // Start/Ende eines Abschnitts (Sekunden; leeres Ende = bis Schluss)
  setTempoBound(sec, field, value) {
    if (field === 'end_sec' && (value === '' || value == null)) { this.patchTempo(sec, { end_sec: null }); return; }
    let n = parseFloat(value); if (isNaN(n)) return;
    n = Math.max(0, Math.round(n * 1000) / 1000);
    this.patchTempo(sec, { [field]: n });
  },
  boundToCursor(sec, field) {
    this.patchTempo(sec, { [field]: ws ? Math.round(ws.getCurrentTime() * 1000) / 1000 : 0 });
  },

  /* ===================== Projekt-Einstellungen / Kalibrierung ===================== */
  openSettings() {
    if (!this.project) return;
    if (!this.isEditor) { this.openLogin(); return; }
    this.settingsOpen = true;
  },
  closeSettings() { this.settingsOpen = false; },

  /* lokal sofort anwenden + gebündelt/debounced nach Supabase (mit Offline-Queue) */
  patchProject(patch) {
    if (!this.project) return;
    Object.assign(this.project, patch);
    const idx = this.projects.findIndex(p => p.id === this.project.id);
    if (idx >= 0) Object.assign(this.projects[idx], patch);
    db.projects.put(JSON.parse(JSON.stringify(this.project))).catch(() => {});

    this._projPending = Object.assign(this._projPending || {}, patch);
    const pid = this.project.id;
    clearTimeout(this._projSaveTimer);
    this._projSaveTimer = setTimeout(async () => {
      const payload = this._projPending; this._projPending = null;
      if (!payload) return;
      try {
        const { error } = await sb.from('projects')
          .update(Object.assign({}, payload, { updated_at: new Date().toISOString() }))
          .eq('id', pid);
        if (error) throw error;
      } catch (e) {
        this.queue('projects', 'update', pid, payload);
        this.setStatus('Offline – Einstellung gespeichert, wird synchronisiert');
      }
    }, 500);
  },

  destroyWs() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (gridRaf) { cancelAnimationFrame(gridRaf); gridRaf = 0; }
    if (ws) { try { ws.destroy(); } catch (e) {} ws = null; wsRegions = null; }
    if (gridCanvas) { try { gridCanvas.remove(); } catch (e) {} gridCanvas = null; gridCtx = null; }
    if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }
  },

  /* ===================== Playback-Controls ===================== */
  togglePlay() { if (ws) ws.playPause(); },
  seekTo(t) { if (ws && this.duration) ws.setTime(Number(t)); },
  zoomIn() { this.zoom = Math.min(400, (this.zoom || 20) * 1.6); if (ws) ws.zoom(this.zoom); },
  zoomOut() { this.zoom = Math.max(1, (this.zoom || 20) / 1.6); if (ws) ws.zoom(this.zoom); },

  isTypingTarget(el) {
    if (!el) return false;
    const t = (el.tagName || '').toUpperCase();
    return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
  },

  onTimeUpdate(t) {
    this.currentTime = t;
    const segs = this.sortedSegments;
    let active = null;
    for (const s of segs) { if (Number(s.timestamp) <= t + 0.001) active = s; else break; }
    const id = active ? active.id : null;
    if (id !== lastActiveSegmentId) {
      lastActiveSegmentId = id;
      this.activeSegmentId = id;
      // Auto-Scroll nur im Training-Modus
      if (id && this.currentMode === 'training') {
        const el = document.getElementById('seg-' + id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  },

  /* ===================== Segmente laden ===================== */
  async loadSegments(pid) {
    try {
      const { data, error } = await sb.from('choreo_segments').select('*').eq('project_id', pid).order('timestamp');
      if (error) throw error;
      this.segments = data || [];
      await db.segments.where('project_id').equals(pid).delete().catch(() => {});
      await db.segments.bulkPut(this.segments).catch(() => {});
    } catch (e) {
      this.segments = await db.segments.where('project_id').equals(pid).toArray().catch(() => []);
    }
  },

  /* ===================== Regions <-> Segmente ===================== */
  renderRegions() {
    if (!wsRegions) return;
    wsRegions.clearRegions();
    const draggable = this.currentMode === 'editor';
    for (const s of this.sortedSegments) {
      wsRegions.addRegion({
        id: s.id,
        start: Number(s.timestamp),
        content: s.label || '♪',
        color: 'rgba(108,140,255,0.85)',
        drag: draggable,
        resize: false
      });
    }
  },

  onRegionMoved(r) {
    const seg = this.segments.find(s => s.id === r.id);
    if (!seg) return;
    seg.timestamp = Math.round(r.start * 1000) / 1000;
    this.saveSegment(seg, { timestamp: seg.timestamp });
  },

  selectSegment(id) {
    this.activeSegmentId = id;
    const el = document.getElementById('seg-' + id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  addSegmentAtCursor() {
    if (!this.project) return;
    const ts = ws ? Math.round(ws.getCurrentTime() * 1000) / 1000 : 0;
    const seg = { id: uuid(), project_id: this.project.id, timestamp: ts, label: '', notes: '' };
    this.segments.push(seg);
    db.segments.put(seg).catch(() => {});
    if (wsRegions) {
      wsRegions.addRegion({ id: seg.id, start: ts, content: '♪', color: 'rgba(108,140,255,0.85)', drag: true, resize: false });
    }
    this.persistInsert(seg);
    this.$nextTick(() => this.selectSegment(seg.id));
  },

  deleteSegment(seg) {
    this.segments = this.segments.filter(s => s.id !== seg.id);
    db.segments.delete(seg.id).catch(() => {});
    if (wsRegions) {
      const r = wsRegions.getRegions().find(x => x.id === seg.id);
      if (r) r.remove();
    }
    this.persistDelete(seg);
  },

  /* ===================== Editor-Eingabe + Debounce ===================== */
  onSegmentInput(seg, field, value) {
    seg[field] = value;
    pendingEdits[seg.id] = Object.assign(pendingEdits[seg.id] || {}, { [field]: value });
    if (field === 'label') {
      const r = wsRegions && wsRegions.getRegions().find(x => x.id === seg.id);
      if (r && r.setOptions) r.setOptions({ content: value || '♪' });
    }
    clearTimeout(debounceTimers[seg.id]);
    debounceTimers[seg.id] = setTimeout(() => {
      const fields = pendingEdits[seg.id];
      delete pendingEdits[seg.id];
      delete debounceTimers[seg.id];
      if (fields) this.saveSegment(seg, fields);
    }, DEBOUNCE_MS);
  },

  /* ===================== Persistenz (mit Offline-Queue) ===================== */
  async saveSegment(seg, fields) {
    const payload = Object.assign({}, fields, { updated_at: new Date().toISOString() });
    db.segments.put(JSON.parse(JSON.stringify(seg))).catch(() => {});
    try {
      const { error } = await sb.from('choreo_segments').update(payload).eq('id', seg.id);
      if (error) throw error;
    } catch (e) {
      await this.queue('choreo_segments', 'update', seg.id, payload);
      this.setStatus('Offline – Änderung gespeichert, wird später synchronisiert');
    }
  },

  async persistInsert(seg) {
    const row = { id: seg.id, project_id: seg.project_id, timestamp: seg.timestamp, label: seg.label, notes: seg.notes };
    try {
      const { error } = await sb.from('choreo_segments').insert(row);
      if (error) throw error;
    } catch (e) {
      await this.queue('choreo_segments', 'insert', seg.id, row);
      this.setStatus('Offline – Marke gespeichert, wird später synchronisiert');
    }
  },

  async persistDelete(seg) {
    try {
      const { error } = await sb.from('choreo_segments').delete().eq('id', seg.id);
      if (error) throw error;
    } catch (e) {
      await this.queue('choreo_segments', 'delete', seg.id, null);
    }
  },

  async queue(table, op, key, payload) {
    await db.syncQueue.add({ table, op, key, payload, timestamp: Date.now() }).catch(() => {});
  },

  async processSyncQueue() {
    if (!navigator.onLine) return;
    let items;
    try { items = await db.syncQueue.orderBy('id').toArray(); } catch (e) { return; }
    for (const it of items) {
      try {
        if (it.op === 'update') {
          const { error } = await sb.from(it.table).update(it.payload).eq('id', it.key);
          if (error) throw error;
        } else if (it.op === 'insert') {
          const { error } = await sb.from(it.table).upsert(it.payload);
          if (error) throw error;
        } else if (it.op === 'delete') {
          const { error } = await sb.from(it.table).delete().eq('id', it.key);
          if (error) throw error;
        }
        await db.syncQueue.delete(it.id);
      } catch (e) {
        break; // bei Fehler abbrechen, später erneut versuchen
      }
    }
  },

  /* --- synchroner Flush beim Verstecken der Seite (keepalive) --- */
  flushPending() {
    const ids = Object.keys(pendingEdits);
    if (!ids.length) return;
    for (const id of ids) {
      clearTimeout(debounceTimers[id]);
      delete debounceTimers[id];
      const fields = pendingEdits[id];
      delete pendingEdits[id];
      const payload = Object.assign({}, fields, { updated_at: new Date().toISOString() });
      try {
        fetch(`${SUPABASE_URL}/rest/v1/choreo_segments?id=eq.${id}`, {
          method: 'PATCH',
          keepalive: true,
          headers: Object.assign({}, restHeaders(), { Prefer: 'return=minimal' }),
          body: JSON.stringify(payload)
        }).catch(() => this.queue('choreo_segments', 'update', id, payload));
      } catch (e) {
        this.queue('choreo_segments', 'update', id, payload);
      }
    }
  },

  /* ===================== Heartbeat-Locking ===================== */
  async toggleMode() {
    if (!this.project) return;
    if (this.currentMode === 'training') {
      if (!this.isEditor) { this.openLogin(); return; }   // Bearbeiten nur mit Login
      await this.enterEditor();
    } else {
      await this.exitEditor();
    }
  },

  async enterEditor() {
    try {
      const ok = await this.acquireLock();
      if (!ok) {
        this.setStatus(`Gesperrt – wird von ${this.lockedByOther} bearbeitet`);
        return;
      }
    } catch (e) {
      if (!navigator.onLine) {
        this.setStatus('Offline-Bearbeitung – Änderungen werden synchronisiert');
      } else {
        this.setStatus('Sperre fehlgeschlagen: ' + e.message);
        return;
      }
    }
    this.currentMode = 'editor';
    this.renderRegions();
    if (this.lockOwned) this.startHeartbeat();
  },

  async exitEditor() {
    this.flushPending();
    await this.releaseLock();
    this.currentMode = 'training';
    this.renderRegions();
  },

  async acquireLock() {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();
    const { data, error } = await sb.from('projects')
      .update({ locked_by: this.userId, locked_by_name: this.userName, locked_at: now })
      .eq('id', this.project.id)
      .or(`locked_by.is.null,locked_by.eq.${this.userId},locked_at.lt.${cutoff}`)
      .select();
    if (error) throw error;
    if (data && data.length) { this.lockOwned = true; this.lockedByOther = null; return true; }
    // Wer hält den Lock?
    const { data: cur } = await sb.from('projects').select('locked_by_name').eq('id', this.project.id).single();
    this.lockedByOther = (cur && cur.locked_by_name) || 'jemand anderem';
    this.lockOwned = false;
    return false;
  },

  startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      if (!this.project || this.currentMode !== 'editor') return;
      try {
        const { data, error } = await sb.from('projects')
          .update({ locked_at: new Date().toISOString(), locked_by_name: this.userName })
          .eq('id', this.project.id).eq('locked_by', this.userId).select();
        if (error) throw error;
        if (!data || !data.length) this.onLockLost();
      } catch (e) { /* Netzfehler im Heartbeat ignorieren */ }
    }, HEARTBEAT_MS);
  },

  async verifyLockStillOurs() {
    if (!this.project) return;
    try {
      const { data } = await sb.from('projects')
        .update({ locked_at: new Date().toISOString() })
        .eq('id', this.project.id).eq('locked_by', this.userId).select();
      if (!data || !data.length) this.onLockLost();
    } catch (e) {}
  },

  onLockLost() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    this.lockOwned = false;
    this.currentMode = 'training';
    this.renderRegions();
    this.setStatus('Bearbeitung beendet – Sperre wurde von jemand anderem übernommen');
  },

  async releaseLock() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (!this.project || !this.lockOwned) { this.lockOwned = false; return; }
    this.lockOwned = false;
    try {
      await sb.from('projects')
        .update({ locked_by: null, locked_by_name: null, locked_at: null })
        .eq('id', this.project.id).eq('locked_by', this.userId);
    } catch (e) {}
  },

  releaseLockBeacon() {
    if (!this.project || !this.lockOwned) return;
    try {
      fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${this.project.id}&locked_by=eq.${this.userId}`, {
        method: 'PATCH',
        keepalive: true,
        headers: Object.assign({}, restHeaders(), { Prefer: 'return=minimal' }),
        body: JSON.stringify({ locked_by: null, locked_by_name: null, locked_at: null })
      }).catch(() => {});
    } catch (e) {}
  },

  /* ===================== Upload / Projekt anlegen ===================== */
  onFilePick(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (!['mp3', 'wav'].includes(ext)) {
      this.uploadError = 'Nur MP3 oder WAV werden unterstützt (m4a/AAC ist mit vielen Browsern nicht kompatibel).';
      this.form.file = null;
      e.target.value = '';
      return;
    }
    this.form.file = f;
    this.uploadError = null;
    if (!this.form.title) this.form.title = f.name.replace(/\.[^.]+$/, '');
  },

  prettySize(bytes) {
    if (!bytes && bytes !== 0) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
  },

  async createProject() {
    if (this.uploading || !this.form.title || !this.form.file) return;
    this.uploading = true; this.uploadProgress = 0; this.uploadError = null;
    const file = this.form.file;
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
    const path = `${uuid()}.${ext}`;

    try {
      await this.xhrUpload(file, path, (p) => { this.uploadProgress = p; });
      const audio_url = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;

      const row = {
        title: this.form.title.trim(),
        bpm: Number(this.form.bpm) || 120,
        time_signature: this.form.time_signature,
        audio_url
      };
      const { data, error } = await sb.from('projects').insert(row).select().single();
      if (error) throw error;

      // initialen Tempo-Abschnitt anlegen (gesamtes Lied)
      const tsec = {
        id: uuid(), project_id: data.id, sort_index: 0, label: null,
        start_sec: 0, end_sec: null,
        bpm: Number(this.form.bpm) || 120,
        time_signature: this.form.time_signature, offset_sec: 0
      };
      try { const r = await sb.from('tempo_sections').insert(tsec); if (r.error) throw r.error; }
      catch (e) { await this.queue('tempo_sections', 'insert', tsec.id, tsec); }

      // Blob sofort cachen -> erstes Öffnen ist instant & offline
      await db.audioCache.put({ projectId: data.id, blob: file, cachedAt: Date.now() }).catch(() => {});

      this.uploading = false;
      this.form = { title: '', bpm: 120, time_signature: '4/4', file: null };
      await this.loadProjects();
      await this.openProject(data);
      this.setStatus('Projekt angelegt');
    } catch (e) {
      this.uploading = false;
      this.uploadError = 'Upload fehlgeschlagen: ' + (e.message || e);
    }
  },

  xhrUpload(file, path, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      this._xhr = xhr;
      xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`);
      xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);  // JWT des Editors (RLS)
      xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
      xhr.setRequestHeader('x-upsert', 'true');
      xhr.setRequestHeader('cache-control', '3600');
      if (file.type) xhr.setRequestHeader('content-type', file.type);
      xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
      xhr.onload = () => {
        this._xhr = null;
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`HTTP ${xhr.status} ${xhr.responseText || ''}`.trim()));
      };
      xhr.onerror = () => { this._xhr = null; reject(new Error('Netzwerkfehler')); };
      xhr.onabort = () => { this._xhr = null; reject(new Error('abgebrochen')); };
      xhr.send(file);
    });
  },

  abortUpload() { if (this._xhr) this._xhr.abort(); this.uploading = false; },

  async confirmDeleteProject(p) {
    if (!confirm(`Projekt „${p.title}" wirklich löschen? Alle Segmente gehen verloren.`)) return;
    try {
      const { error } = await sb.from('projects').delete().eq('id', p.id);
      if (error) throw error;
      await db.audioCache.delete(p.id).catch(() => {});
      await db.segments.where('project_id').equals(p.id).delete().catch(() => {});
      if (this.project && this.project.id === p.id) {
        this.destroyWs();
        this.project = null;
        this.segments = [];
      }
      await this.loadProjects();
      this.setStatus('Projekt gelöscht');
    } catch (e) {
      this.setStatus('Löschen fehlgeschlagen (offline?)');
    }
  },

  /* ===================== Utils ===================== */
  fmt(sec) {
    sec = Number(sec) || 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const cs = Math.floor((sec * 100) % 100);
    return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  },

  setStatus(msg) {
    this.toast = msg;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toast = ''; }, 3200);
  }
}));

window.Alpine = Alpine;
Alpine.start();
