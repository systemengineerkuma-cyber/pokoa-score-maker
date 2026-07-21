const VF = VexFlow;

let score = null;
let scale = 1;
let notePositions = [];
// notePositionsは毎回の描画で作り直され、ホバー中のプレビューが対象を差し替えて
// 描画するとその対象の実測位置が一時的に消えてしまう（プレビューされていない他の
// 要素の実測位置を使ってスロット判定を行いたいfindMeasuredSegmentには不向き）。
// そのため、プレビューが乗っていない「素の」状態の実測位置だけを、段（measureIndex:staff）
// 単位でキャッシュしておく。renderScore()を跨いで保持し、プレビュー中の段は更新しない
let stableNotePositions = new Map();
// 小節ごとの実際の音符エリアのX範囲（scale適用済み）。クレフ・調号・拍子記号が実際に消費した幅を
// 差し引いた実測値（VexFlowのgetNoteStartX/getNoteEndX）で、renderScore()のたびに更新される。
// 固定幅（sx〜sx+measureWidth）で近似すると、調号のシャープ/フラットの数によって実際の音符エリアが
// 変わることに対応できず、ホバー/クリック位置と実際の音符配置がずれるため、xToBeatPositionはこちらを使う
let measureNoteAreaRanges = [];
let hoveredPos = null;
let hoveredMeasureForDelete = null;
let history = [];
let historyIndex = -1;
let northDirection = 0; // 0=↑, 1=→, 2=↓, 3=←

let audioCtx = null;
let masterGainNode = null; // 全音源が経由するマスター音量ノード（再生中でもリアルタイムに音量変更するため）
let volume = parseFloat(localStorage.getItem("volume")) || 0.8; // 0〜1
let playState = "stopped"; // "stopped" | "playing" | "paused"
let isLooping = false;
let playStartTime = null;
let playEndTime = 0; // audioCtx時刻での再生終了予定時刻（終了検知・ループに使用）
let noteSchedule = [];
let noteTimeMap = [];
let beatSchedule = []; // {beatIndex, startTime, endTime} 1エントリ=マップの1センサー分（16分音符単位）。上段・下段どちらの音符内容にも依存しない算術スケジュール
// {measureIndex, noteIndex, startTime, endTime} 1エントリ=1つの音符（休符含む）。テンポ変更の再開位置探しに使う。
// 上段・下段は完全に独立したリズムを持てるため、それぞれ専用の境界スケジュールを持つ
let upperNoteBoundarySchedule = [];
let lowerNoteBoundarySchedule = [];
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

// ツールバーで選択中の音価（音符追加・休符追加の両方に使う）
let selectedDuration = localStorage.getItem("selectedDuration") || "q";
// ツールバーで選択中の種類（"note"|"rest"）。どちらのアイコン列がハイライトされるかを表す
let selectedKind = localStorage.getItem("selectedKind") || "note";
// ツールバーで付点が選択中かどうか（16分音符には非対応。マップタブの16分音符単位のスロットに収まらないため）
let dottedSelected = localStorage.getItem("dottedSelected") === "true";
// Ctrlキーを押している間だけ、ツールバーのハイライトを音符⇔休符で反転表示する
let isCtrlHeldForRestPreview = false;

// タブ定義（将来タブを追加する場合はここに追記する）
const TABS = [
    { id: "score",  label: "五線譜" },
    { id: "map",    label: "マップ" },
];
let activeTab = localStorage.getItem("activeTab") || "score";
// 廃止済みタブ（例: 旧パネル楽譜タブ）がlocalStorageに残っていた場合のフォールバック
if (!TABS.some(t => t.id === activeTab)) activeTab = "score";

function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new AudioContext();
        masterGainNode = audioCtx.createGain();
        masterGainNode.gain.value = volume;
        masterGainNode.connect(audioCtx.destination);
    }
    return audioCtx;
}

// 音名⇔半音番号（C0を基準に0とする）の相互変換。オクターブ・音域を制限しない
const NATURAL_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const CHROMATIC_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// pitch（例:"F#4"）→C0を0とする絶対半音番号（不正な音名はnull）
function pitchToSemitone(pitch) {
    const match = pitch.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!match) return null;
    const letter = match[1].toUpperCase();
    const accidental = match[2];
    const octave = parseInt(match[3], 10);
    const accidentalAdjust = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
    return octave * 12 + NATURAL_SEMITONE[letter] + accidentalAdjust;
}

// 絶対半音番号→pitch文字列（常にシャープ表記、音域無制限）
function semitoneToPitch(semitone) {
    const octave = Math.floor(semitone / 12);
    const withinOctave = ((semitone % 12) + 12) % 12;
    return `${CHROMATIC_SHARP[withinOctave]}${octave}`;
}

// シャープ（黒鍵が上にある）を持つ白鍵（E, Bには上の黒鍵がない）
const HAS_BLACK_KEY = new Set(["C", "D", "F", "G", "A"]);
// フラット（黒鍵が下にある）を持つ白鍵（C, Fには下の黒鍵がない）
const HAS_FLAT_KEY = new Set(["D", "E", "G", "A", "B"]);

// 平均律の周波数計算（A4=440Hzを基準、音域無制限）
function pitchToFrequency(pitch) {
    const semitone = pitchToSemitone(pitch);
    if (semitone === null) return null;
    return 440 * Math.pow(2, (semitone - 57) / 12); // A4の絶対半音番号は57(C0基準)
}

// 音符マット画像・SE音声のキー（常にシャープ表記）に正規化する。
// フラット表記（例:"Bb4"）でも同じ物理パネルを引けるようにするため
function toCanonicalPitch(pitch) {
    const semitone = pitchToSemitone(pitch);
    return semitone === null ? pitch : semitoneToPitch(semitone);
}

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
    const buffer = SE_BUFFERS[toCanonicalPitch(pitch)];

    if (buffer) {
        // 用意されたSE音声をそのまま自然長で再生（音価による打ち切りはしない）
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = 0.8;
        source.connect(gain);
        gain.connect(masterGainNode);
        source.start(startTime);
        activeSourceNodes.push({ node: source, startTime });
        return;
    }

    // SEファイルが未用意/未ロードの間はサイン波で代用（音域は無制限）
    const freq = pitchToFrequency(pitch);
    if (!freq) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(masterGainNode);

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
    upperNoteBoundarySchedule = [];
    lowerNoteBoundarySchedule = [];
    activeSourceNodes = [];

    scheduleMeasuresFrom(0, { noteIndex: 0, time: playStartTime }, { noteIndex: 0, time: playStartTime }, 0, null);

    updatePlaybackButtons();
    trackPlayback();
}

// startMeasureIndex小節目から末尾まで、BPM入力欄の現在値でスケジュールする
// （noteSchedule/noteTimeMap/beatSchedule/upperNoteBoundarySchedule/lowerNoteBoundarySchedule/
// playEndTimeに追記・更新する）。
// upperResume/lowerResume: それぞれ{noteIndex, time}。上段・下段は完全に独立したリズムを持てるため、
// テンポ変更等での再開位置（どの音符から続きを鳴らすか・実際に鳴らし直す時刻）は段ごとに異なりうる。
// beatIndexOffset: マップ用ビート番号（センサー番号）の続き番号
// resumeMeasureStartTimeOverride: 曲中のテンポ変更で小節の途中から再開する場合、
// その小節がもともと始まった時刻（表示上の小節範囲がずれないように引き継ぐ）
function scheduleMeasuresFrom(startMeasureIndex, upperResume, lowerResume, beatIndexOffset, resumeMeasureStartTimeOverride) {
    const bpm = parseInt(document.getElementById("bpmInput").value) || 120;
    const beatDuration = 60 / bpm;
    const sixteenthDuration = beatDuration * 0.25; // マップの1センサー(16分音符)分の長さ
    const measuresPerRow = getMeasuresPerRow();
    const beatsPerMeasure = getBeatsPerMeasure();
    const measureDuration = beatsPerMeasure * beatDuration;

    // 小節単位のスケジュール（noteSchedule: 小節ハイライト用、noteTimeMap: 再生位置ライン用、
    // beatSchedule: マップのセンサー点灯用）は、上段・下段どちらの音符内容にも依存しない。
    // 小節はどちらの配列で見ても必ず同じ拍数で埋まっているため、小節の開始・終了時刻はBPMと
    // 小節番号だけで決まる純粋な算術で求められる
    let time = Math.min(upperResume.time, lowerResume.time);
    let beatIndex = beatIndexOffset;

    for (let measureIndex = startMeasureIndex; measureIndex < score.measures.length; measureIndex++) {
        const isResumeMeasure = measureIndex === startMeasureIndex;
        const measureStartTime = (isResumeMeasure && resumeMeasureStartTimeOverride != null)
            ? resumeMeasureStartTimeOverride
            : time;
        const measureEndTime = measureStartTime + measureDuration;

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

        noteSchedule.push({ measureIndex, startTime: measureStartTime, endTime: measureEndTime });
        noteTimeMap.push({
            startTime: measureStartTime,
            endTime: measureEndTime,
            startX: sx * scale,
            endX: (sx + measureWidth) * scale,
            rowIndex
        });

        // マップのセンサー(16分音符)単位での開始・終了時刻を記録。再開直後の小節は、
        // 実際に鳴らし直す時刻（time）から小節末尾までの残り分だけ生成する
        // （それより前のスロットは、reschedule側で既存のbeatScheduleがそのまま残っている）
        while (time < measureEndTime - 1e-9) {
            const slotEnd = Math.min(time + sixteenthDuration, measureEndTime);
            beatSchedule.push({ beatIndex, startTime: time, endTime: slotEnd });
            beatIndex++;
            time = slotEnd;
        }
        time = measureEndTime;
    }

    // 終了検知はtrackPlayback内でaudioCtx時刻を見て行う（setTimeoutは一時停止中もカウントが進んでしまうため使わない）
    playEndTime = time;

    // 実際の発音（playNote呼び出し）と、再開位置探しに使う音符境界スケジュールは、
    // 上段・下段それぞれ独立にその配列を歩いて生成する（リズムが異なるため、鳴らす時刻の
    // 進み方も独立している）
    function scheduleStream(notesAccessor, boundarySchedule, resume) {
        // resume.timeは「その段の小節開始時刻＋スキップした音符の拍数分」であるはず（呼び出し元で
        // 保証）なので、残りの音符を順に足していけば、再開小節の末尾でちょうど小節終了時刻に一致する。
        // そのため2小節目以降は特別な調整をせず、そのままtを引き継げばよい
        let t = resume.time;
        for (let measureIndex = startMeasureIndex; measureIndex < score.measures.length; measureIndex++) {
            const measure = score.measures[measureIndex];
            const notes = notesAccessor(measure);
            const isResumeMeasure = measureIndex === startMeasureIndex;
            const noteStartIndex = isResumeMeasure ? resume.noteIndex : 0;

            for (let noteIndex = noteStartIndex; noteIndex < notes.length; noteIndex++) {
                const note = notes[noteIndex];
                const duration = noteBeats(note) * beatDuration;
                if (!note.rest && note.pitches) {
                    note.pitches.forEach(pitch => playNote(pitch, t, duration * 0.9));
                }
                boundarySchedule.push({ measureIndex, noteIndex, startTime: t, endTime: t + duration });
                t += duration;
            }
        }
    }

    scheduleStream(m => m.upperNotes, upperNoteBoundarySchedule, upperResume);
    scheduleStream(m => m.lowerNotes, lowerNoteBoundarySchedule, lowerResume);
}

// 再生中/一時停止中にBPMや音符データ（移調など）が変更されたら、今鳴っている音符が終わった
// 直後（次の音符の頭）から新しい内容を適用する。それ以前に鳴っている音はそのまま、まだ鳴って
// いない先の音だけ止めて、現在のscore/BPMを読み直して敷き直す
function rescheduleFromCurrentPosition() {
    if (playState === "stopped" || !audioCtx) return;

    const now = audioCtx.currentTime;
    // 小節単位のスケジュール（算術のみ、上段・下段どちらの音符内容にも依存しない）で
    // 「今どの小節か」を特定する
    const currentMeasureEntry = noteSchedule.find(s => now < s.endTime);
    if (!currentMeasureEntry) return; // 既に最後の小節まで進んでいる

    const resumeMeasureIndex = currentMeasureEntry.measureIndex;
    const resumeMeasureStartTimeOverride = currentMeasureEntry.startTime;

    // 上段・下段それぞれ独立に「今鳴っている音符」を見つけ、その直後から続きを敷き直す
    // （見つからなければ、その段はこの小節をもう鳴らし終えているので小節の頭から再開する）
    function findStreamResume(boundarySchedule) {
        const current = boundarySchedule.find(n => n.measureIndex === resumeMeasureIndex && now < n.endTime);
        if (current) {
            return { time: current.endTime, noteIndex: current.noteIndex + 1 };
        }
        return { time: resumeMeasureStartTimeOverride, noteIndex: 0 };
    }

    const upperResume = findStreamResume(upperNoteBoundarySchedule);
    const lowerResume = findStreamResume(lowerNoteBoundarySchedule);
    // 上段・下段どちらか早く再開する方の時刻を、算術スケジュール（noteSchedule/noteTimeMap/
    // beatSchedule）を敷き直す起点にする
    const earliestResumeTime = Math.min(upperResume.time, lowerResume.time);

    // まだ発音していない先の音（小節削除等で無効になった分も含む）を止める。
    // 曲の終端に達している場合でもここは必ず実行し、削除済み小節の音が鳴りっぱなしにならないようにする
    activeSourceNodes = activeSourceNodes.filter(({ node, startTime }) => {
        if (startTime >= earliestResumeTime) {
            try { node.stop(); } catch (e) { /* 既に終了済みの場合は無視 */ }
            return false;
        }
        return true;
    });
    noteSchedule = noteSchedule.filter(s => s.measureIndex < resumeMeasureIndex);
    noteTimeMap = noteTimeMap.slice(0, noteSchedule.length);
    beatSchedule = beatSchedule.filter(b => b.startTime < earliestResumeTime);
    upperNoteBoundarySchedule = upperNoteBoundarySchedule.filter(n => n.measureIndex < resumeMeasureIndex);
    lowerNoteBoundarySchedule = lowerNoteBoundarySchedule.filter(n => n.measureIndex < resumeMeasureIndex);

    if (resumeMeasureIndex >= score.measures.length) {
        playEndTime = earliestResumeTime;
        return;
    }

    scheduleMeasuresFrom(resumeMeasureIndex, upperResume, lowerResume, beatSchedule.length, resumeMeasureStartTimeOverride);
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
        height: ${(score.grandStaff ? GRAND_STAFF_GAP + 120 : 120) * scale}px;
        background: rgba(74, 144, 226, 0.6);
        pointer-events: none;
        z-index: 20;
    `;
    rowDiv.appendChild(line);
}

const DURATION_ORDER = ["16", "8", "q", "h", "w"];
const durationBeats = { "w": 4, "h": 2, "q": 1, "8": 0.5, "16": 0.25 };
const COMPASS_LABELS = ["N↑", "N→", "N↓", "N←"];

// 音符・休符1つ分の拍数を返す（付点は1.5倍）
function noteBeats(note) {
    return (durationBeats[note.duration] || 0) * (note.dotted ? 1.5 : 1);
}

// ツールバーで現在選択中の音価（付点込み）1つ分の拍数を返す
function selectedNoteBeats() {
    return (durationBeats[selectedDuration] || 0) * (dottedSelected ? 1.5 : 1);
}

const STAVE_TOP_BASE = 40;
const STAVE_WIDTH_BASE = 350;
const FIRST_MEASURE_EXTRA = 60;
// 小節の最後の音符/休符が終止線（バーライン）とほぼ重なって見える問題への対処。
// VexFlowのFormatterは、与えた幅(formatWidth)ぴったりまで音符を敷き詰めようとするため、
// 最後の音符/休符がバーラインの直前（1〜2px程度）まで詰まってしまい、特に休符の場合は
// バーラインの線と重なって見えなくなることがあった。実際に渡すformatWidthを少し狭くして、
// バーラインの手前に必ず余白ができるようにする
const MEASURE_END_PADDING = 10;
// VexFlowは音符を「半音」単位ではなく「五線譜上の位置（自然音の文字1つ分）」単位で等間隔に配置する
// （全音・半音どちらの隣接でも、自然音同士なら常に同じ幅になる）。そのため、クリックY座標から
// ピッチを逆算する際は半音単位ではなくこの文字単位（diatonic step）で計算しないと、C4から離れた
// ピッチほど誤差が蓄積してずれてしまう（実測して確認済み: 実際の描画は常にDIATONIC_STEP_PXの等間隔）
const DIATONIC_STEP_PX = 5;
// C4の実際の描画Y座標（STAVE_TOP_BASE=40, scale=1のときの実測値）
const C4_Y_BASE = 130;

// グランドスタッフ（上段・下段とも ト音記号）関連の定数。
// 2段は全く同じクレフのため、下段は上段をGRAND_STAFF_GAPぶん下にずらしただけの座標系になる
const GRAND_STAFF_GAP = 75;
const STAVE_TOP_LOWER = STAVE_TOP_BASE + GRAND_STAFF_GAP;
const C4_Y_LOWER = C4_Y_BASE + GRAND_STAFF_GAP;
// この音（C5）以上は上段、未満は下段に表示する
const GRAND_STAFF_SPLIT_SEMITONE = pitchToSemitone("C5");
// C4から見たC5のdiatonic step数（C,D,E,F,G,A,Bの7音で1オクターブ）
const GRAND_STAFF_SPLIT_DIATONIC = 7;

// 自然音のレター(C〜B)をC4からのdiatonic step（1文字=1step）に変換する際のオフセット
const LETTER_DIATONIC_OFFSET = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const DIATONIC_LETTERS = ["C", "D", "E", "F", "G", "A", "B"];

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

// クリック入力で許容するピッチ範囲。音符マットの範囲（C4〜C#6）の上下1オクターブずつ
const MIN_INPUT_SEMITONE = pitchToSemitone("C3");
const MAX_INPUT_SEMITONE = pitchToSemitone("C#7");

// クリックY座標（行内ローカル、rowDiv.offsetTopを含まない）から、上段・下段どちらに近いかを判定し、
// その段でのC4基準Y座標を返す。上段・下段は全く同じクレフ（ト音記号）なので、
// 「どちらの段の範囲に近いか」だけを判定すれば、あとは既存と同じ式でピッチを計算できる
function c4YForClick(clickY) {
    if (!score.grandStaff) return C4_Y_BASE;
    const baseY = clickY / scale;
    // 上段の分割音（C5）と下段の分割音の1つ下（B4）のY座標の中間を境界にする
    // （このC5/B4はあくまで境界線の位置を決めるための目安であり、実際にどちらの段に
    // 配置されるかはピッチではなくクリックした位置そのもので決まる）
    const upperSplitY = C4_Y_BASE - GRAND_STAFF_SPLIT_DIATONIC * DIATONIC_STEP_PX;
    const lowerSplitY = C4_Y_LOWER - (GRAND_STAFF_SPLIT_DIATONIC - 1) * DIATONIC_STEP_PX;
    const boundaryY = (upperSplitY + lowerSplitY) / 2;
    return baseY < boundaryY ? C4_Y_BASE : C4_Y_LOWER;
}

// クリックY座標が上段/下段どちらの領域と判定されるか（1段譜表ならfalse固定）。
// ピッチに関わらず、ユーザーがクリックした場所そのものでどちらの段に音符を置くかを決めるために使う
function isUpperFrameForClick(clickY) {
    return !!score.grandStaff && c4YForClick(clickY) === C4_Y_BASE;
}

// クリック/ホバーが上段・下段どちらの音符列（measure.upperNotes/lowerNotes）を対象にしているかを
// 一箇所で決める。1段譜表（!score.grandStaff）のときは常に上段（唯一の段）を対象にする
function staffForClick(clickY) {
    return isUpperFrameForClick(clickY) || !score.grandStaff ? "upper" : "lower";
}

// クリックY座標から最も近い白鍵の音名を返す（音域は無制限。isBlackは現状未使用だが
// 既存の呼び出し互換のため引数として残す）
// rawDiatonicはC4を0とするdiatonic step（自然音の文字1つ分）の相対値
// （クリック位置に応じて上段/下段いずれかのC4位置を基準にする）
function yToPitch(clickY, isBlack) {
    const baseY = clickY / scale;
    const c4Y = c4YForClick(clickY);
    const rawDiatonicFromC4 = (c4Y - baseY) / DIATONIC_STEP_PX;
    const diatonicFromC4 = Math.round(rawDiatonicFromC4);

    if (Math.abs(rawDiatonicFromC4 - diatonicFromC4) > 0.5) return null; // 自然音の位置から半文字分より離れていたら該当なし

    // diatonic step数をレター・オクターブに変換（C,D,E,F,G,A,Bの7音で1オクターブ進む）
    const octaveOffset = Math.floor(diatonicFromC4 / 7);
    const letterIdx = ((diatonicFromC4 % 7) + 7) % 7;
    const letter = DIATONIC_LETTERS[letterIdx];
    const octave = 4 + octaveOffset;
    const absSemitone = pitchToSemitone(`${letter}${octave}`);

    // どちらの段に置くかはピッチではなく、クリックした場所（c4YForClickの判定）で決まる。
    // そのためここではピッチによるクランプは行わない（呼び出し側がstaffForClickで
    // upperNotes/lowerNotesどちらの配列を操作するかを別途決める）
    const naturalPitch = semitoneToPitch(absSemitone);

    // 現在の調号でそのレターが変化する場合は、デフォルトで調号通りの音にする
    // （毎回Shift+クリックで直さなくて済むように。自然音が欲しい場合はShift+クリックで戻せる）
    const match = naturalPitch.match(/^([A-G])(-?\d+)$/);
    const accidental = match ? getKeyAccidentalMap(score.keySignature || "C")[match[1]] : null;
    const result = accidental ? `${match[1]}${accidental}${match[2]}` : naturalPitch;

    // 許容範囲外のクリックは無視する（C3〜C#7）
    const resultSemitone = pitchToSemitone(result);
    if (resultSemitone < MIN_INPUT_SEMITONE || resultSemitone > MAX_INPUT_SEMITONE) return null;

    return result;
}

// score.timeSignature（例: "4/4", "3/4"）から、1小節分の拍数（4分音符換算）を返す
function getBeatsPerMeasure() {
    const [num, den] = (score.timeSignature || "4/4").split("/").map(Number);
    return num * 4 / den;
}

// 和音として同時に鳴らせるピッチ数の上限（固定11、UIでの変更は廃止済み）
function getChordMax() {
    return 11;
}

// 小節1つ分をまるごと休ませる休符（現在の拍子に合う音価）を1つ返す
// 拍数の大きい順（付点も含む）。休符で埋め直す際、なるべく少ない数の休符になるよう貪欲法で使う
const REST_FILL_DURATIONS = [
    { duration: "w", dotted: true, beats: 6 },
    { duration: "w", beats: 4 },
    { duration: "h", dotted: true, beats: 3 },
    { duration: "h", beats: 2 },
    { duration: "q", dotted: true, beats: 1.5 },
    { duration: "q", beats: 1 },
    { duration: "8", dotted: true, beats: 0.75 },
    { duration: "8", beats: 0.5 },
    { duration: "16", dotted: true, beats: 0.375 },
    { duration: "16", beats: 0.25 },
];
const BEAT_EPSILON = 1e-6;

// 指定した拍数ちょうどを、できるだけ少ない数の休符で埋める休符データの配列を返す
function beatsToRests(beats) {
    const rests = [];
    let remaining = beats;
    for (const d of REST_FILL_DURATIONS) {
        while (remaining >= d.beats - BEAT_EPSILON) {
            rests.push({ rest: true, duration: d.duration, ...(d.dotted ? { dotted: true } : {}) });
            remaining -= d.beats;
        }
    }
    return rests;
}

// 新規に作る空の小節（あらかじめ全休符を入れておく。小節は常に音符か休符で埋まっている前提）。
// 上段・下段は完全に独立した音符列なので、それぞれ個別に全休符で埋める
function makeEmptyMeasure() {
    return {
        upperNotes: beatsToRests(getBeatsPerMeasure()),
        lowerNotes: beatsToRests(getBeatsPerMeasure())
    };
}

function pitchToKey(pitch) {
    const match = pitch.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    if (!match) throw new Error(`不正な音名: ${pitch}`);
    const note = match[1].toLowerCase();
    const accidental = match[2];
    const octave = match[3];
    return { key: `${note}${accidental}/${octave}`, accidental };
}

// pitch（例:"F#4"）をshift半音分だけ移調した新しいpitch文字列を返す（常にシャープ表記、音域無制限）
function transposePitch(pitch, shift) {
    const semitone = pitchToSemitone(pitch);
    if (semitone === null) throw new Error(`不正な音名: ${pitch}`);
    return semitoneToPitch(semitone + shift);
}

// 調号（キー）をshift半音分だけ移調する。異名同音は実用上一般的な表記を採用
const KEY_SEMITONES = {
    C: 0, G: 7, D: 2, A: 9, E: 4, B: 11, "F#": 6, "C#": 1,
    F: 5, Bb: 10, Eb: 3, Ab: 8, Db: 1, Gb: 6, Cb: 11,
};
const SEMITONE_TO_KEY = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
function transposeKeySignature(key, shift) {
    const base = KEY_SEMITONES[key] ?? 0;
    const newSemitone = ((base + shift) % 12 + 12) % 12;
    return SEMITONE_TO_KEY[newSemitone];
}

// 調号ごとに変化するレターとその臨時記号（#/b）を返す（五線譜上の付加順）
const SHARP_KEY_ORDER = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7 };
const FLAT_KEY_ORDER = { F: 1, Bb: 2, Eb: 3, Ab: 4, Db: 5, Gb: 6, Cb: 7 };
const SHARP_LETTER_ORDER = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_LETTER_ORDER = ["B", "E", "A", "D", "G", "C", "F"];
function getKeyAccidentalMap(key) {
    const map = {};
    if (key in SHARP_KEY_ORDER) {
        for (let i = 0; i < SHARP_KEY_ORDER[key]; i++) map[SHARP_LETTER_ORDER[i]] = "#";
    } else if (key in FLAT_KEY_ORDER) {
        for (let i = 0; i < FLAT_KEY_ORDER[key]; i++) map[FLAT_LETTER_ORDER[i]] = "b";
    }
    return map;
}

// 曲全体をshift半音分だけ移調する（音符・調号とも）。上段・下段の両方を移調する
function transposeScore(shift) {
    score.measures.forEach(measure => {
        [measure.upperNotes, measure.lowerNotes].forEach(notes => {
            notes.forEach(note => {
                if (note.rest || !note.pitches) return;
                note.pitches = note.pitches.map(p => transposePitch(p, shift));
            });
        });
    });
    score.keySignature = transposeKeySignature(score.keySignature || "C", shift);
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

// タブ（五線譜/マップ）ごとの表示切り替え対象ツールバー。
// ここに無いツールバー（ファイル操作・再生/BPM/音量・ズーム）は両方のタブで常時表示する
const SCORE_ONLY_TOOLBAR_IDS = [
    "toolbarEditMode", "toolbarDuration", "toolbarClipboard", "toolbarKeySig", "toolbarTranspose"
];
const MAP_ONLY_TOOLBAR_IDS = ["toolbarCompass"];

function applyTabVisibility() {
    const isScore = activeTab === "score";
    const isMap   = activeTab === "map";

    // 五線譜エリア
    document.getElementById("scoreWrapper").style.display = isScore ? "" : "none";

    // パネルカウント（音符マット数・レール数・センサー数）はマップタブのみ表示
    document.getElementById("panelCount").style.display = isMap ? "flex" : "none";

    // マップエリア（リサイズハンドルも含むラッパーごと表示切替）
    const mapAreaWrapper = document.getElementById("mapAreaWrapper");
    if (mapAreaWrapper) mapAreaWrapper.style.display = isMap ? "" : "none";

    // マップ専用ツールバー
    const mapToolbar = document.getElementById("mapToolbar");
    if (mapToolbar) mapToolbar.style.display = isMap ? "flex" : "none";

    // 五線譜タブのみで使うツールバー
    SCORE_ONLY_TOOLBAR_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isScore ? "flex" : "none";
    });

    // マップタブのみで使うツールバー
    MAP_ONLY_TOOLBAR_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isMap ? "flex" : "none";
    });

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
    wrapValue: 10,               // 折り返し値（一列あたりのセンサー数。レール1マス=センサー1個のためマス数と同義）
    hideUnusedSensors: false,    // true=周りに音符マットがないセンサーを配置しない（カウントにも含めない）
};

// 段と段の間隔は固定値（ユーザー調整UIは廃止済み）。レールを中心に-3〜+3（センサーの
// 「隣接(1マス)」「遠め(2マス)」＋和音パネルがさらに1マス外側まで伸びうる分）で1セット
// （7マス幅）となる。さらにその間に区切りの空きマスを1マス挟むため、レール同士の間隔は
// 8マス必要（=空きマス7+レール1）
function getTurnLength() {
    return 7;
}

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

// 指定した段（上段/下段）の音符列を、楽譜全体で16分音符単位のビート列にフラット化する
function flattenNotesToBeats(notesAccessor) {
    const beats = [];
    score.measures.forEach((measure, measureIndex) => {
        notesAccessor(measure).forEach(note => {
            const count = Math.round(noteBeats(note) / 0.25);
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

// 楽譜の全ビートを順番に返す（16分音符単位）。実物のぽこあポケモンはトロッコ1本・レール1本のため、
// センサー列は1つしか作れない。上段・下段は完全に独立したリズムを持てるので、それぞれ独立に
// フラット化した上で、両方の音の開始タイミングを合わせて1つの列にマージする
// （同じスロットで両方が音符開始していれば、ピッチを合算した1つの和音として扱う）
function getAllBeats() {
    const upperBeats = flattenNotesToBeats(m => m.upperNotes);
    if (!score.grandStaff) return upperBeats;

    const lowerBeats = flattenNotesToBeats(m => m.lowerNotes);
    return upperBeats.map((u, i) => {
        const l = lowerBeats[i];
        const upperPitches = (u.isFirst && u.note && !u.note.rest && u.note.pitches) ? u.note.pitches : [];
        const lowerPitches = (l.isFirst && l.note && !l.note.rest && l.note.pitches) ? l.note.pitches : [];
        const pitches = [...upperPitches, ...lowerPitches];
        return {
            measureIndex: u.measureIndex,
            note: pitches.length ? { pitches, rest: false } : { rest: true },
            isFirst: true
        };
    });
}

// 中間層3枠（センサー中心を(0,0)としたローカル座標、斜め隣接は使用しない）への
// 音符マット割り当てを、進行方向ベクトル(forwardVec)・レールと反対方向ベクトル(awayVec)を
// 使って実グリッドオフセットに変換する共通処理。
// forwardVec/awayVecはどちらも{dx,dy}が-1/0/1のいずれかの単位ベクトル。
// 直線モードでは常に固定ベクトル、スネークモードでは経路上の位置ごとに変化するベクトルを渡す。
function calcPanelPositionsCore(pitches, forwardVec, awayVec) {
    // 音の優先順位（固定）: 遠い→横（レールと反対側）→近い
    const midRank = [
        {lat: 0, trav: 1, z: 0},   // 遠い
        {lat: -1, trav: 0, z: 0},  // 横（レールと反対側）
        {lat: 0, trav: -1, z: 0},  // 近い
    ];

    const positions = [];
    pitches.forEach((pitch, i) => {
        if (i >= midRank.length) return;
        const slot = midRank[i];
        const dx = slot.trav * forwardVec.dx - slot.lat * awayVec.dx;
        const dy = slot.trav * forwardVec.dy - slot.lat * awayVec.dy;
        positions.push({ relX: dx, relY: dy, z: slot.z, pitch });
    });
    return positions;
}

function updateMapToolbarUI() {
    const { railDirection, startCorner, sideFirst, wrapValue, hideUnusedSensors } = mapSettings;

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
    setActive("mapHideUnusedSensors", hideUnusedSensors);

    const wrapInput = document.getElementById("mapWrapValue");
    if (wrapInput) wrapInput.value = wrapValue;
}

// マップのグリッドデータ（レール・センサー・音符マットの配置）を計算する
// DOM描画には依存しないので、描画不要なカウント表示（レール数・センサー数）からも呼べる
function buildMapGrid() {
    const { railDirection, startCorner, sideFirst, wrapValue } = mapSettings;
    const turnLength = getTurnLength();

    // 全ビートを取得
    const beats = getAllBeats();
    const totalBeats = beats.length;

    // 折り返し単位（センサー数 or マス数。レール1マスにつきセンサー1個のため同じ値）
    const wrapSensors = wrapValue;

    // センサー配置計算
    // センサーはレール1マスにつき1個、次の4パターンを繰り返して配置する:
    // 「隣接(レールから1マス)側→隣接反対側→遠め(レールから2マス)側→遠め反対側」
    // sideFirst="left": 1個目→隣接左, 2個目→隣接右, 3個目→遠め左, 4個目→遠め右, ...
    // sideFirst="right": 1個目→隣接右, 2個目→隣接左, 3個目→遠め右, 4個目→遠め左, ...

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

    // 段と段の間の区切り用空きマスの座標（折り返し軸方向、isVerticalならX・そうでなければY）。
    // レールの1セット（±3=7マス幅）同士の間に、getTurnLength()で決まる間隔のうち
    // 実際に何も配置されない分（turnLength-6マス）だけ区切りとして扱う。
    // レンダリング側（renderMap）でこの座標に該当するマスをグリッド線無しの背景色にする
    const separatorCoords = new Set();
    const gapSize = turnLength - 6;
    if (gapSize > 0 && wrapSensors > 0) {
        const maxColIdx = Math.ceil(totalBeats / wrapSensors) - 1;
        for (let colIdx = 0; colIdx < maxColIdx; colIdx++) {
            const base = wrapSign * colIdx * (turnLength + 1);
            for (let g = 0; g < gapSize; g++) {
                separatorCoords.add(base + wrapSign * (4 + g));
            }
        }
    }

    // 表示範囲（bounding box）は、実際に配置されたセルだけでなく「未使用センサー非表示」設定に
    // 関わらず常に同じ位置を占めるセンサーのマス目も含めて計算する。そうしないと、非表示にした
    // ことで範囲の端にあったセンサーが無くなり、bounding boxが縮んで原点がズレ、レール自体の
    // 論理座標は変わっていないのに描画位置（見た目の位置）だけがズレて見えてしまう
    let extentMinX = Infinity, extentMaxX = -Infinity, extentMinY = Infinity, extentMaxY = -Infinity;
    const markExtent = (x, y) => {
        extentMinX = Math.min(extentMinX, x);
        extentMaxX = Math.max(extentMaxX, x);
        extentMinY = Math.min(extentMinY, y);
        extentMaxY = Math.max(extentMaxY, y);
    };

    // 各段（レール1本分）の理論上の最大フットプリント（レール中心から折り返し軸方向に±3）を
    // 事前にbounding boxへ含めておく。実際にどちら側のセンサー/パネルが使われるかは
    // sideFirst（隣接/遠めの左右どちらが先か）や曲の総拍数（最後の段が4マス周期の途中で
    // 終わるかどうか）によって変わるため、実際に配置されたセルだけを見てbounding boxを
    // 決めると、sideFirstを切り替えただけで範囲が微妙に変わり、レールの論理座標は同じなのに
    // 描画位置だけズレて見えるバグになる
    if (wrapSensors > 0) {
        const maxColIdxInclusive = Math.ceil(totalBeats / wrapSensors) - 1;
        for (let colIdx = 0; colIdx <= maxColIdxInclusive; colIdx++) {
            const bandWrapOffset = wrapSign * colIdx * (turnLength + 1);
            const travelEnd = travelSign * (wrapSensors - 1);
            [0, travelEnd].forEach(tp => {
                [-3, 3].forEach(lateral => {
                    const bx = isVertical ? bandWrapOffset + lateral : tp;
                    const by = isVertical ? tp : bandWrapOffset + lateral;
                    markExtent(bx, by);
                });
            });
        }
    }

    for (let beatIdx = 0; beatIdx < totalBeats; beatIdx++) {
        const beat = beats[beatIdx];

        // 4マス周期: 隣接同側→隣接反対側→遠め同側→遠め反対側
        const cyclePos = beatIdx % 4;
        const isLeftSide = sideFirst === "left"
            ? (cyclePos === 0 || cyclePos === 2)
            : (cyclePos === 1 || cyclePos === 3);
        const isFar = cyclePos === 2 || cyclePos === 3;

        // 段ごとに独立・同じ側から始まる
        const colIdx = Math.floor(beatIdx / wrapSensors);
        const rowIdx = beatIdx % wrapSensors;

        const travelPos = travelSign * rowIdx; // レール1マスにつきビート1つ
        const lateralPos = (isLeftSide ? -1 : 1) * (isFar ? 2 : 1); // レール中心線からの左右オフセット
        const wrapOffset = wrapSign * colIdx * (turnLength + 1); // 段ごとの間隔（レール同士の実際の間隔＝見た目の空きマス数+1）

        const sX = isVertical ? wrapOffset + lateralPos : travelPos;
        const sY = isVertical ? travelPos : wrapOffset + lateralPos;

        const forwardVec = isVertical ? { dx: 0, dy: travelSign } : { dx: travelSign, dy: 0 };
        const awayVec = isVertical ? { dx: lateralPos > 0 ? 1 : -1, dy: 0 } : { dx: 0, dy: lateralPos > 0 ? 1 : -1 };

        // dの並びは進行方向の符号に応じて時間順になるようにする
        const dOrder = travelSign === 1 ? [-1, 0, 1] : [1, 0, -1];
        dOrder.forEach((d, posInTriplet) => {
            const rx = isVertical ? wrapOffset : travelPos + d;
            const ry = isVertical ? travelPos + d : wrapOffset;
            setCell(rx, ry, 0, {
                type: "rail",
                direction: railDirection,
                railStep: beatIdx * 3 + posInTriplet,
            });
            markExtent(rx, ry);
        });

        // このビートに音符マットが伴うか（音符の先頭スロットのみ）
        const hasPanel = beat.isFirst && beat.note && !beat.note.rest && beat.note.pitches;

        // センサーの位置は「未使用センサー非表示」設定に関わらず常にbounding boxに含める
        markExtent(sX, sY);

        // センサーセル（中間層）。周りに音符マットがないセンサーを隠す設定の場合はスキップする
        if (!mapSettings.hideUnusedSensors || hasPanel) {
            setCell(sX, sY, 0, {
                type: "sensor",
                beatNum: beatIdx + 1,
                direction: railDirection,
            });
        }

        // 音符マットの配置
        if (hasPanel) {
            const sorted = [...beat.note.pitches].sort((a, b) => {
                // 半音値で降順ソート（高音順）
                return pitchToSemitone(b) - pitchToSemitone(a);
            });

            const panelPositions = calcPanelPositionsCore(sorted, forwardVec, awayVec);

            panelPositions.forEach(({relX, relY, z, pitch}) => {
                const px = sX + relX;
                const py = sY + relY;
                setCell(px, py, z, {
                    type: "panel",
                    pitch,
                    direction: northDirection,
                });
                markExtent(px, py);
            });
        }
    }

    const extent = extentMinX === Infinity
        ? null
        : { minX: extentMinX, maxX: extentMaxX, minY: extentMinY, maxY: extentMaxY };

    return { grid, totalBeats, extent, separatorCoords, isVertical };
}

// マップグリッドの右端・下端・角の3箇所のハンドルをドラッグして、グリッド自体のマス数
// （マス数/センサー数＝mapSettings.wrapValue）を変更できるようにする。段の間隔は
// レール中心から-3〜+3の固定幅（getTurnLength()）で決まるため調整不要。
// 実際に調整できる値はwrapValue1つだけだが、レールの向きに関わらずどの端からでも
// 直感的に操作できるよう、右端（左右ドラッグ）・下端（上下ドラッグ）・角（斜めドラッグ、
// 縦横どちらか大きく動いた方を採用）の3つのハンドルを常に用意し、どれもwrapValueを操作する。
// 一定ピクセル動かすごとに1段階、mapSettingsを更新してrenderMap()し直す（ドラッグ中は
// 実際に変化があったときだけ再描画し、細かすぎるピクセル移動では再描画しない）。
// ハンドルは#mapAreaの外（兄弟要素）に置いているため、renderMap()のinnerHTML書き換えの
// 影響を受けず、位置はrepositionMapResizeHandle()で毎回のrenderMap()後に追従させる
const MAP_RESIZE_PX_PER_STEP = 18;

// getDelta(dx, dy)で、そのハンドルが実際に使う移動量（px）を1つ返す
function attachMapResizeHandle(handleId, getDelta) {
    const handle = document.getElementById(handleId);
    if (!handle) return;

    let dragging = false;
    let startX = 0, startY = 0;
    let baseWrapValue = 0;
    let appliedDelta = 0;

    handle.addEventListener("mousedown", (e) => {
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        baseWrapValue = mapSettings.wrapValue;
        appliedDelta = 0;
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const px = getDelta(e.clientX - startX, e.clientY - startY);
        const delta = Math.round(px / MAP_RESIZE_PX_PER_STEP);
        if (delta === appliedDelta) return;
        appliedDelta = delta;
        mapSettings.wrapValue = Math.max(1, baseWrapValue + delta);
        updateMapToolbarUI();
        renderMap();
    });

    document.addEventListener("mouseup", () => {
        if (dragging) {
            dragging = false;
            saveMapSettings();
        }
    });
}

// wrapValueが見た目の幅(X)・高さ(Y)どちらに直接効くかはrailDirectionで決まる
// （進行軸=wrapValueに比例して直接伸びる／折り返し軸=段数(totalBeats/wrapValue)が
// 減ることで逆に縮む）。右ハンドルは常に「幅を伸ばす」、下ハンドルは常に
// 「高さを伸ばす」という見た目の直感に合わせるため、wrapValueが効く軸が
// ハンドルの意図する軸と逆（折り返し軸）の場合は、ドラッグ量の符号を反転させる
function setupMapResizeHandle() {
    const widthIsDirectAxis = () => mapSettings.railDirection === "horizontal";
    const heightIsDirectAxis = () => mapSettings.railDirection === "vertical";

    attachMapResizeHandle("mapResizeHandleRight", (dx) => (widthIsDirectAxis() ? dx : -dx));
    attachMapResizeHandle("mapResizeHandleBottom", (dx, dy) => (heightIsDirectAxis() ? dy : -dy));
    // 角は縦横どちらか絶対値の大きい方を採用し、その軸の符号ルールをそのまま使う
    attachMapResizeHandle("mapResizeHandleCorner", (dx, dy) => {
        if (Math.abs(dx) >= Math.abs(dy)) return widthIsDirectAxis() ? dx : -dx;
        return heightIsDirectAxis() ? dy : -dy;
    });
}

// グリッドの実際の右端・下端・角にそれぞれのハンドルを追従させる
function repositionMapResizeHandle(gridDiv) {
    const wrapper = document.getElementById("mapAreaWrapper");
    const right = document.getElementById("mapResizeHandleRight");
    const bottom = document.getElementById("mapResizeHandleBottom");
    const corner = document.getElementById("mapResizeHandleCorner");
    if (!wrapper || !gridDiv || !right || !bottom || !corner) return;
    const gridRect = gridDiv.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const gLeft = gridRect.left - wrapperRect.left;
    const gRight = gridRect.right - wrapperRect.left;
    const gTop = gridRect.top - wrapperRect.top;
    const gBottom = gridRect.bottom - wrapperRect.top;

    // 右端・下端のハンドルは、エリアのどこをドラッグしても反応するよう帯全体を当たり判定にする
    right.style.left = `${gRight - right.offsetWidth}px`;
    right.style.top = `${gTop}px`;
    right.style.height = `${gBottom - gTop}px`;

    bottom.style.left = `${gLeft}px`;
    bottom.style.top = `${gBottom - bottom.offsetHeight}px`;
    bottom.style.width = `${gRight - gLeft}px`;

    corner.style.left = `${gRight - corner.offsetWidth}px`;
    corner.style.top = `${gBottom - corner.offsetHeight}px`;
}

function renderMap() {
    const mapArea = document.getElementById("mapArea");
    if (!mapArea) return;
    mapArea.innerHTML = "";

    const cellSize = Math.round(42 * scale * 0.5);
    const imageSize = cellSize;

    const { grid, extent, separatorCoords, isVertical } = buildMapGrid();

    if (!extent) {
        mapArea.innerHTML = "<p style='color:#aaa;padding:16px;'>音符がありません</p>";
        ["mapResizeHandleRight", "mapResizeHandleBottom", "mapResizeHandleCorner"].forEach((id) => {
            const handle = document.getElementById(id);
            if (handle) handle.style.display = "none";
        });
        updateCountsBar();
        return;
    }

    // グリッドの範囲は、実際に配置されたセルではなく（「未使用センサー非表示」設定の有無で
    // 変わらない）extentを使う。これにより、この設定を切り替えてもレールの描画位置がズレない
    let { minX, maxX, minY, maxY } = extent;

    // 端のセルが枠に密着して見えないよう、表示範囲の周囲に1マス分の余白を持たせる。
    // ただし折り返し軸方向（isVerticalならX、そうでなければY）は、既にbuildMapGrid側で
    // レール中心から±3の理論上の最大フットプリントを常に含めているため、そちらに
    // さらに1マス足すと「±3に収まらない不要な余白の列/行」が生まれてしまう。
    // 進行軸方向（実際のビート数ぶんの実測範囲そのまま）にだけ余白を追加する
    if (isVertical) {
        minY -= 1; maxY += 1;
    } else {
        minX -= 1; maxX += 1;
    }

    const gridW = maxX - minX + 1;
    const gridH = maxY - minY + 1;

    // 層の概念は廃止（グリッドは1つだけ）
    const z = 0;

    // グリッド線はcontainerのgapではなく、セル1つ1つが右端・下端の罫線を自分で持つ方式にする
    // （段の区切りマスだけ罫線を消して背景になじませたいが、gap方式だと特定セルだけ線を
    // 消すことができない＝ネガティブマージンで隙間を塗りつぶす方式を試したところ見た目が
    // ボコついてしまったため、この罫線持ち回し方式に変更した）
    const gridDiv = document.createElement("div");
    gridDiv.style.cssText = `
        display: grid;
        grid-template-columns: repeat(${gridW}, ${cellSize}px);
        grid-template-rows: repeat(${gridH}, ${cellSize}px);
        background: #fff;
        border-top: 1px solid #e0e0e0;
        border-left: 1px solid #e0e0e0;
        width: fit-content;
    `;

    // 折り返し軸方向の座標が区切りマスかどうか
    const isSepCoord = (c) => separatorCoords.has(c);

    for (let gy = 0; gy < gridH; gy++) {
        for (let gx = 0; gx < gridW; gx++) {
            const ax = gx + minX;
            const ay = gy + minY;
            const key = `${ax},${ay},${z}`;
            const data = grid.get(key);

            const ownWrapCoord = isVertical ? ax : ay;
            const isSeparator = isSepCoord(ownWrapCoord);
            // 区切りマスは、折り返し軸と同じ向きの罫線（内部を細切れに見せてしまう側）だけを消す。
            // 折り返し軸と垂直な向きの罫線（区切りの手前・奥どちらの境界か）は区切りかどうかに
            // 関わらず常に描く。これにより区切り自体は内部の線が無い1本の帯として見えつつ、
            // 前後どちらの本物のコンテンツ行/列との境界線も消えずに残る
            const skipRightBorder = isVertical ? false : isSeparator;
            const skipBottomBorder = isVertical ? isSeparator : false;

            const cell = document.createElement("div");
            cell.style.cssText = isSeparator ? `
                width: ${cellSize}px;
                height: ${cellSize}px;
                background: #fff;
                border-right: ${skipRightBorder ? "none" : "1px solid #e0e0e0"};
                border-bottom: ${skipBottomBorder ? "none" : "1px solid #e0e0e0"};
                box-sizing: border-box;
            ` : `
                width: ${cellSize}px;
                height: ${cellSize}px;
                background: #fff;
                border-right: ${skipRightBorder ? "none" : "1px solid #e0e0e0"};
                border-bottom: ${skipBottomBorder ? "none" : "1px solid #e0e0e0"};
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: ${Math.max(8, cellSize * 0.25)}px;
                color: #555;
                box-sizing: border-box;
                overflow: hidden;
            `;

            if (!isSeparator && data) {
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
                    const file = PITCH_TO_FILE[toCanonicalPitch(data.pitch)];
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
    ["mapResizeHandleRight", "mapResizeHandleBottom", "mapResizeHandleCorner"].forEach((id) => {
        const handle = document.getElementById(id);
        if (handle) handle.style.display = "";
    });
    repositionMapResizeHandle(gridDiv);
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
        [measure.upperNotes, measure.lowerNotes].forEach(notes => {
            notes.forEach(note => {
                if (!note.rest && note.pitches) {
                    note.pitches.forEach(pitch => {
                        const group = PITCH_TO_GROUP[pitch];
                        if (group) countMap[group] = (countMap[group] || 0) + 1;
                    });
                }
            });
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
    const { grid } = buildMapGrid();
    let railCellCount = 0;
    let sensorCellCount = 0;
    grid.forEach(data => {
        if (data.type === "rail") railCellCount++;
        if (data.type === "sensor") sensorCellCount++;
    });

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
    addCountIcon("img/sensor.png", "センサー数", sensorCellCount);
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
    btn.style.top = `${lastRowDiv.offsetTop + (STAVE_TOP_BASE + 46 + (score.grandStaff ? GRAND_STAFF_GAP / 2 : 0)) * scale}px`;
    btn.style.width = `${28 * scale}px`;
    btn.style.height = `${28 * scale}px`;
    btn.style.fontSize = `${16 * scale}px`;
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
    updateKeySignatureUI();
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
    if (activeTab === "map") renderMap();
    rescheduleFromCurrentPosition();
}

function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    score = JSON.parse(history[historyIndex]);
    selectedMeasures.clear();
    updateKeySignatureUI();
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
    if (activeTab === "map") renderMap();
    rescheduleFromCurrentPosition();
}

function getMeasuresPerRow() {
    // #scoreWrapperはマップタブ表示中はdisplay:noneになりclientWidthが0になるため、
    // 常に表示されている#main（タブ切替では中身の表示/非表示しか変えない）の幅を基準にする。
    // これを使わないと、マップタブで再生開始した場合に1行1小節と誤って計算され、
    // noteTimeMapのrowIndexが実際の行数と食い違い、五線譜タブに戻したときに再生位置の
    // 縦線が描画されなくなるバグになる
    const wrapper = document.getElementById("main");
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

// 【旧JSON形式の移行専用】あるピッチが上段（グランドスタッフの上側、C5以上）に属するかどうか。
// 現在のライブ編集・描画では段はデータ構造（upperNotes/lowerNotes）で決まるため使われず、
// migrateMeasuresToStaffArraysが旧形式のupperPitches欠損時のフォールバックとしてのみ使う
function isUpperStaffPitch(pitch) {
    return pitchToSemitone(pitch) >= GRAND_STAFF_SPLIT_SEMITONE;
}

// 【旧JSON形式の移行専用】旧形式のnote.upperPitches（無ければピッチの高さ）から、
// そのピッチが上段に属していたかどうかを判定する。migrateMeasuresToStaffArrays専用
function pitchBelongsToUpperStaff(pitch, note) {
    if (note.upperPitches) return note.upperPitches.includes(pitch);
    return isUpperStaffPitch(pitch);
}

// 旧JSON形式（小節ごとにmeasure.notesという単一の音符列を持ち、和音の各ピッチが
// upperPitchesで段を判定していた形式）から、現在の形式（measure.upperNotes/lowerNotesという
// 完全に独立した2つの音符列）へ変換する。既に新形式（upperNotes/lowerNotesを持つ）小節は
// そのまま返す。beatsPerMeasureは変換時点のscore.timeSignatureに基づく1小節分の拍数
function migrateMeasuresToStaffArrays(measures, wasGrandStaff, beatsPerMeasure) {
    return measures.map(measure => {
        if (measure.upperNotes || measure.lowerNotes) return measure; // 既に新形式

        if (!wasGrandStaff) {
            // 旧・単一譜表：全音符をそのまま上段へ、下段は同じ拍数分の休符で埋める
            return {
                upperNotes: measure.notes,
                lowerNotes: beatsToRests(beatsPerMeasure)
            };
        }

        // 旧・グランドスタッフ：upperPitches（無ければピッチの高さ）で1音ずつ上段/下段に振り分け、
        // 同じ位置・同じ音価のまま2つの音符列にする（どちらかにピッチが無ければ同じ音価の休符にする）
        const upperNotes = [];
        const lowerNotes = [];
        measure.notes.forEach(note => {
            if (note.rest) {
                upperNotes.push({ ...note });
                lowerNotes.push({ ...note });
                return;
            }
            const upperPitches = note.pitches.filter(p => pitchBelongsToUpperStaff(p, note));
            const lowerPitches = note.pitches.filter(p => !pitchBelongsToUpperStaff(p, note));
            const base = { duration: note.duration, ...(note.dotted ? { dotted: true } : {}) };
            upperNotes.push(upperPitches.length ? { ...base, pitches: upperPitches } : { ...base, rest: true });
            lowerNotes.push(lowerPitches.length ? { ...base, pitches: lowerPitches } : { ...base, rest: true });
        });
        return { upperNotes, lowerNotes };
    });
}

// 1段分（グランドスタッフの上段/下段、または1段譜表の唯一の段）のStaveNote配列を構築する。
// renderNoteData/origIndexMapはその段専用の音符列（プレビュー込み）。上段・下段は完全に独立した
// 配列なので、以前あった「ピッチがこの段に属するかのフィルタリング」「この段に何も無ければ休符で埋める」
// 処理は不要（配列に入っている音符/休符がそのままこの段の内容になる）。
// 戻り値: { notes, meta }。meta[i]はnotes[i]に対応するクリック判定用の情報
//   { realNoteIndex, isRest, dataPitchIndices }
//   dataPitchIndicesは実データ(notesArray[realNoteIndex].pitches)内でのインデックスの配列
//  （和音追加プレビューで混ぜたピッチの位置はnullになる）
function buildStaffNotes(measureIndex, preview, renderNoteData, origIndexMap, hoveredPos, staff) {
    const previewColor = "rgba(74, 144, 226, 0.45)";
    const hoverColor = "rgba(220, 50, 50, 0.7)";
    const unsupportedColor = "#e08000";

    const notes = [];
    const meta = [];

    renderNoteData.forEach((note, renderIdx) => {
        const realNoteIndex = origIndexMap[renderIdx];
        const isHovered = realNoteIndex !== null && hoveredPos &&
            hoveredPos.measureIndex === measureIndex &&
            hoveredPos.staff === staff &&
            hoveredPos.hitNoteIndex === realNoteIndex &&
            hoveredPos.directHit === true;

        if (note.rest) {
            const restNote = new VF.StaveNote({
                keys: ["b/4"],
                duration: note.duration + "r",
                ...(note.dotted ? { dots: 1 } : {})
            });
            if (note.dotted) {
                VF.Dot.buildAndAttach([restNote], { all: true });
            }
            if (note.__preview) {
                restNote.setStyle({ fillStyle: previewColor, strokeStyle: previewColor });
            } else if (isHovered) {
                restNote.setStyle({ fillStyle: hoverColor, strokeStyle: hoverColor });
            }
            notes.push(restNote);
            meta.push({ realNoteIndex, isRest: true, dataPitchIndices: [] });
            return;
        }

        // 和音追加プレビュー：既存の和音にプレビュー用のピッチを一時的に混ぜて描画する
        let pitches = note.pitches;
        let previewPitchIndex = -1;
        if (preview && preview.type === "chordAdd" && realNoteIndex === preview.existingNoteIndex) {
            pitches = [...note.pitches, preview.pitch].sort((a, b) => pitchToSemitone(a) - pitchToSemitone(b));
            previewPitchIndex = pitches.indexOf(preview.pitch);
        }

        const keys = pitches.map(p => pitchToKey(p).key);
        const staveNote = new VF.StaveNote({
            keys,
            duration: note.duration,
            auto_stem: true,
            ...(note.dotted ? { dots: 1 } : {})
        });
        if (note.dotted) {
            VF.Dot.buildAndAttach([staveNote], { all: true });
        }

        if (note.__preview) {
            staveNote.setStyle({ fillStyle: previewColor, strokeStyle: previewColor });
            staveNote.setStemStyle({ fillStyle: "rgba(0,0,0,0)", strokeStyle: "rgba(0,0,0,0)" });
            staveNote.setFlagStyle({ fillStyle: "rgba(0,0,0,0)", strokeStyle: "rgba(0,0,0,0)" });
        } else {
            pitches.forEach((p, i) => {
                if (i === previewPitchIndex) {
                    staveNote.setKeyStyle(i, { fillStyle: previewColor, strokeStyle: previewColor });
                } else if (!PITCH_TO_FILE[toCanonicalPitch(p)]) {
                    staveNote.setKeyStyle(i, { fillStyle: unsupportedColor, strokeStyle: unsupportedColor });
                }
            });
            if (isHovered) {
                staveNote.setStyle({ fillStyle: hoverColor, strokeStyle: hoverColor });
            }
        }

        // dataPitchIndices: 実データ(note.pitches)内でのインデックス（プレビューで混ぜたピッチはnull）
        const dataPitchIndices = pitches.map((p, i) => i === previewPitchIndex ? null : note.pitches.indexOf(p));

        notes.push(staveNote);
        meta.push({ realNoteIndex, isRest: false, dataPitchIndices });
    });

    return { notes, meta };
}

// buildStaffNotesの結果（1段分）について、notePositions（クリック判定用）を記録する。
// staffは"upper"|"lower"のタグで、編集操作がどちらの配列を書き換えるべきか判定するのに使う
function recordNotePositionsForStaff(notesArray, measureIndex, rowIndex, rowDiv, staffResult, centerShiftPx, staff) {
    staffResult.notes.forEach((staveNote, renderIdx) => {
        const m = staffResult.meta[renderIdx];
        if (m.realNoteIndex === null) return; // プレビュー用のダミーはクリック判定に含めない
        const noteIndex = m.realNoteIndex;
        const noteData = notesArray[noteIndex];
        const bb = staveNote.getBoundingBox();
        const nx = staveNote.getAbsoluteX() * scale + centerShiftPx;
        const nxLeft = bb ? (bb.getX() * scale + centerShiftPx) : nx - 6 * scale;
        const nxRight = bb ? ((bb.getX() + bb.getW()) * scale + centerShiftPx) : nx + 6 * scale;
        const svgOffsetTop = rowDiv.offsetTop;

        if (m.isRest) {
            const ny = staveNote.getYs()[0] * scale + svgOffsetTop;
            notePositions.push({
                x: nx, xLeft: nxLeft, xRight: nxRight, y: ny,
                pitch: null, rest: true, measureIndex, noteIndex, pitchIndex: 0, rowIndex, staff
            });
            return;
        }

        const bbX = bb ? bb.getX() * scale : nx;
        const bbW = bb ? bb.getW() * scale : 12 * scale;
        const dataIndices = m.dataPitchIndices;
        const lastLocalIdx = dataIndices.length - 1;

        dataIndices.forEach((dataIndex, localIdx) => {
            if (dataIndex === null) return; // プレビュー用のピッチは記録しない
            const ny = staveNote.getYs()[localIdx] * scale + svgOffsetTop;
            const nh = staveNote.noteHeads && staveNote.noteHeads[localIdx];
            const nhBB = nh ? nh.getBoundingBox() : null;
            const nhLeft = nhBB ? nhBB.getX() * scale : bbX;
            const nhRight = nhBB ? (nhBB.getX() + nhBB.getW()) * scale : bbX + bbW;
            notePositions.push({
                x: nx,
                xLeft: localIdx === 0 ? bbX : nhLeft,
                xRight: localIdx === lastLocalIdx ? (bbX + bbW) : nhRight,
                y: ny,
                pitch: noteData.pitches[dataIndex],
                measureIndex,
                noteIndex,
                pitchIndex: dataIndex,
                rowIndex,
                staff
            });
        });
    });
}

// 小節の中身が休符1つだけ（例: 全休符）の場合、そのまま描画すると音符エリアの先頭に
// 寄って見えるため、音符エリアの中央に来るよう見た目上シフトする。
// （StaveNoteのgetBoundingBox/getAbsoluteXはdraw前・setXShiftとの組み合わせでは信頼できないため、
// 実際に描画されたDOM要素の位置を測ってからtransformで補正する）。戻り値は適用したシフト量（raw単位）
function centerSoleRestOnStave(context, stave, note) {
    try {
        const bb = note.getBoundingBox();
        if (!bb) return 0;
        const noteAreaCenterX = (stave.getNoteStartX() + stave.getNoteEndX()) / 2;
        const currentCenterX = bb.getX() + bb.getW() / 2;
        const shift = noteAreaCenterX - currentCenterX;
        const groups = context.svg.querySelectorAll("g.vf-stavenote");
        const targetGroup = groups[groups.length - 1];
        if (targetGroup) {
            targetGroup.setAttribute("transform", `translate(${shift}, 0)`);
        }
        return shift;
    } catch (e) {
        return 0;
    }
}

// 上書きプレビュー：「元々あったもの」または「新しく置かれるもの」のうち、
// 通常の描画には出てこない側を、対象グループの中央に半透明で重ね描きする
function drawOverlayGhost(context, stave, notesArray, overlayGhost, color) {
    try {
        let ghostCenterX;
        if (overlayGhost.forceCenterX !== undefined) {
            // ゴーストが表す休符が小節全体を1つで占める場合、実際に置かれる音符の位置を
            // 追わず、休符自身の中央寄せ位置（音符エリア中央）に独立して表示する
            ghostCenterX = overlayGhost.forceCenterX;
        } else {
            const groupNotes = notesArray.slice(overlayGhost.groupStart, overlayGhost.groupStart + overlayGhost.groupLength);
            let ghostMinX = Infinity, ghostMaxX = -Infinity;
            groupNotes.forEach(sn => {
                const bb = sn.getBoundingBox();
                if (bb) {
                    ghostMinX = Math.min(ghostMinX, bb.getX());
                    ghostMaxX = Math.max(ghostMaxX, bb.getX() + bb.getW());
                }
            });
            if (ghostMinX >= ghostMaxX) return;
            ghostCenterX = (ghostMinX + ghostMaxX) / 2;
        }
        const ghostNote = new VF.StaveNote({
            keys: ["b/4"],
            duration: overlayGhost.duration + "r",
            ...(overlayGhost.dotted ? { dots: 1 } : {})
        });
        if (overlayGhost.dotted) {
            VF.Dot.buildAndAttach([ghostNote], { all: true });
        }
        const ghostVoice = new VF.Voice({ num_beats: 1, beat_value: 4 });
        ghostVoice.setStrict(false);
        ghostVoice.addTickables([ghostNote]);
        new VF.Formatter().joinVoices([ghostVoice]).format([ghostVoice], 0);
        ghostNote.setContext(context).setStave(stave);
        ghostNote.setXShift(ghostCenterX - ghostNote.getAbsoluteX());
        // note.setStyle()だけでは単独描画（voice.draw()を経由しない）時にSVGへ反映されないため、
        // contextのfill/strokeを直接指定してから描画する
        context.save();
        context.setFillStyle(color);
        context.setStrokeStyle(color);
        ghostNote.draw();
        context.restore();
    } catch (e) {
        // オーバーレイの描画失敗は無視する（本体の描画には影響させない）
    }
}

function renderScore() {
    const scrollY = window.scrollY;
    notePositions = [];
    measureNoteAreaRanges = [];

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
        const rowBottom = score.grandStaff ? STAVE_TOP_LOWER + 150 : STAVE_TOP_BASE + 150;
        renderer.resize(rowWidth, rowBottom * scale);
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
            const upperStave = new VF.Stave(sx, STAVE_TOP_BASE, measureWidth);
            const lowerStave = score.grandStaff ? new VF.Stave(sx, STAVE_TOP_LOWER, measureWidth) : null;

            if (isFirstMeasure) {
                upperStave.addClef("treble");
                upperStave.addKeySignature(score.keySignature || "C");
                upperStave.addTimeSignature(score.timeSignature);
                if (lowerStave) {
                    lowerStave.addClef("treble");
                    lowerStave.addKeySignature(score.keySignature || "C");
                    lowerStave.addTimeSignature(score.timeSignature);
                }
            }

            if (measureIndex === score.measures.length - 1) {
                upperStave.setEndBarType(VF.Barline.type.END);
                if (lowerStave) lowerStave.setEndBarType(VF.Barline.type.END);
            }

            upperStave.setContext(context).draw();
            if (lowerStave) lowerStave.setContext(context).draw();

            // クレフ・調号・拍子記号が実際に消費した幅を差し引いた、実際の音符エリアのX範囲を記録する
            // （調号のシャープ/フラットの数によって変わるため、固定幅の近似ではホバー/クリック位置がずれる）
            measureNoteAreaRanges[measureIndex] = {
                rowIndex,
                left: upperStave.getNoteStartX() * scale,
                right: upperStave.getNoteEndX() * scale
            };

            if (lowerStave && indexInRow === 0) {
                // 行の先頭小節でだけ、上段・下段を連結する中括弧と縦線を描く
                new VF.StaveConnector(upperStave, lowerStave)
                    .setType(VF.StaveConnector.type.BRACE)
                    .setContext(context)
                    .draw();
                new VF.StaveConnector(upperStave, lowerStave)
                    .setType(VF.StaveConnector.type.SINGLE_LEFT)
                    .setContext(context)
                    .draw();
            }

            context.save();
            context.setFont("Arial", 11);
            context.setFillStyle("#aaa");
            context.fillText(
                `${measureIndex + 1}`,
                sx + 4,
                STAVE_TOP_BASE - 5
            );
            context.restore();

            if (measure.upperNotes.length === 0) {
                return;
            }

            const previewColor = "rgba(74, 144, 226, 0.45)";
            const [tsNum, tsDen] = score.timeSignature.split("/").map(Number);

            // 1段分（上段または下段）の、ホバープレビュー計算・プレビューダミーの差し込み・
            // StaveNote構築・ダミー休符埋め・Voice構築をまとめて行う。上段・下段は完全に独立した
            // 音符列なので、リズム（音価の並び）が異なっていてもそれぞれ独立に処理できる
            function prepareStaff(notesArray, staff) {
                const preview = computeHoverPreview(measureIndex, notesArray, staff);

                const renderNoteData = [...notesArray];
                const origIndexMap = renderNoteData.map((_, i) => i);
                // 上書きプレビュー時、「元々あったもの」と「新しく置かれるもの」の
                // どちらか一方は通常のレンダリングでは表示されなくなるため、そちらを半透明の
                // 追加オーバーレイとして後から重ね描きする（overlayGhostに情報を残す）
                let overlayGhost = null;
                if (preview && (preview.type === "splitNote" || preview.type === "splitRest")) {
                    const leading = beatsToRests(preview.leadingBeats);
                    const trailing = beatsToRests(preview.trailingBeats);
                    const center = preview.type === "splitRest"
                        ? { rest: true, duration: selectedDuration, ...(dottedSelected ? { dotted: true } : {}), __preview: true }
                        : { pitches: [preview.pitch], duration: selectedDuration, ...(dottedSelected ? { dotted: true } : {}), __preview: true };
                    const replacement = [...leading, center, ...trailing];
                    const original = notesArray[preview.targetIndex];
                    // 新しい配置（分割後）は通常通り描画されるので、元の休符（分割前）をグループの中央に重ね描きする
                    overlayGhost = {
                        style: "before",
                        duration: original.duration,
                        dotted: !!original.dotted,
                        groupStart: preview.targetIndex,
                        groupLength: replacement.length
                    };
                    renderNoteData.splice(preview.targetIndex, 1, ...replacement);
                    origIndexMap.splice(preview.targetIndex, 1, ...replacement.map(() => null));
                } else if (preview && preview.type === "overwriteWithRest") {
                    // 休符モードで既存音符の上にホバー：音符データ自体は変更せず通常通り描画し、
                    // 上書き後（休符）のプレビューを同じ位置に重ね描きする
                    overlayGhost = {
                        style: "after",
                        duration: preview.duration,
                        dotted: preview.dotted,
                        groupStart: preview.existingNoteIndex,
                        groupLength: 1
                    };
                }

                const result = buildStaffNotes(measureIndex, preview, renderNoteData, origIndexMap, hoveredPos, staff);

                const totalBeats = renderNoteData.reduce((sum, n) => sum + noteBeats(n), 0);
                const remainingBeats = getBeatsPerMeasure() - totalBeats;
                const dummies = makeDummyNotes(Math.max(0, remainingBeats));
                const allNotes = [...result.notes, ...dummies];

                const voice = new VF.Voice({ num_beats: tsNum, beat_value: tsDen });
                voice.setStrict(false);
                voice.addTickables(allNotes);

                // 小節の中身が休符1つだけ（例: 全休符）の場合、そのまま描画すると音符エリアの先頭に
                // 寄って見えるため、後で音符エリアの中央に来るよう見た目上シフトする（上段・下段で独立に判定）。
                // 音符は（プレビュー中の音符も含め）左寄りのままでよい（休符だけが中央寄せの対象）
                const soloRestCase = renderNoteData.length === 1 && renderNoteData[0].rest;

                // オーバーレイゴーストが休符を表しており、かつそのゴーストが小節全体を1つで
                // 占める（＝もし実際に休符のままだったらsoloRestCase扱いになる）場合、
                // ゴーストは実際に置かれる音符の位置を追わず、休符と同じ「音符エリア中央」に
                // 独立して表示する（音符は左寄り・休符は中央寄り、という見た目の使い分けのため）
                if (overlayGhost) {
                    const wouldBeSoloRest = overlayGhost.groupStart === 0 && overlayGhost.groupLength === renderNoteData.length;
                    if (wouldBeSoloRest) {
                        const stave = staff === "upper" ? upperStave : lowerStave;
                        overlayGhost.forceCenterX = (stave.getNoteStartX() + stave.getNoteEndX()) / 2;
                    }
                }

                return { result, voice, overlayGhost, soloRestCase, preview };
            }

            const upperPrep = prepareStaff(measure.upperNotes, "upper");
            const lowerPrep = score.grandStaff ? prepareStaff(measure.lowerNotes, "lower") : null;

            // 調号に基づき、必要な音符にのみ♯/♭/ナチュラルを自動付与する（段ごと・小節ごとにリセット）
            VF.Accidental.applyAccidentals([upperPrep.voice], score.keySignature || "C");
            if (lowerPrep) VF.Accidental.applyAccidentals([lowerPrep.voice], score.keySignature || "C");

            // クレフ・調号・拍子記号が実際に消費した幅を差し引いた、音符が使える実際の幅を使う
            // （固定オフセットだと調号の♯/♭の数によって幅が変わることに対応できないため）。
            // 最後の音符/休符がバーラインと重ならないよう、少し余白を残す
            const formatWidth = upperStave.getNoteEndX() - upperStave.getNoteStartX() - MEASURE_END_PADDING;

            const formatter = new VF.Formatter();
            formatter.joinVoices([upperPrep.voice]);
            if (lowerPrep) {
                formatter.joinVoices([lowerPrep.voice]);
                formatter.format([upperPrep.voice, lowerPrep.voice], formatWidth);
            } else {
                formatter.format([upperPrep.voice], formatWidth);
            }

            const upperBeams = VF.Beam.generateBeams(
                upperPrep.result.notes.filter((_, i) => !upperPrep.result.meta[i].isRest)
            );
            const lowerBeams = lowerPrep
                ? VF.Beam.generateBeams(lowerPrep.result.notes.filter((_, i) => !lowerPrep.result.meta[i].isRest))
                : [];

            [...upperBeams, ...lowerBeams].forEach(beam => {
                beam.getNotes().forEach(note => {
                    note.setFlagStyle({
                        fillStyle: "transparent",
                        strokeStyle: "transparent"
                    });
                });
            });

            upperPrep.voice.draw(context, upperStave);

            // （StaveNoteのgetBoundingBox/getAbsoluteXはdraw前・setXShiftとの組み合わせでは信頼できないため、
            // 実際に描画されたDOM要素の位置を測ってからtransformで補正する）
            let upperCenterShift = 0;
            if (upperPrep.soloRestCase) {
                upperCenterShift = centerSoleRestOnStave(context, upperStave, upperPrep.result.notes[0]);
            }

            let lowerCenterShift = 0;
            if (lowerPrep) {
                lowerPrep.voice.draw(context, lowerStave);
                if (lowerPrep.soloRestCase) {
                    lowerCenterShift = centerSoleRestOnStave(context, lowerStave, lowerPrep.result.notes[0]);
                }
            }

            upperBeams.forEach(beam => beam.setContext(context).draw());
            lowerBeams.forEach(beam => beam.setContext(context).draw());

            // 上書きプレビュー：「元々あったもの」または「新しく置かれるもの」のうち、
            // 通常の描画には出てこない側を、対象グループの中央に半透明で重ね描きする
            if (upperPrep.overlayGhost) {
                const ghostColor = upperPrep.overlayGhost.style === "before" ? "rgba(120, 120, 120, 0.5)" : previewColor;
                drawOverlayGhost(context, upperStave, upperPrep.result.notes, upperPrep.overlayGhost, ghostColor);
            }
            if (lowerPrep && lowerPrep.overlayGhost) {
                const ghostColor = lowerPrep.overlayGhost.style === "before" ? "rgba(120, 120, 120, 0.5)" : previewColor;
                drawOverlayGhost(context, lowerStave, lowerPrep.result.notes, lowerPrep.overlayGhost, ghostColor);
            }

            recordNotePositionsForStaff(measure.upperNotes, measureIndex, rowIndex, rowDiv, upperPrep.result, upperCenterShift * scale, "upper");
            if (lowerPrep) {
                recordNotePositionsForStaff(measure.lowerNotes, measureIndex, rowIndex, rowDiv, lowerPrep.result, lowerCenterShift * scale, "lower");
            }

            // プレビューが乗っていない（休符/音符が差し替えられていない）段だけ、
            // stableNotePositionsのキャッシュを最新の実測値で更新する
            if (!upperPrep.preview) {
                stableNotePositions.set(`${measureIndex}:upper`, notePositions.filter(p => p.measureIndex === measureIndex && p.staff === "upper"));
            }
            if (lowerPrep && !lowerPrep.preview) {
                stableNotePositions.set(`${measureIndex}:lower`, notePositions.filter(p => p.measureIndex === measureIndex && p.staff === "lower"));
            }
        });
    });

    updateCountsBar();
    updateAddButton();
    setupSVGEvents();
    drawSelectionRect();
    window.scrollTo(0, scrollY);

    // 再生中/一時停止中にタブ切り替えなどでスコアが再構築された場合、
    // 現在位置のハイライト（枠線）を再適用する（マップ側のrenderMap()と同じパターン）
    if (playState !== "stopped" && currentHighlightMeasure >= 0) {
        highlightMeasure(currentHighlightMeasure);
    }
}

// 選択中（確定 + ドラッグ中の暫定）の小節にDIVオーバーレイでハイライトを重ねる
// renderScore() を呼ばずに高速更新できるようにするための仕組み
function drawSelectionRect() {
    document.querySelectorAll(".selectionHighlight").forEach(el => el.remove());

    const scoreElement = document.getElementById("score");
    const rowDivs = scoreElement.querySelectorAll("div[data-row-index]");
    if (!rowDivs.length || !score.measures.length) return;

    let previewSet = null;
    if (editMode === "select" && dragState && dragState.isDragging) {
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
        const height = (score.grandStaff ? GRAND_STAFF_GAP + 130 : 130) * scale;

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
        const topPos = rowOffsetTop + ((score.grandStaff ? STAVE_TOP_LOWER : STAVE_TOP_BASE) + 110) * scale;

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
        const topPos = rowOffsetTop + ((score.grandStaff ? STAVE_TOP_LOWER : STAVE_TOP_BASE) + 110) * scale;

        btn.style.left = `${leftPos}px`;
        btn.style.top = `${topPos}px`;
        btn.style.display = "flex";
        btn.style.width = `${28 * scale}px`;
        btn.style.height = `${28 * scale}px`;
        btn.style.fontSize = `${16 * scale}px`;

        btn.addEventListener("click", () => {
            score.measures.splice(measureIndex, 0, makeEmptyMeasure());
            selectedMeasures.clear();
            saveHistory();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
            if (activeTab === "map") renderMap();
            rescheduleFromCurrentPosition();
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
    // Y方向の許容量はDIATONIC_STEP_PX（隣接する自然音同士の間隔）の半分にする。
    // これより広いと、隣り合う段（五線譜上の位置）の音符同士で判定範囲が重なってしまい、
    // クリックしたつもりの音符と別の音符を誤って拾ってしまうことがあった
    // X方向には1pxの余白を持たせる（実際のマウスイベントのclientX/Yは整数にまるめられるため、
    // xLeftがちょうど小数点以下を持つ場合に、見た目上は音符のど真ん中をクリックしていても
    // 丸め誤差でxLeftをわずかに下回り判定から漏れることがあった）。
    // xLeft/xRightは既にscale適用後（画面ピクセル）の値で、丸め誤差も画面ピクセル単位で
    // 発生するため、この余白にはscaleを掛けない（zoom率が低いとscaleを掛けた分だけ
    // 余白が縮んでしまい、丸め誤差を吸収しきれなくなる）
    const EDGE_TOLERANCE_PX = 1;
    const hit = notePositions.find(pos =>
        pos.measureIndex === measureIndex &&
        clickX >= pos.xLeft - EDGE_TOLERANCE_PX &&
        clickX < pos.xRight + EDGE_TOLERANCE_PX &&
        Math.abs(pos.y - clickY) <= (DIATONIC_STEP_PX / 2) * scale * looseness
    );
    return hit || null;
}

// 小節内のX座標（clickX）が、拍数換算でどの位置（拍単位）にあたるかを返す。
// 小節は常に音符/休符で埋まっている前提なので、実際の音符エリアの表示幅を拍数で比例配分して近似する。
// measureNoteAreaRanges（renderScore()内で実測したクレフ・調号・拍子記号を除いた実際の音符エリア）を
// 優先して使う。未描画などで値が無い場合のみ、小節全体の箱（クレフ等を含む）で近似するgetMeasureXRangeにフォールバックする
function xToBeatPosition(measureIndex, clickX) {
    const { left, right } = measureNoteAreaRanges[measureIndex] || getMeasureXRange(measureIndex);
    const totalBeats = getBeatsPerMeasure();
    if (right <= left || totalBeats <= 0) return null;
    return (clickX - left) / (right - left) * totalBeats;
}

// clickXが指定した音符列（上段/下段どちらかの独立した配列）のどのインデックスにあたるかを、
// 拍位置から探す。見つかった場合 { index, segStart, segBeats } を返す（segStartはその要素の開始拍位置）
function findSegmentAtBeatPosition(notesArray, beatPos) {
    if (beatPos === null) return null;
    let cursor = 0;
    for (let i = 0; i < notesArray.length; i++) {
        const segBeats = noteBeats(notesArray[i]);
        const segStart = cursor;
        const segEnd = cursor + segBeats;
        cursor = segEnd;
        if (beatPos >= segStart - BEAT_EPSILON && beatPos < segEnd - BEAT_EPSILON) {
            return { index: i, segStart, segBeats };
        }
    }
    return null;
}

// clickXが前回の「素の」描画時の実測位置（stableNotePositions）上でどの要素（noteIndex）の
// 担当範囲にあたるかを、要素同士の実際のアンカー位置（VexFlowが割り当てたtick位置）を
// 境界にして探す。休符の描画グリフ自体は非常に細いことが多く、その次の要素が始まるまでの
// 空白もその休符の担当範囲として扱わないと（グリフ自身のbboxだけで判定すると）、休符の
// 右側の空白をクリックしたときに対象が見つからなくなってしまう。
// notePositions（毎回の描画で作り直される）ではなくstableNotePositionsを使うのは、
// プレビュー中はその対象自身の実測位置が一時的に消えてしまい、次のホバー判定の材料に
// できなくなるため（プレビューが乗っていない、素の状態のスナップショットだけを使う）
function findMeasuredSegment(measureIndex, staff, clickX) {
    const seen = new Set();
    const entries = [];
    const cached = stableNotePositions.get(`${measureIndex}:${staff}`) || [];
    cached.forEach(pos => {
        if (seen.has(pos.noteIndex)) return;
        seen.add(pos.noteIndex);
        entries.push({ noteIndex: pos.noteIndex, x: pos.x });
    });
    const range = measureNoteAreaRanges[measureIndex];
    if (entries.length === 0 || !range) return null;
    entries.sort((a, b) => a.noteIndex - b.noteIndex);
    for (let i = 0; i < entries.length; i++) {
        const segLeft = i === 0 ? range.left : entries[i].x;
        const segRight = i === entries.length - 1 ? range.right : entries[i + 1].x;
        if (clickX >= segLeft && clickX < segRight) {
            return { noteIndex: entries[i].noteIndex, xLeft: segLeft, xRight: segRight };
        }
    }
    return null;
}

// clickXがnotesArray内のどの要素（インデックス）の、どの拍位置にあたるかを求める。
// 実測位置（findMeasuredSegment）が使える場合はそちらを優先し（音価混在時の精度のため）、
// 無ければ拍数按分の近似（xToBeatPosition/findSegmentAtBeatPosition）にフォールバックする。
// ホバープレビュー（computeHoverPreview）と実クリック（handleNoteEdit）で全く同じ結果に
// なるよう、判定ロジックをこの1箇所に共通化している
function resolveSegmentAndBeatPos(measureIndex, notesArray, staff, clickX) {
    const measured = findMeasuredSegment(measureIndex, staff, clickX);
    if (measured && measured.noteIndex < notesArray.length && measured.xRight > measured.xLeft) {
        let cursor = 0;
        for (let i = 0; i < measured.noteIndex; i++) cursor += noteBeats(notesArray[i]);
        const segBeats = noteBeats(notesArray[measured.noteIndex]);
        const frac = Math.max(0, Math.min(1, (clickX - measured.xLeft) / (measured.xRight - measured.xLeft)));
        return { segment: { index: measured.noteIndex, segStart: cursor, segBeats }, beatPos: cursor + frac * segBeats };
    }
    const beatPos = xToBeatPosition(measureIndex, clickX);
    return { segment: findSegmentAtBeatPosition(notesArray, beatPos), beatPos };
}

// 休符（1つ分）を、選択中の音価のスロット単位で分割する位置を計算する。
// wantedBeats単位でスロット数を割り出し、hoverの拍位置に一番近いスロットへ吸い付ける
function computeSplitForSegment(segStart, segBeats, hoverBeatPos, wantedBeats) {
    const nSlots = Math.floor(segBeats / wantedBeats + BEAT_EPSILON);
    if (nSlots < 1) return null;
    let slotIndex = Math.floor((hoverBeatPos - segStart) / wantedBeats);
    slotIndex = Math.max(0, Math.min(nSlots - 1, slotIndex));
    const leadingBeats = slotIndex * wantedBeats;
    const trailingBeats = segBeats - leadingBeats - wantedBeats;
    return { leadingBeats, trailingBeats };
}

// 休符を選択中の音価のスロット単位で分割する際、スロット候補が複数ある場合は、それぞれを
// 実際にVexFlowで仮フォーマットしてみて、結果の音符の位置（getAbsoluteX）がclickXに
// 一番近い候補を選ぶ。VexFlowは休符→音符のように内容が変わると必要な幅も変わり、拍数に
// 単純比例した幅配分にはならないため、拍数按分の近似（computeSplitForSegment）だけでは
// 実際の見た目と大きくズレることがある（特に音価の異なる要素が混在する小節で顕著）。
// measureNoteAreaRangesが無い（未描画）場合はcomputeSplitForSegmentにフォールバックする
function pickBestSlotByTrialFormat(measureIndex, notesArray, segment, wantedBeats, clickX, isRestMode) {
    const nSlots = Math.floor(segment.segBeats / wantedBeats + BEAT_EPSILON);
    if (nSlots <= 1) {
        return nSlots < 1 ? null : { leadingBeats: 0, trailingBeats: segment.segBeats - wantedBeats };
    }

    const range = measureNoteAreaRanges[measureIndex];
    if (!range || scale <= 0) {
        return computeSplitForSegment(segment.segStart, segment.segBeats, xToBeatPosition(measureIndex, clickX), wantedBeats);
    }

    const rawLeft = range.left / scale;
    const rawRight = range.right / scale;
    const trialStave = new VF.Stave(rawLeft, 0, rawRight - rawLeft);
    trialStave.setNoteStartX(rawLeft);
    const formatWidth = trialStave.getNoteEndX() - trialStave.getNoteStartX() - MEASURE_END_PADDING;

    const [tsNum, tsDen] = score.timeSignature.split("/").map(Number);
    const buildTrialNote = (n) => {
        if (n.rest) {
            const rn = new VF.StaveNote({ keys: ["b/4"], duration: n.duration + "r", ...(n.dotted ? { dots: 1 } : {}) });
            if (n.dotted) VF.Dot.buildAndAttach([rn], { all: true });
            return rn;
        }
        const sn = new VF.StaveNote({ keys: n.pitches.map(p => pitchToKey(p).key), duration: n.duration, auto_stem: true, ...(n.dotted ? { dots: 1 } : {}) });
        if (n.dotted) VF.Dot.buildAndAttach([sn], { all: true });
        return sn;
    };

    let bestSlot = 0, bestDist = Infinity;
    for (let slotIndex = 0; slotIndex < nSlots; slotIndex++) {
        const leadingBeats = slotIndex * wantedBeats;
        const trailingBeats = segment.segBeats - leadingBeats - wantedBeats;
        const centerEntry = isRestMode
            ? { rest: true, duration: selectedDuration, ...(dottedSelected ? { dotted: true } : {}) }
            : { pitches: ["B4"], duration: selectedDuration, ...(dottedSelected ? { dotted: true } : {}) };
        const leading = beatsToRests(leadingBeats);
        const trailing = beatsToRests(trailingBeats);
        const trialData = [...notesArray];
        trialData.splice(segment.index, 1, ...leading, centerEntry, ...trailing);
        const centerIdx = segment.index + leading.length;

        try {
            const trialNotes = trialData.map(buildTrialNote);
            trialNotes.forEach(n => n.setStave(trialStave));
            const totalBeats = trialData.reduce((s, n) => s + noteBeats(n), 0);
            const remainingBeats = getBeatsPerMeasure() - totalBeats;
            const dummies = makeDummyNotes(Math.max(0, remainingBeats));
            dummies.forEach(n => n.setStave(trialStave));
            const allNotes = [...trialNotes, ...dummies];

            const voice = new VF.Voice({ num_beats: tsNum, beat_value: tsDen });
            voice.setStrict(false);
            voice.addTickables(allNotes);
            new VF.Formatter().joinVoices([voice]).format([voice], formatWidth);

            const candidateX = trialNotes[centerIdx].getAbsoluteX() * scale;
            const dist = Math.abs(candidateX - clickX);
            if (dist < bestDist) {
                bestDist = dist;
                bestSlot = slotIndex;
            }
        } catch (e) {
            // このスロット候補の仮フォーマットに失敗した場合はスキップする
        }
    }
    const leadingBeats = bestSlot * wantedBeats;
    return { leadingBeats, trailingBeats: segment.segBeats - leadingBeats - wantedBeats };
}

// ホバー中に「クリックしたら実際にどうなるか」を計算する。notesArrayは対象の段
// （measure.upperNotes/lowerNotes）の音符列で、staffはその段のタグ（"upper"|"lower"）。
// hoveredPos.staffが一致する場合のみプレビューを返す（別の段をホバー中は何も返さない）。
// 対象の要素（音符/休符）自体は必ずnotesArrayから直接特定する（notePositionsは前回描画の
// スナップショットで、プレビュー自体が対象を差し替えて描画することがあるため、要素の中身の
// 判定材料としては使わない）。ただし「clickXがどの要素の上にあるか」というジオメトリ判定だけは、
// 音価が混在する小節ではxToBeatPositionの拍数按分近似が実際の見た目と大きくズレるため、
// 前回描画の実測位置（findMeasuredSegment）が使える場合はそちらを優先する
function computeHoverPreview(measureIndex, notesArray, staff) {
    if (editMode !== "note") return null;
    if (!hoveredPos || hoveredPos.measureIndex !== measureIndex || !hoveredPos.pitch) return null;
    if (hoveredPos.staff !== staff) return null;

    const invert = k => (k === "note" ? "rest" : "note");
    const effectiveKind = isCtrlHeldForRestPreview ? invert(selectedKind) : selectedKind;

    const { segment } = resolveSegmentAndBeatPos(measureIndex, notesArray, staff, hoveredPos.x);
    if (!segment) return null;
    const target = notesArray[segment.index];

    if (!target.rest) {
        // 既存音符：休符モードならその音符を丸ごと休符で上書き、音符モードなら和音への音追加
        if (effectiveKind === "rest") {
            return {
                type: "overwriteWithRest",
                existingNoteIndex: segment.index,
                duration: target.duration,
                dotted: !!target.dotted
            };
        }
        if (!target.pitches) return null;
        if (target.pitches.includes(hoveredPos.pitch) || target.pitches.length >= getChordMax()) return null;
        return { type: "chordAdd", existingNoteIndex: segment.index, pitch: hoveredPos.pitch };
    }

    // 休符：選択中の音価のスロット単位で分割して新規に置く
    const wantedBeats = selectedNoteBeats();
    if (wantedBeats <= 0) return null;

    const split = pickBestSlotByTrialFormat(measureIndex, notesArray, segment, wantedBeats, hoveredPos.x, effectiveKind === "rest");
    if (!split) return null;

    return {
        type: effectiveKind === "rest" ? "splitRest" : "splitNote",
        targetIndex: segment.index,
        leadingBeats: split.leadingBeats,
        trailingBeats: split.trailingBeats,
        pitch: effectiveKind === "rest" ? null : hoveredPos.pitch,
    };
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
    // クリック直後にrenderScore()すると、クリック前のホバー位置（プレビュー計算のもとになったnotePositions）が
    // データ変更後には古くなっており、変更後の音符と重複したプレビューが一瞬表示されてしまう。
    // クリックした時点でホバー状態は無効化し、次のmousemoveで再計算させる
    hoveredPos = null;

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
                const shiftNotes = shiftHit.staff === "upper" ? measure.upperNotes : measure.lowerNotes;
                const note = shiftNotes[shiftHit.noteIndex];
                const pitch = note.pitches[shiftHit.pitchIndex];
                const match = pitch.match(/^([A-G])([#b]?)(-?\d+)$/);
                if (match) {
                    const [, letter, accidental, octave] = match;
                    const hasSharp = HAS_BLACK_KEY.has(letter);
                    const hasFlat = HAS_FLAT_KEY.has(letter);
                    // 自然音→シャープ→フラット→自然音の順で巡回する（存在しない状態は飛ばす）。
                    // 調号がフラット系の場合でもアクシデンタルなしで表現できるように、
                    // 同じ物理パネルをシャープ表記・フラット表記の両方で選べるようにしている
                    let nextAccidental;
                    if (accidental === "") {
                        nextAccidental = hasSharp ? "#" : (hasFlat ? "b" : "");
                    } else if (accidental === "#") {
                        nextAccidental = hasFlat ? "b" : "";
                    } else {
                        nextAccidental = "";
                    }
                    if (nextAccidental !== accidental) {
                        note.pitches[shiftHit.pitchIndex] = `${letter}${nextAccidental}${octave}`;
                        saveHistory();
                        renderScore();
                    }
                }
            }

        } else {
            // 普段はselectedKindをそのまま使い、Ctrl押下中だけ音符⇔休符を反転する
            const effectiveKind = e.ctrlKey
                ? (selectedKind === "note" ? "rest" : "note")
                : selectedKind;

            if (!isValidX) return;

            // どちらの段（上段/下段）を編集するかは、クリックした位置だけで決まる
            const staff = staffForClick(clickYLocal);
            const targetArray = staff === "upper" ? measure.upperNotes : measure.lowerNotes;

            // ホバープレビューと全く同じ判定にするため、実測位置（findMeasuredSegment）が
            // 使える場合はそちらを優先する（computeHoverPreviewと同じロジック）
            const { segment } = resolveSegmentAndBeatPos(measureIndex, targetArray, staff, clickX);
            if (!segment) return;
            const target = targetArray[segment.index];

            if (!target.rest) {
                if (effectiveKind === "rest") {
                    // 休符モードで既存音符の上に置くと、その音符を同じ長さの休符で上書きする
                    targetArray[segment.index] = {
                        rest: true,
                        duration: target.duration,
                        ...(target.dotted ? { dotted: true } : {})
                    };
                    saveHistory();
                    renderScore();
                } else {
                    // 既存の和音への音追加（この段の音符自体に追加するだけ、他の段とは無関係）
                    const pitch = yToPitch(clickYLocal, false);
                    if (pitch && !target.pitches.includes(pitch) && target.pitches.length < getChordMax()) {
                        target.pitches.push(pitch);
                        target.pitches.sort((a, b) => pitchToSemitone(a) - pitchToSemitone(b));
                        saveHistory();
                        renderScore();
                    }
                }
            } else {
                // 休符：選択中の音価のスロット単位で分割して新規に置く
                const wantedBeats = selectedNoteBeats();
                if (wantedBeats <= 0) return;

                const split = pickBestSlotByTrialFormat(measureIndex, targetArray, segment, wantedBeats, clickX, effectiveKind === "rest");
                if (!split) return; // 選択中の音価がこの休符に収まらない

                let centerEntry;
                if (effectiveKind === "rest") {
                    centerEntry = { rest: true, duration: selectedDuration, ...(dottedSelected ? { dotted: true } : {}) };
                } else {
                    const pitch = yToPitch(clickYLocal, false);
                    if (!pitch) return;
                    centerEntry = { pitches: [pitch], duration: selectedDuration, ...(dottedSelected ? { dotted: true } : {}) };
                }

                const replacement = [
                    ...beatsToRests(split.leadingBeats),
                    centerEntry,
                    ...beatsToRests(split.trailingBeats)
                ];
                targetArray.splice(segment.index, 1, ...replacement);
                saveHistory();
                renderScore();
            }
        }

    } else if (e.button === 2) {
        // 右クリック = 削除。小節は常に音符/休符で埋まっている前提なので、
        // 休符は削除できず（既に「空いている」状態のため）、単音は同じ長さの休符に置き換える
        if (hit) {
            const hitNotes = hit.staff === "upper" ? measure.upperNotes : measure.lowerNotes;
            const note = hitNotes[hit.noteIndex];
            if (note.rest) {
                // 何もしない
            } else if (note.pitches.length === 1) {
                hitNotes[hit.noteIndex] = {
                    rest: true,
                    duration: note.duration,
                    ...(note.dotted ? { dotted: true } : {})
                };
                saveHistory();
                renderScore();
            } else {
                note.pitches.splice(hit.pitchIndex, 1);
                saveHistory();
                renderScore();
            }
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
            const staff = staffForClick(e.clientY - rect.top);
            const hitNote = findNoteAt(measureIndex, mouseX, mouseY);
            const hitNoteX = findNoteAtX(measureIndex, mouseX);

            const newHovered = pitch
                ? { measureIndex, x: mouseX, y: mouseY, pitch, staff, hitNoteIndex: hitNote ? hitNote.noteIndex : (hitNoteX ? hitNoteX.noteIndex : null), directHit: !!hitNote }
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
    // コピー/切り取り/貼り付けは選択モードでの小節選択が前提のため、
    // 音符モードでは操作できないことが分かるようグレーアウトする
    updateClipboardButtons();
}

// 音価ボタン（音符/休符アイコン・付点版含む）の選択状態を反映する
// 選択中の音価・付点有無と一致し、かつ現在のモード（Ctrl押下中なら休符、そうでなければ音符）と種類が合うボタンだけをハイライトする
function updateDurationButtons() {
    // 普段はselectedKindをそのまま使い、Ctrl押下中だけ音符⇔休符を反転してハイライトする
    const invert = k => (k === "note" ? "rest" : "note");
    const activeKind = isCtrlHeldForRestPreview ? invert(selectedKind) : selectedKind;
    document.querySelectorAll("button[data-kind]").forEach(btn => {
        const btnDotted = btn.dataset.dotted === "true";
        const active = btn.dataset.duration === selectedDuration &&
            btn.dataset.kind === activeKind &&
            btnDotted === dottedSelected;
        btn.style.color = active ? "#222" : "#aaa";
        btn.style.background = active ? "#f0f0f0" : "";
    });
}

function updateKeySignatureUI() {
    const select = document.getElementById("keySignatureSelect");
    if (select) select.value = score.keySignature || "C";
}

// 新規作成ダイアログで選択中（まだscoreには反映していない）拍子・譜表。
// 完了ボタンを押すまでscoreは一切変更しないので、キャンセル時は何もせず閉じるだけでよい
let newScorePendingTimeSig = "4/4";
let newScorePendingGrandStaff = false;

function updateNewScoreModalButtons() {
    const ts44 = document.getElementById("newScoreTimeSig44");
    const ts34 = document.getElementById("newScoreTimeSig34");
    if (ts44) {
        ts44.style.color = newScorePendingTimeSig === "4/4" ? "#222" : "#aaa";
        ts44.style.background = newScorePendingTimeSig === "4/4" ? "#f0f0f0" : "";
    }
    if (ts34) {
        ts34.style.color = newScorePendingTimeSig === "3/4" ? "#222" : "#aaa";
        ts34.style.background = newScorePendingTimeSig === "3/4" ? "#f0f0f0" : "";
    }

    const single = document.getElementById("newScoreStaffSingle");
    const grand = document.getElementById("newScoreStaffGrand");
    if (single) {
        single.style.color = !newScorePendingGrandStaff ? "#222" : "#aaa";
        single.style.background = !newScorePendingGrandStaff ? "#f0f0f0" : "";
    }
    if (grand) {
        grand.style.color = newScorePendingGrandStaff ? "#222" : "#aaa";
        grand.style.background = newScorePendingGrandStaff ? "#f0f0f0" : "";
    }
}

function openNewScoreModal() {
    // ダイアログを開く時点の現在の設定を初期値にする
    newScorePendingTimeSig = score.timeSignature || "4/4";
    newScorePendingGrandStaff = !!score.grandStaff;
    updateNewScoreModalButtons();
    const overlay = document.getElementById("newScoreModalOverlay");
    if (overlay) overlay.style.display = "flex";
}

function closeNewScoreModal() {
    const overlay = document.getElementById("newScoreModalOverlay");
    if (overlay) overlay.style.display = "none";
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
            // 小節のドラッグ選択は選択モードのときのみ有効にする（音符モード中の誤選択防止）
            if (editMode === "select") {
                const measures = getMeasuresInDragRange(
                    dragState.startX, dragState.startY,
                    dragState.currentX, dragState.currentY
                );
                selectedMeasures = new Set(measures);
            }
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
        if (e.target.closest("select")) return;

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
        score.measures = [makeEmptyMeasure()];
    } else {
        [...indices].reverse().forEach(i => score.measures.splice(i, 1));
    }
    selectedMeasures.clear();
    saveHistory();
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
    updateClipboardButtons();
    if (activeTab === "map") renderMap();
    rescheduleFromCurrentPosition();
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
    if (activeTab === "map") renderMap();
    rescheduleFromCurrentPosition();
}

// コピー/切り取り/貼り付けは、選択モードで小節を選択している状態が前提の操作のため、
// 音符モードでは（貼り付け先/対象が無いため実際にも無効な）グレーアウト表示にする
function updateClipboardButtons() {
    const copyBtn = document.getElementById("copyBtn");
    const cutBtn = document.getElementById("cutBtn");
    const pasteBtn = document.getElementById("pasteBtn");
    const canUseClipboardOps = editMode === "select";
    if (copyBtn) {
        copyBtn.style.opacity = canUseClipboardOps ? "1" : "0.4";
        copyBtn.disabled = !canUseClipboardOps;
    }
    if (cutBtn) {
        cutBtn.style.opacity = canUseClipboardOps ? "1" : "0.4";
        cutBtn.disabled = !canUseClipboardOps;
    }
    if (pasteBtn) {
        const canPaste = canUseClipboardOps && clipboardMeasures.length > 0;
        pasteBtn.style.opacity = canPaste ? "1" : "0.4";
        pasteBtn.disabled = !canPaste;
    }
}

function deleteSelectedMeasures() {
    if (selectedMeasures.size === 0) return;
    if (selectedMeasures.size >= score.measures.length) {
        // 全小節が選択されている場合は最低1小節残す
        score.measures = [makeEmptyMeasure()];
    } else {
        const indices = [...selectedMeasures].sort((a, b) => b - a);
        indices.forEach(i => score.measures.splice(i, 1));
    }
    selectedMeasures.clear();
    saveHistory();
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
    if (activeTab === "map") renderMap();
    rescheduleFromCurrentPosition();
}

async function main() {

    loadSeBuffers();

    const response = await fetch("sample_score.json");
    const data = await response.json();
    const [tsNumSample, tsDenSample] = (data.timeSignature || "4/4").split("/").map(Number);
    const beatsPerMeasureSample = tsNumSample * 4 / tsDenSample;
    score = {
        timeSignature: data.timeSignature,
        keySignature: data.keySignature || "C",
        grandStaff: !!data.grandStaff,
        measures: migrateMeasuresToStaffArrays(data.measures, !!data.grandStaff, beatsPerMeasureSample)
    };

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
    setupMapResizeHandle();

    // モード切替ボタンの初期状態を反映
    updateEditModeButtons();

    document.getElementById("editModeNote")
        .addEventListener("click", () => setEditMode("note"));
    document.getElementById("editModeSelect")
        .addEventListener("click", () => setEditMode("select"));

    // 音価ボタンの初期状態を反映
    updateDurationButtons();

    document.querySelectorAll("button[data-kind]").forEach(btn => {
        btn.addEventListener("click", () => {
            selectedDuration = btn.dataset.duration;
            selectedKind = btn.dataset.kind;
            dottedSelected = btn.dataset.dotted === "true";
            localStorage.setItem("selectedDuration", selectedDuration);
            localStorage.setItem("selectedKind", selectedKind);
            localStorage.setItem("dottedSelected", dottedSelected);
            updateDurationButtons();
        });
    });

    // Ctrlキーを押している間だけ、音価ボタンの表示を休符アイコンに切り替える
    document.addEventListener("keydown", (e) => {
        if (e.key === "Control" && !isCtrlHeldForRestPreview) {
            isCtrlHeldForRestPreview = true;
            updateDurationButtons();
        }
    });
    document.addEventListener("keyup", (e) => {
        if (e.key === "Control" && isCtrlHeldForRestPreview) {
            isCtrlHeldForRestPreview = false;
            updateDurationButtons();
        }
    });

    // 調号セレクトの初期状態を反映
    updateKeySignatureUI();

    document.getElementById("keySignatureSelect")
        .addEventListener("change", (e) => {
            score.keySignature = e.target.value;
            saveHistory();
            renderScore();
        });

    document.getElementById("transposeUp")
        .addEventListener("click", () => {
            transposeScore(1);
            updateKeySignatureUI();
            saveHistory();
            renderScore();
            if (activeTab === "map") renderMap();
            rescheduleFromCurrentPosition();
        });
    document.getElementById("transposeDown")
        .addEventListener("click", () => {
            transposeScore(-1);
            updateKeySignatureUI();
            saveHistory();
            renderScore();
            if (activeTab === "map") renderMap();
            rescheduleFromCurrentPosition();
        });

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
    document.getElementById("mapWrapValue")?.addEventListener("change", e => {
        mapSettings.wrapValue = Math.max(1, parseInt(e.target.value) || 1);
        saveMapSettings(); renderMap();
    });
    document.getElementById("mapWrapDown")?.addEventListener("click", () => {
        mapSettings.wrapValue = Math.max(1, mapSettings.wrapValue - 1);
        const el = document.getElementById("mapWrapValue");
        if (el) el.value = mapSettings.wrapValue;
        saveMapSettings(); renderMap();
    });
    document.getElementById("mapWrapUp")?.addEventListener("click", () => {
        mapSettings.wrapValue = mapSettings.wrapValue + 1;
        const el = document.getElementById("mapWrapValue");
        if (el) el.value = mapSettings.wrapValue;
        saveMapSettings(); renderMap();
    });
    document.getElementById("mapHideUnusedSensors")?.addEventListener("click", () => {
        mapSettings.hideUnusedSensors = !mapSettings.hideUnusedSensors;
        saveMapSettings(); updateMapToolbarUI(); renderMap();
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
            score.measures.push(makeEmptyMeasure());
            selectedMeasures.clear();
            saveHistory();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
            window.scrollTo(0, scrollY);
            if (activeTab === "map") renderMap();
            rescheduleFromCurrentPosition();
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

    document.getElementById("newScoreBtn")
        .addEventListener("click", () => openNewScoreModal());

    document.getElementById("newScoreTimeSig44")
        .addEventListener("click", () => {
            newScorePendingTimeSig = "4/4";
            updateNewScoreModalButtons();
        });
    document.getElementById("newScoreTimeSig34")
        .addEventListener("click", () => {
            newScorePendingTimeSig = "3/4";
            updateNewScoreModalButtons();
        });
    document.getElementById("newScoreStaffSingle")
        .addEventListener("click", () => {
            newScorePendingGrandStaff = false;
            updateNewScoreModalButtons();
        });
    document.getElementById("newScoreStaffGrand")
        .addEventListener("click", () => {
            newScorePendingGrandStaff = true;
            updateNewScoreModalButtons();
        });

    document.getElementById("newScoreCancelBtn")
        .addEventListener("click", () => closeNewScoreModal());

    document.getElementById("newScoreConfirmBtn")
        .addEventListener("click", () => {
            score.timeSignature = newScorePendingTimeSig;
            score.grandStaff = newScorePendingGrandStaff;
            score.measures = [makeEmptyMeasure()];
            document.getElementById("scoreTitleInput").value = "NewScore";
            selectedMeasures.clear();
            saveHistory();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
            if (activeTab === "map") renderMap();
            closeNewScoreModal();
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
        .addEventListener("change", () => rescheduleFromCurrentPosition());

    const volumeSlider = document.getElementById("volumeSlider");
    volumeSlider.value = volume;
    volumeSlider.addEventListener("input", (e) => {
        volume = parseFloat(e.target.value);
        localStorage.setItem("volume", volume);
        if (masterGainNode) masterGainNode.gain.value = volume;
    });

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
                    const [tsNumLoad, tsDenLoad] = (data.timeSignature || "4/4").split("/").map(Number);
                    const beatsPerMeasureLoad = tsNumLoad * 4 / tsDenLoad;
                    score = {
                        timeSignature: data.timeSignature,
                        keySignature: data.keySignature || "C",
                        grandStaff: !!data.grandStaff,
                        measures: migrateMeasuresToStaffArrays(data.measures, !!data.grandStaff, beatsPerMeasureLoad)
                    };

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
                    updateKeySignatureUI();

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