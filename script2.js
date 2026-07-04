const obs = new OBSWebSocket();
let syncInterval = null;
let isObsConnected = false;
let reconnectTimer = null;
let currentSceneName = ''; // ชื่อ Scene ปัจจุบันที่กำลังเปิดอยู่ใน OBS (ดึงอัตโนมัติ ไม่ต้องพิมพ์เอง)

// ----------------------------------------------------------------
// SYSTEM STATE (Generic Table → OBS Source Builder)
// ----------------------------------------------------------------
// fields: [{ id, name, col, type }]  -- type: 'text' | 'image'
//   ผู้ใช้กำหนดเอง ไม่มี preset ตายตัว ใช้ได้กับตารางอะไรก็ได้
// teamList: [1, 2, 3, ...] -- ลำดับทีม/แถวที่เพิ่มเองได้ ไม่จำกัดจำนวน
//   ทีมที่ n → แถวในชีต = startRow + (n - 1)
let fields = [];
let teamList = [];
let fieldSeq = 0;

const FIELDS_STORAGE_KEY = 'fields_p2';
const TEAMLIST_STORAGE_KEY = 'teamCount_p2'; // เก็บแค่จำนวน แล้ว rebuild array ตอนโหลด
const PREFIX_STORAGE_KEY = 'sourcePrefix_p2';

// ----------------------------------------------------------------
// Utilities
// ----------------------------------------------------------------
function writeLog(msg) {
    const log = document.getElementById('debug-log');
    if (log) {
        log.innerHTML = `[${new Date().toLocaleTimeString()}] ${msg}<br>` + log.innerHTML;
    }
}

function colToIndex(colLetter) {
    if (!colLetter) return -1;
    // รองรับคอลัมน์เกิน Z (AA, AB, ...) เผื่ออนาคต
    const letters = colLetter.toUpperCase().trim();
    let idx = 0;
    for (let i = 0; i < letters.length; i++) {
        const code = letters.charCodeAt(i) - 65;
        if (code < 0 || code > 25) return -1;
        idx = idx * 26 + (code + 1);
    }
    return idx - 1;
}

/**
 * CSV parser ที่รองรับ field ที่มี comma ซ่อนอยู่ใน double-quote
 * เช่น  "Team A, Jr.",C:\path\logo.png,...
 * และรองรับ "" (escaped quote) ภายใน field ที่ครอบด้วย quote ตามมาตรฐาน CSV
 */
function parseCSV(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let inQuote = false;
    let i = 0;
    const len = text.length;

    while (i < len) {
        const ch = text[i];

        if (inQuote) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    // "" → quote ที่ถูก escape ภายใน field
                    cur += '"';
                    i += 2;
                    continue;
                }
                inQuote = false;
                i++;
                continue;
            }
            cur += ch;
            i++;
            continue;
        }

        if (ch === '"') {
            inQuote = true;
            i++;
            continue;
        }
        if (ch === ',') {
            row.push(cur);
            cur = '';
            i++;
            continue;
        }
        if (ch === '\r') {
            i++;
            continue;
        }
        if (ch === '\n') {
            row.push(cur);
            rows.push(row);
            row = [];
            cur = '';
            i++;
            continue;
        }
        cur += ch;
        i++;
    }
    // แถวสุดท้ายที่ไม่มี \n ปิดท้าย
    if (cur.length > 0 || row.length > 0) {
        row.push(cur);
        rows.push(row);
    }
    return rows;
}

/** ตัดอักขระแปลกๆ (\r \n " ที่หลุดมา) และ trim ค่าที่อ่านจากเซลล์ */
function cleanCell(raw) {
    return (raw || '').replace(/[\r\n]+/g, '').trim();
}

// ----------------------------------------------------------------
// OBS Connection (พร้อม Auto-Reconnect)
// ----------------------------------------------------------------
function setConnectionUI(connected) {
    isObsConnected = connected;

    // ── Legacy status text (ถ้ายังมีอยู่) ──
    const el = document.getElementById('status-text');
    if (el) {
        el.innerText = connected ? 'Status: Connected to OBS' : 'Status: OBS Disconnected';
        el.style.color = connected ? '#00c05a' : '#ff3b30';
    }

    // ── New widget ──
    const dot = document.getElementById('obs-dot-indicator');
    const label = document.getElementById('obs-widget-label');
    if (dot && label) {
        dot.className = 'obs-dot ' + (connected ? 'connected' : 'disconnected');
        label.textContent = connected ? 'เชื่อมต่อสำเร็จ' : 'ยังไม่เชื่อมต่อ';
        label.style.color = connected ? '#00c05a' : '#ff3b6e';
    }
}

function setConnectingUI() {
    const dot = document.getElementById('obs-dot-indicator');
    const label = document.getElementById('obs-widget-label');
    if (dot && label) {
        dot.className = 'obs-dot connecting';
        label.textContent = 'กำลังเชื่อมต่อ...';
        label.style.color = '#ffcc00';
    }
}

async function connectOBS() {
    setConnectingUI();
    try {
        await obs.connect('ws://127.0.0.1:4455');
        setConnectionUI(true);
        writeLog('✅ Connected to OBS v5');
        if (reconnectTimer) {
            clearInterval(reconnectTimer);
            reconnectTimer = null;
        }
        await refreshCurrentScene();
    } catch (e) {
        setConnectionUI(false);
        writeLog('❌ OBS Connection Failed! กรุณาตรวจสอบ OBS WebSocket');
        scheduleReconnect();
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setInterval(async () => {
        if (isObsConnected) return;
        setConnectingUI(); // แสดงสถานะว่ากำลังพยายามเชื่อมต่อ
        try {
            await obs.connect('ws://127.0.0.1:4455');
            setConnectionUI(true);
            writeLog('🔁 เชื่อมต่อ OBS กลับมาสำเร็จ');
            clearInterval(reconnectTimer);
            reconnectTimer = null;
            await refreshCurrentScene();
        } catch (e) {
            setConnectionUI(false); // กลับเป็นสีแดงหากเชื่อมต่อไม่สำเร็จในรอบนี้
        }
    }, 4000);
}

obs.on('ConnectionClosed', () => {
    setConnectionUI(false);
    writeLog('⚠️ OBS หลุดการเชื่อมต่อ กำลังพยายามเชื่อมต่อใหม่...');
    setCurrentSceneDisplay('', false);
    scheduleReconnect();
});

// ----------------------------------------------------------------
// Current Scene (auto-detect) — แทนการให้ผู้ใช้พิมพ์ชื่อ Scene เอง
// ใช้ Scene ที่กำลังเปิดอยู่ใน OBS ณ ขณะนั้นเป็น target เสมอ
// ----------------------------------------------------------------
async function refreshCurrentScene() {
    if (!isObsConnected) return;
    try {
        const res = await obs.call('GetCurrentProgramScene');
        currentSceneName = res.currentProgramSceneName || res.sceneName || '';
        setCurrentSceneDisplay(currentSceneName, true);
    } catch (err) {
        writeLog(`⚠️ ดึงชื่อ Scene ปัจจุบันไม่สำเร็จ: ${err.message}`);
        setCurrentSceneDisplay('', false);
    }
}

function setCurrentSceneDisplay(name, live) {
    const box = document.getElementById('currentSceneDisplay');
    const label = document.getElementById('currentSceneName');
    if (!box || !label) return;
    box.classList.toggle('live', !!live);
    label.textContent = live && name ? name : '— ยังไม่เชื่อมต่อ OBS —';
}

// อัปเดตชื่อ Scene ปัจจุบันทันทีที่ผู้ใช้สลับ Scene ใน OBS (ไม่ต้องกดอะไรเพิ่ม)
obs.on('CurrentProgramSceneChanged', (data) => {
    currentSceneName = data.sceneName || '';
    setCurrentSceneDisplay(currentSceneName, true);
});

/** เรียก SetInputSettings แบบปลอดภัย ไม่ throw ออกไปทำให้ทั้งกระบวนการหยุด */
async function safeSetInput(inputName, inputSettings) {
    if (!isObsConnected) return { ok: false, error: 'OBS not connected' };
    try {
        await obs.call('SetInputSettings', { inputName, inputSettings });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ----------------------------------------------------------------
// Logo Base Path
// ----------------------------------------------------------------

/** ทำ path ให้มี / ลงท้าย และแปลง \ → / */
function normFolder(raw) {
    let p = (raw || '').replace(/\\/g, '/').trim();
    if (p && !p.endsWith('/')) p += '/';
    return p;
}

/** เติม .png อัตโนมัติถ้าชื่อไฟล์ไม่มีนามสกุล */
function ensureExtension(filename) {
    if (/\.(png|jpg|jpeg|webp|gif)$/i.test(filename)) return filename;
    return filename + '.png';
}

/** คืน full path สำหรับส่งไป OBS */
function buildLogoPath(rawValueFromSheet) {
    const cleaned = cleanCell(rawValueFromSheet).replace(/"/g, '');
    if (!cleaned) return '';

    const base = normFolder(document.getElementById('logoBasePath').value);
    return base + ensureExtension(cleaned);
}

/** อัปเดต hint แสดง path ตัวอย่าง */
function updatePathHint() {
    const base = normFolder(document.getElementById('logoBasePath').value || 'C:/Logos/');
    const hint = document.getElementById('pathPreviewHint');
    if (hint) hint.textContent = base + 'TeamA.png';
}

function onBasePathInput() {
    updatePathHint();
    document.getElementById('btnSavePath').textContent = '💾 Save';
    document.getElementById('btnSavePath').classList.remove('saved');
}

function saveLogoPath() {
    const val = document.getElementById('logoBasePath').value;
    localStorage.setItem('logoBasePath_p2', val);
    const btn = document.getElementById('btnSavePath');
    btn.textContent = '✅ Saved!';
    btn.classList.add('saved');
    setTimeout(() => {
        btn.textContent = '💾 Save';
        btn.classList.remove('saved');
    }, 2000);
    updatePathHint();
    writeLog(`💾 บันทึก Base Path: ${val}`);
}

/** ตรวจสอบและบันทึกช่วง Row Start-End ทุกครั้งที่ผู้ใช้พิมพ์ค่าใหม่ */
function onRowRangeInput() {
    const startEl = document.getElementById('startRow');
    const endEl = document.getElementById('endRow');
    const hint = document.getElementById('rowRangeHint');
    if (!startEl || !endEl) return;

    const start = parseInt(startEl.value, 10);
    const end = parseInt(endEl.value, 10);

    localStorage.setItem('rowStart_p2', startEl.value);
    localStorage.setItem('rowEnd_p2', endEl.value);

    if (!hint) return;

    if (isNaN(start) || isNaN(end)) {
        hint.textContent = 'กรุณากรอกตัวเลขแถวให้ครบทั้งสองช่อง';
        hint.style.color = '#ff3b30';
        return;
    }
    if (end < start) {
        hint.textContent = '"แถวสิ้นสุด" ต้องมากกว่าหรือเท่ากับ "แถวเริ่มต้น"';
        hint.style.color = '#ff3b30';
        return;
    }

    const span = end - start + 1;
    const n = teamList.length;
    hint.style.color = '#666';
    hint.textContent = span < n
        ? `ช่วงนี้มี ${span} แถว — ถ้ามีทีมครบ ${n} ทีม ควรขยาย "แถวสิ้นสุด" ให้กว้างกว่านี้ (เผื่อแถวว่าง/หัวตาราง)`
        : `จะสแกนแถว ${start} ถึง ${end} (รวม ${span} แถว) แล้วดึงข้อมูลทีมจริงตามจำนวนทีมที่เพิ่มไว้ (${n} ทีม) ข้ามแถวว่าง/หัวตารางอัตโนมัติ`;
}

// ----------------------------------------------------------------
// Google Sheets: ดึง CSV แบบรองรับหลายแท็บ (gid) + cache ระหว่าง sync รอบเดียวกัน
// ----------------------------------------------------------------

/** แปลง Google Sheet URL (เวอร์ชันใดก็ได้) ให้เป็น export CSV URL ของ "แท็บหลัก" (ไม่มี gid ระบุ) */
function buildBaseCsvUrl(rawUrl) {
    return rawUrl
        .replace(/\/edit.*$/, '/export?format=csv')
        .replace(/\/pub.*$/, '/export?format=csv');
}

/** ดึง sheetId จาก URL เช่น .../d/<ID>/edit... */
function extractSheetId(rawUrl) {
    const m = rawUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : null;
}

/**
 * ดึง gid ปัจจุบันจาก URL (เช่น #gid=12345 หรือ ?gid=12345)
 * ใช้เป็นค่า fallback เมื่อผู้ใช้ระบุ tab name ว่างไว้
 */
function extractGidFromUrl(rawUrl) {
    const m = rawUrl.match(/gid=([0-9]+)/);
    return m ? m[1] : '0';
}

/**
 * ดึงรายชื่อแท็บทั้งหมดในไฟล์ (ชื่อ → gid) โดยอ่านจากหน้า HTML ของชีต (เผยแพร่สาธารณะ)
 * ใช้สำหรับแปลง "ชื่อแท็บ" ที่ผู้ใช้กรอกเป็น gid จริง
 * คืนค่า Map<tabNameLowercase, gid> หรือ null ถ้าดึงไม่ได้ (เช่น ชีตไม่ได้แชร์สาธารณะแบบเต็ม)
 */
async function fetchTabGidMap(sheetId) {
    try {
        const url = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const html = await res.text();

        // Google ฝังข้อมูล sheet ไว้ใน JS object ของหน้า HTML เป็น [["ชื่อแท็บ", gid, ...], ...] รูปแบบหลากหลาย
        // ใช้ regex หาคู่ name/gid ที่พบบ่อยในหน้า edit (ไม่ผูกกับ schema เป๊ะ ๆ เพราะ Google เปลี่ยนได้)
        const map = new Map();
        const re = /"([^"\\]{1,80})"\s*,\s*null\s*,\s*(\d+)\s*,/g;
        let match;
        while ((match = re.exec(html)) !== null) {
            map.set(match[1].toLowerCase(), match[2]);
        }
        return map.size > 0 ? map : null;
    } catch (e) {
        return null;
    }
}

/**
 * Cache ของข้อมูลแต่ละแท็บ ระหว่าง 1 รอบ sync (กันดึงซ้ำซ้อนถ้าหลาย Custom Source ใช้แท็บเดียวกัน)
 * key = gid (string)
 */
function createSheetCache(sheetId, fallbackGid, tabGidMap) {
    const cache = new Map();

    async function getRowsForTab(tabName) {
        let gid = fallbackGid;
        if (tabName && tabName.trim()) {
            const wanted = tabName.trim().toLowerCase();
            if (tabGidMap && tabGidMap.has(wanted)) {
                gid = tabGidMap.get(wanted);
            } else {
                // หา gid ไม่เจอจากชื่อ → log เตือน แต่ยัง fallback ไปแท็บหลักเพื่อไม่ให้ระบบหยุดทำงานทั้งหมด
                writeLog(`⚠️ หาแท็บชื่อ "${tabName}" ไม่เจอ ใช้แท็บหลักแทน (ตรวจสอบชื่อแท็บให้ตรงเป๊ะ)`);
            }
        }

        if (cache.has(gid)) return cache.get(gid);

        const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} (gid=${gid})`);
        const text = await res.text();
        const rows = parseCSV(text);
        cache.set(gid, rows);
        return rows;
    }

    return { getRowsForTab };
}

// ----------------------------------------------------------------
// SYSTEM: Prefix Input
// ----------------------------------------------------------------
function onPrefixInput() {
    const val = document.getElementById('sourcePrefix').value.trim() || 'Team';
    localStorage.setItem(PREFIX_STORAGE_KEY, val);
    updateCreateButtonLabel();
}

function getPrefix() {
    const val = document.getElementById('sourcePrefix').value.trim();
    return val || 'Team';
}

// ----------------------------------------------------------------
// SYSTEM: Field Builder (Custom Columns — blank canvas, ไม่มี preset)
// ----------------------------------------------------------------
function genFieldId() {
    fieldSeq++;
    return 'f_' + Date.now() + '_' + fieldSeq;
}

function loadFields() {
    try {
        const raw = localStorage.getItem(FIELDS_STORAGE_KEY);
        if (raw) {
            fields = JSON.parse(raw);
        }
    } catch (e) {
        fields = [];
    }
    renderFieldList();
}

function saveFields() {
    localStorage.setItem(FIELDS_STORAGE_KEY, JSON.stringify(fields));
}

function addFieldRow() {
    fields.push({
        id: genFieldId(),
        name: '',
        col: '',
        type: 'text', // 'text' | 'image'
    });
    saveFields();
    renderFieldList();
    writeLog('➕ เพิ่ม Field ใหม่');
}

function removeFieldRow(id) {
    fields = fields.filter(f => f.id !== id);
    saveFields();
    renderFieldList();
    writeLog('🗑️ ลบ Field');
}

function updateFieldValue(id, key, value) {
    const f = fields.find(x => x.id === id);
    if (!f) return;
    f[key] = value;
    saveFields();
    updateCreateButtonLabel();
    // อัปเดตแค่ preview ของ source name โดยไม่ re-render ทั้งลิสต์ (กัน input เสียโฟกัสตอนพิมพ์)
    const previewEl = document.querySelector(`.field-card[data-id="${id}"] .field-name-preview`);
    if (previewEl) previewEl.textContent = buildFieldNamePreview(f);
}

function setFieldType(id, type) {
    const f = fields.find(x => x.id === id);
    if (!f) return;
    f.type = type;
    saveFields();
    renderFieldList();
}

function buildFieldNamePreview(f) {
    const prefix = getPrefix();
    const fname = (f.name || 'Field').trim() || 'Field';
    return `→ ${prefix}-${fname}-N`;
}

function renderFieldList() {
    const container = document.getElementById('fieldList');
    if (!container) return;

    if (fields.length === 0) {
        container.innerHTML = `<div class="field-empty-hint">
            ยังไม่มี Field — กด "+ เพิ่ม Field" เพื่อสร้างคอลัมน์แรก เช่น ชื่อทีม, คะแนน, โลโก้ ฯลฯ
        </div>`;
        updateCreateButtonLabel();
        return;
    }

    container.innerHTML = fields.map(f => {
        const isText = f.type !== 'image';
        return `
        <div class="field-card" data-id="${f.id}">
            <div class="field-type-toggle">
                <button type="button" class="field-type-btn ${isText ? 'active' : ''}"
                    onclick="setFieldType('${f.id}', 'text')">🔤 Text</button>
                <button type="button" class="field-type-btn ${!isText ? 'active' : ''}"
                    onclick="setFieldType('${f.id}', 'image')">🖼️ Image</button>
            </div>
            <input type="text" class="field-name-input" placeholder="ชื่อ Field เช่น Name, Score, Logo"
                value="${escapeHtml(f.name)}"
                oninput="updateFieldValue('${f.id}', 'name', this.value)">
            <input type="text" class="field-col-input" maxlength="3" placeholder="B"
                value="${escapeHtml(f.col)}"
                oninput="this.value=this.value.toUpperCase(); updateFieldValue('${f.id}', 'col', this.value)">
            <span class="field-name-preview">${escapeHtml(buildFieldNamePreview(f))}</span>
            <button type="button" class="field-delete-btn" title="ลบ Field นี้"
                onclick="removeFieldRow('${f.id}')">✕</button>
        </div>`;
    }).join('');

    updateCreateButtonLabel();
}

// ----------------------------------------------------------------
// SYSTEM: Team List (เพิ่ม/ลบเองได้ ไม่จำกัดจำนวน)
// ----------------------------------------------------------------
function loadTeamList() {
    const saved = parseInt(localStorage.getItem(TEAMLIST_STORAGE_KEY), 10);
    const n = (!isNaN(saved) && saved > 0) ? saved : 4; // ค่าเริ่มต้น 4 ทีม เผื่อผู้ใช้ใหม่
    teamList = [];
    for (let i = 1; i <= n; i++) teamList.push(i);
    renderTeamList();
}

function saveTeamListCount() {
    localStorage.setItem(TEAMLIST_STORAGE_KEY, String(teamList.length));
}

function addTeam() {
    teamList.push(teamList.length + 1);
    saveTeamListCount();
    renderTeamList();
    onRowRangeInput();
}

function removeLastTeam() {
    if (teamList.length === 0) return;
    teamList.pop();
    saveTeamListCount();
    renderTeamList();
    onRowRangeInput();
}

function removeTeamAt(n) {
    // ลบทีมที่ตำแหน่ง n แล้วเรียงเลขใหม่ทั้งหมดให้ต่อเนื่อง 1..length
    teamList = teamList.filter(t => t !== n).map((_, idx) => idx + 1);
    saveTeamListCount();
    renderTeamList();
    onRowRangeInput();
}

function renderTeamList() {
    const grid = document.getElementById('teamChipGrid');
    const countDisplay = document.getElementById('teamCountDisplay');
    const startRowEl = document.getElementById('startRow');
    if (countDisplay) countDisplay.textContent = String(teamList.length);
    if (!grid) {
        updateCreateButtonLabel();
        return;
    }

    const startRow = parseInt(startRowEl ? startRowEl.value : '2', 10) || 2;

    if (teamList.length === 0) {
        grid.innerHTML = `<span style="font-size:12px;color:#666;">ยังไม่มีทีม — กด "+ เพิ่มทีม"</span>`;
        updateCreateButtonLabel();
        return;
    }

    grid.innerHTML = teamList.map(n => {
        const row = startRow + (n - 1);
        return `
        <div class="team-chip">
            #${n} <span class="row-hint">(แถว ${row})</span>
            <button type="button" class="team-chip-remove" title="ลบทีมนี้"
                onclick="removeTeamAt(${n})">✕</button>
        </div>`;
    }).join('');

    updateCreateButtonLabel();
}

// ----------------------------------------------------------------
// SYSTEM: Create button label + hint (อัปเดตตาม fields x teamList)
// ----------------------------------------------------------------
function updateCreateButtonLabel() {
    const btn = document.getElementById('autoCreateBtn');
    const hint = document.getElementById('autoCreateHint');
    if (!btn) return;

    const total = fields.length * teamList.length;
    btn.textContent = `+ สร้าง & Sync ข้อมูลขึ้น OBS (${total} Sources)`;

    if (hint) {
        if (fields.length === 0 || teamList.length === 0) {
            hint.innerHTML = 'เพิ่ม Field และทีมก่อน เพื่อดูรายการ Source ที่จะถูกสร้าง/อัปเดต';
        } else {
            const prefix = getPrefix();
            hint.innerHTML = `ระบบจะสร้าง/อัปเดต Source ต่อไปนี้ (ตัวอย่างทีม 1):<br>` +
                fields.map(f => {
                    const fname = (f.name || '(ยังไม่ตั้งชื่อ)').trim() || '(ยังไม่ตั้งชื่อ)';
                    const typeTag = f.type === 'image' ? '🖼️' : '🔤';
                    return `&nbsp;&nbsp;* ${typeTag} ${prefix}-${fname}-1 ... ${prefix}-${fname}-${teamList.length}`;
                }).join('<br>');
        }
    }
}

// ----------------------------------------------------------------
// SYSTEM: Create (ถ้ายังไม่มี) & Sync ข้อมูลขึ้น OBS ในปุ่มเดียว
// ทำงานกับ fields[] x teamList[] แบบ generic ไม่ผูกกับ BR/เกมใดๆ
// ----------------------------------------------------------------
let cachedTextKind = null; // cache ชนิด text source ของเครื่อง กันสแกนซ้ำทุกรอบ sync

async function detectTextKind() {
    if (cachedTextKind) return cachedTextKind;
    let textKind = 'text_gdiplus_v2';
    try {
        const req = await obs.call('GetInputKindList');
        const kinds = req.inputKinds || [];
        if (kinds.includes('text_gdiplus_v2')) textKind = 'text_gdiplus_v2';
        else if (kinds.includes('text_ft2_source_v2')) textKind = 'text_ft2_source_v2';
        else if (kinds.includes('text_gdiplus')) textKind = 'text_gdiplus';
        else if (kinds.includes('text_ft2_source')) textKind = 'text_ft2_source';
        writeLog(`✅ พบโมดูล Text: [${textKind}]`);
    } catch (err) {
        writeLog(`⚠️ ดึงข้อมูลโมดูล Text ไม่สำเร็จ ใช้ค่าเริ่มต้น: [${textKind}]`);
    }
    cachedTextKind = textKind;
    return textKind;
}

/**
 * สร้าง Source ถ้ายังไม่มีใน Scene แล้วเซ็ตค่าให้ทันที (ไม่ throw ออกไปทั้งกระบวนการ)
 * ใช้ CreateInput ก่อน ถ้า error เพราะมีชื่อซ้ำอยู่แล้ว → fallback ไปใช้ SetInputSettings แทน (อัปเดตของเดิม)
 */
async function ensureSourceAndSet(scene, inputName, kind, settingsForCreate, settingsForUpdate) {
    try {
        await obs.call('CreateInput', {
            sceneName: scene,
            inputName,
            inputKind: kind,
            inputSettings: settingsForCreate
        });
        return { ok: true, created: true };
    } catch (err) {
        // มี Source ชื่อนี้อยู่แล้ว (ไม่ว่าจะอยู่ใน scene นี้หรือที่อื่น) → อัปเดตค่าแทนการสร้างใหม่
        const result = await safeSetInput(inputName, settingsForUpdate);
        return { ok: result.ok, created: false, error: result.error };
    }
}

async function createAndSyncSources() {
    if (fields.length === 0) {
        alert('กรุณาเพิ่ม Field อย่างน้อย 1 รายการก่อนครับ');
        return;
    }
    if (teamList.length === 0) {
        alert('กรุณาเพิ่มทีมอย่างน้อย 1 ทีมก่อนครับ');
        return;
    }
    if (!isObsConnected) {
        alert('ยังไม่ได้เชื่อมต่อ OBS กรุณาตรวจสอบ OBS WebSocket ก่อนครับ');
        return;
    }

    // ดึง Scene ปัจจุบันสดๆ อีกครั้งก่อน sync เผื่อผู้ใช้สลับ Scene ไปแล้วแต่ event ยังมาไม่ถึง
    await refreshCurrentScene();
    const scene = currentSceneName;
    if (!scene) {
        alert('ไม่พบ Scene ปัจจุบันใน OBS กรุณาตรวจสอบการเชื่อมต่อ OBS ก่อนครับ');
        return;
    }

    const rawUrl = document.getElementById('sheetUrl').value.trim();
    if (!rawUrl.includes('docs.google.com/spreadsheets')) {
        alert('กรุณากรอก Google Sheet URL ให้ถูกต้องก่อนครับ (Section ด้านล่าง)');
        return;
    }
    localStorage.setItem('lastSheetUrl_p2', rawUrl);

    const prefix = getPrefix();

    // ตรวจสอบว่าทุก Field ตั้งชื่อ + คอลัมน์ครบหรือยัง
    const invalidField = fields.find(f => !f.name || !f.name.trim() || !f.col || colToIndex(f.col) < 0);
    if (invalidField) {
        alert('มี Field ที่ยังไม่ได้ตั้ง "ชื่อ" หรือ "คอลัมน์" ให้ครบ กรุณาตรวจสอบก่อนครับ');
        return;
    }

    const totalSources = fields.length * teamList.length;
    writeLog(`▶️ เริ่มสร้าง/อัปเดต ${totalSources} Sources (${teamList.length} ทีม x ${fields.length} field) ลงใน Scene: ${scene}`);

    writeLog('🔄 กำลังดึงข้อมูลจาก Google Sheets...');

    const csvUrl = buildBaseCsvUrl(rawUrl);
    let rows;
    try {
        const response = await fetch(csvUrl);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.text();
        rows = parseCSV(data);
    } catch (err) {
        writeLog(`❌ Error: ${err.message}`);
        return;
    }

    const startRowInput = parseInt(document.getElementById('startRow').value, 10);
    if (isNaN(startRowInput) || startRowInput < 1) {
        writeLog('❌ "แถวเริ่มต้น" ไม่ถูกต้อง');
        return;
    }
    const startRow0 = startRowInput - 1; // 0-based

    const textKind = await detectTextKind();

    const previewRows = [];
    let createdCount = 0, updatedCount = 0, errorCount = 0;

    for (let teamIdx = 0; teamIdx < teamList.length; teamIdx++) {
        const teamNum = teamList[teamIdx]; // เลขทีมที่ผู้ใช้กำหนด (อาจไม่ต่อเนื่องถ้าลบกลางลิสต์ — แต่ renderTeamList เรียงใหม่ให้ต่อเนื่องแล้ว)
        const currentRow = startRow0 + teamIdx; // ทีมที่ N → แถว startRow + (N-1) ตามที่ตกลงกันไว้
        const sheetRow = rows[currentRow];

        const rowResult = { i: teamNum, sheetRow: currentRow + 1, cells: {} };
        const jobs = [];

        for (const f of fields) {
            const colIdx = colToIndex(f.col);
            const rawValue = sheetRow ? cleanCell(sheetRow[colIdx]).replace(/"/g, '') : '';
            const inputName = `${prefix}-${f.name.trim()}-${teamNum}`;

            if (f.type === 'image') {
                const fullPath = buildLogoPath(rawValue);
                rowResult.cells[f.name] = { value: rawValue, display: fullPath, isImage: true };
                if (fullPath) {
                    jobs.push(
                        ensureSourceAndSet(scene, inputName, 'image_source', { file: fullPath }, { file: fullPath })
                            .then(r => ({ ...r, inputName }))
                    );
                }
            } else {
                rowResult.cells[f.name] = { value: rawValue, display: rawValue, isImage: false };
                jobs.push(
                    ensureSourceAndSet(scene, inputName, textKind, { text: rawValue }, { text: rawValue })
                        .then(r => ({ ...r, inputName }))
                );
            }
        }

        const results = await Promise.all(jobs);
        results.forEach(r => {
            if (r.ok && r.created) createdCount++;
            else if (r.ok && !r.created) updatedCount++;
            else {
                errorCount++;
                console.log(`⚠️ ${r.inputName}: ${r.error || 'ไม่สำเร็จ'}`);
            }
        });

        previewRows.push(rowResult);
    }

    writeLog(`📊 สรุป: สร้างใหม่ ${createdCount}, อัปเดต ${updatedCount}, ผิดพลาด ${errorCount} (จาก ${totalSources} Sources)`);
    renderPreviewTable(previewRows);

    // sync ชุด Custom Source (Section 0) ต่อจากชุดหลักเสมอ ใช้ rows เดิม กันดึงซ้ำ
    await syncCustomSources(rawUrl, rows);

    if (errorCount > 0 && createdCount === 0 && updatedCount === 0) {
        writeLog('⚠️ สร้าง/อัปเดต Source ไม่สำเร็จเลยครับ — กรุณาตรวจสอบชื่อ Scene และการเชื่อมต่อ OBS');
        flashCreateButton(false);
    } else {
        writeLog(`✅ เสร็จสิ้น! สร้างใหม่ ${createdCount}, อัปเดต ${updatedCount}, ผิดพลาด ${errorCount} — เช็คใน OBS ได้เลยครับ`);
        flashCreateButton(true);
    }
}

/** แสดงผลสำเร็จ/ไม่สำเร็จแบบไม่มี popup — เปลี่ยนสีปุ่มชั่วคราวแทน alert() */
function flashCreateButton(success) {
    const btn = document.getElementById('autoCreateBtn');
    if (!btn) return;
    const originalText = btn.textContent;
    const originalBg = btn.style.background;

    btn.textContent = success ? '✅ Sync สำเร็จ!' : '⚠️ Sync ไม่สำเร็จ';
    btn.style.background = success ? '#00c05a' : '#ff3b30';

    setTimeout(() => {
        btn.style.background = originalBg;
        updateCreateButtonLabel(); // คืนข้อความปุ่มให้ตรงกับ fields/teamList ปัจจุบัน
    }, 2200);
}

/** ปุ่ม "โหลดข้อมูล & sync" นอก modal — เรียกตัวเดียวกัน เผื่อผู้ใช้แค่อยาก refresh ข้อมูลโดยไม่เปิด modal */
async function fetchAndSyncSheets() {
    await createAndSyncSources();
}


// ----------------------------------------------------------------
// Preview Table (Dynamic columns ตาม fields[] ที่ผู้ใช้กำหนดเอง)
// ----------------------------------------------------------------
function renderPreviewTable(rows) {
    const panel = document.getElementById('previewPanel');
    const theadRow = document.getElementById('preview-thead-row');
    const tbody = document.getElementById('preview-tbody');
    if (!panel || !tbody || !theadRow) return;

    panel.style.display = 'block';

    // หัวตาราง: # + ชื่อ field ทุกตัวตามลำดับที่ผู้ใช้สร้างไว้
    // field ที่เป็น image จะมี 2 คอลัมน์ (Status + Path) ส่วน text มี 1 คอลัมน์
    let headHtml = '<th>#</th>';
    fields.forEach(f => {
        if (f.type !== 'image') {
            headHtml += `<th>${escapeHtml(f.name)}</th>`;
        }
    });
    theadRow.innerHTML = headHtml;

    tbody.innerHTML = '';

    rows.forEach(r => {
        let tds = `<td>${r.i}</td>`;

        fields.forEach(f => {
            const cell = r.cells[f.name];
            if (!cell) {
                tds += f.type === 'image' ? `<td>-</td><td>-</td>` : `<td>-</td>`;
                return;
            }
            if (cell.isImage) {
                // ไม่แสดงคอลัมน์ Logo ในตาราง preview
                return;
            } else {
                tds += `<td>${escapeHtml(cell.value) || '-'}</td>`;
            }
        });

        const tr = document.createElement('tr');
        tr.innerHTML = tds;
        tbody.appendChild(tr);
    });
}

/** ป้องกัน HTML/JS injection จากค่าที่มาจาก Google Sheet ก่อนแสดงผลในตาราง */
function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}



// ==================================================================
// SECTION 0: CUSTOM SOURCE MAPPING
// ------------------------------------------------------------------
// ผู้ใช้สามารถเพิ่ม Source กี่ตัวก็ได้ แต่ละตัวกำหนดเองว่า:
//   - เป็น Text หรือ Image
//   - ชื่อ Source ใน OBS
//   - อ้างอิง Row แบบ "Offset ตามทีม" (เลื่อนตามลำดับทีมเหมือน Section 2)
//        หรือ "Fixed" (เลขแถวตายตัว ไม่ขึ้นกับทีม)
//   - คอลัมน์ (ตัวอักษร เช่น B, AA)
//   - ชื่อแท็บ (sheet tab) ที่จะดึงข้อมูล ถ้าเว้นว่าง = แท็บหลักของ Section 2
// ==================================================================

let customSources = []; // [{ id, type, name, rowMode, row, col, tabName, collapsed }]
let customSourceSeq = 0;

const CUSTOM_SOURCE_STORAGE_KEY = 'customSources_p2';

function genCsId() {
    customSourceSeq++;
    return 'cs_' + Date.now() + '_' + customSourceSeq;
}

function loadCustomSources() {
    try {
        const raw = localStorage.getItem(CUSTOM_SOURCE_STORAGE_KEY);
        if (raw) {
            customSources = JSON.parse(raw);
        }
    } catch (e) {
        customSources = [];
    }
    renderCustomSourceList();
}

function saveCustomSources() {
    localStorage.setItem(CUSTOM_SOURCE_STORAGE_KEY, JSON.stringify(customSources));
}

function addCustomSourceRow() {
    customSources.push({
        id: genCsId(),
        type: 'text',          // 'text' | 'image'
        name: '',
        rowMode: 'offset',     // 'offset' | 'fixed'
        row: '2',
        col: 'B',
        tabName: '',
        collapsed: false,
    });
    saveCustomSources();
    renderCustomSourceList();
    writeLog('➕ เพิ่ม Custom Source ใหม่');
}

function removeCustomSourceRow(id) {
    customSources = customSources.filter(r => r.id !== id);
    saveCustomSources();
    renderCustomSourceList();
    writeLog('🗑️ ลบ Custom Source');
}

function updateCustomSourceField(id, field, value) {
    const row = customSources.find(r => r.id === id);
    if (!row) return;
    row[field] = value;
    saveCustomSources();
}

function setCustomSourceType(id, type) {
    const row = customSources.find(r => r.id === id);
    if (!row) return;
    row.type = type;
    saveCustomSources();
    renderCustomSourceList();
}

function setCustomSourceRowMode(id, mode) {
    const row = customSources.find(r => r.id === id);
    if (!row) return;
    row.rowMode = mode;
    saveCustomSources();
    renderCustomSourceList();
}

function toggleCustomSourceSettings(id) {
    const row = customSources.find(r => r.id === id);
    if (!row) return;
    row.collapsed = !row.collapsed;
    saveCustomSources();
    renderCustomSourceList();
}

function renderCustomSourceList() {
    const container = document.getElementById('customSourceList');
    if (!container) return;

    if (customSources.length === 0) {
        container.innerHTML = `<p style="font-size:12px;color:#666;margin:10px 0;">
            ยังไม่มี Custom Source — กดปุ่ม "เพิ่ม Source" ด้านล่างเพื่อเริ่มต้นครับ
        </p>`;
        return;
    }

    container.innerHTML = customSources.map(row => {
        const isText = row.type === 'text';
        const settingsOpen = !row.collapsed;
        const rowOffset = row.rowMode === 'offset';

        const summary = isText
            ? `Text → "${row.name || '(ยังไม่ตั้งชื่อ)'}" | ${rowOffset ? 'แถวเริ่ม' : 'แถวตายตัว'}: ${row.row || '-'} | คอลัมน์: ${row.col || '-'}${row.tabName ? ' | แท็บ: ' + row.tabName : ''}`
            : `Image → "${row.name || '(ยังไม่ตั้งชื่อ)'}" | ${rowOffset ? 'แถวเริ่ม' : 'แถวตายตัว'}: ${row.row || '-'} | คอลัมน์: ${row.col || '-'}${row.tabName ? ' | แท็บ: ' + row.tabName : ''}`;

        return `
        <div class="cs-row" data-id="${row.id}">
            <div class="cs-row-top">
                <div class="cs-type-toggle">
                    <button type="button" class="cs-type-btn ${isText ? 'active' : ''}" data-type="text"
                        onclick="setCustomSourceType('${row.id}', 'text')">🔤 Text</button>
                    <button type="button" class="cs-type-btn ${!isText ? 'active' : ''}" data-type="image"
                        onclick="setCustomSourceType('${row.id}', 'image')">🖼️ Image</button>
                </div>
                <input type="text" class="cs-name-input" placeholder="ชื่อ Source ใน OBS เช่น MVP_Name"
                    value="${escapeHtml(row.name)}"
                    oninput="updateCustomSourceField('${row.id}', 'name', this.value)">
                <button type="button" class="cs-icon-btn" title="ตั้งค่า Row/Column"
                    onclick="toggleCustomSourceSettings('${row.id}')">⚙️</button>
                <button type="button" class="cs-icon-btn cs-delete" title="ลบ Source นี้"
                    onclick="removeCustomSourceRow('${row.id}')">✕</button>
            </div>

            <div class="cs-summary">${escapeHtml(summary)}</div>

            <div class="cs-settings ${settingsOpen ? 'open' : ''}">
                <div style="font-size:11px;color:#aaa;margin-bottom:6px;">วิธีอ้างอิง Row</div>
                <div class="cs-mode-toggle">
                    <button type="button" class="cs-mode-btn ${rowOffset ? 'active' : ''}"
                        onclick="setCustomSourceRowMode('${row.id}', 'offset')">Offset ตามทีม</button>
                    <button type="button" class="cs-mode-btn ${!rowOffset ? 'active' : ''}"
                        onclick="setCustomSourceRowMode('${row.id}', 'fixed')">Fixed (แถวตายตัว)</button>
                </div>
                <p style="font-size:11px;color:#666;margin:0 0 10px;line-height:1.5;">
                    ${rowOffset
                ? 'ระบบจะวนซ้ำตามจำนวนทีมที่เจอจริง (เหมือน Section 2) เริ่มที่แถวด้านล่างนี้ แล้วเลื่อนลงทีละ 1 แถวต่อทีม'
                : 'ระบบจะดึงค่าจากแถวนี้แถวเดียวเสมอ ไม่ขึ้นกับจำนวนทีม (เหมาะกับข้อมูล Sponsor / MVP / หัวข้อพิเศษ)'}
                </p>

                <div class="cs-fields-grid">
                    <div class="cs-field">
                        <label>${rowOffset ? 'แถวเริ่มต้น (Row)' : 'แถว (Row)'}</label>
                        <input type="number" min="1" value="${escapeHtml(row.row)}"
                            oninput="updateCustomSourceField('${row.id}', 'row', this.value)">
                    </div>
                    <div class="cs-field">
                        <label>คอลัมน์ (Column)</label>
                        <input type="text" maxlength="3" value="${escapeHtml(row.col)}"
                            placeholder="เช่น B, AA"
                            oninput="updateCustomSourceField('${row.id}', 'col', this.value.toUpperCase())">
                    </div>
                    <div class="cs-field">
                        <label>ชื่อแท็บ (Sheet Tab) — เว้นว่าง = แท็บหลัก</label>
                        <input type="text" value="${escapeHtml(row.tabName)}"
                            placeholder="เช่น Day2"
                            oninput="updateCustomSourceField('${row.id}', 'tabName', this.value)">
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');
}

/**
 * Sync Custom Source ทั้งหมดขึ้น OBS
 * @param {string} rawSheetUrl - URL ของ Google Sheet จาก Section 2
 * @param {string[][]} mainTabRows - แถว CSV ของแท็บหลักที่ดึงไปแล้วใน fetchAndSyncSheets (กันดึงซ้ำ)
 */
async function syncCustomSources(rawSheetUrl, mainTabRows) {
    if (customSources.length === 0) return;

    const sheetId = extractSheetId(rawSheetUrl);
    if (!sheetId) {
        writeLog('⚠️ Custom Source: ไม่สามารถอ่าน Sheet ID จาก URL ได้');
        return;
    }

    const fallbackGid = extractGidFromUrl(rawSheetUrl) || '0';
    const tabGidMap = await fetchTabGidMap(sheetId);
    if (!tabGidMap) {
        writeLog('ℹ️ Custom Source: ไม่พบรายชื่อแท็บ (อาจไม่ได้แชร์สาธารณะแบบเต็ม) — Source ที่ระบุชื่อแท็บไว้จะใช้แท็บหลักแทน');
    }

    const cache = createSheetCache(sheetId, fallbackGid, tabGidMap);
    // แท็บหลักโหลดมาแล้วจาก fetchAndSyncSheets → ใส่ลง cache ทันทีไม่ต้องดึงซ้ำ
    if (mainTabRows) {
        cache.getRowsForTab.__preset = true;
    }

    // ลำดับทีมที่เจอจริงใน sync รอบนี้ ใช้สำหรับ mode "offset"
    // (ดึงจาก preview table ปัจจุบันที่ render ไว้แล้ว เพื่อให้สอดคล้องกับจำนวนทีมจริง)
    const teamCountRows = document.querySelectorAll('#preview-tbody tr').length;
    const teamCount = teamCountRows > 0 ? teamCountRows : teamList.length;

    let okCount = 0, warnCount = 0;

    for (const src of customSources) {
        if (!src.name || !src.name.trim()) continue; // ข้าม Source ที่ยังไม่ตั้งชื่อ

        const colIdx = colToIndex(src.col);
        if (colIdx < 0) {
            writeLog(`⚠️ Custom Source "${src.name}": คอลัมน์ "${src.col}" ไม่ถูกต้อง`);
            warnCount++;
            continue;
        }

        let rows;
        try {
            if (!src.tabName || !src.tabName.trim()) {
                // ใช้แท็บหลัก — ถ้ามี mainTabRows อยู่แล้วใช้เลย ไม่ fetch ซ้ำ
                rows = mainTabRows || await cache.getRowsForTab('');
            } else {
                rows = await cache.getRowsForTab(src.tabName);
            }
        } catch (err) {
            writeLog(`❌ Custom Source "${src.name}": โหลดข้อมูลแท็บไม่สำเร็จ (${err.message})`);
            warnCount++;
            continue;
        }

        const baseRow = parseInt(src.row, 10);
        if (isNaN(baseRow) || baseRow < 1) {
            writeLog(`⚠️ Custom Source "${src.name}": เลขแถวไม่ถูกต้อง`);
            warnCount++;
            continue;
        }

        if (src.rowMode === 'fixed') {
            const rIdx = baseRow - 1;
            const cell = rows[rIdx] ? cleanCell(rows[rIdx][colIdx]).replace(/"/g, '') : '';
            const result = await applyCustomSourceValue(src, cell);
            result.ok ? okCount++ : warnCount++;
        } else {
            // offset mode: เลื่อนตามจำนวนทีมที่เจอจริง สร้าง Source ชื่อ {name}-{n} ต่อทีม
            for (let n = 1; n <= teamCount; n++) {
                const rIdx = (baseRow - 1) + (n - 1);
                const cell = rows[rIdx] ? cleanCell(rows[rIdx][colIdx]).replace(/"/g, '') : '';
                const inputName = `${src.name}-${n}`;
                const result = await applyCustomSourceValue({ ...src, name: inputName }, cell);
                result.ok ? okCount++ : warnCount++;
            }
        }
    }

    if (okCount > 0 || warnCount > 0) {
        writeLog(`📦 Custom Source sync: สำเร็จ ${okCount} รายการ, ตรวจสอบ ${warnCount} รายการ`);
    }
}

async function applyCustomSourceValue(src, cellValue) {
    if (src.type === 'image') {
        const path = buildLogoPath(cellValue);
        if (!path) return { ok: false };
        return safeSetInput(src.name, { file: path });
    }
    return safeSetInput(src.name, { text: cellValue });
}

// ----------------------------------------------------------------
// Init
// ----------------------------------------------------------------
// ----------------------------------------------------------------


window.onload = () => {
    const savedPath = localStorage.getItem('logoBasePath_p2');
    if (savedPath) {
        document.getElementById('logoBasePath').value = savedPath;
    }


    const savedStart = localStorage.getItem('rowStart_p2');
    const savedEnd = localStorage.getItem('rowEnd_p2');
    if (savedStart) document.getElementById('startRow').value = savedStart;
    if (savedEnd) document.getElementById('endRow').value = savedEnd;

    // โหลด Prefix ที่บันทึกไว้ (ค่าเริ่มต้น "Team")
    const savedPrefix = localStorage.getItem(PREFIX_STORAGE_KEY);
    if (savedPrefix) document.getElementById('sourcePrefix').value = savedPrefix;

    // โหลด Fields (Custom Columns ที่ผู้ใช้สร้างเอง) + Team List (จำนวนทีมที่เพิ่ม/ลบเอง)
    loadFields();
    loadTeamList();

    const savedSheetUrl = localStorage.getItem('lastSheetUrl_p2');
    if (savedSheetUrl) document.getElementById('sheetUrl').value = savedSheetUrl;

    onRowRangeInput();
    updatePathHint();
    loadCustomSources();
    connectOBS();
};