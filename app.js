const VF = VexFlow;

let score = null;
let scale = 0.75; // デフォルトのズーム倍率（実際の描画倍率。ZOOM_DISPLAY_BASEにより「100%」と表示される）
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
// 直前のsaveBtnクリック（またはファイル読み込み直後）以降に、内容の変更があったかどうか。
// #statusBarの保存状態インジケータに使う
let hasUnsavedChanges = false;
let northDirection = 0; // 0=↑, 1=→, 2=↓, 3=←

let audioCtx = null;
let masterGainNode = null; // 全音源が経由するマスター音量ノード（再生中でもリアルタイムに音量変更するため）
let volume = parseFloat(localStorage.getItem("volume")) || 0.8; // 0〜1
// ミュート直前の音量。ミュート中はnull以外になり、アイコン再クリックでこの値に戻す
let volumeBeforeMute = null;
let playState = "stopped"; // "stopped" | "playing" | "paused"
let isLooping = false;
let playStartTime = null;
let playEndTime = 0; // audioCtx時刻での再生終了予定時刻（終了検知・ループに使用）
// 曲の絶対的な先頭（小節0）から数えて、今回の再生開始位置が何秒目にあたるか。
// シークバーの現在位置表示に使う（A-B区間ループ中でもシークバー自体は曲全体の
// 絶対時間で動かしたいため、区間の先頭ではなく常に曲の先頭からの絶対位置にする）
let playAbsoluteElapsedAtStart = 0;
// シークバーをドラッグ操作中かどうか。trueの間はtrackPlayback()側からの
// シークバーの値の自動更新を止め、ドラッグ中の値を上書きしないようにする
let isSeekDragging = false;
let noteSchedule = [];
let noteTimeMap = [];
let beatSchedule = []; // {beatIndex, startTime, endTime} 1エントリ=マップの1センサー分（16分音符単位）。上段・下段どちらの音符内容にも依存しない算術スケジュール
// {measureIndex, noteIndex, startTime, endTime} 1エントリ=1つの音符（休符含む）。テンポ変更の再開位置探しに使う。
// 上段・下段は完全に独立したリズムを持てるため、それぞれ専用の境界スケジュールを持つ
let upperNoteBoundarySchedule = [];
let lowerNoteBoundarySchedule = [];
let activeSourceNodes = []; // {node, startTime} 再生中にスケジュール済みの音源（曲中のテンポ変更時に先の分を止めるため）
let currentHighlightMeasure = -1;
let currentHighlightBeatIndex = null; // マップのレール上の再生位置（ビート番号）
let currentHighlightBeatT = 0; // そのビート内での経過（0〜1）
let animFrameId = null;
// ビートごとのレール中心座標（#mapGrid基準px）のキャッシュ。renderMap()のたびに
// 作り直し、再生中の位置マーカー(drawMapPlayLine)はこれを使って毎フレームDOMを
// 総なめすることなく座標を引けるようにする
let mapBeatPositions = [];
let mapRailIsVertical = false;
let mapRailCellSize = 0;

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
    { id: "score",    label: "五線譜",           icon: "fa-music" },
    { id: "map",      label: "マップ",            icon: "fa-map" },
    { id: "both",     label: "並べて",            icon: "fa-table-columns" },
    { id: "assembly", label: "プレビュー",         icon: "fa-cube" },
];
let activeTab = localStorage.getItem("activeTab") || "score";
// 廃止済みタブ（例: 旧パネル楽譜タブ）がlocalStorageに残っていた場合のフォールバック
if (!TABS.some(t => t.id === activeTab)) activeTab = "score";

// 「両方」タブ（五線譜+マップ同時表示）のレイアウト。ボタンで左右2パターンをローテーション切替する
// （上下2パターンは2026-08-04にユーザーの依頼で廃止済み。「レイアウトは左右だけでいいです」）
const BOTH_TAB_LAYOUT_ORDER = ["left-right", "right-left"];
let bothTabLayout = localStorage.getItem("bothTabLayout") || "left-right";
if (!BOTH_TAB_LAYOUT_ORDER.includes(bothTabLayout)) bothTabLayout = "left-right";

// 「並べて」タブの左右パネルの幅比率（0〜1、左パネルの取り分）。#bothTabDividerの
// ドラッグで変更し、次回訪問時も同じ比率を再現する
let bothSplitRatio = parseFloat(localStorage.getItem("bothSplitRatio"));
if (!(bothSplitRatio >= 0.15 && bothSplitRatio <= 0.85)) bothSplitRatio = 0.5;

function applyBothSplitRatio() {
    const container = document.getElementById("bothTabContainer");
    if (!container) return;
    const leftPct = (bothSplitRatio * 100).toFixed(2);
    const rightPct = (100 - bothSplitRatio * 100).toFixed(2);
    container.style.gridTemplateColumns = `${leftPct}% 10px ${rightPct}%`;
}

function applyBothTabLayout() {
    const container = document.getElementById("bothTabContainer");
    if (!container) return;
    BOTH_TAB_LAYOUT_ORDER.forEach(l => container.classList.remove(`layout-${l}`));
    container.classList.add(`layout-${bothTabLayout}`);
    applyBothSplitRatio();
    updateBothTabContainerHeight();
    updateContentAreaMinHeights();
}

// 「並べて」タブの左右レイアウトを入れ替える（レイアウトボタンのクリック、および
// 「並べて」タブをすでに表示中にもう一度タブを押した場合の、両方から呼ばれる共通処理）
function rotateBothTabLayout() {
    const i = BOTH_TAB_LAYOUT_ORDER.indexOf(bothTabLayout);
    const nextIndex = (i + 1) % BOTH_TAB_LAYOUT_ORDER.length;
    bothTabLayout = BOTH_TAB_LAYOUT_ORDER[nextIndex];
    localStorage.setItem("bothTabLayout", bothTabLayout);

    // bothSplitRatioは常に「左側の取り分」を表すため、入れ替え時にこれを反転しないと、
    // 左スロットの幅だけが据え置かれて中身（五線譜/マップ）だけが入れ替わる形になり、
    // 結果として五線譜とマップの幅そのものが入れ替わって見えてしまう（例:五線譜30%だった
    // ものが入れ替え後に70%になる）。反転させることで、各エリア自身の幅は変えずに
    // 位置（左右）だけが入れ替わるようにする
    bothSplitRatio = 1 - bothSplitRatio;
    localStorage.setItem("bothSplitRatio", bothSplitRatio);

    // ボタンのアイコンを左右反転させ、左右を入れ替えたことを視覚的に伝える
    const icon = document.querySelector("#bothLayoutRotate i");
    if (icon) icon.style.transform = nextIndex === 1 ? "scaleX(-1)" : "";

    // FLIP（First-Last-Invert-Play）技法で、五線譜/マップ領域の入れ替わりを
    // 「配置がガタッと切り替わる」のではなく「位置がスッと移動する」ように見せる。
    // grid自体は行⇔列で構造が丸ごと変わるため滑らかに補間できないが、
    // 切り替え前後で#scoreWrapper/#mapAreaWrapperの画面上の位置を測定しておき、
    // 切り替え後に「切り替え前の位置にいるように見える」だけズレたtransformを
    // 一旦transitionなしで当ててから、それを0へ戻すtransitionをかけることで、
    // 実際の移動距離ぶんだけ滑らかにスライドしたように見せる
    // #bothTabDivider（入れ替えボタンを乗せている境界線）も、bothSplitRatioの反転で
    // 実際の画面上の位置（列1の幅が変わるため）が動く。ここに含めないと、境界線・
    // 入れ替えボタンだけ即座に新しい位置へスナップし、五線譜/マップ本体がFLIPで
    // 追いつくまでの間、両者のタイミングがズレて見えてしまう
    const flipEls = [document.getElementById("scoreWrapper"), document.getElementById("mapAreaWrapper"), document.getElementById("bothTabDivider")]
        .filter(Boolean);
    const firstRects = new Map(flipEls.map(el => [el, el.getBoundingClientRect()]));

    // bothSplitRatioを反転させているため、五線譜・マップそれぞれ自身の幅は変わらず
    // 左右の位置（grid-column）だけが入れ替わる。renderScore()/renderMap()が依存する
    // 入力（各ラッパー自身のclientWidth・scale・データ内容）は何一つ変化しないため、
    // 中身を再構築するrenderScore()/renderMap()の呼び直しは不要（かつ、五線譜は数十ms、
    // マップは小節数・マス数次第で数百msかかることもあり、単なる左右入れ替えのたびに
    // 呼ぶと体感のもたつきの主因になっていた）。削除/挿入ボタンやマップのリサイズハンドルも
    // 位置は各ラッパー自身からの相対オフセットで決まり、ラッパーの子要素として一緒に
    // 移動するため、これらも再計算不要（FLIPアニメーション自体はapplyBothTabLayout()後の
    // 実測left/topの差分だけで成立するため、中身の再構築とは独立して機能する）
    applyBothTabLayout();

    flipEls.forEach(el => {
        const first = firstRects.get(el);
        const last = el.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (!dx && !dy) return;

        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        // 上記transformを一度実際に描画させてから（reflow強制）、本来の位置へ
        // transitionで滑らかに戻す。強制reflowなしだと、直後のtransform変更が
        // ブラウザによって1回のペイントにまとめられ、移動が瞬間的になってしまう
        el.getBoundingClientRect();

        requestAnimationFrame(() => {
            el.style.transition = "transform 0.3s ease";
            el.style.transform = "";
            setTimeout(() => { el.style.transition = ""; }, 320);
        });
    });
}

// 「両方」タブでは、五線譜とマップをブラウザの表示領域のちょうど半分ずつで区切りたい
// （上下2パターンは高さを、左右2パターンは幅を半分ずつに分ける）。加えて、左右パターンでは
// 五線譜・マップそれぞれが自分のエリア内で独立して縦スクロールできるようにしたい。
// #bothTabContainer自体には親から継承できる高さが無い（ページは通常のドキュメントフローで
// スクロールする）ため、レイアウトの向きに関わらず、ブラウザの可視領域のうち
// #bothTabContainerより上（タブ・ツールバー等）が占める分を引いた残り高さをJSで都度計算し、
// 明示的な高さとして与える（CSS側は`grid-template-rows`/`grid-template-columns`の`1fr`で
// 半分ずつに分け、各エリアの`overflow:auto`ではみ出した内容だけを個別にスクロールさせる）
function updateBothTabContainerHeight() {
    const container = document.getElementById("bothTabContainer");
    if (!container) return;
    if (activeTab !== "both") {
        container.style.height = "";
        return;
    }
    // 直前まで別タブでページがスクロールしていた場合、getBoundingClientRect().topがスクロール
    // 位置の影響を受けて不正確になる。「両方」タブではページ全体がちょうど収まる高さになる
    // 想定のため、先頭にスクロールしてから測定する
    window.scrollTo(0, 0);
    const top = container.getBoundingClientRect().top;
    let available = window.innerHeight - top;
    container.style.height = Math.max(available, 100) + "px";

    // #main等コンテナの下側に残る余白（padding等）の影響で、上記だけではまだページ全体が
    // わずかにはみ出すことがあるため、実際のはみ出し量を測って一度だけ補正する
    const overflow = document.documentElement.scrollHeight - window.innerHeight;
    if (overflow > 0) {
        available = Math.max(available - overflow, 100);
        container.style.height = available + "px";
    }
}

// 五線譜・マップの背景（白い枠）は、小節数や音符マット数が少ないとその分だけ小さくなってしまい、
// エリアの残りが素の背景色のまま余ってしまう。「楽譜や音符マットが少ししかなくても、エリア
// いっぱいに背景の余白を拡げたい」という要望を受け、内容が少ない時でも少なくとも表示エリア分の
// 高さは確保する（内容がそれより多ければ自然にそれを超えて伸びる、min-heightなので上限は無い）。
// 五線譜側は背景を持つ#scoreWrapper自身に、マップ側は背景を持つ#mapArea（#mapAreaWrapperの
// 子）に、それぞれmin-heightを設定する
function updateContentAreaMinHeights() {
    const container = document.getElementById("bothTabContainer");
    const scoreWrapper = document.getElementById("scoreWrapper");
    const mapAreaWrapper = document.getElementById("mapAreaWrapper");
    const mapArea = document.getElementById("mapArea");
    if (!container || !scoreWrapper || !mapArea) return;

    if (activeTab === "both") {
        // 「両方」タブでは、#scoreWrapper/#mapAreaWrapper自体がgridのalign-items:stretchで
        // 既にトラック全体の高さになっている（updateBothTabContainerHeightが計算した
        // #bothTabContainerの高さを、grid-template-rows/columnsの1frが半分ずつに分配する）。
        // 五線譜側はそのままで背景が埋まるため追加指定は不要。マップ側は背景が1つ内側の
        // #mapAreaにあるため、既に確定している親（#mapAreaWrapper）の高さをそのまま使う
        scoreWrapper.style.minHeight = "";
        mapArea.style.minHeight = mapAreaWrapper ? mapAreaWrapper.clientHeight + "px" : "";
        return;
    }

    // 単体タブ（五線譜/マップ）: ここではページ自体は従来通り自由にスクロールできるままにしたい
    // ため、コンテナの高さそのものは固定しない。「表示エリア（#bothTabContainerの位置から
    // ブラウザ表示領域の下端まで）」の高さをmin-heightとして与えるだけに留める。
    // getBoundingClientRect().top + window.scrollY で、現在のスクロール位置に関わらず
    // 「ページ先頭から見た絶対位置」を求められるため、scrollTo(0,0)による強制スクロールは不要
    const docTop = container.getBoundingClientRect().top + window.scrollY;
    const available = Math.max(window.innerHeight - docTop, 100) + "px";
    scoreWrapper.style.minHeight = activeTab === "score" ? available : "";
    mapArea.style.minHeight = activeTab === "map" ? available : "";
}

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

// マップの音符マット画像（img/*.jpg）のプリロードキャッシュ。canvasのdrawImage()は
// 読み込み済みのHTMLImageElementでないと描けない（<img src=...>と違い、ブラウザの
// 非同期パイプラインに任せて後から自然に表示される、ということが無い）ため、
// loadSeBuffers()と同様アプリ起動時に先読みしておく
const MAP_PANEL_IMAGES = {};
let mapPanelImagesLoadStarted = false;

function loadMapPanelImages() {
    if (mapPanelImagesLoadStarted) return;
    mapPanelImagesLoadStarted = true;
    Object.keys(PITCH_TO_FILE).forEach(pitch => {
        const img = new Image();
        img.onload = scheduleMapPanelRedraw;
        img.src = `img/${PITCH_TO_FILE[pitch]}`;
        MAP_PANEL_IMAGES[pitch] = img;
    });
}

function getMapPanelImage(pitch) {
    return MAP_PANEL_IMAGES[toCanonicalPitch(pitch)] || null;
}

// 起動直後、複数の画像がほぼ同時に読み込み完了することが多いため、1枚読み込むごとに
// 都度キャンバス全体を再描画するのではなく、1フレームにまとめて1回だけ再描画する
let mapImageRedrawScheduled = false;
function scheduleMapPanelRedraw() {
    if (mapImageRedrawScheduled) return;
    mapImageRedrawScheduled = true;
    requestAnimationFrame(() => {
        mapImageRedrawScheduled = false;
        if ((activeTab === "map" || activeTab === "both") && mapRenderState) drawMapCanvas(mapRenderState);
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

// 再生は基本的に曲全体を対象とする（小節選択は編集用の状態であり、シークバー等の
// 再生系操作を巻き込まないよう独立させている）が、A-B区間ループ（abLoopRange）が
// 設定されている間はその区間だけを対象にする。scheduleMeasuresFrom()がこの関数を
// 直接呼んでスケジュールの終端を決めているため、区間の反映はここで行う。
// abLoopRangeは常に値を持ち（デフォルトは曲の端から端まで）、nullにはならない
// （resetAbLoopRangeToFull参照）
let abLoopRange = null; // { startMeasureIndex, endMeasureIndex }（#abLoopStripで設定）
// A-B区間ループの有効/無効トグル（#abLoopToggleBtn）がOFFの間は区間を無視して曲全体を
// 対象にする。区間自体（abLoopRange）はOFFにしても保持したままにし、再度ONにすれば
// 同じ区間がすぐ復活するようにする（毎回帯をドラッグし直さずに済むように）。
// デフォルトはOFF（区間は端から端までだが、明示的にONにするまでは効かない）
let abLoopEnabled = false;

// abLoopRangeを現在の曲の先頭〜末尾（デフォルトの範囲）にリセットする。新規作成・
// 読み込み直後の初期状態と、帯を単発クリックした時のリセット操作の両方から使う。
// 有効/無効トグルもデフォルトのOFFに戻す
function resetAbLoopRangeToFull() {
    abLoopRange = score.measures.length > 0
        ? { startMeasureIndex: 0, endMeasureIndex: score.measures.length - 1 }
        : null;
    abLoopEnabled = false;
}

function getPlaybackEndMeasureIndex() {
    if (abLoopRange && abLoopEnabled) return abLoopRange.endMeasureIndex;
    return score.measures.length - 1;
}

function getPlaybackRangeMeasures() {
    if (abLoopRange && abLoopEnabled) return { startMeasureIndex: abLoopRange.startMeasureIndex, endMeasureIndex: abLoopRange.endMeasureIndex };
    return { startMeasureIndex: 0, endMeasureIndex: getPlaybackEndMeasureIndex() };
}

// 現在のBPMでの、曲全体の合計時間（秒）。シークバーの総時間表示・シーク位置→
// 小節番号の計算に使う。A-B区間ループ中でも常に曲全体基準のまま変えない
// （「シークバーの秒数は変えないでほしい」との要望——動かせる範囲はA-Bに
// 制限しつつ、表示される時刻・目盛りは曲全体の絶対時間のままにする）
function getFullSongDuration() {
    const bpm = parseInt(document.getElementById("bpmInput")?.value) || 120;
    return Math.max(0, score.measures.length * getBeatsPerMeasure() * (60 / bpm));
}

function playScore() {
    if (playState !== "stopped") return;
    const { startMeasureIndex } = getPlaybackRangeMeasures();
    startPlaybackFromMeasure(startMeasureIndex);
}

// 指定した小節からスケジュールを組み直して再生を開始する（playScore()の本体であり、
// シーク（seekToRatio）からも「その位置の小節から再生し直す」ために使う）
function startPlaybackFromMeasure(measureIndex) {
    playState = "playing";

    const ctx = getAudioContext();
    playStartTime = ctx.currentTime + 0.1;
    noteSchedule = [];
    noteTimeMap = [];
    beatSchedule = [];
    upperNoteBoundarySchedule = [];
    lowerNoteBoundarySchedule = [];
    activeSourceNodes = [];

    // マップのセンサー番号（beatIndex）は曲頭からの絶対番号なので、開始小節分のビート数を
    // オフセットとして渡し、途中から再生してもセンサーのハイライトがずれないようにする
    const beatIndexOffset = measureIndex * getBeatsPerMeasure() * 4;

    // シークバー用: 曲の絶対的な先頭から数えて、何秒ぶん進んだ位置から再生を始めるか
    const bpm = parseInt(document.getElementById("bpmInput").value) || 120;
    playAbsoluteElapsedAtStart = measureIndex * getBeatsPerMeasure() * (60 / bpm);

    scheduleMeasuresFrom(measureIndex, { noteIndex: 0, time: playStartTime }, { noteIndex: 0, time: playStartTime }, beatIndexOffset, null);

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

    const endMeasureIndex = getPlaybackEndMeasureIndex();

    for (let measureIndex = startMeasureIndex; measureIndex <= endMeasureIndex; measureIndex++) {
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
        for (let measureIndex = startMeasureIndex; measureIndex <= endMeasureIndex; measureIndex++) {
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

    if (resumeMeasureIndex >= score.measures.length || resumeMeasureIndex > getPlaybackEndMeasureIndex()) {
        playEndTime = earliestResumeTime;
        return;
    }

    scheduleMeasuresFrom(resumeMeasureIndex, upperResume, lowerResume, beatSchedule.length, resumeMeasureStartTimeOverride);
}

// 再生を終端まで到達した状態にする（ループ時は続けて再生開始）
function finishPlayback() {
    playState = "stopped";
    // 全曲ループ（isLooping）とA-B区間ループ（abLoopRange）は独立した別概念だが、
    // どちらか一方でも有効なら「最後まで来たら再生対象範囲の先頭へ戻って続ける」
    // という動作自体は共通なので、ここではORで判定する
    if (isLooping || (abLoopRange && abLoopEnabled)) {
        playScore();
        return;
    }
    currentHighlightMeasure = -1;
    currentHighlightBeatIndex = null;
    cancelAnimationFrame(animFrameId);
    highlightMeasure(-1);
    updatePlaybackMarkers(null);
    document.querySelectorAll(".playLine").forEach(el => el.remove());
    updatePlaybackButtons();
    updateSeekBar();
}

function stopScore() {
    if (playState === "stopped") return;
    playState = "stopped";
    currentHighlightMeasure = -1;
    currentHighlightBeatIndex = null;
    cancelAnimationFrame(animFrameId);
    highlightMeasure(-1);
    updatePlaybackMarkers(null);
    document.querySelectorAll(".playLine").forEach(el => el.remove());
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
    updatePlaybackButtons();
    updateSeekBar();
}

// 再生中の音・スケジュールはそのままに、時間経過を止める
function pauseScore() {
    if (playState !== "playing") return;
    playState = "paused";
    if (audioCtx) audioCtx.suspend();
    cancelAnimationFrame(animFrameId);
    updatePlaybackButtons();
}

// 音量に応じてミュートアイコンの見た目を切り替える
function updateMuteIcon() {
    const icon = document.getElementById("muteBtn");
    if (!icon) return;
    icon.className = volume === 0 ? "fa-solid fa-volume-xmark" : "fa-solid fa-volume-high";
}

// 一時停止した時点から再生を続ける
function resumeScore() {
    if (playState !== "paused") return;
    playState = "playing";
    if (audioCtx) audioCtx.resume();
    trackPlayback();
    updatePlaybackButtons();
}

// 再生中/一時停止中に、曲の先頭から再生し直す
function restartScore() {
    if (playState === "stopped") return;
    const { startMeasureIndex } = getPlaybackRangeMeasures();
    restartPlaybackFromMeasure(startMeasureIndex);
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
    const restartBtn = document.getElementById("restartBtn");
    if (restartBtn) {
        const stopped = playState === "stopped";
        restartBtn.disabled = stopped;
        restartBtn.style.opacity = stopped ? "0.4" : "1";
    }
}

function formatPlaybackTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

// 現在の再生対象範囲の先頭から数えた経過秒数（停止中は0）
function getPlaybackElapsed() {
    if (playState === "stopped" || !audioCtx) return 0;
    return playAbsoluteElapsedAtStart + (audioCtx.currentTime - playStartTime);
}

// シークバーのつまみ位置と現在時刻/総時間の表示を、現在の再生状態に合わせて更新する。
// ドラッグ中（isSeekDragging）はつまみの値・時刻表示ともに触らない
// （'input'ハンドラ側がドラッグ位置に基づく表示を担当しているため、ここで実際の
// 再生位置に基づく値を書き戻すと表示が競合してちらつく）
function updateSeekBar() {
    const bar = document.getElementById("seekBar");
    const curEl = document.getElementById("seekTimeCurrent");
    const totalEl = document.getElementById("seekTimeTotal");
    if (!bar || !curEl || !totalEl) return;

    const totalDuration = getFullSongDuration();
    totalEl.textContent = formatPlaybackTime(totalDuration);
    if (isSeekDragging) return;

    const elapsed = Math.min(totalDuration, getPlaybackElapsed());
    curEl.textContent = formatPlaybackTime(elapsed);
    bar.value = totalDuration > 0 ? elapsed / totalDuration : 0;
    updateSliderFill(bar);
    updateSeekBarFillStart();
}

// A-Bループ中は、シークバーの「再生済み」を示す黒いバーがA-B区間の外にはみ出さないよう、
// バーが塗り始める位置（--fill-start）をAの位置に揃える（CSSのグラデーション/clip-pathで参照する）。
// A-Bが無効な間は常に0%（曲の先頭から塗る、従来通り）
function updateSeekBarFillStart() {
    const bar = document.getElementById("seekBar");
    if (!bar || !score) return;
    const startRatio = (abLoopRange && abLoopEnabled && score.measures.length > 0)
        ? abLoopRange.startMeasureIndex / score.measures.length
        : 0;
    bar.style.setProperty("--fill-start", `${startRatio * 100}%`);
}

// シークバーで指定された割合(0〜1、再生対象範囲内での位置)へ再生位置を移動する。
// 小節単位で対象の小節を求め、そこからスケジュールを組み直して再生する
// （曲の途中の任意の時刻ちょうどから鳴らし直すのは、上段・下段の音符境界が
// 揃っていないと崩れるため、小節単位に丸めている）
// 指定した小節の頭の状態を、小節ハイライト・マップのマーカーへ即座に反映する。
// シークや最初に戻す操作は、一時停止中に行われるとtrackPlayback()のループが
// 1度も回らないまま止まってしまい、見た目が新しい位置に追従しないため、
// stopScore()+startPlaybackFromMeasure()の直後にこれを呼んで明示的に同期する
function syncHighlightToMeasureStart(measureIndex) {
    currentHighlightMeasure = measureIndex;
    highlightMeasure(measureIndex);
    if (beatSchedule.length > 0) {
        currentHighlightBeatIndex = beatSchedule[0].beatIndex;
        currentHighlightBeatT = 0;
        updatePlaybackMarkers(currentHighlightBeatIndex, 0);
    }
}

// 再生中でなければ（一時停止中/停止中のどちらでも）、指定した小節から再生し直した上で
// 直後に一時停止扱いにする。再生中だった場合だけそのまま再生を続ける
// （停止中にシークバーを動かしただけで勝手に再生が始まらないようにするため）
function restartPlaybackFromMeasure(measureIndex) {
    const wasPlaying = playState === "playing";
    stopScore();
    startPlaybackFromMeasure(measureIndex);
    syncHighlightToMeasureStart(measureIndex);
    if (!wasPlaying) pauseScore();
    updateSeekBar();
}

// シークバーの割合(0〜1)から、再生対象範囲内で対応する小節indexを求める
// シークバーの割合(0〜1、常に曲全体基準)から対応する小節indexを求める。
// A-B区間ループが有効な間は、シークバーの目盛り自体は曲全体のままにしつつ
// （「シークバーの秒数は変えないでほしい」との要望）、実際にシークできる小節は
// A-B区間内にクランプする（＝シークバーが動ける範囲がA-Bの長さだけになる）
function getMeasureIndexForRatio(ratio) {
    const measureIndex = measureIndexForFullSongRatio(ratio);
    if (measureIndex === null) return null;
    if (abLoopRange && abLoopEnabled) {
        return Math.min(abLoopRange.endMeasureIndex, Math.max(abLoopRange.startMeasureIndex, measureIndex));
    }
    return measureIndex;
}

function seekToRatio(ratio) {
    const targetMeasureIndex = getMeasureIndexForRatio(ratio);
    if (targetMeasureIndex === null) return;
    restartPlaybackFromMeasure(targetMeasureIndex);
}

// シークバーをドラッグ中、実際に音を鳴らし直す（seekToRatio）前のプレビューとして、
// 五線譜のハイライトとマップの再生位置マーカーだけをドラッグ位置に追従させる
function previewSeekHighlight(measureIndex) {
    highlightMeasure(measureIndex);
    const beatIndex = measureIndex * getBeatsPerMeasure() * 4;
    updatePlaybackMarkers(beatIndex, 0);
    const { left, rowIndex } = getMeasureXRange(measureIndex);
    drawPlayLine(left, rowIndex);
}

// ===== A-B区間ループ =====
// #abLoopStrip（#seekBarの真下の帯）上でのドラッグでA-B区間を指定する。
// getMeasureIndexForRatio()はA-B区間ループが有効な間、区間内にクランプされる
// （シークバー自体の動く範囲をA-Bの長さだけに制限するため）ため、区間を新しく
// 引き直す/広げ直す用途には使えない（区間の外側が表現できなくなる）。
// このため常に「曲全体」を基準にした専用の変換関数を別に用意する
function measureIndexForFullSongRatio(ratio) {
    const measureCount = score.measures.length;
    if (measureCount <= 0) return null;
    return Math.min(measureCount - 1, Math.max(0, Math.floor(ratio * measureCount)));
}

// #abLoopStripの表示位置・幅を#seekBarの実測位置に揃える（#seekBarRowと
// #abLoopStripRowはCSS上同じmax-width/paddingだが、#seekBar自体は左右の
// 時刻表示スパンの分だけ内側に寄っているため、flexだけでは厳密に一致しない）
function updateAbLoopStripGeometry() {
    const seekBar = document.getElementById("seekBar");
    const strip = document.getElementById("abLoopStrip");
    const stripRow = document.getElementById("abLoopStripRow");
    if (!seekBar || !strip || !stripRow) return;
    const seekRect = seekBar.getBoundingClientRect();
    const rowRect = stripRow.getBoundingClientRect();
    strip.style.left = `${seekRect.left - rowRect.left}px`;
    strip.style.width = `${seekRect.width}px`;
}

// abLoopRange（常に値を持つ、デフォルトは曲の端から端まで）に応じて帯の表示を更新する。
// あわせて#abLoopToggleBtn（有効/無効トグル）の見た目もここで同期する
function renderAbLoopBand() {
    const band = document.getElementById("abLoopBand");
    const toggleBtn = document.getElementById("abLoopToggleBtn");
    if (!band) return;

    updateSeekBarFillStart();

    if (toggleBtn) {
        toggleBtn.style.color = abLoopEnabled ? "#4a6cf7" : "#ccc";
    }

    if (!abLoopRange) {
        band.style.display = "none";
        return;
    }

    // トグルOFF中は、区間自体は保持しつつも「今は効いていない」ことが分かるよう帯を薄くする
    band.style.opacity = abLoopEnabled ? "1" : "0.4";

    const measureCount = score.measures.length;
    const startRatio = abLoopRange.startMeasureIndex / measureCount;
    const endRatio = (abLoopRange.endMeasureIndex + 1) / measureCount;
    band.style.display = "";
    band.style.left = `${startRatio * 100}%`;
    band.style.width = `${(endRatio - startRatio) * 100}%`;
}

// A/Bの位置調整は、帯の上のどこをドラッグしても新しい区間を引き直せる方式だと、
// 「何もない場所」をドラッグしただけでも区間が変わってしまい紛らわしいため廃止した。
// 位置調整は開始（A）/終了（B）の各ハンドルを個別につまむ操作のみで行う
function setupAbLoopStrip() {
    const strip = document.getElementById("abLoopStrip");
    if (!strip) return;
    resetAbLoopRangeToFull();
    renderAbLoopBand();

    setupAbLoopHandle(document.getElementById("abLoopHandleA"), "start");
    setupAbLoopHandle(document.getElementById("abLoopHandleB"), "end");
}

// 開始（A）/終了（B）のハンドルを個別につまんで動かす。区間の引き直し
// （setupAbLoopStrip本体側のドラッグ）とは別の、既存区間の微調整用の操作
function setupAbLoopHandle(handle, which) {
    if (!handle) return;
    let dragging = false;

    handle.addEventListener("pointerdown", (e) => {
        if (!abLoopRange) return;
        dragging = true;
        e.stopPropagation();
        e.preventDefault();
    });

    document.addEventListener("pointermove", (e) => {
        if (!dragging || !abLoopRange) return;
        const strip = document.getElementById("abLoopStrip");
        if (!strip) return;
        const rect = strip.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        const measureIndex = measureIndexForFullSongRatio(ratio);
        if (measureIndex === null) return;

        // 相手側の端との間に最低1小節分の間隔を保ったままクランプする
        if (which === "start") {
            const clamped = Math.max(0, Math.min(measureIndex, abLoopRange.endMeasureIndex - 1));
            abLoopRange = { ...abLoopRange, startMeasureIndex: clamped };
        } else {
            const clamped = Math.min(score.measures.length - 1, Math.max(measureIndex, abLoopRange.startMeasureIndex + 1));
            abLoopRange = { ...abLoopRange, endMeasureIndex: clamped };
        }
        renderAbLoopBand();
    });

    document.addEventListener("pointerup", () => {
        if (!dragging) return;
        dragging = false;
        if (!abLoopRange) return;
        updateSeekBar();
        // Aを動かした場合だけ、練習中に今聴いている位置を新しいAへ合わせる
        // （Bを動かした場合は、次のループの折り返し地点が変わるだけで十分なので
        // 再生位置をジャンプさせない）。一時停止中も、再開時に古いスケジュールの
        // ままだと新しいAより前（旧区間側）が鳴ってしまうため、playing同様に組み直す
        if (which === "start" && (playState === "playing" || playState === "paused")) {
            restartPlaybackFromMeasure(abLoopRange.startMeasureIndex);
        }
    });
}

function trackPlayback() {
    if (playState !== "playing" || !audioCtx) return;

    const now = audioCtx.currentTime;

    if (now >= playEndTime) {
        finishPlayback();
        return;
    }

    updateSeekBar();

    // ドラッグ中は'input'ハンドラ側のpreviewSeekHighlight()がハイライト表示を担当して
    // いるため、ここで実際の（まだ古い位置の）再生時刻に基づく表示に書き戻さない
    if (!isSeekDragging) {
        const current = noteSchedule.find(s => now >= s.startTime && now < s.endTime);
        if (current && current.measureIndex !== currentHighlightMeasure) {
            currentHighlightMeasure = current.measureIndex;
            highlightMeasure(currentHighlightMeasure);
        }

        const currentBeat = beatSchedule.find(b => now >= b.startTime && now < b.endTime);
        if (currentBeat) {
            // レール上のマーカーは、このビートから次のビートへ1拍ぶんの時間で移動する
            const beatT = (now - currentBeat.startTime) / (currentBeat.endTime - currentBeat.startTime);
            currentHighlightBeatIndex = currentBeat.beatIndex;
            currentHighlightBeatT = beatT;
            updatePlaybackMarkers(currentBeat.beatIndex, beatT);
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
    }

    animFrameId = requestAnimationFrame(trackPlayback);
}

function highlightMeasure(measureIndex) {
    document.querySelectorAll(".measureGroup").forEach((group, i) => {
        if (i === measureIndex) {
            group.style.outline = "2px solid #4a6cf7";
            group.style.borderRadius = "8px";
        } else {
            group.style.outline = "none";
        }
    });
}

// マップ上のレールの再生位置を、五線譜のdrawPlayLineと同じ「1本のマーカーを毎フレーム
// 描き直す」方式で示す。マス目を1つずつ塗り替える方式（旧highlightRailStep）は、
// 整数ステップが変わるたびに多数のセルのbackgroundを書き換えるため、点滅して見える
// ちらつきの原因になっていた。
// 位置はマス目のrailStep（複数ビートが同じマスを取り合って上書きし合うため欠番が
// 飛び飛びに生じ、境界付近でどのマスを最寄りとするかが1フレームごとに揺れて残像のように
// 見えてしまっていた）ではなく、ビート番号beatIndexとそのビート内の経過tから
// 毎回同じ結果になるよう直接求める。段の折り返し（改行）をまたぐ瞬間は、
// 画面上は離れた行へ大きく動くが、これはビートbeatIndexから次のビートbeatIndex+1への
// 移動を1拍ぶんの時間で一定速度になめらかに描いているだけで、揺れたり消えたりはしない
function drawMapPlayLine(beatIndex, t) {
    // querySelectorだと万が一複数残っていた場合に1つしか消せず残像の原因になるため、
    // 必ずquerySelectorAllで全部消してから作り直す
    document.querySelectorAll(".mapPlayLine").forEach(el => el.remove());
    if (beatIndex == null) return;

    // #mapGridはcanvas化されており、その子としてDOMをappendしても描画されない
    // （canvasの子ノードはフォールバックコンテンツ扱いで画面には出ない）ため、
    // 選択ハイライト（drawMapSelectionOverlays）と同様に#mapAreaWrapperへ追加し、
    // canvasの実際の画面位置ぶんを座標に加算する
    const canvas = document.getElementById("mapGrid");
    const wrapper = document.getElementById("mapAreaWrapper");
    const posA = mapBeatPositions[beatIndex];
    if (!canvas || !wrapper || !posA) return;
    let posB = mapBeatPositions[beatIndex + 1] || posA;

    // 段の折り返し（wrapValueごとの改行）をまたぐ瞬間は、beatIndexとbeatIndex+1が
    // レール上で隣接しておらず、段の端から次の段の端まで大きく離れた座標になる
    // （折り返しは連続した1本のレールが続くのではなく、行の先頭に戻る形のため）。
    // これをそのまま補間すると、マーカーが何もない場所を横切って飛んでいくように
    // 見えてしまうため、1マス分より離れている場合は補間せず次の位置へ瞬時に切り替える
    if (mapRailCellSize > 0) {
        const dx = posB.x - posA.x;
        const dy = posB.y - posA.y;
        if (Math.hypot(dx, dy) > mapRailCellSize * 1.5) {
            posB = posA;
        }
    }

    // posA/posBはcanvasローカル座標（canvasの左上を原点とするpx）。#mapAreaWrapper基準の
    // 座標に変換するため、canvasの実際の表示位置とwrapperのスクロール量を加算する
    // （選択ハイライトのcreateMapOverlayEl()と同じ変換パターン）
    const canvasRect = canvas.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const offsetX = canvasRect.left - wrapperRect.left + wrapper.scrollLeft;
    const offsetY = canvasRect.top - wrapperRect.top + wrapper.scrollTop;

    const localX = posA.x + (posB.x - posA.x) * t;
    const localY = posA.y + (posB.y - posA.y) * t;
    const x = localX + offsetX;
    const y = localY + offsetY;

    const w = mapRailIsVertical ? mapRailCellSize * 0.4 : mapRailCellSize * 0.9;
    const h = mapRailIsVertical ? mapRailCellSize * 0.9 : mapRailCellSize * 0.4;

    const line = document.createElement("div");
    line.className = "mapPlayLine";
    line.style.cssText = `
        position: absolute;
        left: ${x - w / 2}px;
        top: ${y - h / 2}px;
        width: ${w}px;
        height: ${h}px;
        background: rgba(255, 209, 0, 0.9);
        border-radius: 3px;
        pointer-events: none;
        z-index: 8;
    `;
    wrapper.appendChild(line);
}

// 2Dマップ・プレビュー(3D)どちらでも再生中のトロッコ位置を表示する共通ヘルパー。
// updateAssemblyPlayMarker()はプレビュー用のThree.jsシーンがまだ無い（一度もタブを
// 開いていない）場合は内部で何もしない
function updatePlaybackMarkers(beatIndex, t = 0) {
    drawMapPlayLine(beatIndex, t);
    updateAssemblyPlayMarker(beatIndex, t);
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

// これまでデフォルトだった実際の描画倍率(0.75)を、UI上は「100%」として見せるための
// 基準値。scale(実際の描画に使う倍率)とズーム%表示(statusZoom)を切り離すことで、
// 見た目のサイズは変えずに「今まで75%だったものを100%と呼ぶ」を実現している
const ZOOM_DISPLAY_BASE = 0.75;
// ズームスライダーの可動範囲（実際の描画倍率）。表示%は(scale/ZOOM_DISPLAY_BASE)*100なので、
// ZOOM_MIN/MAXは「表示50%〜200%にしたい」から逆算した値（0.5・2.0 に ZOOM_DISPLAY_BASE を掛けたもの）。
// ズームイン/アウトボタンやCtrl+ホイールのクランプ値もここに揃える
const ZOOM_MIN = 0.375;
const ZOOM_MAX = 1.5;

const DURATION_ORDER = ["16", "8", "q", "h", "w"];
const durationBeats = { "w": 4, "h": 2, "q": 1, "8": 0.5, "16": 0.25 };
const DURATION_LABELS = { "w": "全音符", "h": "2分音符", "q": "4分音符", "8": "8分音符", "16": "16分音符" };
const COMPASS_LABELS = ["N↑", "N→", "N↓", "N←"];

// コンパスボタンはマップタブ用（#compassLabel）と組み立てプレビュー用
// （#assemblyCompassLabel）の2箇所にあるため、.compass-labelクラスでまとめて更新する
function updateCompassLabels() {
    document.querySelectorAll(".compass-label").forEach(el => {
        el.textContent = COMPASS_LABELS[northDirection];
    });
}

// MusicXML書き出し/読み込み用。4分音符=8単位とすると、5音価×付点あり/なしの
// 全10通り（最小0.25拍〜最大6拍）がすべて整数になる（最小のdivisions値）
const MUSICXML_DIVISIONS = 8;
const DURATION_TO_XML_TYPE = { "16": "16th", "8": "eighth", "q": "quarter", "h": "half", "w": "whole" };
const XML_TYPE_TO_DURATION = Object.fromEntries(
    Object.entries(DURATION_TO_XML_TYPE).map(([code, type]) => [type, code])
);

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

// MusicXML書き出し/読み込み用。調号コード⇔<fifths>（符号付き五度圏カウント、
// 負値=フラット系）の対応。SHARP_KEY_ORDER/FLAT_KEY_ORDERはアクセント文字の
// 付加順テーブルで符号の向きが違うため、流用せず素直に新規定義する
const KEY_SIG_FIFTHS = {
    C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, "F#": 6, "C#": 7,
    F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
};
const FIFTHS_TO_KEY_SIG = Object.fromEntries(
    Object.entries(KEY_SIG_FIFTHS).map(([key, fifths]) => [fifths, key])
);

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
    "toolbarKeySig", "toolbarTranspose"
];

function applyTabVisibility() {
    const isBoth    = activeTab === "both";
    const showScore = activeTab === "score" || isBoth;
    const showMap   = activeTab === "map"   || isBoth;

    // 「両方」タブの時だけ、五線譜/マップを均等2分割するgridレイアウトを有効にするクラス。
    // 単体タブ表示（子は1つだけ表示）にはこのレイアウトを適用しない
    const bothTabContainer = document.getElementById("bothTabContainer");
    if (bothTabContainer) bothTabContainer.classList.toggle("bothTabActive", isBoth);

    // 五線譜エリア
    document.getElementById("scoreWrapper").style.display = showScore ? "" : "none";

    // パネルカウント（音符マット数・レール数・センサー数）は全タブ共通で常に表示する
    document.getElementById("panelCount").style.display = "flex";

    // マップエリア（リサイズハンドルも含むラッパーごと表示切替）
    const mapAreaWrapper = document.getElementById("mapAreaWrapper");
    if (mapAreaWrapper) {
        mapAreaWrapper.style.display = showMap ? "" : "none";
        mapAreaWrapper.style.marginTop = "0";
    }

    // マップ専用ツールバー
    const mapToolbar = document.getElementById("mapToolbar");
    if (mapToolbar) mapToolbar.style.display = showMap ? "flex" : "none";

    // 組み立てプレビュー（Three.js）エリア
    const assemblyAreaWrapper = document.getElementById("assemblyAreaWrapper");
    if (assemblyAreaWrapper) assemblyAreaWrapper.style.display = activeTab === "assembly" ? "" : "none";

    // コンパス・「表示する層」ボタンは、マップ専用ツールバーではなく音符マットエリア上に
    // 浮かせて表示する独立したオーバーレイなので、別途表示切替する
    const mapCornerOverlay = document.getElementById("mapCornerOverlay");
    if (mapCornerOverlay) mapCornerOverlay.style.display = showMap ? "flex" : "none";

    // 五線譜タブのみで使うツールバー。表示する場合はinline style自体を外し、
    // CSS側のdisplay指定（.toolbarのflex）をそのまま活かす
    SCORE_ONLY_TOOLBAR_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showScore ? "" : "none";
    });

    // ヘルプは五線譜エリア右上に重ねる絶対配置のオーバーレイになったため、
    // レイアウトの高さには影響しない。五線譜が見えているタブ（五線譜/並べて）では常に表示する
    const infoWrap = document.getElementById("infoWrap");
    if (infoWrap) infoWrap.style.display = showScore ? "block" : "none";

    // タブボタンのアクティブ状態を更新
    TABS.forEach(tab => {
        const btn = document.getElementById(`tab-${tab.id}`);
        if (!btn) return;
        btn.classList.toggle("tab-active", tab.id === activeTab);
    });
    updateTabIndicator();

    // 編集モード/コピー・切り取り・貼り付けボタンは、マップ単体タブかどうかで
    // 使える/使えないが変わるため、タブ切替のたびに有効/無効を更新する
    updateEditModeButtons();
}

// アクティブなタブボタンの位置/幅に、タブ切替インジケーター（白いピル背景）を追従させる。
// animate=falseの場合はtransitionを止めて瞬時に配置する（初回描画時、位置ズレした
// 状態からスライドしてくるように見えるのを防ぐため）
function updateTabIndicator(animate = true) {
    const indicator = document.getElementById("tabActiveIndicator");
    const activeBtn = document.getElementById(`tab-${activeTab}`);
    if (!indicator || !activeBtn) return;

    if (!animate) {
        indicator.style.transition = "none";
        indicator.style.left = `${activeBtn.offsetLeft}px`;
        indicator.style.width = `${activeBtn.offsetWidth}px`;
        void indicator.offsetWidth; // reflowを強制してから元のtransitionへ戻す
        indicator.style.transition = "";
        return;
    }
    indicator.style.left = `${activeBtn.offsetLeft}px`;
    indicator.style.width = `${activeBtn.offsetWidth}px`;
}

function switchTab(tabId) {
    if (activeTab === tabId) {
        // 「並べて」タブをすでに表示中にもう一度押した場合は、タブ自体の切り替えは
        // 何も起きないはずの操作だが、その代わりにレイアウトボタン（左右入れ替え）と
        // 同じ効果を発生させる
        if (tabId === "both") rotateBothTabLayout();
        return;
    }
    const previousTab = activeTab;
    activeTab = tabId;
    localStorage.setItem("activeTab", activeTab);
    applyTabVisibility();
    if (activeTab === "both") applyBothTabLayout();
    updateBothTabContainerHeight(); // 他タブへ切り替えた場合、両方タブ用の高さ指定を解除する
    updateContentAreaMinHeights();
    if (activeTab === "score" || activeTab === "both") {
        renderScore();
        setupDeleteButtons();
        setupInsertButtons();
    }
    if (activeTab === "map" || activeTab === "both") {
        renderMap();
    }
    if (activeTab === "assembly") {
        renderAssemblyPreview();
    }
    // 組み立てプレビューから離れる時は、見えていない間ムダにフレームを描き続けないよう
    // レンダーループを止める（戻ってきた時はrenderAssemblyPreview()が再開する）
    if (previousTab === "assembly" && activeTab !== "assembly") {
        stopAssemblyRenderLoop();
    }
    playTabSwitchAnimation();
}

// タブ切替時、新しく表示された中身をふわっとフェードイン（+わずかに下からスライド）させる
function playTabSwitchAnimation() {
    const main = document.getElementById("main");
    if (!main) return;
    main.classList.remove("tab-content-fade");
    void main.offsetWidth; // reflowを強制してアニメーションを最初からやり直させる
    main.classList.add("tab-content-fade");
}

// マップ設定
let mapSettings = {
    railDirection: "vertical",   // "vertical" | "horizontal"
    startCorner: "top-left",     // "top-left" | "top-right" | "bottom-left" | "bottom-right"
    sideFirst: "left",           // "left" | "right" （どちら側のセンサーを先にするか）
    wrapValue: 50,               // 折り返し値（一列あたりのセンサー数。レール1マス=センサー1個のためマス数と同義）
    hideUnusedSensors: false,    // true=周りに音符マットがないセンサーを配置しない（カウントにも含めない）
    activeLayer: "middle",       // "middle" | "upper" | "lower" （表示する層）
};

// 層名⇔グリッドのz座標の対応。中間層=0（センサーが存在するのはここだけ）、
// 上位層=+1・下位層=-1（レールのみ中間層と同じ位置に複製表示する）
const MAP_LAYER_Z = { middle: 0, upper: 1, lower: -1 };
// 上下ボタンで切り替える際の並び順（上位層→中間層→下位層）
const MAP_LAYER_ORDER = ["upper", "middle", "lower"];

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
        // 上段・下段で同じ音（異名同音表記の違いも含む）が同時に鳴っている場合、
        // 物理的には同じ音符マット1枚で表現できるため、重複を1つにまとめる
        const seenCanonical = new Set();
        const pitches = [...upperPitches, ...lowerPitches].filter(p => {
            const key = toCanonicalPitch(p);
            if (seenCanonical.has(key)) return false;
            seenCanonical.add(key);
            return true;
        });
        return {
            measureIndex: u.measureIndex,
            note: pitches.length ? { pitches, rest: false } : { rest: true },
            isFirst: true
        };
    });
}

// 中間層3枠+上位層4枠+下位層4枠（計11枠、センサー中心を(0,0)としたローカル座標、
// 斜め隣接は使用しない）への音符マット割り当てを、進行方向ベクトル(forwardVec)・
// レールと反対方向ベクトル(awayVec)を使って実グリッドオフセットに変換する共通処理。
// forwardVec/awayVecはどちらも{dx,dy}が-1/0/1のいずれかの単位ベクトル。
// 直線モードでは常に固定ベクトル、スネークモードでは経路上の位置ごとに変化するベクトルを渡す。
function calcPanelPositionsCore(pitches, forwardVec, awayVec) {
    // 音の優先順位（固定）: 中間層(遠い→横→近い) → 上位層(遠い→横→近い→センサー直上) →
    // 下位層(遠い→横→近い→センサー直下)。上位層/下位層の4つ目はセンサーそのものの
    // 位置（lat:0,trav:0）に積む
    const midRank = [
        {lat: 0, trav: 1, z: 0},   // 遠い
        {lat: -1, trav: 0, z: 0},  // 横（レールと反対側）
        {lat: 0, trav: -1, z: 0},  // 近い
    ];
    const upperRank = [
        {lat: 0, trav: 1, z: 1},
        {lat: -1, trav: 0, z: 1},
        {lat: 0, trav: -1, z: 1},
        {lat: 0, trav: 0, z: 1},   // センサー直上
    ];
    const lowerRank = [
        {lat: 0, trav: 1, z: -1},
        {lat: -1, trav: 0, z: -1},
        {lat: 0, trav: -1, z: -1},
        {lat: 0, trav: 0, z: -1},  // センサー直下
    ];
    const fullRank = [...midRank, ...upperRank, ...lowerRank]; // 3+4+4=11枠

    const positions = [];
    pitches.forEach((pitch, i) => {
        if (i >= fullRank.length) return;
        const slot = fullRank[i];
        const dx = slot.trav * forwardVec.dx - slot.lat * awayVec.dx;
        const dy = slot.trav * forwardVec.dy - slot.lat * awayVec.dy;
        positions.push({ relX: dx, relY: dy, z: slot.z, pitch });
    });
    return positions;
}

function updateMapToolbarUI() {
    const { railDirection, startCorner, sideFirst, wrapValue, hideUnusedSensors, activeLayer } = mapSettings;

    const setActive = (id, active) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.color = active ? "#3451d1" : "#767676";
        el.style.background = active ? "#eaefff" : "";
    };

    MAP_LAYER_ORDER.forEach(layer => {
        const bar = document.querySelector(`.map-layer-bar[data-layer="${layer}"]`);
        if (bar) bar.classList.toggle("active", activeLayer === layer);
    });
    const layerIdx = MAP_LAYER_ORDER.indexOf(activeLayer);
    const layerUpBtn = document.getElementById("mapLayerUp");
    const layerDownBtn = document.getElementById("mapLayerDown");
    if (layerUpBtn) layerUpBtn.disabled = layerIdx <= 0;
    if (layerDownBtn) layerDownBtn.disabled = layerIdx >= MAP_LAYER_ORDER.length - 1;

    setActive("mapRailVertical",   railDirection === "vertical");
    setActive("mapRailHorizontal", railDirection === "horizontal");
    setActive("mapCorner-top-left",     startCorner === "top-left");
    setActive("mapCorner-top-right",    startCorner === "top-right");
    setActive("mapCorner-bottom-left",  startCorner === "bottom-left");
    setActive("mapCorner-bottom-right", startCorner === "bottom-right");
    setActive("mapSideLeft",  sideFirst === "left");
    setActive("mapSideRight", sideFirst === "right");
    setActive("mapShowUnusedSensors", !hideUnusedSensors);
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
    //
    // ただし、この「理論上の最大フットプリント」は表示位置を安定させるためのbounding box
    // 拡張であり、必ずしも「実際にその段の何らかの小節がそこまで存在する」ことは意味しない。
    // 特に最後の段は、曲の総拍数がwrapSensorsで割り切れない場合、実際のビートが並ぶのは
    // 途中までで、そこから先（wrapSensors分の理論上の幅の残り）は完全な空白になる。
    // この「予約されているだけで実際には何も無い」座標をdeadZoneCoordsに記録しておき、
    // renderMap()側でクリック/ドラッグ選択の対象外（見た目の余白と同様の扱い）にする
    const deadZoneCoords = new Set();
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

            // この段に実際に存在するビート数（最後の段以外は必ずwrapSensors分フル）
            const actualBeatsInBand = colIdx < maxColIdxInclusive
                ? wrapSensors
                : totalBeats - maxColIdxInclusive * wrapSensors;
            // レールは1ビートにつき3マス（進行軸方向に-1,0,+1）の帯として描画されるが、
            // 段の最初/最後のビートだけは、実在しない隣の段へ向かってはみ出さないよう
            // その方向のマスを描画しない（詳しくはレール配置ループ側のコメントを参照）。
            // そのため dead zone は actualBeatsInBand の位置（最後のビートより1マス先、
            // 従来ならレールがはみ出していた位置）から始めてよい
            for (let rowIdx = actualBeatsInBand; rowIdx < wrapSensors; rowIdx++) {
                const tp = travelSign * rowIdx;
                for (let lateral = -3; lateral <= 3; lateral++) {
                    const bx = isVertical ? bandWrapOffset + lateral : tp;
                    const by = isVertical ? tp : bandWrapOffset + lateral;
                    deadZoneCoords.add(`${bx},${by}`);
                }
            }
        }
    }

    // 各ビートのレール中心座標(sX,sY)。再生中の位置マーカー(drawMapPlayLine)が、
    // マス目のrailStep（複数ビートが同じマスを取り合って上書きし合うため欠番が飛び飛びに
    // 生じる、実体のあるマスだけの断片的な値）ではなく、ビート番号そのものを使って
    // 途切れなく位置を求められるようにするために残しておく
    const beatCenters = [];

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

        // レール自体の中心マス（d=0の位置。センサーはここからlateralPosぶんずれた位置）
        beatCenters[beatIdx] = {
            x: isVertical ? wrapOffset : travelPos,
            y: isVertical ? travelPos : wrapOffset,
        };

        const sX = isVertical ? wrapOffset + lateralPos : travelPos;
        const sY = isVertical ? travelPos : wrapOffset + lateralPos;

        const forwardVec = isVertical ? { dx: 0, dy: travelSign } : { dx: travelSign, dy: 0 };
        const awayVec = isVertical ? { dx: lateralPos > 0 ? 1 : -1, dy: 0 } : { dx: 0, dy: lateralPos > 0 ? 1 : -1 };

        // 段の最初/最後のビートかどうか（最後の段は総拍数の都合でwrapSensors未満で
        // 終わることがあるため、totalBeatsの終端も「最後」として扱う）
        const isFirstInRow = rowIdx === 0;
        const isLastInRow = rowIdx === wrapSensors - 1 || beatIdx === totalBeats - 1;

        // dの並びは進行方向の符号に応じて時間順になるようにする
        const dOrder = travelSign === 1 ? [-1, 0, 1] : [1, 0, -1];
        dOrder.forEach((d, posInTriplet) => {
            // 段の最初のビートは1マス手前（-travelSign方向）、最後のビートは1マス先
            // （+travelSign方向）のレールマスを描画しない。段同士は実際には接続されておらず
            // （折り返しは連続した1本のレールではなく、行の先頭に戻る形）、このはみ出しマスが
            // 隣の段の方向へ向かって描かれると、あたかも段同士がつながっているように見えてしまう
            if (isFirstInRow && d === -travelSign) return;
            if (isLastInRow && d === travelSign) return;

            const rx = isVertical ? wrapOffset : travelPos + d;
            const ry = isVertical ? travelPos + d : wrapOffset;
            const railData = {
                type: "rail",
                direction: railDirection,
                railStep: beatIdx * 3 + posInTriplet,
                measureIndex: beat.measureIndex,
                // 折り返し（改行）をまたぐ小節では、レールが離れた場所に分かれて存在するため、
                // 選択枠を計算する際にどの段（レール1本分）に属するかを区別できるようにしておく
                band: colIdx,
            };
            // レールは中間層だけでなく、上位層・下位層にも同じ位置にそのまま複製表示する
            // （センサーは中間層にしか無い。実際の物理レールが3層分あるわけではないが、
            // 上位層/下位層を見たときにもレールの通り道が分かるよう表示だけ複製する）
            setCell(rx, ry, 0, railData);
            setCell(rx, ry, 1, railData);
            setCell(rx, ry, -1, railData);
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
                measureIndex: beat.measureIndex,
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
                    measureIndex: beat.measureIndex,
                });
                markExtent(px, py);
            });
        }
    }

    const extent = extentMinX === Infinity
        ? null
        : { minX: extentMinX, maxX: extentMaxX, minY: extentMinY, maxY: extentMaxY };

    return { grid, totalBeats, extent, separatorCoords, isVertical, deadZoneCoords, beatCenters };
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

// 音符/休符グループ（#toolbarDuration）は、ツールバー内（#toolbarDurationToolbarSlot、
// 2段目）にドッキングされた状態で表示される。左端のグリップハンドルをドラッグすると
// 切り離されてposition:fixedのフローティングパネルになり、画面上の任意の位置に配置できる。
// フローティング中にツールバー付近までドラッグして離すと、再びドッキングされる。
// 位置・ドッキング状態はセッション内でのみ保持し、ページ再読み込み（F5）のたびに
// 必ず初期位置（ドッキング状態）へ戻す（永続化はあえてしない）
const NOTE_TOOLBAR_UNDOCK_THRESHOLD_PX = 20;
const NOTE_TOOLBAR_DOCK_ZONE_MARGIN_PX = 40;
let noteToolbarDocked = true; // ドッキング中かどうか（フローティング中はfalse）

// ドッキング先のスロット要素を返す
function getNoteToolbarSlot() {
    return document.getElementById("toolbarDurationToolbarSlot");
}

function clampNoteToolbarPos(x, y) {
    const el = document.getElementById("toolbarDuration");
    const w = el.offsetWidth || 200;
    const h = el.offsetHeight || 40;
    const maxX = Math.max(0, window.innerWidth - w);
    const maxY = Math.max(0, window.innerHeight - h);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
}

function applyNoteToolbarPos(x, y) {
    const el = document.getElementById("toolbarDuration");
    if (!el) return;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
}

// ドッキング先スロットへ戻す。#toolbarDuration自体の表示/非表示は
// SCORE_ONLY_TOOLBAR_IDSの処理（五線譜表示中のみ表示）に任せているので、
// ここではスロットへ差し込むだけでよい
function dockNoteToolbar() {
    const el = document.getElementById("toolbarDuration");
    const slot = getNoteToolbarSlot();
    if (!el || !slot) return;
    el.classList.remove("floating", "snapping");
    el.style.left = "";
    el.style.top = "";
    slot.appendChild(el);
    noteToolbarDocked = true;
}

// ドッキング判定に使う領域（ツールバー行）に、指定した位置が十分近いかどうかを返す
function isNearNoteToolbarDockZone(rect) {
    const toolbarsEl = document.getElementById("tabRow");
    if (!toolbarsEl) return false;
    const tz = toolbarsEl.getBoundingClientRect();
    return rect.top < tz.bottom + NOTE_TOOLBAR_DOCK_ZONE_MARGIN_PX;
}

// ドッキングした場合に実際に収まる位置（スロット）を概算する。
// ドラッグ中にこの位置へ「吸い付いて」見せることで、離せばここにドッキングされることを予告する
function computeNoteToolbarDockSnapPos() {
    const slot = getNoteToolbarSlot();
    if (!slot) return null;
    const slotRect = slot.getBoundingClientRect();
    return { x: slotRect.left, y: slotRect.bottom + 4 };
}

// ドッキング先スロットのフローから切り離し、body直下でposition:fixedのフローティングパネルにする
function undockNoteToolbar(x, y) {
    const el = document.getElementById("toolbarDuration");
    if (!el) return;
    document.body.appendChild(el);
    el.classList.add("floating");
    noteToolbarDocked = false;
    const clamped = clampNoteToolbarPos(x, y);
    applyNoteToolbarPos(clamped.x, clamped.y);
}

function setupNoteToolbarDrag() {
    const el = document.getElementById("toolbarDuration");
    const handle = document.getElementById("toolbarDurationHandle");
    if (!el || !handle) return;

    dockNoteToolbar(); // 常にツールバー（2段目）のドッキング状態から開始する

    let dragging = false;
    // このドラッグ操作で実際にフローティングパネルとして位置更新が行われたか
    // （＝ドッキング中なら閾値を超えて切り離された後、フローティング中なら常にtrue）。
    // falseのまま終わった場合は単なるクリック（ボタン誤反応防止のため何もしない）
    let hasMoved = false;
    let startX = 0, startY = 0, baseX = 0, baseY = 0;

    handle.addEventListener("mousedown", (e) => {
        dragging = true;
        hasMoved = !noteToolbarDocked; // 既にフローティング中なら最初から追従対象
        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        baseX = rect.left;
        baseY = rect.top;
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        if (!hasMoved) {
            // ドッキング中は、単なるクリックと区別するため一定量動かすまでは何もしない。
            // 閾値を超えた瞬間、現在の見た目位置を維持したまま切り離す（位置が飛ばないように）
            if (Math.hypot(dx, dy) < NOTE_TOOLBAR_UNDOCK_THRESHOLD_PX) return;
            const rect = el.getBoundingClientRect();
            undockNoteToolbar(rect.left, rect.top);
            baseX = rect.left;
            baseY = rect.top;
            hasMoved = true;
        }

        const { x, y } = clampNoteToolbarPos(baseX + dx, baseY + dy);
        const freeRect = { top: y, left: x, bottom: y + (el.offsetHeight || 40) };
        if (isNearNoteToolbarDockZone(freeRect)) {
            // ドックゾーン内: 実際にドッキングした場合の位置へ吸い付かせ、予告の枠線を表示する
            const snap = computeNoteToolbarDockSnapPos();
            el.classList.add("snapping");
            if (snap) applyNoteToolbarPos(snap.x, snap.y);
            else applyNoteToolbarPos(x, y);
        } else {
            el.classList.remove("snapping");
            applyNoteToolbarPos(x, y);
        }
    });

    document.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        if (!hasMoved) return; // 閾値未満のまま終わった＝ただのクリック、何もしない

        el.classList.remove("snapping");
        const rect = el.getBoundingClientRect();
        if (isNearNoteToolbarDockZone(rect)) {
            dockNoteToolbar();
        }
    });

    // ウィンドウリサイズで画面外にはみ出さないよう追従させる（フローティング時のみ）
    window.addEventListener("resize", () => {
        if (noteToolbarDocked) return;
        const rect = el.getBoundingClientRect();
        const { x, y } = clampNoteToolbarPos(rect.left, rect.top);
        applyNoteToolbarPos(x, y);
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

// 「並べて」タブの左右パネル境界線のドラッグ操作。ドラッグ中は軽いgrid-template-columnsの
// 書き換えだけに留め（五線譜の折返し再計算はコストが高く、毎フレーム行うともっさりする）、
// ドラッグが終わった時点で一度だけ折返し再計算・localStorageへの保存を行う
function setupBothTabDivider() {
    const divider = document.getElementById("bothTabDivider");
    const container = document.getElementById("bothTabContainer");
    if (!divider || !container) return;

    let dragging = false;
    // mousemoveは1フレームに何度も発火しうるため、五線譜の再描画（renderScore、
    // コストが高い）はフレームごとに1回だけに間引く。grid-template-columnsの
    // 書き換え自体は軽いので、そちらは毎回そのまま反映する
    let rafPending = false;

    divider.addEventListener("mousedown", (e) => {
        // 境界線上に重ねて置いた「左右を入れ替え」ボタンをクリックした場合は、
        // 幅調整のドラッグを開始しない
        if (e.target.closest("#bothLayoutRotate")) return;
        dragging = true;
        divider.classList.add("dragging");
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const rect = container.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        bothSplitRatio = Math.min(0.85, Math.max(0.15, ratio));
        applyBothSplitRatio();

        if (!rafPending) {
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                renderScore();
                setupDeleteButtons();
                setupInsertButtons();
            });
        }
    });

    document.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        divider.classList.remove("dragging");
        localStorage.setItem("bothSplitRatio", bothSplitRatio);
        updateContentAreaMinHeights();
        renderScore();
        setupDeleteButtons();
        setupInsertButtons();
        if (activeTab === "both") renderMap();
    });

    // 境界線中央の「左右を入れ替え」ボタンは、クリックでの左右入れ替えに加え、
    // ドロワー開閉ボタンと同様に押したまま上下にドラッグして縦位置を動かせるようにする
    // （transform:translate(-50%,-50%)により、CSSのtopがそのままボタン中心のY座標になる）
    const rotateBtn = document.getElementById("bothLayoutRotate");
    if (rotateBtn) {
        const savedRotateTop = localStorage.getItem("bothLayoutRotateTop");
        if (savedRotateTop) rotateBtn.style.top = savedRotateTop;

        const ROTATE_DRAG_THRESHOLD_PX = 4;
        let rotateDragState = null;

        rotateBtn.addEventListener("mousedown", (e) => {
            const dividerRect = divider.getBoundingClientRect();
            const startCenterY = rotateBtn.getBoundingClientRect().top + rotateBtn.offsetHeight / 2 - dividerRect.top;
            rotateDragState = { startY: e.clientY, startCenterY, moved: false };
            e.preventDefault();
        });

        document.addEventListener("mousemove", (e) => {
            if (!rotateDragState) return;
            const dy = e.clientY - rotateDragState.startY;
            if (!rotateDragState.moved && Math.abs(dy) > ROTATE_DRAG_THRESHOLD_PX) rotateDragState.moved = true;
            if (!rotateDragState.moved) return;
            const dividerRect = divider.getBoundingClientRect();
            const halfHeight = rotateBtn.offsetHeight / 2;
            const newCenterY = Math.max(halfHeight, Math.min(dividerRect.height - halfHeight, rotateDragState.startCenterY + dy));
            rotateBtn.style.top = `${newCenterY}px`;
        });

        document.addEventListener("mouseup", () => {
            if (!rotateDragState) return;
            if (!rotateDragState.moved) {
                rotateBothTabLayout();
            } else {
                localStorage.setItem("bothLayoutRotateTop", rotateBtn.style.top);
            }
            rotateDragState = null;
        });
    }
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

// renderMap()が呼ばれるたびに1回だけ再構築し、以降のポインタイベント（クリック/ドラッグ）は
// これを読むだけにする（buildMapGrid()をmousemoveのたびに呼び直すのは無駄なため、
// 「レンダリング時に1回」という従来の頻度を保つ）。
// 空スコア等でマップが無い時はnull。
let mapRenderState = null;

function renderMap() {
    const mapArea = document.getElementById("mapArea");
    if (!mapArea) return;

    const cellSize = Math.round(42 * scale * 0.5);
    mapRailCellSize = cellSize;

    const { grid, extent, separatorCoords, isVertical, deadZoneCoords, beatCenters } = buildMapGrid();

    if (!extent) {
        mapArea.innerHTML = "<p style='color:var(--text-faint);padding:16px;'>音符がありません</p>";
        ["mapResizeHandleRight", "mapResizeHandleBottom", "mapResizeHandleCorner"].forEach((id) => {
            const handle = document.getElementById(id);
            if (handle) handle.style.display = "none";
        });
        mapBeatPositions = [];
        mapRenderState = null;
        // 以前はgridDiv（canvas化前は#mapGrid自身）ごと消えていたので暗黙に片付いていたが、
        // 選択ハイライト/再生マーカーは今は#mapAreaWrapperの子として存在するため、
        // ここで明示的に消さないと空スコアに切り替えても残骸が浮いたままになる
        document.querySelectorAll(".mapSelectionOverlay, .mapPlayLine").forEach(el => el.remove());
        updateCountsBar();
        return;
    }

    // グリッドの範囲は、実際に配置されたセルではなく（「未使用センサー非表示」設定の有無で
    // 変わらない）extentを使う。これにより、この設定を切り替えてもレールの描画位置がズレない
    let { minX, maxX, minY, maxY } = extent;
    // どの小節にも属さない「見た目用の余白マス」（下記の+1マージン）をクリック判定から
    // 除外するため、マージンを足す前の実測範囲（＝どこかの小節に属するマスがあり得る範囲）を
    // 別に保持しておく
    const extMinX = minX, extMaxX = maxX, extMinY = minY, extMaxY = maxY;

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

    // 再生中の位置マーカー(drawMapPlayLine)用に、ビートごとのレール中心座標をpx単位に
    // 変換して控えておく。マス目のrailStepではなくビート番号そのものをキーにするため、
    // 複数ビートが同じマスを取り合って上書きし合うことによる欠番の影響を受けない
    mapBeatPositions = beatCenters.map(c => ({
        x: (c.x - minX) * cellSize + cellSize / 2,
        y: (c.y - minY) * cellSize + cellSize / 2,
    }));
    mapRailIsVertical = isVertical;

    // 表示する層（中間層/上位層/下位層）に応じたzを選ぶ
    const z = MAP_LAYER_Z[mapSettings.activeLayer] ?? 0;

    // マス数ぶんのDOM要素を毎回作り直す代わりに、1枚のcanvasにピクセルとして描く
    // （長い曲ではマス数が数万に達し、DOM生成コストがタブ切り替え等のもたつきの
    // 主因になっていたため）。canvas要素自体は使い回し、破棄/再生成しない
    let canvas = document.getElementById("mapGrid");
    if (!canvas || canvas.tagName !== "CANVAS") {
        mapArea.innerHTML = "";
        canvas = document.createElement("canvas");
        canvas.id = "mapGrid";
        mapArea.appendChild(canvas);
    }
    setupCanvasForDPI(canvas, gridW * cellSize, gridH * cellSize);

    // クリック/ドラッグでのヒットテスト用データを、描画そのものより先に用意しておく
    // （画像の遅延読み込み等で描画が後から差し替わっても、クリック判定は常に最新の
    // ジオメトリを参照できるようにするため）
    mapRenderState = buildMapRenderState({
        canvas, grid, z, isVertical, cellSize, minX, minY, gridW, gridH,
        extMinX, extMaxX, extMinY, extMaxY, deadZoneCoords, separatorCoords
    });

    drawMapCanvas(mapRenderState);

    ["mapResizeHandleRight", "mapResizeHandleBottom", "mapResizeHandleCorner"].forEach((id) => {
        const handle = document.getElementById(id);
        if (handle) handle.style.display = "";
    });
    repositionMapResizeHandle(canvas);
    drawMapSelectionOverlays();
    updateCountsBar();

    // 再生中/一時停止中にグリッドが再構築された場合、現在位置のマーカーを再適用する
    if (playState !== "stopped" && currentHighlightBeatIndex !== null) {
        drawMapPlayLine(currentHighlightBeatIndex, currentHighlightBeatT);
    }
}

// canvasのCSS表示サイズ(cssW/cssH)と、実ピクセル数（devicePixelRatio倍）を分離して設定する。
// 高DPI環境で描画がぼやけないようにするための標準的な手法（このアプリでは初めての導入 —
// 従来はVexFlow(SVG)ベースで解像度非依存だったため、DPI対応は今回が初）
function setupCanvasForDPI(canvas, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    canvas._mapDPR = dpr;
}

// renderMap()のたびに1回構築され、以降のヒットテスト（findNearestMapCell等）・
// 選択ハイライト（drawMapSelectionOverlays）から参照される。
// clickableByCoordはmeasureIndexを持つ全セル（rail/sensor/panelいずれも）を
// "x,y" -> measureIndexで引けるようにしたもの（直撃判定をO(1)にする）。
// railOnlyはrailセルだけを抜き出した配列（クリック位置が直撃しなかった時の
// 最近傍探索=mapCellWeightedDistance用、railセルのみが対象なのは元のDOM版と同じ）
function buildMapRenderState({ canvas, grid, z, isVertical, cellSize, minX, minY, gridW, gridH,
                                extMinX, extMaxX, extMinY, extMaxY, deadZoneCoords, separatorCoords }) {
    const clickableByCoord = new Map();
    const railOnly = [];
    for (const [key, data] of grid) {
        if (data.measureIndex === undefined) continue;
        const parts = key.split(",");
        if (Number(parts[2]) !== z) continue; // 現在表示中の層のセルだけが対象（従来もDOMは現在層のぶんしか作られていなかった）
        const x = Number(parts[0]), y = Number(parts[1]);
        clickableByCoord.set(`${x},${y}`, data.measureIndex);
        if (data.type === "rail") railOnly.push({ measureIndex: data.measureIndex, band: data.band, x, y });
    }
    return { canvas, grid, z, isVertical, cellSize, minX, minY, gridW, gridH,
             extMinX, extMaxX, extMinY, extMaxY, deadZoneCoords, separatorCoords,
             clickableByCoord, railOnly };
}

// canvasのグリッド全体をピクセルとして描き直す（renderMap()と、パネル画像の遅延読み込み
// 完了時から呼ばれる）。1マスずつdrawMapCell()に委譲する
function drawMapCanvas(state) {
    const { canvas, grid, z, isVertical, cellSize, minX, minY, gridW, gridH, separatorCoords } = state;
    const ctx = canvas.getContext("2d");
    const dpr = canvas._mapDPR || 1;
    const cssW = gridW * cellSize, cssH = gridH * cellSize;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cssW, cssH);

    const isSepCoord = (c) => separatorCoords.has(c);

    // 罫線は1マスごとにstroke()を呼ぶと（マス数が多い時に）呼び出し回数自体がボトルネックに
    // なるため、全マス分の線分を1つのPath2Dにまとめておき、最後に1回だけstroke()する
    const borderPath = new Path2D();

    for (let gy = 0; gy < gridH; gy++) {
        for (let gx = 0; gx < gridW; gx++) {
            const ax = gx + minX;
            const ay = gy + minY;
            const data = grid.get(`${ax},${ay},${z}`);
            const ownWrapCoord = isVertical ? ax : ay;
            const isSeparator = isSepCoord(ownWrapCoord);
            drawMapCell(ctx, borderPath, { px: gx * cellSize, py: gy * cellSize, cellSize, gx, gy, isSeparator, isVertical, data });
        }
    }

    ctx.strokeStyle = "#e0e0e0";
    ctx.lineWidth = 1;
    ctx.stroke(borderPath);

    ctx.restore();
}

// 1マス分の描画。区切りマスの罫線スキップロジックは元のDOM版（renderMap()旧実装）と
// 一字一句同じ条件式を保っている。罫線はctx.stroke()を都度呼ばず、呼び出し元が持つ
// 1本のPath2Dに線分を足しこむだけにする（drawMapCanvas()参照）
function drawMapCell(ctx, borderPath, { px, py, cellSize, gx, gy, isSeparator, isVertical, data }) {
    // --- 背景 ---
    if (!isSeparator && data && data.type === "rail") {
        drawMapGradientRect(ctx, px, py, cellSize, "rail");
    } else if (!isSeparator && data && data.type === "sensor") {
        drawMapGradientRect(ctx, px, py, cellSize, "sensor");
    } else if (!isSeparator && data && data.type === "panel" && PITCH_TO_FILE[toCanonicalPitch(data.pitch)]) {
        drawMapGradientRect(ctx, px, py, cellSize, "panel");
    } else {
        ctx.fillStyle = "#fff";
        ctx.fillRect(px, py, cellSize, cellSize);
    }

    // --- 罫線（元のskip*/show*ロジックをそのまま踏襲） ---
    const skipRightBorder = isVertical ? false : isSeparator;
    const skipBottomBorder = isVertical ? isSeparator : false;
    const skipLeftBorder = isVertical ? false : isSeparator;
    const skipTopBorder = isVertical ? isSeparator : false;
    const showLeftBorder = gx === 0 && !skipLeftBorder;
    const showTopBorder = gy === 0 && !skipTopBorder;

    if (!skipRightBorder) addMapBorderLine(borderPath, px + cellSize, py, px + cellSize, py + cellSize);
    if (!skipBottomBorder) addMapBorderLine(borderPath, px, py + cellSize, px + cellSize, py + cellSize);
    if (showLeftBorder) addMapBorderLine(borderPath, px, py, px, py + cellSize);
    if (showTopBorder) addMapBorderLine(borderPath, px, py, px + cellSize, py);

    // --- 種別ごとの中身 ---
    if (!isSeparator && data) {
        if (data.type === "rail") {
            drawMapRailLine(ctx, px, py, cellSize, data.direction);
        } else if (data.type === "sensor") {
            drawMapSensorText(ctx, px, py, cellSize, data.beatNum);
        } else if (data.type === "panel") {
            drawMapPanelImage(ctx, px, py, cellSize, data.pitch);
        }
    }
}

// canvasの1pxストロークは整数座標だと2デバイスピクセルにまたがってにじむため、
// 0.5だけずらして1本の線がくっきり乗るようにする。実際のstroke()はdrawMapCanvas()側で
// 全マスぶんまとめて1回だけ呼ぶため、ここではpathに線分を足しこむだけ
function addMapBorderLine(path, x1, y1, x2, y2) {
    if (x1 === x2) {
        const x = Math.round(x1) + 0.5;
        path.moveTo(x, y1);
        path.lineTo(x, y2);
    } else {
        const y = Math.round(y1) + 0.5;
        path.moveTo(x1, y);
        path.lineTo(x2, y);
    }
}

// rail/sensor/panelの背景グラデーション（CSSの.mapCell--rail/--sensor/--panelと同じ配色）＋
// inset box-shadowの近似（canvasにはinset shadowの直接的な相当機能が無いため、端に薄い
// 明暗の帯を描いて立体感を模す。ぼかしの無い分だけCSS版とは厳密には一致しない）
function drawMapGradientRect(ctx, px, py, size, kind) {
    let grad;
    if (kind === "rail") {
        grad = ctx.createLinearGradient(px, py, px + size, py + size);
        grad.addColorStop(0, "#6b6b6b");
        grad.addColorStop(1, "#4a4a4a");
    } else if (kind === "sensor") {
        grad = ctx.createLinearGradient(px, py, px + size, py + size);
        grad.addColorStop(0, "#ea6b6b");
        grad.addColorStop(1, "#d03f3f");
    } else {
        grad = ctx.createRadialGradient(
            px + size / 2, py + size / 2, 0,
            px + size / 2, py + size / 2, size / 2 * Math.SQRT2
        );
        grad.addColorStop(0, "#fbfbfb");
        grad.addColorStop(1, "#e8e8e8");
    }
    ctx.fillStyle = grad;
    ctx.fillRect(px, py, size, size);

    if (kind === "rail" || kind === "sensor") {
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.fillRect(px, py, size, 1);
        ctx.fillStyle = "rgba(0,0,0,0.2)";
        ctx.fillRect(px, py + size - 2, size, 2);
    } else {
        ctx.fillStyle = "rgba(0,0,0,0.12)";
        ctx.fillRect(px, py, size, 2);
    }
}

// レールの向きを示す線（.mapRailLine相当）。角丸矩形＋軽いドロップシャドウ
function drawMapRailLine(ctx, px, py, size, direction) {
    const isVert = direction === "vertical";
    const w = isVert ? size * 0.3 : size;
    const h = isVert ? size : size * 0.3;
    const x = px + (size - w) / 2;
    const y = py + (size - h) / 2;
    const r = Math.min(2, w / 2, h / 2);

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.3)";
    ctx.shadowBlur = 1;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = "#999";
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

// センサーの拍番号（.mapCell--sensorのcolor:#fffが.mapCell--contentのcolor:#555より
// 後のCSS定義で勝っていたのと同じ色を使う）
function drawMapSensorText(ctx, px, py, size, beatNum) {
    const text = String(beatNum);
    const digits = text.length;
    const fontRatio = digits <= 2 ? 0.5 : 0.4 * 3 / digits;
    const fontSize = size * fontRatio;

    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.font = `${fontSize}px 'Noto Sans JP', 'Meiryo', 'メイリオ', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, px + size / 2, py + size / 2);
    ctx.restore();
}

// 音符マットの画像（プリロード済みキャッシュから取得、未読込ならこの回は何も描かない——
// 読み込み完了時にscheduleMapPanelRedraw()が呼ばれて再描画される）
function drawMapPanelImage(ctx, px, py, size, pitch) {
    const file = PITCH_TO_FILE[toCanonicalPitch(pitch)];
    if (!file) return;
    const img = getMapPanelImage(pitch);
    if (!img || !img.complete || img.naturalWidth === 0) return;

    ctx.save();
    ctx.translate(px + size / 2, py + size / 2);
    ctx.rotate(northDirection * 90 * Math.PI / 180);
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = 1;
    ctx.shadowOffsetY = 1;
    // PITCH_TO_FILEの画像は全て100x100pxの正方形（実測確認済み）なので、
    // object-fit:containと等価な単純な引き伸ばし描画でよい
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
    ctx.restore();
}

// ===== 組み立てプレビュー（Three.js製の3D表示） =====
// 2Dマップ（canvas）とは独立したビュー。buildMapGrid()が返すgridは3層（上位/中間/下位）
// 全部を同時に含んでいるため、ここでは層を切り替えず、3層まとめて縦に積んで表示する。
// レール/センサー/音符マットはそれぞれInstancedMeshにまとめて描画する（1マス=1メッシュだと
// 長い曲でメッシュ数が数千〜数万になり得るため。以前DOM方式のマップが同種の理由で遅かった
// 前例があるので、最初から避ける）

// window.THREEはESモジュール側（index.html）が非同期で公開するグローバルなので、
// app.js側ではトップレベルで直接参照せず、必ずこの関数経由でアクセスする
function ensureThreeLoaded(callback) {
    if (window.THREE && window.OrbitControls) { callback(); return; }
    window.addEventListener("three-ready", () => callback(), { once: true });
}

let assemblyScene = null, assemblyCamera = null, assemblyRenderer = null, assemblyControls = null;
let assemblySceneReady = false;
let assemblyAnimFrameId = null;
let assemblyCameraFramed = false; // 初回のみカメラを内容に合わせてフレーミングする（編集のたびに視点をリセットしないため）
let assemblyRailMesh = null, assemblySensorMesh = null;
let assemblyPanelMeshes = {};   // canonical pitch -> InstancedMesh
let assemblyLayerGrids = [];    // 3層それぞれの床グリッド（THREE.GridHelper）
let assemblyGridVisible = true; // #assemblyGridToggleBtnで切り替える、rebuildAssemblyMeshes()を跨いで保持する
let assemblyPlayMarker = null;  // 再生中のトロッコ位置を示す球（initAssemblyScene()で1回だけ作成し使い回す）
let assemblyBeatCenters = [];   // ビートごとのレール中心のワールド座標（updateAssemblyPlayMarker用、rebuildAssemblyMeshes()のたびに作り直す）
const ASSEMBLY_CELL_SIZE = 1;
// 層の間隔はマス目の縦横と同じ長さにする（＝1マスぶんが縦横高さとも等しい立方体になる）
const ASSEMBLY_LAYER_HEIGHT = ASSEMBLY_CELL_SIZE;

const MAP_PANEL_MATERIALS = {}; // canonical pitch -> [6面ぶんのMeshStandardMaterial]（BoxGeometry用）
let assemblyRailMaterial = null, assemblySensorMaterial = null, assemblyPanelSideMaterial = null, assemblyUnitBoxGeometry = null;

// 初回のタブ切り替え時にだけ呼ばれる。renderer/scene/camera/ライト/OrbitControls/
// 共有ジオメトリ・マテリアルを1回だけ構築する
function initAssemblyScene() {
    if (assemblySceneReady) return;
    const canvas = document.getElementById("assemblyCanvas");
    if (!canvas) return;

    assemblyRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    assemblyRenderer.setPixelRatio(window.devicePixelRatio || 1);
    assemblyRenderer.shadowMap.enabled = true;
    assemblyRenderer.outputColorSpace = THREE.SRGBColorSpace;
    assemblyRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    assemblyRenderer.toneMappingExposure = 1.1;

    assemblyScene = new THREE.Scene();
    assemblyScene.background = new THREE.Color(0xe9ecf1);

    assemblyCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    assemblyCamera.position.set(12, 12, 12); // 内容に応じてframeAssemblyCamera()が上書きする

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f98, 0.9);
    assemblyScene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(10, 18, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    assemblyScene.add(sun);
    assemblyScene.add(sun.target);

    assemblyControls = new OrbitControls(assemblyCamera, assemblyRenderer.domElement);
    assemblyControls.enableDamping = true;
    assemblyControls.dampingFactor = 0.08;
    assemblyControls.zoomToCursor = true; // マウス（タッチ）位置を中心にズームする
    // 右ドラッグは常に平行移動。左ドラッグは通常は回転だが、OrbitControls標準の挙動として
    // Shift/Ctrl/Metaを押しながらだと自動的に平行移動に切り替わる（mouseButtons.LEFTを
    // ROTATEのままにしておくだけでよく、こちらで手動切り替えする必要はない）
    assemblyControls.enablePan = true;
    assemblyControls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    assemblyControls.minDistance = 3;
    assemblyControls.maxDistance = 200; // frameAssemblyCamera()で曲ごとに調整
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // 使い回す共有ジオメトリ・マテリアル（2Dマップの色使いに合わせる: レール=ダークグレー、
    // センサー=赤、音符マット側面=白系。音符マットの上面だけピッチごとの写真テクスチャを貼る）
    assemblyUnitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
    assemblyRailMaterial = new THREE.MeshStandardMaterial({ color: 0x585858, roughness: 0.65, metalness: 0.35 });
    assemblySensorMaterial = new THREE.MeshStandardMaterial({ color: 0xd94f4f, roughness: 0.5, metalness: 0.1, emissive: 0x330000, emissiveIntensity: 0.15 });
    assemblyPanelSideMaterial = new THREE.MeshStandardMaterial({ color: 0xefefef, roughness: 0.8 });

    // 再生中のトロッコ位置マーカー（2Dマップのdraw MapPlayLineの黄色いマーカーと同系色）。
    // rebuildAssemblyMeshes()では破棄されず使い回すので、ここで1回だけ作る
    const markerMaterial = new THREE.MeshStandardMaterial({ color: 0xffd100, emissive: 0xffd100, emissiveIntensity: 0.5, roughness: 0.4 });
    assemblyPlayMarker = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.6), markerMaterial);
    assemblyPlayMarker.visible = false;
    assemblyScene.add(assemblyPlayMarker);

    assemblySceneReady = true;
}

// ピッチごとのテクスチャ+マテリアル（BoxGeometryの6面ぶん）を遅延生成する。
// 既にloadMapPanelImages()がプリロード中のHTMLImageElement（MAP_PANEL_IMAGES）を
// そのまま流用し、二重に画像を取得しない
function getAssemblyPanelMaterials(pitch) {
    const canon = toCanonicalPitch(pitch);
    if (MAP_PANEL_MATERIALS[canon]) return MAP_PANEL_MATERIALS[canon];

    const img = getMapPanelImage(canon);
    const tex = new THREE.Texture(img || undefined);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (img) {
        if (img.complete && img.naturalWidth > 0) {
            tex.needsUpdate = true;
        } else {
            // 既存のimg.onload（2DマップのscheduleMapPanelRedraw）を上書きしないよう、
            // addEventListenerで別リスナーとして追加するだけにする
            img.addEventListener("load", () => { tex.needsUpdate = true; }, { once: true });
        }
    }

    const top = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
    // BoxGeometryの面順序は [+x, -x, +y, -y, +z, -z]。+y（上面）だけ写真テクスチャ、他は側面色
    MAP_PANEL_MATERIALS[canon] = [
        assemblyPanelSideMaterial, assemblyPanelSideMaterial,
        top, assemblyPanelSideMaterial,
        assemblyPanelSideMaterial, assemblyPanelSideMaterial,
    ];
    return MAP_PANEL_MATERIALS[canon];
}

// 位置の配列から1つのInstancedMeshを組み立てる共通処理
function buildAssemblyInstancedMesh(positions, geometry, material, sx, sy, sz, rotY) {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(positions.length, 1));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const scale = new THREE.Vector3(sx, sy, sz);
    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    positions.forEach((pos, i) => {
        m.compose(pos, quat, scale);
        mesh.setMatrixAt(i, m);
    });
    mesh.count = positions.length;
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
}

// 曲が空の時に表示する簡単な案内文（2Dマップの「音符がありません」と同趣旨）
function updateAssemblyEmptyState(isEmpty) {
    const canvas = document.getElementById("assemblyCanvas");
    let hint = document.getElementById("assemblyEmptyHint");
    if (isEmpty) {
        if (canvas) canvas.style.display = "none";
        if (!hint) {
            hint = document.createElement("p");
            hint.id = "assemblyEmptyHint";
            hint.style.cssText = "color:var(--text-faint); padding:16px;";
            hint.textContent = "音符がありません";
            document.getElementById("assemblyAreaWrapper").appendChild(hint);
        }
    } else {
        if (canvas) canvas.style.display = "";
        if (hint) hint.remove();
    }
}

// buildMapGrid()の結果を元に、3層ぶんのInstancedMeshを作り直す。renderMap()と同様、
// 曲やマップ設定が変わるたびに丸ごと呼び直す（ジオメトリ/マテリアルは使い回し、
// 前回分のInstancedMeshだけ破棄して作り直す）
function rebuildAssemblyMeshes() {
    [assemblyRailMesh, assemblySensorMesh, ...Object.values(assemblyPanelMeshes)].forEach(m => {
        if (m) assemblyScene.remove(m);
    });
    assemblyRailMesh = null;
    assemblySensorMesh = null;
    assemblyPanelMeshes = {};
    assemblyLayerGrids.forEach(g => assemblyScene.remove(g));
    assemblyLayerGrids = [];

    const { grid, extent, beatCenters } = buildMapGrid();
    if (!extent) {
        updateAssemblyEmptyState(true);
        assemblyBeatCenters = [];
        if (assemblyPlayMarker) assemblyPlayMarker.visible = false;
        assemblyRenderer.render(assemblyScene, assemblyCamera);
        return;
    }
    updateAssemblyEmptyState(false);

    const centerX = (extent.minX + extent.maxX) / 2;
    const centerY = (extent.minY + extent.maxY) / 2;
    const toWorld = (gx, gy, gz) => new THREE.Vector3(
        (gx - centerX) * ASSEMBLY_CELL_SIZE,
        gz * ASSEMBLY_LAYER_HEIGHT,
        (gy - centerY) * ASSEMBLY_CELL_SIZE
    );

    // 再生中のトロッコ位置マーカー（updateAssemblyPlayMarker）用に、ビートごとのレール
    // 中心座標をワールド座標へ変換しておく。トロッコは物理的な中間層のレール上しか
    // 走らないためz=0固定でよい（2DマップのmapBeatPositionsと同じ役割）
    assemblyBeatCenters = beatCenters.map(c => toWorld(c.x, c.y, 0));

    const railPositions = [];
    const sensorPositions = [];
    const panelPositionsByPitch = {}; // canonical pitch -> Vector3[]
    const rotY = northDirection * Math.PI / 2;

    for (const [key, data] of grid) {
        const parts = key.split(",").map(Number);
        const pos = toWorld(parts[0], parts[1], parts[2]);
        if (data.type === "rail") {
            // レールはgrid上では上位層/中間層/下位層の3つに同じものが複製されている
            // （2Dマップはどの層を見てもレールの通り道が分かるようにするための仕掛け）が、
            // 3層を同時に表示するこのプレビューではそのまま描くとレールが3本重なって見えて
            // しまう。実際のレールは1本しか無いので、中間層（z===0）ぶんだけ描画する
            if (parts[2] !== 0) continue;
            railPositions.push(pos);
        } else if (data.type === "sensor") {
            sensorPositions.push(pos);
        } else if (data.type === "panel") {
            const canon = toCanonicalPitch(data.pitch);
            if (!PITCH_TO_FILE[canon]) continue; // 2D版と同じ「対応画像が無ければ描かない」ガード
            if (!panelPositionsByPitch[canon]) panelPositionsByPitch[canon] = [];
            panelPositionsByPitch[canon].push(pos);
        }
    }

    assemblyRailMesh = buildAssemblyInstancedMesh(railPositions, assemblyUnitBoxGeometry, assemblyRailMaterial, 1, 0.2, 1, 0);
    assemblyScene.add(assemblyRailMesh);
    assemblySensorMesh = buildAssemblyInstancedMesh(sensorPositions, assemblyUnitBoxGeometry, assemblySensorMaterial, 0.9, 0.25, 0.9, 0);
    assemblyScene.add(assemblySensorMesh);
    Object.entries(panelPositionsByPitch).forEach(([pitch, positions]) => {
        const mesh = buildAssemblyInstancedMesh(positions, assemblyUnitBoxGeometry, getAssemblyPanelMaterials(pitch), 0.95, 0.15, 0.95, rotY);
        assemblyPanelMeshes[pitch] = mesh;
        assemblyScene.add(mesh);
    });

    // 3層を視覚的に伝える床グリッド（半透明の板は重なった面同士の深度ソート問題があるため
    // 使わず、不透明な線だけのGridHelperにする）
    const gridSize = Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY) + 4;

    // GridHelperは自身のposition(既定は原点)を中心に、gridSizeの偶奇に応じて線の位置が
    // 整数(偶数)または0.5ズレた半整数(奇数)のどちらかに揃う。一方、実際のマスはtoWorld()で
    // (gx-centerX)というワールド座標に置かれ、そのマスの境界線はcenterXが整数か半整数かで
    // 整数位置/半整数位置のどちらかになる。一列の最大センサー数（wrapValue）を変えると
    // 総マス数が変わりcenterX/centerYの偶奇も変わるため、この2つがたまたま噛み合わない
    // 組み合わせになると、線がマスの境界ではなく真ん中を通ってしまう。X軸・Y(奥行き)軸は
    // それぞれ独立にズレうるので、両方について必要な補正量を求めてposition.x/zに反映する
    const nativeLineFrac = gridSize % 2 !== 0 ? 0.5 : 0;
    const boundaryFracFor = (centerSum) => ((((centerSum % 2) + 2) % 2) === 0 ? 0.5 : 0);
    const offsetX = boundaryFracFor(extent.minX + extent.maxX) === nativeLineFrac ? 0 : ASSEMBLY_CELL_SIZE / 2;
    const offsetZ = boundaryFracFor(extent.minY + extent.maxY) === nativeLineFrac ? 0 : ASSEMBLY_CELL_SIZE / 2;
    [-1, 0, 1].forEach(layer => {
        // GridHelperは本来「中心を通る2本の線だけ濃い色にする」機能を持つが、これは
        // gridSize（マス数）の偶奇でその中心線が実在するかどうかが決まる仕様のため、
        // マス数が変わるだけで「濃い線が出たり消えたりする」意図しない見た目のブレになる。
        // このプレビューに中心線を強調したい意図は無いため、2色を同じ色にして常に均一にする
        const helper = new THREE.GridHelper(gridSize * ASSEMBLY_CELL_SIZE, gridSize, 0xd8d8d8, 0xd8d8d8);
        helper.position.set(offsetX, layer * ASSEMBLY_LAYER_HEIGHT - 0.15, offsetZ);
        helper.visible = assemblyGridVisible; // #assemblyGridToggleBtnでの設定を再構築後も保つ
        assemblyScene.add(helper);
        assemblyLayerGrids.push(helper);
    });

    if (!assemblyCameraFramed) {
        frameAssemblyCamera(extent);
        assemblyCameraFramed = true;
    }

    // 再生中/一時停止中にグリッドが再構築された場合、現在位置のマーカーを再適用する
    // （2DマップのrenderMap()末尾にある同趣旨の処理と同じ理由）
    if (playState !== "stopped" && currentHighlightBeatIndex !== null) {
        updateAssemblyPlayMarker(currentHighlightBeatIndex, currentHighlightBeatT);
    }
}

// 再生中のトロッコ位置を、プレビュー(3D)の球マーカーで示す。drawMapPlayLine()の3D版で、
// ロジックは同じ（beatIndexとbeatIndex+1の間をtで補間、段の折り返しをまたぐ大きな
// 移動だけは瞬時に切り替える）だが、対象がDOM要素ではなくThree.jsのメッシュな点が異なる
function updateAssemblyPlayMarker(beatIndex, t) {
    if (!assemblyPlayMarker) return;
    const posA = beatIndex == null ? null : assemblyBeatCenters[beatIndex];
    if (!posA) {
        assemblyPlayMarker.visible = false;
        return;
    }
    let posB = assemblyBeatCenters[beatIndex + 1] || posA;
    if (posA.distanceTo(posB) > ASSEMBLY_CELL_SIZE * 1.5) posB = posA;

    assemblyPlayMarker.position.lerpVectors(posA, posB, t);
    assemblyPlayMarker.position.y += 0.4; // レール/センサーの高さより少し上に浮かせて見やすくする
    assemblyPlayMarker.visible = true;
}

// 内容の大きさに合わせてカメラの初期位置・ズーム範囲を決める。初回ビルド時のみ呼ばれる
// （毎回呼ぶと編集のたびにユーザーがせっかく回転させた視点がリセットされてしまうため）
function frameAssemblyCamera(extent) {
    const gridW = (extent.maxX - extent.minX + 1) * ASSEMBLY_CELL_SIZE;
    const gridH = (extent.maxY - extent.minY + 1) * ASSEMBLY_CELL_SIZE;
    const footprint = Math.max(gridW, gridH, 4);
    const dist = footprint * 1.1 + ASSEMBLY_LAYER_HEIGHT * 2;

    assemblyCamera.position.set(dist * 0.7, dist * 0.6, dist * 0.7);
    assemblyControls.target.set(0, 0, 0);
    assemblyControls.minDistance = Math.max(3, footprint * 0.15);
    assemblyControls.maxDistance = footprint * 4 + 40;
    assemblyControls.update();
}

function startAssemblyRenderLoop() {
    if (assemblyAnimFrameId !== null) return;
    const tick = () => {
        assemblyAnimFrameId = requestAnimationFrame(tick);
        assemblyControls.update();
        assemblyRenderer.render(assemblyScene, assemblyCamera);
    };
    tick();
}

function stopAssemblyRenderLoop() {
    if (assemblyAnimFrameId !== null) cancelAnimationFrame(assemblyAnimFrameId);
    assemblyAnimFrameId = null;
}

// #assemblyAreaWrapperの実際の表示サイズにrenderer/cameraを合わせる。
// #assemblyCanvasのheight:100%が効くには親に明確な高さ（min-heightではなくheight）が
// 要るため、updateContentAreaMinHeights()と同じ「ヘッダー等を除いた残り高さ」の考え方で
// ここではheightを直接指定する
function resizeAssemblyRenderer() {
    if (!assemblySceneReady) return;
    const wrapper = document.getElementById("assemblyAreaWrapper");
    if (!wrapper) return;
    const docTop = wrapper.getBoundingClientRect().top + window.scrollY;
    wrapper.style.height = `${Math.max(window.innerHeight - docTop, 100)}px`;

    const w = wrapper.clientWidth, h = wrapper.clientHeight;
    if (w === 0 || h === 0) return;
    assemblyRenderer.setSize(w, h, false);
    assemblyCamera.aspect = w / h;
    assemblyCamera.updateProjectionMatrix();
    if (assemblyAnimFrameId !== null) assemblyRenderer.render(assemblyScene, assemblyCamera);
}

// 組み立てプレビュータブのエントリポイント。タブ切り替え時・曲やマップ設定の変更時に
// 呼ばれる（renderMap()と同じ立ち位置）
function renderAssemblyPreview() {
    ensureThreeLoaded(() => {
        initAssemblyScene();
        resizeAssemblyRenderer();
        rebuildAssemblyMeshes();
        startAssemblyRenderLoop();
    });
}

// 曲やマップ設定の変更のたびに、今見えているのがマップ/並べて/組み立てプレビューの
// どれであっても、そのタブだけを再描画する共通ヘルパー（2Dマップ側は元々
// 「if (activeTab === "map" || activeTab === "both") renderMap();」を編集のたびに
// 個別に書いていたが、組み立てプレビューでも同じことが必要になったためまとめた）
function refreshMapAndAssemblyIfVisible() {
    if (activeTab === "map" || activeTab === "both") renderMap();
    if (activeTab === "assembly") renderAssemblyPreview();
}

// マップ上の選択ハイライト（.mapSelectionOverlay）を描き直す。renderMap()の全再構築を
// 経由しない軽量な処理なので、ドラッグ中のライブプレビュー表示にも使える。
// previewSetを渡すとそちらを優先表示し（ドラッグ中の暫定選択）、省略時はselectedMeasuresを使う。
// 再生中の位置マーカー（drawMapPlayLine）は独立した重ね合わせ要素として描くため、
// この選択ハイライトも同様にpointer-events:noneの重ね合わせ子要素にして干渉しないようにしている。
// 音符マット自体の色（ピッチごとの画像）が透けて見えなくなると見分けづらいという指摘を受け、
// 半透明の塗りつぶしはやめ、白+青の二重リングの縁取りだけにして中身の色を隠さないようにした
function createMapOverlayEl(key, box, wrapperRect, scrollLeft, scrollTop) {
    const { left, top, right, bottom } = box;
    const el = document.createElement("div");
    el.className = "mapSelectionOverlay";
    el.dataset.key = key;
    el.style.cssText = `
        position: absolute;
        left: ${left - wrapperRect.left + scrollLeft}px;
        top: ${top - wrapperRect.top + scrollTop}px;
        width: ${right - left}px;
        height: ${bottom - top}px;
        box-shadow: inset 0 0 0 2px #fff, inset 0 0 0 4px #4a6cf7, 0 0 10px rgba(74, 108, 247, 0.5);
        pointer-events: none;
        z-index: 4;
    `;
    return el;
}

// animate=false（既定）: 従来通り全部消して全部描き直す（グリッドの再構築を伴う通常の
// 再描画で使う）。animate=true: 現在表示中の枠と今回表示すべき集合（(measureIndex,band)の
// 組み合わせごと）を比較し、新しく選択された枠だけフェードイン、選択から外れた枠だけ
// フェードアウトさせる
function drawMapSelectionOverlays(previewSet, animate = false) {
    const effective = previewSet || selectedMeasures;

    const wrapper = document.getElementById("mapAreaWrapper");
    if (!wrapper) {
        document.querySelectorAll(".mapSelectionOverlay").forEach(el => el.remove());
        return;
    }
    const wrapperRect = wrapper.getBoundingClientRect();
    // オーバーレイは#mapAreaWrapper（position:relative）を基準にposition:absoluteで配置するが、
    // このwrapper自身が（「両方」タブでは）overflow:autoでスクロールする場合、absolute要素の
    // top/leftはwrapperの「現在見えている位置」ではなく「スクロールされる中身の原点」からの
    // 距離として解釈される。getBoundingClientRect()は常に現在の可視位置（スクロール分を
    // 差し引いた後の値）を返すため、その差分をそのままtop/leftに使うと、描画した瞬間の
    // スクロール量だけずれてしまう（マップをスクロールしてから選択すると顕著に発生した）。
    // wrapper自身の現在のscrollTop/scrollLeftを足し戻すことで、スクロール位置に関わらず
    // 常に正しい位置に描画されるようにする
    const scrollLeft = wrapper.scrollLeft;
    const scrollTop = wrapper.scrollTop;

    // 音符マット1つ1つを個別に囲うのではなく、その小節に属するレールのマスだけをまとめて覆う
    // 四角（バウンディングボックス）を描く（センサー・音符マットは枠の対象に含めない。
    // 含めると音符マットが左右/上下に張り出す分だけ枠が不要に大きくなってしまうため）。
    // 折り返し（改行）をまたぐ小節はレールが離れた場所に分かれるため、1つの四角にまとめると
    // 間の無関係な領域まで囲ってしまう。段（data-map-band）ごとにグループ分けし、
    // 段ごとに別々の四角を描くことで、それぞれのレール区間だけをタイトに囲む
    // マップはcanvas化されており個別マスのDOM要素が存在しないため、対象小節のrailセルは
    // renderMap()が構築したmapRenderState.railOnlyから拾い、そのグリッド座標×cellSizeから
    // ビューポート座標のボックスを算出する（DOM要素のgetBoundingClientRect()を集計していた
    // 従来のロジックと、算出結果は同じになるよう設計している）
    const targets = new Map(); // "measureIndex:band" -> {left,top,right,bottom}
    if (mapRenderState) {
        const { railOnly, minX, minY, cellSize, canvas } = mapRenderState;
        const canvasRect = canvas.getBoundingClientRect();
        effective.forEach(measureIndex => {
            const bands = new Map(); // band -> {left,top,right,bottom}
            railOnly.forEach(c => {
                if (c.measureIndex !== measureIndex) return;
                const band = c.band ?? "";
                const left = (c.x - minX) * cellSize + canvasRect.left;
                const top = (c.y - minY) * cellSize + canvasRect.top;
                const right = left + cellSize;
                const bottom = top + cellSize;
                let box = bands.get(band);
                if (!box) {
                    box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
                    bands.set(band, box);
                }
                box.left = Math.min(box.left, left);
                box.top = Math.min(box.top, top);
                box.right = Math.max(box.right, right);
                box.bottom = Math.max(box.bottom, bottom);
            });

            bands.forEach((box, band) => targets.set(`${measureIndex}:${band}`, box));
        });
    }

    if (!animate) {
        document.querySelectorAll(".mapSelectionOverlay").forEach(el => el.remove());
        targets.forEach((box, key) => {
            wrapper.appendChild(createMapOverlayEl(key, box, wrapperRect, scrollLeft, scrollTop));
        });
        return;
    }

    const existingByKey = new Map();
    document.querySelectorAll(".mapSelectionOverlay").forEach(el => {
        existingByKey.set(el.dataset.key, el);
    });

    existingByKey.forEach((el, key) => {
        if (!targets.has(key)) fadeOutAndRemove(el);
    });

    targets.forEach((box, key) => {
        if (existingByKey.has(key)) return; // 既に表示中ならそのまま
        const el = createMapOverlayEl(key, box, wrapperRect, scrollLeft, scrollTop);
        wrapper.appendChild(el);
        fadeInIfAnimated(el, true);
    });
}

// 折り返し軸（段/バンドが変わる方向）のズレを最優先し、進行軸方向のズレは同じ段内での
// 判定にだけ使う重み付き距離を返す（五線譜タブのgetMeasureIndexFromWrapperXYが「行のズレを
// 最優先」しているのと同じ考え方）。単純なユークリッド距離だと、段によって長さが違う場合
// （最後の段が短い等）に、グリッドから大きく外れた位置から一番近いセルを探すと、本来
// 近いはずの段（例えば最後の段）ではなく、たまたま距離が近いだけの別の段のセルを
// 誤って選んでしまうことがあった（例: ドラッグの終点がグリッドの右下はるか先にあり、
// 短い最後の段より、手前の長い段の方が直線距離では近い場合）
function mapCellWeightedDistance(cx, cy, x, y) {
    const isVertical = mapSettings.railDirection === "vertical";
    const wrapDist = isVertical ? Math.abs(cx - x) : Math.abs(cy - y);
    const travelDist = isVertical ? Math.abs(cy - y) : Math.abs(cx - x);
    return wrapDist * 100000 + travelDist;
}

// 指定座標を直接含むセル（レール/センサー/音符マット、どの種類でも良い）があればそれを使う。
// 無ければ、レールセルだけを対象に、上記の重み付き距離が最も近いものにフォールバックする
// （マップタブがアクティブな間はページのどこからでもドラッグを開始できるようにするための設計）。
// フォールバック探索をレールだけに絞るのは、センサー・音符マットは和音の配置
// （中間層の「遠い/近い」等）により進行軸方向で自分の本来のビート位置から前後にずれて
// 配置されることがあり、それらも候補に含めると「マウスが一方向に動いているのに、
// 解決される小節番号が前後してしまう（非単調になる）」問題があったため。レールは
// 常に自分のビート位置ぴったり（±1の連続する帯）にしか存在せず、小節番号の並び順と
// 進行軸方向の位置が必ず一致するため、フォールバックの基準として安全に使える
function findNearestMapCell(x, y) {
    if (!mapRenderState) return null;
    const { canvas, clickableByCoord, railOnly, minX, minY, cellSize, gridW, gridH } = mapRenderState;
    const canvasRect = canvas.getBoundingClientRect();

    // 直撃判定：座標からグリッド上の論理マス座標を直接算出し、そのマスにmeasureIndexが
    // あるかをO(1)で調べる（マップはcanvas化されておりマス単位のDOM要素が存在しないため、
    // 以前のようにgetBoundingClientRect()をマスごとに回す必要はない）
    const localX = x - canvasRect.left;
    const localY = y - canvasRect.top;
    if (localX >= 0 && localY >= 0) {
        // グリッド右端/下端ちょうどの座標（canvasRect.right/bottom上のピクセル）は
        // Math.floorだけだと1つ外側（範囲外）のマス番号になってしまうため、
        // 最終列/行にクランプする（DOM要素のgetBoundingClientRect()が右端/下端を
        // 含める形で判定していた従来の挙動に合わせるため）
        const gx = Math.min(gridW - 1, Math.floor(localX / cellSize));
        const gy = Math.min(gridH - 1, Math.floor(localY / cellSize));
        const ax = gx + minX, ay = gy + minY;
        const hit = clickableByCoord.get(`${ax},${ay}`);
        if (hit !== undefined) return hit;
    }

    // 直撃が無ければ、レールセルだけを対象に重み付き距離が最も近いものにフォールバックする
    // （mapCellWeightedDistanceの意図・レールに絞る理由は同関数のコメント参照）
    let nearestIndex = null;
    let nearestDist = Infinity;
    railOnly.forEach(c => {
        const cx = (c.x - minX) * cellSize + cellSize / 2 + canvasRect.left;
        const cy = (c.y - minY) * cellSize + cellSize / 2 + canvasRect.top;
        const dist = mapCellWeightedDistance(cx, cy, x, y);
        if (dist < nearestDist) {
            nearestDist = dist;
            nearestIndex = c.measureIndex;
        }
    });
    return nearestIndex;
}

// 指定した座標（ビューポート基準）にあるマスが属する小節インデックスを返す。
// 座標を直接含むマスがあればそれを、無ければ最も近いマスの小節にフォールバックする
// （マップは隙間だらけのグリッドなので、ドラッグ中の座標がマスの真上とは限らないため）
function getMapMeasureIndexAtPoint(x, y) {
    if (!mapRenderState) return null;
    // グリッド本体（canvas化された#mapGrid）の外側（背景を埋めるために広げた白い余白部分や、
    // ページの他の場所）を押しても選択が始まらないようにする
    const { canvas, minX, minY, gridW, gridH, cellSize, extMinX, extMaxX, extMinY, extMaxY, deadZoneCoords } = mapRenderState;
    const canvasRect = canvas.getBoundingClientRect();
    if (x < canvasRect.left || x > canvasRect.right || y < canvasRect.top || y > canvasRect.bottom) {
        return null;
    }

    // どの小節にも属さない「見た目用の余白マス」（renderMap()が表示範囲の端に追加する
    // 1マス分のマージン）や、末尾の未使用フットプリント（deadZoneCoords）を直接クリック
    // した場合は選択しない。レール/センサー/音符マットが無い普通の空白マス（小節の実測
    // 範囲内にあり、たまたまその位置に何も配置されていないだけのマス）はここでは対象外で、
    // 従来通り下の「最も近いセルへのフォールバック」で選択できる
    // （以前はcell.dataset.outsideExtentが立ったDOM要素をクリック判定していたが、
    // canvas化により座標からextent/deadZoneCoordsへの直接判定に置き換えている）
    const localX = x - canvasRect.left;
    const localY = y - canvasRect.top;
    // グリッド右端/下端ちょうどの座標は最終列/行にクランプする（findNearestMapCell側と
    // 同じ理由。上のcanvasRect境界チェックでは右端/下端ぴったりを「内側」として通しているため）
    const gx = Math.min(gridW - 1, Math.floor(localX / cellSize));
    const gy = Math.min(gridH - 1, Math.floor(localY / cellSize));
    if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) {
        const ax = gx + minX, ay = gy + minY;
        if (ax < extMinX || ax > extMaxX || ay < extMinY || ay > extMaxY || deadZoneCoords.has(`${ax},${ay}`)) {
            return null;
        }
    }

    return findNearestMapCell(x, y);
}

// getMapMeasureIndexAtPoint()と同様だが、グリッド外・余白マス（outsideExtent）による
// null判定を一切行わず、常に最も近いセルの小節を返す（距離無制限のフォールバックのみ）。
// ドラッグ中は、開始点さえ有効なセル上であれば（setupMapAreaDrag()のmousedownで保証済み）、
// 現在点がグリッド外や末尾の余白にはみ出しても選択自体は続行してほしい
// （「エンドポイントは有効として働いてほしい」との要望。クリックのみでの単発選択や、
// ドラッグの開始点判定には使わず、あくまで進行中のドラッグの現在点解決にだけ使う）
function getNearestMapMeasureIndex(x, y) {
    return findNearestMapCell(x, y);
}

// 開始点の小節（mousedown時点で一度だけ解決し確定させた値）・現在点の小節（都度解決）の
// 間を「まるっと」全部選択範囲にする（五線譜タブの`getMeasuresInDragRange`と同じ、開始小節→
// 終了小節の連続範囲という考え方。マップ上でグリッドが物理的にどう並んでいるかは無関係で、
// あくまで小節番号としての範囲選択にする）。
// 開始点は生座標(x1,y1)から毎回再解決するのではなく、mousedown時点で一度だけ解決した
// startMeasureIndexをそのまま受け取る。ドラッグ中に何らかの理由でグリッドが再描画され
// セル位置が変わった場合でも、開始小節の判定がブレないようにするため
// （現在点は生きたマウス位置を反映する必要があるため、その都度x2,y2から解決する）
function getMapMeasuresInDragRange(startMeasureIndex, x2, y2) {
    const endIndex = getNearestMapMeasureIndex(x2, y2);
    const result = new Set();
    if (startMeasureIndex === null || endIndex === null) return result;
    const from = Math.min(startMeasureIndex, endIndex);
    const to = Math.max(startMeasureIndex, endIndex);
    for (let i = from; i <= to; i++) result.add(i);
    return result;
}

// マップ上でのクリック/ドラッグによる小節選択。selectedMeasuresは五線譜タブの選択と共有の
// 状態のため、タブを切り替えると renderScore()/drawSelectionRect() が自動的にこの選択を
// 五線譜側にも反映する（逆に、五線譜タブで選択してからマップタブに切り替えた場合も
// renderMap()がselectedMeasuresを見てオーバーレイを描き直す）。
// 単発クリック（閾値未満の移動）ではその1マスの小節だけを選択、実際にドラッグした場合は
// 開始点の小節→現在点の小節までの連続範囲をまるごと選択する（五線譜タブのドラッグ選択と
// 同じ操作感。マス単位ではなく必ず小節単位で選択されるようにするため）
const MAP_DRAG_THRESHOLD_PX = 4;
let mapDragState = null;

function setupMapAreaDrag() {
    document.addEventListener("mousedown", (e) => {
        // 五線譜タブのドラッグ選択と同じく、マップが表示されている間はページのどこから
        // （#mapAreaの外からでも）ドラッグを開始できるようにする。ボタン等の通常操作の邪魔を
        // しないよう、それらの上でのmousedownだけは除外する。
        // 「両方」タブでは五線譜エリア内でのmousedownはこちらでは処理しない（setupGlobalEvents()側に任せる）
        if (activeTab !== "map" && activeTab !== "both") return;
        if (isSeekDragging) return;
        if (activeTab === "both" && e.target.closest("#scoreWrapper")) return;
        if (e.target.closest("button")) return;
        if (e.target.closest("input")) return;
        if (e.target.closest("label")) return;
        if (e.target.closest("select")) return;
        // マップエリアの拡縮ハンドル（.map-resize-handle）や、「並べて」タブの五線譜/マップ
        // 境界線（#bothTabDivider）をドラッグしている最中にもこのmousedownが反応してしまい、
        // 操作のたびに小節の選択状態が巻き込まれて変わってしまうバグがあったため、ここでも除外する
        if (e.target.closest(".map-resize-handle")) return;
        if (e.target.closest("#bothTabDivider")) return;
        // 音符/休符グループ（#toolbarDuration）のグリップハンドルをドラッグして移動する際、
        // フローティング中にマップ領域と重なっていても小節選択を巻き込まないよう除外する
        if (e.target.closest("#toolbarDuration")) return;
        // 下部の再生バー（曲名・BPM・音量・シークバー・A-B帯・再生ボタン等）からドラッグを
        // 始めても、小節選択を巻き込まないよう除外する
        if (e.target.closest("#playbackBar")) return;
        // ドロワー（調号・移調・マップ設定・音符グループ等）からドラッグを始めても、
        // 同様に小節選択を巻き込まないよう除外する
        if (e.target.closest("#drawer")) return;
        // 単発クリック（ドラッグに発展しなかった場合）用に、グリッド外・余白を除外する
        // 厳密な判定も別途取っておく。実際にドラッグに発展した場合は、開始点がグリッド外/
        // 余白上でも（＝マウスを下ろした瞬間はまだ厳密な判定で無効でも）、そこから実際に
        // ドラッグして有効なセルの方へ動かせば選択できてほしいため、ドラッグ開始自体は
        // 距離無制限の寛容な判定（getNearestMapMeasureIndex）で許可する
        const strictStartMeasureIndex = getMapMeasureIndexAtPoint(e.clientX, e.clientY);
        const lenientStartMeasureIndex = getNearestMapMeasureIndex(e.clientX, e.clientY);
        if (lenientStartMeasureIndex === null) return; // マップに小節が1つも無い等、本当に何も無い場合のみ諦める
        mapDragState = {
            startX: e.clientX,
            startY: e.clientY,
            currentX: e.clientX,
            currentY: e.clientY,
            isDragging: false,
            startMeasureIndex: lenientStartMeasureIndex,
            strictStartMeasureIndex,
        };
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!mapDragState) return;
        mapDragState.currentX = e.clientX;
        mapDragState.currentY = e.clientY;
        if (!mapDragState.isDragging) {
            const dx = mapDragState.currentX - mapDragState.startX;
            const dy = mapDragState.currentY - mapDragState.startY;
            if (Math.hypot(dx, dy) < MAP_DRAG_THRESHOLD_PX) return;
            mapDragState.isDragging = true;
        }
        const previewSet = getMapMeasuresInDragRange(
            mapDragState.startMeasureIndex,
            mapDragState.currentX, mapDragState.currentY
        );
        drawMapSelectionOverlays(previewSet);
        // 「両方」タブでは、ドラッグ中のプレビュー範囲をリアルタイムで五線譜側にも反映する
        if (activeTab === "both") drawSelectionRect(previewSet);
    });

    document.addEventListener("mouseup", () => {
        if (!mapDragState) return;
        if (mapDragState.isDragging) {
            const measures = getMapMeasuresInDragRange(
                mapDragState.startMeasureIndex,
                mapDragState.currentX, mapDragState.currentY
            );
            if (measures.size) selectedMeasures = measures;
        } else if (mapDragState.strictStartMeasureIndex !== null) {
            // 単発クリック（ドラッグしなかった場合）は、グリッド外・余白のクリックが誤って
            // 選択されないよう、厳密な判定の結果だけを使う
            selectedMeasures = new Set([mapDragState.strictStartMeasureIndex]);
        }
        mapDragState = null;
        // 選択が確定した瞬間なので、枠をふわっとフェードインさせる
        drawMapSelectionOverlays(undefined, true);
        // 「両方」タブでは、マップ側で確定した選択を五線譜側にも即座に反映する
        if (activeTab === "both") drawSelectionRect(undefined, true);
        // コピー/切り取りボタンの活性状態も、選択確定と同時に更新する
        // （五線譜側の同種の不具合と同じく、ここで呼ばないと他の再描画が起きるまで
        // 古い状態のまま表示され続けてしまう）
        updateStatusBar();
    });
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
    const panelCountImageSize = 19;

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
        count.style.cssText = "font-size:11px; color:var(--text-muted);";
        count.textContent = `×${countMap[group] || 0}`;

        item.appendChild(img);
        item.appendChild(count);
        panelCount.appendChild(item);
    });

    // レール数（レールマスの総数）・センサー数はマップの配置設定に基づいて計算
    const { grid } = buildMapGrid();
    let railCellCount = 0;
    let sensorCellCount = 0;
    grid.forEach((data, key) => {
        // レールは上位層/下位層にも表示用に複製されているため、実体(z=0)のみ数える
        const z = Number(key.split(",")[2]);
        if (z !== 0) return;
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
        label.style.cssText = "font-size:11px; color:var(--text-muted);";
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
    btn.style.width = `${24 * scale}px`;
    btn.style.height = `${24 * scale}px`;
    btn.style.fontSize = `${14 * scale}px`;
}

function saveHistory() {
    history = history.slice(0, historyIndex + 1);
    history.push(JSON.stringify(score));
    historyIndex++;
    hasUnsavedChanges = true;
    updateStatusBar();
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
    refreshMapAndAssemblyIfVisible();
    rescheduleFromCurrentPosition();
    showToast("元に戻しました", "fa-rotate-left");
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
    refreshMapAndAssemblyIfVisible();
    rescheduleFromCurrentPosition();
    showToast("やり直しました", "fa-rotate-right");
}

function getMeasuresPerRow() {
    // #scoreWrapperはマップタブ表示中はdisplay:noneになりclientWidthが0になるため、
    // その場合は常に表示されている#mainの幅を基準にする。
    // これを使わないと、マップタブで再生開始した場合に1行1小節と誤って計算され、
    // noteTimeMapのrowIndexが実際の行数と食い違い、五線譜タブに戻したときに再生位置の
    // 縦線が描画されなくなるバグになる。
    // 一方「両方」タブの左右レイアウトでは#scoreWrapperは非表示ではなく画面の半分幅で
    // 表示されているため、その場合は#scoreWrapper自身の幅を優先する（#mainの全幅を使うと
    // 実際より多い小節数で折り返してしまい、はみ出す）
    const scoreWrapper = document.getElementById("scoreWrapper");
    const wrapper = (scoreWrapper && scoreWrapper.clientWidth > 0) ? scoreWrapper : document.getElementById("main");
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
    const countBefore = notePositions.length;
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

    // この小節・この段について1件も記録できなかった場合（プレビューが小節の中身を
    // 丸ごと置き換え、実データにマッピングし直せる要素が1つも残らなかった場合——
    // 空の小節に最初の1音を置こうとホバーした時など、1個しか要素が無い小節で起こりうる）、
    // 次のmousemoveでのヒットテスト（findNoteAt/findNoteAtX）が完全に空振りし続けてしまう。
    // 直前の非プレビュー時点のスナップショット（stableNotePositions）で補っておくことで、
    // ホバー中も「本来そこに何があったか」の判定材料を失わないようにする
    if (notePositions.length === countBefore) {
        const cached = stableNotePositions.get(`${measureIndex}:${staff}`);
        if (cached) notePositions.push(...cached);
    }
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

// 1行分（複数小節）をVexFlowで構築し、rowDiv（未アペンド）を返す。
// renderScore()（全体再描画）とupdateHoverRows()（該当行だけの軽量再描画）の両方から呼ばれる共通ロジック
function buildRow(rowMeasures, rowIndex) {
        const isFirstRow = rowIndex === 0;

        const firstMeasureExtra = isFirstRow ? FIRST_MEASURE_EXTRA : 0;
        const rowWidth = (20 + firstMeasureExtra + rowMeasures.length * STAVE_WIDTH_BASE + 20) * scale;

        const rowDiv = document.createElement("div");
        rowDiv.style.position = "relative";
        rowDiv.dataset.rowIndex = rowIndex;

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

    return rowDiv;
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
        const rowDiv = buildRow(rowMeasures, rowIndex);
        scoreElement.appendChild(rowDiv);
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

    updateStatusBar();
}

// 選択中（確定 + ドラッグ中の暫定）の小節にDIVオーバーレイでハイライトを重ねる
// renderScore() を呼ばずに高速更新できるようにするための仕組み
// previewSetOverrideを渡すと、自分自身のdragStateではなく指定集合をプレビューとして描画する
// （「両方」タブでマップ側のドラッグプレビューをリアルタイムで五線譜側にも反映するために使う）
// animate=trueの場合、要素をopacity:0で追加した直後に次フレームでopacity:1へ遷移させ、
// ふわっとフェードインさせる。animate=false（既定）なら即座に表示する。
// ドラッグ中のライブプレビュー等、頻繁に再描画される場面でアニメーションさせると
// 毎回フェードがやり直されてかえってちらついて見えるため、そうした呼び出しでは使わない
// （選択操作が確定した瞬間だけanimate=trueを渡す）
function fadeInIfAnimated(el, animate) {
    if (!animate) {
        el.style.opacity = "1";
        return;
    }
    el.style.transition = "opacity 0.15s ease";
    el.style.opacity = "0";
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            el.style.opacity = "1";
        });
    });
}

// 要素をふわっとフェードアウトさせてから取り除く（0.15秒後にDOMから削除）
const SELECTION_FADE_MS = 150;
function fadeOutAndRemove(el) {
    el.style.transition = `opacity ${SELECTION_FADE_MS / 1000}s ease`;
    el.style.opacity = "0";
    setTimeout(() => el.remove(), SELECTION_FADE_MS);
}

// 保存/アンドゥ/リドゥなど、見た目に変化が出にくい操作の後に一瞬だけ
// 表示する通知（画面下中央に積み上げ、2秒ほどでフェードアウトして消える）
const TOAST_VISIBLE_MS = 2000;
const TOAST_FADE_MS = 200;
function showToast(message, icon = "fa-check") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<i class="fa-solid ${icon}"></i><span></span>`;
    el.querySelector("span").textContent = message;
    container.appendChild(el);
    setTimeout(() => {
        el.classList.add("toast-hide");
        setTimeout(() => el.remove(), TOAST_FADE_MS);
    }, TOAST_VISIBLE_MS);
}

function createSelectionHighlightEl(measureIndex, rowDivs) {
    const { rowIndex, left, right } = getMeasureXRange(measureIndex);
    const rowDiv = rowDivs[rowIndex];
    if (!rowDiv) return null;

    const top = rowDiv.offsetTop + (STAVE_TOP_BASE - 6) * scale;
    const height = (score.grandStaff ? GRAND_STAFF_GAP + 130 : 130) * scale;

    const el = document.createElement("div");
    el.className = "selectionHighlight";
    el.dataset.measureIndex = measureIndex;
    el.style.cssText = `
        position: absolute;
        left: ${left}px;
        top: ${top}px;
        width: ${right - left}px;
        height: ${height}px;
        background: rgba(74, 108, 247, 0.10);
        border: 1.5px solid rgba(74, 108, 247, 0.65);
        border-radius: 6px;
        box-shadow: 0 0 0 4px rgba(74, 108, 247, 0.12), 0 0 18px rgba(74, 108, 247, 0.28);
        box-sizing: border-box;
        pointer-events: none;
        z-index: 5;
    `;
    return el;
}

// animate=false（既定）: 従来通り、既存のハイライトを全部消してから対象を全部描き直す
// （小節の再レイアウト（拍子/ズーム変更等）を伴う通常の再描画で使う。位置がズレる心配が無い）
// animate=true: 現在表示中のハイライトと今回表示すべき集合を比較し、新しく選択された
// ものだけフェードイン、選択から外れたものだけフェードアウトさせる（既に表示中で
// 引き続き選択されているものはそのまま、消して作り直したりしない）
function drawSelectionRect(previewSetOverride, animate = false) {
    const scoreElement = document.getElementById("score");
    const rowDivs = scoreElement.querySelectorAll("div[data-row-index]");

    let previewSet = previewSetOverride || null;
    // 小節のドラッグ選択は音符モードでも使えるようにしているため、ここもモードを問わず
    // ドラッグ中であればプレビュー矩形を出す（クリックのみ音符モードでは音符配置に使う）
    if (!previewSet && dragState && dragState.isDragging) {
        previewSet = new Set(getMeasuresInDragRange(
            dragState.startX, dragState.startY,
            dragState.currentX, dragState.currentY
        ));
    }

    const wrapper = document.getElementById("scoreWrapper");

    if (!animate) {
        document.querySelectorAll(".selectionHighlight").forEach(el => el.remove());
        if (!rowDivs.length || !score.measures.length) return;
        score.measures.forEach((_, measureIndex) => {
            const isSelected = selectedMeasures.has(measureIndex) ||
                (previewSet && previewSet.has(measureIndex));
            if (!isSelected) return;
            const el = createSelectionHighlightEl(measureIndex, rowDivs);
            if (el) wrapper.appendChild(el);
        });
        return;
    }

    if (!rowDivs.length || !score.measures.length) {
        document.querySelectorAll(".selectionHighlight").forEach(el => fadeOutAndRemove(el));
        return;
    }

    const targetIndexes = new Set();
    score.measures.forEach((_, measureIndex) => {
        const isSelected = selectedMeasures.has(measureIndex) ||
            (previewSet && previewSet.has(measureIndex));
        if (isSelected) targetIndexes.add(measureIndex);
    });

    const existingByIndex = new Map();
    document.querySelectorAll(".selectionHighlight").forEach(el => {
        existingByIndex.set(Number(el.dataset.measureIndex), el);
    });

    existingByIndex.forEach((el, measureIndex) => {
        if (!targetIndexes.has(measureIndex)) fadeOutAndRemove(el);
    });

    targetIndexes.forEach(measureIndex => {
        if (existingByIndex.has(measureIndex)) return; // 既に表示中ならそのまま
        const el = createSelectionHighlightEl(measureIndex, rowDivs);
        if (!el) return;
        wrapper.appendChild(el);
        fadeInIfAnimated(el, true);
    });
}

function setupDeleteButtons() {
    document.querySelectorAll(".deleteMeasureBtn").forEach(b => b.remove());

    const wrapper = document.getElementById("scoreWrapper");
    const scoreElement = document.getElementById("score");
    const measuresPerRow = getMeasuresPerRow();
    // 行のDOM要素一覧はループ内では変化しないため、小節数ぶん毎回クエリし直さず1回だけ取得する
    // （以前は小節ごとにquerySelectorAllを呼んでおり、小節数が多いと無駄なDOM検索の
    // 積み重ねがボタン再構築のコストの大半を占めていた）
    const rowDivs = scoreElement.querySelectorAll("div[data-row-index]");

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
        const rowDiv = rowDivs[rowIndex];
        const rowOffsetTop = rowDiv ? rowDiv.offsetTop : 0;

        const leftPos = (sx + measureWidth / 2 - 12) * scale;
        const topPos = rowOffsetTop + ((score.grandStaff ? STAVE_TOP_LOWER : STAVE_TOP_BASE) + 110) * scale;

        btn.style.left = `${leftPos}px`;
        btn.style.top = `${topPos}px`;
        btn.style.display = "flex";
        btn.style.width = `${24 * scale}px`;
        btn.style.height = `${24 * scale}px`;
        btn.style.fontSize = `${14 * scale}px`;

        btn.addEventListener("click", () => {
            score.measures.splice(measureIndex, 1);
            selectedMeasures.clear();
            saveHistory();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
            refreshMapAndAssemblyIfVisible();
            rescheduleFromCurrentPosition();
        });

        wrapper.appendChild(btn);
    });
}

function setupInsertButtons() {
    document.querySelectorAll(".insertMeasureBtn").forEach(b => b.remove());

    const wrapper = document.getElementById("scoreWrapper");
    const scoreElement = document.getElementById("score");
    const measuresPerRow = getMeasuresPerRow();
    // setupDeleteButtons()と同様、行のDOM要素一覧は1回だけ取得してループ内で使い回す
    const rowDivs = scoreElement.querySelectorAll("div[data-row-index]");

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

        const rowDiv = rowDivs[rowIndex];
        const rowOffsetTop = rowDiv ? rowDiv.offsetTop : 0;

        const leftPos = (sx - 12) * scale;
        const topPos = rowOffsetTop + ((score.grandStaff ? STAVE_TOP_LOWER : STAVE_TOP_BASE) + 110) * scale;

        btn.style.left = `${leftPos}px`;
        btn.style.top = `${topPos}px`;
        btn.style.display = "flex";
        btn.style.width = `${24 * scale}px`;
        btn.style.height = `${24 * scale}px`;
        btn.style.fontSize = `${14 * scale}px`;

        btn.addEventListener("click", () => {
            score.measures.splice(measureIndex, 0, makeEmptyMeasure());
            selectedMeasures.clear();
            saveHistory();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
            refreshMapAndAssemblyIfVisible();
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
                        if (activeTab === "both") renderMap();
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
                    if (activeTab === "both") renderMap();
                } else {
                    // 既存の和音への音追加（この段の音符自体に追加するだけ、他の段とは無関係）
                    const pitch = yToPitch(clickYLocal, false);
                    if (pitch && !target.pitches.includes(pitch) && target.pitches.length < getChordMax()) {
                        target.pitches.push(pitch);
                        target.pitches.sort((a, b) => pitchToSemitone(a) - pitchToSemitone(b));
                        saveHistory();
                        renderScore();
                        if (activeTab === "both") renderMap();
                        // 音を設置した瞬間に、その音を鳴らして確認できるようにする
                        playNote(pitch, getAudioContext().currentTime, 0.3);
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
                if (activeTab === "both") renderMap();
                // 音を設置した瞬間に、その音を鳴らして確認できるようにする（休符の場合は鳴らさない）
                if (centerEntry.pitches) {
                    playNote(centerEntry.pitches[0], getAudioContext().currentTime, 0.3);
                }
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
                if (activeTab === "both") renderMap();
            } else {
                note.pitches.splice(hit.pitchIndex, 1);
                saveHistory();
                renderScore();
                if (activeTab === "both") renderMap();
            }
        }
    }
}

// 1つのsvg（1行分）に対するイベント配線。setupSVGEvents()（全行に配線）と、
// updateHoverRows()（差し替えた行だけに配線し直す軽量パス）の両方から呼ばれる
function setupSVGEventsForRow(svg, rowDiv) {
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
                // updateHoverRows()内でbuildRow()が読むのはグローバルhoveredPosのため、
                // 呼び出す前に更新しておく（後から更新すると、再構築時にまだ古いホバー位置の
                // ままプレビューが描かれてしまい、次のmousemoveが来ないケース（このまま
                // マウスがスコア外へ抜ける等）ではプレビューが消えずに残り続けてしまう）
                const prevHovered = hoveredPos;
                hoveredPos = null;
                updateHoverRows(prevHovered, null);
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
            const prevHovered = hoveredPos;
            hoveredPos = newHovered;
            updateHoverRows(prevHovered, newHovered);
        }
    });

    svg.addEventListener("mouseleave", () => {
        if (dragState) return;
        if (hoveredPos !== null) {
            const prevHovered = hoveredPos;
            hoveredPos = null;
            updateHoverRows(prevHovered, null);
        }
    });
}

function setupSVGEvents() {
    const scoreElement = document.getElementById("score");
    const svgs = scoreElement.querySelectorAll("svg");

    svgs.forEach(svg => {
        const rowDiv = svg.parentElement;
        setupSVGEventsForRow(svg, rowDiv);
    });
}

// hoveredPosが変わった時、影響を受ける行（変化前後のmeasureIndexが属する行、最大2行）だけを
// buildRow()で作り直し、他の行はそのままにする（renderScore()の全体再描画を避けるための軽量パス）
function rowIndexForMeasure(measureIndex) {
    return Math.floor(measureIndex / getMeasuresPerRow());
}

function updateHoverRows(prevHoveredPos, newHoveredPos) {
    const scoreElement = document.getElementById("score");
    const measuresPerRow = getMeasuresPerRow();
    const affectedRows = new Set();
    if (prevHoveredPos) affectedRows.add(rowIndexForMeasure(prevHoveredPos.measureIndex));
    if (newHoveredPos) affectedRows.add(rowIndexForMeasure(newHoveredPos.measureIndex));

    affectedRows.forEach(rowIndex => {
        const oldRowDiv = scoreElement.children[rowIndex];
        if (!oldRowDiv) return;

        const startMeasureIndex = rowIndex * measuresPerRow;
        const rowMeasures = score.measures
            .slice(startMeasureIndex, startMeasureIndex + measuresPerRow)
            .map((m, j) => ({ measure: m, measureIndex: startMeasureIndex + j }));
        if (rowMeasures.length === 0) return;

        const endMeasureIndex = startMeasureIndex + rowMeasures.length - 1;
        notePositions = notePositions.filter(p => p.measureIndex < startMeasureIndex || p.measureIndex > endMeasureIndex);

        const newRowDiv = buildRow(rowMeasures, rowIndex);
        scoreElement.replaceChild(newRowDiv, oldRowDiv);

        const svg = newRowDiv.querySelector("svg");
        if (svg) setupSVGEventsForRow(svg, newRowDiv);
    });
}

// document・wrapperレベルのイベントはmain()で一度だけ登録する
function updateEditModeButtons() {
    const noteBtn = document.getElementById("editModeNote");
    const selectBtn = document.getElementById("editModeSelect");
    if (!noteBtn || !selectBtn) return;
    noteBtn.style.color = editMode === "note" ? "#3451d1" : "#767676";
    selectBtn.style.color = editMode === "select" ? "#3451d1" : "#767676";
    noteBtn.style.background = editMode === "note" ? "#eaefff" : "";
    selectBtn.style.background = editMode === "select" ? "#eaefff" : "";
    // 編集モード自体が五線譜（音符の配置・選択）向けの概念のため、マップ単体タブでは
    // 表示だけしておき操作はできないようにする（「並べて」タブでは五線譜も見えているので
    // 通常通り使える）。グレーアウト自体は.toolbar button:disabledのCSSに任せる
    const disabledHere = activeTab === "map";
    noteBtn.disabled = disabledHere;
    selectBtn.disabled = disabledHere;
    // コピー/切り取り/貼り付けの使える/使えないは選択状態に応じて変わるため、
    // モード切替のたびにも改めて反映する
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
        btn.style.color = active ? "#3451d1" : "#767676";
        btn.style.background = active ? "#eaefff" : "";
    });
    updateStatusBar();
}

// 画面下部の#statusBar（保存状態・選択中の音符/小節・全体の小節数と再生時間・ズーム率）を
// 現在の状態から再計算して反映する。saveHistory()（内容の変更）・renderScore()（選択/ズーム変更を
// 含む再描画全般）・updateDurationButtons()（入力音価の切替）・BPM欄の入力など、
// 表示内容に影響しうる箇所から都度呼び出す
function updateStatusBar() {
    const saveEl = document.getElementById("statusSaveState");
    if (saveEl) {
        saveEl.classList.toggle("unsaved", hasUnsavedChanges);
        saveEl.innerHTML = hasUnsavedChanges
            ? '<i class="fa-solid fa-circle"></i> 未保存の変更'
            : '<i class="fa-solid fa-check"></i> 保存済み';
    }

    const selEl = document.getElementById("statusSelection");
    if (selEl) {
        if (selectedMeasures.size === 1) {
            const idx = [...selectedMeasures][0];
            selEl.textContent = `${idx + 1}小節目を選択中`;
        } else if (selectedMeasures.size > 1) {
            const indices = [...selectedMeasures];
            const min = Math.min(...indices) + 1;
            const max = Math.max(...indices) + 1;
            selEl.textContent = `${min}-${max}小節を選択中`;
        } else {
            const label = DURATION_LABELS[selectedDuration] || "";
            selEl.textContent = `入力音価: ${label}${dottedSelected ? "（付点）" : ""}`;
        }
    }

    // 選択状態はrenderScore()経由でここが呼ばれるたびに変わりうるため、
    // コピー/切り取り/貼り付けの使える/使えないもあわせて更新する
    updateClipboardButtons();

    const countEl = document.getElementById("statusMeasureCount");
    if (countEl && score) {
        const bpm = parseInt(document.getElementById("bpmInput")?.value) || 120;
        const beatsPerMeasure = getBeatsPerMeasure();
        const totalSeconds = score.measures.length * beatsPerMeasure * (60 / bpm);
        const m = Math.floor(totalSeconds / 60);
        const s = Math.floor(totalSeconds % 60);
        countEl.textContent = `全${score.measures.length}小節 / 再生時間 ${m}:${String(s).padStart(2, "0")}`;
    }

    const zoomEl = document.getElementById("statusZoom");
    if (zoomEl) {
        zoomEl.textContent = `${Math.round((scale / ZOOM_DISPLAY_BASE) * 100)}%`;
    }

    // BPMの変更でシークバーの総時間・現在位置の割合が変わりうるため、
    // 停止中も含めて都度追従させる
    updateSeekBar();
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
        ts44.style.color = newScorePendingTimeSig === "4/4" ? "#3451d1" : "#767676";
        ts44.style.background = newScorePendingTimeSig === "4/4" ? "#eaefff" : "";
    }
    if (ts34) {
        ts34.style.color = newScorePendingTimeSig === "3/4" ? "#3451d1" : "#767676";
        ts34.style.background = newScorePendingTimeSig === "3/4" ? "#eaefff" : "";
    }

    const single = document.getElementById("newScoreStaffSingle");
    const grand = document.getElementById("newScoreStaffGrand");
    if (single) {
        single.style.color = !newScorePendingGrandStaff ? "#3451d1" : "#767676";
        single.style.background = !newScorePendingGrandStaff ? "#eaefff" : "";
    }
    if (grand) {
        grand.style.color = newScorePendingGrandStaff ? "#3451d1" : "#767676";
        grand.style.background = newScorePendingGrandStaff ? "#eaefff" : "";
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

// 左からスライドしてくるドロワーメニューの開閉。ヘッダーは常に土台として固定し、
// ドロワーは本体コンテンツを押しやる常時表示スタイルのみ（オーバーレイ表示はしない）。
// 開閉は左端の矢印タブだけで行う。開閉状態はlocalStorageに保存し、次回訪問時も
// 再現する（未訪問時はデフォルトで開いた状態にする）。
// コンテンツを押しやるmargin-leftはアニメーションさせていない（複雑なコンテンツの
// margin-leftを毎フレーム変化させるともっさりして見えるため）ので、開閉と同時に
// 即座に折返し再計算してよい
function reflowForDrawerToggle() {
    updateBothTabContainerHeight();
    updateContentAreaMinHeights();
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
    // マップは呼び直さない：ドロワーの開閉で変わるのは#mapAreaWrapperの「表示幅」
    // （＝スクロールして見える範囲）だけで、マップの中身（canvasの実サイズ・グリッド
    // の内容・クリック判定用データ）はwrapValueやscale等に依存しwrapper幅には依存しない
    // ため、再構築の必要が無い（「並べて」タブの左右入れ替え最適化と同じ考え方。
    // window resizeハンドラも元々renderMap()を呼んでおらず、この関数だけ取り残されていた）。
    // 選択ハイライト・リサイズハンドル・コーナーオーバーレイもcanvas/wrapper基準の
    // 相対位置で決まるため、wrapper自体がCSSで押しやられるだけなら自動的に追従する

    // 組み立てプレビューは2Dマップと違い、renderer/カメラのアスペクト比がラッパーの
    // 実サイズに直接依存するカメラ駆動ビューポートなので、ドロワー開閉でも明示的に
    // リサイズが必要（window resizeイベントはドロワー開閉では発火しないため）
    if (activeTab === "assembly") resizeAssemblyRenderer();
}

function setDrawerOpen(open) {
    localStorage.setItem("drawerOpen", open ? "true" : "false");
    document.getElementById("drawer").classList.toggle("open", open);
    document.body.classList.toggle("drawer-pinned", open);
    // reflowForDrawerToggle()（renderScore()の全体再描画等）は小節数が多いと数百msかかる
    // ことがあり、クリック直後に同期実行すると、ブラウザは次の描画までクラス切り替えの
    // 反映すら止めてしまう（＝クリックしてから一瞬固まったように見えてからドロワーが
    // 開閉する）。setTimeout(fn,0)は次の描画より先にマクロタスクが実行されてしまうことが
    // あり確実ではないため、二重のrequestAnimationFrameを使う：1回目のコールバックが
    // 戻った時点でブラウザは「今のクラス変更を含む1フレーム」を実際に描画し、
    // その次のフレームで2回目のコールバック（実際の再計算）が走る、という形で
    // 「ドロワー自体の開閉が先に画面に映ってから、続きの再計算が行われる」ことを保証する
    requestAnimationFrame(() => {
        requestAnimationFrame(reflowForDrawerToggle);
    });
}

function setupDrawer() {
    // 開閉の初期状態（localStorageの"drawerOpen"）は、index.html内の早期スクリプトが
    // app.js読み込み前にbody/#drawerへ既に反映済み。おかげでスコアの初回描画時点で
    // 既に正しい幅になっており、ここで改めて適用・再描画し直す必要はない
    // （F5リロード時に「一瞬閉じた状態→開いた状態」とズレて見えるちらつきを防ぐため）。
    // ここでは以降のクリック操作の配線だけを行う
    const drawer = document.getElementById("drawer");
    const drawerTab = document.getElementById("drawerTab");

    // 縦位置（.drawer-tabのtransform:translateY(-50%)により、CSSのtopがそのままボタン
    // 中心のY座標になる）をドラッグで自由に変えられるようにする。保存済みの位置があれば復元
    const savedTabTop = localStorage.getItem("drawerTabTop");
    if (savedTabTop) drawerTab.style.top = savedTabTop;

    const DRAG_THRESHOLD_PX = 4;
    let dragState = null;

    drawerTab.addEventListener("mousedown", (e) => {
        const drawerRect = drawer.getBoundingClientRect();
        const startCenterY = drawerTab.getBoundingClientRect().top + drawerTab.offsetHeight / 2 - drawerRect.top;
        dragState = { startY: e.clientY, startCenterY, moved: false };
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!dragState) return;
        const dy = e.clientY - dragState.startY;
        if (!dragState.moved && Math.abs(dy) > DRAG_THRESHOLD_PX) dragState.moved = true;
        if (!dragState.moved) return;
        const drawerRect = drawer.getBoundingClientRect();
        const halfHeight = drawerTab.offsetHeight / 2;
        const newCenterY = Math.max(halfHeight, Math.min(drawerRect.height - halfHeight, dragState.startCenterY + dy));
        drawerTab.style.top = `${newCenterY}px`;
    });

    document.addEventListener("mouseup", () => {
        if (!dragState) return;
        if (!dragState.moved) {
            // ドラッグに発展しなかった単発クリックは、これまで通り開閉をトグルする
            const isOpen = drawer.classList.contains("open");
            setDrawerOpen(!isOpen);
        } else {
            localStorage.setItem("drawerTabTop", drawerTab.style.top);
        }
        dragState = null;
    });
}

// 操作ヘルプ（#info）はホバーで開くポップオーバーだが、ホバーだけだとマウスを離すと
// すぐ閉じてじっくり読めない・タッチ操作では開けないため、クリックで「ピン留め」して
// 開いたままにできるようにする。ピン留め中に外側をクリックすると閉じる
function setupHelpPopover() {
    const wrap = document.getElementById("infoWrap");
    const btn = document.getElementById("helpBtn");
    const popover = document.getElementById("info");
    const header = document.getElementById("infoHeader");
    const closeBtn = document.getElementById("infoCloseBtn");
    if (!wrap || !btn || !popover || !header || !closeBtn) return;

    let pinned = false;

    const setPinned = (value) => {
        pinned = value;
        btn.classList.toggle("pinned", pinned);
        popover.classList.toggle("pinned", pinned);
    };

    // ドラッグで動かした位置をリセットし、次回はまた「？」ボタンの下の定位置から開く
    const resetPosition = () => {
        popover.classList.remove("dragged");
        popover.style.left = "";
        popover.style.top = "";
    };

    btn.addEventListener("click", () => {
        setPinned(!pinned);
        if (!pinned) resetPosition();
    });

    closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setPinned(false);
        resetPosition();
    });

    // ウィンドウ内のどこをドラッグしても、ウィンドウのように自由な位置へ動かせる。
    // ドラッグ開始時に自動でピン留めもする（念のため、閉じた状態からのドラッグ開始でも
    // 表示されるようにするため）
    let dragState = null;
    popover.addEventListener("mousedown", (e) => {
        if (e.target.closest("#infoCloseBtn")) return;
        setPinned(true);
        const rect = popover.getBoundingClientRect();
        popover.classList.add("dragged");
        popover.style.left = `${rect.left}px`;
        popover.style.top = `${rect.top}px`;
        dragState = {
            startX: e.clientX,
            startY: e.clientY,
            startLeft: rect.left,
            startTop: rect.top,
        };
        e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
        if (!dragState) return;
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        popover.style.left = `${dragState.startLeft + dx}px`;
        popover.style.top = `${dragState.startTop + dy}px`;
    });

    document.addEventListener("mouseup", () => {
        dragState = null;
    });
}

// コンパス/「表示する層」オーバーレイ（#mapCornerOverlay）は#mapAreaWrapper基準の
// position:absoluteで右上に配置しているが、「並べて」タブ等#mapAreaWrapper自体が
// スクロールする（overflow:auto）場面では、スクロール内容の一部として一緒に流れて
// いってしまう。position:stickyはtop方向は効くがright方向はスクロール幅に依存して
// 効かなかったため、scrollイベントでスクロール量ぶんをtranslateで打ち消し、常に
// 同じ画面位置（右上の角）に留まるようにする
function setupMapCornerOverlayScrollSync() {
    const wrapper = document.getElementById("mapAreaWrapper");
    const overlay = document.getElementById("mapCornerOverlay");
    if (!wrapper || !overlay) return;
    wrapper.addEventListener("scroll", () => {
        overlay.style.transform = `translate(${wrapper.scrollLeft}px, ${wrapper.scrollTop}px)`;
    });
}

function setupGlobalEvents() {
    const wrapper = document.getElementById("scoreWrapper");

    // ドラッグ座標更新・確定判定（document全体で監視）
    document.addEventListener("mousemove", e => {
        if (!dragState) return;
        const wrapperRect = wrapper.getBoundingClientRect();
        // wrapper（「両方」タブではoverflow:autoでスクロール可能）の現在のスクロール量を
        // 足し戻し、rowDiv.offsetTopなど（スクロール位置に関係ない絶対座標）と比較可能な
        // 座標系に揃える。これが無いと、五線譜エリアをスクロールした状態でのドラッグ選択が
        // スクロール量ぶんズレた行を指してしまう（マップ側と同種のバグ）
        dragState.currentX = e.clientX - wrapperRect.left + wrapper.scrollLeft;
        dragState.currentY = e.clientY - wrapperRect.top + wrapper.scrollTop;

        const dx = dragState.currentX - dragState.startX;
        const dy = dragState.currentY - dragState.startY;
        if (!dragState.isDragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
            dragState.isDragging = true;
        }
        if (dragState.isDragging) {
            drawSelectionRect();
            // 「両方」タブでは、ドラッグ中のプレビュー範囲をリアルタイムでマップ側にも反映する
            if (activeTab === "both") {
                const previewSet = new Set(getMeasuresInDragRange(
                    dragState.startX, dragState.startY,
                    dragState.currentX, dragState.currentY
                ));
                drawMapSelectionOverlays(previewSet);
            }
        }
    });

    // mouseup（svg外でリリースされても確定させるため）
    document.addEventListener("mouseup", e => {
        if (!dragState) return;

        if (dragState.isDragging) {
            // 小節のドラッグ選択は音符モードでも有効にする（クリックのみ音符モードでは
            // 音符配置に使うため、実際にドラッグ移動した場合だけ選択として扱う）
            const measures = getMeasuresInDragRange(
                dragState.startX, dragState.startY,
                dragState.currentX, dragState.currentY
            );
            selectedMeasures = new Set(measures);
            dragState = null;
            renderScore();
            // 選択が確定した瞬間なので、枠をふわっとフェードインさせる
            drawSelectionRect(undefined, true);
            // 「両方」タブでは、五線譜側で確定した選択をマップ側にも即座に反映する
            if (activeTab === "both") drawMapSelectionOverlays(undefined, true);
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
                    drawSelectionRect(undefined, true);
                    if (activeTab === "both") drawMapSelectionOverlays(undefined, true);
                }
            } else {
                // 音符モード：通常の音符編集処理
                if (selectedMeasures.size > 0) {
                    selectedMeasures.clear();
                    renderScore();
                    if (activeTab === "both") drawMapSelectionOverlays();
                }
                if (svg && editMode === "note") {
                    handleNoteEdit(originalEvent, svg, rowDiv);
                }
            }
        }
    });

    // document全体のmousedownでドラッグ選択を開始（ページのどこからでも）
    document.addEventListener("mousedown", e => {
        // マップタブの操作（マップ側の独立したドラッグ選択、setupMapAreaDrag()）と
        // 干渉しないよう、このハンドラは五線譜が表示されている時だけ動く。
        // 「両方」タブでは五線譜・マップの両エリアが同時に見えるため、マップエリア内での
        // mousedownはこちらでは処理しない（setupMapAreaDrag()側に任せる）
        if (activeTab !== "score" && activeTab !== "both") return;
        if (isSeekDragging) return;
        if (activeTab === "both" && e.target.closest("#mapAreaWrapper")) return;
        if (e.target.closest("button")) return;
        if (e.target.closest("input")) return;
        if (e.target.closest("label")) return;
        if (e.target.closest("select")) return;
        // 「並べて」タブの五線譜/マップ境界線（#bothTabDivider）をドラッグしている最中にも
        // このmousedownが反応し、幅調整のたびに小節の選択状態が巻き込まれてしまうため除外する
        if (e.target.closest("#bothTabDivider")) return;
        // 操作ヘルプ（#infoWrap）は本文中どこからでもドラッグして移動できるが、そのドラッグが
        // 五線譜の小節選択を巻き込んでしまわないよう除外する
        if (e.target.closest("#infoWrap")) return;
        // 音符/休符グループ（#toolbarDuration）のグリップハンドルをドラッグして移動する際も、
        // 同様に五線譜の小節選択を巻き込んでしまわないよう除外する
        if (e.target.closest("#toolbarDuration")) return;
        // 下部の再生バー（曲名・BPM・音量・シークバー・A-B帯・再生ボタン等）からドラッグを
        // 始めても、小節選択を巻き込まないよう除外する
        if (e.target.closest("#playbackBar")) return;
        // ドロワー（調号・移調・マップ設定・音符グループ等）からドラッグを始めても、
        // 同様に小節選択を巻き込まないよう除外する
        if (e.target.closest("#drawer")) return;

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
            if (activeTab === "both") drawMapSelectionOverlays();
            // ここではrenderScore()を呼ばない（クリック位置の音符編集をこの後で
            // 行うため、その前に無駄な再描画をしたくない）が、コピー/切り取り
            // ボタンの活性状態はここで選択が変わった時点で直接更新しておかないと、
            // 五線譜上でマウスを動かす等の別の再描画が起きるまで古い状態のまま
            // 表示され続けてしまう
            updateStatusBar();
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
            startX: e.clientX - wrapperRect.left + wrapper.scrollLeft,
            startY: e.clientY - wrapperRect.top + wrapper.scrollTop,
            currentX: e.clientX - wrapperRect.left + wrapper.scrollLeft,
            currentY: e.clientY - wrapperRect.top + wrapper.scrollTop,
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

// スライダーのつまみより左側（設定値まで）を塗りつぶすため、値の割合を
// CSSカスタムプロパティ--fillに反映する（WebKit系トラックのグラデーション用。
// Firefoxは::-moz-range-progressがネイティブに塗りつぶすため未使用でも実害なし）
function updateSliderFill(el) {
    const min = parseFloat(el.min) || 0;
    const max = parseFloat(el.max) || 100;
    const pct = ((parseFloat(el.value) - min) / (max - min)) * 100;
    el.style.setProperty("--fill", `${pct}%`);
}

function updateZoom(newScale) {
    scale = newScale;
    const zoomSlider = document.getElementById("zoomSlider");
    zoomSlider.value = scale;
    updateSliderFill(zoomSlider);
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
    refreshMapAndAssemblyIfVisible();
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
    refreshMapAndAssemblyIfVisible();
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
    refreshMapAndAssemblyIfVisible();
    rescheduleFromCurrentPosition();
}

// コピー/切り取り/貼り付けは、小節が選択されている状態が前提の操作のため、
// 何も選択されていなければ（貼り付け先/対象が無いため実際にも無効な）グレーアウト表示にする。
// 音符モードでもドラッグで小節選択はできるため、判定はeditModeではなく
// selectedMeasuresの有無で行う。マップ単体タブでは五線譜が見えていないためグレーアウトする
function updateClipboardButtons() {
    const copyBtn = document.getElementById("copyBtn");
    const cutBtn = document.getElementById("cutBtn");
    const pasteBtn = document.getElementById("pasteBtn");
    const canUseClipboardOps = selectedMeasures.size > 0 && activeTab !== "map";
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
    refreshMapAndAssemblyIfVisible();
    rescheduleFromCurrentPosition();
}

// ===== MusicXML入出力 =====
// 保存は常にMusicXML形式で書き出す。読み込みは従来のJSON保存ファイル（後方互換）と、
// このアプリ自身が書き出したMusicXMLファイルの両方に対応する（他ソフト製の任意の
// MusicXMLファイルへの汎用対応は対象外。<backup>を使う複数声部やファイルごとに
// 異なるdivisions、タイ/スラーの混同、.mxl圧縮などの「現実のファイルの癖」を
// 吸収するのは別途大掛かりな作業になるため、今回は自分の書き出し形式を確実に
// 読み戻せることに専念する）

function escapeXmlText(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

// ピッチ文字列（例:"F#4"）→MusicXMLのstep/alter/octave
function pitchStringToMusicXML(pitchStr) {
    const match = pitchStr.match(/^([A-Ga-g])([#b]?)(-?\d+)$/);
    const step = match[1].toUpperCase();
    const alter = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
    const octave = parseInt(match[3], 10);
    return { step, alter, octave };
}

// MusicXMLのstep/alter/octave→ピッチ文字列
function musicXMLToPitchString(step, alter, octave) {
    const accidental = alter === 1 ? "#" : alter === -1 ? "b" : "";
    return `${step}${accidental}${octave}`;
}

// 1つの音符/休符オブジェクトのMusicXML上の長さ（divisions単位）を返す
function noteDurationUnits(note) {
    return Math.round(durationBeats[note.duration] * (note.dotted ? 1.5 : 1) * MUSICXML_DIVISIONS);
}

// 1段（upperNotes/lowerNotes）分の<note>要素群を組み立てる
function buildStaffNotesXML(notes, staffNumber, voiceNumber) {
    return notes.map(note => {
        const type = DURATION_TO_XML_TYPE[note.duration];
        const units = noteDurationUnits(note);
        const dotXml = note.dotted ? "<dot/>" : "";
        if (note.rest) {
            return `<note><rest/><duration>${units}</duration><voice>${voiceNumber}</voice><type>${type}</type>${dotXml}<staff>${staffNumber}</staff></note>`;
        }
        return note.pitches.map((pitchStr, i) => {
            const { step, alter, octave } = pitchStringToMusicXML(pitchStr);
            const alterXml = alter !== 0 ? `<alter>${alter}</alter>` : "";
            const chordXml = i > 0 ? "<chord/>" : "";
            return `<note>${chordXml}<pitch><step>${step}</step>${alterXml}<octave>${octave}</octave></pitch><duration>${units}</duration><voice>${voiceNumber}</voice><type>${type}</type>${dotXml}<staff>${staffNumber}</staff></note>`;
        }).join("");
    }).join("");
}

// 1段分の音符/休符列の合計長さ（divisions単位）。和音は1つの音符として1回だけ数える
function staffNotesUnits(notes) {
    return notes.reduce((sum, note) => sum + noteDurationUnits(note), 0);
}

// score（+title/bpm/northDirection/mapSettings）→MusicXML文字列
function scoreToMusicXML(scoreData, { title, bpm, northDirection: nd, mapSettings: ms }) {
    const fifths = KEY_SIG_FIFTHS[scoreData.keySignature] ?? 0;
    const [beatsNum, beatsDen] = (scoreData.timeSignature || "4/4").split("/").map(Number);
    const appState = JSON.stringify({ grandStaff: !!scoreData.grandStaff, northDirection: nd, mapSettings: ms });

    const measuresXml = scoreData.measures.map((measure, i) => {
        const upperXml = buildStaffNotesXML(measure.upperNotes, 1, 1);
        const lowerXml = buildStaffNotesXML(measure.lowerNotes, 2, 2);
        const backupUnits = staffNotesUnits(measure.upperNotes);

        const attributesXml = i === 0 ? `<attributes><divisions>${MUSICXML_DIVISIONS}</divisions><key><fifths>${fifths}</fifths></key><time><beats>${beatsNum}</beats><beat-type>${beatsDen}</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>G</sign><line>2</line></clef></attributes>` : "";
        const directionXml = i === 0 ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><sound tempo="${bpm}"/></direction>` : "";

        return `<measure number="${i + 1}">${attributesXml}${directionXml}${upperXml}<backup><duration>${backupUnits}</duration></backup>${lowerXml}</measure>`;
    }).join("");

    return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
<movement-title>${escapeXmlText(title)}</movement-title>
<identification><miscellaneous><miscellaneous-field name="pokoa:appState">${escapeXmlText(appState)}</miscellaneous-field></miscellaneous></identification>
<part-list><score-part id="P1"><part-name>Pokoa</part-name></score-part></part-list>
<part id="P1">${measuresXml}</part>
</score-partwise>`;
}

// 読み込んだファイルのテキストがJSON/MusicXML/不明のどれかを判定する
function detectFileFormat(text) {
    const trimmed = text.replace(/^﻿/, "").trim();
    if (/<score-partwise/i.test(trimmed.slice(0, 500))) return "musicxml";
    if (trimmed.startsWith("{")) return "json";
    return "unknown";
}

// .mxl（ZIP圧縮MusicXML、musescore.com等のダウンロードの既定形式）から、
// 中のMusicXML本体だけをテキストとして取り出す。解凍にはfflate（CDN読み込み、
// window.fflate）を使う。取り出した後のテキストはdetectFileFormat/musicXMLToScoreに
// そのまま渡せる（.mxlは「MusicXML本体をZIPで包んだ入れ物」でしかないため）
function extractMusicXMLFromMxl(arrayBuffer) {
    let entries;
    try {
        entries = fflate.unzipSync(new Uint8Array(arrayBuffer));
    } catch (err) {
        throw new Error(`ZIPとして展開できませんでした（${err.message || err}）`);
    }

    // 正規の.mxl構造では、META-INF/container.xmlのrootfileが本体のパスを教えてくれる
    let rootPath = null;
    const containerBytes = entries["META-INF/container.xml"];
    if (containerBytes) {
        const containerXml = new TextDecoder("utf-8").decode(containerBytes);
        const doc = new DOMParser().parseFromString(containerXml, "application/xml");
        const rootfileEl = doc.querySelector("rootfile");
        if (rootfileEl) rootPath = rootfileEl.getAttribute("full-path");
    }

    // container.xmlが無い/読めない/指しているファイルが実在しない場合のフォールバックとして、
    // META-INF以外にある.xml/.musicxmlエントリを1つ拾う
    if (!rootPath || !entries[rootPath]) {
        rootPath = Object.keys(entries).find(
            name => !name.startsWith("META-INF/") && /\.(musicxml|xml)$/i.test(name)
        );
    }

    if (!rootPath || !entries[rootPath]) {
        throw new Error("圧縮ファイル内にMusicXML本体が見つかりませんでした");
    }

    return new TextDecoder("utf-8").decode(entries[rootPath]);
}

// <pitch>要素→ピッチ文字列
function readPitchFromXML(pitchEl) {
    const step = pitchEl.querySelector("step").textContent;
    const alterEl = pitchEl.querySelector("alter");
    const alter = alterEl ? parseInt(alterEl.textContent, 10) : 0;
    if (alter !== 0 && alter !== 1 && alter !== -1) {
        throw new Error(`対応していない臨時記号です（alter=${alter}）`);
    }
    const octave = pitchEl.querySelector("octave").textContent;
    return musicXMLToPitchString(step, alter, octave);
}

// MusicXML文字列→{score, title, bpm, northDirection, mapSettings}。
// このアプリ自身が書き出した形式（1パート・2段・1段=1声部）以外は分かりやすい
// エラーメッセージ付きでErrorを投げる
function musicXMLToScore(xmlString) {
    const doc = new DOMParser().parseFromString(xmlString, "application/xml");
    if (doc.querySelector("parsererror")) {
        throw new Error("XMLとして解析できませんでした");
    }
    const root = doc.documentElement;
    if (!root || root.tagName !== "score-partwise") {
        throw new Error("score-partwise形式のMusicXMLのみ対応しています");
    }
    const parts = root.querySelectorAll(":scope > part");
    if (parts.length !== 1) {
        throw new Error("複数パートのMusicXMLには対応していません");
    }
    const part = parts[0];
    const measureEls = part.querySelectorAll(":scope > measure");
    if (measureEls.length === 0) {
        throw new Error("小節が見つかりませんでした");
    }

    const firstAttributes = measureEls[0].querySelector(":scope > attributes");
    if (!firstAttributes) {
        throw new Error("拍子/調号の情報（attributes）が見つかりませんでした");
    }
    const fifthsEl = firstAttributes.querySelector("key > fifths");
    const fifths = fifthsEl ? parseInt(fifthsEl.textContent, 10) : 0;
    const keySignature = FIFTHS_TO_KEY_SIG[fifths];
    if (!keySignature) {
        throw new Error(`対応していない調号です（fifths=${fifths}）`);
    }
    const beatsEl = firstAttributes.querySelector("time > beats");
    const beatTypeEl = firstAttributes.querySelector("time > beat-type");
    const timeSignature = beatsEl && beatTypeEl ? `${beatsEl.textContent}/${beatTypeEl.textContent}` : "4/4";
    const stavesEl = firstAttributes.querySelector("staves");
    const hasSecondStaff = stavesEl ? parseInt(stavesEl.textContent, 10) >= 2 : false;

    let appState = {};
    const miscField = root.querySelector('identification > miscellaneous > miscellaneous-field[name="pokoa:appState"]');
    if (miscField) {
        try { appState = JSON.parse(miscField.textContent); } catch { appState = {}; }
    }

    const titleEl = root.querySelector(":scope > movement-title");
    const title = titleEl ? titleEl.textContent : "NewScore";
    const soundEl = part.querySelector("sound[tempo]");
    const bpm = soundEl ? Math.round(parseFloat(soundEl.getAttribute("tempo"))) : 120;

    const measures = Array.from(measureEls).map((measureEl) => {
        const upperNotes = [];
        const lowerNotes = [];
        const currentSlotByStaff = { 1: null, 2: null };
        const seenVoiceByStaff = { 1: null, 2: null };

        measureEl.querySelectorAll(":scope > note").forEach((noteEl) => {
            const staffEl = noteEl.querySelector("staff");
            const staffNum = staffEl ? parseInt(staffEl.textContent, 10) : 1;
            if (staffNum !== 1 && staffNum !== 2) {
                throw new Error(`対応していない段番号です（staff=${staffNum}）`);
            }

            const voiceEl = noteEl.querySelector("voice");
            if (voiceEl) {
                const voiceNum = voiceEl.textContent;
                if (seenVoiceByStaff[staffNum] == null) {
                    seenVoiceByStaff[staffNum] = voiceNum;
                } else if (seenVoiceByStaff[staffNum] !== voiceNum) {
                    throw new Error("複数声部（voice）が混在する段には対応していません");
                }
            }

            const isChordFlag = !!noteEl.querySelector(":scope > chord");
            if (isChordFlag) {
                const target = currentSlotByStaff[staffNum];
                if (!target || !target.pitches) {
                    throw new Error("孤立した<chord/>要素があります");
                }
                const pitchEl = noteEl.querySelector("pitch");
                if (!pitchEl) throw new Error("<chord/>要素に音高情報がありません");
                target.pitches.push(readPitchFromXML(pitchEl));
                target.pitches.sort((a, b) => pitchToSemitone(a) - pitchToSemitone(b));
                return;
            }

            const typeEl = noteEl.querySelector("type");
            if (!typeEl) {
                throw new Error("音価（<type>）を持たない音符には対応していません");
            }
            const durationCode = XML_TYPE_TO_DURATION[typeEl.textContent];
            if (!durationCode) {
                throw new Error(`対応していない音価です（type=${typeEl.textContent}）`);
            }
            const dotted = !!noteEl.querySelector(":scope > dot");
            const isRest = !!noteEl.querySelector(":scope > rest");
            const targetArray = staffNum === 1 ? upperNotes : lowerNotes;

            let noteObj;
            if (isRest) {
                noteObj = { rest: true, duration: durationCode, ...(dotted ? { dotted: true } : {}) };
            } else {
                const pitchEl = noteEl.querySelector("pitch");
                if (!pitchEl) throw new Error("音高情報が見つかりませんでした");
                noteObj = { pitches: [readPitchFromXML(pitchEl)], duration: durationCode, ...(dotted ? { dotted: true } : {}) };
            }
            targetArray.push(noteObj);
            currentSlotByStaff[staffNum] = noteObj;
        });

        // 単一段のMusicXML（<staves>が無い等）を読んだ場合、下段が空のままだと
        // 「小節は常に上段/下段とも音符/休符で埋まっている」という前提が崩れるため、
        // 上段と同じ長さの休符で埋めておく
        if (lowerNotes.length === 0) {
            const upperBeats = upperNotes.reduce((sum, n) => sum + durationBeats[n.duration] * (n.dotted ? 1.5 : 1), 0);
            if (upperBeats > 0) lowerNotes.push(...beatsToRests(upperBeats));
        }

        return { upperNotes, lowerNotes };
    });

    return {
        score: {
            timeSignature,
            keySignature,
            grandStaff: appState.grandStaff != null ? !!appState.grandStaff : hasSecondStaff,
            measures,
        },
        title,
        bpm,
        northDirection: appState.northDirection != null ? appState.northDirection : 0,
        mapSettings: appState.mapSettings || null,
    };
}

// 読み込み完了後の共通後処理（JSON/MusicXMLどちらの読み込み結果もここに渡す）
function applyLoadedScore({ score: loadedScore, title, bpm, northDirection: loadedNorthDirection, mapSettings: loadedMapSettings }) {
    score = loadedScore;
    resetAbLoopRangeToFull();
    renderAbLoopBand();

    if (title != null) {
        document.getElementById("scoreTitleInput").value = title;
    }
    if (bpm != null) {
        document.getElementById("bpmInput").value = bpm;
    }
    if (loadedNorthDirection != null) {
        northDirection = loadedNorthDirection;
        updateCompassLabels();
    }
    if (loadedMapSettings) {
        Object.assign(mapSettings, loadedMapSettings);
        saveMapSettings();
        updateMapToolbarUI();
    }
    updateKeySignatureUI();

    history = [];
    historyIndex = -1;
    selectedMeasures.clear();
    saveHistory();
    // 読み込み直後はファイルの内容そのものなので「未保存の変更」ではない
    hasUnsavedChanges = false;
    renderScore();
    setupDeleteButtons();
    setupInsertButtons();
    refreshMapAndAssemblyIfVisible();
}

async function main() {

    loadSeBuffers();
    loadMapPanelImages();

    // タブUIの生成は取得したデータに依存しないため、fetch完了を待たず先に行う。
    // これをfetchの後に回すと、通信が終わるまでタブが1つも表示されない
    // （F5リロード時のちらつきの一因になっていた）
    const tabContainer = document.getElementById("tabContainer");
    TABS.forEach(tab => {
        const btn = document.createElement("button");
        btn.id = `tab-${tab.id}`;
        btn.className = "tab-btn";
        btn.innerHTML = `<i class="fa-solid ${tab.icon}"></i><span>${tab.label}</span>`;
        btn.addEventListener("click", () => switchTab(tab.id));
        tabContainer.appendChild(btn);
    });
    // 初回描画時は、インジケーターが(0,0)からスライドしてくるように見えないよう
    // transitionなしで即座にアクティブタブの位置へ配置する
    updateTabIndicator(false);

    applyTabVisibility();
    if (activeTab === "both") applyBothTabLayout();
    updateContentAreaMinHeights();
    updateSliderFill(document.getElementById("zoomSlider"));

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

    // サンプルJSONに表題・テンポ・コンパス・マップ設定があれば復元する（ズームはJSONに保存しない）
    if (data.title != null) {
        document.getElementById("scoreTitleInput").value = data.title;
    }
    if (data.bpm != null) {
        document.getElementById("bpmInput").value = data.bpm;
    }
    if (data.northDirection != null) {
        northDirection = data.northDirection;
        updateCompassLabels();
    }
    if (data.mapSettings) {
        Object.assign(mapSettings, data.mapSettings);
        saveMapSettings();
    }

    renderScore();
    saveHistory();
    // 起動直後はサンプルJSONそのままの状態なので「未保存の変更」ではない
    hasUnsavedChanges = false;
    updateStatusBar();
    setupDeleteButtons();
    setupInsertButtons();
    // localStorageに保存されたタブが「五線譜」以外の場合、そのタブの中身も初期描画する
    refreshMapAndAssemblyIfVisible();
    setupGlobalEvents(); // document/wrapperイベントは一度だけ登録
    setupMapResizeHandle();
    setupBothTabDivider();
    setupNoteToolbarDrag();
    setupMapAreaDrag();
    setupDrawer();
    setupHelpPopover();
    setupMapCornerOverlayScrollSync();
    setupAbLoopStrip();
    updateAbLoopStripGeometry();

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
            refreshMapAndAssemblyIfVisible();
        });

    document.getElementById("transposeUp")
        .addEventListener("click", () => {
            transposeScore(1);
            updateKeySignatureUI();
            saveHistory();
            renderScore();
            refreshMapAndAssemblyIfVisible();
            rescheduleFromCurrentPosition();
        });
    document.getElementById("transposeDown")
        .addEventListener("click", () => {
            transposeScore(-1);
            updateKeySignatureUI();
            saveHistory();
            renderScore();
            refreshMapAndAssemblyIfVisible();
            rescheduleFromCurrentPosition();
        });

    document.getElementById("copyBtn")
        .addEventListener("click", () => copySelectedMeasures());
    document.getElementById("cutBtn")
        .addEventListener("click", () => cutSelectedMeasures());
    document.getElementById("pasteBtn")
        .addEventListener("click", () => pasteSelectedMeasures());

    updateClipboardButtons();

    // マップ専用ツールバーのイベント登録（上下ボタンでMAP_LAYER_ORDER内を1つずつ移動）
    document.getElementById("mapLayerUp")?.addEventListener("click", () => {
        const idx = MAP_LAYER_ORDER.indexOf(mapSettings.activeLayer);
        if (idx <= 0) return;
        mapSettings.activeLayer = MAP_LAYER_ORDER[idx - 1];
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapLayerDown")?.addEventListener("click", () => {
        const idx = MAP_LAYER_ORDER.indexOf(mapSettings.activeLayer);
        if (idx === -1 || idx >= MAP_LAYER_ORDER.length - 1) return;
        mapSettings.activeLayer = MAP_LAYER_ORDER[idx + 1];
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapRailVertical")?.addEventListener("click", () => {
        mapSettings.railDirection = "vertical";
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapRailHorizontal")?.addEventListener("click", () => {
        mapSettings.railDirection = "horizontal";
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    ["top-left","top-right","bottom-left","bottom-right"].forEach(corner => {
        document.getElementById(`mapCorner-${corner}`)?.addEventListener("click", () => {
            mapSettings.startCorner = corner;
            saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
        });
    });
    document.getElementById("mapSideLeft")?.addEventListener("click", () => {
        mapSettings.sideFirst = "left";
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapSideRight")?.addEventListener("click", () => {
        mapSettings.sideFirst = "right";
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapWrapValue")?.addEventListener("change", e => {
        mapSettings.wrapValue = Math.max(1, parseInt(e.target.value) || 1);
        saveMapSettings(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapWrapDown")?.addEventListener("click", () => {
        mapSettings.wrapValue = Math.max(1, mapSettings.wrapValue - 1);
        const el = document.getElementById("mapWrapValue");
        if (el) el.value = mapSettings.wrapValue;
        saveMapSettings(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapWrapUp")?.addEventListener("click", () => {
        mapSettings.wrapValue = mapSettings.wrapValue + 1;
        const el = document.getElementById("mapWrapValue");
        if (el) el.value = mapSettings.wrapValue;
        saveMapSettings(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapShowUnusedSensors")?.addEventListener("click", () => {
        mapSettings.hideUnusedSensors = false;
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapHideUnusedSensors")?.addEventListener("click", () => {
        mapSettings.hideUnusedSensors = true;
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    updateMapToolbarUI();

    window.addEventListener("resize", () => {
        updateBothTabContainerHeight();
        updateContentAreaMinHeights();
        renderScore();
        setupDeleteButtons();
        setupInsertButtons();
        updateAbLoopStripGeometry();
        if (activeTab === "assembly") resizeAssemblyRenderer();
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
            refreshMapAndAssemblyIfVisible();
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
                updateZoom(Math.min(scale + 0.1, ZOOM_MAX));
            } else {
                updateZoom(Math.max(scale - 0.1, ZOOM_MIN));
            }
        }
    }, { passive: false });

    document.getElementById("zoomIn")
        .addEventListener("click", () => {
            updateZoom(Math.min(scale + 0.1, ZOOM_MAX));
        });

    document.getElementById("zoomOut")
        .addEventListener("click", () => {
            updateZoom(Math.max(scale - 0.1, ZOOM_MIN));
        });

    document.getElementById("zoomSlider")
        .addEventListener("input", (e) => {
            updateZoom(parseFloat(e.target.value));
        });

    function toggleNorthDirection() {
        northDirection = (northDirection + 1) % 4;
        updateCompassLabels();
        updateCountsBar();
        refreshMapAndAssemblyIfVisible();
    }
    document.getElementById("compassBtn")?.addEventListener("click", toggleNorthDirection);
    document.getElementById("assemblyCompassBtn")?.addEventListener("click", toggleNorthDirection);

    // 組み立てプレビューのグリッド線ON/OFF
    const assemblyGridToggleBtn = document.getElementById("assemblyGridToggleBtn");
    if (assemblyGridToggleBtn) {
        const applyAssemblyGridToggleStyle = () => {
            const icon = assemblyGridToggleBtn.querySelector("i");
            if (icon) icon.style.color = assemblyGridVisible ? "#4a6cf7" : "#ccc";
        };
        applyAssemblyGridToggleStyle();
        assemblyGridToggleBtn.addEventListener("click", () => {
            assemblyGridVisible = !assemblyGridVisible;
            assemblyLayerGrids.forEach(g => { g.visible = assemblyGridVisible; });
            applyAssemblyGridToggleStyle();
            if (assemblyRenderer && assemblyCamera) assemblyRenderer.render(assemblyScene, assemblyCamera);
        });
    }

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
            resetAbLoopRangeToFull();
            renderAbLoopBand();
            saveHistory();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
            refreshMapAndAssemblyIfVisible();
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

    document.getElementById("restartBtn")
        .addEventListener("click", () => restartScore());

    // A-B区間ループの有効/無効トグル（区間自体はabLoopRangeに保持したまま、
    // 再生への反映だけをON/OFFする。#abLoopStripでの区間の描画・調整はそのまま）
    document.getElementById("abLoopToggleBtn")
        .addEventListener("click", () => {
            abLoopEnabled = !abLoopEnabled;
            renderAbLoopBand();
            updateSeekBar();
            rescheduleFromCurrentPosition();
        });

    document.getElementById("loopBtn")
        .addEventListener("click", () => {
            isLooping = !isLooping;
            const icon = document.querySelector("#loopBtn i");
            icon.style.color = isLooping ? "#4a6cf7" : "#ccc";
        });

    document.getElementById("bpmInput")
        .addEventListener("change", () => rescheduleFromCurrentPosition());
    document.getElementById("bpmInput")
        .addEventListener("input", () => updateStatusBar());

    const volumeSlider = document.getElementById("volumeSlider");
    volumeSlider.value = volume;
    updateSliderFill(volumeSlider);
    updateMuteIcon();
    volumeSlider.addEventListener("input", (e) => {
        volume = parseFloat(e.target.value);
        // スライダーを直接動かした場合は、以前のミュート状態を破棄する
        // （ミュートアイコンを押し直しても、意図せずミュート前の音量に戻らないように）
        volumeBeforeMute = null;
        localStorage.setItem("volume", volume);
        if (masterGainNode) masterGainNode.gain.value = volume;
        updateSliderFill(e.target);
        updateMuteIcon();
    });

    const seekBar = document.getElementById("seekBar");
    updateSeekBar();
    // ドラッグ開始～終了の間は、再生中でもtrackPlayback()側からつまみの値を
    // 上書きしない（isSeekDraggingで抑止）。'input'はドラッグ中に連続発火するので
    // 時間ラベルの追従だけに使い、実際のシーク（音の鳴らし直し）は指を離した
    // 'change'発火時にまとめて1回だけ行う
    seekBar.addEventListener("pointerdown", () => {
        isSeekDragging = true;
    });
    seekBar.addEventListener("input", (e) => {
        let ratio = parseFloat(e.target.value);
        const previewMeasureIndex = getMeasureIndexForRatio(ratio);
        // A-B区間ループ中は、getMeasureIndexForRatio()が区間内にクランプした結果を
        // つまみ自体の値にも反映し直し、区間の外へドラッグしても見た目上つまみが
        // 区間の境界より外へ出ないようにする（表示中の秒数ともズレないように揃える）
        if (abLoopRange && abLoopEnabled && previewMeasureIndex !== null) {
            ratio = previewMeasureIndex / score.measures.length;
            e.target.value = ratio;
        }
        document.getElementById("seekTimeCurrent").textContent =
            formatPlaybackTime(ratio * getFullSongDuration());
        updateSliderFill(e.target);
        if (previewMeasureIndex !== null) previewSeekHighlight(previewMeasureIndex);
    });
    seekBar.addEventListener("change", (e) => {
        isSeekDragging = false;
        seekToRatio(parseFloat(e.target.value));
    });
    // 値が変化しないままクリック位置で指を離した場合は'change'が発火せず、
    // isSeekDraggingがtrueのまま固まってシークバーが二度と自動追従しなくなるため、
    // 保険としてdocument全体のpointerupでも必ずフラグを戻す
    document.addEventListener("pointerup", () => {
        isSeekDragging = false;
    });
    // つまみをドラッグ中にカーソルがトラックの外（五線譜やマップ側）へ少しでもはみ出すと、
    // ブラウザ側のテキスト選択（ドラッグ選択）が一緒に発生してしまうことがあるため、
    // ドラッグ中はselectstartを止めて選択が始まらないようにする
    document.addEventListener("selectstart", (e) => {
        if (isSeekDragging) e.preventDefault();
    });

    document.getElementById("muteBtn").addEventListener("click", () => {
        if (volumeBeforeMute === null) {
            volumeBeforeMute = volume;
            volume = 0;
        } else {
            volume = volumeBeforeMute;
            volumeBeforeMute = null;
        }
        volumeSlider.value = volume;
        localStorage.setItem("volume", volume);
        if (masterGainNode) masterGainNode.gain.value = volume;
        updateSliderFill(volumeSlider);
        updateMuteIcon();
    });

    document.getElementById("saveBtn")
        .addEventListener("click", async () => {
            const title = document.getElementById("scoreTitleInput").value || "NewScore";
            const bpm = parseInt(document.getElementById("bpmInput").value) || 120;
            const xml = scoreToMusicXML(score, { title, bpm, northDirection, mapSettings: { ...mapSettings } });

            // File System Access API対応ブラウザ（Chrome/Edge等）では、保存先を
            // エクスプローラーのダイアログで選べるようにする。非対応ブラウザ
            // （Firefox/Safari等）では、従来通りダウンロードフォルダへ自動保存する
            if (window.showSaveFilePicker) {
                try {
                    const handle = await window.showSaveFilePicker({
                        suggestedName: `${title}.musicxml`,
                        types: [{ description: "MusicXMLファイル", accept: { "application/vnd.recordare.musicxml+xml": [".musicxml", ".xml"] } }],
                    });
                    const writable = await handle.createWritable();
                    await writable.write(xml);
                    await writable.close();
                    hasUnsavedChanges = false;
                    updateStatusBar();
                    showToast(`「${title}」を保存しました`, "fa-floppy-disk");
                } catch (err) {
                    // ユーザーがダイアログをキャンセルした場合は何もしない
                    if (err.name !== "AbortError") console.error(err);
                }
                return;
            }

            const blob = new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${title}.musicxml`;
            a.click();
            URL.revokeObjectURL(url);
            hasUnsavedChanges = false;
            updateStatusBar();
            showToast(`「${title}」を保存しました`, "fa-floppy-disk");
        });

    document.getElementById("loadFile")
        .addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => {
                const buffer = event.target.result;
                const bytes = new Uint8Array(buffer);
                let text;

                // 先頭2バイトがZIPのマジックナンバー"PK"（0x50,0x4B）なら.mxl（ZIP圧縮
                // MusicXML）とみなして解凍する。拡張子ではなく中身のバイト列で判定するため、
                // 拡張子を.xmlにリネームした.mxl等でも正しく扱える
                if (bytes[0] === 0x50 && bytes[1] === 0x4B) {
                    try {
                        text = extractMusicXMLFromMxl(buffer);
                    } catch (err) {
                        alert(`圧縮ファイル（.mxl）の展開に失敗しました\n${err.message || ""}`);
                        return;
                    }
                } else {
                    text = new TextDecoder("utf-8").decode(buffer);
                }

                const format = detectFileFormat(text);

                if (format === "json") {
                    try {
                        const data = JSON.parse(text);
                        const [tsNumLoad, tsDenLoad] = (data.timeSignature || "4/4").split("/").map(Number);
                        const beatsPerMeasureLoad = tsNumLoad * 4 / tsDenLoad;
                        const loadedScore = {
                            timeSignature: data.timeSignature,
                            keySignature: data.keySignature || "C",
                            grandStaff: !!data.grandStaff,
                            measures: migrateMeasuresToStaffArrays(data.measures, !!data.grandStaff, beatsPerMeasureLoad)
                        };
                        applyLoadedScore({
                            score: loadedScore,
                            title: data.title,
                            bpm: data.bpm,
                            northDirection: data.northDirection,
                            mapSettings: data.mapSettings,
                        });
                    } catch (err) {
                        alert("JSONの読み込みに失敗しました");
                    }
                } else if (format === "musicxml") {
                    try {
                        applyLoadedScore(musicXMLToScore(text));
                    } catch (err) {
                        alert(`MusicXMLの読み込みに失敗しました（このアプリで書き出したファイル以外は現時点で非対応です）\n${err.message || ""}`);
                    }
                } else {
                    alert("対応していないファイル形式です");
                }
            };
            reader.readAsArrayBuffer(file);
            e.target.value = "";
        });
}

main().catch(console.error);