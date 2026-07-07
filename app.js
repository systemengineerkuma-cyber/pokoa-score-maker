const VF = VexFlow;

let score = null;
let scale = 1;
let notePositions = [];
let hoveredPos = null;
let hoveredMeasureForDelete = null;
let history = [];
let historyIndex = -1;
let northDirection = 0; // 0=↑, 1=→, 2=↓, 3=←

let audioCtx = null;
let playState = "stopped"; // "stopped" | "playing" | "paused"
let isLooping = false;
let playStartTime = null;
let playEndTime = 0; // audioCtx時刻での再生終了予定時刻（終了検知・ループに使用）
let noteSchedule = [];
let noteTimeMap = [];
let beatSchedule = []; // {beatIndex, startTime, endTime} 1エントリ=マップの1センサー分（16分音符単位）
let noteBoundarySchedule = []; // {measureIndex, noteIndex, startTime, endTime} 1エントリ=1つの音符（休符含む）。テンポ変更の再開位置探しに使う
let activeSourceNodes = []; // {node, startTime} 再生中にスケジュール済みの音源（曲中のテンポ変更時に先の分を止めるため）
let currentHighlightMeasure = -1;
let currentHighlightBeat = -1;
let currentHighlightRailStep = null; // マップのレール上の再生位置（連続値を丸めた整数）
let animFrameId = null;

// 小節範囲選択用の状態
let selectedMeasures = new Set();
let clipboardMeasures = []; // コピー/切り取りした小節データ
let dragState = null; // { startX, startY, currentX, currentY, isDragging }
const DRAG_THRESHOLD = 6; // px

// 編集モード: "note"=音符モード, "select"=選択モード
let editMode = localStorage.getItem("editMode") || "note";

// タブ定義（将来タブを追加する場合はここに追記する）
const TABS = [
    { id: "score",  label: "五線譜" },
    { id: "map",    label: "マップ" },
];
let activeTab = localStorage.getItem("activeTab") || "score";
// 廃止済みタブ（例: 旧パネル楽譜タブ）がlocalStorageに残っていた場合のフォールバック
if (!TABS.some(t => t.id === activeTab)) activeTab = "score";

function getAudioContext() {
    if (!audioCtx) audioCtx = new AudioContext();
    return audioCtx;
}

const NOTE_FREQ = {
    "C4":  261.63,
    "C#4": 277.18,
    "D4":  293.66,
    "D#4": 311.13,
    "E4":  329.63,
    "F4":  349.23,
    "F#4": 369.99,
    "G4":  392.00,
    "G#4": 415.30,
    "A4":  440.00,
    "A#4": 466.16,
    "B4":  493.88,
    "C5":  523.25,
    "C#5": 554.37,
    "D5":  587.33,
    "D#5": 622.25,
    "E5":  659.25,
    "F5":  698.46,
    "F#5": 739.99,
    "G5":  783.99,
    "G#5": 830.61,
    "A5":  880.00,
    "A#5": 932.33,
    "B5":  987.77,
    "C6":  1046.50,
    "C#6": 1108.73,
};

// ドレミファソラシドのSE音声（26音分、se/フォルダ）をプリロードするキャッシュ
// 未ロード/ファイル未用意の間はnullのままとなり、その場合はサイン波にフォールバックする
const SE_BUFFERS = {};
let seLoadStarted = false;

function loadSeBuffers() {
    if (seLoadStarted) return;
    seLoadStarted = true;
    const ctx = getAudioContext();
    Object.keys(PITCH_TO_FILE).forEach(pitch => {
        const file = PITCH_TO_FILE[pitch].replace(/\.jpg$/, ".mp3");
        fetch(`se/${file}`)
            .then(res => { if (!res.ok) throw new Error("not found"); return res.arrayBuffer(); })
            .then(buf => ctx.decodeAudioData(buf))
            .then(decoded => { SE_BUFFERS[pitch] = decoded; })
            .catch(() => { /* 未用意のファイルはフォールバック(サイン波)のまま */ });
    });
}

function playNote(pitch, startTime, duration) {
    const ctx = getAudioContext();
    const buffer = SE_BUFFERS[pitch];

    if (buffer) {
        // 用意されたSE音声をそのまま自然長で再生（音価による打ち切りはしない）
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = 0.8;
        source.connect(gain);
        gain.connect(ctx.destination);
        source.start(startTime);
        activeSourceNodes.push({ node: source, startTime });
        return;
    }

    // SEファイルが未用意/未ロードの間はサイン波で代用
    const freq = NOTE_FREQ[pitch];
    if (!freq) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    osc.frequency.value = freq;

    gain.gain.setValueAtTime(0.3, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.start(startTime);
    osc.stop(startTime + duration);
    activeSourceNodes.push({ node: osc, startTime });
}

function playScore() {
    if (playState !== "stopped") return;
    playState = "playing";

    const ctx = getAudioContext();
    playStartTime = ctx.currentTime + 0.1;
    noteSchedule = [];
    noteTimeMap = [];
    beatSchedule = [];
    noteBoundarySchedule = [];
    activeSourceNodes = [];

    scheduleMeasuresFrom(0, 0, 0, playStartTime, null);

    updatePlaybackButtons();
    trackPlayback();
}

// startMeasureIndex小節目のstartNoteIndex番目の音符から末尾まで、beatIndexOffsetを起点の
// ビート番号として、startTimeを起点にBPM入力欄の現在値でスケジュールする
// （noteSchedule/noteTimeMap/beatSchedule/noteBoundarySchedule/playEndTimeに追記・更新する）
// resumeMeasureStartTimeOverride: 曲中のテンポ変更で小節の途中から再開する場合、
// その小節がもともと始まった時刻（表示上の小節範囲がずれないように引き継ぐ）
function scheduleMeasuresFrom(startMeasureIndex, startNoteIndex, beatIndexOffset, startTime, resumeMeasureStartTimeOverride) {
    const bpm = parseInt(document.getElementById("bpmInput").value) || 120;
    const beatDuration = 60 / bpm;
    const sixteenthDuration = beatDuration * 0.25; // マップの1センサー(16分音符)分の長さ
    const measuresPerRow = getMeasuresPerRow();

    let time = startTime;
    let beatIndex = beatIndexOffset;

    for (let measureIndex = startMeasureIndex; measureIndex < score.measures.length; measureIndex++) {
        const measure = score.measures[measureIndex];
        const isResumeMeasure = measureIndex === startMeasureIndex;
        const noteStartIndex = isResumeMeasure ? startNoteIndex : 0;
        const measureStartTime = (isResumeMeasure && resumeMeasureStartTimeOverride != null)
            ? resumeMeasureStartTimeOverride
            : time;

        const rowIndex = Math.floor(measureIndex / measuresPerRow);
        const idxInRow = measureIndex % measuresPerRow;
        const isFirstRow = rowIndex === 0;
        const isFirstMeasure = isFirstRow && idxInRow === 0;

        let sx;
        if (isFirstRow) {
            sx = idxInRow === 0 ? 20 : 20 + FIRST_MEASURE_EXTRA + idxInRow * STAVE_WIDTH_BASE;
        } else {
            sx = 20 + idxInRow * STAVE_WIDTH_BASE;
        }
        const measureWidth = isFirstMeasure ? STAVE_WIDTH_BASE + FIRST_MEASURE_EXTRA : STAVE_WIDTH_BASE;

        for (let noteIndex = noteStartIndex; noteIndex < measure.notes.length; noteIndex++) {
            const note = measure.notes[noteIndex];
            const duration = (durationBeats[note.duration] || 0) * beatDuration;
            if (!note.rest && note.pitches) {
                note.pitches.forEach(pitch => {
                    playNote(pitch, time, duration * 0.9);
                });
            }

            // マップのセンサー(16分音符)単位での開始・終了時刻を記録
            const slotCount = Math.round((durationBeats[note.duration] || 0) / 0.25);
            for (let s = 0; s < slotCount; s++) {
                beatSchedule.push({
                    beatIndex,
                    startTime: time + s * sixteenthDuration,
                    endTime: time + (s + 1) * sixteenthDuration,
                });
                beatIndex++;
            }

            // テンポ変更の再開位置探しに使う、音符単位の開始・終了時刻
            noteBoundarySchedule.push({
                measureIndex,
                noteIndex,
                startTime: time,
                endTime: time + duration,
            });

            time += duration;
        }

        noteSchedule.push({
            measureIndex,
            startTime: measureStartTime,
            endTime: time
        });

        noteTimeMap.push({
            startTime: measureStartTime,
            endTime: time,
            startX: sx * scale,
            endX: (sx + measureWidth) * scale,
            rowIndex
        });
    }

    // 終了検知はtrackPlayback内でaudioCtx時刻を見て行う（setTimeoutは一時停止中もカウントが進んでしまうため使わない）
    playEndTime = time;
}

// 再生中/一時停止中にBPMが変更されたら、今鳴っている音符が終わった直後（次の音符の頭）から
// 新テンポを適用する。それ以前に鳴っている音はそのまま、まだ鳴っていない先の音だけ止めて敷き直す
function applyTempoChange() {
    if (playState === "stopped" || !audioCtx) return;

    const now = audioCtx.currentTime;
    const current = noteBoundarySchedule.find(n => now < n.endTime);
    if (!current) return; // 既に最後の音符まで進んでいる

    const resumeTime = current.endTime;
    let resumeMeasureIndex = current.measureIndex;
    let resumeNoteIndex = current.noteIndex + 1;
    if (resumeNoteIndex >= score.measures[resumeMeasureIndex].notes.length) {
        resumeMeasureIndex++;
        resumeNoteIndex = 0;
    }
    if (resumeMeasureIndex >= score.measures.length) {
        playEndTime = resumeTime;
        return;
    }

    // まだ発音していない先の音だけを止める
    activeSourceNodes = activeSourceNodes.filter(({ node, startTime }) => {
        if (startTime >= resumeTime) {
            try { node.stop(); } catch (e) { /* 既に終了済みの場合は無視 */ }
            return false;
        }
        return true;
    });

    // 再開する小節がもともと始まった時刻を引き継ぐ（表示上の小節範囲がずれないように）
    const resumeMeasureEntry = noteSchedule.find(s => s.measureIndex === resumeMeasureIndex);
    const resumeMeasureStartTimeOverride = resumeMeasureEntry ? resumeMeasureEntry.startTime : resumeTime;

    // 再開する小節（とそれ以降）の記録を消して、新テンポで敷き直す
    noteSchedule = noteSchedule.filter(s => s.measureIndex < resumeMeasureIndex);
    noteTimeMap = noteTimeMap.slice(0, noteSchedule.length);
    beatSchedule = beatSchedule.filter(b => b.startTime < resumeTime);
    noteBoundarySchedule = noteBoundarySchedule.filter(n => n.startTime < resumeTime);

    scheduleMeasuresFrom(resumeMeasureIndex, resumeNoteIndex, beatSchedule.length, resumeTime, resumeMeasureStartTimeOverride);
}

// 再生を終端まで到達した状態にする（ループ時は続けて再生開始）
function finishPlayback() {
    playState = "stopped";
    if (isLooping) {
        playScore();
        return;
    }
    currentHighlightMeasure = -1;
    currentHighlightBeat = -1;
    currentHighlightRailStep = null;
    cancelAnimationFrame(animFrameId);
    highlightMeasure(-1);
    highlightMapSensor(-1);
    highlightRailStep(null);
    document.querySelectorAll(".playLine").forEach(el => el.remove());
    updatePlaybackButtons();
}

function stopScore() {
    if (playState === "stopped") return;
    playState = "stopped";
    currentHighlightMeasure = -1;
    currentHighlightBeat = -1;
    currentHighlightRailStep = null;
    cancelAnimationFrame(animFrameId);
    highlightMeasure(-1);
    highlightMapSensor(-1);
    highlightRailStep(null);
    document.querySelectorAll(".playLine").forEach(el => el.remove());
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
    updatePlaybackButtons();
}

// 再生中の音・スケジュールはそのままに、時間経過を止める
function pauseScore() {
    if (playState !== "playing") return;
    playState = "paused";
    if (audioCtx) audioCtx.suspend();
    cancelAnimationFrame(animFrameId);
    updatePlaybackButtons();
}

// 一時停止した時点から再生を続ける
function resumeScore() {
    if (playState !== "paused") return;
    playState = "playing";
    if (audioCtx) audioCtx.resume();
    trackPlayback();
    updatePlaybackButtons();
}

// 再生/一時停止トグルボタンと停止ボタンの見た目を状態に合わせて更新する
function updatePlaybackButtons() {
    const toggleBtn = document.getElementById("playBtn");
    if (toggleBtn) {
        toggleBtn.innerHTML = playState === "playing"
            ? '<i class="fa-solid fa-pause"></i>'
            : '<i class="fa-solid fa-play"></i>';
    }
    const stopBtn = document.getElementById("stopBtn");
    if (stopBtn) {
        const stopped = playState === "stopped";
        stopBtn.disabled = stopped;
        stopBtn.style.opacity = stopped ? "0.4" : "1";
    }
}

function trackPlayback() {
    if (playState !== "playing" || !audioCtx) return;

    const now = audioCtx.currentTime;

    if (now >= playEndTime) {
        finishPlayback();
        return;
    }

    const current = noteSchedule.find(s => now >= s.startTime && now < s.endTime);
    if (current && current.measureIndex !== currentHighlightMeasure) {
        currentHighlightMeasure = current.measureIndex;
        highlightMeasure(currentHighlightMeasure);
    }

    const currentBeat = beatSchedule.find(b => now >= b.startTime && now < b.endTime);
    if (currentBeat) {
        if (currentBeat.beatIndex !== currentHighlightBeat) {
            currentHighlightBeat = currentBeat.beatIndex;
            highlightMapSensor(currentHighlightBeat);
        }
        // レールはビート内の経過に合わせて連続的に動かす（センサー中心=beatIndex*3+1）
        const beatT = (now - currentBeat.startTime) / (currentBeat.endTime - currentBeat.startTime);
        const railStep = currentBeat.beatIndex * 3 + 1 + beatT * 3;
        if (Math.round(railStep) !== currentHighlightRailStep) {
            currentHighlightRailStep = Math.round(railStep);
            highlightRailStep(railStep);
        }
    }

    for (let i = 0; i < noteTimeMap.length; i++) {
        const m = noteTimeMap[i];
        if (now >= m.startTime && now < m.endTime) {
            const t = (now - m.startTime) / (m.endTime - m.startTime);
            const x = m.startX + (m.endX - m.startX) * t;
            drawPlayLine(x, m.rowIndex);
            break;
        }
    }

    animFrameId = requestAnimationFrame(trackPlayback);
}

function highlightMeasure(measureIndex) {
    document.querySelectorAll(".measureGroup").forEach((group, i) => {
        if (i === measureIndex) {
            group.style.outline = "2px solid #4a90e2";
            group.style.borderRadius = "8px";
        } else {
            group.style.outline = "none";
        }
    });
}

// マップ上で現在再生中のセンサーを強調表示する（beatIndexは0始まり、-1で解除）
function highlightMapSensor(beatIndex) {
    const beatNum = beatIndex + 1;

    document.querySelectorAll('#mapArea [data-cell-type="sensor"]').forEach(cell => {
        const isActive = beatIndex >= 0 && parseInt(cell.textContent, 10) === beatNum;
        cell.style.outline = isActive ? "3px solid #ffeb3b" : "none";
        cell.style.zIndex = isActive ? "5" : "";
    });
}

// マップ上のレールの色を再生位置に合わせて滑らかに動かす
// railStepは連続値（ビート中心=整数、ビート間は補間値）で渡す。nullで解除
function highlightRailStep(railStep) {
    const rounded = railStep == null ? null : Math.round(railStep);
    document.querySelectorAll('#mapArea [data-cell-type="rail"]').forEach(cell => {
        const isActive = rounded !== null && parseInt(cell.dataset.railStep, 10) === rounded;
        cell.style.background = isActive ? "#4a90e2" : "#555";
    });
}

function drawPlayLine(x, rowIndex) {
    document.querySelectorAll(".playLine").forEach(el => el.remove());

    const scoreElement = document.getElementById("score");
    const rowDivs = scoreElement.querySelectorAll("div[data-row-index]");
    const rowDiv = rowDivs[rowIndex];
    if (!rowDiv) return;

    const line = document.createElement("div");
    line.className = "playLine";
    line.style.cssText = `
        position: absolute;
        left: ${x}px;
        top: ${STAVE_TOP_BASE * scale}px;
        width: 2px;
        height: ${120 * scale}px;
        background: rgba(74, 144, 226, 0.6);
        pointer-events: none;
        z-index: 20;
    `;
    rowDiv.appendChild(line);
}

const DURATION_ORDER = ["16", "8", "q", "h", "w"];
const durationBeats = { "w": 4, "h": 2, "q": 1, "8": 0.5, "16": 0.25 };
const COMPASS_LABELS = ["N↑", "N→", "N↓", "N←"];

const STAVE_TOP_BASE = 40;
const STAVE_WIDTH_BASE = 350;
const FIRST_MEASURE_EXTRA = 60;
const C4_Y_BASE = 128;
const SEMITONE_PX = 2.5;

const WHITE_KEYS = [
    { pitch: "C4", semitone: 0  },
    { pitch: "D4", semitone: 2  },
    { pitch: "E4", semitone: 4  },
    { pitch: "F4", semitone: 5  },
    { pitch: "G4", semitone: 7  },
    { pitch: "A4", semitone: 9  },
    { pitch: "B4", semitone: 11 },
    { pitch: "C5", semitone: 12 },
    { pitch: "D5", semitone: 14 },
    { pitch: "E5", semitone: 16 },
    { pitch: "F5", semitone: 17 },
    { pitch: "G5", semitone: 19 },
    { pitch: "A5", semitone: 21 },
    { pitch: "B5", semitone: 23 },
    { pitch: "C6", semitone: 24 },
];

const BLACK_KEYS = [
    { pitch: "C#4", semitone: 1  },
    { pitch: "D#4", semitone: 3  },
    { pitch: "F#4", semitone: 6  },
    { pitch: "G#4", semitone: 8  },
    { pitch: "A#4", semitone: 10 },
    { pitch: "C#5", semitone: 13 },
    { pitch: "D#5", semitone: 15 },
    { pitch: "F#5", semitone: 18 },
    { pitch: "G#5", semitone: 20 },
    { pitch: "A#5", semitone: 22 },
    { pitch: "C#6", semitone: 25 },
];

const WHITE_TO_BLACK = {
    "C4":  "C#4",
    "D4":  "D#4",
    "F4":  "F#4",
    "G4":  "G#4",
    "A4":  "A#4",
    "C5":  "C#5",
    "D5":  "D#5",
    "F5":  "F#5",
    "G5":  "G#5",
    "A5":  "A#5",
    "C6":  "C#6",
};

const BLACK_PITCHES = new Set(BLACK_KEYS.map(k => k.pitch));

const PITCH_TO_FILE = {
    "C4":  "c.jpg",
    "C#4": "c_.jpg",
    "D4":  "d.jpg",
    "D#4": "d_.jpg",
    "E4":  "e.jpg",
    "F4":  "f.jpg",
    "F#4": "f_.jpg",
    "G4":  "g.jpg",
    "G#4": "g_.jpg",
    "A4":  "a.jpg",
    "A#4": "a_.jpg",
    "B4":  "b.jpg",
    "C5":  "c2.jpg",
    "C#5": "c2_.jpg",
    "D5":  "d2.jpg",
    "D#5": "d2_.jpg",
    "E5":  "e2.jpg",
    "F5":  "f2.jpg",
    "F#5": "f2_.jpg",
    "G5":  "g2.jpg",
    "G#5": "g2_.jpg",
    "A5":  "a2.jpg",
    "A#5": "a2_.jpg",
    "B5":  "b2.jpg",
    "C6":  "c3.jpg",
    "C#6": "c3_.jpg",
};

function semitoneToY(semitone) {
    return C4_Y_BASE - semitone * SEMITONE_PX;
}

function yToPitch(clickY, isBlack) {
    const baseY = clickY / scale;
    const keys = isBlack ? BLACK_KEYS : WHITE_KEYS;
    let closest = null;
    let minDist = Infinity;

    for (const { pitch, semitone } of keys) {
        const noteY = semitoneToY(semitone);
        const dist = Math.abs(baseY - noteY);
        if (dist < minDist) {
            minDist = dist;
            closest = pitch;
        }
    }

    if (minDist > SEMITONE_PX) return null;
    return closest;
}

function getMeasureBeats(measure) {
    return measure.notes.reduce(
        (sum, n) => sum + (durationBeats[n.duration] || 0), 0
    );
}

function getNextDuration(current, remaining) {
    const currentIndex = DURATION_ORDER.indexOf(current);
    for (let i = 1; i <= DURATION_ORDER.length; i++) {
        const next = DURATION_ORDER[(currentIndex + i) % DURATION_ORDER.length];
        if (durationBeats[next] <= remaining) {
            return next;
        }
    }
    return current;
}

function pitchToKey(pitch) {
    const match = pitch.match(/^([A-Ga-g])([#b]?)(\d)$/);
    if (!match) throw new Error(`不正な音名: ${pitch}`);
    const note = match[1].toLowerCase();
    const accidental = match[2];
    const octave = match[3];
    return { key: `${note}${accidental}/${octave}`, accidental };
}

function makeDummyNotes(remainingBeats) {
    const dummies = [];
    let remaining = remainingBeats;
    const durations = ["w", "h", "q", "8", "16"];

    for (const dur of durations) {
        while (remaining >= durationBeats[dur]) {
            const dummy = new VF.StaveNote({
                keys: ["b/4"],
                duration: dur + "r"
            });
            dummy.setStyle({
                fillStyle: "transparent",
                strokeStyle: "transparent"
            });
            dummies.push(dummy);
            remaining -= durationBeats[dur];
        }
    }
    return dummies;
}

function applyTabVisibility() {
    const isScore = activeTab === "score";
    const isMap   = activeTab === "map";

    // 五線譜エリア
    document.getElementById("scoreWrapper").style.display = isScore ? "" : "none";

    // パネルカウント（音符マット数・レール数・センサー数）は全タブで表示
    document.getElementById("panelCount").style.display = "flex";

    // マップエリア
    const mapArea = document.getElementById("mapArea");
    if (mapArea) mapArea.style.display = isMap ? "" : "none";

    // マップ専用ツールバー
    const mapToolbar = document.getElementById("mapToolbar");
    if (mapToolbar) mapToolbar.style.display = isMap ? "flex" : "none";

    // ヘルプは五線譜タブのみ表示
    const info = document.getElementById("info");
    if (info) info.style.display = isScore ? "" : "none";

    // タブボタンのアクティブ状態を更新
    TABS.forEach(tab => {
        const btn = document.getElementById(`tab-${tab.id}`);
        if (!btn) return;
        btn.classList.toggle("tab-active", tab.id === activeTab);
    });
}

function switchTab(tabId) {
    if (activeTab === tabId) return;
    activeTab = tabId;
    localStorage.setItem("activeTab", activeTab);
    applyTabVisibility();
    if (activeTab === "score") {
        renderScore();
        setupDeleteButtons();
        setupInsertButtons();
    } else if (activeTab === "map") {
        renderMap();
    }
}

// マップ設定
let mapSettings = {
    railDirection: "vertical",   // "vertical" | "horizontal"
    startCorner: "top-left",     // "top-left" | "top-right" | "bottom-left" | "bottom-right"
    sideFirst: "left",           // "left" | "right" （どちら側のセンサーを先にするか）
    wrapByCount: true,           // true=センサー数指定, false=マス数指定
    wrapValue: 10,               // 折り返し値
};

// マップ設定をlocalStorageから復元
(function() {
    const saved = localStorage.getItem("mapSettings");
    if (saved) {
        try { Object.assign(mapSettings, JSON.parse(saved)); } catch(e) {}
    }
})();

function saveMapSettings() {
    localStorage.setItem("mapSettings", JSON.stringify(mapSettings));
}

// 楽譜の全ビートを順番に返す（16分音符単位）
function getAllBeats() {
    const beats = [];
    score.measures.forEach((measure, measureIndex) => {
        measure.notes.forEach(note => {
            const count = Math.round((durationBeats[note.duration] || 0) / 0.25);
            for (let i = 0; i < count; i++) {
                beats.push({
                    measureIndex,
                    note: i === 0 ? note : null, // 最初のスロットのみ音符データを持つ
                    isFirst: i === 0,
                });
            }
        });
    });
    return beats;
}

// センサー周囲（中間層のみ）への音符マット配置を計算する
// railDir: "vertical"|"horizontal", startCorner: 始点（トロッコの進行方向を決める）
// isLeftSide: このセンサーがレールの左側にいるか（sideFirstとビート番号から決まる）
// pitches: 高音順にソートされた音名配列（和音は最大3つまでの前提）
// 戻り値: [{dx, dy, z, pitch}]（センサーからの実グリッド座標オフセット。z: 常に0=中間層）
//
// 上位層・下位層は廃止し、中間層の3枠（遠い→横→近い、高音から順）のみを使う。
// 「遠い/近い」「レールと反対側」はセンサーから見たローカルな向きであり、
// 実際のグリッド座標（dx, dy）に変換する際に以下を考慮する:
//   - レール向き(railDir): vertical→進行軸=Y・左右軸=X、horizontal→進行軸=X・左右軸=Y
//   - 開始地点(startCorner): 進行方向の符号（top/left側開始なら+、bottom/right側開始なら-）
//   - isLeftSide: 左側センサーなら「反対側」=マイナス方向、右側センサーなら「反対側」=プラス方向
//     （レールの左右が入れ替わっても、置き方の考え方自体は左右対称で同一）
function calcPanelPositions(pitches, railDir, startCorner, isLeftSide) {
    const isVertical = railDir === "vertical";
    const [vPart, hPart] = startCorner.split("-"); // "top"|"bottom", "left"|"right"
    // 進行軸の符号（vertical: top→+Y方向, horizontal: left→+X方向）
    const travelSign = isVertical
        ? (vPart === "top" ? 1 : -1)
        : (hPart === "left" ? 1 : -1);
    // 左右軸の符号（左側センサーなら-1側が反対側、右側センサーなら+1側が反対側）
    const lateralSign = isLeftSide ? 1 : -1;

    // 中間層3枠（センサー中心を(0,0)としたローカル座標、斜め隣接は使用しない）
    // lat: レールと反対側を-1とするローカル左右位置、trav: 遠い方を+1とするローカル進行位置
    // 音の優先順位（固定）: 遠い→横→近い
    const midRank = [
        {lat: 0, trav: 1, z: 0},   // 遠い
        {lat: -1, trav: 0, z: 0},  // 横（レールと反対側）
        {lat: 0, trav: -1, z: 0},  // 近い
    ];

    // ローカル座標(lat, trav)を実グリッドオフセット(dx, dy)に変換
    const toGridDelta = (slot) => {
        const travelDelta = slot.trav * travelSign;
        const lateralDelta = slot.lat * lateralSign;
        return isVertical
            ? { dx: lateralDelta, dy: travelDelta, z: slot.z }
            : { dx: travelDelta, dy: lateralDelta, z: slot.z };
    };

    const positions = [];
    // pitchesを高音順（既にソート済みと仮定）にmidRankへ割り当て（最大3つ）
    pitches.forEach((pitch, i) => {
        if (i >= midRank.length) return;
        const { dx, dy, z } = toGridDelta(midRank[i]);
        positions.push({ relX: dx, relY: dy, z, pitch });
    });

    return positions;
}

function updateMapToolbarUI() {
    const { railDirection, startCorner, sideFirst, wrapByCount, wrapValue } = mapSettings;

    const setActive = (id, active) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.color = active ? "#222" : "#aaa";
        el.style.background = active ? "#f0f0f0" : "";
    };

    setActive("mapRailVertical",   railDirection === "vertical");
    setActive("mapRailHorizontal", railDirection === "horizontal");
    setActive("mapCorner-top-left",     startCorner === "top-left");
    setActive("mapCorner-top-right",    startCorner === "top-right");
    setActive("mapCorner-bottom-left",  startCorner === "bottom-left");
    setActive("mapCorner-bottom-right", startCorner === "bottom-right");
    setActive("mapSideLeft",  sideFirst === "left");
    setActive("mapSideRight", sideFirst === "right");
    setActive("mapWrapByCount", wrapByCount);
    setActive("mapWrapByMass",  !wrapByCount);

    const wrapInput = document.getElementById("mapWrapValue");
    if (wrapInput) wrapInput.value = wrapValue;
}

// マップのグリッドデータ（レール・センサー・音符マットの配置）を計算する
// DOM描画には依存しないので、描画不要なカウント表示（レール数・センサー数）からも呼べる
function buildMapGrid() {
    const { railDirection, startCorner, sideFirst, wrapByCount, wrapValue } = mapSettings;

    // 全ビートを取得
    const beats = getAllBeats();
    const totalBeats = beats.length;

    // 折り返し単位（センサー数 or マス数）
    const wrapSensors = wrapByCount
        ? wrapValue
        : Math.round((wrapValue + 1) / 3);

    // センサー配置計算
    // センサーはレール方向に交互(left/right)に配置、間隔3マス
    // sideFirst="left": センサー1→左, センサー2→右, ...
    // sideFirst="right": センサー1→右, センサー2→左, ...

    // レール向き・開始地点から、進行軸/折り返し軸の符号を決める
    // vertical: 進行軸=Y, 折り返し軸=X / horizontal: 進行軸=X, 折り返し軸=Y
    const isVertical = railDirection === "vertical";
    const [vPart, hPart] = startCorner.split("-"); // "top"|"bottom", "left"|"right"
    const travelSign = isVertical
        ? (vPart === "top" ? 1 : -1)   // 上開始→進行軸+方向、下開始→-方向
        : (hPart === "left" ? 1 : -1); // 左開始→進行軸+方向、右開始→-方向
    const wrapSign = isVertical
        ? (hPart === "left" ? 1 : -1)  // 左開始→折り返しは+方向に列を増やす、右開始→-方向
        : (vPart === "top" ? 1 : -1);  // 上開始→折り返しは+方向に行を増やす、下開始→-方向

    // グリッドセルを蓄積するMap: key="x,y,z" value={type, pitch, direction, beatNum}
    const grid = new Map();

    const setCell = (x, y, z, data) => {
        grid.set(`${x},${y},${z}`, data);
    };

    for (let beatIdx = 0; beatIdx < totalBeats; beatIdx++) {
        const beat = beats[beatIdx];
        const colIdx = Math.floor(beatIdx / wrapSensors);
        const rowIdx = beatIdx % wrapSensors;

        // センサーの進行軸上の位置（3マス間隔、開始地点の向きに応じて符号が変わる）
        const travelPos = travelSign * rowIdx * 3;
        // センサーの左右（進行軸に対して直角）
        const isLeftSide = sideFirst === "left"
            ? (beatIdx % 2 === 0)
            : (beatIdx % 2 === 1);
        const lateralPos = isLeftSide ? -1 : 1; // レール中心線からの左右オフセット（レールに隣接）

        // 折り返し軸オフセット（段ごとにずらす、開始地点の向きに応じて符号が変わる）
        const wrapOffset = wrapSign * colIdx * 6; // 1段あたり6マス幅（左2+レール1+右2+隙間1）

        // センサーの絶対グリッド座標（進行軸・折り返し軸を実際のX/Yに変換）
        const sX = isVertical ? wrapOffset + lateralPos : travelPos;
        const sY = isVertical ? travelPos : wrapOffset + lateralPos;

        // レールセル（センサーを中心に進行軸方向へ3マス分）
        // railStep: このビートの中心を basе(beatIdx*3+1) とした、再生位置の滑らかな補間に使う連番
        // （dの並びは進行方向の符号に応じて時間順になるようにする）
        const dOrder = travelSign === 1 ? [-1, 0, 1] : [1, 0, -1];
        dOrder.forEach((d, posInTriplet) => {
            const rx = isVertical ? wrapOffset : travelPos + d;
            const ry = isVertical ? travelPos + d : wrapOffset;
            setCell(rx, ry, 0, {
                type: "rail",
                direction: railDirection,
                railStep: beatIdx * 3 + posInTriplet,
            });
        });

        // センサーセル（中間層）
        setCell(sX, sY, 0, {
            type: "sensor",
            beatNum: beatIdx + 1,
            direction: railDirection,
        });

        // 音符マットの配置
        if (beat.isFirst && beat.note && !beat.note.rest && beat.note.pitches) {
            const sorted = [...beat.note.pitches].sort((a, b) => {
                // 半音値で降順ソート（高音順）
                const semitoneOf = p => {
                    const found = [...WHITE_KEYS, ...BLACK_KEYS].find(k => k.pitch === p);
                    return found ? found.semitone : 0;
                };
                return semitoneOf(b) - semitoneOf(a);
            });

            const panelPositions = calcPanelPositions(sorted, railDirection, startCorner, isLeftSide);

            panelPositions.forEach(({relX, relY, z, pitch}) => {
                const px = sX + relX;
                const py = sY + relY;
                setCell(px, py, z, {
                    type: "panel",
                    pitch,
                    direction: northDirection,
                });
            });
        }
    }

    return { grid, totalBeats };
}

function renderMap() {
    const mapArea = document.getElementById("mapArea");
    if (!mapArea) return;
    mapArea.innerHTML = "";

    const cellSize = Math.round(42 * scale * 0.5);
    const imageSize = cellSize;

    const { grid } = buildMapGrid();

    // グリッドの範囲を計算
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    grid.forEach((_, key) => {
        const [x, y] = key.split(",").map(Number);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
    });

    if (minX === Infinity) {
        mapArea.innerHTML = "<p style='color:#aaa;padding:16px;'>音符がありません</p>";
        updateCountsBar();
        return;
    }

    // 端のセルが枠に密着して見えないよう、表示範囲の周囲に1マス分の余白を持たせる
    minX -= 1; maxX += 1;
    minY -= 1; maxY += 1;

    const gridW = maxX - minX + 1;
    const gridH = maxY - minY + 1;

    // 層の概念は廃止（グリッドは1つだけ）
    const z = 0;

    const gridDiv = document.createElement("div");
    gridDiv.style.cssText = `
        display: grid;
        grid-template-columns: repeat(${gridW}, ${cellSize}px);
        grid-template-rows: repeat(${gridH}, ${cellSize}px);
        gap: 1px;
        background: #e0e0e0;
        border: 1px solid #e0e0e0;
        width: fit-content;
    `;

    for (let gy = 0; gy < gridH; gy++) {
        for (let gx = 0; gx < gridW; gx++) {
            const ax = gx + minX;
            const ay = gy + minY;
            const key = `${ax},${ay},${z}`;
            const data = grid.get(key);

            const cell = document.createElement("div");
            cell.style.cssText = `
                width: ${cellSize}px;
                height: ${cellSize}px;
                background: #fff;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: ${Math.max(8, cellSize * 0.25)}px;
                color: #555;
                box-sizing: border-box;
                overflow: hidden;
            `;

            if (data) {
                if (data.type === "rail") {
                    cell.style.background = "#555";
                    // 向きに応じた線を描画（将来画像に置き換え予定）
                    const line = document.createElement("div");
                    const isVert = data.direction === "vertical";
                    line.style.cssText = `
                        width: ${isVert ? "30%" : "100%"};
                        height: ${isVert ? "100%" : "30%"};
                        background: #888;
                        border-radius: 2px;
                    `;
                    // data-direction属性で向きを保持（将来の画像置換用）
                    cell.dataset.direction = data.direction;
                    cell.dataset.cellType = "rail";
                    cell.dataset.railStep = data.railStep;
                    cell.appendChild(line);
                } else if (data.type === "sensor") {
                    cell.style.background = "#e05555";
                    cell.style.color = "#fff";
                    // data-direction属性で向きを保持（将来の画像置換用）
                    cell.dataset.direction = data.direction;
                    cell.dataset.cellType = "sensor";
                    // センサーのレーザー方向（レールに対して直角）
                    const isVert = data.direction === "vertical";
                    cell.dataset.laserDirection = isVert ? "horizontal" : "vertical";
                    cell.textContent = data.beatNum;
                } else if (data.type === "panel") {
                    const file = PITCH_TO_FILE[data.pitch];
                    if (file) {
                        const img = document.createElement("img");
                        img.src = `img/${file}`;
                        img.alt = data.pitch;
                        img.style.cssText = `
                            width: ${imageSize}px;
                            height: ${imageSize}px;
                            object-fit: contain;
                        `;
                        // コンパス方向を反映（将来の画像置換用）
                        img.style.transform = `rotate(${northDirection * 90}deg)`;
                        img.dataset.cellType = "panel";
                        img.dataset.pitch = data.pitch;
                        cell.appendChild(img);
                    }
                }
            }

            gridDiv.appendChild(cell);
        }
    }

    mapArea.appendChild(gridDiv);
    updateCountsBar();

    // 再生中/一時停止中にグリッドが再構築された場合、現在位置のハイライトを再適用する
    if (playState !== "stopped" && currentHighlightBeat >= 0) {
        highlightMapSensor(currentHighlightBeat);
    }
    if (playState !== "stopped" && currentHighlightRailStep !== null) {
        highlightRailStep(currentHighlightRailStep);
    }
}

// 音符マット数・レール数・センサー数の表示（全タブ共通、#panelCountに表示）
const PITCH_TO_GROUP = {
    "C4": "C1", "C#4": "C1",
    "D4": "D",  "D#4": "D",
    "E4": "E",
    "F4": "F",  "F#4": "F",
    "G4": "G",  "G#4": "G",
    "A4": "A",  "A#4": "A",
    "B4": "B",
    "C5": "C2", "C#5": "C2",
    "D5": "D",  "D#5": "D",
    "E5": "E",
    "F5": "F",  "F#5": "F",
    "G5": "G",  "G#5": "G",
    "A5": "A",  "A#5": "A",
    "B5": "B",
    "C6": "C2", "C#6": "C2",
};

const GROUP_TO_FILE = {
    "C1": "c.jpg", "D": "d.jpg", "E": "e.jpg",
    "F": "f.jpg",  "G": "g.jpg", "A": "a.jpg",
    "B": "b.jpg",  "C2": "c2.jpg"
};

function updateCountsBar() {
    const panelCountImageSize = 21;

    const countMap = {};
    score.measures.forEach(measure => {
        measure.notes.forEach(note => {
            if (!note.rest && note.pitches) {
                note.pitches.forEach(pitch => {
                    const group = PITCH_TO_GROUP[pitch];
                    if (group) countMap[group] = (countMap[group] || 0) + 1;
                });
            }
        });
    });

    const panelCount = document.getElementById("panelCount");
    if (!panelCount) return;
    panelCount.innerHTML = "";

    const ORDER = ["C1", "D", "E", "F", "G", "A", "B", "C2"];
    ORDER.forEach(group => {
        const file = GROUP_TO_FILE[group];
        if (!file) return;

        const item = document.createElement("div");
        item.style.cssText = "display:flex; align-items:center; gap:4px;";

        const img = document.createElement("img");
        img.src = `img/${file}`;
        img.style.cssText = `width:${panelCountImageSize}px; height:${panelCountImageSize}px;`;

        const count = document.createElement("span");
        count.style.cssText = "font-size:12px; color:#999;";
        count.textContent = `×${countMap[group] || 0}`;

        item.appendChild(img);
        item.appendChild(count);
        panelCount.appendChild(item);
    });

    // レール数（レールマスの総数）・センサー数はマップの配置設定に基づいて計算
    const { grid, totalBeats } = buildMapGrid();
    let railCellCount = 0;
    grid.forEach(data => { if (data.type === "rail") railCellCount++; });

    const addCountIcon = (src, alt, count) => {
        const item = document.createElement("div");
        item.style.cssText = "display:flex; align-items:center; gap:4px; margin-left:8px;";

        const img = document.createElement("img");
        img.src = src;
        img.alt = alt;
        img.style.cssText = `width:${panelCountImageSize}px; height:${panelCountImageSize}px;`;

        const label = document.createElement("span");
        label.style.cssText = "font-size:12px; color:#999;";
        label.textContent = `×${count}`;

        item.appendChild(img);
        item.appendChild(label);
        panelCount.appendChild(item);
    };

    addCountIcon("img/rail.png", "レール数", railCellCount);
    addCountIcon("img/sensor.png", "センサー数", totalBeats);
}

function updateAddButton() {
    const scoreElement = document.getElementById("score");
    const svgs = scoreElement.querySelectorAll("svg");
    const btn = document.getElementById("addMeasureBtn");
    if (!svgs.length || !btn) return;

    const lastSvg = svgs[svgs.length - 1];
    const lastRowDiv = lastSvg.parentElement;
    const lastSvgWidth = parseFloat(lastSvg.getAttribute("width") || 0);

    btn.style.left = `${lastSvgWidth + 4}px`;
    btn.style.top = `${lastRowDiv.offsetTop + (STAVE_TOP_BASE + 46) * scale}px`;
    btn.style.width = `${28 * scale}px`;
    btn.style.height = `${28 * scale}px`;
    btn.style.fontSize = `${16 * scale}px`;
}

function drawHoverPreview(context, stave, measureIndex) {
    if (editMode === "select") return;
    if (!hoveredPos || hoveredPos.measureIndex !== measureIndex) return;

    try {
        const converted = pitchToKey(hoveredPos.pitch);
        const previewNote = new VF.StaveNote({
            keys: [converted.key],
            duration: "q",
            auto_stem: true
        });

        if (converted.accidental) {
            previewNote.addModifier(
                new VF.Accidental(converted.accidental), 0
            );
        }

        const voice = new VF.Voice({ num_beats: 1, beat_value: 4 });
        voice.setStrict(false);
        voice.addTickables([previewNote]);

        new VF.Formatter()
            .joinVoices([voice])
            .format([voice], 0);

        previewNote.setContext(context).setStave(stave);

        const targetX = hoveredPos.x / scale;
        const currentX = previewNote.getAbsoluteX();
        const noteHeadWidth = 6;

        previewNote.setXShift(targetX - currentX - noteHeadWidth);
        previewNote.setStyle({
            fillStyle: "rgba(74, 144, 226, 0.4)",
            strokeStyle: "rgba(74, 144, 226, 0.4)"
        });
        previewNote.setStemStyle({
            fillStyle: "rgba(0,0,0,0)",
            strokeStyle: "rgba(0,0,0,0)"
        });
        previewNote.setFlagStyle({
            fillStyle: "rgba(0,0,0,0)",
            strokeStyle: "rgba(0,0,0,0)"
        });
        previewNote.draw();

    } catch (e) {
        // プレビュー描画エラーは無視
    }
}

function saveHistory() {
    history = history.slice(0, historyIndex + 1);
    history.push(JSON.stringify(score));
    historyIndex++;
}

function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    score = JSON.parse(history[historyIndex]);
    selectedMeasures.clear();
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
}

function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    score = JSON.parse(history[historyIndex]);
    selectedMeasures.clear();
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
}

function getMeasuresPerRow() {
    const wrapper = document.getElementById("scoreWrapper");
    const availableWidth = wrapper.clientWidth - 40;
    const firstRowWidth = FIRST_MEASURE_EXTRA + STAVE_WIDTH_BASE;
    if (availableWidth < firstRowWidth * scale) return 1;
    const remaining = availableWidth - firstRowWidth * scale;
    return 1 + Math.floor(remaining / (STAVE_WIDTH_BASE * scale));
}

// 指定した小節のX範囲（row内の左端〜右端）を返す
function getMeasureXRange(measureIndex) {
    const measuresPerRow = getMeasuresPerRow();
    const rowIndex = Math.floor(measureIndex / measuresPerRow);
    const indexInRow = measureIndex % measuresPerRow;
    const isFirstRow = rowIndex === 0;
    const isFirstMeasure = isFirstRow && indexInRow === 0;

    let sx;
    if (isFirstRow) {
        sx = indexInRow === 0 ? 20 : 20 + FIRST_MEASURE_EXTRA + indexInRow * STAVE_WIDTH_BASE;
    } else {
        sx = 20 + indexInRow * STAVE_WIDTH_BASE;
    }
    const measureWidth = isFirstMeasure ? STAVE_WIDTH_BASE + FIRST_MEASURE_EXTRA : STAVE_WIDTH_BASE;

    return {
        rowIndex,
        left: sx * scale,
        right: (sx + measureWidth) * scale
    };
}

// 指定座標（scoreWrapper基準）に最も近い小節indexを返す（行優先・X座標は範囲内/最近傍）
function getMeasureIndexFromWrapperXY(x, y) {
    const scoreElement = document.getElementById("score");
    const rowDivs = scoreElement.querySelectorAll("div[data-row-index]");
    if (!rowDivs.length || !score.measures.length) return 0;

    let bestIndex = 0;
    let bestDist = Infinity;

    score.measures.forEach((_, measureIndex) => {
        const { rowIndex, left, right } = getMeasureXRange(measureIndex);
        const rowDiv = rowDivs[rowIndex];
        if (!rowDiv) return;

        const top = rowDiv.offsetTop;
        const bottom = top + rowDiv.offsetHeight;

        let dy;
        if (y < top) dy = top - y;
        else if (y > bottom) dy = y - bottom;
        else dy = 0;

        let dx;
        if (x < left) dx = left - x;
        else if (x > right) dx = x - right;
        else dx = 0;

        // 行のズレを最優先（同じ行内ならdy=0なので、行内のX距離だけで比較される）
        const dist = dy * 100000 + dx;

        if (dist < bestDist) {
            bestDist = dist;
            bestIndex = measureIndex;
        }
    });

    return bestIndex;
}

// ドラッグ開始点〜終了点までの小節indexを、順序通りに全部含めて返す（飛び飛びにならない）
function getMeasuresInDragRange(x1, y1, x2, y2) {
    const startIndex = getMeasureIndexFromWrapperXY(x1, y1);
    const endIndex = getMeasureIndexFromWrapperXY(x2, y2);

    const from = Math.min(startIndex, endIndex);
    const to = Math.max(startIndex, endIndex);

    const result = [];
    for (let i = from; i <= to; i++) {
        result.push(i);
    }
    return result;
}

function renderScore() {
    const scrollY = window.scrollY;
    notePositions = [];

    const scoreElement = document.getElementById("score");
    scoreElement.innerHTML = "";

    const measuresPerRow = getMeasuresPerRow();

    const rows = [];
    for (let i = 0; i < score.measures.length; i += measuresPerRow) {
        rows.push(score.measures.slice(i, i + measuresPerRow).map((m, j) => ({
            measure: m,
            measureIndex: i + j
        })));
    }

    rows.forEach((rowMeasures, rowIndex) => {
        const isFirstRow = rowIndex === 0;

        const firstMeasureExtra = isFirstRow ? FIRST_MEASURE_EXTRA : 0;
        const rowWidth = (20 + firstMeasureExtra + rowMeasures.length * STAVE_WIDTH_BASE + 20) * scale;

        const rowDiv = document.createElement("div");
        rowDiv.style.position = "relative";
        rowDiv.dataset.rowIndex = rowIndex;
        scoreElement.appendChild(rowDiv);

        const renderer = new VF.Renderer(rowDiv, VF.Renderer.Backends.SVG);
        renderer.resize(rowWidth, 200 * scale);
        renderer.getContext().scale(scale, scale);
        const context = renderer.getContext();

        rowMeasures.forEach(({ measure, measureIndex }, indexInRow) => {
            const isFirstMeasure = isFirstRow && indexInRow === 0;

            let sx;
            if (isFirstRow) {
                sx = indexInRow === 0 ? 20 : 20 + FIRST_MEASURE_EXTRA + indexInRow * STAVE_WIDTH_BASE;
            } else {
                sx = 20 + indexInRow * STAVE_WIDTH_BASE;
            }

            const measureWidth = isFirstMeasure ? STAVE_WIDTH_BASE + FIRST_MEASURE_EXTRA : STAVE_WIDTH_BASE;
            const stave = new VF.Stave(sx, STAVE_TOP_BASE, measureWidth);

            if (isFirstMeasure) {
                stave.addClef("treble");
                stave.addTimeSignature(score.timeSignature);
            }

            if (measureIndex === score.measures.length - 1) {
                stave.setEndBarType(VF.Barline.type.END);
            }

            stave.setContext(context).draw();

            context.save();
            context.setFont("Arial", 11);
            context.setFillStyle("#aaa");
            context.fillText(
                `${measureIndex + 1}`,
                sx + 4,
                STAVE_TOP_BASE - 5
            );
            context.restore();

            if (!measure.notes || measure.notes.length === 0) {
                drawHoverPreview(context, stave, measureIndex);
                return;
            }

            const notes = measure.notes.map((note, noteIndex) => {
                const isHovered = hoveredPos &&
                    hoveredPos.measureIndex === measureIndex &&
                    hoveredPos.hitNoteIndex === noteIndex &&
                    hoveredPos.directHit === true;

                const hoverColor = "rgba(220, 50, 50, 0.7)";

                if (note.rest) {
                    const restNote = new VF.StaveNote({
                        keys: ["b/4"],
                        duration: note.duration + "r"
                    });
                    if (isHovered) {
                        restNote.setStyle({ fillStyle: hoverColor, strokeStyle: hoverColor });
                    }
                    return restNote;
                }

                const keys = note.pitches.map(p => pitchToKey(p).key);
                const staveNote = new VF.StaveNote({
                    keys,
                    duration: note.duration,
                    auto_stem: true
                });

                if (isHovered) {
                    staveNote.setStyle({ fillStyle: hoverColor, strokeStyle: hoverColor });
                }

                note.pitches.forEach((pitch, i) => {
                    const converted = pitchToKey(pitch);
                    if (converted.accidental) {
                        staveNote.addModifier(
                            new VF.Accidental(converted.accidental), i
                        );
                    }
                });

                return staveNote;
            });

            const remainingBeats = 4 - getMeasureBeats(measure);
            const dummyNotes = makeDummyNotes(remainingBeats);
            const allNotes = [...notes, ...dummyNotes];

            const voice = new VF.Voice({ num_beats: 4, beat_value: 4 });
            voice.setStrict(false);
            voice.addTickables(allNotes);

            const formatWidth = isFirstMeasure
                ? STAVE_WIDTH_BASE + FIRST_MEASURE_EXTRA - 80
                : STAVE_WIDTH_BASE - 10;

            new VF.Formatter()
                .joinVoices([voice])
                .format([voice], formatWidth);

            const beams = VF.Beam.generateBeams(
                notes.filter((_, i) => !measure.notes[i].rest)
            );

            beams.forEach(beam => {
                beam.getNotes().forEach(note => {
                    note.setFlagStyle({
                        fillStyle: "transparent",
                        strokeStyle: "transparent"
                    });
                });
            });

            voice.draw(context, stave);

            beams.forEach(beam => {
                beam.setContext(context).draw();
            });

            notes.forEach((staveNote, noteIndex) => {
                const noteData = measure.notes[noteIndex];
                const bb = staveNote.getBoundingBox();
                const nx = staveNote.getAbsoluteX() * scale;
                const nxLeft = bb ? bb.getX() * scale : nx - 6 * scale;
                const nxRight = bb ? (bb.getX() + bb.getW()) * scale : nx + 6 * scale;
                const svgOffsetTop = rowDiv.offsetTop;

                if (noteData.rest) {
                    const ny = staveNote.getYs()[0] * scale + svgOffsetTop;
                    notePositions.push({
                        x: nx,
                        xLeft: nxLeft,
                        xRight: nxRight,
                        y: ny,
                        pitch: null,
                        rest: true,
                        measureIndex,
                        noteIndex,
                        pitchIndex: 0,
                        rowIndex
                    });
                    return;
                }

                const bbX = bb ? bb.getX() * scale : nx;
                const bbW = bb ? bb.getW() * scale : 12 * scale;
                const pitchCount = noteData.pitches.length;

                noteData.pitches.forEach((pitch, pitchIndex) => {
                    const ny = staveNote.getYs()[pitchIndex] * scale + svgOffsetTop;
                    const sliceW = bbW / pitchCount;
                    notePositions.push({
                        x: nx,
                        xLeft: bbX + sliceW * pitchIndex,
                        xRight: bbX + sliceW * (pitchIndex + 1),
                        y: ny,
                        pitch,
                        measureIndex,
                        noteIndex,
                        pitchIndex,
                        rowIndex
                    });
                });
            });

            drawHoverPreview(context, stave, measureIndex);
        });
    });

    updateCountsBar();
    updateAddButton();
    setupSVGEvents();
    drawSelectionRect();
    window.scrollTo(0, scrollY);
}

// 選択中（確定 + ドラッグ中の暫定）の小節にDIVオーバーレイでハイライトを重ねる
// renderScore() を呼ばずに高速更新できるようにするための仕組み
function drawSelectionRect() {
    document.querySelectorAll(".selectionHighlight").forEach(el => el.remove());

    const scoreElement = document.getElementById("score");
    const rowDivs = scoreElement.querySelectorAll("div[data-row-index]");
    if (!rowDivs.length || !score.measures.length) return;

    let previewSet = null;
    if (dragState && dragState.isDragging) {
        previewSet = new Set(getMeasuresInDragRange(
            dragState.startX, dragState.startY,
            dragState.currentX, dragState.currentY
        ));
    }

    const wrapper = document.getElementById("scoreWrapper");

    score.measures.forEach((_, measureIndex) => {
        const isSelected = selectedMeasures.has(measureIndex) ||
            (previewSet && previewSet.has(measureIndex));
        if (!isSelected) return;

        const { rowIndex, left, right } = getMeasureXRange(measureIndex);
        const rowDiv = rowDivs[rowIndex];
        if (!rowDiv) return;

        const top = rowDiv.offsetTop + (STAVE_TOP_BASE - 6) * scale;
        const height = 130 * scale;

        const el = document.createElement("div");
        el.className = "selectionHighlight";
        el.style.cssText = `
            position: absolute;
            left: ${left}px;
            top: ${top}px;
            width: ${right - left}px;
            height: ${height}px;
            background: rgba(74, 144, 226, 0.12);
            pointer-events: none;
            z-index: 5;
        `;
        wrapper.appendChild(el);
    });
}

function setupDeleteButtons() {
    document.querySelectorAll(".deleteMeasureBtn").forEach(b => b.remove());

    const wrapper = document.getElementById("scoreWrapper");
    const scoreElement = document.getElementById("score");
    const measuresPerRow = getMeasuresPerRow();

    score.measures.forEach((_, measureIndex) => {
        if (score.measures.length <= 1) return;

        const btn = document.createElement("button");
        btn.className = "deleteMeasureBtn";
        btn.innerHTML = '<i class="fa-solid fa-circle-xmark"></i>';

        const rowIndex = Math.floor(measureIndex / measuresPerRow);
        const indexInRow = measureIndex % measuresPerRow;
        const isFirstRow = rowIndex === 0;
        const isFirstMeasure = isFirstRow && indexInRow === 0;

        let sx;
        if (isFirstRow) {
            sx = indexInRow === 0 ? 20 : 20 + FIRST_MEASURE_EXTRA + indexInRow * STAVE_WIDTH_BASE;
        } else {
            sx = 20 + indexInRow * STAVE_WIDTH_BASE;
        }

        const measureWidth = isFirstMeasure ? STAVE_WIDTH_BASE + FIRST_MEASURE_EXTRA : STAVE_WIDTH_BASE;
        const rowDivs = scoreElement.querySelectorAll("div[data-row-index]");
        const rowDiv = rowDivs[rowIndex];
        const rowOffsetTop = rowDiv ? rowDiv.offsetTop : 0;

        const leftPos = (sx + measureWidth / 2 - 14) * scale;
        const topPos = rowOffsetTop + (STAVE_TOP_BASE + 110) * scale;

        btn.style.left = `${leftPos}px`;
        btn.style.top = `${topPos}px`;
        btn.style.display = "flex";
        btn.style.width = `${28 * scale}px`;
        btn.style.height = `${28 * scale}px`;
        btn.style.fontSize = `${16 * scale}px`;

        btn.addEventListener("click", () => {
            score.measures.splice(measureIndex, 1);
            selectedMeasures.clear();
            saveHistory();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
        });

        wrapper.appendChild(btn);
    });
}

function setupInsertButtons() {
    document.querySelectorAll(".insertMeasureBtn").forEach(b => b.remove());

    const wrapper = document.getElementById("scoreWrapper");
    const scoreElement = document.getElementById("score");
    const measuresPerRow = getMeasuresPerRow();

    score.measures.forEach((_, measureIndex) => {
        const btn = document.createElement("button");
        btn.className = "insertMeasureBtn";
        btn.innerHTML = '<i class="fa-solid fa-circle-plus"></i>';

        const rowIndex = Math.floor(measureIndex / measuresPerRow);
        const indexInRow = measureIndex % measuresPerRow;
        const isFirstRow = rowIndex === 0;
        const isFirstMeasure = isFirstRow && indexInRow === 0;

        let sx;
        if (isFirstRow) {
            sx = indexInRow === 0 ? 20 : 20 + FIRST_MEASURE_EXTRA + indexInRow * STAVE_WIDTH_BASE;
        } else {
            sx = 20 + indexInRow * STAVE_WIDTH_BASE;
        }

        const rowDivs = scoreElement.querySelectorAll("div[data-row-index]");
        const rowDiv = rowDivs[rowIndex];
        const rowOffsetTop = rowDiv ? rowDiv.offsetTop : 0;

        const leftPos = (sx - 14) * scale;
        const topPos = rowOffsetTop + (STAVE_TOP_BASE + 110) * scale;

        btn.style.left = `${leftPos}px`;
        btn.style.top = `${topPos}px`;
        btn.style.display = "flex";
        btn.style.width = `${28 * scale}px`;
        btn.style.height = `${28 * scale}px`;
        btn.style.fontSize = `${16 * scale}px`;

        btn.addEventListener("click", () => {
            score.measures.splice(measureIndex, 0, { notes: [] });
            selectedMeasures.clear();
            saveHistory();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
        });

        wrapper.appendChild(btn);
    });
}

function updateDeleteButtons() {}

function findNoteAtX(measureIndex, clickX) {
    return notePositions.find(pos =>
        pos.measureIndex === measureIndex &&
        Math.abs(pos.x - clickX) <= 24 * scale
    ) || null;
}

function findNoteAt(measureIndex, clickX, clickY, looseness = 1) {
    const hit = notePositions.find(pos =>
        pos.measureIndex === measureIndex &&
        clickX >= pos.xLeft &&
        clickX < pos.xRight &&
        Math.abs(pos.y - clickY) <= 5 * scale * looseness
    );
    return hit || null;
}

function getMeasureIndexFromXY(clickX, clickY) {
    const scoreElement = document.getElementById("score");
    const rowDivs = scoreElement.querySelectorAll("div[data-row-index]");
    const measuresPerRow = getMeasuresPerRow();

    let rowIndex = 0;
    for (let i = 0; i < rowDivs.length; i++) {
        const rowDiv = rowDivs[i];
        const top = rowDiv.offsetTop;
        const height = rowDiv.offsetHeight;
        if (clickY >= top && clickY < top + height) {
            rowIndex = i;
            break;
        }
    }

    const isFirstRow = rowIndex === 0;
    const firstMeasureEnd = (20 + FIRST_MEASURE_EXTRA + STAVE_WIDTH_BASE) * scale;

    let indexInRow;
    if (isFirstRow) {
        if (clickX < firstMeasureEnd) {
            indexInRow = 0;
        } else {
            indexInRow = 1 + Math.floor((clickX - firstMeasureEnd) / (STAVE_WIDTH_BASE * scale));
        }
    } else {
        indexInRow = Math.floor((clickX - 20 * scale) / (STAVE_WIDTH_BASE * scale));
    }

    return rowIndex * measuresPerRow + indexInRow;
}

// 実際の音符編集処理（ドラッグでない通常クリック時に呼ばれる）
function handleNoteEdit(e, svg, rowDiv) {
    const rect = svg.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top + rowDiv.offsetTop;
    const clickYLocal = e.clientY - rect.top;

    const measureIndex = getMeasureIndexFromXY(clickX, clickY);
    if (measureIndex < 0 || measureIndex >= score.measures.length) return;

    const measure = score.measures[measureIndex];
    const hit = findNoteAt(measureIndex, clickX, clickY);

    const measuresPerRow = getMeasuresPerRow();
    const idxInRow = measureIndex % measuresPerRow;
    const isFirstRow = Math.floor(measureIndex / measuresPerRow) === 0;
    const isFirstMeasure = isFirstRow && idxInRow === 0;
    let sx;
    if (isFirstRow) {
        sx = idxInRow === 0 ? 20 : 20 + FIRST_MEASURE_EXTRA + idxInRow * STAVE_WIDTH_BASE;
    } else {
        sx = 20 + idxInRow * STAVE_WIDTH_BASE;
    }
    const measureWidth = isFirstMeasure ? STAVE_WIDTH_BASE + FIRST_MEASURE_EXTRA : STAVE_WIDTH_BASE;
    const isValidX = clickX < (sx + measureWidth) * scale;

    if (e.button === 0) {
        if (e.shiftKey) {
            const shiftHit = notePositions
                .filter(pos =>
                    pos.measureIndex === measureIndex &&
                    Math.abs(pos.x - clickX) <= 20 * scale
                )
                .sort((a, b) => Math.abs(a.y - clickY) - Math.abs(b.y - clickY))[0] || null;

            if (shiftHit) {
                const note = measure.notes[shiftHit.noteIndex];
                const pitch = note.pitches[shiftHit.pitchIndex];
                if (BLACK_PITCHES.has(pitch)) {
                    const whiteKey = Object.keys(WHITE_TO_BLACK).find(
                        k => WHITE_TO_BLACK[k] === pitch
                    );
                    if (whiteKey) {
                        note.pitches[shiftHit.pitchIndex] = whiteKey;
                        saveHistory();
                        renderScore();
                    }
                } else if (WHITE_TO_BLACK[pitch]) {
                    note.pitches[shiftHit.pitchIndex] = WHITE_TO_BLACK[pitch];
                    saveHistory();
                    renderScore();
                }
            }

        } else if (e.ctrlKey) {
            const existingNote = findNoteAt(measureIndex, clickX, clickY);
            if (existingNote) return;
            if (!isValidX) return;

            const measureNotes = notePositions.filter(
                p => p.measureIndex === measureIndex
            );

            const beats = getMeasureBeats(measure);
            const remaining = 4 - beats;
            if (remaining <= 0) return;

            const duration = remaining >= 1 ? "q" : remaining >= 0.5 ? "8" : "16";
            if (durationBeats[duration] > remaining) return;

            const uniqueNoteIndices = [...new Set(measureNotes.map(p => p.noteIndex))];
            const noteInsertIndex = uniqueNoteIndices.filter(i => {
                const pos = measureNotes.find(p => p.noteIndex === i);
                return pos && pos.x < clickX;
            }).length;

            measure.notes.splice(noteInsertIndex, 0, {
                rest: true,
                duration
            });
            saveHistory();
            renderScore();

            } else if (hit) {
            // 同じX座標に既存音符があり、Y座標が外れている場合は和音追加
            const existingAtX = findNoteAtX(measureIndex, clickX);
            if (existingAtX && !existingAtX.rest) {
                const note = measure.notes[existingAtX.noteIndex];
                const pitch = yToPitch(clickYLocal, false);
                if (pitch && !note.pitches.includes(pitch) && note.pitches.length < 3) {
                    note.pitches.push(pitch);
                    note.pitches.sort((a, b) => {
                        const aIdx = [...WHITE_KEYS, ...BLACK_KEYS].findIndex(k => k.pitch === a);
                        const bIdx = [...WHITE_KEYS, ...BLACK_KEYS].findIndex(k => k.pitch === b);
                        return aIdx - bIdx;
                    });
                    saveHistory();
                    renderScore();
                    return;
                }
            }

            const note = measure.notes[hit.noteIndex];
            if (note.rest) {
                measure.notes.splice(hit.noteIndex, 1);
            } else if (note.pitches.length === 1) {
                measure.notes.splice(hit.noteIndex, 1);
            } else {
                note.pitches.splice(hit.pitchIndex, 1);
            }
            saveHistory();
            renderScore();

        } else {
            const existingNote = findNoteAtX(measureIndex, clickX);

            if (existingNote) {
                const note = measure.notes[existingNote.noteIndex];
                if (note.rest) return;
                if (note.pitches.length >= 3) return;

                const pitch = yToPitch(clickYLocal, false);
                if (!pitch) return;
                if (note.pitches.includes(pitch)) return;

                note.pitches.push(pitch);
                note.pitches.sort((a, b) => {
                    const aIdx = [...WHITE_KEYS, ...BLACK_KEYS].findIndex(k => k.pitch === a);
                    const bIdx = [...WHITE_KEYS, ...BLACK_KEYS].findIndex(k => k.pitch === b);
                    return aIdx - bIdx;
                });
                saveHistory();
                renderScore();

            } else {
                if (!isValidX) return;

                const pitch = yToPitch(clickYLocal, false);
                if (!pitch) return;

                const beats = getMeasureBeats(measure);
                const remaining = 4 - beats;
                if (remaining <= 0) return;

                const duration = remaining >= 1 ? "q" : remaining >= 0.5 ? "8" : "16";
                if (durationBeats[duration] > remaining) return;

                const measureNotePositions = notePositions.filter(
                    p => p.measureIndex === measureIndex
                );
                const uniqueNoteIndices = [...new Set(measureNotePositions.map(p => p.noteIndex))];
                const insertIndex = uniqueNoteIndices.filter(i => {
                    const pos = measureNotePositions.find(p => p.noteIndex === i);
                    return pos && pos.x < clickX;
                }).length;

                measure.notes.splice(insertIndex, 0, {
                    pitches: [pitch],
                    duration
                });
                saveHistory();
                renderScore();
            }
        }

    } else if (e.button === 2) {
        if (hit) {
            const note = measure.notes[hit.noteIndex];
            const beats = getMeasureBeats(measure);
            const remaining = 4 - beats + durationBeats[note.duration];
            note.duration = getNextDuration(note.duration, remaining);
            saveHistory();
            renderScore();
        }
    }
}

function setupSVGEvents() {
    const scoreElement = document.getElementById("score");
    const svgs = scoreElement.querySelectorAll("svg");
    const wrapper = document.getElementById("scoreWrapper");

    svgs.forEach((svg, rowIndex) => {
        const rowDiv = svg.parentElement;

        svg.setAttribute("pointer-events", "all");
        // カーソルはデフォルトのまま（変更しない）

        svg.addEventListener("contextmenu", e => e.preventDefault());

        svg.addEventListener("mousemove", e => {
            // ドラッグ中はホバー処理をスキップ（座標更新はdocument mousemoveで行う）
            if (dragState && dragState.isDragging) return;
            if (dragState) return;

            const rect = svg.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top + rowDiv.offsetTop;

            const measureIndex = getMeasureIndexFromXY(mouseX, mouseY);

            if (measureIndex < 0 || measureIndex >= score.measures.length) {
                if (hoveredPos !== null) {
                    hoveredPos = null;
                    renderScore();
                }
                return;
            }

            const pitch = yToPitch(e.clientY - rect.top, false);
            const hitNote = findNoteAt(measureIndex, mouseX, mouseY);
            const hitNoteX = findNoteAtX(measureIndex, mouseX);

            const newHovered = pitch
                ? { measureIndex, x: mouseX, y: mouseY, pitch, hitNoteIndex: hitNote ? hitNote.noteIndex : (hitNoteX ? hitNoteX.noteIndex : null), directHit: !!hitNote }
                : null;

            const changed = JSON.stringify(newHovered) !== JSON.stringify(hoveredPos);
            if (changed) {
                hoveredPos = newHovered;
                renderScore();
            }
        });

        svg.addEventListener("mouseleave", () => {
            if (dragState) return;
            if (hoveredPos !== null) {
                hoveredPos = null;
                renderScore();
            }
        });
    });
}

// document・wrapperレベルのイベントはmain()で一度だけ登録する
function updateEditModeButtons() {
    const noteBtn = document.getElementById("editModeNote");
    const selectBtn = document.getElementById("editModeSelect");
    if (!noteBtn || !selectBtn) return;
    noteBtn.style.color = editMode === "note" ? "#222" : "#aaa";
    selectBtn.style.color = editMode === "select" ? "#222" : "#aaa";
    noteBtn.style.background = editMode === "note" ? "#f0f0f0" : "";
    selectBtn.style.background = editMode === "select" ? "#f0f0f0" : "";
}

function setEditMode(mode) {
    editMode = mode;
    localStorage.setItem("editMode", editMode);
    // 選択モードに切り替えた場合、ホバー状態をクリア
    if (editMode === "select" && hoveredPos !== null) {
        hoveredPos = null;
        renderScore();
    }
    updateEditModeButtons();
}

function setupGlobalEvents() {
    const wrapper = document.getElementById("scoreWrapper");

    // ドラッグ座標更新・確定判定（document全体で監視）
    document.addEventListener("mousemove", e => {
        if (!dragState) return;
        const wrapperRect = wrapper.getBoundingClientRect();
        dragState.currentX = e.clientX - wrapperRect.left;
        dragState.currentY = e.clientY - wrapperRect.top;

        const dx = dragState.currentX - dragState.startX;
        const dy = dragState.currentY - dragState.startY;
        if (!dragState.isDragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
            dragState.isDragging = true;
        }
        if (dragState.isDragging) {
            drawSelectionRect();
        }
    });

    // mouseup（svg外でリリースされても確定させるため）
    document.addEventListener("mouseup", e => {
        if (!dragState) return;

        if (dragState.isDragging) {
            const measures = getMeasuresInDragRange(
                dragState.startX, dragState.startY,
                dragState.currentX, dragState.currentY
            );
            selectedMeasures = new Set(measures);
            dragState = null;
            renderScore();
        } else {
            // ドラッグなし
            const { svg, rowDiv, originalEvent } = dragState;
            dragState = null;
            drawSelectionRect();

            if (editMode === "select" && svg) {
                // 選択モード：クリックした小節を単体選択
                const rect = svg.getBoundingClientRect();
                const clickX = originalEvent.clientX - rect.left;
                const clickY = originalEvent.clientY - rect.top + rowDiv.offsetTop;
                const measureIndex = getMeasureIndexFromXY(clickX, clickY);
                if (measureIndex >= 0 && measureIndex < score.measures.length) {
                    selectedMeasures = new Set([measureIndex]);
                    renderScore();
                }
            } else {
                // 音符モード：通常の音符編集処理
                if (selectedMeasures.size > 0) {
                    selectedMeasures.clear();
                    renderScore();
                }
                if (svg && editMode === "note") {
                    handleNoteEdit(originalEvent, svg, rowDiv);
                }
            }
        }
    });

    // document全体のmousedownでドラッグ選択を開始（ページのどこからでも）
    document.addEventListener("mousedown", e => {
        if (e.target.closest("button")) return;
        if (e.target.closest("input")) return;
        if (e.target.closest("label")) return;

        // 右クリック・Shift・Ctrl は音符モード時のみSVG上で音符編集
        if (e.button !== 0 || e.shiftKey || e.ctrlKey) {
            if (editMode === "note") {
                const svgEl = e.target.closest("svg");
                if (svgEl) {
                    const scoreElement = document.getElementById("score");
                    const svgs = scoreElement.querySelectorAll("svg");
                    let rowDiv = null;
                    svgs.forEach(s => { if (s === svgEl) rowDiv = s.parentElement; });
                    handleNoteEdit(e, svgEl, rowDiv);
                }
            }
            return;
        }

        e.preventDefault();

        // 前の選択をクリア
        if (selectedMeasures.size > 0) {
            selectedMeasures.clear();
            drawSelectionRect();
        }

        // SVG上からのクリックなら svg と rowDiv を記録
        const svgEl = e.target.closest("svg");
        let hitSvg = null;
        let hitRowDiv = null;
        if (svgEl) {
            const scoreElement = document.getElementById("score");
            const svgs = scoreElement.querySelectorAll("svg");
            svgs.forEach(s => {
                if (s === svgEl) {
                    hitSvg = s;
                    hitRowDiv = s.parentElement;
                }
            });
        }

        const wrapperRect = wrapper.getBoundingClientRect();
        dragState = {
            startX: e.clientX - wrapperRect.left,
            startY: e.clientY - wrapperRect.top,
            currentX: e.clientX - wrapperRect.left,
            currentY: e.clientY - wrapperRect.top,
            isDragging: false,
            svg: hitSvg,
            rowDiv: hitRowDiv,
            originalEvent: e
        };
    });
}

function rebuildNoteTimeMap() {
    if (!noteSchedule.length) return;
    noteTimeMap = [];
    const measuresPerRow = getMeasuresPerRow();

    noteSchedule.forEach(({ measureIndex, startTime, endTime }) => {
        const rowIndex = Math.floor(measureIndex / measuresPerRow);
        const idxInRow = measureIndex % measuresPerRow;
        const isFirstRow = rowIndex === 0;
        const isFirstMeasure = isFirstRow && idxInRow === 0;

        let sx;
        if (isFirstRow) {
            sx = idxInRow === 0 ? 20 : 20 + FIRST_MEASURE_EXTRA + idxInRow * STAVE_WIDTH_BASE;
        } else {
            sx = 20 + idxInRow * STAVE_WIDTH_BASE;
        }
        const measureWidth = isFirstMeasure ? STAVE_WIDTH_BASE + FIRST_MEASURE_EXTRA : STAVE_WIDTH_BASE;

        noteTimeMap.push({
            startTime,
            endTime,
            startX: sx * scale,
            endX: (sx + measureWidth) * scale,
            rowIndex
        });
    });
}

function updateZoom(newScale) {
    scale = newScale;
    document.getElementById("zoomSlider").value = scale;
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
    if (activeTab === "map") renderMap();
    if (playState !== "stopped") {
        rebuildNoteTimeMap();
    }
}

// 選択中の小節を一括削除
function copySelectedMeasures() {
    if (selectedMeasures.size === 0) return;
    const indices = [...selectedMeasures].sort((a, b) => a - b);
    clipboardMeasures = indices.map(i => JSON.parse(JSON.stringify(score.measures[i])));
    updateClipboardButtons();
}

function cutSelectedMeasures() {
    if (selectedMeasures.size === 0) return;
    const indices = [...selectedMeasures].sort((a, b) => a - b);
    clipboardMeasures = indices.map(i => JSON.parse(JSON.stringify(score.measures[i])));

    // 全削除時は1小節残す
    if (indices.length >= score.measures.length) {
        score.measures = [{ notes: [] }];
    } else {
        [...indices].reverse().forEach(i => score.measures.splice(i, 1));
    }
    selectedMeasures.clear();
    saveHistory();
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
    updateClipboardButtons();
}

function pasteSelectedMeasures() {
    if (clipboardMeasures.length === 0) return;
    if (selectedMeasures.size === 0) return;

    const insertAt = Math.min(...selectedMeasures);
    const copies = clipboardMeasures.map(m => JSON.parse(JSON.stringify(m)));
    score.measures.splice(insertAt, 0, ...copies);

    // 挿入数分だけ選択indexをシフト（元の選択小節を指し続ける）
    const shift = copies.length;
    selectedMeasures = new Set([...selectedMeasures].map(i => i + shift));

    saveHistory();
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
}

function updateClipboardButtons() {
    const pasteBtn = document.getElementById("pasteBtn");
    if (pasteBtn) {
        pasteBtn.style.opacity = clipboardMeasures.length > 0 ? "1" : "0.4";
        pasteBtn.disabled = clipboardMeasures.length === 0;
    }
}

function deleteSelectedMeasures() {
    if (selectedMeasures.size === 0) return;
    if (selectedMeasures.size >= score.measures.length) {
        // 全小節が選択されている場合は最低1小節残す
        score.measures = [{ notes: [] }];
    } else {
        const indices = [...selectedMeasures].sort((a, b) => b - a);
        indices.forEach(i => score.measures.splice(i, 1));
    }
    selectedMeasures.clear();
    saveHistory();
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
}

async function main() {

    loadSeBuffers();

    const response = await fetch("sample_score.json");
    const data = await response.json();
    score = { timeSignature: data.timeSignature, measures: data.measures };

    // サンプルJSONに表題・テンポ・コンパス・ズーム・マップ設定があれば復元する
    if (data.title != null) {
        document.getElementById("scoreTitleInput").value = data.title;
    }
    if (data.bpm != null) {
        document.getElementById("bpmInput").value = data.bpm;
    }
    if (data.northDirection != null) {
        northDirection = data.northDirection;
        document.getElementById("compassLabel").textContent = COMPASS_LABELS[northDirection];
    }
    if (data.scale != null) {
        scale = data.scale;
        document.getElementById("zoomSlider").value = scale;
    }
    if (data.mapSettings) {
        Object.assign(mapSettings, data.mapSettings);
        saveMapSettings();
    }

    // タブUIを動的に生成
    const tabContainer = document.getElementById("tabContainer");
    TABS.forEach(tab => {
        const btn = document.createElement("button");
        btn.id = `tab-${tab.id}`;
        btn.className = "tab-btn";
        btn.textContent = tab.label;
        btn.addEventListener("click", () => switchTab(tab.id));
        tabContainer.appendChild(btn);
    });

    applyTabVisibility();

    renderScore();
    saveHistory();
    setupDeleteButtons();
    setupInsertButtons();
    // localStorageに保存されたタブが「五線譜」以外の場合、そのタブの中身も初期描画する
    if (activeTab === "map") renderMap();
    setupGlobalEvents(); // document/wrapperイベントは一度だけ登録

    // モード切替ボタンの初期状態を反映
    updateEditModeButtons();

    document.getElementById("editModeNote")
        .addEventListener("click", () => setEditMode("note"));
    document.getElementById("editModeSelect")
        .addEventListener("click", () => setEditMode("select"));

    document.getElementById("copyBtn")
        .addEventListener("click", () => copySelectedMeasures());
    document.getElementById("cutBtn")
        .addEventListener("click", () => cutSelectedMeasures());
    document.getElementById("pasteBtn")
        .addEventListener("click", () => pasteSelectedMeasures());

    updateClipboardButtons();

    // マップ専用ツールバーのイベント登録
    document.getElementById("mapRailVertical")?.addEventListener("click", () => {
        mapSettings.railDirection = "vertical";
        saveMapSettings(); updateMapToolbarUI(); renderMap();
    });
    document.getElementById("mapRailHorizontal")?.addEventListener("click", () => {
        mapSettings.railDirection = "horizontal";
        saveMapSettings(); updateMapToolbarUI(); renderMap();
    });
    ["top-left","top-right","bottom-left","bottom-right"].forEach(corner => {
        document.getElementById(`mapCorner-${corner}`)?.addEventListener("click", () => {
            mapSettings.startCorner = corner;
            saveMapSettings(); updateMapToolbarUI(); renderMap();
        });
    });
    document.getElementById("mapSideLeft")?.addEventListener("click", () => {
        mapSettings.sideFirst = "left";
        saveMapSettings(); updateMapToolbarUI(); renderMap();
    });
    document.getElementById("mapSideRight")?.addEventListener("click", () => {
        mapSettings.sideFirst = "right";
        saveMapSettings(); updateMapToolbarUI(); renderMap();
    });
    document.getElementById("mapWrapByCount")?.addEventListener("click", () => {
        if (!mapSettings.wrapByCount) {
            // マス数→センサー数へ変換（表示している折り返し幅の実質的な意味を保つ）
            mapSettings.wrapValue = Math.max(1, Math.round((mapSettings.wrapValue + 1) / 3));
        }
        mapSettings.wrapByCount = true;
        saveMapSettings(); updateMapToolbarUI(); renderMap();
    });
    document.getElementById("mapWrapByMass")?.addEventListener("click", () => {
        if (mapSettings.wrapByCount) {
            // センサー数→マス数へ変換（表示している折り返し幅の実質的な意味を保つ）
            mapSettings.wrapValue = Math.max(1, mapSettings.wrapValue * 3 - 1);
        }
        mapSettings.wrapByCount = false;
        saveMapSettings(); updateMapToolbarUI(); renderMap();
    });
    document.getElementById("mapWrapValue")?.addEventListener("change", e => {
        mapSettings.wrapValue = Math.max(1, parseInt(e.target.value) || 1);
        saveMapSettings(); renderMap();
    });
    document.getElementById("mapWrapDown")?.addEventListener("click", () => {
        // マス数指定のときは3マス間隔（センサー間隔）に合わせて3ずつ増減する
        const step = mapSettings.wrapByCount ? 1 : 3;
        mapSettings.wrapValue = Math.max(1, mapSettings.wrapValue - step);
        const el = document.getElementById("mapWrapValue");
        if (el) el.value = mapSettings.wrapValue;
        saveMapSettings(); renderMap();
    });
    document.getElementById("mapWrapUp")?.addEventListener("click", () => {
        const step = mapSettings.wrapByCount ? 1 : 3;
        mapSettings.wrapValue = mapSettings.wrapValue + step;
        const el = document.getElementById("mapWrapValue");
        if (el) el.value = mapSettings.wrapValue;
        saveMapSettings(); renderMap();
    });
    updateMapToolbarUI();

    window.addEventListener("resize", () => {
        renderScore();
        setupDeleteButtons();
        setupInsertButtons();
    });

    document.getElementById("addMeasureBtn")
        .addEventListener("click", (e) => {
            e.preventDefault();
            const scrollY = window.scrollY;
            score.measures.push({ notes: [] });
            selectedMeasures.clear();
            saveHistory();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
            window.scrollTo(0, scrollY);
        });

    document.addEventListener("keydown", e => {
        if (e.key === "Shift" || e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
        } else if (e.ctrlKey && e.shiftKey && e.key === "Z") {
            e.preventDefault();
            redo();
        } else if (e.ctrlKey && e.key === "z") {
            e.preventDefault();
            undo();
        } else if (e.ctrlKey && e.key === "y") {
            e.preventDefault();
            redo();
        } else if (e.ctrlKey && e.key === "c") {
            if (selectedMeasures.size > 0) {
                e.preventDefault();
                copySelectedMeasures();
            }
        } else if (e.ctrlKey && e.key === "x") {
            if (selectedMeasures.size > 0) {
                e.preventDefault();
                cutSelectedMeasures();
            }
        } else if (e.ctrlKey && e.key === "v") {
            if (clipboardMeasures.length > 0 && selectedMeasures.size > 0) {
                e.preventDefault();
                pasteSelectedMeasures();
            }
        } else if (e.key === "Escape") {
            if (selectedMeasures.size > 0) {
                selectedMeasures.clear();
                renderScore();
            }
        } else if (e.key === "Delete" || e.key === "Backspace") {
            if (selectedMeasures.size > 0) {
                e.preventDefault();
                deleteSelectedMeasures();
            }
        }
    });

    document.addEventListener("wheel", e => {
        if (e.ctrlKey) {
            e.preventDefault();
            if (e.deltaY < 0) {
                updateZoom(Math.min(scale + 0.1, 3));
            } else {
                updateZoom(Math.max(scale - 0.1, 0.25));
            }
        }
    }, { passive: false });

    document.getElementById("zoomIn")
        .addEventListener("click", () => {
            updateZoom(Math.min(scale + 0.25, 3));
        });

    document.getElementById("zoomOut")
        .addEventListener("click", () => {
            updateZoom(Math.max(scale - 0.25, 0.25));
        });

    document.getElementById("zoomSlider")
        .addEventListener("input", (e) => {
            updateZoom(parseFloat(e.target.value));
        });

    document.getElementById("compassBtn")
        .addEventListener("click", () => {
            northDirection = (northDirection + 1) % 4;
            document.getElementById("compassLabel").textContent = COMPASS_LABELS[northDirection];
            updateCountsBar();
            if (activeTab === "map") renderMap();
        });

    document.getElementById("clearBtn")
        .addEventListener("click", () => {
            if (!confirm("全クリアしますか？")) return;
            score.measures = [{ notes: [] }];
            document.getElementById("scoreTitleInput").value = "NewScore";
            selectedMeasures.clear();
            saveHistory();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
        });

    document.getElementById("undoBtn")
        .addEventListener("click", () => undo());

    document.getElementById("redoBtn")
        .addEventListener("click", () => redo());

    document.getElementById("playBtn")
        .addEventListener("click", () => {
            if (playState === "stopped") {
                playScore();
            } else if (playState === "playing") {
                pauseScore();
            } else if (playState === "paused") {
                resumeScore();
            }
        });

    document.getElementById("stopBtn")
        .addEventListener("click", () => stopScore());

    document.getElementById("loopBtn")
        .addEventListener("click", () => {
            isLooping = !isLooping;
            const icon = document.querySelector("#loopBtn i");
            icon.style.color = isLooping ? "#4a90e2" : "#ccc";
        });

    document.getElementById("bpmInput")
        .addEventListener("change", () => applyTempoChange());

    document.getElementById("saveBtn")
        .addEventListener("click", () => {
            const title = document.getElementById("scoreTitleInput").value || "NewScore";
            const bpm = parseInt(document.getElementById("bpmInput").value) || 120;
            const payload = {
                ...score,
                title,
                bpm,
                northDirection,
                scale,
                mapSettings: { ...mapSettings },
            };
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${title}.json`;
            a.click();
            URL.revokeObjectURL(url);
        });

    document.getElementById("loadFile")
        .addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    score = { timeSignature: data.timeSignature, measures: data.measures };

                    if (data.title != null) {
                        document.getElementById("scoreTitleInput").value = data.title;
                    }
                    if (data.bpm != null) {
                        document.getElementById("bpmInput").value = data.bpm;
                    }
                    if (data.northDirection != null) {
                        northDirection = data.northDirection;
                        document.getElementById("compassLabel").textContent = COMPASS_LABELS[northDirection];
                    }
                    if (data.scale != null) {
                        scale = data.scale;
                        document.getElementById("zoomSlider").value = scale;
                    }
                    if (data.mapSettings) {
                        Object.assign(mapSettings, data.mapSettings);
                        saveMapSettings();
                        updateMapToolbarUI();
                    }

                    history = [];
                    historyIndex = -1;
                    selectedMeasures.clear();
                    saveHistory();
                    renderScore();
                    setupDeleteButtons();
                    setupInsertButtons();
                    if (activeTab === "map") renderMap();
                } catch (err) {
                    alert("JSONの読み込みに失敗しました");
                }
            };
            reader.readAsText(file);
            e.target.value = "";
        });
}

main().catch(console.error);