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

// デバッグ用の隠しウィンドウ（Ctrl+Shift+Dで表示/非表示）。「隠しデバッグウィンドウが欲しい」
// との依頼に対応。中身は当初からは決めておらず、必要になった時にdebugStateへキーを足していく
// 運用にする（例: debugState.playState = playState; renderDebugPanel();）。
// renderDebugPanel()はdebugStateの中身をそのままキー: 値の一覧として#debugPanelBodyに描画する
let debugState = {};
// デバッグウィンドウの「テーマ」設定（デフォルト/UNDERTALE/マフェット戦）。3Dプレビューの
// 空・陸の見た目を切り替える（applyAssemblyThemeVisuals参照）。3Dシーンがまだ無い間に
// 選ばれても、initAssemblyScene()が生成直後にこの値を見て反映するため問題ない
const DEBUG_THEMES = ["default", "undertale", "muffet"];
let debugTheme = DEBUG_THEMES.includes(localStorage.getItem("debugTheme")) ? localStorage.getItem("debugTheme") : "default";
function toggleDebugPanel() {
    const panel = document.getElementById("debugPanel");
    if (!panel) return;
    const nowVisible = panel.style.display === "none";
    panel.style.display = nowVisible ? "flex" : "none";
    if (nowVisible) renderDebugPanel();
}
function renderDebugPanel() {
    const body = document.getElementById("debugPanelBody");
    if (!body) return;
    const keys = Object.keys(debugState);
    body.textContent = keys.length
        ? keys.map(k => `${k}: ${JSON.stringify(debugState[k])}`).join("\n")
        : "（debugStateは空です。必要な項目をdebugStateに追加してください）";
}

// デバッグウィンドウの、ヘッダードラッグでの移動・閉じるボタン・テーマ切り替えを配線する。
// 「もっと使いやすくしてほしい」との依頼に対応（#helpBtnのポップオーバーと同じ
// ドラッグ実装パターンを踏襲している）
function setupDebugPanel() {
    const panel = document.getElementById("debugPanel");
    const header = document.getElementById("debugPanelHeader");
    const closeBtn = document.getElementById("debugPanelCloseBtn");
    const themeSelect = document.getElementById("debugPanelThemeSelect");
    if (!panel || !header || !closeBtn || !themeSelect) return;

    closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        panel.style.display = "none";
    });

    // ヘッダーのどこをドラッグしても、ウィンドウのように自由な位置へ動かせる。
    // 初期配置はCSSのtop/rightだが、ドラッグを始めた瞬間に現在位置をleft/topへ
    // 焼き直してから追従させる（right指定のままだとleftで動かせないため）
    let dragState = null;
    header.addEventListener("mousedown", (e) => {
        if (e.target.closest("#debugPanelCloseBtn")) return;
        const rect = panel.getBoundingClientRect();
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.right = "auto";
        dragState = { startX: e.clientX, startY: e.clientY, startLeft: rect.left, startTop: rect.top };
        e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
        if (!dragState) return;
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        panel.style.left = `${dragState.startLeft + dx}px`;
        panel.style.top = `${dragState.startTop + dy}px`;
    });
    document.addEventListener("mouseup", () => { dragState = null; });

    // テーマ: デフォルト/UNDERTALEの2択。「ダーク/ライトではない」との訂正を受け、
    // CSS変数によるUI全体の配色切り替えはやめ、3Dプレビューの空・陸の見た目だけを
    // 切り替える方式にした（applyAssemblyThemeVisuals参照）
    themeSelect.value = debugTheme;
    themeSelect.addEventListener("change", () => {
        debugTheme = themeSelect.value;
        localStorage.setItem("debugTheme", debugTheme);
        applyAssemblyThemeVisuals();
    });
}

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
// 実際の発音（playNote呼び出し）の先読みスケジューラ用の状態。
// 「シークした位置から曲の終端までの残り音符を毎回まとめて一括でWeb Audioグラフに予約する」実装だと、
// 曲の前半（残り音符が多い位置）から再生するほど「予約済み未発音」のノードが長時間・大量に同時存在し、
// 実機のオーディオレンダリングスレッドが処理落ちして「出だしが重い/音がガビる」原因になっていた
// （詳しくは他PCでの調査引き継ぎ参照）。対策として、常に「今から数秒先まで」だけをplayNote()で
// 実際に予約し、再生が進むにつれて少しずつ継ぎ足す方式に変更する。
// pendingNoteEvents: {pitch, startTime, duration}を実際に鳴る時刻の昇順に並べたもの（休符は含まない）。
// scheduleMeasuresFrom()が呼ばれるたびに作り直す（テンポ変更・シーク・停止による再スケジュールに対応）
let pendingNoteEvents = [];
let pendingNoteEventsCursor = 0; // pendingNoteEventsのうち、まだplayNote()していない先頭位置
const SCHEDULE_LOOKAHEAD_SECONDS = 3; // 常にこの秒数先まで予約しておく
const SCHEDULE_TICK_INTERVAL_MS = 200; // 先読み分を継ぎ足す間隔
// scheduleMeasuresFrom()を呼ぶたびにインクリメントする世代カウンタ。先読みループ（setTimeoutで
// 継続する）は毎tickでこの値と自分が生成された時点の値を比較し、不一致なら（テンポ変更/シーク/
// 停止等で別のスケジュールに置き換わった証拠なので）静かに処理を打ち切る
let scheduleGeneration = 0;
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
// 「折り返しあり」時のみ使う、拍番号(beatIdx)→railIndex（mapBeatPositions/assemblyBeatCentersRaw
// 内での物理的な通し番号）の対応表。トロッコの表示位置（updateWrapTrolleyPositionAtTime）が
// 実際に鳴っている拍の正しい物理セルを求めるために使う。「折り返しなし」では使わない（空のまま）
let wrapBeatIndexToRailIndex = [];
// beatIndex -> [{px,py}]（現在表示中の層にある音符マットのセル左上、canvasローカル座標）。
// 「トロッコ通過時に音符マットを凹ませる」演出（2D版）用、renderMap()のたびに作り直す
let mapPanelPositionsByBeat = new Map();
let mapGridVisible = true; // #mapGridToggleBtnで切り替える、renderMap()を跨いで保持する（3Dプレビュー側のassemblyGridVisibleと対になる設定）

// トロッコの「見た目の位置」の進行方向用の状態（2D・3D共通）。動きが無い/ごく僅かな瞬間に
// 直前の向きを保持し続けるためだけに使う（resolveTrolleyDisplayPosition参照）
let trolleyDisplayForward = null;         // {x,y} 直前の実際の移動方向（正規化済み、3Dの向き表示用）

// 「コネクタ経路を実時間で辿る追いつきモード」は、このコードベースの現在のレール生成方式
// （buildFixedRailTrack＝経路上の隣接セルは必ず1マス差で大ジャンプが起きない設計、
// buildMapGridの非wrap分岐＝段同士が物理的に繋がっていないため瞬間移動が正しい仕様）の
// どちらでも実際には使われない（connectorPathsは常に空のMapのまま）と判明したため、
// 2026-09のコードレビューで撤去した。以前はここでcatchup用の状態（出発ビートindex・
// 経路・実時間の記録）をリセットしていたが、それらの変数自体を削除したため、現状は
// 何もしなくてよい（trolleyDisplayForwardは元々ここでリセットしていなかった、その
// ままの挙動を維持している）。呼び出し側（再生開始・停止・シーク時）はそのまま残して
// あるが、この関数自体は実質的に無効化されている
function resetTrolleyDisplayState() {
}

// beatIndex/tから見た目のトロッコ位置を求める。rawBeatCenters/戻り値の単位は呼び出し側が
// 渡すcellSize基準（2Dはpx換算済みのmapBeatPositions+mapRailCellSize、3Dは1マス=1の
// assemblyBeatCenters+ASSEMBLY_CELL_SIZE=1）。ビート間は線形補間。次ビートまでの距離が
// 遠い（段の折り返し等でレールが物理的に繋がっていない）場合は、その場で即座に目的地へ
// 瞬間移動する。
// 戻り値は{x,y}に加え、直前の実際の移動方向{forward:{x,y}}（3D側の向き表示用。動きが
// 無かった/ごく僅かだった場合は直前の向きをそのまま保持する）も含める
function resolveTrolleyDisplayPosition(rawBeatCenters, beatIndex, t, cellSize) {
    if (beatIndex == null || !rawBeatCenters || !rawBeatCenters[beatIndex]) return null;

    const updateForward = (fromPos, toPos) => {
        const fx = toPos.x - fromPos.x, fy = toPos.y - fromPos.y;
        const len = Math.hypot(fx, fy);
        if (len > 1e-6) trolleyDisplayForward = { x: fx / len, y: fy / len };
    };

    const posA = rawBeatCenters[beatIndex];
    const posB = rawBeatCenters[beatIndex + 1] || posA;
    const dx = posB.x - posA.x, dy = posB.y - posA.y;
    const bigJump = Math.hypot(dx, dy) > cellSize * 1.5;
    if (!bigJump) {
        const pos = { x: posA.x + dx * t, y: posA.y + dy * t };
        updateForward(posA, posB);
        return { x: pos.x, y: pos.y, forward: trolleyDisplayForward };
    }

    // 段の折り返し等、次ビートまでの距離が遠い（レールで物理的に繋がっていない）区間は
    // その場で即座に目的地（次のビート位置）へ瞬間移動する。
    // 「レールの端で次のレールに移るとき、向きが一瞬進行方向と逆になる」バグの原因：
    // ここでupdateForward(posA, posB)を呼んでいたため、posA（段の終端）→posB（次の段の
    // 先頭、折り返し軸方向にオフセットした位置）という、物理的に繋がっていない2点間の
    // 直線ベクトルがそのまま「向き」として採用されてしまっていた（「折り返しなし」時の
    // 段は同じ向きに並ぶ非ミラー行のため、この直線は実際の進行方向とほぼ正反対
    // （実測dot≈-0.92）になり得る）。この瞬間は向きを更新せず、直前まで使っていた
    // 向きを維持する
    return { x: posB.x, y: posB.y, forward: trolleyDisplayForward };
}

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
];
let activeTab = localStorage.getItem("activeTab") || "score";
// 廃止済みタブ（例: 旧パネル楽譜タブ・独立していた頃の「プレビュー」タブ）が
// localStorageに残っていた場合のフォールバック
if (!TABS.some(t => t.id === activeTab)) activeTab = "score";

// マップタブ内での表示モード（2Dマップ / 3Dプレビュー）。マップ単体タブ・「並べて」タブの
// どちらでも切り替えられる（「マップタブ内で、2Dと3Dを変えられるようにする」との依頼で、
// 独立した「プレビュー」タブを廃止しマップタブに統合した際に導入。当初は「並べて」タブは
// 2D固定としていたが、直後に「並べてタブでも、2D3Dボタンはいる」との追加依頼で「並べて」でも
// 切り替えられるよう拡張した）
let mapViewMode = localStorage.getItem("mapViewMode") || "3d";
if (mapViewMode !== "2d" && mapViewMode !== "3d") mapViewMode = "3d";
// マップエリア（マップタブ・「並べて」タブどちらでも）が3Dプレビュー表示中かどうか
// （旧`activeTab === "assembly"`相当の判定）
function isAssemblyActive() {
    return (activeTab === "map" || activeTab === "both") && mapViewMode === "3d";
}
function isMap2DActive() {
    return (activeTab === "map" || activeTab === "both") && mapViewMode === "2d";
}

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
    const flipEls = [document.getElementById("scoreWrapper"), document.getElementById("mapAreaWrapper"), document.getElementById("assemblyAreaWrapper"), document.getElementById("bothTabDivider")]
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
    mapArea.style.minHeight = (activeTab === "map" && mapViewMode === "2d") ? available : "";
}

function getAudioContext() {
    if (!audioCtx) {
        audioCtx = new AudioContext();
        masterGainNode = audioCtx.createGain();
        masterGainNode.gain.value = volume;
        // SE音源は音価で打ち切らず自然長（約0.5秒）のまま再生する仕様のため、音符の間隔が
        // それより短い（速い曲・密集した和音等）と多数の音が重なって鳴り続ける。それらを
        // 単純に加算した音量を制限する仕組みが無かったため、重なりが増えると音割れ
        // （クリッピング）していた。出力の最終段に軽いリミッター（コンプレッサー）を挟み、
        // 静かな場面には影響させず、重なって音量が大きくなった瞬間だけ自動で抑える
        // （値は他PCでのCPU負荷ストレステストで検証済みのものに揃えている）
        const limiter = audioCtx.createDynamicsCompressor();
        limiter.threshold.value = -6;  // このdBを超えた分だけ効き始める
        limiter.knee.value = 0;        // ちょうどthresholdからハードに効かせる
        limiter.ratio.value = 20;      // ほぼリミッター相当の強い圧縮比
        limiter.attack.value = 0.003;  // 音の頭を潰さないよう素早く反応
        limiter.release.value = 0.1;   // 短すぎるとポンピングして不自然になるため少し長めに
        masterGainNode.connect(limiter);
        limiter.connect(audioCtx.destination);
    }
    // ページ読み込み時に生成したAudioContextは、ブラウザの自動再生制限により
    // ユーザー操作なしでは"suspended"状態のまま留まることがある。明示的にresume()を
    // 試みておく（失敗しても無視——実際の再生開始側(startPlaybackFromMeasure)で
    // 改めてresume完了を待ってからスケジュールする）
    if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
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

// 音符マットの「マット」な見た目（brightness/saturateを効かせた版）のキャッシュ。
// ctx.filterを描画のたび（マス×フレームごと）に適用すると非常に重く
// （実測でユーザーから「2Dの処理が激重」との報告あり。Chromiumのcanvas filterは
// 通常のdrawImageよりずっとコストが高い）、ピッチの種類数（26種）分だけ
// オフスクリーンcanvasへ1回だけ焼き込んでおけば、以降は素のdrawImageで済む
const MAP_PANEL_FILTERED_IMAGES = {};
const MAP_PANEL_MATTE_FILTER = "brightness(0.9) saturate(0.92)";

function getMapPanelFilteredImage(pitch) {
    const key = toCanonicalPitch(pitch);
    const cached = MAP_PANEL_FILTERED_IMAGES[key];
    if (cached) return cached;
    const img = MAP_PANEL_IMAGES[key];
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const off = document.createElement("canvas");
    off.width = img.naturalWidth;
    off.height = img.naturalHeight;
    const offCtx = off.getContext("2d");
    offCtx.filter = MAP_PANEL_MATTE_FILTER;
    offCtx.drawImage(img, 0, 0);
    MAP_PANEL_FILTERED_IMAGES[key] = off;
    return off;
}

// 3Dプレビュー用: 音符マットの色味を少し濃く（彩度を上げる）した版のキャッシュ。
// 「3Dの音符マットをもう少し色味を濃くしたい」との依頼に対応。2Dの「マット化」
// （brightness/saturateを下げる）とは逆方向・別用途で、元の生画像（MAP_PANEL_IMAGES）
// を基準にする。ctx.filterを毎フレーム適用すると重い（2D側で実測済みの教訓）ため、
// 同じくオフスクリーンへ1回だけ焼き込んでキャッシュする
const MAP_PANEL_VIVID_IMAGES = {};
const MAP_PANEL_VIVID_FILTER = "saturate(1.35)";

function getMapPanelVividImage(pitch) {
    const key = toCanonicalPitch(pitch);
    const cached = MAP_PANEL_VIVID_IMAGES[key];
    if (cached) return cached;
    const img = MAP_PANEL_IMAGES[key];
    if (!img || !img.complete || img.naturalWidth === 0) return null;
    const off = document.createElement("canvas");
    off.width = img.naturalWidth;
    off.height = img.naturalHeight;
    const offCtx = off.getContext("2d");
    offCtx.filter = MAP_PANEL_VIVID_FILTER;
    offCtx.drawImage(img, 0, 0);
    MAP_PANEL_VIVID_IMAGES[key] = off;
    return off;
}

// 起動直後、複数の画像がほぼ同時に読み込み完了することが多いため、1枚読み込むごとに
// 都度キャンバス全体を再描画するのではなく、1フレームにまとめて1回だけ再描画する
let mapImageRedrawScheduled = false;
function scheduleMapPanelRedraw() {
    if (mapImageRedrawScheduled) return;
    mapImageRedrawScheduled = true;
    requestAnimationFrame(() => {
        mapImageRedrawScheduled = false;
        if (((activeTab === "map" && mapViewMode === "2d") || activeTab === "both") && mapRenderState) drawMapCanvas(mapRenderState);
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

// 「再生位置に自動で追従」トグル（#autoFollowToggleBtn、ABの左）。ONの間、再生中に
// 五線譜（.playLine）・2Dマップ（.mapPlayLine）の再生位置を自動でスクロール追従させる
// （trackPlayback参照）。挙動は2つで異なる: 五線譜は画面外に出た時だけキャッチアップする
// （maybeFollowPlaybackElement）のに対し、2Dマップは「常にトロッコが見えるように」との
// 指摘を受け、毎フレーム画面中心に追従させ続ける（followMapPlaybackContinuous）。
// 曲を跨いだ設定ではなく単なるUI操作の好みのため、volume等と同様localStorageに保存する
let autoFollowPlayback = localStorage.getItem("autoFollowPlayback") !== "false";

function applyAutoFollowToggleStyle() {
    const btn = document.getElementById("autoFollowToggleBtn");
    if (btn) btn.style.color = autoFollowPlayback ? "#4a6cf7" : "#ccc";
}

// 固定ヘッダー（#stickyHeader）・下部の再生バー（#playbackBar）に隠れていない、
// 実際に見えている縦方向の範囲を返す。「並べて」タブで#scoreWrapper/#mapAreaWrapper
// 自身がスクロールする場合・単体タブでウィンドウ自体がスクロールする場合のどちらでも、
// getBoundingClientRect()はビューポート基準の座標を返すため、この判定はどちらの
// スクロール方式でも共通して使える
function getPlaybackFollowSafeBounds() {
    const header = document.getElementById("stickyHeader");
    const playbackBar = document.getElementById("playbackBar");
    const top = header ? header.getBoundingClientRect().bottom : 0;
    const bottom = playbackBar ? playbackBar.getBoundingClientRect().top : window.innerHeight;
    return { top, bottom };
}

// 追従スクロールが不要に連発しないよう、クールダウンを設ける（五線譜専用。
// 2Dマップ側は毎フレーム型のfollowMapPlaybackContinuous()を使うため対象外）。
// smooth scrollのアニメーション中（数百ms）は毎フレームの判定でまだ「見えていない」と
// 出続けるため、クールダウン無しだと同じ位置へ何度もscrollIntoView()を呼び直して
// アニメーションが飛び飛びになってしまう
const AUTO_FOLLOW_SCROLL_COOLDOWN_MS = 600;
const autoFollowLastScrollAt = { score: 0 };

function maybeFollowPlaybackElement(el, key) {
    if (!autoFollowPlayback || !el) return;
    const rect = el.getBoundingClientRect();
    // 要素が display:none（非表示タブ側）の場合は幅・高さとも0になるため、
    // その場合は判定自体をスキップする（そのビューは今表示されていないので追従不要）
    if (rect.width === 0 && rect.height === 0) return;
    const bounds = getPlaybackFollowSafeBounds();
    const visible = rect.top >= bounds.top && rect.bottom <= bounds.bottom
        && rect.left >= 0 && rect.right <= window.innerWidth;
    if (visible) return;
    const now = performance.now();
    if (now - autoFollowLastScrollAt[key] < AUTO_FOLLOW_SCROLL_COOLDOWN_MS) return;
    autoFollowLastScrollAt[key] = now;
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
}

// 2Dマップ用の追従（五線譜と違い「常にトロッコが見えるように」との指摘を受け、五線譜側
// （画面外に出たら初めてキャッチアップする方式）より積極的な、毎フレーム型に変更した）。
// trackPlayback()から毎フレーム呼ばれ、トロッコ（.mapPlayLine）の画面中心からのズレを
// 都度そのまま打ち消すようスクロールし続ける——3D側のトロッコ視点チェイスカメラを
// DOMスクロールで模したイメージ。トロッコはdrawMapPlayLine側で1フレームごとに
// なめらかに移動するため、この関数も毎フレーム小さな量だけ動かすことになり、結果として
// 連続的なパンに見える（smoothスクロールではなく即時移動を毎フレーム繰り返す方式。
// smoothだと前フレームのアニメーションと競合してカクつく）
function followMapPlaybackContinuous(el) {
    if (!autoFollowPlayback || !el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return; // 2Dマップが非表示中は何もしない
    const bounds = getPlaybackFollowSafeBounds();
    const targetCx = window.innerWidth / 2;
    const targetCy = (bounds.top + bounds.bottom) / 2;
    const dx = (rect.left + rect.right) / 2 - targetCx;
    const dy = (rect.top + rect.bottom) / 2 - targetCy;
    if (dx === 0 && dy === 0) return;
    const wrapper = document.getElementById("mapAreaWrapper");
    // 「並べて」タブ等、#mapAreaWrapper自身がスクロールする（overflow:auto、
    // .bothTabActive時のみ）場合はそちらを、単体タブ表示（ウィンドウ自体がスクロールする）
    // ではウィンドウをスクロールする
    const wrapperScrolls = wrapper && ["auto", "scroll"].includes(getComputedStyle(wrapper).overflowY);
    if (wrapperScrolls) {
        wrapper.scrollBy({ left: dx, top: dy, behavior: "auto" });
    } else {
        window.scrollBy({ left: dx, top: dy, behavior: "auto" });
    }
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
    const timeline = computeMeasureTimeline();
    return Math.max(0, timeline[timeline.length - 1]);
}

function playScore() {
    if (playState !== "stopped") return;
    const { startMeasureIndex } = getPlaybackRangeMeasures();
    startPlaybackFromMeasure(startMeasureIndex);
}

// 指定した小節からスケジュールを組み直して再生を開始する（playScore()の本体であり、
// シーク（seekToRatio）からも「その位置の小節から再生し直す」ために使う）
function startPlaybackFromMeasure(measureIndex) {
    resetTrolleyDisplayState(); // 再生開始（ループ再開含む）は滑らかに追いつかせず先頭から
    playState = "playing";

    const ctx = getAudioContext();

    // ctx.currentTimeを基準にplayStartTime等を計算するため、実際にcontextが"running"に
    // なってから（resumeが完了してから）でないと、その後のスケジュール全体が
    // タイミングごとズレてしまう。"suspended"のまま読み進めてしまうバグへの対処
    const beginScheduling = () => {
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
        // （テンポマップ対応: 小節ごとに実効テンポが変わりうるため、累積タイムラインを使う）
        playAbsoluteElapsedAtStart = computeMeasureTimeline()[measureIndex];

        scheduleMeasuresFrom(measureIndex, { noteIndex: 0, time: playStartTime }, { noteIndex: 0, time: playStartTime }, beatIndexOffset, null);

        updatePlaybackButtons();
        trackPlayback();
    };

    if (ctx.state === "running") {
        beginScheduling();
    } else {
        // resumeが失敗した場合も（無音になるだけでも）スケジュール自体は行っておく。
        // resumeの完了待ちの間に、別のstopScore()等でこのctxが既に破棄され
        // （audioCtxが差し替わり）ている可能性があるため、完了時点でまだ自分が
        // 有効なcontextかどうかを確認してから実行する（古い方が後から発火して
        // 新しい再生状態を上書きしてしまう競合を防ぐ）
        const guardedBegin = () => { if (audioCtx === ctx) beginScheduling(); };
        ctx.resume().then(guardedBegin, guardedBegin);
    }
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
    const measuresPerRow = getMeasuresPerRow();
    const beatsPerMeasure = getBeatsPerMeasure();

    // 小節単位のスケジュール（noteSchedule: 小節ハイライト用、noteTimeMap: 再生位置ライン用、
    // beatSchedule: マップのセンサー点灯用）は、上段・下段どちらの音符内容にも依存しない。
    // 小節はどちらの配列で見ても必ず同じ拍数で埋まっているため、小節の開始・終了時刻は
    // その時点の実効テンポ（テンポマップ、score.measures[i].tempo）と小節番号だけで決まる
    // 純粋な算術で求められる（曲全体で単一だったbpmを、小節ごとに切り替わりうる値に拡張）
    let time = Math.min(upperResume.time, lowerResume.time);
    let beatIndex = beatIndexOffset;
    let currentBpm = getEffectiveTempoAtMeasure(startMeasureIndex);

    const endMeasureIndex = getPlaybackEndMeasureIndex();

    // 実際の発音（playNote呼び出し＝Web Audioのノード生成）は重い処理のため、ここでは
    // 「いつ・何を鳴らすか」をpendingNoteEventsに集めるだけに留め、実際にplayNote()するのは
    // 後段の先読みスケジューラ（scheduleLookaheadTick）に任せる（詳細は下のコメント参照）
    const collectedNoteEvents = [];

    for (let measureIndex = startMeasureIndex; measureIndex <= endMeasureIndex; measureIndex++) {
        if (score.measures[measureIndex].tempo != null) currentBpm = score.measures[measureIndex].tempo;
        const beatDuration = 60 / currentBpm;
        const sixteenthDuration = beatDuration * 0.25; // マップの1センサー(16分音符)分の長さ
        const measureDuration = beatsPerMeasure * beatDuration;

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

        noteSchedule.push({ measureIndex, startTime: measureStartTime, endTime: measureEndTime });
        noteTimeMap.push({
            startTime: measureStartTime,
            endTime: measureEndTime,
            startX: sx * scale,
            endX: (sx + measureWidth) * scale,
            rowIndex
        });
    }

    // 終了検知はtrackPlayback内でaudioCtx時刻を見て行う（setTimeoutは一時停止中もカウントが進んでしまうため使わない）
    playEndTime = time;

    // 音符境界スケジュール（upperNoteBoundarySchedule/lowerNoteBoundarySchedule、テンポ変更等での
    // 再開位置探しに使う）は、算術のみで軽いためこれまで通り曲の残り全体ぶんを毎回すぐに作る。
    // collectedNoteEvents（発音イベントの収集先）は上の小節ループより前で宣言済み
    // （曲の前半（残り音符が多い位置）から再生するときに、残り全部のノードを一度に生成すると
    // 実機のオーディオレンダリングスレッドが処理落ちし「出だしが重い/音がガビる」原因になっていた
    // ため、実際のplayNote()呼び出しは後段の先読みスケジューラ(scheduleLookaheadTick)に任せる）
    function scheduleStream(notesAccessor, boundarySchedule, resume) {
        // resume.timeは「その段の小節開始時刻＋スキップした音符の拍数分」であるはず（呼び出し元で
        // 保証）なので、残りの音符を順に足していけば、再開小節の末尾でちょうど小節終了時刻に一致する。
        // そのため2小節目以降は特別な調整をせず、そのままtを引き継げばよい
        let t = resume.time;
        let streamBpm = getEffectiveTempoAtMeasure(startMeasureIndex);
        for (let measureIndex = startMeasureIndex; measureIndex <= endMeasureIndex; measureIndex++) {
            if (score.measures[measureIndex].tempo != null) streamBpm = score.measures[measureIndex].tempo;
            const beatDuration = 60 / streamBpm;
            const measure = score.measures[measureIndex];
            const notes = notesAccessor(measure);
            const isResumeMeasure = measureIndex === startMeasureIndex;
            const noteStartIndex = isResumeMeasure ? resume.noteIndex : 0;

            for (let noteIndex = noteStartIndex; noteIndex < notes.length; noteIndex++) {
                const note = notes[noteIndex];
                const duration = noteBeats(note) * beatDuration;
                if (!note.rest && note.pitches) {
                    note.pitches.forEach(pitch => collectedNoteEvents.push({ pitch, startTime: t, duration: duration * 0.9 }));
                }
                boundarySchedule.push({ measureIndex, noteIndex, startTime: t, endTime: t + duration });
                t += duration;
            }
        }
    }

    scheduleStream(m => m.upperNotes, upperNoteBoundarySchedule, upperResume);
    scheduleStream(m => m.lowerNotes, lowerNoteBoundarySchedule, lowerResume);

    // 上段・下段合わせて、実際に鳴る時刻の昇順にソートしてから先読みスケジューラへ渡す
    // （上段を全部集めてから下段を全部集める順のままチャンク分割すると、曲頭で最初に鳴る
    // はずの下段の音が配列の後方に位置してしまい、処理に時間がかかった時に予定時刻を
    // 過ぎてから呼ばれる＝スケジュールの遅刻が起きるため、必ず時刻順に並べ直す）
    collectedNoteEvents.sort((a, b) => a.startTime - b.startTime);
    pendingNoteEvents = collectedNoteEvents;
    pendingNoteEventsCursor = 0;

    scheduleGeneration++;
    scheduleLookaheadTick(scheduleGeneration);
}

// 先読みスケジューラ本体。「今から数秒先（SCHEDULE_LOOKAHEAD_SECONDS）まで」に開始時刻がある
// pendingNoteEventsだけをplayNote()で実際に予約し、まだ先の分は次回以降のtickに残す。
// myGenerationは呼び出された時点のscheduleGeneration。以降のtickのたびに現在値と比較し、
// 一致しなくなっていたら（テンポ変更/シーク/停止等で別のスケジュールに置き換わった証拠）
// 静かに処理を打ち切る（audioCtxが閉じられている場合も同様に打ち切る）
function scheduleLookaheadTick(myGeneration) {
    if (myGeneration !== scheduleGeneration || !audioCtx) return;

    // 一時停止中はここで何もしない。pauseScore()はaudioCtxをsuspendするだけで、この
    // setTimeoutループ自体は止めていないため、チェックせずに進むとplayNote()内の
    // getAudioContext()が「suspendedなら自動でresume()する」ガード（ブラウザの自動再生
    // 制限対策）を踏んでしまい、一時停止したはずのcontextが数百ms後に勝手に再開され、
    // 音が鳴り続け・トロッコの定速アニメーションも一時停止中に進んでしまうバグになっていた
    // （「一時停止しても、再開したら少し先から始まる」として報告された）。
    // generationはそのまま維持し、tickだけを次回に先送りする——再開時に自動的に
    // 続きから追いつけるようにするため、ループ自体は止めない
    if (playState !== "playing") {
        setTimeout(() => scheduleLookaheadTick(myGeneration), SCHEDULE_TICK_INTERVAL_MS);
        return;
    }

    const horizon = audioCtx.currentTime + SCHEDULE_LOOKAHEAD_SECONDS;
    while (pendingNoteEventsCursor < pendingNoteEvents.length && pendingNoteEvents[pendingNoteEventsCursor].startTime < horizon) {
        const { pitch, startTime, duration } = pendingNoteEvents[pendingNoteEventsCursor];
        playNote(pitch, startTime, duration);
        pendingNoteEventsCursor++;
    }

    if (pendingNoteEventsCursor < pendingNoteEvents.length) {
        setTimeout(() => scheduleLookaheadTick(myGeneration), SCHEDULE_TICK_INTERVAL_MS);
    }
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

    // 現在の再生位置が、有効なA-Bループ区間のAより手前になっている場合（例: 区間外を
    // 再生中にABトグルをONにした、区間を今の再生位置より後ろへドラッグし直した等）、
    // そのまま続けると区間外（Aより前）を鳴らし続けてしまう。その場合は素直に続きを
    // 敷き直すのではなく、区間の先頭（A）へ直接ジャンプし直す
    const { startMeasureIndex: rangeStart } = getPlaybackRangeMeasures();
    if (resumeMeasureIndex < rangeStart) {
        restartPlaybackFromMeasure(rangeStart);
        return;
    }

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
        // ここから先はscheduleMeasuresFrom()を呼ばない（鳴らす曲がもう無いため）が、
        // 直前まで動いていた先読みループ（scheduleLookaheadTick）がまだ先の分を
        // 予約し残している可能性があるため、世代を進めて確実に打ち切る
        // （そのままにすると、削除済み/変更済みの小節の音が鳴ってしまうことがある）
        scheduleGeneration++;
        pendingNoteEvents = [];
        pendingNoteEventsCursor = 0;
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
    // 先読みループ（scheduleLookaheadTick）が万一まだ残っていても、世代を進めて確実に打ち切る
    // （audioCtxをnullにするだけでも次tickでガードされるが、念のため明示的にも無効化する）
    scheduleGeneration++;
    pendingNoteEvents = [];
    pendingNoteEventsCursor = 0;
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
    let startRatio = 0;
    if (abLoopRange && abLoopEnabled && score.measures.length > 0) {
        // テンポマップ対応: 小節番号の単純な比ではなく、累積タイムライン（秒）ベースの比にする
        const timeline = computeMeasureTimeline();
        const totalDuration = timeline[timeline.length - 1];
        startRatio = totalDuration > 0 ? timeline[abLoopRange.startMeasureIndex] / totalDuration : 0;
    }
    bar.style.setProperty("--fill-start", `${startRatio * 100}%`);
}

// シークバーで指定された割合(0〜1、再生対象範囲内での位置)へ再生位置を移動する。
// 小節単位で対象の小節を求め、そこからスケジュールを組み直して再生する
// （曲の途中の任意の時刻ちょうどから鳴らし直すのは、上段・下段の音符境界が
// 揃っていないと崩れるため、小節単位に丸めている）
// 「折り返しあり」の固定長線路（buildFixedRailTrack）上でのトロッコ位置を、指定した
// audioCtx時刻から算出し、currentHighlightBeatIndex/Tを更新してupdatePlaybackMarkers()を
// 呼ぶ。syncHighlightToMeasureStart（シーク時）・trackPlayback（毎フレーム）の両方で
// 同じ計算式を使うための共通化
function updateWrapTrolleyPositionAtTime(time) {
    // mapBeatPositionsは2D(renderMap)、assemblyBeatCentersRawは3D(rebuildAssemblyMeshes)
    // 側でしか埋まらないため、どちらか実際にレンダリング済みの方を使う
    const pathLen = mapBeatPositions.length || assemblyBeatCentersRaw.length;
    if (pathLen <= 1) return;

    // 「折り返しあり」の線路は曲の拍ぶんの直線＋行と行を繋ぐカーブから成るが、カーブの
    // 中間セルも行から間借りした実際の拍としてbeatSchedule・wrapBeatIndexToRailIndexに
    // 1:1で対応するため（buildFixedRailTrack参照）、非折り返しモードと同じ単純な
    // 「今の拍のrailIndexからnextRailIndexまでをtで線形補間」で滑らかに表示できる
    const currentBeat = beatSchedule.find(b => time >= b.startTime && time < b.endTime);
    let idx, t;
    if (currentBeat && wrapBeatIndexToRailIndex.length > 0) {
        const pos = wrapBeatIndexToRailIndex[currentBeat.beatIndex];
        const nextPos = wrapBeatIndexToRailIndex[currentBeat.beatIndex + 1];
        if (pos == null) {
            // 衝突等でこの拍にセンサー自体が配置されなかった稀なケース。位置は更新しない
            // （直前の表示のまま——レールを壊さない方を優先した既知の限界、pickSensorPosition参照）
            return;
        }
        const rawT = (currentBeat.endTime > currentBeat.startTime) ? (time - currentBeat.startTime) / (currentBeat.endTime - currentBeat.startTime) : 0;
        idx = pos;
        t = (nextPos != null) ? rawT : 0;
    } else {
        // beatSchedule/対応表が無い（再生していない・プレビュー等）場合のみ、従来の定速フォールバック
        const bpm = parseInt(document.getElementById("bpmInput")?.value) || 120;
        const cellsPerSec = 1 / ((60 / bpm) * 0.25);
        const posAlongPath = (time * cellsPerSec) % pathLen;
        idx = Math.floor(posAlongPath);
        t = posAlongPath - idx;
    }
    currentHighlightBeatIndex = idx;
    currentHighlightBeatT = t;
    updatePlaybackMarkers(idx, t);
}

// 指定した小節の頭の状態を、小節ハイライト・マップのマーカーへ即座に反映する。
// シークや最初に戻す操作は、一時停止中に行われるとtrackPlayback()のループが
// 1度も回らないまま止まってしまい、見た目が新しい位置に追従しないため、
// stopScore()+startPlaybackFromMeasure()の直後にこれを呼んで明示的に同期する
function syncHighlightToMeasureStart(measureIndex) {
    resetTrolleyDisplayState(); // シーク直後は滑らかに追いつかせず即座に正しい位置へ合わせる
    currentHighlightMeasure = measureIndex;
    highlightMeasure(measureIndex);
    if (mapSettings.railWrapEnabled) {
        // 「折り返しあり」のトロッコは曲の再生位置（小節）とは無関係な定速クロックのため、
        // シーク自体では動かさず、その時点のaudioCtx.currentTimeから改めて位置を求める
        if (audioCtx) updateWrapTrolleyPositionAtTime(audioCtx.currentTime);
    } else if (beatSchedule.length > 0) {
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
    resetTrolleyDisplayState(); // シーク直後は滑らかに追いつかせず即座に正しい位置へ合わせる
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
    // テンポマップ対応: 小節ごとの実際の長さ（秒）が均一とは限らないため、単純な
    // ratio×小節数ではなく、累積タイムライン（秒）上で目標時刻に対応する小節を探す
    const timeline = computeMeasureTimeline();
    const totalDuration = timeline[timeline.length - 1];
    const targetTime = ratio * totalDuration;
    let idx = measureCount - 1;
    for (let i = 0; i < measureCount; i++) {
        if (targetTime < timeline[i + 1]) { idx = i; break; }
    }
    return Math.min(measureCount - 1, Math.max(0, idx));
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
        // ABがOFFの間はA/Bを動かしても再生には一切影響しないはず（区間はまだ効いていない）
        // なので、どちらの分岐もabLoopEnabledの時だけ実行する
        if (abLoopEnabled && (playState === "playing" || playState === "paused")) {
            if (which === "start") {
                // Aを動かした場合、練習中に今聴いている位置を新しいAへ合わせる。
                // 一時停止中も、再開時に古いスケジュールのままだと新しいAより前
                // （旧区間側）が鳴ってしまうため、playing同様に組み直す
                restartPlaybackFromMeasure(abLoopRange.startMeasureIndex);
            } else {
                // Bを動かした場合は再生位置をジャンプさせる必要は無いが、そのままだと
                // 「今の再生位置が既に新しいBより後ろ」というケース（区間を今より手前へ
                // 縮めた場合）で、区間外（Bより後ろ）を鳴らし続けてしまう。
                // rescheduleFromCurrentPosition()が新しいB以降のスケジュールを
                // 打ち切ってくれる（現在鳴っている音符はそのまま鳴らし切ったうえで）
                rescheduleFromCurrentPosition();
            }
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

        if (mapSettings.railWrapEnabled) {
            // 「折り返しあり」は曲の拍数とは無関係な固定長の線路（buildFixedRailTrack）の
            // ため、トロッコは曲の再生位置とは無関係に一定速度で線路上を進める。
            // audioCtx.currentTime（一時停止で正しく止まり、再開で正しく再開する既存の
            // 時計）を使い、線路の全長で周回（終端まで来たら先頭へループ）させる
            updateWrapTrolleyPositionAtTime(now);
        } else {
            const currentBeat = beatSchedule.find(b => now >= b.startTime && now < b.endTime);
            if (currentBeat) {
                // レール上のマーカーは、このビートから次のビートへ1拍ぶんの時間で移動する
                const beatT = (now - currentBeat.startTime) / (currentBeat.endTime - currentBeat.startTime);
                currentHighlightBeatIndex = currentBeat.beatIndex;
                currentHighlightBeatT = beatT;
                updatePlaybackMarkers(currentBeat.beatIndex, beatT);
            }
        }
        followMapPlaybackContinuous(document.querySelector(".mapPlayLine"));

        for (let i = 0; i < noteTimeMap.length; i++) {
            const m = noteTimeMap[i];
            if (now >= m.startTime && now < m.endTime) {
                const t = (now - m.startTime) / (m.endTime - m.startTime);
                const x = m.startX + (m.endX - m.startX) * t;
                drawPlayLine(x, m.rowIndex);
                break;
            }
        }
        maybeFollowPlaybackElement(document.querySelector(".playLine"), "score");
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
    if (!canvas || !wrapper || !mapBeatPositions[beatIndex]) return;

    // beatIndex/beatIndex+1間の単純な線形補間（段の折り返し等で距離が遠い場合は瞬間移動。
    // 詳細はresolveTrolleyDisplayPosition参照）
    const local = resolveTrolleyDisplayPosition(mapBeatPositions, beatIndex, t, mapRailCellSize);
    if (!local) return;

    // localはcanvasローカル座標（canvasの左上を原点とするpx）。#mapAreaWrapper基準の
    // 座標に変換するため、canvasの実際の表示位置とwrapperのスクロール量を加算する
    // （選択ハイライトのcreateMapOverlayEl()と同じ変換パターン）
    const canvasRect = canvas.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const offsetX = canvasRect.left - wrapperRect.left + wrapper.scrollLeft;
    const offsetY = canvasRect.top - wrapperRect.top + wrapper.scrollTop;

    const x = local.x + offsetX;
    const y = local.y + offsetY;

    // 「トロッコはもう少し大きくていい、ただしマスからはみ出ない程度」との指定が
    // 0.4/0.9→0.5/0.95の後さらに続いたため、1マス(1.0)ちょうどまで引き上げた（長さ側）。
    // その後「トロッコの幅を少し広げてほしい」との依頼で、幅側（進行方向と直交する
    // 短辺）を0.55→0.65に拡張した（3D側の本体幅拡張と揃えた変更）
    const w = mapRailIsVertical ? mapRailCellSize * 0.65 : mapRailCellSize * 1.0;
    const h = mapRailIsVertical ? mapRailCellSize * 1.0 : mapRailCellSize * 0.65;

    const line = document.createElement("div");
    line.className = "mapPlayLine";
    line.style.cssText = `
        position: absolute;
        left: ${x - w / 2}px;
        top: ${y - h / 2}px;
        width: ${w}px;
        height: ${h}px;
        pointer-events: none;
        z-index: 8;
    `;
    // プリミティブ組み立てのトロッコ（buildProceduralTrolleyMesh）のスナップショット生成
    // （loadAssemblyTrolleyIcon2D参照）が完了済みならそのアイコン画像を使う。生成前は
    // SVGの簡易アイコンで代用し、生成完了後に呼ばれるdrawMapPlayLine()から自然に切り替わる
    line.innerHTML = assemblyTrolleyIcon2DDataURL
        ? `<img src="${assemblyTrolleyIcon2DDataURL}" style="width:100%;height:100%;display:block;">`
        : buildMapTrolleyIconSVG(w, h, mapRailIsVertical);
    wrapper.appendChild(line);
}

// 2Dマップの再生位置マーカーを、実機のトロッコ写真を参考にした簡易アイコン（荷台+
// 車輪4つ+取っ手、真上から見た形）として描くSVG文字列を組み立てる。w/hは呼び出し側
// （drawMapPlayLine）でレール向きに応じて長辺/短辺を入れ替え済みなので、ここでは
// isVerticalに応じてどちらが進行方向（長辺）かだけ見て配置する
function buildMapTrolleyIconSVG(w, h, isVertical) {
    const bodyColor = "#4a2035", wheelColor = "#263454", handleColor = "#1c1c1c";
    let bodyX, bodyY, bodyW, bodyH, wheelR, handleRect;
    if (isVertical) {
        bodyW = w * 0.72; bodyH = h * 0.66;
        bodyX = (w - bodyW) / 2; bodyY = (h - bodyH) / 2;
        wheelR = w * 0.26;
        handleRect = { x: bodyX + bodyW * 0.3, y: bodyY - h * 0.1, w: bodyW * 0.4, h: h * 0.14 };
    } else {
        bodyW = w * 0.66; bodyH = h * 0.72;
        bodyX = (w - bodyW) / 2; bodyY = (h - bodyH) / 2;
        wheelR = h * 0.26;
        handleRect = { x: bodyX + bodyW - w * 0.02, y: bodyY + bodyH * 0.3, w: w * 0.12, h: bodyH * 0.4 };
    }
    const wheelXs = [bodyX + wheelR * 0.4, bodyX + bodyW - wheelR * 0.4];
    const wheelYs = [bodyY + wheelR * 0.4, bodyY + bodyH - wheelR * 0.4];
    const wheels = wheelXs.flatMap(wx => wheelYs.map(wy =>
        `<circle cx="${wx}" cy="${wy}" r="${wheelR}" fill="${wheelColor}"/>`
    )).join("");
    // display:blockが無いと<svg>はinline要素としてベースライン基準で配置され、
    // フォントのディセンダー分だけ下に隙間ができて見た目が実際の位置よりも下にずれる
    // （「レールの横を走ってしまっている」との報告の原因。cellSizeが小さいマップでは
    // マーカー自体の高さ(h)がその隙間と同程度かそれより小さいため、1マス分ズレて見えた）
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="overflow:visible; display:block;">`
        + wheels
        + `<rect x="${bodyX}" y="${bodyY}" width="${bodyW}" height="${bodyH}" rx="${wheelR * 0.6}" fill="${bodyColor}"/>`
        + `<rect x="${handleRect.x}" y="${handleRect.y}" width="${handleRect.w}" height="${handleRect.h}" rx="${wheelR * 0.4}" fill="${handleColor}"/>`
        + `</svg>`;
}

// 2Dマップ版の「トロッコ通過時に音符マットを凹ませる」演出。3D版
// （setAssemblyPanelPressed）と同じ発想だがcanvasを再描画するのではなく、
// drawMapPlayLineと同じ「#mapAreaWrapperに重ねるDOM要素」方式にする（canvas全体を
// 毎フレーム再描画するのは長い曲で重くなるため避けたい）。凹み自体はCSSの
// inset box-shadowで表現し、暖色の半透明の帯を重ねて3D版の発光演出に寄せている
function updateMapPanelPressOverlays(beatIndex) {
    document.querySelectorAll(".mapPanelPressOverlay").forEach(el => el.remove());
    if (beatIndex == null) return;
    const positions = mapPanelPositionsByBeat.get(beatIndex);
    if (!positions || !positions.length) return;

    const canvas = document.getElementById("mapGrid");
    const wrapper = document.getElementById("mapAreaWrapper");
    if (!canvas || !wrapper) return;
    const canvasRect = canvas.getBoundingClientRect();
    const wrapperRect = wrapper.getBoundingClientRect();
    const offsetX = canvasRect.left - wrapperRect.left + wrapper.scrollLeft;
    const offsetY = canvasRect.top - wrapperRect.top + wrapper.scrollTop;
    const size = mapRailCellSize;
    const shadowSize = Math.max(3, size * 0.22);

    positions.forEach(({ px, py }) => {
        const overlay = document.createElement("div");
        overlay.className = "mapPanelPressOverlay";
        overlay.style.cssText = `
            position: absolute;
            left: ${px + offsetX}px;
            top: ${py + offsetY}px;
            width: ${size}px;
            height: ${size}px;
            border-radius: 3px;
            background: rgba(255, 176, 40, 0.45);
            box-shadow: inset 0 ${shadowSize}px ${shadowSize * 1.3}px rgba(0,0,0,0.55);
            pointer-events: none;
            z-index: 7;
        `;
        wrapper.appendChild(overlay);
    });
}

// 2Dマップ・プレビュー(3D)どちらでも再生中のトロッコ位置を表示する共通ヘルパー。
// updateAssemblyPlayMarker()はプレビュー用のThree.jsシーンがまだ無い（一度もタブを
// 開いていない）場合は内部で何もしない
function updatePlaybackMarkers(beatIndex, t = 0) {
    drawMapPlayLine(beatIndex, t);
    updateMapPanelPressOverlays(beatIndex);
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

// 曲中の任意の位置で「今のテンポ」を求める。score.measures[i].tempoは、その小節から
// 新しいテンポが始まる場合だけ持つ省略可能フィールド（無ければ直前の小節から継続）。
// measure0にも無ければ#bpmInput（テンポマップが無い曲の従来通りの基準テンポ）を使う。
// 呼び出し側でループしながら求める場合は、この関数を毎回0から呼ぶとO(n^2)になるため、
// 直前の値を保持するローカル変数を使って1回のループで済ませること（下記参照）
function getEffectiveTempoAtMeasure(measureIndex) {
    let tempo = parseInt(document.getElementById("bpmInput")?.value) || 120;
    for (let i = 0; i <= measureIndex && i < score.measures.length; i++) {
        if (score.measures[i].tempo != null) tempo = score.measures[i].tempo;
    }
    return tempo;
}

// 曲全体の「各小節の開始時刻（秒、曲頭=0基準）」をテンポマップ考慮の累積で求める。
// 戻り値はscore.measures.length+1個の配列（末尾は曲全体の合計時間=次の小節が
// あるとしたらの開始時刻）。getFullSongDuration・startPlaybackFromMeasure・
// updateStatusBar・measureIndexForFullSongRatio・updateSeekBarFillStartが共通で使う
function computeMeasureTimeline() {
    const beatsPerMeasure = getBeatsPerMeasure();
    let tempo = parseInt(document.getElementById("bpmInput")?.value) || 120;
    let t = 0;
    const starts = [0];
    for (let i = 0; i < score.measures.length; i++) {
        if (score.measures[i].tempo != null) tempo = score.measures[i].tempo;
        t += beatsPerMeasure * (60 / tempo);
        starts.push(t);
    }
    return starts;
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

// 組み立てプレビュー（3D）専用のツールバー。元は3Dキャンバス上に浮かせた
// #assemblyCornerOverlayの一部だったが、画面上部のメニューバーへ移設したため、
// 3Dプレビュー表示中（showMap3D）だけ表示する
const ASSEMBLY_3D_TOOLBAR_IDS = [
    "toolbarAssemblyCompass", "toolbarAssemblyGrid", "toolbarAssemblyColors", "toolbarAssemblyCamera"
];

// 2Dマップ専用のツールバー。元は2Dマップ上に浮かせた#mapCornerOverlayの一部
// （「表示する層」だけは引き続き#mapCornerOverlay側に残す）だったが、画面上部の
// メニューバーへ移設したため、2Dマップ表示中（showMap2D）だけ表示する
// （2D/3D切替ボタン自体は#toolbarMapViewToggleとして2D/3D共通の1つに統合済みのため含まない）
const MAP_2D_TOOLBAR_IDS = [
    "toolbarMap2DCompass", "toolbarMap2DGrid"
];

function applyTabVisibility() {
    const isBoth    = activeTab === "both";
    const showScore = activeTab === "score" || isBoth;
    // マップ単体タブ・「並べて」タブのどちらでも、mapViewModeに応じて2D/3Dが排他的に見える
    const showMap2D = isMap2DActive();
    const showMap3D = isAssemblyActive();
    const showMap   = showMap2D || showMap3D;

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
        mapAreaWrapper.style.display = showMap2D ? "" : "none";
        mapAreaWrapper.style.marginTop = "0";
    }

    // マップ専用ツールバー
    const mapToolbar = document.getElementById("mapToolbar");
    if (mapToolbar) mapToolbar.style.display = showMap ? "flex" : "none";

    // 組み立てプレビュー（Three.js）エリア
    const assemblyAreaWrapper = document.getElementById("assemblyAreaWrapper");
    if (assemblyAreaWrapper) assemblyAreaWrapper.style.display = showMap3D ? "" : "none";

    // マップ（2D/3D共通）の2D/3D切替。画面上部のメニューバーに1つだけ設置している
    // （#toolbarMapViewToggle）。マップタブ表示中（2D/3Dどちらでも）は常に表示する
    const toolbarMapViewToggle = document.getElementById("toolbarMapViewToggle");
    if (toolbarMapViewToggle) toolbarMapViewToggle.style.display = showMap ? "" : "none";

    document.querySelectorAll(".map-view-mode-btn").forEach(btn => {
        const active = btn.dataset.mapViewMode === mapViewMode;
        btn.style.color = active ? "#3451d1" : "#767676";
        btn.style.background = active ? "#eaefff" : "";
    });

    // コンパス・「表示する層」ボタンは、マップ専用ツールバーではなく音符マットエリア上に
    // 浮かせて表示する独立したオーバーレイなので、別途表示切替する（2Dマップ専用）
    const mapCornerOverlay = document.getElementById("mapCornerOverlay");
    if (mapCornerOverlay) mapCornerOverlay.style.display = showMap2D ? "flex" : "none";

    // 五線譜タブのみで使うツールバー。表示する場合はinline style自体を外し、
    // CSS側のdisplay指定（.toolbarのflex）をそのまま活かす
    SCORE_ONLY_TOOLBAR_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showScore ? "" : "none";
    });

    // 組み立てプレビュー（3D）専用のツールバー（画面上部のメニューバーに設置）。
    // 3Dプレビュー表示中（showMap3D）だけ表示する
    ASSEMBLY_3D_TOOLBAR_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showMap3D ? "" : "none";
    });

    // 2Dマップ専用のツールバー（画面上部のメニューバーに設置）。
    // 2Dマップ表示中（showMap2D）だけ表示する
    MAP_2D_TOOLBAR_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = showMap2D ? "" : "none";
    });

    // ヘルプ（#helpBtn/#infoWrap）は「表示をなくす（蓋閉じ）、機能の実装は残す」との
    // 依頼により、実装（ホバー/ピン留め/ドラッグ移動等）はそのまま残しつつ、常に非表示にしている。
    // 再度表示したくなった場合は、下の行を`showScore ? "block" : "none"`に戻せばよい
    const infoWrap = document.getElementById("infoWrap");
    if (infoWrap) infoWrap.style.display = "none";

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
    // previousTabの時点でassembly(3D)が見えていたかどうかは、activeTabを書き換える前に
    // 判定しておく必要がある（isAssemblyActive()は現在のactiveTabを見るため）
    const wasAssemblyActive = isAssemblyActive();
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
    if (isMap2DActive()) {
        renderMap();
    }
    if (isAssemblyActive()) {
        renderAssemblyPreview();
    }
    // 組み立てプレビュー（マップタブ・「並べて」タブのどちらかで3Dモード）から完全に離れる時は、
    // 見えていない間ムダにフレームを描き続けないようレンダーループを止める（戻ってきた時は
    // renderAssemblyPreview()が再開する）。マップ⇔並べての間を3Dモードのまま行き来した場合は
    // 引き続き見えているので止めない（マップタブ内のモード切替自体はsetMapViewMode()側で
    // 同様の処理をしている）
    if (wasAssemblyActive && !isAssemblyActive()) {
        stopAssemblyRenderLoop();
    }
    playTabSwitchAnimation();
}

// タブ切替時、新しく表示された中身をふわっとフェードイン（+わずかに下からスライド）させる。
// #mainではなく#bothTabContainer（実際のタブの中身）に対して行う——全画面表示対応で
// #playbackBarが#mainの子になったため、#main自体をフェードさせると再生バーまで
// タブ切替のたびに一緒にフェードしてしまう（再生バーはタブ切替と無関係に常時表示のため）
function playTabSwitchAnimation() {
    const container = document.getElementById("bothTabContainer");
    if (!container) return;
    container.classList.remove("tab-content-fade");
    void container.offsetWidth; // reflowを強制してアニメーションを最初からやり直させる
    container.classList.add("tab-content-fade");
}

// 全画面表示中、無操作が一定時間続いたら周辺UI（左上のヒント・右上のコーナー
// オーバーレイ・下部の再生バー）をフェードアウトする。「無操作が一定時間で、全画面の
// 左上、右上、真下のUIは消えるようにしてほしい」との依頼に対応（動画プレイヤーの
// 全画面操作UIと同じ定石。再生バーの見た目＝半透明/ぼかしの是非は別件、index.htmlの
// #main:fullscreen #playbackBar側のコメント参照）。実際の見た目の変化はCSS側
// （#main.fullscreen-idle ...）が担当し、ここでは「無操作が続いているかどうか」だけを
// 判定してクラスを付け外しする
const FULLSCREEN_IDLE_HIDE_MS = 1000;
function setupFullscreenIdleHide(mainEl) {
    let idleTimer = null;
    const scheduleHide = () => {
        clearTimeout(idleTimer);
        if (!document.fullscreenElement) return;
        idleTimer = setTimeout(() => mainEl.classList.add("fullscreen-idle"), FULLSCREEN_IDLE_HIDE_MS);
    };
    const onActivity = () => {
        if (!document.fullscreenElement) return;
        mainEl.classList.remove("fullscreen-idle");
        scheduleHide();
    };
    ["mousemove", "mousedown", "keydown", "wheel", "touchstart"].forEach(evt => {
        document.addEventListener(evt, onActivity, { passive: true });
    });
    document.addEventListener("fullscreenchange", () => {
        clearTimeout(idleTimer);
        mainEl.classList.remove("fullscreen-idle");
        if (document.fullscreenElement) scheduleHide();
    });
}

// 空・陸の色のデフォルト値。「リセットボタンが欲しい」との依頼に対応するため、
// 初期値としてだけでなくリセット時の復元先としても参照できるよう定数化しておく
const MAP_SKY_COLOR_DEFAULT = "#4a90d9";
const MAP_GROUND_COLOR_DEFAULT = "#8fc98a";

// マップ設定
let mapSettings = {
    railDirection: "vertical",   // "vertical" | "horizontal"
    startCorner: "top-left",     // "top-left" | "top-right" | "bottom-left" | "bottom-right"
    sideFirst: "left",           // "left" | "right" （どちら側のセンサーを先にするか）
    wrapValue: 50,               // 「折り返しあり」時は一列の最大レール数、「折り返しなし」時は一列あたりのセンサー数（マス数と同義）
    railWrapEnabled: true,       // true=曲の拍数ぶんのレール+カーブの繰り返しを敷く（buildFixedRailTrack）、false=拍数連動の独立した帯（従来通り）
    hideUnusedSensors: false,    // true=周りに音符マットがないセンサーを配置しない（カウントにも含めない）
    activeLayer: "middle",       // "middle" | "upper" | "lower" （表示する層）
    skyColor: MAP_SKY_COLOR_DEFAULT,     // 3Dプレビューの空の色（2D側には見た目上の反映は無いが、設定は2D/3D共通で持つ）
    groundColor: MAP_GROUND_COLOR_DEFAULT, // 3Dプレビューの陸の色。2Dではマップの背景色として使う
    showCharacter: false,        // true=3Dプレビューでトロッコの上にキャラクター（models/char.glb）を表示する
    showDecorations: true,       // true=3Dプレビューの陸に木・草・花を散りばめる（generateAssemblyDecorations参照）
    railFloating: true,          // true=レールを地面から浮かせる（従来通り）、false=地面につける
    showSensorDirection: false,  // true=3Dプレビューで各センサーの反応方向（forwardVec沿い2マス）へ薄い赤の光線を出す（デバッグ用、2026-10-01追加）
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

// 音符マット配置時の衝突判定（isBlocked）を、渡されたgrid（Set<"x,y,z">）から作る共通ヘルパー。
// buildFixedRailTrack/buildMapGridそれぞれのローカルなgridを閉じ込めるためファクトリ関数にしている
function makeIsBlockedForPanel(grid) {
    return (x, y, z) => grid.has(`${x},${y},${z}`);
}

// センサー位置そのものの衝突回避（buildFixedRailTrackのカーブ付近で確立し、非wrap時の
// カーブ接続でも同じ問題が起きるため共有ヘルパーに切り出した）。4マス周期で決まる
// 本来の位置→左右反転→遠近反転→両方反転の優先順で、既存セル（レール・別ビートの
// センサー/音符マット）と衝突しない最初の候補を返す。4通り全て衝突していればundefined
// （呼び出し側で「このビートの配置を諦める」判断をする——無警告のレール上書きはしない）
function pickSensorPosition(grid, slotX, slotY, awayVec, beatIdx, sideFirst) {
    const cyclePos = beatIdx % 4;
    const baseIsLeftSide = sideFirst === "left"
        ? (cyclePos === 0 || cyclePos === 2)
        : (cyclePos === 1 || cyclePos === 3);
    const baseIsFar = cyclePos === 2 || cyclePos === 3;
    const candidates = [
        { isLeftSide: baseIsLeftSide, isFar: baseIsFar },
        { isLeftSide: !baseIsLeftSide, isFar: baseIsFar },
        { isLeftSide: baseIsLeftSide, isFar: !baseIsFar },
        { isLeftSide: !baseIsLeftSide, isFar: !baseIsFar },
    ];
    for (const cand of candidates) {
        const lp = (cand.isLeftSide ? -1 : 1) * (cand.isFar ? 2 : 1);
        const cx = slotX + awayVec.dx * lp;
        const cy = slotY + awayVec.dy * lp;
        if (!grid.has(`${cx},${cy},0`)) return { x: cx, y: cy };
    }
    return undefined;
}

// 中間層3枠+上位層4枠+下位層4枠（計11枠、センサー中心を(0,0)としたローカル座標、
// 斜め隣接は使用しない）への音符マット割り当てを、進行方向ベクトル(forwardVec)・
// レールと反対方向ベクトル(awayVec)を使って実グリッドオフセットに変換する共通処理。
// forwardVec/awayVecはどちらも{dx,dy}が-1/0/1のいずれかの単位ベクトル。
// 直線モードでは常に固定ベクトル、スネークモードでは経路上の位置ごとに変化するベクトルを渡す。
// sX/sYはセンサーの絶対座標、isBlocked(x,y)は「そのマスに音符マットを置けない
// （レールの折り返しコネクタが通る・既に別のセンサーの音符マットが置かれている等）」
// かどうかを判定する任意のコールバック。
//
// 【配置ルール】センサー1個に対する11枠のランク（優先順位）自体は絶対・固定であり、
// 状況に応じて変えない（実機のセンサー・音符マットの物理的な位置関係が固定であるため）。
// ただし、2つのセンサーの反応範囲が重なる等の理由であるマスが既に埋まっている場合、
// そのマスだけは諦めて「死にマス」として扱い、同じセンサーの11枠のうちまだ空いている
// 別の枠があればそちらへ配置する——1箇所埋まっていたら即座にその音を諦めるのではなく、
// 11枠を優先順位順に総当たりしてから、本当にどこも空いていない場合にだけ諦める
// （ユーザー指摘、2026-09-29:「死にマスは、2つ以上のセンサーで反応してしまうのでおけない。
// それ以外のマスで置ける猶予があるならば、そこに配置してください」）
function calcPanelPositionsCore(pitches, forwardVec, awayVec, sX, sY, isBlocked) {
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

    const toOffset = (slot) => ({
        dx: slot.trav * forwardVec.dx - slot.lat * awayVec.dx,
        dy: slot.trav * forwardVec.dy - slot.lat * awayVec.dy,
    });

    const claimedIdx = new Set(); // このセンサー（和音）が既に使ったfullRankの枠番号
    const positions = [];
    pitches.forEach((pitch, i) => {
        if (i >= fullRank.length) return; // 11枠を超える音は物理的に置き場が無いためドロップ（従来通り）

        const primarySlot = fullRank[i];
        // 探索順: (1)本来の優先枠 (2)trav反転（遠い⇄近い、同じ和音の他の音との重複だけは
        // 避ける） (3)それ以外の全枠をfullRankの優先順位のまま総当たり。die cellで塞がって
        // いても即ドロップせず、この和音自身がまだ使っていない枠が他に無いか全て試す
        const order = [i];
        if (primarySlot.trav !== 0) {
            const flipIdx = fullRank.findIndex(s => s.lat === primarySlot.lat && s.trav === -primarySlot.trav && s.z === primarySlot.z);
            if (flipIdx >= 0) order.push(flipIdx);
        }
        fullRank.forEach((_, idx) => { if (!order.includes(idx)) order.push(idx); });

        for (const idx of order) {
            if (claimedIdx.has(idx)) continue; // 同じ和音の別の音が既に使った枠
            const slot = fullRank[idx];
            const { dx, dy } = toOffset(slot);
            if (isBlocked && isBlocked(sX + dx, sY + dy, slot.z)) continue; // 死にマス（他センサーの領域と重複等）
            positions.push({ relX: dx, relY: dy, z: slot.z, pitch });
            claimedIdx.add(idx);
            return;
        }
        console.warn(`音符マットの配置候補(全${fullRank.length}枠)が全て衝突したため、1音(${pitch})の配置をスキップしました（センサー間隔が詰まっている等の既知の限界）。`);
    });
    return positions;
}

function updateMapToolbarUI() {
    const { railDirection, startCorner, sideFirst, wrapValue, railWrapEnabled, hideUnusedSensors, activeLayer, showCharacter, showDecorations, railFloating, showSensorDirection } = mapSettings;

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
    setActive("mapRailWrapOn",  railWrapEnabled);
    setActive("mapRailWrapOff", !railWrapEnabled);
    setActive("mapCharacterOn",  showCharacter);
    setActive("mapCharacterOff", !showCharacter);
    setActive("mapDecorationsOn",  showDecorations);
    setActive("mapDecorationsOff", !showDecorations);
    setActive("mapRailFloatingOn",  railFloating);
    setActive("mapRailFloatingOff", !railFloating);
    setActive("mapSensorDirectionOn",  showSensorDirection);
    setActive("mapSensorDirectionOff", !showSensorDirection);

    const wrapInput = document.getElementById("mapWrapValue");
    if (wrapInput) wrapInput.value = wrapValue;
}

// マップのグリッドデータ（レール・センサー・音符マットの配置）を計算する
// DOM描画には依存しないので、描画不要なカウント表示（レール数・センサー数）からも呼べる

// 「折り返しあり」時のレール敷設。「一列の最大レール数」(wrapValue)ぶん直線にレールを
// 置いたらカーブを描き、これを曲の総拍数ぶん敷き終わるまで繰り返す、曲の長さに
// ぴったり合わせた物理的な線路（カーブは行と行の間の接続専用で、拍を消費しない）。
// 以前はここが「曲の拍数とは無関係な固定300マス」だったため、長い曲では途中から
// 音符マットが付かなくなり、さらにトロッコの表示位置が拍番号をそのまま物理セル番号
// として使っていたことと相まって、段数の多い曲では後半のほとんどの段にトロッコが
// 実質到達できない（センサーは付いているのに表示だけ先頭付近で足踏みする）不具合が
// あった。曲の拍数に合わせて線路自体を伸ばすことで両方を解消する
// （「行と行の間もカーブで実際に繋げてワープを無くしたい」との依頼、2026-09-29。
// 対象は「折り返しあり」であって「折り返しなし」ではない、と後から明確化された）。
// 段の間隔・ジグザグ配置の考え方（isMirroredBand相当・wrapOffset・カーブの90度回転描画）は
// 従来の「折り返しあり」実装と同じものを踏襲している
function buildFixedRailTrack({ railDirection, isVertical, travelSign, wrapSign, wrapValue, turnLength }) {
    const effectiveTurnLength = turnLength - 1; // 段の間隔から区切り用の1マスを詰める（従来通り）
    const maxRailsPerRow = Math.max(1, wrapValue);

    const grid = new Map();
    const setCell = (x, y, z, data) => grid.set(`${x},${y},${z}`, data);

    // 経路上の全セル座標を、実際に辿る順番に並べたもの（直線+カーブ、隙間なく1マスずつ）。
    // トロッコの定速アニメーションは、この配列を先頭からの通し番号として辿るだけでよい
    // （どのセルも隣と必ず1マス差のため、resolveTrolleyDisplayPosition側の「大ジャンプ」判定が
    // 発生せず、コネクタ経路(connectorPaths)を別途持つ必要が無い）
    const railCenters = [];

    let extentMinX = Infinity, extentMaxX = -Infinity, extentMinY = Infinity, extentMaxY = -Infinity;
    const markExtent = (x, y) => {
        extentMinX = Math.min(extentMinX, x);
        extentMaxX = Math.max(extentMaxX, x);
        extentMinY = Math.min(extentMinY, y);
        extentMaxY = Math.max(extentMaxY, y);
    };

    // keepExisting=trueの場合、既にそのマスにレールが置かれていれば上書きしない
    // （直線の段の先頭セルが、直前のカーブが既に置いた曲がり角のセルと同じ座標になる場合、
    // カーブ側の向き＝直角に折れた「真横」の向きを優先して残すため。上書きを許すと、
    // 曲がり角のうち片方の端だけ直線側の向きに戻ってしまい、U字の向きが左右非対称に見える）
    const placeRailCell = (x, y, direction, keepExisting = false, corner = null) => {
        const key = `${x},${y},0`;
        if (keepExisting && grid.has(key)) {
            markExtent(x, y);
            return;
        }
        // corner（{inDir,outDir}）が指定されたセルは、直線ではなく1マスぶんの円弧として
        // 描画する（「カーブの角を1マスだけ弧にしてカーブっぽく」との依頼）。inDir/outDirは
        // それぞれ「このマスに入ってくる方向」「このマスから出ていく方向」の単位ベクトル
        // （2D/3D双方のレンダラーがこれを見て円弧の中心・開始角/終了角を計算する）
        const railData = corner ? { type: "rail", direction, corner } : { type: "rail", direction };
        setCell(x, y, 0, railData);
        setCell(x, y, 1, railData);
        setCell(x, y, -1, railData);
        markExtent(x, y);
    };

    // 折り返し軸(wrap軸)・進行軸(travel軸)それぞれの符号から、グリッド単位の単位ベクトル
    // {dx,dy}を作るヘルパー（角の円弧の始点/終点方向を決めるのに使う）
    const travelVec = (sign) => isVertical ? { dx: 0, dy: sign } : { dx: sign, dy: 0 };
    const wrapVec = (sign) => isVertical ? { dx: sign, dy: 0 } : { dx: 0, dy: sign };

    // 行・カーブの構造（何行あるか、各行の長さ、ミラーリングの偶奇）は、曲の「実際の拍数」
    // だけで決まる（以前のFIXED_RAIL_TOTAL_COUNT=300のような固定値ではない）。
    const beats = getAllBeats();
    const totalBeats = beats.length;

    // 「カーブは行の中からturnLength-1マス（中間セルの数）だけ間借りするだけで、レール
    // 総数（物理セル数）は曲の実際の拍数と常に完全に一致する」という設計（「カーブも直線も
    // レールはレールで、数は変わらないはず」との指摘、2026-09-30）。カーブが後ろに続く行は
    // 直線部分の拍数をcurveNewCellsぶん減らし、浮いた拍数をカーブの中間セル自身が引き継いで
    // 鳴らす。最後の行（後ろにカーブが無い）だけは残り全部をそのまま使う。
    // 各行が直線部分で消費する拍数のリストを先に1回だけ計算しておく（セルはまだ書き込まない）
    const curveNewCells = Math.max(0, effectiveTurnLength); // turnLength-1 = 6
    const rowStraightLengths = [];
    {
        let rem = totalBeats;
        while (rem > 0) {
            if (rem <= maxRailsPerRow) {
                rowStraightLengths.push(rem);
                rem = 0;
            } else {
                const cap = Math.max(1, maxRailsPerRow - curveNewCells);
                rowStraightLengths.push(cap);
                rem -= cap;
                rem -= curveNewCells; // カーブが直接引き取る拍数
            }
        }
    }
    const totalBandCount = rowStraightLengths.length;

    let remaining = totalBeats;
    let colIdx = 0;
    while (remaining > 0) {
        const rowsInThisBand = rowStraightLengths[colIdx];
        // 奇数番目の段は視覚上の進行方向を逆にする（ジグザグ/ボウストロフェドン配置）。
        // これにより段の終端と次の段の始端が進行軸上の同じ座標で揃い、間をカーブで
        // 直角に繋げられるようになる（従来の「折り返しあり」実装と同じ考え方）。
        // 偶奇は先頭からのcolIdxではなく「末尾から数えた位置」で決める——最後の段だけは
        // 端数で他より短くなり得るが、この基準なら最後から2番目の段との接続は必ず
        // 「両方とも行0で繋がる」パターンになり、段の長さが違っても座標がずれない
        // （先頭基準だと、最後の段が短い場合に接続点の行番号が一致しなくなることがあった）
        const mirrored = (totalBandCount - 1 - colIdx) % 2 === 1;
        const wrapOffset = wrapSign * colIdx * (effectiveTurnLength + 1);
        // この段の後ろにカーブが続くかどうか（最後の段だけは続かない）。段の最後のセル
        // （カーブの入口の角と同一座標）が、直後のカーブ中間セルではなく自分自身の段の
        // 向き（forwardVec）を使うべきかどうかの判定に使う（下記isRowEndBeforeCurve参照）
        const hasFollowingCurve = colIdx < totalBandCount - 1;

        for (let i = 0; i < rowsInThisBand; i++) {
            const effRowIdx = mirrored ? (rowsInThisBand - 1 - i) : i;
            const travelPos = travelSign * effRowIdx;
            const rx = isVertical ? wrapOffset : travelPos;
            const ry = isVertical ? travelPos : wrapOffset;
            placeRailCell(rx, ry, railDirection, true);
            // 段の最初のセル(i===0)は、直前にカーブがある場合（colIdx>0）、そのカーブの
            // 出口（wB地点）としてカーブ生成ループ側で既にrailCentersへpush済みの座標と
            // 完全に一致する。ここでも重複してpushすると、経路上に同じ座標が2つ連続で
            // 並ぶことになり、トロッコの定速アニメーションがその1ステップぶん（1/cellsPerSec秒）
            // 進んでも見た目の位置が変わらない＝一瞬静止して見えるバグになる
            // （「U字の2回目のカーブで一瞬止まる」として報告された）
            if (!(i === 0 && colIdx > 0)) {
                // 段の最後のセル(i===rowsInThisBand-1)かつ後ろにカーブが続く場合、この
                // セルはカーブの入口の角と同一座標（=物理的には直線の続きだが、次に
                // 押し込まれるのはカーブの中間セル）になる。センサーの向き算出（下記
                // sensorSlots）で「次のセルとの差分」をそのまま使うと、この最後の1マスだけ
                // 折れ曲がった後のカーブの向きを向いてしまい、同じ直線上に並ぶ他のセンサー
                // と向きが食い違って見える（「センサーの向きが180度逆で配置されている
                // ところが散見される」との指摘、2026-10-01）。isRowEndBeforeCurveフラグを
                // 立てておき、このセルだけ「前のセルとの差分」を使うよう下流で分岐する
                railCenters.push({ x: rx, y: ry, isBeat: true, isRowEndBeforeCurve: i === rowsInThisBand - 1 && hasFollowingCurve });
            }
        }
        remaining -= rowsInThisBand;
        if (remaining <= 0) break;

        // カーブ（次の段への接続）。このバンドの終端（最後に置いた行の座標）から、
        // 折り返し軸方向に直角へ折れ、次の段の始端まで1本のレールで繋ぐ
        const boundaryEffRowIdx = mirrored ? 0 : rowsInThisBand - 1;
        const T = travelSign * boundaryEffRowIdx;
        const wA = wrapOffset;
        const wB = wrapSign * (colIdx + 1) * (effectiveTurnLength + 1);
        // コネクタは折り返し軸方向（メインのレールとは直角）に走るため、見た目のレール向き
        // （drawMapRailLineのdirection、ties/レール本体の向きを決める）もメインの
        // railDirectionとは直角にする。同じ向きのままだとレールが実際には直角に曲がらず、
        // ただ横に並んでいるだけに見えてしまう
        const connectorDirection = isVertical ? "horizontal" : "vertical";

        // カーブの両端（直線からカーブへ曲がる角、カーブから次の直線へ戻る角）だけ、
        // 「進行方向が変わる1マス」として円弧描画用のinDir/outDirを持たせる
        // （「トロッコが進む方向に合わせて」なので、実際にその角を通過する際の
        // 進行方向をそのまま使う）
        const nextMirrored = (totalBandCount - 1 - (colIdx + 1)) % 2 === 1;
        const entryCorner = {
            inDir: travelVec(mirrored ? -travelSign : travelSign),
            outDir: wrapVec(wrapSign),
        };
        const exitCorner = {
            inDir: wrapVec(wrapSign),
            outDir: travelVec(nextMirrored ? -travelSign : travelSign),
        };

        for (let w = wA; wrapSign > 0 ? w <= wB : w >= wB; w += wrapSign) {
            const rx = isVertical ? w : T;
            const ry = isVertical ? T : w;
            const corner = w === wA ? entryCorner : w === wB ? exitCorner : null;
            placeRailCell(rx, ry, connectorDirection, false, corner);
            // wA地点は直線側で既にpush済み。ここでpushする残り全部（wB=出口の角を含む）は
            // isBeat:trueにする——「カーブも直線と同様に扱う」との依頼により、カーブの
            // 中間セルにも実際の（本物の、行から間借りした）拍が対応するため。
            // wB地点（出口の角）は次の段のi=0（最初の拍）の座標と幾何学的に完全に一致する
            // 地点で、次の段側では「直前のカーブのwB地点と重複するため」という理由で
            // i=0のpushを意図的にスキップしている（下のrowsInThisBandループのコメント参照）。
            // そのため、この段の最初の拍を代表する実体はここでのpushだけである
            if (w !== wA) railCenters.push({ x: rx, y: ry, isBeat: true });
        }
        // カーブの中間セル(curveNewCells個)は、行の直線部分から間借りした実際の拍を
        // 引き継いで鳴らすため、remainingからもその分を消費する（rowStraightLengths側の
        // 計算と一致させる）
        remaining -= curveNewCells;
        colIdx += 1;
    }

    // ここまでで線路（直線+カーブ）のセルは確定した。ここから、実際の曲のビートに合わせて
    // センサー・音符マットをこの固定線路に配置する（「センサーを配置してください、一回
    // やってみてください」との依頼、最初の実装）。「カーブも直線と同様に扱う」との依頼
    // （2026-09-30）により、現在はrailCenters上のisBeat:trueなセルであれば、直線の行の
    // セルもカーブの中間セルも区別なくセンサー配置の対象にする（判定にはrailCenters側で
    // 予め付けたisBeatフラグを使う——cell.cornerでの判定は誤り。段の最後/最初の拍のセルは
    // カーブのentryCorner/exitCorner描画により見た目上cell.cornerが真になるが、実際には
    // 拍を表すisBeat:trueのrailCentersエントリなので除外してはいけない）。
    // 経路(railCenters)上の隣接2点は必ず1マス差なので、その差分をそのまま「このセルでの
    // 進行方向(forwardVec)」として使える——段のミラーリングやカーブでどちらに曲がるかを
    // 個別に判定しなくても、経路そのものから自然に求まる
    const sensorSlots = [];
    for (let i = 0; i < railCenters.length; i++) {
        const { x, y, isBeat, isRowEndBeforeCurve } = railCenters[i];
        if (!isBeat) continue;
        const next = railCenters[i + 1];
        const prev = railCenters[i - 1];
        // 段の最後のセル（直後にカーブの中間セルが続く座標）だけは例外的に「前のセルとの
        // 差分」を使う。「次のセルとの差分」のままだと、直線の続きであるこのセル自身の
        // 向きが、直後に折れ曲がるカーブの向きに引っ張られてしまい、同じ直線上に並ぶ
        // 他のセンサーと向きが食い違って見える（isRowEndBeforeCurveのコメント参照）
        const forwardVec = (next && !isRowEndBeforeCurve)
            ? { dx: next.x - x, dy: next.y - y }
            : { dx: x - prev.x, dy: y - prev.y }; // 経路の最後尾・段の最後のセルは直前までの進行方向を引き継ぐ
        // 進行方向を90度回転させた向きを「外側」とする（常に同じ側に一貫してオフセット
        // されるよう、回転の向きは固定。どちら回りでも物理的な意味は変わらない）
        const awayVec = { dx: -forwardVec.dy, dy: forwardVec.dx };
        // railIndex（railCenters内での本来の通し番号、カーブぶんの欠番を含む）も保持しておく。
        // 音符マットのbeatIndexに使うのはsensorSlotsの添字（下のbeatIdx、カーブを除いた
        // 拍だけの通し番号）ではなくこちらでなければならない——トロッコの再生位置
        // （trackPlayback）はrailCenters（カーブ込みの物理的な経路）上の通し番号を
        // そのまま使っているため、拍だけの番号とは食い違ってしまう（詳細はbeatIndex:
        // slot.railIndexの代入箇所のコメント参照）
        sensorSlots.push({ x, y, forwardVec, awayVec, railIndex: i });
    }

    // beats/totalBeatsは線路自体を敷くのに使ったものと同じ配列（上で計算済み）。
    // 線路の総数（行の拍数の合計）は必ずtotalBeatsと一致するはずだが、念のため
    // 不一致があれば警告に留めて収まる分だけ配置する（レールを壊さない方を優先）
    const totalBeatsToPlace = Math.min(beats.length, sensorSlots.length);
    if (beats.length > sensorSlots.length) {
        console.warn(`固定レール上のセンサー設置可能数(${sensorSlots.length})が曲の拍数(${beats.length})に足りません。超過分の拍にはセンサーが付きません。`);
    }

    // 拍番号(beatIdx)→railIndex（railCenters内の物理的な通し番号）の対応表。
    // トロッコの再生位置（updateWrapTrolleyPositionAtTime）が、実際に鳴っている拍の
    // 物理位置を正確に求めるために使う。センサー自体の配置（pickSensorPosition）が
    // 衝突で諦められた場合でも、レール自体（railIndex）は必ず存在するのでそのまま使える
    const beatIndexToRailIndex = sensorSlots.slice(0, totalBeatsToPlace).map(s => s.railIndex);

    for (let beatIdx = 0; beatIdx < totalBeatsToPlace; beatIdx++) {
        const beat = beats[beatIdx];
        const slot = sensorSlots[beatIdx];

        const picked = pickSensorPosition(grid, slot.x, slot.y, slot.awayVec, beatIdx, mapSettings.sideFirst);
        if (!picked) {
            // 4通り全て衝突していた場合、以前はやむを得ず本来の位置（=既に埋まっている
            // ことが確認済みのセル）をそのまま使っていたが、これはレール（カーブの通り道
            // 等）を無警告で上書きしてしまい、線路が欠けて見える不具合になっていた。
            // 「曲の拍数がセンサー設置可能数を超える」場合と同じ考え方で、このビートの
            // センサー・音符マットの配置は諦めてスキップする（レールを壊さない方を優先する）
            console.warn(`拍${beatIdx + 1}: センサーの配置候補（本来位置/左右反転/遠近反転/両方反転）が全て衝突したため、このビートのセンサー・音符マットをスキップしました。`);
            continue;
        }
        const { x: sX, y: sY } = picked;

        const hasPanel = beat.isFirst && beat.note && !beat.note.rest && beat.note.pitches;

        // slot.awayVecは「隣接/遠め・左右」4マス周期の基準となる固定の回転軸であり、
        // beatIdxが偶数/奇数かで実際にはその正負どちらの側にもセンサーが置かれる
        // （pickSensorPositionのisLeftSide参照）。そのためレール中心(slot.x,slot.y)から
        // 実際に置かれたセンサー位置(sX,sY)への差分を正規化した方を、以降（センサーの
        // 表示向き・音符マットの配置オフセット）すべてで使う——slot.awayVecのまま使うと、
        // 約半数のセンサーで実際の位置と逆向きになり、「レーザーがそっぽを向く」
        // （2026-10-01）だけでなく、音符マットがレールと反対側ではなく**レール側へ**
        // 配置されてしまう実害のあるバグになっていた（「レール、真ん中の音符マット、
        // センサーの順に配置されている」とのユーザー指摘で発覚。実際に1660枚中104枚で
        // 音符マットがセンサーよりレールに近い位置に配置されていたことを数値で確認した）
        const awayDx = sX - slot.x, awayDy = sY - slot.y;
        const awayMag = Math.hypot(awayDx, awayDy) || 1;
        const actualAwayVec = { dx: awayDx / awayMag, dy: awayDy / awayMag };

        markExtent(sX, sY);
        if (!mapSettings.hideUnusedSensors || hasPanel) {
            setCell(sX, sY, 0, {
                type: "sensor",
                beatNum: beatIdx + 1,
                direction: slot.forwardVec.dy !== 0 ? "vertical" : "horizontal",
                measureIndex: beat.measureIndex,
                awayVec: actualAwayVec,
            });
        }

        if (hasPanel) {
            const sorted = [...beat.note.pitches].sort((a, b) => pitchToSemitone(b) - pitchToSemitone(a));
            // 既に置かれている（レール・別ビートのセンサー/音符マット）セルには重ねない
            const panelPositions = calcPanelPositionsCore(sorted, slot.forwardVec, actualAwayVec, sX, sY, makeIsBlockedForPanel(grid));
            panelPositions.forEach(({ relX, relY, z, pitch }) => {
                const px = sX + relX;
                const py = sY + relY;
                setCell(px, py, z, {
                    type: "panel",
                    pitch,
                    direction: northDirection,
                    measureIndex: beat.measureIndex,
                    // 「音符マットが踏まれたら凹む」演出（setAssemblyPanelPressed等）は、
                    // トロッコの再生位置＝railCenters（カーブのセルも含む物理的な経路）上の
                    // 通し番号でこのbeatIndexを検索する。sensorSlotsの添字beatIdxは拡張
                    // ビート列（カーブのentry/exit角を除く一部のセルがrailCenters上で
                    // 欠番になる関係で、通し番号とはズレることがある）上の位置なので、
                    // 実際にトロッコが辿る通し番号と一致するslot.railIndexを使う
                    beatIndex: slot.railIndex,
                });
                markExtent(px, py);
            });
        }
    }

    const extent = extentMinX === Infinity
        ? null
        : { minX: extentMinX, maxX: extentMaxX, minY: extentMinY, maxY: extentMaxY };

    return {
        grid,
        totalBeats: railCenters.length,
        extent,
        separatorCoords: new Set(),
        isVertical,
        deadZoneCoords: new Set(),
        beatCenters: railCenters,
        beatIndexToRailIndex,
    };
}

function buildMapGrid() {
    const { railDirection, startCorner, sideFirst, wrapValue, railWrapEnabled } = mapSettings;
    const turnLength = getTurnLength();

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

    // 「折り返しあり」の場合、レール敷設は曲の拍数と完全に切り離した固定長（300個、
    // カーブも1個として数える）の物理的な線路に置き換える（センサー・音符マットは
    // まだこの新しい線路には乗せていない、意図的な未実装状態）。「折り返しなし」は
    // 以下の従来通り拍数連動の独立した帯のまま、一切変更しない
    if (railWrapEnabled) {
        return buildFixedRailTrack({ railDirection, isVertical, travelSign, wrapSign, wrapValue, turnLength });
    }

    const effectiveTurnLength = turnLength;

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

    // グリッドセルを蓄積するMap: key="x,y,z" value={type, pitch, direction, beatNum}
    const grid = new Map();

    const setCell = (x, y, z, data) => {
        grid.set(`${x},${y},${z}`, data);
    };

    // 「折り返しなし」では段同士は独立しており、コネクタ・境界ビートの再配置は存在しない
    // （それらは「折り返しあり」時のbuildFixedRailTrack側の話。ここでは常に非ミラー・
    // 段境界の再配置なしとして扱う）
    const isMirroredBand = () => false;
    // 音符マット配置時の衝突判定（isBlocked）。既に別のビートが同じセル（同じzのみ）を
    // 使っていないかだけ見る（コネクタの概念が無いため接続部分の判定は不要）
    const isBlockedForPanel = makeIsBlockedForPanel(grid);

    // 段と段の間の区切り用空きマスの座標（折り返し軸方向、isVerticalならX・そうでなければY）。
    // レールの1セット（±3=7マス幅）同士の間に、getTurnLength()で決まる間隔のうち
    // 実際に何も配置されない分（turnLength-6マス）だけ区切りとして扱う。
    // レンダリング側（renderMap）でこの座標に該当するマスをグリッド線無しの背景色にする。
    // 「折り返しあり」の場合はこの間隔を実際のレール（コネクタ）で繋ぐため、区切り自体が
    // 存在しなくなる（drawMapCellはisSeparatorのマスにはrail描画をしないため、区切りに
    // すると繋がったはずのコネクタが見えなくなってしまう）
    const separatorCoords = new Set();
    const gapSize = turnLength - 6;
    if (!railWrapEnabled && gapSize > 0 && wrapSensors > 0) {
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
            const bandWrapOffset = wrapSign * colIdx * (effectiveTurnLength + 1);
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
            // 従来ならレールがはみ出していた位置）から始めてよい。
            // 「折り返しあり」で奇数段の場合、実際に描画される座標はミラーリングされた
            // effRowIdxを使うため、dead zoneの座標もそれに合わせて計算する必要がある
            // （raw rowIdxのまま計算すると、ミラーリングされた段では逆側を塞いでしまう）
            const mirrored = isMirroredBand(colIdx);
            for (let rowIdx = actualBeatsInBand; rowIdx < wrapSensors; rowIdx++) {
                const effRowIdx = mirrored ? (wrapSensors - 1 - rowIdx) : rowIdx;
                const tp = travelSign * effRowIdx;
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

        // 段ごとに独立・同じ側から始まる（「折り返しなし」では常に非ミラー）
        const colIdx = Math.floor(beatIdx / wrapSensors);
        const rowIdx = beatIdx % wrapSensors;
        const mirrored = isMirroredBand(colIdx);
        const effRowIdx = mirrored ? (wrapSensors - 1 - rowIdx) : rowIdx;
        const effTravelSign = mirrored ? -travelSign : travelSign;

        const travelPos = travelSign * effRowIdx; // レール1マスにつきビート1つ
        const lateralPos = (isLeftSide ? -1 : 1) * (isFar ? 2 : 1); // レール中心線からの左右オフセット

        // 段境界の直前/直後のビート（段の最後のビート、次の段の最初のビート）は、曲の長さ・
        const wrapOffset = wrapSign * colIdx * (effectiveTurnLength + 1); // 段ごとの間隔（レール同士の実際の間隔＝見た目の空きマス数+1）

        // レール自体の中心マス（d=0の位置。センサーはここからlateralPosぶんずれた位置）
        beatCenters[beatIdx] = {
            x: isVertical ? wrapOffset : travelPos,
            y: isVertical ? travelPos : wrapOffset,
        };

        const sX = isVertical ? wrapOffset + lateralPos : travelPos;
        const sY = isVertical ? travelPos : wrapOffset + lateralPos;

        const forwardVec = isVertical ? { dx: 0, dy: effTravelSign } : { dx: effTravelSign, dy: 0 };
        const awayVec = isVertical ? { dx: lateralPos > 0 ? 1 : -1, dy: 0 } : { dx: 0, dy: lateralPos > 0 ? 1 : -1 };

        // 段の最初/最後のビートかどうか。最後の段は総拍数の都合でwrapSensors未満で
        // 終わることがあるため、totalBeatsの終端も「最後」として扱う
        const isFirstInRow = effRowIdx === 0;
        const isLastInRow = effRowIdx === wrapSensors - 1 || beatIdx === totalBeats - 1;

        // dの並びは実効進行方向の符号に応じて時間順になるようにする
        const dOrder = effTravelSign === 1 ? [-1, 0, 1] : [1, 0, -1];
        dOrder.forEach((d, posInTriplet) => {
            // 段の最初のビート（effRowIdx=0）は1マス手前、最後のビート（effRowIdx=wrapSensors-1）は
            // 1マス先のレールマスを描画しない（段同士は実際には接続されておらず、このはみ出し
            // マスが隣の段の方向へ向かって描かれると、あたかも段同士がつながっているように
            // 見えてしまうため）
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
                // レール中心から見てこのセンサーが外側へ向かう方向（awayVecと同じ、
                // 音符マットの配置にも使っている値）。マス内でセンサーをレールから
                // 少し遠ざける表示に使う（drawMapCell/rebuildAssemblyMeshes参照）
                awayVec,
            });
        }

        // 音符マットの配置
        if (hasPanel) {
            const sorted = [...beat.note.pitches].sort((a, b) => {
                // 半音値で降順ソート（高音順）
                return pitchToSemitone(b) - pitchToSemitone(a);
            });

            const panelPositions = calcPanelPositionsCore(sorted, forwardVec, awayVec, sX, sY, isBlockedForPanel);

            panelPositions.forEach(({relX, relY, z, pitch}) => {
                const px = sX + relX;
                const py = sY + relY;
                setCell(px, py, z, {
                    type: "panel",
                    pitch,
                    direction: northDirection,
                    measureIndex: beat.measureIndex,
                    // 3Dプレビューで「トロッコ通過時に音符マットを凹ませる」演出のため、
                    // このマットがどのビートで鳴るかを持たせる（updateAssemblyPlayMarker参照）
                    beatIndex: beatIdx,
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
                // 3D側は境界線ドラッグ中にリサイズが一切呼ばれておらず、CSS上の箱（grid）は
                // 追従して伸び縮みする一方、WebGLの実解像度とカメラのaspectは元のままだった
                // ため、その差分がCSSによる引き伸ばし表示として見えていた（「3Dが引き伸ばされた
                // ようになる」との指摘）。五線譜と同様に1フレームに1回のペースで追従させる
                if (isAssemblyActive()) resizeAssemblyRenderer();
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
        if (isAssemblyActive()) resizeAssemblyRenderer();
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

    const { grid, extent, separatorCoords, isVertical, deadZoneCoords, beatCenters, beatIndexToRailIndex } = buildMapGrid();
    wrapBeatIndexToRailIndex = beatIndexToRailIndex || [];

    if (!extent) {
        mapArea.innerHTML = "<p style='color:var(--text-faint);padding:16px;'>音符がありません</p>";
        ["mapResizeHandleRight", "mapResizeHandleBottom", "mapResizeHandleCorner"].forEach((id) => {
            const handle = document.getElementById(id);
            if (handle) handle.style.display = "none";
        });
        mapBeatPositions = [];
        mapPanelPositionsByBeat = new Map();
        mapRenderState = null;
        // 以前はgridDiv（canvas化前は#mapGrid自身）ごと消えていたので暗黙に片付いていたが、
        // 選択ハイライト/再生マーカーは今は#mapAreaWrapperの子として存在するため、
        // ここで明示的に消さないと空スコアに切り替えても残骸が浮いたままになる
        document.querySelectorAll(".mapSelectionOverlay, .mapPlayLine, .mapPanelPressOverlay").forEach(el => el.remove());
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

    // 「トロッコ通過時に音符マットを凹ませる」演出（2D版）用に、現在表示中の層にある
    // 音符マットのセル位置をbeatIndexごとにまとめておく（3D版のassemblyPanelInstancesByBeatと
    // 同じ発想）。和音の場合は1つのbeatIndexに複数マスが対応する
    mapPanelPositionsByBeat = new Map();
    for (const [key, data] of grid) {
        if (data.type !== "panel") continue;
        const parts = key.split(",").map(Number);
        if (parts[2] !== z) continue;
        const px = (parts[0] - minX) * cellSize;
        const py = (parts[1] - minY) * cellSize;
        if (!mapPanelPositionsByBeat.has(data.beatIndex)) mapPanelPositionsByBeat.set(data.beatIndex, []);
        mapPanelPositionsByBeat.get(data.beatIndex).push({ px, py });
    }

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

    if (mapGridVisible) {
        ctx.strokeStyle = "#e0e0e0";
        ctx.lineWidth = 1;
        ctx.stroke(borderPath);
    }

    ctx.restore();
}

// センサーの、正方形のマスに対する長方形の比率（レールに直角な方向をSENSOR_CROSS_RATIO、
// レールに沿う方向をSENSOR_ALONG_RATIOにすることで「レールに直角に伸びる方が長い」形にする）
const SENSOR_CROSS_RATIO = 0.65;
const SENSOR_ALONG_RATIO = 0.35;
const SENSOR_AWAY_OFFSET_RATIO = 0.08; // レール（マス中心線）から外側へずらす量（セルサイズに対する比率）

// 1マス分の描画。区切りマスの罫線スキップロジックは元のDOM版（renderMap()旧実装）と
// 一字一句同じ条件式を保っている。罫線はctx.stroke()を都度呼ばず、呼び出し元が持つ
// 1本のPath2Dに線分を足しこむだけにする（drawMapCanvas()参照）
function drawMapCell(ctx, borderPath, { px, py, cellSize, gx, gy, isSeparator, isVertical, data }) {
    // --- 背景 ---
    // レールは3Dプレビューと合わせた「細い黒レール2本＋幅広いグレーの横木（穴あき）」の
    // 見た目にするため、単色の塗りつぶし背景は持たない（drawMapRailLine側で直接描く）
    if (!isSeparator && data && data.type === "sensor") {
        // センサーは正方形ではなく、レール（トロッコの通り道）に直角な方向へ長い長方形に
        // する（＝長辺がレールの方を向く）。マップ全体のレール向き設定（isVertical）で
        // 一律に決めるのではなく、buildMapGrid側でセンサーごとに計算済みのdata.direction
        // （forwardVec/awayVec由来、そのセンサーの実際のレール向きを反映した値）を使う——
        // 「センサーはレールのトロッコの方に向けないとダメ」との指摘、2026-09-29。
        // data.directionが無い（古いデータ等）場合のみ、従来通りマップ全体のisVerticalに
        // フォールバックする
        const sensorIsVertical = data.direction ? data.direction === "vertical" : isVertical;
        const sensorCross = cellSize * SENSOR_CROSS_RATIO, sensorAlong = cellSize * SENSOR_ALONG_RATIO;
        const sensorW = sensorIsVertical ? sensorCross : sensorAlong;
        const sensorH = sensorIsVertical ? sensorAlong : sensorCross;
        // 「センサーを枠の中で、レールから少し遠ざける」との依頼に対応。data.awayVecは
        // レール中心から見てこのセンサーが外側へ向かう方向（buildMapGrid参照、音符マットの
        // 配置にも使っている値と同じ）なので、その方向へマス内で少しずらす
        const awayVec = data.awayVec || { dx: 0, dy: 0 };
        const awayOffsetX = awayVec.dx * cellSize * SENSOR_AWAY_OFFSET_RATIO;
        const awayOffsetY = awayVec.dy * cellSize * SENSOR_AWAY_OFFSET_RATIO;
        drawMapGradientRect(
            ctx, px + (cellSize - sensorW) / 2 + awayOffsetX, py + (cellSize - sensorH) / 2 + awayOffsetY,
            sensorW, sensorH, "sensor"
        );
    } else if (!isSeparator && data && data.type === "panel" && PITCH_TO_FILE[toCanonicalPitch(data.pitch)]) {
        drawMapGradientRect(ctx, px, py, cellSize, cellSize, "panel");
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
            if (data.corner) {
                drawMapRailCorner(ctx, px, py, cellSize, data.corner.inDir, data.corner.outDir);
            } else {
                drawMapRailLine(ctx, px, py, cellSize, data.direction);
            }
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

// sensor/panelの背景グラデーション（CSSの.mapCell--sensor/--panelと同じ配色）＋
// inset box-shadowの近似（canvasにはinset shadowの直接的な相当機能が無いため、端に薄い
// 明暗の帯を描いて立体感を模す。ぼかしの無い分だけCSS版とは厳密には一致しない）。
// レール（"rail"）はここでは扱わない（drawMapRailLine側で直接描く、上のdrawMapCell参照）。
// センサーは正方形とは限らない長方形（w,hが異なりうる）ため、pxRect全体をw/hで受け取る
function drawMapGradientRect(ctx, px, py, w, h, kind) {
    let grad;
    if (kind === "sensor") {
        grad = ctx.createLinearGradient(px, py, px + w, py + h);
        grad.addColorStop(0, "#333");
        grad.addColorStop(1, "#000");
    } else {
        const r = Math.max(w, h) / 2 * Math.SQRT2;
        grad = ctx.createRadialGradient(px + w / 2, py + h / 2, 0, px + w / 2, py + h / 2, r);
        grad.addColorStop(0, "#fbfbfb");
        grad.addColorStop(1, "#e8e8e8");
    }
    ctx.fillStyle = grad;
    ctx.fillRect(px, py, w, h);

    if (kind === "sensor") {
        ctx.fillStyle = "rgba(255,255,255,0.15)";
        ctx.fillRect(px, py, w, 1);
        ctx.fillStyle = "rgba(0,0,0,0.2)";
        ctx.fillRect(px, py + h - 2, w, 2);
    } else {
        ctx.fillStyle = "rgba(0,0,0,0.12)";
        ctx.fillRect(px, py, w, 2);
    }
}

// レールが1マスの中で直角に曲がる「角」セル（buildFixedRailTrackのcorner参照）を、
// 折れ線ではなく1マスぶんの円弧として描くための共通の幾何計算（2D canvas・3Dどちらの
// レンダラーからも使う）。inDir/outDirは「このマスに入ってくる方向」「出ていく方向」の
// 単位ベクトル{dx,dy}（マス単位、dxとdyは常にどちらか一方が0の軸並行ベクトル）。
// 半径はマス1つぶん(0.5)——これにより、隣接する直線レールの中心線とタンジェント連続
// （弧の両端で滑らかに繋がる）になる。戻り値は全てこのマスの中心を原点(0,0)とした
// マス単位の相対座標・ラジアン角
function computeRailCornerArc(inDir, outDir) {
    const r = 0.5;
    const ccx = r * (outDir.dx - inDir.dx);
    const ccy = r * (outDir.dy - inDir.dy);
    const startAngle = Math.atan2(-outDir.dy, -outDir.dx); // 入口点（直前の直線から辿り着く点）の方向
    const endAngle = Math.atan2(inDir.dy, inDir.dx);       // 出口点（次の直線へ向かう点）の方向
    let sweep = endAngle - startAngle;
    while (sweep <= -Math.PI) sweep += Math.PI * 2;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    const anticlockwise = sweep < 0;
    return { r, ccx, ccy, startAngle, endAngle, sweep, anticlockwise };
}

// レール本体の見た目。3Dプレビュー（assemblyRailSideMesh/assemblyRailRungMesh）と
// 同じ「細い黒レール2本（マスの全長を貫通）＋幅広いグレーの横木（マス内に周期的に
// 配置、間は穴＝何も描かない）」というデザインを2Dでも再現する。比率は3D側の
// RAIL_SIDE_OFFSET/RAIL_SIDE_WIDTH/RAIL_RUNG_WIDTH/RAIL_RUNG_LENGTH/RAIL_RUNG_OFFSETSと
// 揃えてある。3D側は「黒の方が背が高く、重なった範囲はグレーが黒に隠れる」ことで
// 黒がグレーの上に乗って見えるが、2Dには奥行きが無いため、単純に横木を先に描いてから
// 黒を後から重ねて描くことで同じ見た目（黒が優先して見える）を再現している
function drawMapRailLine(ctx, px, py, size, direction) {
    const isVert = direction === "vertical";
    const SIDE_OFFSET = 0.3, SIDE_WIDTH = 0.15;
    const RUNG_WIDTH = 0.92, RUNG_LENGTH = 0.22;
    const RUNG_OFFSETS = [-0.25, 0.25];
    const cx0 = px + size / 2, cy0 = py + size / 2;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.3)";
    ctx.shadowBlur = 1;
    ctx.shadowOffsetY = 1;

    // 横木（グレー、周期配置）を先に描く
    ctx.fillStyle = "#999";
    const rungCross = size * RUNG_WIDTH, rungAlong = size * RUNG_LENGTH;
    const rungR = Math.min(2, rungCross / 2, rungAlong / 2);
    RUNG_OFFSETS.forEach(offset => {
        const cx = cx0 + (isVert ? 0 : size * offset);
        const cy = cy0 + (isVert ? size * offset : 0);
        const w = isVert ? rungCross : rungAlong;
        const h = isVert ? rungAlong : rungCross;
        ctx.beginPath();
        ctx.roundRect(cx - w / 2, cy - h / 2, w, h, rungR);
        ctx.fill();
    });

    // レール本体（黒、マスの全長を貫通）を横木の上に重ねて描く
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#585858";
    const sideCross = size * SIDE_WIDTH;
    [-SIDE_OFFSET, SIDE_OFFSET].forEach(offset => {
        const cx = cx0 + (isVert ? size * offset : 0);
        const cy = cy0 + (isVert ? 0 : size * offset);
        const w = isVert ? sideCross : size;
        const h = isVert ? size : sideCross;
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    });
    ctx.restore();
}

// カーブの角（1マスぶん）を、直角の折れ線ではなく滑らかな円弧として描く。
// drawMapRailLineと同じ「黒いレール本体2本＋グレーの横木」の見た目を、直線の代わりに
// computeRailCornerArc()で求めた円弧に沿って描く（横木は弧の途中2箇所に、半径方向の
// 短い線として配置——直線版のRUNG_OFFSETS=[-0.25,0.25]に相当する、弧の1/3・2/3地点）
function drawMapRailCorner(ctx, px, py, size, inDir, outDir) {
    const SIDE_OFFSET = 0.3, SIDE_WIDTH = 0.15, RUNG_WIDTH = 0.92, RUNG_LENGTH = 0.22;
    const cx0 = px + size / 2, cy0 = py + size / 2;
    const { r, ccx, ccy, startAngle, endAngle, sweep, anticlockwise } = computeRailCornerArc(inDir, outDir);
    const centerX = cx0 + ccx * size, centerY = cy0 + ccy * size;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.3)";
    ctx.shadowBlur = 1;
    ctx.shadowOffsetY = 1;

    // 横木（グレー、弧の1/3・2/3地点に半径方向の短い線として）
    ctx.strokeStyle = "#999";
    ctx.lineCap = "butt";
    ctx.lineWidth = size * RUNG_LENGTH;
    [1 / 3, 2 / 3].forEach(t => {
        const angle = startAngle + sweep * t;
        const rIn = (r - RUNG_WIDTH / 2) * size, rOut = (r + RUNG_WIDTH / 2) * size;
        ctx.beginPath();
        ctx.moveTo(centerX + rIn * Math.cos(angle), centerY + rIn * Math.sin(angle));
        ctx.lineTo(centerX + rOut * Math.cos(angle), centerY + rOut * Math.sin(angle));
        ctx.stroke();
    });

    // レール本体（黒）: 内側・外側2本の同心円弧
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = "#585858";
    ctx.lineWidth = size * SIDE_WIDTH;
    [(r - SIDE_OFFSET) * size, (r + SIDE_OFFSET) * size].forEach(radius => {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, startAngle, endAngle, anticlockwise);
        ctx.stroke();
    });
    ctx.restore();
}

// 音符マットの画像（プリロード済みキャッシュから取得、未読込ならこの回は何も描かない——
// 読み込み完了時にscheduleMapPanelRedraw()が呼ばれて再描画される）
function drawMapPanelImage(ctx, px, py, size, pitch) {
    const file = PITCH_TO_FILE[toCanonicalPitch(pitch)];
    if (!file) return;
    const img = getMapPanelFilteredImage(pitch);
    if (!img) return;

    ctx.save();
    ctx.translate(px + size / 2, py + size / 2);
    ctx.rotate(northDirection * 90 * Math.PI / 180);
    // 画像は100x100pxだが実際のセルサイズはズームにより10〜20px程度まで縮小されることが多く
    // （標準ズームでcellSize=16px程度、5倍以上の縮小）、ブラウザ既定の
    // imageSmoothingQuality（"low"）だと簡易な補間しか行われず、この倍率では
    // 「輝度が高くくっきり見えずぼやけて見える」（色が薄まり滲んだような見た目になる）
    // 原因になっていた。"high"にすると縮小時の補間の質が上がりくっきり見える
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.shadowColor = "rgba(0,0,0,0.25)";
    ctx.shadowBlur = 1;
    ctx.shadowOffsetY = 1;
    // PITCH_TO_FILEの画像は全て100x100pxの正方形（実測確認済み）なので、
    // object-fit:containと等価な単純な引き伸ばし描画でよい
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
    ctx.restore();

    // 音符マットの左辺・上辺だけ黒い線を引く（元々は四方を囲む実装のバグで右辺・下辺が
    // 後から重ねられる薄いグリッド罫線に隠れ、結果的に左辺・上辺の2辺だけ黒く見えていた。
    // 「2辺が黒だった時が良かった」との要望で、その見た目を意図的に再現する）
    // 線の中心をpx/pyのちょうど0.5だけずらす（addMapBorderLineと同じクリスプ表示のテクニック）
    // 位置合わせは、lineWidthが整数の時だけ1本の線が1〜複数pxの境界にぴったり乗って
    // くっきり見える。0.75や1.25のような半端な太さだと、線がpxグリッドの境界をまたいで
    // アンチエイリアスの薄い階調が複数pxに広がり「ぼやけて」見えてしまう
    // （「2Dがぼやけて見える」の原因と判断し、1.25→整数の1に戻した）
    ctx.save();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px + 0.5, py);
    ctx.lineTo(px + 0.5, py + size);
    ctx.moveTo(px, py + 0.5);
    ctx.lineTo(px + size, py + 0.5);
    ctx.stroke();
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
    if (window.THREE && window.OrbitControls && window.LineSegments2) { callback(); return; }
    window.addEventListener("three-ready", () => callback(), { once: true });
}

let assemblyScene = null, assemblyCamera = null, assemblyRenderer = null, assemblyControls = null, assemblySun = null;
// 雲の影専用の第2ライト（assemblyCloudSun）。レール/トロッコ/キャラクター/音符マット用の
// assemblySunと影用シャドウマップを分けるための仕組み（ASSEMBLY_CLOUD_LAYER参照）
let assemblyCloudSun = null;
let assemblySceneReady = false;
let assemblyAnimFrameId = null;
let assemblySkyMesh = null, assemblyGroundMesh = null; // 空（グラデーション球）・陸（地面）。色をUIから変更できるよう参照を保持する
// 「テーマ」（デバッグウィンドウのプルダウン、デフォルト/UNDERTALE）で空の見た目そのものを
// 差し替えるため、通常時のグラデーションシェーダーと、UNDERTALEテーマ用のバトル画面風
// （黒地に白い星）テクスチャ材質の両方を保持しておき、テーマに応じてassemblySkyMesh.material
// を丸ごと差し替える（陸は色を変えるだけなので専用の材質は不要）
let assemblyGradientSkyMaterial = null;
// UNDERTALE/マフェット戦テーマの空材質はassemblyDecorationMaterialCache（"undertaleSky"/"muffetSky"キー）で
// 遅延生成・キャッシュする（花・草・木の共有マテリアルキャッシュと同じ仕組みを流用）
// 空・陸の色そのものは2D/3D共通のmapSettings.skyColor/groundColorで保持する（保存・共有のため）
const ASSEMBLY_GROUND_Y = -1.5; // 地面の高さ（カメラがこれより下に潜ったら透明にする判定にも使う）
const ASSEMBLY_GROUND_TRANSPARENT_OPACITY = 0.12; // 地中に潜った時の地面の不透明度
let assemblyCameraFramed = false; // 初回のみカメラを内容に合わせてフレーミングする（編集のたびに視点をリセットしないため）
// 「一列の最大センサー数」やレール方向はマップ全体の縦横比を大きく変える設定のため、
// これらが変わった時だけは例外的に再フレーミングする（変えないと、新しい形のマップが
// 古いカメラ位置の視界外に大きくはみ出し「マップの片割れが残っている」ように見えてしまう）。
// rebuildAssemblyMeshes()で、フレーミング済みの値と現在の値を比較して判定する
let assemblyFramedWrapValue = null;
let assemblyFramedRailDirection = null;
// レールの見た目（本体+横木）は、セルごとの向き(data.direction)に応じて縦向き/横向きの
// 2グループに分けてそれぞれ別のInstancedMeshで描く（「トロッコが進む方向に合わせてレールの
// 向きも変える」ため。1つのInstancedMeshは全インスタンス共通のスケール/回転しか持てないため、
// 向きごとに別メッシュにする必要がある。要素数は0〜2個（片方の向きしか無ければ1個、
// レールが無ければ0個）
let assemblyRailSideMeshes = [], assemblyRailRungMeshes = [];
let assemblySensorMeshes = []; // レールと同じく向き(data.direction)ごとに分かれる、要素数0〜2個
let assemblySensorDirectionMesh = null; // mapSettings.showSensorDirection時のみ、デバッグ用の光線（要素数0〜1個）
let assemblyPanelMeshes = {};   // canonical pitch -> InstancedMesh
let assemblyPanelEdgesGroup = null; // 音符マット1枚ごとの黒ぶち（THREE.LineSegmentsの集合）
let assemblyLayerGrids = [];    // 床グリッド（キャンバステクスチャを貼った平面メッシュ。理由はrebuildAssemblyMeshes内のコメント参照）
let assemblyGridVisible = true; // #assemblyGridToggleBtnで切り替える、rebuildAssemblyMeshes()を跨いで保持する
// カメラワーク（#assemblyCameraPlayBtn＝再生/一時停止、.assembly-angle-btn＝アングル選択）。
// 「5秒（後に3秒）おきに切り替える専用ボタン」は廃止し、代わりに4つのアングルボタン
// （左回り/トロッコ視点/右回り/トロッコ前視点）自体をトグル（複数選択可）にした：
// 0個選択＝カメラワーク一時停止と同一、1個選択＝そのアングルに固定、2個以上選択＝
// 選択中のものだけを3秒おきに順番に切り替える（getEffectiveAssemblyCameraAngleMode参照）。
// assemblyCameraPlayingがtrueの間だけstartAssemblyRenderLoop()のtick内で実際に
// カメラを動かす。どちらもrebuildAssemblyMeshes()を跨いで保持する（assemblyGridVisibleと
// 同じ位置付けの状態）
let assemblySelectedAngleModes = new Set(["rotateRight"]); // トグルON中のアングル集合
let assemblyCameraPlaying = false;
let assemblyPlayMarker = null;  // 再生中のトロッコ位置を示す球（initAssemblyScene()で1回だけ作成し使い回す）
let assemblyBeatCenters = [];   // ビートごとのレール中心のワールド座標（updateAssemblyPlayMarker用、rebuildAssemblyMeshes()のたびに作り直す）
// resolveTrolleyDisplayPosition用に、toWorld変換前のグリッド論理座標（{x,y}、1マス=1単位）も
// 保持しておく。ASSEMBLY_CELL_SIZE=1でtoWorldは平行移動+スケール1の変換のため、距離や
// 経路長の計算は変換前のグリッド座標のままで正しく行え、返ってきた位置だけtoWorld()すればよい
let assemblyBeatCentersRaw = [];
// トロッコ視点の直前の進行方向。段の折り返し・曲の終端など次のビート座標が使えない
// 瞬間に、進行方向を再計算できず視点が一瞬跳ねるのを防ぐため、最後に有効だった
// 向きを保持しておいて使い回す（updateAssemblyTrolleyViewCamera参照）。
// トップレベルでTHREE.Vector3を即生成するとTHREE未定義エラーになる（index.htmlの
// コメント参照）ため、nullで始めて初回のupdateAssemblyTrolleyViewCamera呼び出し時に
// 遅延生成する
let assemblyTrolleyLastForward = null;
// 「トロッコが通過するとき、反応する音符マットをへこます」用。beatIndex -> [{pitch, index}]
// （そのビートに鳴る音符マットが、assemblyPanelMeshes[pitch]という1つのInstancedMeshの
// 何番目のインスタンスか）。位置の基準（凹ませる前の元の座標）はassemblyPanelPositionsByPitchに
// 持たせる。どちらもrebuildAssemblyMeshes()のたびに作り直す
let assemblyPanelInstancesByBeat = new Map();
let assemblyPanelPositionsByPitch = {}; // canonical pitch -> Vector3[]（凹ませる前の元の位置）
let assemblyPanelRotY = 0; // 音符マットの現在の回転（northDirection由来、凹み演出の行列再計算に必要）
let assemblyPressedBeatIndex = null; // 現在「凹ませている」beatIndex（変化した時だけ再計算する）
let assemblyPanelEdgeOffsetByPitch = {}; // canonical pitch -> assemblyPanelEdgesGroup.children内での開始インデックス
const ASSEMBLY_CELL_SIZE = 1;
// 層の間隔はマス目の縦横と同じ長さにする（＝1マスぶんが縦横高さとも等しい立方体になる）
const ASSEMBLY_LAYER_HEIGHT = ASSEMBLY_CELL_SIZE;
const ASSEMBLY_ROTATE_SPEED = 0.7; // 自動回転の速さ（OrbitControls既定の2.0より遅く「ゆっくり」に）
// トロッコ視点のカメラの高さ・後方オフセット・注視点の先読み距離。
// 見下ろし角度＝atan(HEIGHT/(BACK_OFFSET+LOOK_AHEAD))という関係があるため、
// 3つを個別に調整することで「見下ろし具合」と「引き具合」を別々にコントロールできる。
// 「もう少しカメラを下げて、遠くが見える感じで」との指定でHEIGHTを下げ、LOOK_AHEADを
// 伸ばして遠近感を強調した後、「気持ち見下し気味で、水平線は見えるように」との指定で
// HEIGHTだけ少し戻した（見下ろし角を少し付けつつ、浅めに保って遠くの見通しは保つ）。
// その後「もう少し引き気味に」との指定でBACK_OFFSET/HEIGHTを約1.7倍に拡大（見下ろし角は
// ほぼ据え置き、単純にカメラとトロッコの距離だけを伸ばす）。さらにその後
// 「近接グループのカメラはもう少し引きでいい」との指定でBACK_OFFSET/HEIGHT/
// FRONT_VIEW_OFFSETを約1.35倍に再拡大した
const ASSEMBLY_TROLLEY_VIEW_HEIGHT = 4.3; // トロッコ視点のカメラの高さ（トロッコ位置からの上乗せ）
const ASSEMBLY_TROLLEY_VIEW_BACK_OFFSET = 9.5; // トロッコ視点のカメラを進行方向と逆へ下げる量
const ASSEMBLY_TROLLEY_VIEW_LOOK_AHEAD = 5; // 注視点をトロッコの少し先に置く距離
// トロッコ前視点: 進行方向の前方にこの距離だけ離れた位置にカメラを置き、トロッコ自身を
// 振り返って見る（トロッコ視点＝後方追従の対になる構図）。高さはトロッコ視点と共通
const ASSEMBLY_TROLLEY_FRONT_VIEW_OFFSET = 9.5;
// 遠隔グループの開始距離レンジ（ASSEMBLY_ROTATE_START_DISTANCE_MIN/MAX、下記）は
// 「近接グループの距離感を基準にした絶対距離」として設計した経緯があるが、値自体は
// その依頼当時の近接グループの距離（7）を基準に一度チューニング済みのため、近接グループの
// FRONT_VIEW_OFFSETを直接参照すると、近接側だけを調整したいときに遠隔側の距離まで
// 連動して変わってしまう。それを避けるため、当時の基準値をこの定数として切り離して固定した
const ASSEMBLY_ROTATE_START_DISTANCE_REFERENCE = 7;
// トロッコ左前視点/右前視点: 前視点と同じ距離感（カメラ〜トロッコ間の距離は前視点と揃える）
// のまま、進行方向の真正面ではなく斜め45度の位置から見る構図。前方向成分・横方向成分とも
// OFFSET*cos(45°)/sin(45°)にすることで、前視点と同じ半径の円周上の別の点になるようにしている
const ASSEMBLY_TROLLEY_FRONT_DIAGONAL_FORWARD = ASSEMBLY_TROLLEY_FRONT_VIEW_OFFSET * Math.SQRT1_2;
const ASSEMBLY_TROLLEY_FRONT_DIAGONAL_SIDE = ASSEMBLY_TROLLEY_FRONT_VIEW_OFFSET * Math.SQRT1_2;
// 「カメラワークを改善したい」との依頼で、カメラワークを2グループに整理した。
// 近接グループ＝トロッコ視点/前視点/左前視点/右前視点（chaseモード、トロッコにぴったり
// 追従する構図）。一時追加していたトロッコ横視点・俯瞰視点は「消してよい」との指示で
// 削除済みだが、その後「左前・右前からのアングルを追加してほしい」との依頼で
// trolleyFrontLeftView・trolleyFrontRightViewを新設した
// 「カメラモード名を重複して手打ちしている4つの配列があり、新モード追加時の更新漏れの
// リスクがある」との2026-09コードレビュー指摘を受け、モードごとの定義を1つの配列
// （ASSEMBLY_CAMERA_MODE_DEFS）に集約し、以前は個別に手打ちしていたASSEMBLY_CHASE_MODES/
// ASSEMBLY_ANGLE_MODE_ORDER/ASSEMBLY_REMOTE_CAMERA_MODES/ASSEMBLY_REMOTE_CHASE_SUBMODESの
// 4つはすべてそこから導出する形に整理した（各配列の中身・並び順は変更前と完全に同一）。
// 新しいアングルを追加する際は、ここに1エントリ追記するだけでよい。
// - group: "near"（近接、チェイス視点）/"remote"（遠隔、周回視点）
// - chaseFollow: trueのものだけが「遠隔グループに入った瞬間のランダム開始位置スナップ＋
//   毎フレームの追従補正」の対象（rotateLeft/rotateRightのみ。rotateLeftFixed/
//   rotateRightFixedは「カメラ位置はほぼ動かさない」という復活させたい旧挙動のため対象外）
const ASSEMBLY_CAMERA_MODE_DEFS = [
    { name: "rotateLeft", group: "remote", chaseFollow: true },
    { name: "trolleyView", group: "near" },
    { name: "rotateRight", group: "remote", chaseFollow: true },
    { name: "trolleyFrontView", group: "near" },
    { name: "trolleyFrontLeftView", group: "near" },
    { name: "trolleyFrontRightView", group: "near" },
    { name: "rotateLeftFixed", group: "remote" },
    { name: "rotateRightFixed", group: "remote" },
];
const ASSEMBLY_CHASE_MODES = ASSEMBLY_CAMERA_MODE_DEFS.filter(d => d.group === "near").map(d => d.name); // 近接グループ（tick()・applyAssemblyCameraAngleAndPlayState()共通の判定に使う）
// 「トロッコ視点」「トロッコ前視点」は元々OrbitControlsを無効化しカメラを直接固定していたが、
// 「マウスによる視点変更も許容してほしい」との依頼で、当初は「毎フレームcontrols.targetだけを
// トロッコへ追従させ、カメラの位置はOrbitControls.update()任せ」という左回り/右回りと同じ
// 方式に変更した。ところが実測したところ、targetだけを動かしてupdate()を呼んでも
// カメラがまったく追従しない（トロッコが遠く離れてもカメラが完全に静止したまま）という
// 不具合が発覚した——OrbitControls.update()は毎回「現在のcamera.position - 現在のtarget」
// からoffsetを再計算し、そのoffsetをそのまま新しいtargetに足し戻してcamera.positionを
// 再構成する実装のため、（autoRotate等の角度デルタが無い限り）targetをいくら動かしても
// 結果的にcamera.positionは変化しない、という数学的な無変化（恒等変換）になっていたのが原因
// （左回り/右回りで「追従できている」ように見えていたのはautoRotateの角度デルタが
// 毎フレーム加わっていたおかげで、target追従そのものの効果ではなかった）。
// 「背面カメラと前面カメラは追従してください」との指摘を受け、一旦「ユーザーがマウスで
// ドラッグ中でない限り、毎フレームsnapAssemblyChaseCameraToTrolley()でカメラ位置を丸ごと
// 再計算する」方式にしたが、これだとドラッグをやめた次のフレームで基準構図へ戻ってしまい、
// 「視点を動かした後、戻すのではなく維持してほしい（遠隔と同じように）」との指摘を受けた。
// 最終的に、遠隔グループ（左回り/右回り）と同じ「モードに入った瞬間だけ基準構図へ一度
// スナップし、以降は同じモードが続く限りトロッコの移動ぶんをカメラへ平行移動として
// 足し込むだけ」という方式に変更した（tick内の分岐、assemblyLastChaseCameraMode/
// assemblyChaseLastTrolleyPos参照）。ドラッグによる相対オフセットはこの平行移動を挟んでも
// 保たれるため、ドラッグ中かどうかで分岐する必要が無くなった
// アングルボタンの固定順序（複数選択時、この順で巡回する）。「5秒おきに切り替える
// 専用ボタン」は廃止し、代わりにアングルボタン自体をトグルにして、選択中のものだけを
// この順番で3秒おきに巡回するようにした（0個選択＝一時停止と同一、1個選択＝それに固定）。
// 「近接グループに、左前・右前からのアングルを追加してほしい」との依頼で
// trolleyFrontLeftView・trolleyFrontRightViewを末尾に追加した（既存4つの並び順は不変）。
// その後「昔の（カメラ位置がほぼ動かない）左回り/右回りを別アングルとして復活させたい」
// との依頼でrotateLeftFixed・rotateRightFixedを追加した
const ASSEMBLY_ANGLE_MODE_ORDER = ASSEMBLY_CAMERA_MODE_DEFS.map(d => d.name);
const ASSEMBLY_CYCLE_INTERVAL_MS = 3000;
let assemblyCycleAngleIndex = 0; // ASSEMBLY_ANGLE_MODE_ORDER内の現在位置（2個以上選択時のみ使う）
let assemblyCycleTimerId = null;

// 遠隔グループ（左回り/右回り）。「カメラワークを改善したい」との依頼で、この2つに
// 新しい挙動を追加した——従来は「元々あったカメラの位置のまま」左回り/右回りを開始して
// いたが、遠隔グループに（何か別のモードや一時停止状態から）入った瞬間だけ、トロッコを
// 中心にランダムな方位の位置へ一度スナップするようにした。角度そのものの回転は従来通り
// OrbitControls.autoRotateに任せる（tick()内、snapAssemblyCameraToRandomRemoteStart参照）。
// 「トロッコに接近する仕様は廃止」との依頼により、開始後に毎フレーム距離を詰めていく
// 処理（approachAssemblyRemoteCameraTowardTrolley）は削除済み——開始距離は
// 「可能な限り近くまで寄ること」との指定通り、常にminDistance（これ以上近寄れない下限）
// に固定し、そのまま距離を変えずに回り続ける（このランダム開始+追従補正の挙動は
// 下のASSEMBLY_REMOTE_CHASE_SUBMODESだけが対象）。
// 「最初のころの（カメラ位置がほぼ動かず、注視点だけがトロッコを追う）左回り/右回りも
// 良かったので別アングルとして復活させてほしい」との依頼で、rotateLeftFixed/
// rotateRightFixedを遠隔グループに追加した。こちらは`ASSEMBLY_REMOTE_CHASE_SUBMODES`に
// 含めないことで、ランダム開始スナップ・追従補正のどちらも適用されない（tick()参照）
// ＝targetだけがトロッコを追い、カメラ自身の位置は当時と同じくOrbitControls.update()の
// 恒等変換的な挙動に任せたまま（結果、遠くのトロッコを見るとゆっくり画角が変わって見える）
const ASSEMBLY_REMOTE_CAMERA_MODES = ASSEMBLY_CAMERA_MODE_DEFS.filter(d => d.group === "remote").map(d => d.name);
const ASSEMBLY_REMOTE_CHASE_SUBMODES = ASSEMBLY_CAMERA_MODE_DEFS.filter(d => d.chaseFollow).map(d => d.name); // ランダム開始+追従補正の対象（Fixed版は対象外）
// 開始距離：「可能な限り近く(minDistance固定)」→「30%〜55%(minDistance〜maxDistanceの比率)」
// といくつか試したが、「まだ遠い」との指摘が続いた。原因は、比率の基準にしていた
// minDistance/maxDistance自体が曲・マップ設定の規模（footprint）に応じて大きく伸び縮みする値
// だったこと——大きめのトラックだとmaxDistanceが600超になることもあり、その30%でも
// 絶対距離としては200前後という「近接グループ（トロッコ視点等、距離7程度）」とは
// 桁違いに離れた位置になってしまっていた。トラック全体を見渡すための距離レンジを
// 基準にする設計自体が間違っていたため、近接グループの距離感（ASSEMBLY_TROLLEY_FRONT_VIEW_OFFSET
// =7）を基準にした絶対距離（その2.5〜5倍）に変更した。これによりトラックの規模に
// 関わらず「近接グループより一回り引いた、それでいて近接寄りの距離感」で安定する
// （実際にOrbitControls上で選べる範囲かどうかだけ、安全のためminDistance/maxDistanceで
// クランプする）
const ASSEMBLY_ROTATE_START_DISTANCE_MIN = ASSEMBLY_ROTATE_START_DISTANCE_REFERENCE * 2.5;
const ASSEMBLY_ROTATE_START_DISTANCE_MAX = ASSEMBLY_ROTATE_START_DISTANCE_REFERENCE * 5;
// 開始位置の仰角は、既定の俯瞰視点（frameAssemblyCamera参照、水平から見て約31°）に揃える。
// 方位角・距離だけをランダムにすることで、真上/真下などの不自然な角度にならないようにした
const ASSEMBLY_ROTATE_START_ELEVATION_DEG = 31;
// 直前フレームで実際に効いていた遠隔グループのモード（"rotateLeft"/"rotateRight"/null）。
// これが変わった瞬間（他モード/一時停止から入った時・左回り⇄右回りが切り替わった時の
// どちらも）に再スナップする（tick()参照。「左回り⇄右回りの切替でも毎回中央基準の
// 近づいた地点へ再スナップしてほしい」との依頼で、単純な「入った/入っていない」の
// 真偽値ではなくモード自体を追跡するよう変更した）
let assemblyLastRemoteCameraMode = null;
let assemblyRemoteCameraLastTargetPos = null; // 前フレームのトロッコ位置（target移動ぶんをカメラにも平行移動させ、半径のドリフトを防ぐため）

// 「レースゲームでよくある、数秒おきにランダムにカメラが切り替わるかっこいいモード」
// （#assemblyRandomCameraBtn）。既存の4アングルトグル（assemblySelectedAngleModes）とは
// 独立したON/OFFモードとして実装しているが、「ランダム時に使う種類は、トグルで
// 切りかえられるように戻す」との依頼により、ランダムモード中もassemblySelectedAngleModes
// 自体は一切書き換えず、あくまで「ランダムモードが選んでよい種類（トグルONのもの）」
// という意味のまま保つ。実際に今表示しているモードは別変数
// （assemblyRandomCameraCurrentMode）で持ち、getEffectiveAssemblyCameraAngleModeが
// ランダムモード中はそちらを返す。こうすることで、ランダムモードを動かしたまま
// 手動トグルボタンでも自由に候補の増減ができ、かつ「ランダムモードを抜けたら選択集合が
// 汚れていて解除できない」といった不具合も構造上起きなくなる。
// 「必ず、近接→遠隔の順に切り替わるようにしてほしい」との依頼で、近接グループ
// （ASSEMBLY_CHASE_MODES）・遠隔グループ（ASSEMBLY_REMOTE_CAMERA_MODES）を厳密に交互に
// 選ぶ（pickNextAssemblyRandomCameraMode参照）。間隔も固定3秒ではなく毎回ランダム
// （2〜4.5秒）にすることで、既存の巡回モードとは違う「予測できない切り替わり方」を
// 出している。直前と同じアングルが連続で選ばれると変化が無く単調に見えるため、
// 選択肢からは直前のアングルを除外する
const ASSEMBLY_RANDOM_CAMERA_MIN_INTERVAL_MS = 2000;
const ASSEMBLY_RANDOM_CAMERA_MAX_INTERVAL_MS = 4500;
let assemblyRandomCameraMode = false;
let assemblyRandomCameraTimerId = null;
let assemblyRandomCameraCurrentMode = null; // ランダムモードが今選んでいるモード（近接/遠隔どちらも0個ならnull）
let assemblyRandomCameraNextGroup = "near"; // 次に選ぶべきグループ（"near"/"remote"を交互に）
// 直前フレームで実際に効いていた近接グループのモード（"trolleyView"等/null）。遠隔グループの
// assemblyLastRemoteCameraModeと同じ考え方で、これが変わった瞬間（他モード/一時停止から
// 入った時・トロッコ視点⇄前視点等の切替時）だけ基準構図へ再スナップする。「近接アングルで
// ユーザーが視点を動かした後、ドラッグをやめても元の構図に戻さず維持してほしい（遠隔と
// 同じように）」との依頼のため、同じモードが続いている間は一切スナップし直さない
let assemblyLastChaseCameraMode = null;
// 前フレームのトロッコ位置（遠隔グループのassemblyRemoteCameraLastTargetPosと同じ考え方で、
// target移動ぶんをカメラにも平行移動させ、ユーザーがドラッグで作った相対オフセットを
// 保ったまま追従させるため）
let assemblyChaseLastTrolleyPos = null;
// スナップ時点の「トロッコ位置→target」のオフセット（トロッコ視点の注視点は
// 進行方向へのlook-ahead分ずれているため、target自体もトロッコ位置とは別に持つ必要がある）。
// 「途中でカクっとなる」というデグレの原因究明: 以前はこのオフセットを毎フレーム
// computeAssemblyTrolleyForward()から再計算していたが、レールが折り返る区間で進行方向が
// 急反転すると、target（＝カメラの注視点）だけが1フレームで大きく飛び、OrbitControlsの
// minDistance/maxDistanceクランプが働いてカメラ位置ごと引っ張られる「カクッ」というスナップが
// 起きていた。トロッコの移動そのものは連続的（急に飛ばない）なので、target側もforwardを
// 毎回引き直すのではなく、スナップ時に一度だけ確定させたオフセットをトロッコ位置に
// 足すだけにすることで、カメラ⇄target間の距離を常に一定に保ち、クランプが発動する余地を
// 無くした
let assemblyChaseTargetOffset = null;
// トロッコマーカー（buildAssemblyTrolleyMesh）の車輪接地面をレール上面付近に合わせる
// オフセット。レールはy=0中心・高さ0.2（RAIL_HEIGHT、rebuildAssemblyMeshes参照）なので
// 上面は約0.1。実測しながら調整すること
const ASSEMBLY_TROLLEY_MARKER_Y_OFFSET = 0.1;
// トロッコ本体（マーカー）の直前の進行方向。assemblyTrolleyLastForwardと同じ理由で、
// 折り返し・移動が無い瞬間の不自然な回転を防ぐために使う（updateAssemblyPlayMarker参照）
let assemblyMarkerLastForward = null;
// トロッコ本体の向き(rotation.y)を滑らかに回転させるための、前回このフレームを
// 処理した実時刻（updateAssemblyPlayMarker参照）
let assemblyMarkerLastRotationTime = null;

const MAP_PANEL_MATERIALS = {}; // canonical pitch -> [6面ぶんのMeshStandardMaterial]（BoxGeometry用）
let assemblyRailMaterial = null, assemblyRailRungMaterial = null, assemblySensorMaterial = null, assemblyPanelSideMaterial = null, assemblyUnitBoxGeometry = null;
let assemblySensorDirectionMaterial = null; // センサー向きデバッグ光線（mapSettings.showSensorDirection）用
let assemblyPanelEdgesGeometry = null, assemblyPanelEdgesMaterial = null; // 音符マットの黒ぶち用（共有、位置/回転/スケールだけ個別に設定する）

// 空の色（#assemblySkyColorInput）を変更する。水平線側（bottomColor）は指定色を白へ
// 75%寄せた明るい色を自動で作り、グラデーション自体は常に保つ。
// デフォルト以外のテーマ適用中は空が専用材質（uniformsを持たない）に差し替わっているため、
// 何もしない（設定自体はmapSettings.skyColorに保存され、デフォルトテーマに戻した時に反映される）
function applyAssemblySkyColor(hex) {
    if (!assemblySkyMesh || debugTheme !== "default") return;
    const top = new THREE.Color(hex);
    const bottom = top.clone().lerp(new THREE.Color(0xffffff), 0.75);
    assemblySkyMesh.material.uniforms.topColor.value.copy(top);
    assemblySkyMesh.material.uniforms.bottomColor.value.copy(bottom);
}

// 陸の色（#assemblyGroundColorInput）を変更する。デフォルト以外のテーマ適用中は陸が
// 専用の固定色になっているため、同様に何もしない（理由はapplyAssemblySkyColor参照）。
// 「地面がベタ塗りではなく模様（色ムラ＋小さな花模様）になっている実機の写真を再現できるか」
// との依頼を受け、地面の色が既定の緑（MAP_GROUND_COLOR_DEFAULT）の時だけ
// buildAssemblyGroundGrassTexture()で生成した模様テクスチャを使う。「地面色はUIで自由に
// 選べる仕様だが、模様の種類はどう決めるか」を確認したところ「とりあえずデフォルトの緑のみ
// 適用」との指定だったため、それ以外の任意色では従来通りベタ塗りのまま（テクスチャなし）にする
function applyAssemblyGroundColor(hex) {
    if (!assemblyGroundMesh || debugTheme !== "default") return;
    if (hex === MAP_GROUND_COLOR_DEFAULT) {
        if (!assemblyGroundGrassTexture) assemblyGroundGrassTexture = buildAssemblyGroundGrassTexture(hex);
        assemblyGroundMesh.material.map = assemblyGroundGrassTexture;
        assemblyGroundMesh.material.color.set(0xffffff); // テクスチャに色を焼き込んでいるので乗算しない
    } else {
        assemblyGroundMesh.material.map = null;
        assemblyGroundMesh.material.color.set(hex);
    }
    assemblyGroundMesh.material.needsUpdate = true; // map有無の切替はシェーダー再コンパイルが必要
}

// 地面（草原）の模様テクスチャを一度だけ生成し使い回す。ユーザー提供の参考写真
// （茶色い地面=色ムラ＋暗い小さな穴、緑の地面=色ムラ＋花のような小さな色点）のうち、
// 「とりあえずデフォルトの緑のみ適用」という指定に沿って、緑の草原パターン（色ムラ＋
// 花模様の点）だけを再現する。900×900の地面全体にASSEMBLY_GROUND_TEXTURE_WORLD_SIZE
// （ワールド単位、レール1マス=1）ごとに1タイルが来るようリピートさせる
let assemblyGroundGrassTexture = null;
// 「見た目が規則的」との指摘対応: タイル1枚あたりの配置数が少ないまま小さいタイルで
// リピートすると、同じ配置（花5個・パッチ7個の並び）が視界内に何度も同時に見えてしまい、
// 規則的なスタンプのように見えてしまう。タイル自体のワールド上のサイズを広げ（6→12）、
// 個数・解像度も同じ倍率（面積比で4倍）で増やすことで、1個1個の見た目の大きさ・密度
// （見た目の印象としての薄さ）は変えずに、同じ並びが繰り返し視界に入る頻度だけを減らした
const ASSEMBLY_GROUND_TEXTURE_SIZE = 2048;
const ASSEMBLY_GROUND_TEXTURE_WORLD_SIZE = 12;
const ASSEMBLY_GROUND_PLANE_SIZE = 900; // groundGeometryのPlaneGeometry(900, 900)と合わせる

function buildAssemblyGroundGrassTexture(baseHex) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = ASSEMBLY_GROUND_TEXTURE_SIZE;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const base = new THREE.Color(baseHex);
    const baseRgb = { r: Math.round(base.r * 255), g: Math.round(base.g * 255), b: Math.round(base.b * 255) };

    ctx.fillStyle = `rgb(${baseRgb.r}, ${baseRgb.g}, ${baseRgb.b})`;
    ctx.fillRect(0, 0, W, H);

    // タイルの継ぎ目が見えないよう、円/花が端をまたぐ場合に備えて周囲8近傍にも同じものを描く
    // （リピートで隣り合うタイル同士が、まるで最初から1枚だったかのように繋がって見える）
    const drawWrapped = (cx, cy, margin, draw) => {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const x = cx + dx * W, y = cy + dy * H;
                if (x + margin < 0 || x - margin > W || y + margin < 0 || y - margin > H) continue;
                draw(x, y);
            }
        }
    };

    // 色ムラ（雲状の濃淡パッチ）。参考写真同様、単調なベタ塗りに見えないようにする。
    // タイルのワールドサイズが2倍（6→12）になった分、同じ絶対的な大きさ・密度に見えるよう
    // 個数を面積比の4倍・半径の割合を半分にしている（上のASSEMBLY_GROUND_TEXTURE_WORLD_SIZE参照）
    const blotchCount = 20;
    for (let i = 0; i < blotchCount; i++) {
        const cx = Math.random() * W, cy = Math.random() * H;
        const radius = W * (0.025 + Math.random() * 0.045);
        const darker = Math.random() < 0.6;
        const amount = (0.08 + Math.random() * 0.1) * (darker ? -1 : 1);
        const target = amount >= 0 ? 255 : 0;
        const r = Math.round(baseRgb.r + (target - baseRgb.r) * Math.abs(amount));
        const g = Math.round(baseRgb.g + (target - baseRgb.g) * Math.abs(amount));
        const b = Math.round(baseRgb.b + (target - baseRgb.b) * Math.abs(amount));
        drawWrapped(cx, cy, radius, (x, y) => {
            const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
            grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.5)`);
            grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // 小さな花模様。中心の円＋周囲6枚の花びら（円の集合）で表現する簡易的な花形
    const flowerColors = ["#e9cf4a", "#f3efe0", "#5cc2b3", "#d7e696", "#eeb0c9"];
    const drawFlower = (x, y, r, color) => {
        ctx.fillStyle = color;
        const petals = 6;
        for (let p = 0; p < petals; p++) {
            const angle = (p / petals) * Math.PI * 2;
            const px = x + Math.cos(angle) * r * 0.62;
            const py = y + Math.sin(angle) * r * 0.62;
            ctx.beginPath();
            ctx.arc(px, py, r * 0.42, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(x, y, r * 0.42, 0, Math.PI * 2);
        ctx.fill();
    };
    const flowerCount = 28;
    for (let i = 0; i < flowerCount; i++) {
        const cx = Math.random() * W, cy = Math.random() * H;
        // 「少し小さくして」で0.006〜0.011→0.004〜0.0075、その後「少し大きくしてください」で
        // 0.005〜0.009に調整
        const radius = W * (0.005 + Math.random() * 0.004);
        const color = flowerColors[Math.floor(Math.random() * flowerColors.length)];
        drawWrapped(cx, cy, radius * 2, (x, y) => drawFlower(x, y, radius, color));
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    const repeatCount = ASSEMBLY_GROUND_PLANE_SIZE / ASSEMBLY_GROUND_TEXTURE_WORLD_SIZE;
    texture.repeat.set(repeatCount, repeatCount);
    if (assemblyRenderer) texture.anisotropy = assemblyRenderer.capabilities.getMaxAnisotropy();
    return texture;
}

// UNDERTALEテーマ用、バトル画面風（黒地に白い星）のテクスチャを一度だけ生成して使い回す
function buildUndertaleSkyMaterial() {
    if (assemblyDecorationMaterialCache.has("undertaleSky")) return assemblyDecorationMaterialCache.get("undertaleSky");
    // 巨大な球（半径450）に貼るため、解像度が低いと1つ1つの星がぼやけた大きな
    // 四角い光の塊に見えてしまう（実際に低解像度で試して確認）。解像度を上げ、
    // かつNearestFilterでにじませない（Undertale本編のドット絵らしい、輪郭のくっきりした
    // 星にする）ことで、ぼやけを解消する
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // 大きさ・明るさをランダムに散らした白い点（1〜2px四方の四角、くっきりさせるため円ではなく
    // 四角にする）で、素朴な星空らしいムラを出す
    for (let i = 0; i < 900; i++) {
        const x = Math.floor(Math.random() * canvas.width);
        const y = Math.floor(Math.random() * canvas.height);
        const size = Math.random() < 0.85 ? 1 : 2; // ほとんどは1px、たまに2pxの明るい星
        ctx.fillStyle = `rgba(255,255,255,${(Math.random() * 0.5 + 0.5).toFixed(2)})`;
        ctx.fillRect(x, y, size, size);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, fog: false });
    assemblyDecorationMaterialCache.set("undertaleSky", material);
    return material;
}

// マフェット戦テーマ用、お店の紫〜マゼンタのグラデーションに蜘蛛の巣模様を重ねたテクスチャを
// 一度だけ生成して使い回す（UNDERTALEテーマのbuildUndertaleSkyMaterialと同じ考え方）
function buildMuffetSkyMaterial() {
    if (assemblyDecorationMaterialCache.has("muffetSky")) return assemblyDecorationMaterialCache.get("muffetSky");
    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext("2d");
    const bgGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bgGradient.addColorStop(0, "#1a0620");
    bgGradient.addColorStop(1, "#5c1a4a");
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 蜘蛛の巣模様: 中心から放射状の糸＋同心円状に糸をつなぐ輪。
    // 「蜘蛛の巣だと気付きにくいのは、でかいのが1つしかないから」との指摘を受け、
    // 巨大な巣を1つ（半径がキャンバス全体＝球全体に及ぶ）だけ配置する方式をやめた。
    // 1つしか無いと、どの向きを見てもその巣の一部（交差する数本の線）しか視界に入らず、
    // 「蜘蛛の巣の形」として認識しづらい。代わりに、通常の視野角に収まる程度の
    // 小さめの巣を複数バラまき、どちらを向いても巣の全体像が視界に入りやすくする。
    // このcanvasは球（THREE.SphereGeometry）に巻きつく横長の1枚絵のため、中心が
    // キャンバスの左右端付近にある巣は、反対側の脚がキャンバスの外＝反対の端に
    // 続かなければならない（球ではつながっているため）。単純に1回描くだけだと
    // 端で切れて「右半分しか無い巣」になってしまっていたので、横方向に
    // ±canvas.widthずらしたコピーも一緒に描き、端をまたぐ巣も継ぎ目なく繋がるようにした
    function drawWebAt(cx, cy, radius, spokeCount, rings) {
        const spokes = [];
        for (let i = 0; i < spokeCount; i++) {
            const angle = (i / spokeCount) * Math.PI * 2;
            const dx = Math.cos(angle), dy = Math.sin(angle);
            spokes.push({ dx, dy });
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + dx * radius, cy + dy * radius);
            ctx.stroke();
        }
        for (let r = 1; r <= rings; r++) {
            const ringRadius = (r / rings) * radius;
            ctx.beginPath();
            spokes.forEach((s, i) => {
                const x = cx + s.dx * ringRadius, y = cy + s.dy * ringRadius;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            });
            ctx.closePath();
            ctx.stroke();
        }
    }
    function drawWeb(cx, cy, radius, spokeCount, rings) {
        [-canvas.width, 0, canvas.width].forEach(offset => drawWebAt(cx + offset, cy, radius, spokeCount, rings));
    }

    // 蜘蛛（1本の糸で上から垂れているシルエット）。本体は楕円形の腹＋丸い頭、
    // 脚は4対（片側4本）を斜めに生やすだけの簡略化した見た目にする
    function drawHangingSpider(x, topY, threadLength) {
        ctx.strokeStyle = "rgba(255, 235, 250, 0.7)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, topY);
        ctx.lineTo(x, topY + threadLength);
        ctx.stroke();

        const bodyY = topY + threadLength;
        const r = 11;
        ctx.fillStyle = "rgba(15, 5, 15, 0.95)";
        ctx.beginPath();
        ctx.ellipse(x, bodyY + r * 1.4, r, r * 1.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, bodyY, r * 0.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(15, 5, 15, 0.95)";
        ctx.lineWidth = 2;
        for (let i = 0; i < 4; i++) {
            const legY = bodyY + r * 0.6 + i * r * 0.5;
            const spread = r * (1.4 + i * 0.35);
            [-1, 1].forEach(side => {
                ctx.beginPath();
                ctx.moveTo(x, legY);
                ctx.lineTo(x + side * spread, legY - r * 0.3);
                ctx.stroke();
            });
        }
    }

    // マフェット本人（他の小さな蜘蛛より一回り大きい、糸で垂れたシルエット）。
    // 頭＋ツインお団子＋裾の広がったドレス＋蜘蛛脚3対＋ピンクのリボン、という
    // 簡略化した見た目で「ただの蜘蛛ではない特別な1匹」と分かるようにする
    function drawMuffet(x, topY, threadLength) {
        ctx.strokeStyle = "rgba(255, 235, 250, 0.7)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, topY);
        ctx.lineTo(x, topY + threadLength);
        ctx.stroke();

        const bodyY = topY + threadLength;
        const r = 11 * 2.6; // 通常の蜘蛛(r=11)より一回り大きくして特別感を出す

        ctx.fillStyle = "rgba(10, 4, 12, 0.97)";
        ctx.beginPath();
        ctx.arc(x, bodyY, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        // ツインお団子（左右の小さな丸）
        [-1, 1].forEach(side => {
            ctx.beginPath();
            ctx.arc(x + side * r * 0.55, bodyY - r * 0.15, r * 0.22, 0, Math.PI * 2);
            ctx.fill();
        });

        // ドレス（裾が広がる三角形のシルエット）
        const dressTopY = bodyY + r * 0.4;
        const dressBottomY = bodyY + r * 1.9;
        ctx.beginPath();
        ctx.moveTo(x, dressTopY);
        ctx.lineTo(x - r * 1.1, dressBottomY);
        ctx.lineTo(x + r * 1.1, dressBottomY);
        ctx.closePath();
        ctx.fill();

        // 蜘蛛脚（ドレスの左右から伸びる細い脚を3対）
        ctx.strokeStyle = "rgba(10, 4, 12, 0.97)";
        ctx.lineWidth = 2.2;
        for (let i = 0; i < 3; i++) {
            const legY = dressTopY + r * 0.5 + i * r * 0.45;
            const spread = r * (1.4 + i * 0.35);
            [-1, 1].forEach(side => {
                ctx.beginPath();
                ctx.moveTo(x + side * r * 0.9, legY);
                ctx.lineTo(x + side * spread, legY - r * 0.25);
                ctx.stroke();
            });
        }

        // 差し色のリボン（頭の上の小さなピンク）
        ctx.fillStyle = "rgba(255, 140, 200, 0.9)";
        ctx.beginPath();
        ctx.ellipse(x, bodyY - r * 0.55, r * 0.18, r * 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    // 「蜘蛛の巣の大きさは大中小様々」との指摘で、細めの線（4px→2px）にした上で、
    // 小・中・大の3段階からランダムに選ぶようにし、個数も増やして空白が目立ちにくくした
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 235, 250, 0.85)";
    const webCount = 12;
    const sizeTiers = [
        { min: 0.035, max: 0.06 },  // 小
        { min: 0.07, max: 0.11 },   // 中
        { min: 0.13, max: 0.2 },    // 大
    ];
    for (let i = 0; i < webCount; i++) {
        const cx = Math.random() * canvas.width;
        const cy = Math.random() * canvas.height * 0.75; // 地面に近い下端すれすれには置かない
        const tier = sizeTiers[Math.floor(Math.random() * sizeTiers.length)];
        const radius = canvas.width * (tier.min + Math.random() * (tier.max - tier.min));
        drawWeb(cx, cy, radius, 9 + Math.floor(Math.random() * 5), 4);
    }

    // 上から1本の糸で垂れている蜘蛛を2匹ほど配置
    for (let i = 0; i < 2; i++) {
        const x = canvas.width * (0.2 + Math.random() * 0.6);
        // 球の極（canvas y=0＝真上）に近すぎると、等長方形図法の歪みで糸が波打って見える
        // （実際に真上を見上げて確認）ため、極からは少し離す
        const topY = canvas.height * (0.15 + Math.random() * 0.15);
        const threadLength = canvas.height * (0.12 + Math.random() * 0.18);
        drawHangingSpider(x, topY, threadLength);
    }

    // マフェット本人を1匹。「マフェットも追加できるか」との依頼に対応。見つけやすいよう、
    // 通常のカメラが最初に向きがちな中央寄りの位置に固定気味に配置する
    drawMuffet(canvas.width * (0.45 + Math.random() * 0.1), canvas.height * 0.2, canvas.height * 0.22);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, fog: false });
    assemblyDecorationMaterialCache.set("muffetSky", material);
    return material;
}

// 「テーマ」（デバッグウィンドウのプルダウン）に応じて空・陸の見た目を切り替える。
// デフォルト: 通常のグラデーション空＋mapSettings.groundColor/skyColorの陸/空
// UNDERTALE: バトル画面風（黒地に白い星）の空＋ほぼ黒の陸
// マフェット戦: 紫〜マゼンタの空に蜘蛛の巣模様＋深い紫の陸
// 3Dシーンが未初期化（assemblySkyMesh/assemblyGroundMeshがまだ無い）間は何もしない
// （initAssemblyScene側で生成直後に改めて呼ばれる）
function applyAssemblyThemeVisuals() {
    if (!assemblySkyMesh || !assemblyGroundMesh) return;
    if (debugTheme === "undertale") {
        assemblySkyMesh.material = buildUndertaleSkyMaterial();
        assemblyGroundMesh.material.color.set("#050505");
    } else if (debugTheme === "muffet") {
        assemblySkyMesh.material = buildMuffetSkyMaterial();
        assemblyGroundMesh.material.color.set("#2a0a24");
    } else {
        assemblySkyMesh.material = assemblyGradientSkyMaterial;
        applyAssemblySkyColor(mapSettings.skyColor);
        applyAssemblyGroundColor(mapSettings.groundColor);
    }
    // マフェット戦テーマ限定のバトルUI風オーバーレイ（ハート＋たたかう等）は、このテーマの時だけ出す
    const battleUI = document.getElementById("muffetBattleUI");
    if (battleUI) battleUI.style.display = debugTheme === "muffet" ? "flex" : "none";
    if (assemblyRenderer && assemblyCamera) assemblyRenderer.render(assemblyScene, assemblyCamera);
}

// 色ピッカーの"input"連打（ドラッグ中の連続発火）を、指を止めた瞬間だけにまとめるための
// 汎用デバウンス。最後の呼び出しからdelayms経っても次が来なければそこでfnを実行する
const MAP_COLOR_INPUT_DEBOUNCE_MS = 200;
function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; fn(...args); }, delay);
    };
}

// 空・陸の色の変更窓口。mapSettingsへ保存し（2D側にUIは無いが、設定自体は共通の
// mapSettingsに保持し続ける）、3D側の見た目・color inputの表示値を更新する
function setAssemblySkyColor(hex) {
    mapSettings.skyColor = hex;
    saveMapSettings();
    applyAssemblySkyColor(hex);
    if (assemblyRenderer && assemblyCamera) assemblyRenderer.render(assemblyScene, assemblyCamera);
    document.querySelectorAll(".map-sky-color-input").forEach(el => { el.value = hex; });
}

function setAssemblyGroundColor(hex) {
    mapSettings.groundColor = hex;
    saveMapSettings();
    applyAssemblyGroundColor(hex);
    if (assemblyRenderer && assemblyCamera) assemblyRenderer.render(assemblyScene, assemblyCamera);
    document.querySelectorAll(".map-ground-color-input").forEach(el => { el.value = hex; });
}

// 空・陸の色を初期値に戻す（「リセットボタンが欲しい」との依頼対応）
function resetAssemblyColors() {
    setAssemblySkyColor(MAP_SKY_COLOR_DEFAULT);
    setAssemblyGroundColor(MAP_GROUND_COLOR_DEFAULT);
}

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
    // 「3Dは2Dより暗い気がする」との指摘を受け、一度NoToneMappingに変更してみたが
    // 実測（キャンバスの平均輝度をWebGLから読み取って比較）するとACESFilmicToneMapping自体は
    // 明るさにほぼ影響しておらず、むしろ「余計暗くなった」というユーザーの体感の方が正しかった。
    // ACESFilmicToneMappingへ戻し、明るさに直接効くtoneMappingExposureを1.6まで上げてみたが、
    // 今度は「色が白飛びしてぼんやりする」との指摘（既に明るい部分＝パネル側面の白系素材や
    // 画像の明るい部分が先にクリップし、締まりが無くなる）。1.1（暗すぎ）と1.6（白飛び）の
    // 間を取り、控えめに1.2に設定。
    // その後「2Dと並べると3Dがくすんで見える、少し明るくすると2Dに近づきそう」との指摘で
    // 1.35へ再調整（実測ではexposureを上げるほど平均輝度は上がる一方、彩度はわずかに下がる
    // 傾向があったため、White Balanceの検証と同様に大きく振らず控えめな増分に留めた）
    assemblyRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    assemblyRenderer.toneMappingExposure = 1.35;

    assemblyScene = new THREE.Scene();

    // 空: カメラを中心に包む大きな球（内側から見る＝THREE.BackSide）に、頂点の高さで
    // 色を補間するグラデーションシェーダーをかける（three.js公式サンプルの空と同じ手法）。
    // 「見上げると中央後方に大きな黒丸が出る」不具合の原因は、この球がワールド原点に
    // 固定されていたこと——カメラがOrbitControlsの平行移動で原点から離れると、球の外に
    // 出てしまい（BackSideは内側からしか見えないため）その先の何も無い部分が
    // レンダラーの既定クリアカラー（黒）で見えてしまっていた。対策として、毎フレーム
    // 球の位置をカメラの現在位置に合わせる（startAssemblyRenderLoop参照）ことで、
    // カメラが常に球の中心＝内側に居続けるようにした
    const skyGeometry = new THREE.SphereGeometry(450, 32, 15);
    const skyMaterial = assemblyGradientSkyMaterial = new THREE.ShaderMaterial({
        uniforms: {
            topColor: { value: new THREE.Color(mapSettings.skyColor) },
            bottomColor: { value: new THREE.Color(mapSettings.skyColor).lerp(new THREE.Color(0xffffff), 0.75) },
            offset: { value: 20 },
            exponent: { value: 0.6 },
        },
        vertexShader: `
            varying vec3 vWorldPosition;
            void main() {
                vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                vWorldPosition = worldPosition.xyz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform vec3 topColor;
            uniform vec3 bottomColor;
            uniform float offset;
            uniform float exponent;
            varying vec3 vWorldPosition;
            void main() {
                float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
                gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
            }
        `,
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
    });
    assemblySkyMesh = new THREE.Mesh(skyGeometry, skyMaterial);
    assemblyScene.add(assemblySkyMesh);

    // 陸（地面）。3層（上位/中間/下位）の一番下より確実に低い位置に置く。
    // THREE.DoubleSideにしておくことで、万が一下から見上げても（表面が裏返っていても）
    // 面自体が消えて黒い穴に見えることがないようにする。transparent:trueにしておき、
    // カメラが地面より下に潜り込んだ時だけstartAssemblyRenderLoop()側でopacityを
    // 下げて透明にする（「地中に埋まったら地面を透明にして上を見上げられるように」）
    const groundGeometry = new THREE.PlaneGeometry(ASSEMBLY_GROUND_PLANE_SIZE, ASSEMBLY_GROUND_PLANE_SIZE);
    // alphaTestは池の「穴」を切り抜くためのalphaMap用（updateAssemblyGroundHoles参照）。
    // 穴が無い間はalphaMap未設定＝常にalpha=1なので影響しない
    const groundMaterial = new THREE.MeshStandardMaterial({ color: mapSettings.groundColor, roughness: 1, side: THREE.DoubleSide, transparent: true, opacity: 1, alphaTest: 0.5 });
    assemblyGroundMesh = new THREE.Mesh(groundGeometry, groundMaterial);
    assemblyGroundMesh.rotation.x = -Math.PI / 2;
    assemblyGroundMesh.position.y = ASSEMBLY_GROUND_Y;
    assemblyGroundMesh.receiveShadow = true;
    assemblyScene.add(assemblyGroundMesh);

    // 3Dシーンの初回構築時点で既にUNDERTALEテーマが選ばれていた場合に備え、
    // 空・陸をここで一度テーマに応じた見た目へ揃えておく
    applyAssemblyThemeVisuals();

    assemblyCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    assemblyCamera.position.set(12, 12, 12); // 内容に応じてframeAssemblyCamera()が上書きする
    // 雲のメッシュはASSEMBLY_CLOUD_LAYERにだけ乗せ、assemblySunの影から除外する（下記）ため、
    // メインカメラ側では通常のlayer0に加えてこのlayerも見えるようにしておく必要がある
    assemblyCamera.layers.enable(ASSEMBLY_CLOUD_LAYER);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f98, 0.9);
    assemblyScene.add(hemi);
    assemblySun = new THREE.DirectionalLight(0xffffff, 1.4);
    // 実際の位置（南側から斜めに当たるように）はnorthDirection（コンパスの向き）に応じて
    // rebuildAssemblyMeshes()のたびにupdateAssemblySunPosition()で設定し直す。ここでは
    // シーン初期化時点でまだnorthDirection等が読めるので、初期値としても一度呼んでおく
    assemblySun.castShadow = true;
    // 「雲の影がぼんやりしている」との指摘への対応でshadow.cameraの可視範囲に雲の表示範囲
    // （assemblyCloudRange、ASSEMBLY_GROUND_BLOCK_MARGIN=300ぶんまで広がる）を含めたところ、
    // 今度は「レール/トロッコ/キャラクター/音符マットの影が薄れた」との指摘が新たに出た。
    // 解像度4096でも715ユニット幅（実測）を覆うとテクセル1個あたり約0.175ユニットになり、
    // 1マス(ASSEMBLY_CELL_SIZE=1)より細かいレールの横木やキャラクターの脚等はまともな
    // 解像度で影が出ない。雲は元々ぼんやりした大きな影で精度が要らない一方、レール等は
    // シャープさが要るため、両者を同じシャドウマップに収めようとする設計自体が無理があった。
    // → 雲専用の第2ライト（assemblyCloudSun）を用意し、THREE.Layersで影の描画対象を
    // 分離する: assemblySun（このライト）の影はlayer0（既定＝雲以外の全て）だけを見るように
    // 明示し、狭い実内容ぶんの範囲に絞ってテクセル密度を確保する（frustumはrebuildAssembly
    // Meshes側で内容の実際の広さだけから計算し直す）。雲の影はassemblyCloudSun側で別途、
    // 広いが粗い解像度のまま担当させる（雲の影はぼやけていても元々目立たない）
    assemblySun.shadow.camera.layers.set(0);
    assemblySun.shadow.mapSize.set(4096, 4096);
    // shadow.cameraの見える範囲（デフォルトは左右上下±5の狭い正方形）は、内容の実際の
    // 広がりに応じてrebuildAssemblyMeshes()側で毎回サイズを合わせ直す（この初期値のままだと、
    // 曲が長い/マス数が多いと大半の音符マット・レールが範囲外になり影が出ない、または
    // 範囲の境界付近で影が不自然に切れる原因になる）
    assemblyScene.add(assemblySun);
    assemblyScene.add(assemblySun.target);

    assemblyCloudSun = new THREE.DirectionalLight(0xffffff, 1.4);
    assemblyCloudSun.castShadow = true;
    // 雲の影は広範囲・低精度で構わないため、mapSizeはassemblySunより低くしてよい
    // （テクセル密度が粗くても、元々ぼんやり大きい雲の影では目立たない）
    assemblyCloudSun.shadow.mapSize.set(2048, 2048);
    assemblyCloudSun.shadow.camera.layers.set(ASSEMBLY_CLOUD_LAYER); // 雲だけをこのライトの影に描く
    assemblyScene.add(assemblyCloudSun);
    assemblyScene.add(assemblyCloudSun.target);
    updateAssemblySunPosition();

    // 【2026-09のコードレビューで検討し、あえて手を付けないことにした設計上の課題】
    // スクリプト制御（チェイス視点/遠隔視点の自動回転等）もOrbitControls任せにしている
    // ため、target追従の補正（followAssemblyCameraTarget付近）・minDistance/maxDistance
    // クランプ・damping一時無効化トリック（frameAssemblyCameraToFit付近）など、OrbitControls
    // の内部挙動に起因する「カクっ」系の不具合を5回以上個別に回避してきた経緯がある。
    // 「OrbitControls任せをやめてcamera.position/lookAtを直接制御する」方向への刷新も
    // 検討したが、現状は上記の回避策が効いて安定動作しており、作り直しは過去に直した
    // バグ群の再発リスクが最も高い変更になるため、今回は見送った（ユーザーと相談の上での判断）。
    // 触る場合は、チェイス視点/遠隔視点それぞれの「開始時スナップ」「毎フレーム追従」
    // 「モード切替時」「ドラッグ→解放」「minDistance復帰」の全パターンをPlaywrightで
    // 前後比較してから進めること
    assemblyControls = new OrbitControls(assemblyCamera, assemblyRenderer.domElement);
    assemblyControls.enableDamping = true;
    assemblyControls.dampingFactor = 0.08;
    assemblyControls.zoomToCursor = true; // マウス（タッチ）位置を中心にズームする
    assemblyControls.zoomSpeed = 2.0; // 「マウスロールでもうちょっと拡大したい」との依頼で既定値1.0から引き上げ
    // 「右クリックのドラッグで回転、左クリックのドラッグで移動にしてほしい（今の逆）」との
    // 依頼で、既定のOrbitControls配置（左=回転/右=平行移動）から入れ替えた。OrbitControls
    // 標準の挙動として、割り当てた操作がどちらのボタンでもShift/Ctrl/Metaを押しながらだと
    // 回転⇔平行移動が反転する（こちらで手動切り替えする必要はない）
    assemblyControls.enablePan = true;
    assemblyControls.panSpeed = 2.2; // 「ドラッグの移動速度を上げてほしい」との依頼で既定値1.0から引き上げ
    assemblyControls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    assemblyControls.minDistance = 3;
    assemblyControls.maxDistance = 200; // frameAssemblyCamera()で曲ごとに調整
    assemblyControls.autoRotateSpeed = ASSEMBLY_ROTATE_SPEED; // 既定値2.0より遅く、「ゆっくり」回転させる（左回り/右回りボタン）
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // 「3Dエリアをクリックすると再生、もう一度クリックすると一時停止」との依頼。
    // OrbitControlsのドラッグ操作（回転/平行移動/ズーム）と区別するため、単純な"click"
    // イベントは使わず、pointerdown→pointerupの移動距離が小さい場合だけ「クリック」とみなす
    // （ブラウザのclickイベントは、同じ要素上で発生した多少のドラッグ後でも発火してしまう
    // ため、ドラッグでカメラを回すたびに誤って再生/一時停止が切り替わってしまう）
    let assemblyClickStartPos = null;
    canvas.addEventListener("pointerdown", (e) => {
        assemblyClickStartPos = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener("pointerup", (e) => {
        if (!assemblyClickStartPos) return;
        const dx = e.clientX - assemblyClickStartPos.x, dy = e.clientY - assemblyClickStartPos.y;
        assemblyClickStartPos = null;
        if (Math.hypot(dx, dy) > 5) return; // ドラッグ操作とみなし、再生トグルはしない
        if (playState === "stopped") {
            playScore();
        } else if (playState === "playing") {
            pauseScore();
        } else if (playState === "paused") {
            resumeScore();
        }
    });

    // 使い回す共有ジオメトリ・マテリアル（2Dマップの色使いに合わせる: レール=ダークグレー、
    // センサー=黒。音符マットの上面だけピッチごとの写真テクスチャを貼り、側面は
    // 「つやありの黒に」との指定でroughnessを低く・metalnessを持たせた黒に変更済み）
    assemblyUnitBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
    assemblyRailMaterial = new THREE.MeshStandardMaterial({ color: 0x585858, roughness: 0.65, metalness: 0.35 });
    // レール中央の横木（左右のレール本体の間に一定間隔で架かる、梯子の"段"に相当）用。
    // 2Dマップの中央帯（drawMapRailLine、#999）と同系色（rebuildAssemblyMeshes参照）
    assemblyRailRungMaterial = new THREE.MeshStandardMaterial({ color: 0x999999, roughness: 0.6, metalness: 0.25 });
    assemblySensorMaterial = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5, metalness: 0.1 });
    // センサーの反応方向をデバッグ表示する薄い赤の光線。実在の物体ではなく見た目の目印
    // なので、光の当たり方に左右されない自己発光（MeshBasicMaterial）にし、半透明で
    // 「うっすら」感を出す。影は落とさない/受けない
    assemblySensorDirectionMaterial = new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 0.35, depthWrite: false });
    // 「音符マットの側面はつやありの黒に」との依頼（従来は0xefefefのマット白系）。
    // roughnessを低めにして光沢感を、metalnessも少し持たせてハイライトが締まって
    // 見えるようにした（全面鏡面にすると不自然なため、金属100%は避けた）
    assemblyPanelSideMaterial = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.15, metalness: 0.4 });
    // 音符マットの黒ぶち。単位立方体（assemblyUnitBoxGeometry）の辺だけを取り出したジオメトリを
    // 1つ共有し、各マットの実際のサイズ・位置・回転はLineSegments2側のscale/position/quaternionで
    // 個別に与える（InstancedMeshは三角形描画専用でLineSegmentsには使えないため、マット枚数ぶん
    // 個別のLineSegments2を作る。ジオメトリ/マテリアル自体は共有なので生成コストは小さい）。
    // 通常のTHREE.LineBasicMaterial+LineSegmentsだとlinewidthがほぼ全ブラウザ（特にWindows Chrome）
    // で無視され常に1px固定になってしまうWebGL自体の既知の制約があり、「もう少し細く」という
    // 調整ができなかったため、実際にピクセル単位で太さを制御できるLineSegments2（fat lines、
    // three/addons/lines/）に置き換えている
    const edgesPositions = new THREE.EdgesGeometry(assemblyUnitBoxGeometry).attributes.position.array;
    assemblyPanelEdgesGeometry = new LineSegmentsGeometry();
    assemblyPanelEdgesGeometry.setPositions(edgesPositions);
    // linewidthの単位はpx（resolutionは要設定、resizeAssemblyRenderer参照）。
    // 「ふちの太さを気持ち細く」との依頼で、素の1pxから0.75pxへ少し細くしている
    assemblyPanelEdgesMaterial = new LineMaterial({ color: 0x000000, linewidth: 0.75 });
    // fat lines（LineSegments2）は線の太さをシェーダー側の矩形展開で作るため、細い線ほど
    // 縁がギザギザ（ジャギー）に見えやすい。alphaToCoverageを有効にすると、レンダラーの
    // MSAA（antialias:true、下のWebGLRenderer生成時に設定済み）を線の縁のカバレッジ計算にも
    // 使うようになり、輪郭が滑らかになる（three.jsのfat lines公式サンプルでも推奨されている設定）
    assemblyPanelEdgesMaterial.alphaToCoverage = true;
    assemblyPanelEdgesMaterial.resolution.set(canvas.clientWidth || 1, canvas.clientHeight || 1);

    // 再生中のトロッコ位置マーカー。トロッコ本体（プリミティブ組み立て）をぶら下げる
    // 空のGroupを先に作る（rebuildAssemblyMeshes()では破棄されず使い回すので、ここで
    // 1回だけ作る。updateAssemblyPlayMarker参照）
    assemblyPlayMarker = new THREE.Group();
    assemblyPlayMarker.visible = false;
    assemblyScene.add(assemblyPlayMarker);

    loadAssemblyTrolleyBodyModel();
    initAssemblyClouds();

    assemblySceneReady = true;
}

// コンパスの向き（northDirection、2Dマップの「N↑/N→/N↓/N←」ラベルと同じ意味）に応じた
// 「南」方向の単位ベクトル（ワールド座標のx,z成分）。2Dマップのコンパスラベルは
// 画面上の向き（up/right/down/left）を表すだけで実際のグリッド配置自体は回転しないため、
// 「北がどちらか」の対応もその画面方向のまま据え置く。toWorld()はgx→world x、
// gy→world zへそのまま対応させているため、画面の上（gyが小さい方向）は
// world zが小さい方向になる
// northDirection=0(N↑=北は画面上): 北=-z → 南=+z
// northDirection=1(N→=北は画面右): 北=+x → 南=-x
// northDirection=2(N↓=北は画面下): 北=+z → 南=-z
// northDirection=3(N←=北は画面左): 北=-x → 南=+x
const ASSEMBLY_SOUTH_VECTOR_BY_NORTH_DIRECTION = [
    { x: 0, z: 1 },
    { x: -1, z: 0 },
    { x: 0, z: -1 },
    { x: 1, z: 0 },
];

// 「南側から斜めに光が当たる」ようにassemblySunの位置を設定する。northDirection
// （コンパスの向き）が変わっても常に南から当たり続けるよう、rebuildAssemblyMeshes()の
// たびに呼び直す（「斜めでいいから南側から光を当ててほしい」との依頼）
function updateAssemblySunPosition() {
    if (!assemblySun) return;
    const south = ASSEMBLY_SOUTH_VECTOR_BY_NORTH_DIRECTION[northDirection] || ASSEMBLY_SOUTH_VECTOR_BY_NORTH_DIRECTION[0];
    // 雲を「空に配置」した結果、雲の高さ(y=65〜85)が元の太陽の高さ(18)を超えてしまい、
    // 太陽から見て逆側（影用のshadow.cameraの視錐台の外）になって雲の影が落ちなくなって
    // いた。太陽の高さを雲より確実に高い位置まで引き上げる必要があるが、単純に高さだけ
    // 変えると光の入射角（陰影の向き・長さ）が変わってしまうため、水平距離も同じ比率で
    // 拡大し、角度（atan(HEIGHT/HORIZONTAL_DISTANCE)）は元の値（18/13）のまま保つ
    const HEIGHT = 110;
    const HORIZONTAL_DISTANCE = 13 * (HEIGHT / 18); // 元の角度を保つための比例拡大
    assemblySun.position.set(south.x * HORIZONTAL_DISTANCE, HEIGHT, south.z * HORIZONTAL_DISTANCE);
    // 雲専用ライトも同じ向き・高さから当てる（陰影の向きを本物の太陽と一致させる）
    if (assemblyCloudSun) {
        assemblyCloudSun.position.copy(assemblySun.position);
    }
}

// ピッチごとのテクスチャ+マテリアル（BoxGeometryの6面ぶん）を遅延生成する。
// 既にloadMapPanelImages()がプリロード中のHTMLImageElement（MAP_PANEL_IMAGES）を
// そのまま流用し、二重に画像を取得しない
function getAssemblyPanelMaterials(pitch) {
    const canon = toCanonicalPitch(pitch);
    if (MAP_PANEL_MATERIALS[canon]) return MAP_PANEL_MATERIALS[canon];

    // 生画像ではなく、色味を濃く（彩度アップ）した焼き込み済みキャッシュを使う
    // （getMapPanelVividImage参照。「3Dの音符マットをもう少し色味を濃くしたい」との依頼）
    const img = getMapPanelImage(canon);
    const vividImg = getMapPanelVividImage(canon);
    const tex = new THREE.Texture(vividImg || undefined);
    tex.colorSpace = THREE.SRGBColorSpace;
    if (vividImg) {
        tex.needsUpdate = true;
    } else if (img) {
        // 既存のimg.onload（2DマップのscheduleMapPanelRedraw）を上書きしないよう、
        // addEventListenerで別リスナーとして追加するだけにする
        img.addEventListener("load", () => {
            tex.image = getMapPanelVividImage(canon);
            tex.needsUpdate = true;
        }, { once: true });
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

// トロッコ本体（荷台+車輪+取っ手）。当初ユーザー用意のmodels/trolley.glb（28MB）をGLTFLoaderで
// 読み込んでいたが、「trolley.glbを使わずに同じような見た目に」との依頼でプリミティブ組み立てへ
// 置き換えた（丸みのあるカプセル形状）。さらに「キャラクターは不要」「丸みではなく角ばっている
// 元のものに近いのがいい」「もう少し大きいサイズで」「色は茶色ベースで」との依頼で、トロッコに
// 乗せるキャラクター（models/char.glb）を廃止し、本体もBoxGeometryを使った角ばった木箱ふうの
// 荷台+車輪4つ+取っ手という構成に作り直した（配色は焦げ茶の荷台+黒に近い濃い焦げ茶の車輪/取っ手）。
// GLTFLoaderは使わない同期関数（2Dアイコン生成用のbuildAssemblyTrolleyIcon2DSnapshot()と、
// 3D本体表示の両方からこのプリミティブ形状を使う）
function buildProceduralTrolleyMesh() {
    const group = new THREE.Group();

    // 荷台（角ばった木箱ふうのBox、焦げ茶）。「トロッコの幅を少し広げてほしい」との
    // 依頼でX（左右幅）を0.62→0.72に拡張した（Z＝進行方向の長さは1マスにちょうど収まる
    // よう既に調整済みのため変更していない。getAssemblyTrolleyFootprintScale()は
    // X/Zの大きい方＝Z基準のままなので、この変更で長さ側の見た目は変わらない）
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x6b4423, roughness: 0.75, metalness: 0.05 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.42, 0.78), bodyMat);
    body.position.y = 0.34;
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // 上部の縁（濃い焦げ茶、本体よりひとまわり大きい薄い板を上面に重ねてツートンに見せる）
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x3e2a17, roughness: 0.8, metalness: 0.05 });
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.08, 0.84), rimMat);
    rim.position.y = 0.59;
    rim.castShadow = true;
    group.add(rim);

    // 車輪×4（濃い焦げ茶、角ばった荷台に合わせて角柱寄りの低ポリ円柱）。本体の拡幅に
    // 合わせてX位置も±0.29→±0.34へ広げ、荷台の縁の内側に収まる位置関係を保つ
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x2b1c10, roughness: 0.7, metalness: 0.1 });
    const wheelGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.07, 12);
    [[-0.34, 0.28], [0.34, 0.28], [-0.34, -0.28], [0.34, -0.28]].forEach(([x, z]) => {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.rotation.z = Math.PI / 2; // 円柱の軸を左右(X)方向へ倒す
        wheel.position.set(x, 0.15, z);
        wheel.castShadow = true;
        group.add(wheel);
    });

    // 取っ手（進行方向(+Z)側、垂直な角材の支柱+その上端で支柱と直角に交わる横棒でL字に見せる。
    // 横棒は乗っている人から見て左右(X軸)方向に伸びる向き）
    const handleMat = new THREE.MeshStandardMaterial({ color: 0x3e2a17, roughness: 0.75, metalness: 0.05 });
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.44, 0.06), handleMat);
    post.position.set(0, 0.68, 0.42);
    post.castShadow = true;
    group.add(post);
    // 横棒の幅も本体の拡幅に合わせて0.26→0.30に広げていたが、「持ち手をもう少し横に
    // 長く」との指示で0.42へ、さらに「もうちょっと長くていい」との指示で0.54へ広げた
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.06, 0.06), handleMat);
    grip.position.set(0, 0.9, 0.42);
    grip.castShadow = true;
    group.add(grip);

    return group;
}

// ============================================================
// 陸の装飾（木・草・花）。「実際のぽこあには木や草、花もある」との依頼で追加した、
// トロッコ・レール・音符マットの無い空きマスに散りばめる背景オブジェクト群。
// トロッコと同じ方針で、外部モデルではなくTHREE.jsの基本ジオメトリだけで組み立てる
// （ユーザー提供の実機参考写真は、白〜ピンクの丸い花弁×5〜9本＋根本の緑の葉、という
// トイ的にデフォルメされた見た目だったため、それを簡易ジオメトリで再現している）。
// 生成・配置はgenerateAssemblyDecorations()（rebuildAssemblyMeshes参照）が担当する
// ============================================================

// 花: 白〜ピンクのグラデーションで色を散らす（参考写真で1株の中に白〜濃いピンクが
// 混在していたことを再現）
const ASSEMBLY_FLOWER_PETAL_COLORS = [0xffffff, 0xffe1ec, 0xffc2dc, 0xff9dc4];

// 木・草・花はどれも固定の小さな色パレットしか使わないのに、パーツ（葉・花弁・実…）
// ごとに毎回new THREE.MeshStandardMaterial(...)していたため、実際には同じ色・同じ
// 見た目のマテリアルが個数分（500個の装飾×数十パーツ＝数千〜1万個超）重複生成されて
// いた。「重い」との指摘を受け、色が同じなら常に同じマテリアルインスタンスを再利用する
// キャッシュを導入（見た目は一切変えず、マテリアルの重複だけを無くす）
const assemblyDecorationMaterialCache = new Map();
function getSharedDecorationMaterial(key, factory) {
    if (!assemblyDecorationMaterialCache.has(key)) assemblyDecorationMaterialCache.set(key, factory());
    return assemblyDecorationMaterialCache.get(key);
}

// 1個の装飾（花・草・木）グループ内にある個別メッシュ（花なら葉+茎+花弁+中心で
// 100個超に及ぶ）を、同じマテリアルを使うものどうしで1つのBufferGeometryに合体させ、
// 1つのMeshにまとめる。「装飾が重い」との指摘の本質的な原因（500個×数十〜百個超の
// 個別メッシュ＝合計2万7千個超の描画呼び出し）に対応するための最適化で、各パーツの
// 位置・回転・見た目は一切変えず、描画回数だけを削減する（マテリアルはキャッシュ共有
// されているため、装飾1個あたり「使っているマテリアルの種類数」（花なら7種程度、
// 草なら3種、木なら3〜4種）まで描画回数が減る
function mergeAssemblyDecorationParts(group) {
    group.updateMatrixWorld(true); // グループ自体はこの時点では無変形（identity）のはずだが、
    // 入れ子のflowerHeadグループ等の位置・回転をワールド行列として確定させるために必要
    const buckets = new Map();
    const toRemove = [];
    group.traverse(o => {
        if (!o.isMesh) return;
        // このジオメトリは各パーツにつき`new THREE.XxxGeometry(...)`で毎回新規生成された
        // ものであり、他のメッシュと共有されていない（=このMesh専用）ため、clone()せず
        // 直接変形して構わない（clone()は内部のFloat32Array丸ごとコピーが発生し、
        // 装飾500個規模だと無視できないコストになっていた）
        o.geometry.applyMatrix4(o.matrixWorld);
        let bucket = buckets.get(o.material);
        if (!bucket) { bucket = { geometries: [], castShadow: false }; buckets.set(o.material, bucket); }
        bucket.geometries.push(o.geometry);
        if (o.castShadow) bucket.castShadow = true;
        toRemove.push(o);
    });
    // traverse中に木構造を変更するのは安全ではないため、走査完了後にまとめて取り除く
    // （ジオメトリは上のbucketにまだ入っているのでここでは破棄しない）
    for (const o of toRemove) {
        if (o.parent) o.parent.remove(o);
    }
    for (const [material, bucket] of buckets) {
        const merged = BufferGeometryUtils.mergeGeometries(bucket.geometries, false);
        bucket.geometries.forEach(g => g.dispose());
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = bucket.castShadow;
        group.add(mesh);
    }
}

function buildProceduralFlowerClusterMesh() {
    const group = new THREE.Group();

    // 根本の葉（円錐を平たく潰して葉っぱのシルエットにし、放射状に並べる。
    // 花より目立たないよう小さめ・低めに抑える）
    const leafMat = getSharedDecorationMaterial("flowerLeaf", () => new THREE.MeshStandardMaterial({ color: 0x2f7a3a, roughness: 0.8 }));
    const leafCount = 4;
    for (let i = 0; i < leafCount; i++) {
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 3), leafMat);
        leaf.scale.z = 0.35; // 潰して平たい葉の形にする
        const angle = (i / leafCount) * Math.PI * 2;
        leaf.position.set(Math.cos(angle) * 0.035, 0.045, Math.sin(angle) * 0.035);
        leaf.rotation.y = angle;
        leaf.rotation.x = Math.PI / 2 - 0.4; // 少し上向きに寝かせる
        leaf.castShadow = true;
        group.add(leaf);
    }

    // 花（茎+花弁+黄色い中心）を9〜13本、株の中心から放射状に生やす。
    // 「花はもっと正方形より」との指示のため、円形の放射状配置そのままだと株の輪郭が
    // 真円になってしまう点を補正する：角度に応じて中心からの伸び幅を対角方向
    // （45度・135度…）ほど伸ばす「スーパー楕円（squircle）」的な係数を掛け、
    // 輪郭を真円から角のある正方形寄りの丸みへ寄せる
    const stemMat = getSharedDecorationMaterial("flowerStem", () => new THREE.MeshStandardMaterial({ color: 0x3f8a4a, roughness: 0.8 }));
    const centerMat = getSharedDecorationMaterial("flowerCenter", () => new THREE.MeshStandardMaterial({ color: 0xffe066, roughness: 0.6 }));
    const flowerCount = 11 + Math.floor(Math.random() * 6);
    const FLOWER_SQUARE_LEAN_N = 4;
    const squareLeanFactor = (angle) => {
        const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
        return 1 / Math.pow(Math.pow(c, FLOWER_SQUARE_LEAN_N) + Math.pow(s, FLOWER_SQUARE_LEAN_N), 1 / FLOWER_SQUARE_LEAN_N);
    };
    for (let i = 0; i < flowerCount; i++) {
        const angle = (i / flowerCount) * Math.PI * 2 + Math.random() * 0.5;
        const lean_factor = squareLeanFactor(angle);
        const stemHeight = 0.14 + Math.random() * 0.08;
        const stemBaseR = Math.random() * 0.03 * lean_factor;
        const stemX = Math.cos(angle) * stemBaseR;
        const stemZ = Math.sin(angle) * stemBaseR;
        const lean = 0.15; // 外側へ少し傾ける角度

        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.006, stemHeight, 4), stemMat);
        stem.position.set(stemX, stemHeight / 2, stemZ);
        stem.rotation.z = Math.cos(angle) * lean;
        stem.rotation.x = -Math.sin(angle) * lean;
        group.add(stem);

        // 花弁は丸い小片（CircleGeometry）を5〜6枚、中心の周りに放射状に並べて
        // 1つの花にする（1枚板の五角形だと「板」に見えてしまうため、参考写真通り
        // 個々の丸い花弁が分かれて見えるようにする）
        const headX = stemX + Math.cos(angle) * 0.03 * lean_factor;
        const headY = stemHeight + 0.01;
        const headZ = stemZ + Math.sin(angle) * 0.03 * lean_factor;
        const flowerHead = new THREE.Group();
        flowerHead.position.set(headX, headY, headZ);
        // 「花が、角度によっては消えてしまいます」との指摘の原因判定: 花弁は平たい円盤
        // (CircleGeometry)で、1つのflowerHead内の花弁は全て同じ向き（法線方向）を共有する。
        // 元々はrotation.xのみ±0.25rad(約14度)という狭い範囲でしか傾きをばらつかせておらず、
        // かつrotation.z（円盤自身の法線を軸にした回転）は法線の向き自体を一切変えないため、
        // 1株（11〜16個のflowerHead）のほぼ全てがほぼ真上向きの法線で揃ってしまっていた。
        // 結果、真横に近い浅い角度から見ると、株全体の花弁がほぼ同時に真横（面積ゼロに近い
        // 縁）を向いてしまい「消えた」ように見えていた（Playwrightで実際に、特定の浅い仰角・
        // 近距離のカメラ配置で花弁色のピクセルが0になることを実測して確認済み）。
        // 対策として、傾きの最大角を約29度に広げ、さらにrotation.y（傾く方向そのもの）も
        // ランダム化して、株の中のflowerHeadごとに法線の向きがバラバラになるようにした
        // （どの角度から見ても、株の中の一部のflowerHeadは十分な面積を見せる）
        flowerHead.rotation.x = -Math.PI / 2 + (Math.random() - 0.5) * 1.0;
        flowerHead.rotation.y = Math.random() * Math.PI * 2;
        flowerHead.rotation.z = Math.random() * Math.PI * 2; // 花全体の向きをランダムにして単調にしない
        const petalCount = 5 + Math.floor(Math.random() * 2);
        const petalColorIndex = Math.floor(Math.random() * ASSEMBLY_FLOWER_PETAL_COLORS.length);
        const petalMat = getSharedDecorationMaterial(`flowerPetal${petalColorIndex}`, () =>
            new THREE.MeshStandardMaterial({ color: ASSEMBLY_FLOWER_PETAL_COLORS[petalColorIndex], roughness: 0.5, side: THREE.DoubleSide }));
        // 「草と花、もっとマスいっぱいにしていい」との指示で花弁を大きく・広めにした
        const petalReach = 0.034;
        const petalRadius = 0.027;
        for (let p = 0; p < petalCount; p++) {
            const petalAngle = (p / petalCount) * Math.PI * 2;
            const petal = new THREE.Mesh(new THREE.CircleGeometry(petalRadius, 8), petalMat);
            petal.position.set(Math.cos(petalAngle) * petalReach, Math.sin(petalAngle) * petalReach, 0);
            petal.rotation.z = petalAngle;
            petal.castShadow = true;
            flowerHead.add(petal);
        }
        group.add(flowerHead);

        const center = new THREE.Mesh(new THREE.SphereGeometry(0.012, 6, 6), centerMat);
        center.position.set(headX, headY + 0.003, headZ);
        group.add(center);
    }

    // 「装飾が重い」との指摘対応。1花クラスタあたり100個超あった個別メッシュ（葉・茎・
    // 花弁・中心）を、同じマテリアルどうしで合体させ数個のメッシュにまとめる
    mergeAssemblyDecorationParts(group);

    // 株の横方向の広がりを1マス(ASSEMBLY_CELL_SIZE=1)の正方形いっぱいになるよう正規化する
    // （getAssemblyTrolleyFootprintScale()と同じ「はみ出ない範囲で目一杯大きくする」考え方。
    // 高さ(Y)まで一緒に拡大すると茎が不自然に長く突き出てしまうため、X/Zのみ拡大する）。
    // 「マスの中で正方形にしてほしい」との指示のため、X/Zは同じ倍率ではなく個別に
    // ターゲットへ合わせる（元の株はX/Zの広がりが不揃いなため、共通倍率だとX/Zどちらかが
    // 1マスに届かず正方形にならない）
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const FLOWER_FOOTPRINT_TARGET = 1.0;
    if (size.x > 0 && size.z > 0) {
        group.scale.set(FLOWER_FOOTPRINT_TARGET / size.x, 1, FLOWER_FOOTPRINT_TARGET / size.z);
    }

    return group;
}

// 草むら: 参考写真（26588_0.jpg）を元に作り直した。以前は韮のように細く直立する葉を
// マス全体にばらつかせる方式だったが、参考写真は株の中心から幅広の葉が球状（あらゆる
// 方向）に密生する、ロゼット状（アロエ・多肉植物のような）1株のシルエットだった。
// 葉1枚1枚は円錐を扁平に潰して幅広の葉先にし、株の中心付近から真上〜真横〜やや下向き
// まで球状にあらゆる方向へ伸ばすことで、参考写真の丸くふっくらしたシルエットを作る。
// 色も参考写真の青緑がかったトーンに合わせた
function buildProceduralGrassTuftMesh() {
    const group = new THREE.Group();
    const greens = [0x3f8f82, 0x4a9e8e, 0x357a70];
    const bladeCount = 26 + Math.floor(Math.random() * 10);
    const CENTER_SPREAD = 0.04; // 根本は株の中心付近にまとめる（マス全体への分散はやめた）
    // phiは真上(0)からの角度。真下(π)近くまで許すと葉が地面に潜って見えるため、
    // 水平よりやや下（約100度）までに制限し、参考写真の丸いドーム状シルエットに寄せる
    const MAX_PHI = Math.PI * 0.56;
    for (let i = 0; i < bladeCount; i++) {
        const colorIndex = Math.floor(Math.random() * greens.length);
        const mat = getSharedDecorationMaterial(`grassBlade${colorIndex}`, () => new THREE.MeshStandardMaterial({ color: greens[colorIndex], roughness: 0.55 }));
        // 「細い針のようで、参考写真の幅広の葉に見えない」ため、太さを上げ・高さを
        // 少し抑えて幅/高さの比を大きくした（幅広の葉先らしいシルエットにする）
        const height = 0.2 + Math.random() * 0.13;
        const width = 0.1 + Math.random() * 0.03;
        const blade = new THREE.Mesh(new THREE.ConeGeometry(width, height, 4), mat);
        blade.scale.z = 0.32; // 潰して幅広の葉先形状にする

        const theta = Math.random() * Math.PI * 2;
        // cos(phi)を一様分布させることで、極（真上）付近に偏らせず立体角として均等に散らす
        const phi = Math.acos(1 - Math.random() * (1 - Math.cos(MAX_PHI)));
        const dir = new THREE.Vector3(
            Math.sin(phi) * Math.cos(theta),
            Math.cos(phi),
            Math.sin(phi) * Math.sin(theta)
        );
        const rootX = (Math.random() - 0.5) * CENTER_SPREAD;
        const rootZ = (Math.random() - 0.5) * CENTER_SPREAD;
        // 葉の根本（中心寄り）が株の中心に来るよう、ジオメトリ中心をdir方向へheight/2ぶん
        // ずらして配置する（葉の先端がdir方向へ伸びる）
        blade.position.set(rootX, 0, rootZ).addScaledVector(dir, height / 2);
        blade.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        blade.castShadow = true;
        group.add(blade);
    }

    // 「装飾が重い」との指摘対応。1株あたり数十枚あった個別メッシュ（葉）を、
    // 同じ色（マテリアル）どうしで合体させ最大3個のメッシュにまとめる
    mergeAssemblyDecorationParts(group);

    // 花と同様、1マス(ASSEMBLY_CELL_SIZE=1)の正方形いっぱいになるようX/Zを個別に正規化する
    // （「叢も同様」との指示）。高さ(Y)は据え置き
    const box = new THREE.Box3().setFromObject(group);
    const size = box.getSize(new THREE.Vector3());
    const GRASS_FOOTPRINT_TARGET = 1.0;
    if (size.x > 0 && size.z > 0) {
        group.scale.set(GRASS_FOOTPRINT_TARGET / size.x, 1, GRASS_FOOTPRINT_TARGET / size.z);
    }

    return group;
}

// 木は2種類: 広葉樹（丸いシルエット）・針葉樹（円錐のシルエット）。
// 経緯: 当初1種類の木で葉を「もりもり」に増量していったところ、クラスタの位置を
// 大きくランダムに散らしていたためシルエットが「いびつ」（丸くも円錐でもない不定形）に
// なってしまった。指摘を受け、(1) 広葉樹は葉の塊を中心付近にまとめて丸いシルエットに
// なるよう再設計し、(2) 針葉樹という円錐シルエットの新種を追加し、(3) 両方とも
// 背丈を控えめに戻した（もりもり化の過程で伸びすぎていたため）

// 広葉樹（丸い木）: 参考写真（26585_0.jpg）を元に作り直した。参考写真は樹冠が幹を
// 覆い隠すほど大きく、表面全体がこんもりした房で密に覆われ、根元は末広がりに張り出し、
// 赤〜黄の実に緑の葉が添えられていた。幹（円柱）+根本の張り出し+大きめの中心球+表面を
// 覆う多数の小さな塊、という構成は維持しつつ、房の密度・実の質感をその方向へ寄せた
function buildProceduralBroadleafTreeMesh() {
    const group = new THREE.Group();
    const trunkMat = getSharedDecorationMaterial("treeTrunk", () => new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 }));
    // 参考写真は樹冠に対して幹が短く見えたため、以前よりやや短くした
    const trunkHeight = 0.85 + Math.random() * 0.25;
    // 「木の幹は1マス分いっぱいにしてください」との指示で、根元の半径がASSEMBLY_CELL_SIZE
    // （1マス=1）の半分＝0.5（直径1マスぶん）になるよう太くした
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.5, trunkHeight, 6), trunkMat);
    trunk.position.y = trunkHeight / 2;
    trunk.castShadow = true;
    group.add(trunk);
    // 根本の張り出し（参考写真の、幹の根元が末広がりに太くなっている見た目）
    const rootFlare = new THREE.Mesh(new THREE.ConeGeometry(0.56, 0.16, 6), trunkMat);
    rootFlare.position.y = 0.08;
    rootFlare.castShadow = true;
    group.add(rootFlare);

    const foliageColors = [0x4f9a4a, 0x5aa855, 0x458a41];
    const foliageColorIndex = Math.floor(Math.random() * foliageColors.length);
    const foliageMat = getSharedDecorationMaterial(`broadleafFoliage${foliageColorIndex}`, () =>
        new THREE.MeshStandardMaterial({ color: foliageColors[foliageColorIndex], roughness: 0.85 }));
    // 葉（樹冠）のサイズだけを拡大する（幹の太さ・高さは対象外なので触れない）。
    // 「10倍にしてほしい」→「10倍は言い過ぎました2倍で」と訂正が入り、2倍に調整済み
    const FOLIAGE_SCALE = 2;
    const mainR = (0.62 + Math.random() * 0.2) * FOLIAGE_SCALE;
    const canopyCenterY = trunkHeight + mainR * 0.85;
    // 中心となる大きめの球（detail=1でカクカクしすぎない丸みにする）がシルエットの主体
    const mainFoliage = new THREE.Mesh(new THREE.IcosahedronGeometry(mainR, 1), foliageMat);
    mainFoliage.position.set(0, canopyCenterY, 0);
    mainFoliage.castShadow = true;
    group.add(mainFoliage);
    // 表面に小さな塊を数多くくっつけて質感を出す（中心からの距離を主球の半径未満に抑え、
    // 全体シルエットが丸のまま保たれるようにする＝いびつ化の再発防止）。参考写真の
    // 「表面全体がこんもりした房で覆われている」密度に寄せるため、個数を増やし1個ずつは
    // 少し小さくした
    const bumpCount = 8 + Math.floor(Math.random() * 4);
    for (let i = 0; i < bumpCount; i++) {
        const bumpR = mainR * (0.3 + Math.random() * 0.2);
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 1.6 - 0.8); // 下半分に寄りすぎないよう範囲を絞る
        const dist = mainR * 0.75;
        const bump = new THREE.Mesh(new THREE.IcosahedronGeometry(bumpR, 0), foliageMat);
        bump.position.set(
            dist * Math.sin(phi) * Math.cos(theta),
            canopyCenterY + dist * Math.cos(phi) * 0.7,
            dist * Math.sin(phi) * Math.sin(theta)
        );
        bump.castShadow = true;
        group.add(bump);
    }

    // リンゴのような実を樹冠の表面に散らす（「広葉樹にはリンゴのような木の実をつけます」
    // →「実の大きさはもっと大きくていい（ひとつの木につき4つ）」との指示は維持）。
    // 参考写真同様、実の上部に小さな緑の葉を1枚添え、色も赤〜橙寄りに調整した
    const appleMat = getSharedDecorationMaterial("apple", () => new THREE.MeshStandardMaterial({ color: 0xd94a2b, roughness: 0.4 }));
    const appleLeafMat = getSharedDecorationMaterial("appleLeaf", () => new THREE.MeshStandardMaterial({ color: 0x3f8a4a, roughness: 0.7 }));
    const appleCount = 4;
    for (let i = 0; i < appleCount; i++) {
        const appleR = mainR * 0.17;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(Math.random() * 1.7 - 0.85);
        const dist = mainR * 0.95; // 樹冠の表面付近にぶら下がるように少し外側
        const ax = dist * Math.sin(phi) * Math.cos(theta);
        const ay = canopyCenterY + dist * Math.cos(phi) * 0.7;
        const az = dist * Math.sin(phi) * Math.sin(theta);
        const apple = new THREE.Mesh(new THREE.SphereGeometry(appleR, 8, 8), appleMat);
        apple.position.set(ax, ay, az);
        apple.castShadow = true;
        group.add(apple);
        // 葉は実から樹冠の外側（実自身の中心からの方向）へ向けて生やす。rotation.x/yの
        // 組み合わせでは向きが安定せず、真正面から見ると平べったい三角形が目立って
        // しまっていたため、外向きベクトルにquaternionで正確に揃える方式にした
        const outward = new THREE.Vector3(ax, ay - canopyCenterY, az).normalize();
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(appleR * 0.4, appleR * 0.9, 3), appleLeafMat);
        leaf.scale.z = 0.3;
        leaf.position.set(ax, ay, az).addScaledVector(outward, appleR * 0.6);
        leaf.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), outward);
        group.add(leaf);
    }

    // 「装飾が重い」との指摘対応。幹・根本張り出し・樹冠(main+bump)・実・実の葉で
    // 個別だったメッシュを同じマテリアルどうしで合体させる（最大5メッシュにまとめる）
    mergeAssemblyDecorationParts(group);
    return group;
}

// 針葉樹（三角形の木）: 参考写真（26584_0.jpg）を元に作り直した。参考写真は1枚の
// 滑らかな円錐ではなく、段ごとに小さな枝葉の房が輪になって重なり、外側へ垂れ下がる
// 「うろこ状」のシルエットだった。段の数を増やし（4→7）、各段を1つの円錐ではなく
// 段の外周に並べた複数の小さな塊（房）で構成することで、その質感に近づけた
function buildProceduralConiferTreeMesh() {
    const group = new THREE.Group();
    const trunkMat = getSharedDecorationMaterial("treeTrunk", () => new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.9 }));
    const trunkHeight = 0.55 + Math.random() * 0.15;
    // 「木の幹は1マス分いっぱいにしてください」との指示で、根元の半径が0.5（直径1マスぶん）
    // になるよう太くした
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.375, 0.5, trunkHeight, 6), trunkMat);
    trunk.position.y = trunkHeight / 2;
    trunk.castShadow = true;
    group.add(trunk);

    const foliageColors = [0x3d7a3f, 0x2f6a38, 0x4a8a4a];
    const foliageColorIndex = Math.floor(Math.random() * foliageColors.length);
    const foliageMat = getSharedDecorationMaterial(`coniferFoliage${foliageColorIndex}`, () =>
        new THREE.MeshStandardMaterial({ color: foliageColors[foliageColorIndex], roughness: 0.85 }));
    // 葉（房）のサイズを拡大する。「10倍にしてほしい」→「10倍は言い過ぎました2倍で」と
    // 訂正が入り、2倍に調整済み
    const FOLIAGE_SCALE = 2;
    const baseRadius = (0.62 + Math.random() * 0.18) * FOLIAGE_SCALE;
    const segmentCount = 7;
    let currentY = trunkHeight;
    for (let i = 0; i < segmentCount; i++) {
        const frac = i / segmentCount;
        const segRadius = baseRadius * (1 - frac * 0.78);
        const segHeight = (0.55 - frac * 0.08) * FOLIAGE_SCALE;
        const tierY = currentY + segHeight * 0.4;
        // 房を段の外周に均等に並べる。頂点の段（最後）だけは1つの房にまとめ、
        // 中心（ringR=0）に置いて尖った頂点にする
        const isTip = i === segmentCount - 1;
        const lobeCount = isTip ? 1 : 6;
        const ringR = isTip ? 0 : segRadius * 0.7;
        for (let l = 0; l < lobeCount; l++) {
            // 段ごとに開始角をずらし、真上から見て房の継ぎ目が段を通して一直線に
            // 揃わないようにする（参考写真のような不規則な重なりに近づける）
            const angle = (l / lobeCount) * Math.PI * 2 + frac * 2.4;
            const lobeR = isTip ? segRadius * 0.55 : segRadius * (0.42 + Math.random() * 0.1);
            const lobe = new THREE.Mesh(new THREE.IcosahedronGeometry(lobeR, 0), foliageMat);
            lobe.position.set(Math.cos(angle) * ringR, tierY - lobeR * 0.3, Math.sin(angle) * ringR);
            lobe.scale.y = 0.72; // 房を少し潰し、外側へ垂れ下がった葉房らしくする
            lobe.castShadow = true;
            group.add(lobe);
        }
        currentY += segHeight * 0.5; // 段同士を重ねて隙間ができないようにする
    }

    // 「三角の木に木の実は不要」との指摘で、水色のイチゴのような実の装飾は撤去した
    // （広葉樹の赤い実とは別に付けていたが、針葉樹には無い方が参考写真に近い）

    // 「装飾が重い」との指摘対応。幹・葉（7段の房）で個別だったメッシュを
    // 同じマテリアルどうしで合体させる
    mergeAssemblyDecorationParts(group);
    return group;
}

// ============================================================
// 空に浮かぶ雲。「こういった雲を設置して、時間で平行に流れていく。影が地面に移る」
// との依頼で追加。個々の雲の生成・消滅サイクル自体はトラック・マップ設定と無関係
// （トロッコ演奏の内容によらず常に同じように空を流れる）なため、木・草・花のように
// rebuildAssemblyMeshes()のたびに作り直すことはしない。
// ただし「一列の最大レール数を100とかにすると、雲の流れるエリアが偏ってしまいます。
// 現在の小節の数などに合わせて動的に広げることは可能ですか？」との指摘の通り、雲が
// 流れる範囲（assemblyCloudRange）は元々トラックの規模と無関係な固定値だったため、
// 大きなトラックだと雲がトラックの一部分にしか流れず偏って見えていた。トラックの
// footprint（frameAssemblyCamera()と同じ考え方）に応じて範囲を動的に広げるよう、
// 固定constから可変letへ変更し、rebuildAssemblyMeshes()のたびにupdateAssemblyCloudRange()
// で更新するようにした。「リロードが入るので、再描画でよい」との指示のため、範囲が
// 実際に変わった時は既存の雲を流れ切るまで待たず、resetAssemblyClouds()でその場で
// 全て破棄して新しい範囲で撒き直す（雲の生成・消滅サイクル自体＝tickAssemblyClouds()の
// 挙動は変更していない）
// 「雲をマップ全体に表示されるようにしてほしい」との依頼で、雲が流れる範囲を
// トラックのfootprintに毛の生えた程度（footprint*0.9）から、地面ブロック・装飾が
// 実際に広がる範囲（ASSEMBLY_GROUND_BLOCK_MARGIN分の余白まで）に合わせて大きく広げた。
// 範囲（面積）が大きく広がる分、密度が薄くなりすぎないよう個数も増やした
// （30→100→10000（生成に約30秒）→1000（約15〜17秒、見た目も曇り空のように過密）→300→200
// と調整）
// 雲のメッシュだけをのせるTHREE.Layers番号。assemblySun（レール/トロッコ/キャラクター/
// 音符マット等、狭く高精度な影が必要な光源）の影から雲を除外し、assemblyCloudSun（広く
// 粗い解像度でよい雲専用の影）側にだけ雲を描かせるための分離に使う
const ASSEMBLY_CLOUD_LAYER = 1;
const ASSEMBLY_CLOUD_COUNT = 200;
const ASSEMBLY_CLOUD_DRIFT_SPEED = 1.2; // ワールド単位/秒（「雲の速度はもう少し早くていい」との指示で0.5から引き上げ）
const ASSEMBLY_CLOUD_RANGE_DEFAULT = 70; // 小さなトラックでの下限（従来の固定値）
let assemblyCloudRange = ASSEMBLY_CLOUD_RANGE_DEFAULT; // 雲が流れる範囲の半径。これを超えたら消える
let assemblyClouds = [];

// トラックのfootprintに応じてassemblyCloudRangeを更新する。frameAssemblyCamera()と
// 同じfootprintの考え方（グリッドの縦横のうち大きい方）を使うことで、カメラが引いて
// トラック全体を見渡す規模に対して雲の流れる範囲も一緒に広がるようにする。
// 「リロードが入るので、再描画でよい」との指示のため、範囲が実際に変わった時は
// 既存の雲が流れ切るのを待たず、その場で全て破棄して新しい範囲で撒き直す
// （トラックの規模が変わる操作では他の要素（レール・音符マット・装飾等）もどのみち
// 即座に作り直されるため、雲だけ滑らかに移行させる必要は無いという判断）
function updateAssemblyCloudRange(extent) {
    const gridW = (extent.maxX - extent.minX + 1) * ASSEMBLY_CELL_SIZE;
    const gridH = (extent.maxY - extent.minY + 1) * ASSEMBLY_CELL_SIZE;
    const footprint = Math.max(gridW, gridH, 4);
    // 地面ブロック・装飾が実際に広がる範囲（footprint/2 + マージン）まで雲の範囲を広げ、
    // 「マップ全体」に雲が見えるようにする（以前のfootprint*0.9だと、トラックの近くだけに
    // 雲が集まり、その外側の広い地面ブロック・装飾エリアには一切流れて来なかった）
    const newRange = Math.max(ASSEMBLY_CLOUD_RANGE_DEFAULT, footprint * 0.9, footprint / 2 + ASSEMBLY_GROUND_BLOCK_MARGIN);
    if (Math.abs(newRange - assemblyCloudRange) > 0.01) {
        assemblyCloudRange = newRange;
        resetAssemblyClouds();
    }
}

// 「雲ってそんな縦長いものばかりではない」「雲は3Dでなくても、平面でいい」との指摘で
// 再設計。3Dの塊を横一列に並べる方式は、どの雲も同じような細長い形になりがちで、かつ
// 立体的すぎた。丸い平面（CircleGeometry、地面と水平に寝かせる）を中心から2Dクラスタ状に
// ランダムな角度・距離でばら撒く方式に変え、(1) 完全に平ら（3Dの厚みが無い）にしつつ、
// (2) 雲ごとに丸く固まったものから横に広がったものまで、形にばらつきが出るようにした
function buildProceduralCloudMesh() {
    const group = new THREE.Group();
    // 「雲はもっと白い」との指示でクリーム掛かった色から純白に近い色へ変更。
    // 「下から見上げたら黒い」との指摘のため、光源の向きで陰影が付くMeshStandardMaterial
    // ではなく、常に同じ色で見えるMeshBasicMaterial（陰影計算をしない）に変更した——
    // 平らな板（厚み0）は太陽光が真上からしか当たらないため、下向きの面は必然的に
    // 直射光を受けられず暗く沈んでしまう（アンビエント光頼みで黒に近くなる）。
    // フェードイン用にtransparent:trueにし、初期opacityは0（spawnAssemblyCloud側で
    // 毎フレーム引き上げる）にしておく
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0 });
    group.userData.cloudMaterial = cloudMat; // tickAssemblyCloudsからフェード制御するための参照
    const lumpCount = 5 + Math.floor(Math.random() * 4); // 5〜8枚の円盤を散らす
    for (let i = 0; i < lumpCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * 1.0; // 中心からの距離をランダムにし、丸みも横広がりも出るようにする
        const r = 0.6 + Math.random() * 0.5;
        const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 10), cloudMat);
        disc.rotation.x = -Math.PI / 2; // 地面と水平に寝かせる（平面の雲）
        disc.position.set(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
        // assemblySunの影から除外し、assemblyCloudSun側にだけ影を描かせるための分離
        // （ASSEMBLY_CLOUD_LAYER参照）。メインカメラはlayer0に加えてこのlayerも
        // 有効化済み（initAssemblyScene）なので、通常の見た目には影響しない
        disc.layers.set(ASSEMBLY_CLOUD_LAYER);
        // 影はここではまだ有効にしない（castShadowはopacityを見ないため、フェード中の
        // 半透明な雲がいきなり真っ黒な影を落とし、境目が不自然に見えてしまう。
        // フェードが完了した時にtickAssemblyCloudsからまとめて有効化する）
        disc.castShadow = false;
        group.add(disc);
    }
    return group;
}

// 新規生成時、範囲の境界ぴったりではなくさらに外側から生やす（「もう少し離れた距離から
// 生成してください」との指示）。フェードインが目に入る前に済ませやすくする狙いもある
const ASSEMBLY_CLOUD_SPAWN_MARGIN = 35;
// フェードインに掛ける時間（秒）。「急に出現すると変」との指摘で追加
const ASSEMBLY_CLOUD_FADE_DURATION = 3;

// 影の最大の濃さ（0〜1のalpha）
const ASSEMBLY_CLOUD_SHADOW_MAX_ALPHA = 0.45;

// 疑似影（地面に落とす、雲と同じ配置の暗い半透明の複製）を作る。「雲の影もフェードイン
// してほしい」との指摘に対応するため——本物のcastShadowはopacityを見ずに常にくっきり
// 影を落とすため、フェード完了までは代わりにこの疑似影を使い、opacityを雲本体と同じ
// 進行度で連動させて滑らかにフェードインさせる。
// 「本物のcastShadowを使わず疑似影だけを雲が存在する間ずっと使い続ける」方式も試したが、
// 複数の雲の疑似影（半透明の黒）が地面上で重なると、アルファブレンドにより濃さが
// 積み重なってほぼ真っ黒になってしまい（本物の影は光源1つぶんの濃さで頭打ちになり
// 重なっても濃くならないのに対し、半透明の板を重ねるとどんどん濃くなる）、「さっきより
// おかしい」との指摘につながった。そのため、フェード完了後は本物のcastShadowに切り替える
// 方式に戻した（フェード中の一瞬の切り替わりより、常時発生しうる濃さの重なりの方が
// 実害が大きいと判断）
function buildAssemblyCloudShadowBlob(cloud) {
    const blob = cloud.clone(); // ジオメトリ配置だけ複製（マテリアルは共有されるので直後に差し替える）
    const blobMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false });
    blob.traverse(o => { if (o.isMesh) { o.material = blobMat; o.castShadow = false; } });
    blob.userData.blobMaterial = blobMat;
    blob.scale.copy(cloud.scale);
    blob.rotation.y = cloud.rotation.y;
    return blob;
}

// 太陽光の向きに沿って、指定した高さにある点が地面(ASSEMBLY_GROUND_Y)のどこに
// 影を落とすかのXZオフセットを求める（平行光源なので高さだけで決まる）
function getAssemblyCloudShadowOffset(heightAboveGround) {
    const dir = new THREE.Vector3().subVectors(assemblySun.target.position, assemblySun.position).normalize();
    const t = -heightAboveGround / dir.y; // dir.yは負（下向き）なので、tは正になる
    return { x: dir.x * t, z: dir.z * t };
}

// フェードが完了した雲の疑似影を片付け、全ての円盤にcastShadowをまとめて有効化する
// （本物の影は複数重なっても濃くなりすぎないため、定常状態はこちらを使う）
function enableAssemblyCloudShadow(cloud) {
    if (cloud.userData.shadowEnabled) return;
    cloud.userData.shadowEnabled = true;
    cloud.traverse(o => { if (o.isMesh) o.castShadow = true; });
    if (cloud.userData.shadowBlob) {
        assemblyScene.remove(cloud.userData.shadowBlob);
        cloud.userData.shadowBlob.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        cloud.userData.shadowBlob = null;
    }
}

// 1個の雲を生成して指定したX座標に配置する（initAssemblyClouds/spawnAssemblyCloud共通）。
// Y/Zはランダムに決める
function spawnAssemblyCloud(x) {
    const cloud = buildProceduralCloudMesh();
    // 「もう少し大小の雲があっていい」との指示で、大きさのばらつきの幅を広げた
    // 「雲のサイズが全体的に大きい」との指摘で全体的に縮小しつつ、大小のばらつきは維持
    cloud.scale.setScalar(1.5 + Math.random() * 5.5);
    const cloudY = 90 + Math.random() * 14; // 「雲の高さをもっと高くして」との指示で34→60→90に引き上げ（太陽の高さ110より低いまま）
    cloud.position.set(x, cloudY, (Math.random() * 2 - 1) * assemblyCloudRange);
    cloud.rotation.y = Math.random() * Math.PI * 2;
    cloud.userData.fadeElapsed = 0; // tickAssemblyCloudsでopacityを毎フレーム引き上げる
    assemblyScene.add(cloud);
    assemblyClouds.push(cloud);

    // フェード中だけ表示する疑似影を、太陽の向きに応じたオフセット位置の地面に置く
    const offset = getAssemblyCloudShadowOffset(cloudY - ASSEMBLY_GROUND_Y);
    const blob = buildAssemblyCloudShadowBlob(cloud);
    blob.position.set(x + offset.x, ASSEMBLY_GROUND_Y + 0.01, cloud.position.z + offset.z);
    cloud.userData.shadowBlob = blob;
    cloud.userData.shadowGroundOffset = offset; // 雲がX方向へ流れるのに追従させるため保持
    assemblyScene.add(blob);
}

// 1個の雲（疑似影があればそれも含め）をシーンから取り除き、GPUリソースを解放する
function disposeAssemblyCloud(cloud) {
    assemblyScene.remove(cloud);
    cloud.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
    });
    if (cloud.userData.shadowBlob) {
        assemblyScene.remove(cloud.userData.shadowBlob);
        cloud.userData.shadowBlob.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
    }
}

// 今ある雲を全て破棄し、現在のassemblyCloudRangeで撒き直す。updateAssemblyCloudRange()が
// 範囲の変化を検知した時に呼ぶ（雲だけ滑らかに移行させる必要は無いという判断、詳細は
// updateAssemblyCloudRangeのコメント参照）
function resetAssemblyClouds() {
    assemblyClouds.forEach(disposeAssemblyCloud);
    assemblyClouds = [];
    initAssemblyClouds();
}

// 3Dシーン初期化時、最初から画面に雲がある状態にするため範囲全体に散らして生成する
// （以降の追加生成はtickAssemblyCloudsが端から生やす。initAssemblyScene参照）。
// トラックの規模変更でassemblyCloudRangeが変わった時（resetAssemblyClouds経由）にも呼ばれる。
// 初回表示時にフェードインの間が空いて不自然に見えないよう、開始時点で既にフェード済み
// （opacity=1、影も有効）にしておく
function initAssemblyClouds() {
    for (let i = 0; i < ASSEMBLY_CLOUD_COUNT; i++) {
        spawnAssemblyCloud((Math.random() * 2 - 1) * assemblyCloudRange);
        const cloud = assemblyClouds[assemblyClouds.length - 1];
        cloud.userData.fadeElapsed = ASSEMBLY_CLOUD_FADE_DURATION;
        cloud.userData.cloudMaterial.opacity = 1;
        enableAssemblyCloudShadow(cloud); // 疑似影をすぐ片付け、本物の影を有効化する
    }
}

// 次に新しい雲を生やすまでの残り時間（秒）。「定期的に新しい雲もどんどん生成してください」
// との指示のため、ランダムな間隔で生やし続ける
let assemblyCloudSpawnTimer = 3;

// 毎フレーム、雲をX方向へゆっくり平行移動させる（「時間で平行に流れていく」）。
// 「陸のエリアからはみ出たら消え、定期的に新しい雲もどんどん生成してください」との指示で、
// 反対側へ折り返す（テレポートする）方式から、範囲外に出たら消して片側から新しい雲を
// 生やし続ける方式に変更した
function tickAssemblyClouds(dt) {
    for (let i = assemblyClouds.length - 1; i >= 0; i--) {
        const cloud = assemblyClouds[i];
        cloud.position.x += ASSEMBLY_CLOUD_DRIFT_SPEED * dt;
        if (cloud.userData.shadowBlob) {
            // 雲のX移動に追従させる（Zは流れないので変化しない）
            cloud.userData.shadowBlob.position.x = cloud.position.x + cloud.userData.shadowGroundOffset.x;
        }
        // 「雲と影は、消える時はフェードアウトすること。ぱっと消えないこと」との指摘対応。
        // 以前は表示エリアを出た瞬間にdisposeAssemblyCloud()で即座に消していた（フェード
        // イン側は既に対応済みだったが、退出側だけ非対称に「ぱっと消える」ままだった）。
        // 表示エリアを出た最初のフレームでexiting状態に入り、以降はASSEMBLY_CLOUD_FADE_DURATION
        // かけてopacityを1→0へ戻し、完全に消えてから実際にdisposeする
        if (cloud.position.x > assemblyCloudRange && !cloud.userData.exiting) {
            cloud.userData.exiting = true;
            cloud.userData.fadeElapsed = 0;
            // 定常状態では複数の疑似影が重なって濃さが積み重なるのを避けるため本物の
            // castShadowへ切り替え済み（enableAssemblyCloudShadow参照）だが、本物の影は
            // opacityを見ず常にくっきり落ちるためフェードアウトできない。退出時だけ
            // 疑似影を作り直し、フェードイン時と同じ仕組みで雲本体と同期してフェード
            // させられるようにする（本物のcastShadowは無効化する）
            if (cloud.userData.shadowEnabled) {
                cloud.traverse(o => { if (o.isMesh) o.castShadow = false; });
                cloud.userData.shadowEnabled = false;
                const offset = getAssemblyCloudShadowOffset(cloud.position.y - ASSEMBLY_GROUND_Y);
                const blob = buildAssemblyCloudShadowBlob(cloud);
                blob.position.set(cloud.position.x + offset.x, ASSEMBLY_GROUND_Y + 0.01, cloud.position.z + offset.z);
                cloud.userData.shadowBlob = blob;
                cloud.userData.shadowGroundOffset = offset;
                cloud.userData.shadowBlob.userData.blobMaterial.opacity = ASSEMBLY_CLOUD_SHADOW_MAX_ALPHA; // 直前まで本物の影で全力表示だった状態を引き継ぐ
                assemblyScene.add(blob);
            }
        }
        if (cloud.userData.exiting) {
            cloud.userData.fadeElapsed = Math.min(ASSEMBLY_CLOUD_FADE_DURATION, cloud.userData.fadeElapsed + dt);
            const progress = 1 - cloud.userData.fadeElapsed / ASSEMBLY_CLOUD_FADE_DURATION; // 1→0
            cloud.userData.cloudMaterial.opacity = progress;
            const shadowProgress = progress * progress * progress; // フェードイン側と同じイージングを逆向きに使う
            cloud.userData.shadowBlob.userData.blobMaterial.opacity = shadowProgress * ASSEMBLY_CLOUD_SHADOW_MAX_ALPHA;
            if (cloud.userData.fadeElapsed >= ASSEMBLY_CLOUD_FADE_DURATION) {
                disposeAssemblyCloud(cloud);
                assemblyClouds.splice(i, 1);
            }
            continue;
        }
        // フェードイン（「急に出現すると変」との指摘のため、生成直後は透明から少しずつ現れる）。
        // 「早くフェードインすると見切れてしまう」との指摘のため、通常の表示エリア
        // （-assemblyCloudRange〜assemblyCloudRange、雲が完全に収まって見える範囲）に
        // 入るまではフェードを開始しない（生成時のさらに外側のマージン区間は透明のまま素通りする）
        const withinDisplayArea = cloud.position.x >= -assemblyCloudRange;
        if (withinDisplayArea && cloud.userData.fadeElapsed < ASSEMBLY_CLOUD_FADE_DURATION) {
            cloud.userData.fadeElapsed = Math.min(ASSEMBLY_CLOUD_FADE_DURATION, cloud.userData.fadeElapsed + dt);
            const progress = cloud.userData.fadeElapsed / ASSEMBLY_CLOUD_FADE_DURATION;
            cloud.userData.cloudMaterial.opacity = progress;
            // 「雲はじわ～っと表示されるのに、影は一瞬で表示されてしまう」との指摘対応。
            // 進行度(progress)自体は雲本体と全く同じ値を使っており、alphaの数値としては
            // 同期して線形に増えていたが、実測（Playwrightでprogressごとにスクリーンショット
            // を比較）したところ、白い雲が淡い青空に乗るケースは低コントラストなため序盤の
            // 薄いopacityでもほぼ見えないのに対し、黒に近い影が緑の地面に乗るケースは
            // 高コントラストなため、ごく薄いopacity（例: progress=0.15時点でalpha≈0.07）
            // でも既にはっきり「影がある」と分かってしまい、体感的に「影だけ一瞬で出る」
            // ように見えていた。影側だけ3乗のイージングを掛け、序盤はほぼ見えないまま
            // 終盤で一気に濃くなるようにすることで、雲本体の体感的な出現速度に合わせた
            const shadowProgress = progress * progress * progress;
            cloud.userData.shadowBlob.userData.blobMaterial.opacity = shadowProgress * ASSEMBLY_CLOUD_SHADOW_MAX_ALPHA;
            // フェードが完了した瞬間に本物の影へ切り替える（複数の雲の疑似影が重なって
            // 濃さが積み重なるのを避けるため、定常状態では本物の影を使う）
            if (cloud.userData.fadeElapsed >= ASSEMBLY_CLOUD_FADE_DURATION) {
                enableAssemblyCloudShadow(cloud);
            }
        }
    }
    assemblyCloudSpawnTimer -= dt;
    if (assemblyCloudSpawnTimer <= 0) {
        // 流れてくる側（左端）よりもさらに外側から生やす
        spawnAssemblyCloud(-assemblyCloudRange - ASSEMBLY_CLOUD_SPAWN_MARGIN);
        assemblyCloudSpawnTimer = 2 + Math.random() * 3; // 次の生成までの間隔をランダムにする
    }
}

// 木・草・花の生成・配置本体。トラックの外周（extentをASSEMBLY_DECORATION_MARGINぶん
// 広げた範囲）のうち、grid上でレール/センサー/音符マットが無い（＝空いている）マスから
// ランダムに間引いて選び、ランダムな種類（草が最も多く、花・木の順に少なくする）を
// 生やす。曲・マップ設定が変わるたびrebuildAssemblyMeshes()から毎回呼び直され、
// 前回ぶんは必ず一度破棄してから作り直す
// 「グリッドエリアの周りにしか咲いていない、水平線の奥の方までまばらせないのか」との
// 指摘で4→60に拡大した（地面プレーンは900x900と広いため、直近の数マスだけでなく
// 遠景にも点在させることで奥行きのある景色にする）
const ASSEMBLY_DECORATION_MARGIN = 120; // トラック外周に広げる範囲（マス）。「範囲を広げてください」との依頼で60→120に試験的に拡大
// 「周りを囲っているように見える、もっとまばらに」との指摘で0.14→0.05に下げた
// （グリッド外周のリング状の範囲は非常に長いため、密度を下げないと途切れ目のない
// 壁のように見えてしまう）
const ASSEMBLY_DECORATION_DENSITY = 0.05; // 空きマス1つあたりに何かを置く確率
// 上記のASSEMBLY_DECORATION_MARGIN拡大（60→120）で対象エリアが約2.5倍になった分、
// 合計個数の上限を固定していると花・草・木の密度が薄まって見えてしまう。「植物の
// 上限は5倍」との指示で100→500に拡大
const ASSEMBLY_DECORATION_MAX_COUNT = 500; // 大きなトラックでも重くなりすぎないための上限
let assemblyDecorationMeshes = [];
// 前回配置した時点のextent（トラックの形）を覚えておき、変わっていなければ
// 再配置をスキップする（「何かの設定を変えるたびに植物や雲の再描画をやめたい」との
// 指示のため。extentは曲・レール方向・段の幅など、実際にグリッドの形が変わる設定でしか
// 変化しないので、それ以外の設定（色・カメラ等）を変更した際の無駄な再抽選を防げる）
let assemblyDecorationsExtentSignature = null;

// 除外すべき「グリッドエリア」は、トラックの生の矩形(extent)そのものではなく、
// 3D画面に実際に表示される正方形グリッド（rebuildAssemblyMeshesのgridSize算出と
// 同じ式：長辺+4を一辺とする正方形）に合わせる。トラックが細長い場合、extentの
// 矩形だけを除外すると、正方形グリッドの中の余白部分にも装飾が生成されてしまい
// 「グリッドの中に生えている」ように見える不具合があったため。木・草・花の配置と
// 地面ブロックの色分けの両方で使う共通ロジックなのでヘルパーとして切り出した
function computeAssemblyGridSquareBounds(extent) {
    const gridCenterX = (extent.minX + extent.maxX) / 2;
    const gridCenterY = (extent.minY + extent.maxY) / 2;
    const gridHalf = (Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY) + 4) / 2;
    return {
        gridMinX: gridCenterX - gridHalf, gridMaxX: gridCenterX + gridHalf,
        gridMinY: gridCenterY - gridHalf, gridMaxY: gridCenterY + gridHalf,
    };
}

// 「一列の最大レール数を変えると重い」との指摘を受けた計測で、3D再構築（平均約550ms）の
// うち装飾（花・草・木）の生成だけで474ms（全体の約85%）を占め、特に花が単価1.56ms×191個で
// 断トツに重いと判明。個々の花・草・木を毎回ゼロから手続き的に構築（花弁の配置計算等）する
// のをやめ、「1マス分（1個）だけ本物を作ったら、あとは複製で使い回す」方式にした
// （ユーザー了承済み：同じ種類の花/草/木は全部同じ形・同じ色になるが、位置・回転は
// 複製後に個別設定するため従来通りバラバラになる）。Object3D.clone()はジオメトリ・
// マテリアルを複製せず参照を共有するため、複製自体はほぼノーコストになる
let assemblyFlowerClusterTemplate = null;
let assemblyGrassTuftTemplate = null;
let assemblyBroadleafTreeTemplate = null;
let assemblyConiferTreeTemplate = null;
function getAssemblyFlowerClusterInstance() {
    if (!assemblyFlowerClusterTemplate) assemblyFlowerClusterTemplate = buildProceduralFlowerClusterMesh();
    return assemblyFlowerClusterTemplate.clone();
}
function getAssemblyGrassTuftInstance() {
    if (!assemblyGrassTuftTemplate) assemblyGrassTuftTemplate = buildProceduralGrassTuftMesh();
    return assemblyGrassTuftTemplate.clone();
}
function getAssemblyBroadleafTreeInstance() {
    if (!assemblyBroadleafTreeTemplate) assemblyBroadleafTreeTemplate = buildProceduralBroadleafTreeMesh();
    return assemblyBroadleafTreeTemplate.clone();
}
function getAssemblyConiferTreeInstance() {
    if (!assemblyConiferTreeTemplate) assemblyConiferTreeTemplate = buildProceduralConiferTreeMesh();
    return assemblyConiferTreeTemplate.clone();
}

function generateAssemblyDecorations(extent, toWorld) {
    // マテリアルはgetSharedDecorationMaterial()で色ごとに共有・キャッシュされているため
    // （「装飾が重い」対策でマテリアル重複を無くした際に導入）、個々の装飾を破棄する時に
    // マテリアルまでdispose()してしまうと、他の（まだ使用中の）装飾や次回以降の生成で
    // 同じマテリアルを使う全ての装飾が壊れる。同様に、ジオメトリも今は花/草/木それぞれ
    // 1個だけ本物を作って複製（Object3D.clone()、ジオメトリは参照共有）で使い回している
    // ため、個々の装飾のジオメトリをdispose()すると、まだ使用中の他の複製や次回以降の
    // 複製元（テンプレート）まで壊れてしまう。scene.remove()だけ行い、ジオメトリ・
    // マテリアルどちらもdispose()しない
    if (!mapSettings.showDecorations) {
        assemblyDecorationMeshes.forEach(m => assemblyScene.remove(m));
        assemblyDecorationMeshes = [];
        assemblyDecorationsExtentSignature = null; // 次に表示をONにした時は必ず新しく配置し直す
        return;
    }
    // extentが前回と変わっていなければ、既存の配置をそのまま維持する（無駄な再抽選をしない）
    const signature = `${extent.minX},${extent.maxX},${extent.minY},${extent.maxY}`;
    if (signature === assemblyDecorationsExtentSignature && assemblyDecorationMeshes.length > 0) return;
    assemblyDecorationsExtentSignature = signature;

    assemblyDecorationMeshes.forEach(m => assemblyScene.remove(m));
    assemblyDecorationMeshes = [];

    const { gridMinX, gridMaxX, gridMinY, gridMaxY } = computeAssemblyGridSquareBounds(extent);

    // gridHalfが端数(奇数のgridSizeを2で割った場合など)になり得るため、外周の探索範囲は
    // 整数グリッド座標を確実に網羅できるようfloor/ceilで丸める(内外判定自体はgridMinX等の
    // 端数のまま比較して問題ない)
    const minX = Math.floor(gridMinX - ASSEMBLY_DECORATION_MARGIN);
    const maxX = Math.ceil(gridMaxX + ASSEMBLY_DECORATION_MARGIN);
    const minY = Math.floor(gridMinY - ASSEMBLY_DECORATION_MARGIN);
    const maxY = Math.ceil(gridMaxY + ASSEMBLY_DECORATION_MARGIN);

    // 正方形グリッドの外側にある有効なマス目を全て洗い出す（「かならず、グリッドエリアと
    // 同じような升目を意識して、1マスの中に1つの草や花が収まるように配置してください」
    // との指示のため、花・草も含め全て整数グリッド座標に1個ずつ配置する。以前試した
    // 「グリッドに縛られない自由配置」は明確に不要と指摘されたため撤回した）
    const validCellKeys = [];
    const validCellSet = new Set();
    for (let gx = minX; gx <= maxX; gx++) {
        for (let gy = minY; gy <= maxY; gy++) {
            if (gx >= gridMinX && gx <= gridMaxX && gy >= gridMinY && gy <= gridMaxY) continue;
            const key = `${gx},${gy}`;
            // 「茶色ブロックには草ははやさないでください」との指摘対応。地面ブロック・池が
            // 既に使っているマスには木・草・花を生やさない（どちらもこの時点で確定済み。
            // generateAssemblyPonds/generateAssemblyGroundBlocksを先に呼んでいるため）
            if (assemblyGroundBlockCellSet.has(key) || assemblyPondCellSet.has(key)) continue;
            validCellKeys.push(key);
            validCellSet.add(key);
        }
    }

    // シードとなる候補マス（花・草・木の「群れ」の起点）を密度に応じて間引く
    const seedKeys = validCellKeys.filter(() => Math.random() < ASSEMBLY_DECORATION_DENSITY);
    // 端に偏らないようシャッフルしてから、上限に達するまで順に処理する
    for (let i = seedKeys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [seedKeys[i], seedKeys[j]] = [seedKeys[j], seedKeys[i]];
    }

    const usedCellSet = new Set();
    let placedCount = 0;
    for (const seedKey of seedKeys) {
        if (placedCount >= ASSEMBLY_DECORATION_MAX_COUNT) break;
        if (usedCellSet.has(seedKey)) continue; // 既に他の群れがこのマスを使っている
        const [gx, gy] = seedKey.split(",").map(Number);

        const roll = Math.random();
        // 草が一番多く、次に花、木は控えめ。木は元々8%だったが、花・草がクラスタ化して
        // 1シードあたり複数マスを消費するようになった影響で上限に達するまでに評価される
        // シード数自体が減り、「木がまったく映っていない」という体感になっていたため20%に
        // 引き上げた
        const isTree = roll < 0.2;
        const isFlower = !isTree && roll < 0.55;
        // 「花や草は、1つではなく2〜4個、ランダムな形で密集していることが多い」との
        // 指摘のため、花・草はシードのマスを含め近隣の未使用マスも使って2〜4マスへ広がる
        // 群れにする（木は単体のまま）。1マスには必ず1個だけ収める
        const clusterSize = isTree ? 1 : 2 + Math.floor(Math.random() * 3);

        let neighborKeys = [];
        if (clusterSize > 1) {
            // 隣接マスをランダムな順で集める（「ランダムな形」）。「独立してしまっている
            // （斜めはカウントしない）」との指摘のため、対角（8近傍）ではなく上下左右
            // （4近傍）のみを隣接として扱う
            const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            for (const [dx, dy] of dirs) {
                const key = `${gx + dx},${gy + dy}`;
                if (validCellSet.has(key) && !usedCellSet.has(key)) neighborKeys.push(key);
            }
            for (let i = neighborKeys.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [neighborKeys[i], neighborKeys[j]] = [neighborKeys[j], neighborKeys[i]];
            }
        }
        // 「花や草は、必ず1マス以上横に別の花や草が隣接しています」との指示のため、
        // 隣接マス（上下左右）が1つも確保できなかった花・草のシードは孤立した1マス
        // だけの株になってしまうので、その場合はこのシードを丸ごと使わない（孤立株を作らない）
        if (!isTree && neighborKeys.length === 0) continue;

        const cellKeys = [seedKey];
        usedCellSet.add(seedKey);
        for (let i = 0; i < clusterSize - 1 && i < neighborKeys.length; i++) {
            cellKeys.push(neighborKeys[i]);
            usedCellSet.add(neighborKeys[i]);
        }
        // 群れ（cellKeys）の途中で上限に達すると、種となったマスだけが配置され隣接する
        // 仲間が配置されずに孤立してしまう（「花や草は、必ず1マス以上横に別の花や草が
        // 隣接しています」という前提が崩れる）。そのため群れは全部まとめて置けるかを
        // 先に確認し、置けない場合はこの群れを丸ごとスキップする（全部か無しか）
        if (placedCount + cellKeys.length > ASSEMBLY_DECORATION_MAX_COUNT) continue;

        for (const cellKey of cellKeys) {
            const [cgx, cgy] = cellKey.split(",").map(Number);
            // 木は広葉樹/針葉樹を半々でランダムに選ぶ
            const mesh = isTree ? (Math.random() < 0.5 ? getAssemblyBroadleafTreeInstance() : getAssemblyConiferTreeInstance())
                : isFlower ? getAssemblyFlowerClusterInstance()
                : getAssemblyGrassTuftInstance();

            // 花・木・草は全て下位層（MAP_LAYER_Z.lower）に配置する（「花や木は下位レイヤーに
            // してください」→「草むらも下位レイヤーで」との指示）。
            // Yは「下位層＝地面に接触する層」という実機の位置づけ（ユーザー確認済み）に合わせて
            // 地面そのものの高さ(ASSEMBLY_GROUND_Y)を使う。MAP_LAYER_Z.lowerのY(-1)のままだと
            // 地面との間に0.5の隙間が空き、影が足元から離れた位置にずれて落ちる不自然な見た目に
            // なっていたため（木・花で先に対応済みの問題と同じ）
            const base = toWorld(cgx, cgy, MAP_LAYER_Z.lower);
            // 花・草は footprint がちょうど1マス分（はみ出ない範囲で目一杯）なので、
            // 少しでもjitterを掛けるとマスからはみ出してしまう。「花も草も1マス内に
            // はまっていません」との指摘を受け、花・草はjitterを掛けずマスの中心に
            // 正確に置く。木は1マスぴったりである必要が無いため従来通り小さなjitterを残す
            const jitterScale = isTree ? ASSEMBLY_CELL_SIZE * 0.6 : 0;
            const jitterX = (Math.random() - 0.5) * jitterScale;
            const jitterZ = (Math.random() - 0.5) * jitterScale;
            mesh.position.set(base.x + jitterX, ASSEMBLY_GROUND_Y, base.z + jitterZ);
            // 花・草は構築時点でX/Zの footprint を正方形に正規化しているが、任意角度で回転させると
            // （形状自体は正方形の輪郭ではないため）回転後のワールド座標AABBが再び正方形からずれて
            // しまう。90度刻みの回転ならローカルのX/Z軸が入れ替わるだけで正方形が保たれるため、
            // 花・草はそれに限定する（「もうちょい正方形寄りで」「叢も同様」との指示）。
            // 木は正方形である必要が無いため従来通り任意角度で回転させる
            mesh.rotation.y = (isTree ? Math.random() * Math.PI * 2 : Math.floor(Math.random() * 4) * (Math.PI / 2));
            // 「まだ草や花にばらつきがある」「升目いっぱいに出すことを忘れずに」との指摘のため、
            // 草も含め花・木・草すべてランダムな拡大縮小を掛けない（サイズを毎回一定にする）。
            // 以前は草だけランダムな大きさのばらつき(0.85〜1.15倍)を残していたが、
            // これだと1マス丸ごとを埋めきれない（最大15%小さくなる）ことがあり、
            // 「升目を意識できていない・密集できていない」ように見える一因になっていた
            assemblyScene.add(mesh);
            assemblyDecorationMeshes.push(mesh);
            placedCount++;
        }
    }
}

// ============================================================
// 地面ブロックの色分け。「ぽこあポケモンのように、グリッドエリアより外側に対し、
// 地面のブロックの色をランダムで変えてほしい。黄土色で、必ず1マス以上同じ黄土色の
// ブロックと隣接したランダムな配置にしてほしい」との依頼。当初は合計10〜100個の
// 「群れ」をまばらに撒く方式だったが、「全然増えていない」「見えている陸の3分の2
// くらい茶色でいい」との指摘で、面積そのものを大きく塗るスケールに作り直した。
// 木・草・花と同じ「グリッド外側のマスを使う」考え方だが、こちらは装飾物を生やすの
// ではなく、地面そのものの色を1マス単位で塗り替える（薄い正方形の板を地面に重ねる）。
// 対象マス数が数千〜数万に達しうるため、個別Meshではなく1つのInstancedMeshにまとめて
// 描画負荷を抑える
// ============================================================
const ASSEMBLY_GROUND_BLOCK_COLOR = 0xd6b678; // 黄土色。「もう少し薄くていい」との指示で0xc19a49より明るく淡い色に調整
// 「見えている陸の3分の2くらい茶色でいい」→「半分程度にしてください」→「3分の1にしてみて
// ください」と段階的に調整された、対象マスのうち茶色にする割合
const ASSEMBLY_GROUND_BLOCK_FILL_FRACTION = 1 / 3;
// 「地面は一回の描画（InstancedMesh）なら、目に見えている陸全部に反映してほしい」との
// 指示で、木・草・花のASSEMBLY_DECORATION_MARGIN（120マス、合計個数上限があるため
// 広げすぎると密度が薄まる制約がある）とは別に、地面ブロック専用のより広いマージンを
// 用意した。地面ブロックは合計個数の上限が無く1回の描画で済むため、広げても表示コストは
// 増えない（生成コスト・メモリだけがマス数に応じて増える）
const ASSEMBLY_GROUND_BLOCK_MARGIN = 300;
// 極端に大きなトラックでもタイル数が暴走しないための安全上限（これを超える場合は
// フラクションを維持できる範囲まで対象マス数を絞る＝マージンいっぱいまでは広がらず
// グリッドに近い側から優先して塗られる）。
// 「途中でカクっとなる」というデグレ報告の調査中、ASSEMBLY_GROUND_BLOCK_MARGIN=300が
// 大きすぎて、トラックの規模に関わらずほぼ常にこの上限（当初150,000）に張り付いた
// 状態になっていたことが判明した（小さいデフォルトのトラックでも150,000枚に到達）。
// 上限が「滅多に発動しない安全弁」ではなく「常に効いている実質的な固定値」になって
// しまっており、装飾（500個）と合わせて描画負荷が常に高い状態が続いていた。
// カメラの不具合そのものとは別の切り分けだが、確実に負荷を下げられる対策として
// 上限を150,000→30,000に引き下げた（生成時のBFS成長ループもこの上限で打ち切られる
// ため、GPU側のインスタンス数だけでなくCPU側の生成コストも下がる）
const ASSEMBLY_GROUND_BLOCK_MAX_INSTANCES = 30000;
let assemblyGroundBlockMesh = null;
let assemblyGroundBlockGeometry = null;
let assemblyGroundBlockMaterial = null;
// 木・草・花と同じ理由（「何かの設定を変えるたびに再描画をやめたい」）で、extentが
// 前回と変わっていなければ再配置をスキップする
let assemblyGroundBlocksExtentSignature = null;

// 「茶色のところは参考写真を参考にしてほしい」との依頼を受け、当初はブロック1枚1枚に
// アトラス状の模様テクスチャ・ランダム回転・色ムラを持たせる作り込んだ実装を試したが、
// 「一回元に戻して、斑点だけつければいい」との指摘で撤回。ブロック自体は元のベタ塗り単色
// InstancedMeshのまま維持し、参考写真の黒い斑点だけを、その上に重ねる別の小さな
// InstancedMesh（黒い円板、まばらな一部のブロックにだけ乗せる）として追加する方式にした
// 「黒が強調しすぎ、もっと小さい点でいい、色も茶色よりほんの少し黒っぽい感じでいい」との
// 指摘で、真っ黒ではなくブロック本体の色を暗くしただけの色に、サイズも小さく調整した
const ASSEMBLY_GROUND_SPOT_DARKEN = 0.4; // ブロック本体の色にこの倍率を掛けて少し暗くするだけ（真っ黒にしない）。「ちょっと見えるかな程度」との指摘で0.55→0.4に
// 「点々を増やしてください」→「もうちょっとふやして」と段階的に引き上げ、0.05→0.15→0.25に
const ASSEMBLY_GROUND_SPOT_FRACTION = 0.25; // ブロックのうち斑点を乗せる割合
// 「今の点を最大として、大中小をもう少し散らしてほしい」との指摘で、固定半径から
// MIN〜MAXのランダムな大中小に変更した（MAXはこれまでの固定値0.05のまま）
// 「もうちょっと茶色の粒大きくてもいいかも」との指摘で0.05/0.02→0.07/0.03に引き上げ
const ASSEMBLY_GROUND_SPOT_RADIUS_MAX = 0.07;
const ASSEMBLY_GROUND_SPOT_RADIUS_MIN = 0.03;
let assemblyGroundSpotMesh = null;
let assemblyGroundSpotGeometry = null;
let assemblyGroundSpotMaterial = null;
// 「茶色ブロックには草ははやさないでください」との指摘対応。地面ブロック（brownSet）が
// 使っているマス目を、木・草・花の配置（generateAssemblyDecorations）が避けられるよう、
// 生成結果を外から参照できる形で保持しておく（rebuildAssemblyMeshes側で地面ブロックを
// 木・草・花より先に生成させ、こちらを先に確定させる必要がある）
let assemblyGroundBlockCellSet = new Set();

function generateAssemblyGroundBlocks(extent, toWorld, grid) {
    const signature = `${extent.minX},${extent.maxX},${extent.minY},${extent.maxY}`;
    if (signature === assemblyGroundBlocksExtentSignature && assemblyGroundBlockMesh) return;
    assemblyGroundBlocksExtentSignature = signature;

    if (assemblyGroundBlockMesh) {
        assemblyScene.remove(assemblyGroundBlockMesh);
        assemblyGroundBlockMesh = null;
    }
    if (assemblyGroundBlockGeometry) assemblyGroundBlockGeometry.dispose();
    if (assemblyGroundBlockMaterial) assemblyGroundBlockMaterial.dispose();
    if (assemblyGroundSpotMesh) {
        assemblyScene.remove(assemblyGroundSpotMesh);
        assemblyGroundSpotMesh = null;
    }
    if (assemblyGroundSpotGeometry) assemblyGroundSpotGeometry.dispose();
    if (assemblyGroundSpotMaterial) assemblyGroundSpotMaterial.dispose();

    const { gridMinX, gridMaxX, gridMinY, gridMaxY } = computeAssemblyGridSquareBounds(extent);
    const minX = Math.floor(gridMinX - ASSEMBLY_GROUND_BLOCK_MARGIN);
    const maxX = Math.ceil(gridMaxX + ASSEMBLY_GROUND_BLOCK_MARGIN);
    const minY = Math.floor(gridMinY - ASSEMBLY_GROUND_BLOCK_MARGIN);
    const maxY = Math.ceil(gridMaxY + ASSEMBLY_GROUND_BLOCK_MARGIN);
    // 「グリッドエリアでも茶色が混ざってもいい」との指摘で、以前の「グリッドの正方形の
    // 内側は完全に除外する」判定をやめ、実際にレール・センサー・音符マットが存在する
    // マスだけを避けるようにした（gridの各キーは"gx,gy,gz"で、レールは3層に複製されている
    // ため、layerを無視してgx,gyだけを集めればよい）
    const occupiedCellSet = new Set();
    for (const key of grid.keys()) {
        const parts = key.split(",");
        occupiedCellSet.add(`${parts[0]},${parts[1]}`);
    }
    // 池の上に地面ブロックが重ならないよう、池が使っているマス目（assemblyPondCellSet、
    // generateAssemblyPondsを地面ブロックより先に呼ぶことでこの時点で確定済み）も避ける
    const isAvailableCell = (gx, gy) => {
        const key = `${gx},${gy}`;
        return !occupiedCellSet.has(key) && !assemblyPondCellSet.has(key);
    };
    const isInSearchArea = (gx, gy) => gx >= minX && gx <= maxX && gy >= minY && gy <= maxY;

    // 対象マス数は非常に大きくなりうる（マージン300マス四方）ため、木・草・花のように
    // 全マスを配列に洗い出す（O(マージン^2)のループ+配列確保）のは避け、面積を掛け算だけで
    // 算出する。シードも「配列から取り出す」のではなく「範囲内の座標を乱数で直接引いて、
    // 実際に使われていないマスか確認する（ダメなら引き直す）」という乱数の当たり外れ方式に
    // することで、実際に使うマス数（targetFillCount、上限あり）に近い計算量だけで済むようにした
    const totalOuterCells = (maxX - minX + 1) * (maxY - minY + 1);
    const totalAvailableCells = Math.max(0, totalOuterCells - occupiedCellSet.size);
    const targetFillCount = Math.min(
        Math.round(totalAvailableCells * ASSEMBLY_GROUND_BLOCK_FILL_FRACTION),
        ASSEMBLY_GROUND_BLOCK_MAX_INSTANCES
    );

    // 各マスを独立に確率判定するだけだと細かい斑点模様（ノイズ）になってしまい、
    // 「見えている陸の3分の2くらい茶色でいい」という自然な地形の塊には見えなかった。
    // そこで複数のシード地点から同時に波状に広がるBFSで育てる方式を試したが、全シードが
    // 同じ速度で同時に育つため、どれも似たような大きさの円形に近い塊ばかりになり、
    // 「ワンパターンのみで面白くない、いろんな形があっていい」との指摘を受けた。
    // 修正として、塊を1つずつ順番に育てる方式に変更。各塊ごとに目標マス数を
    // （小さな点状〜大きく入り組んだ塊まで）大きくばらつかせ、育て方も「フロンティアを
    // 一度に全部広げる」のではなく「フロンティアの中からランダムに1マスだけ選んで
    // 隣へ1マス伸ばす」を繰り返す方式（花・草の群れ作りと同じ考え方）にすることで、
    // 円形ではなく蛇行した不規則な輪郭の塊になり、塊どうしの形・大きさに変化が出る
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    const brownSet = new Set();
    let seedGuard = 0;
    const maxSeedGuard = targetFillCount * 20 + 5000; // シード探索の空振り上限（無限ループ対策）
    while (brownSet.size < targetFillCount && seedGuard < maxSeedGuard) {
        seedGuard++;
        // 範囲内の座標を直接乱数で引き、実際に使われていない（レール・センサー・音符マットが
        // 無い）マスだけをシードにする
        const candidate = [
            minX + Math.floor(Math.random() * (maxX - minX + 1)),
            minY + Math.floor(Math.random() * (maxY - minY + 1)),
        ];
        if (!isAvailableCell(candidate[0], candidate[1])) continue;
        const seed = brownSet.has(`${candidate[0]},${candidate[1]}`) ? null : candidate;
        if (!seed) continue;

        // 塊1つあたりの目標マス数を、小さいものが多く・大きいものも時々混ざるよう
        // べき乗分布ふうに決める（Math.random()**3で0付近に偏らせつつ、稀に大きな
        // 値も出るようにする）。これで点状の小さな塊から広く入り組んだ塊まで混在する
        const remaining = targetFillCount - brownSet.size;
        const patchTarget = Math.max(1, Math.min(remaining, Math.round(2 + Math.pow(Math.random(), 3) * 350)));

        const seedKey = `${seed[0]},${seed[1]}`;
        brownSet.add(seedKey);
        let patchCount = 1;
        const frontier = [seed];
        while (patchCount < patchTarget && frontier.length > 0) {
            const idx = Math.floor(Math.random() * frontier.length);
            const [gx, gy] = frontier[idx];
            const shuffledDirs = shuffleArray(dirs);
            let extended = false;
            for (const [dx, dy] of shuffledDirs) {
                const nx = gx + dx, ny = gy + dy;
                const key = `${nx},${ny}`;
                if (isInSearchArea(nx, ny) && isAvailableCell(nx, ny) && !brownSet.has(key)) {
                    brownSet.add(key);
                    frontier.push([nx, ny]);
                    patchCount++;
                    extended = true;
                    break;
                }
            }
            if (!extended) frontier.splice(idx, 1); // これ以上広げられないマスは候補から外す
        }
    }
    assemblyGroundBlockCellSet = brownSet; // 木・草・花側が避けられるよう公開する

    assemblyGroundBlockGeometry = new THREE.PlaneGeometry(ASSEMBLY_CELL_SIZE, ASSEMBLY_CELL_SIZE);
    // 「茶色の床ブロックがちらついて見える」との指摘（z-fighting）のため、地面からの
    // 高さの余白を0.003→0.02に広げ、さらにGPU側のポリゴンオフセット（奥行きをカメラ側へ
    // わずかにずらす、z-fighting対策の定番）も併用して確実に手前に描画されるようにした
    assemblyGroundBlockMaterial = new THREE.MeshStandardMaterial({
        color: ASSEMBLY_GROUND_BLOCK_COLOR, roughness: 0.95,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    assemblyGroundBlockMesh = new THREE.InstancedMesh(assemblyGroundBlockGeometry, assemblyGroundBlockMaterial, brownSet.size);
    assemblyGroundBlockMesh.receiveShadow = true;
    const dummy = new THREE.Object3D();
    dummy.rotation.x = -Math.PI / 2;
    let idx = 0;
    for (const key of brownSet) {
        const [gx, gy] = key.split(",").map(Number);
        const world = toWorld(gx, gy, MAP_LAYER_Z.middle);
        dummy.position.set(world.x, ASSEMBLY_GROUND_Y + 0.02, world.z);
        dummy.updateMatrix();
        assemblyGroundBlockMesh.setMatrixAt(idx++, dummy.matrix);
    }
    assemblyScene.add(assemblyGroundBlockMesh);

    // 斑点。ブロックの一部（ASSEMBLY_GROUND_SPOT_FRACTION）にだけ、まばらに小さな円板を
    // 重ねる。ブロック本体の色・材質は変更しない
    const spotKeys = [...brownSet].filter(() => Math.random() < ASSEMBLY_GROUND_SPOT_FRACTION);
    if (spotKeys.length > 0) {
        // 半径1の円を1つだけ作り、インスタンスごとにscaleで大中小を表現する
        // （個体ごとに違うジオメトリを用意しなくて済む）
        assemblyGroundSpotGeometry = new THREE.CircleGeometry(1, 12);
        const spotColor = new THREE.Color(ASSEMBLY_GROUND_BLOCK_COLOR).multiplyScalar(ASSEMBLY_GROUND_SPOT_DARKEN);
        assemblyGroundSpotMaterial = new THREE.MeshBasicMaterial({
            color: spotColor,
            polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
        });
        assemblyGroundSpotMesh = new THREE.InstancedMesh(assemblyGroundSpotGeometry, assemblyGroundSpotMaterial, spotKeys.length);
        const spotDummy = new THREE.Object3D();
        spotDummy.rotation.x = -Math.PI / 2;
        let spotIdx = 0;
        for (const key of spotKeys) {
            const [gx, gy] = key.split(",").map(Number);
            const world = toWorld(gx, gy, MAP_LAYER_Z.middle);
            // ブロックの中心からわずかにずらし、マス目に整列した並びに見えないようにする
            const jitterX = (Math.random() - 0.5) * 0.4;
            const jitterZ = (Math.random() - 0.5) * 0.4;
            spotDummy.position.set(world.x + jitterX, ASSEMBLY_GROUND_Y + 0.03, world.z + jitterZ);
            const radius = ASSEMBLY_GROUND_SPOT_RADIUS_MIN + Math.random() * (ASSEMBLY_GROUND_SPOT_RADIUS_MAX - ASSEMBLY_GROUND_SPOT_RADIUS_MIN);
            spotDummy.scale.setScalar(radius);
            spotDummy.updateMatrix();
            assemblyGroundSpotMesh.setMatrixAt(spotIdx++, spotDummy.matrix);
        }
        assemblyScene.add(assemblyGroundSpotMesh);
    }
}

// ============================================================
// 池。「池を大・中で2個作ってください、場所はランダム」→「池も、土と同じようなブロックの
// 塊です。ただし、陸より1マス下げてください」との依頼で追加・作り直した。初版は雲と同じ
// 「円盤を重ねる」有機的な輪郭だったが、指摘を受け、地面ブロック（generateAssemblyGroundBlocks）
// と全く同じ「グリッド1マス単位の正方形タイルをBFSで塊状に育てる」方式に作り直し、
// 陸（ASSEMBLY_GROUND_Y）より1マス(ASSEMBLY_CELL_SIZE)下げた高さに沈めることで、
// 池が周りの陸より低い窪地に見えるようにした
// ============================================================
const ASSEMBLY_POND_SIZES = [280, 140, 70]; // 大・中・小それぞれの目標マス数
const ASSEMBLY_POND_COLOR = 0x4a90d9;
// トラック（グリッド正方形）の外周からの距離の範囲（マス）。近すぎるとトラックに重なり、
// 遠すぎると視界から外れて見えなくなるため、両方に制限を設ける
const ASSEMBLY_POND_MIN_DISTANCE_FROM_TRACK = 15;
const ASSEMBLY_POND_MAX_DISTANCE_FROM_TRACK = 60;
let assemblyPondMesh = null;
let assemblyPondGeometry = null;
let assemblyPondMaterial = null;
let assemblyPondWallMesh = null;    // 池の縁の「崖」を隠す水色の壁（下記generateAssemblyPonds末尾参照）
let assemblyPondWallGeometry = null;
let assemblyPondsExtentSignature = null;
// 地面ブロック（generateAssemblyGroundBlocks）・木/草/花（generateAssemblyDecorations）が
// 池の上に重ならないよう避けられるようにするため、使用中のマス目を外から参照できる形で
// 保持しておく（generateAssemblyPondsをそれらより先に呼ぶ必要がある）
let assemblyPondCellSet = new Set();

function generateAssemblyPonds(extent, toWorld) {
    const signature = `${extent.minX},${extent.maxX},${extent.minY},${extent.maxY}`;
    if (signature === assemblyPondsExtentSignature && assemblyPondMesh) return;
    assemblyPondsExtentSignature = signature;

    if (assemblyPondMesh) {
        assemblyScene.remove(assemblyPondMesh);
        assemblyPondMesh = null;
    }
    if (assemblyPondWallMesh) {
        assemblyScene.remove(assemblyPondWallMesh);
        assemblyPondWallMesh = null;
    }
    if (assemblyPondGeometry) assemblyPondGeometry.dispose();
    if (assemblyPondWallGeometry) assemblyPondWallGeometry.dispose();
    if (assemblyPondMaterial) assemblyPondMaterial.dispose();

    const { gridMinX, gridMaxX, gridMinY, gridMaxY } = computeAssemblyGridSquareBounds(extent);
    const gridCenterX = (gridMinX + gridMaxX) / 2;
    const gridCenterY = (gridMinY + gridMaxY) / 2;
    // グリッド外周（正方形）を確実に包む円の半径（対角線の半分）
    const gridHalf = Math.max(gridMaxX - gridMinX, gridMaxY - gridMinY) / 2 * Math.SQRT2;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    // BFSでの成長時、トラック（グリッド正方形）の内側へ向かって伸びてしまうと池がレール・
    // 音符マットに重なってしまうため、正方形の外側のマスにしか広がれないようにする
    const isOutsideGridSquare = (gx, gy) => !(gx >= gridMinX && gx <= gridMaxX && gy >= gridMinY && gy <= gridMaxY);

    const pondSet = new Set();
    ASSEMBLY_POND_SIZES.forEach(targetCells => {
        // シード探索: グリッド外周からMIN〜MAX距離のリング上のランダムな1マスを探す
        // （地面ブロックと違い、池は個数も位置の自由度も小さいため、単純なリトライ方式で十分）
        let seed = null;
        for (let attempt = 0; attempt < 200 && !seed; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = gridHalf + ASSEMBLY_POND_MIN_DISTANCE_FROM_TRACK
                + Math.random() * (ASSEMBLY_POND_MAX_DISTANCE_FROM_TRACK - ASSEMBLY_POND_MIN_DISTANCE_FROM_TRACK);
            const gx = Math.round(gridCenterX + Math.cos(angle) * dist);
            const gy = Math.round(gridCenterY + Math.sin(angle) * dist);
            const key = `${gx},${gy}`;
            if (!pondSet.has(key)) seed = [gx, gy];
        }
        if (!seed) return;

        // 地面ブロックと同じBFS成長（フロンティアからランダムに1マス選び隣へ1マス伸ばす）
        const seedKey = `${seed[0]},${seed[1]}`;
        pondSet.add(seedKey);
        let count = 1;
        const frontier = [seed];
        while (count < targetCells && frontier.length > 0) {
            const idx = Math.floor(Math.random() * frontier.length);
            const [gx, gy] = frontier[idx];
            const shuffledDirs = shuffleArray(dirs);
            let extended = false;
            for (const [dx, dy] of shuffledDirs) {
                const nx = gx + dx, ny = gy + dy;
                const key = `${nx},${ny}`;
                if (!pondSet.has(key) && isOutsideGridSquare(nx, ny)) {
                    pondSet.add(key);
                    frontier.push([nx, ny]);
                    count++;
                    extended = true;
                    break;
                }
            }
            if (!extended) frontier.splice(idx, 1);
        }
    });
    assemblyPondCellSet = pondSet;
    if (pondSet.size === 0) return;

    assemblyPondGeometry = new THREE.PlaneGeometry(ASSEMBLY_CELL_SIZE, ASSEMBLY_CELL_SIZE);
    // metalness付きだと環境マップが無いため反射が真っ黒に近く沈んで見えてしまい、さらに
    // 陸より1マス低い窪地のため周りの陸に遮られて影が落ちやすく、思った以上に暗くなって
    // いた（実測で確認）。metalnessをやめ、素直な拡散反射だけの水色にした
    assemblyPondMaterial = new THREE.MeshStandardMaterial({
        color: ASSEMBLY_POND_COLOR, roughness: 0.6, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    assemblyPondMesh = new THREE.InstancedMesh(assemblyPondGeometry, assemblyPondMaterial, pondSet.size);
    assemblyPondMesh.receiveShadow = true;
    const dummy = new THREE.Object3D();
    dummy.rotation.x = -Math.PI / 2;
    let idx = 0;
    for (const key of pondSet) {
        const [gx, gy] = key.split(",").map(Number);
        const world = toWorld(gx, gy, MAP_LAYER_Z.middle);
        // 「陸より1マス下げてください」との指定通り、地面ブロック(ASSEMBLY_GROUND_Y+0.02)より
        // ASSEMBLY_CELL_SIZE(=1マス)ぶん低い高さに沈める
        dummy.position.set(world.x, ASSEMBLY_GROUND_Y - ASSEMBLY_CELL_SIZE + 0.02, world.z);
        dummy.updateMatrix();
        assemblyPondMesh.setMatrixAt(idx++, dummy.matrix);
    }
    assemblyScene.add(assemblyPondMesh);

    // 「1マス下げて青、それだけ」のつもりが、陸〜水面間の切り立った崖に壁が無いため、
    // 斜めから見ると崖の隙間から背景（空）が覗いて白っぽく見えてしまっていた
    // （「湖の白いところ？」との指摘で判明。真上から見ないと気付きにくいバグだった）。
    // 当初は境界の辺1つにつき独立した1枚の板（InstancedMesh）を置く方式にしたが、
    // 池の輪郭が1マス単位でかなりギザギザなため、板同士がバラバラの独立した面として
    // 描画され「くし状に割れた」ような見た目になってしまった（「池のふちがおかしいかも」
    // との指摘で判明）。輪郭を1本の連続した多角形（複数の池があれば複数ループ）として
    // 抽出し、角も含めて頂点を共有する1枚の連続したメッシュへ組み立てることで解消する。
    //
    // 各マスの4隅を、隣接マスと整数座標を共有できるよう2倍のグリッド座標（奇数の整数）で
    // 表す（マス(gx,gy)の4隅は(2gx±1, 2gy±1)）。露出している辺（池ではない隣接マスと接する
    // 辺）を頂点グラフとして集め、次数2（通常）の頂点を辿って閉じたループへ分解する
    const cornerGraph = new Map(); // "cx,cy" -> { pos:[cx,cy], neighbors:[key,...] }
    const edgeOutward = new Map(); // "kA|kB"(ソート済み) -> [dx,dy]（このマスから見た外向き）
    const edgeId = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const addCorner = (cx, cy) => {
        const k = `${cx},${cy}`;
        if (!cornerGraph.has(k)) cornerGraph.set(k, { pos: [cx, cy], neighbors: [] });
        return k;
    };
    for (const key of pondSet) {
        const [gx, gy] = key.split(",").map(Number);
        for (const [dx, dy] of dirs) {
            if (pondSet.has(`${gx + dx},${gy + dy}`)) continue;
            let c1, c2;
            if (dx === 1) { c1 = [2 * gx + 1, 2 * gy - 1]; c2 = [2 * gx + 1, 2 * gy + 1]; }
            else if (dx === -1) { c1 = [2 * gx - 1, 2 * gy - 1]; c2 = [2 * gx - 1, 2 * gy + 1]; }
            else if (dy === 1) { c1 = [2 * gx - 1, 2 * gy + 1]; c2 = [2 * gx + 1, 2 * gy + 1]; }
            else { c1 = [2 * gx - 1, 2 * gy - 1]; c2 = [2 * gx + 1, 2 * gy - 1]; }
            const k1 = addCorner(...c1), k2 = addCorner(...c2);
            cornerGraph.get(k1).neighbors.push(k2);
            cornerGraph.get(k2).neighbors.push(k1);
            edgeOutward.set(edgeId(k1, k2), [dx, dy]);
        }
    }
    // 未訪問の辺が無くなるまで、閉じたループを1つずつ切り出す（池が複数あれば複数ループになる）。
    // 稀に池の形が対角線上でしか接しない「ピンチポイント」（次数4の頂点）ができることがあるが、
    // その場合は単に最初に見つかった未訪問の辺へ進む（見た目への影響はごく軽微）
    const edgeVisited = new Set();
    const loops = [];
    for (const [startKey, startNode] of cornerGraph) {
        for (const firstNext of startNode.neighbors) {
            const firstId = edgeId(startKey, firstNext);
            if (edgeVisited.has(firstId)) continue;
            edgeVisited.add(firstId);
            const loop = [startKey];
            let curKey = firstNext;
            let guard = 0;
            while (curKey !== startKey && guard++ < 100000) {
                loop.push(curKey);
                const curNode = cornerGraph.get(curKey);
                let nextKey = null;
                for (const cand of curNode.neighbors) {
                    if (edgeVisited.has(edgeId(curKey, cand))) continue;
                    nextKey = cand;
                    break;
                }
                if (nextKey == null) break;
                edgeVisited.add(edgeId(curKey, nextKey));
                curKey = nextKey;
            }
            if (loop.length >= 3) loops.push(loop);
        }
    }

    // 各ループを、頂点を共有する連続したリボン状の崖メッシュ（三角形2枚/辺）に変換する。
    // 三角形の頂点順（＝法線の向き）は、辺ごとに記録しておいた本来の外向き方向
    // （edgeOutward）と実際の法線を外積で比較し、一致する向きになるよう個別に選ぶ
    // （ループを辿る方向が辺ごとに一定とは限らないため、辺単位で安全に判定する）
    const wallTopY = ASSEMBLY_GROUND_Y + 0.02;
    const wallBottomY = ASSEMBLY_GROUND_Y - ASSEMBLY_CELL_SIZE + 0.02;
    const wallPositions = [];
    loops.forEach(loopKeys => {
        const n = loopKeys.length;
        for (let i = 0; i < n; i++) {
            const k1 = loopKeys[i], k2 = loopKeys[(i + 1) % n];
            const outward = edgeOutward.get(edgeId(k1, k2));
            if (!outward) continue; // ループを閉じるための最後の辺が元の境界辺と一致しない場合はスキップ
            const [cx1, cy1] = cornerGraph.get(k1).pos;
            const [cx2, cy2] = cornerGraph.get(k2).pos;
            const w1 = toWorld(cx1 / 2, cy1 / 2, MAP_LAYER_Z.middle);
            const w2 = toWorld(cx2 / 2, cy2 / 2, MAP_LAYER_Z.middle);
            const e1 = [0, wallBottomY - wallTopY, 0];
            const e2 = [w2.x - w1.x, wallBottomY - wallTopY, w2.z - w1.z];
            const normalX = e1[1] * e2[2] - e1[2] * e2[1];
            const normalZ = e1[0] * e2[1] - e1[1] * e2[0];
            const forward = normalX * outward[0] + normalZ * outward[1] >= 0;
            const top1 = [w1.x, wallTopY, w1.z], bot1 = [w1.x, wallBottomY, w1.z];
            const top2 = [w2.x, wallTopY, w2.z], bot2 = [w2.x, wallBottomY, w2.z];
            const quad = forward
                ? [...top1, ...bot1, ...bot2, ...top1, ...bot2, ...top2]
                : [...bot1, ...top1, ...bot2, ...top1, ...top2, ...bot2];
            wallPositions.push(...quad);
        }
    });

    if (wallPositions.length > 0) {
        assemblyPondWallGeometry = new THREE.BufferGeometry();
        assemblyPondWallGeometry.setAttribute("position", new THREE.Float32BufferAttribute(wallPositions, 3));
        assemblyPondWallGeometry.computeVertexNormals();
        assemblyPondWallMesh = new THREE.Mesh(assemblyPondWallGeometry, assemblyPondMaterial);
        assemblyScene.add(assemblyPondWallMesh);
    }
}

// 「池が一つも表示されていません。陸が上に表示されていないと見えないので、そのせいですかね？」
// との指摘で判明: 陸（assemblyGroundMesh）は900×900の穴の無い1枚の板で、池は「陸より1マス
// 下げる」との指定通りその板よりさらに低い高さに沈めているため、上から見ると常に陸の板
// そのものに完全に隠れて池が一切見えなくなっていた（ユーザー自身の見立て通りの原因）。
// 板のジオメトリを池の形に合わせて毎回切り抜くのは重く複雑なため、alphaMap（透明度だけの
// 別テクスチャ）で「池のマスだけ透明にする」穴あきマスクを作り、陸の板のその部分だけ
// 透過させて下にある池を見せる方式にした（色用のmap/グラス模様テクスチャとは独立した
// スロットなので、地面の色・模様設定とは干渉しない）
// 512だと900マス四方の板全体に対して1マス=0.57pxしか無く、下の穴の大きさ計算の
// Math.max(1,...)フロアが常に働いて「1マス分の穴のつもりが実際は3.5マス分」に
// 膨れ上がり、池の周りに実際の水面より大きく地面が透けた縁（背景が透けて白っぽく
// 見える）ができてしまっていた（「湖の白いところ？」との指摘で判明、実測で確認済み）。
// 1マスが十分な解像度（2px強）を持つよう引き上げて解消する
const ASSEMBLY_GROUND_HOLE_TEXTURE_SIZE = 2048;
let assemblyGroundHoleTexture = null;

function updateAssemblyGroundHoles(pondCellSet, toWorld) {
    if (!assemblyGroundMesh) return;
    const size = ASSEMBLY_GROUND_HOLE_TEXTURE_SIZE;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; // 不透明＝穴なし
    ctx.fillRect(0, 0, size, size);

    if (pondCellSet.size > 0) {
        ctx.fillStyle = "black"; // 透明＝穴（alphaTest=0.5で切り抜く）
        // PlaneGeometry(900,900)をrotation.x=-90度で寝かせているため、
        // ワールドのX→キャンバスX、ワールドのZ→キャンバスYへそのまま対応する
        // （実機で実測して確認済み。詳細はproject_pokoa_map_tab_spec参照）
        const pxPerUnit = size / ASSEMBLY_GROUND_PLANE_SIZE;
        const half = ASSEMBLY_GROUND_PLANE_SIZE / 2;
        // 継ぎ目に隙間が出ないよう1px弱だけ余裕を持たせる（解像度を上げたことで、この
        // 余裕が実際のマスサイズに対して不釣り合いに大きくならないようにした）
        const cellPx = ASSEMBLY_CELL_SIZE * pxPerUnit + 0.75;
        for (const key of pondCellSet) {
            const [gx, gy] = key.split(",").map(Number);
            const world = toWorld(gx, gy, MAP_LAYER_Z.middle);
            const px = (world.x + half) * pxPerUnit;
            const py = (world.z + half) * pxPerUnit;
            ctx.fillRect(px - cellPx / 2, py - cellPx / 2, cellPx, cellPx);
        }
    }

    if (assemblyGroundHoleTexture) assemblyGroundHoleTexture.dispose();
    assemblyGroundHoleTexture = new THREE.CanvasTexture(canvas);
    assemblyGroundMesh.material.alphaMap = pondCellSet.size > 0 ? assemblyGroundHoleTexture : null;
    assemblyGroundMesh.material.needsUpdate = true;
}

let assemblyTrolleyBodyModelLoadStarted = false;
let assemblyTrolleyIcon2DDataURL = null;
let assemblyTrolleyBodyModel = null;

// buildProceduralTrolleyMesh()自体はシーン非依存の純粋なジオメトリ構築のため、
// このスケール算出（幅=1マスに正規化する倍率）も3Dタブを開く前から計算できる。
// キャラクター（models/char.glb）のプリロードをタブ非依存で開始できるようにするため、
// loadAssemblyTrolleyBodyModel()と共通のヘルパーとして切り出した（一度計算したら使い回す）
let assemblyTrolleyFootprintScaleCache = null;
function getAssemblyTrolleyFootprintScale() {
    if (assemblyTrolleyFootprintScaleCache != null) return assemblyTrolleyFootprintScaleCache;
    const probe = buildProceduralTrolleyMesh();
    const box = new THREE.Box3().setFromObject(probe);
    const size = box.getSize(new THREE.Vector3());
    const FOOTPRINT_TARGET = 1.0; // 1マス（ASSEMBLY_CELL_SIZE=1）からはみ出ない範囲で目一杯大きくする基準
    const footprint = Math.max(size.x, size.z);
    assemblyTrolleyFootprintScaleCache = footprint > 0 ? FOOTPRINT_TARGET / footprint : 1;
    return assemblyTrolleyFootprintScaleCache;
}

// 荷台の縁（rim、buildProceduralTrolleyMesh参照）の上面ワールドY。
// rim.position.y(0.59)+厚みの半分(0.08/2=0.04)=0.63がスケール前のローカルY。
// キャラクター（models/char.glb）を荷台に乗せる際の足元の高さ算出に使う
function getAssemblyTrolleyBedTopY() {
    return 0.63 * getAssemblyTrolleyFootprintScale();
}

function loadAssemblyTrolleyBodyModel() {
    if (assemblyTrolleyBodyModelLoadStarted) return;
    assemblyTrolleyBodyModelLoadStarted = true;
    const model = buildProceduralTrolleyMesh();

    // 幅(footprint)が1マスからはみ出ない範囲で目一杯大きくなるよう、X/Zの大きい方を
    // 基準に一律スケールする（trolley.glb版から引き継いだ「マス境界ちょうど」というサイズ基準）
    const scale = getAssemblyTrolleyFootprintScale();
    model.scale.setScalar(scale);

    const scaledBox = new THREE.Box3().setFromObject(model);
    const center = scaledBox.getCenter(new THREE.Vector3());
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= scaledBox.min.y; // 接地面（車輪の下端）をローカルy=0に

    assemblyTrolleyBodyModel = model;
    assemblyPlayMarker.add(model);

    if (mapSettings.showCharacter) loadAssemblyCharacterModel();
    attachAssemblyCharacterIfReady();
}

// トロッコの上に乗せるキャラクター（models/char.glb）。以前「キャラクターは不要」との
// 依頼で本体をGLTFLoaderから現在のプリミティブ組み立て（buildProceduralTrolleyMesh）へ
// 置き換えた際に廃止した機能だが、「トロッコの上にキャラクター載せる載せないの設定を
// ドロワーに追加してほしい」との依頼で、既定オフのドロワー設定（mapSettings.showCharacter）
// として復活させた。3Dプレビュー限定（2Dの簡易アイコンには反映しない）で、
// assemblyPlayMarker配下にトロッコ本体と並べて1回だけ読み込み、以降は表示/非表示の
// 切り替えのみvisibleで行う。
// 57MBと大きいファイルのため、「表示に切り替えた瞬間だけ読み込み開始」だと初回再生時に
// キャラクターだけ数秒遅れて出現するのが目立つ、との指摘を受け、シーン（assemblyScene/
// assemblyPlayMarker）の有無に依存せず読み込みだけは先に始められるようにした
// （3Dタブを開く前、main()の起動処理からでもプリロードできる）。読み込み完了時に
// assemblyPlayMarkerがまだ存在しなければ、attachAssemblyCharacterIfReady()を
// loadAssemblyTrolleyBodyModel()側からも呼び直すことで後から取り付ける
let assemblyCharacterModel = null;
let assemblyCharacterLoadStarted = false;
function loadAssemblyCharacterModel() {
    if (assemblyCharacterLoadStarted) return;
    assemblyCharacterLoadStarted = true;
    ensureThreeLoaded(() => {
        const loader = new window.GLTFLoader();
        loader.load(
            "models/char.glb",
            (gltf) => {
                const model = gltf.scene;
                const box = new THREE.Box3().setFromObject(model);
                const size = box.getSize(new THREE.Vector3());
                // トロッコの足元幅（footprint=1.0）に対する目安の背丈
                const CHARACTER_HEIGHT_TARGET = 1.3;
                const scale = size.y > 0 ? CHARACTER_HEIGHT_TARGET / size.y : 1;
                model.scale.setScalar(scale);

                const scaledBox = new THREE.Box3().setFromObject(model);
                const center = scaledBox.getCenter(new THREE.Vector3());
                model.position.x -= center.x;
                model.position.z -= center.z;
                model.position.y += getAssemblyTrolleyBedTopY() - scaledBox.min.y; // 荷台の上に足を乗せる
                model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

                // 「キャラクターが暗い」との指摘への対策。実測したところ、モデル本体の
                // metalness/roughness/colorを補正してもほぼ見た目が変わらなかった一方、
                // シーン全体の光源を強めると明確に明るくなることを確認した（=素材の問題では
                // なく光量不足）。ただし全体の光源は2D/3Dの明るさを揃えるために既に「実測」で
                // 慎重にチューニング済み（他の要素にも影響するため触りたくない）。そこで、
                // キャラクター自身に追従する局所的なフィルライトだけを追加する方式にした。
                // 「もう少し明るくてもいい」との指摘でintensity/distance/decayを一度強めたが
                // （intensity:10, distance:6, decay:0.7）、そのままだと光の届く範囲が
                // キャラクターの足元より下の地面（トロッコの荷台や真下の地面）まで届いてしまい、
                // 「キャラだけでなく周りの地面まで明るくなってしまっている」と指摘された。
                // three.jsのlight.layers（Object3D.layersの一種）による「特定オブジェクトだけを
                // 照らす」制御を試したが、実測するとレンダラーの光源収集自体がカメラのlayersとの
                // 一致判定で行われるらしく、layersをカメラと不一致にした時点でキャラクター自身への
                // 効果も消えてしまい狙った選択照射にはならなかった（実測で確認済み、機能しない）。
                // 代わりに、光源の高さをキャラクターの胸の高さ付近（足元からy=0.9）まで下げつつ、
                // distance（届く範囲の上限）を1.6まで絞ることで、キャラクター自身は十分照らしつつ
                // 光源からの垂直距離が離れている地面には物理的に届かなくなるよう調整した
                // （実測: 地面付近のピクセル平均輝度がフィルライト無し時と完全に同じ値に戻り、
                // 胴体付近の輝度は約54→75前後を維持）。
                // 「後頭部はもう少し暗くていいです」との指摘を受け再度弱めた。なお実測したところ、
                // このフィルライト（y=0.9・distance=1.6のどちらの設定でも）は頭部（モデル上部）
                // まではそもそも届いておらず、頭部付近のピクセル値はフィルライトの有無に関わらず
                // 完全に同一だった——つまり後頭部の明るさ自体は本フィルライトが原因ではなく、
                // シーン共通の環境光（hemisphere/directional、2D/3Dの明るさを揃えるため触らない
                // 方針）由来と考えられる。ただし全体の見た目を少し抑えたいという要望と解釈し、
                // 胸〜首元まわりに影響するフィルライト自体は控えめに調整した
                // （intensity:15→9, distance:1.6→1.2, position.y:0.9→0.75）
                const fillLight = new THREE.PointLight(0xffffff, 9, 1.2, 1);
                fillLight.position.set(0, 0.75, 0);
                model.add(fillLight);

                // 「軽く縦横にぷよぷよ躍動させたい」との依頼向けに、既存のmodel自身の
                // 位置・スケール（トロッコの荷台の上に足が来るよう既に調整済み）はそのまま
                // 保ち、揺れアニメーション専用の外側Groupで包む。assemblyCharacterModelは
                // 以後このGroupを指す（visible切り替え・assemblyPlayMarkerへの追加は
                // Groupに対して行えばmodel側にも自動的に伝わる）。揺れの実処理は
                // tickAssemblyCharacterWobble()がこのGroup自身のscale/position.yを
                // 毎フレーム書き換えることで実現する（modelのローカル変形には触れない）
                const wobbleGroup = new THREE.Group();
                wobbleGroup.add(model);

                assemblyCharacterModel = wobbleGroup;
                attachAssemblyCharacterIfReady();
            },
            undefined,
            (err) => { console.warn("キャラクターモデル(models/char.glb)の読み込みに失敗しました", err); }
        );
    });
}

// 読み込み済み（assemblyCharacterModel）かつアタッチ先（assemblyPlayMarker）が
// 用意できていれば、シーンに追加する。読み込み完了・3Dタブ初期化のどちらが先でも
// 正しく組み合わさるよう、両方の完了地点から呼ぶ
let assemblyCharacterWarmedUp = false;
function attachAssemblyCharacterIfReady() {
    if (assemblyCharacterModel && assemblyPlayMarker && !assemblyCharacterModel.parent) {
        assemblyPlayMarker.add(assemblyCharacterModel);
    }
    applyAssemblyCharacterVisibility();

    // 「再生を押すとキャラクターが数秒表示されない」との指摘の実測原因：char.glbは
    // 約194万ポリゴンという非常に高精度（AI生成モデルにありがち）なメッシュで、
    // three.jsはオブジェクトが最初に「実際に見える状態でrender()される瞬間」まで
    // GPUへの頂点バッファアップロード・シェーダーのコンパイルを遅延させる。これまでは
    // 再生開始時（assemblyPlayMarker.visible が初めてtrueになる瞬間）にこの初回コストが
    // 発生していたため、まさに「再生を押した直後」に数秒のカクつきとして現れていた
    // （Playwrightで実測: 通常は再生開始から1秒前後でトロッコが表示されるのに対し、
    // このアップロード待ちで4.5〜5.7秒かかっていた）。
    // 対策として、シーンの準備ができ次第——ユーザー操作を待たずに——ここで一度だけ
    // 「一瞬だけ可視にしてrender()を強制発行→元の可視状態に戻して再度render()」という
    // ウォームアップを行い、この重いアップロード処理を体感の無いタイミングに前倒しする
    // （2回目のrender()で表示バッファを正しい状態に戻すため、画面上には一切見えない）
    if (!assemblyCharacterWarmedUp && assemblyCharacterModel && assemblyRenderer && assemblyScene && assemblyCamera) {
        assemblyCharacterWarmedUp = true;
        const wasCharVisible = assemblyCharacterModel.visible;
        const wasMarkerVisible = assemblyPlayMarker.visible;
        assemblyCharacterModel.visible = true;
        assemblyPlayMarker.visible = true;
        assemblyRenderer.render(assemblyScene, assemblyCamera);
        assemblyCharacterModel.visible = wasCharVisible;
        assemblyPlayMarker.visible = wasMarkerVisible;
        assemblyRenderer.render(assemblyScene, assemblyCamera);
    }
}

function applyAssemblyCharacterVisibility() {
    if (assemblyCharacterModel) assemblyCharacterModel.visible = !!mapSettings.showCharacter;
}

// 「キャラクターを軽く縦横にぷよぷよ躍動させたい（Y軸移動そのものより、伸び縮みする
// イメージ）」との依頼への対応。assemblyCharacterModel（＝loadAssemblyCharacterModel内で
// 作る揺れ専用のGroup、実際のモデルはその子）のscale/position.yを、サイン波で
// 継続的に揺らす。トロッコの再生状態に関わらず、キャラクターが表示されている間は
// 常に（アイドル時も）動き続ける——「躍動させる」という依頼の趣旨（常に生き生きして
// 見えること）に合わせた
// 「もう少し弾みを抑えられますか」との指摘（4回目）で振幅を段階的に控えめにした
// （Y:0.07→0.045→0.025→0.012→0.006, XZ:0.045→0.028→0.016→0.008→0.004,
// 位置ゆれ:0.02→0.012→0.006→0.003→0.0015。4回目は「さらに半分程度に」と明示的に確認の上で反映。
// 周波数は「生き生き感」を保つためそのまま）
const ASSEMBLY_CHARACTER_WOBBLE_HZ = 2.2;         // 1秒あたりの伸縮サイクル数
const ASSEMBLY_CHARACTER_WOBBLE_AMOUNT_Y = 0.006; // 縦方向の伸縮量（比率、±0.6%）
const ASSEMBLY_CHARACTER_WOBBLE_AMOUNT_XZ = 0.004; // 横方向の伸縮量（縦と逆位相＝伸びると縮む「ぷよぷよ」感、±0.4%）
const ASSEMBLY_CHARACTER_WOBBLE_BOB_Y = 0.0015;   // 上下のごく軽い位置ゆれ（ワールド単位）
let assemblyCharacterWobblePhase = 0;

function tickAssemblyCharacterWobble(dt) {
    if (!assemblyCharacterModel || !assemblyCharacterModel.visible) return;
    assemblyCharacterWobblePhase += dt * ASSEMBLY_CHARACTER_WOBBLE_HZ * Math.PI * 2;
    const s = Math.sin(assemblyCharacterWobblePhase);
    assemblyCharacterModel.scale.set(
        1 - s * ASSEMBLY_CHARACTER_WOBBLE_AMOUNT_XZ,
        1 + s * ASSEMBLY_CHARACTER_WOBBLE_AMOUNT_Y,
        1 - s * ASSEMBLY_CHARACTER_WOBBLE_AMOUNT_XZ
    );
    // 伸びている（s>0）タイミングだけ少し浮かせ、縮んでいる時は接地させたままにする
    // （ジャンプするたびに一瞬だけ体が伸びて着地でつぶれる、という自然な跳ねに近づける）
    assemblyCharacterModel.position.y = Math.max(0, s) * ASSEMBLY_CHARACTER_WOBBLE_BOB_Y;
}

// 2Dマップのトロッコアイコン用。3D側（loadAssemblyTrolleyBodyModel）はassemblyPlayMarkerが
// できる3Dタブを開いた時にしか呼ばれないため、2D専用タブしか開かないユーザーでは
// いつまでもSVGの簡易アイコンのままになってしまう。そのため3Dシーンの初期化とは切り離し、
// main()から常に（どのタブでも）独立して呼ぶ
let assemblyTrolleyIcon2DLoadStarted = false;
function loadAssemblyTrolleyIcon2D() {
    if (assemblyTrolleyIcon2DLoadStarted) return;
    assemblyTrolleyIcon2DLoadStarted = true;
    ensureThreeLoaded(() => {
        assemblyTrolleyIcon2DDataURL = buildAssemblyTrolleyIcon2DSnapshot(buildProceduralTrolleyMesh());
        // 現在マーカーが表示中なら、SVG仮アイコンのままにせずすぐ差し替える
        // （通常はdrawMapPlayLine()が再生の毎フレーム呼ばれる中で自然に切り替わるが、
        // 一時停止中は次にdrawMapPlayLine()が呼ばれるまで古いままになってしまうため）
        if (currentHighlightBeatIndex !== null) {
            drawMapPlayLine(currentHighlightBeatIndex, currentHighlightBeatT);
        }
    });
}

// 2Dマップのトロッコアイコン用に、トロッコ本体のプリミティブ形状を専用の小さな
// オフスクリーンシーンで1回だけレンダリングし、data URL画像にして返す
function buildAssemblyTrolleyIcon2DSnapshot(sourceModel) {
    const SIZE = 256;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(SIZE, SIZE, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;

    const scene = new THREE.Scene();
    const model = sourceModel;
    scene.add(model);

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    model.position.sub(center);

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const cam = new THREE.OrthographicCamera(-maxDim * 0.75, maxDim * 0.75, maxDim * 0.75, -maxDim * 0.75, 0.01, maxDim * 10);
    cam.position.set(maxDim * 0.9, maxDim * 1.1, maxDim * 0.9);
    cam.lookAt(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f98, 1.1));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
    dirLight.position.set(maxDim, maxDim * 2, maxDim);
    scene.add(dirLight);

    renderer.render(scene, cam);
    const dataURL = renderer.domElement.toDataURL("image/png");
    renderer.dispose();
    return dataURL;
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

// buildAssemblyInstancedMesh()の汎用版。全インスタンス共通の位置リスト+1つの回転/スケールでは
// 表現できない場合（カーブの角の円弧セグメントのように、インスタンスごとに向きが異なる場合）に使う。
// instancesは{position, quaternion, scale}の配列
function buildAssemblyInstancedMeshCustom(instances, geometry, material) {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(instances.length, 1));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    instances.forEach((inst, i) => {
        m.compose(inst.position, inst.quaternion, inst.scale);
        mesh.setMatrixAt(i, m);
    });
    mesh.count = instances.length;
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
}

// 音符マット1枚ごとの黒ぶち（LineSegments2＝fat lines）をまとめてGroupにする。InstancedMeshは
// 三角形描画専用でLineSegments2には使えないため、buildAssemblyInstancedMesh()のように
// 1つのメッシュにまとめることはできず、マット1枚につき1つのLineSegments2を作る
// （ジオメトリ・マテリアルはassemblyPanelEdgesGeometry/Materialを共有するので軽量）
// マット本体の面とぴったり同じ位置に黒ぶちを重ねるとz-fighting（深度値が同点でどちらが
// 手前か不安定になり、線がちらついたり面に埋もれて見えなくなる）が起きるため、ごくわずかに
// （1%）大きくして面より少しだけ外側に浮かせる。凹み演出（setAssemblyPanelPressed）でも
// 黒ぶちの位置・スケールを再計算する際に同じ係数を使うので、共有定数にしてある
const ASSEMBLY_PANEL_EDGE_SCALE_FACTOR = 1.01;
function buildAssemblyEdgeLines(positions, sx, sy, sz, rotY) {
    const group = new THREE.Group();
    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    positions.forEach(pos => {
        const line = new LineSegments2(assemblyPanelEdgesGeometry, assemblyPanelEdgesMaterial);
        line.position.copy(pos);
        line.quaternion.copy(quat);
        line.scale.set(sx * ASSEMBLY_PANEL_EDGE_SCALE_FACTOR, sy * ASSEMBLY_PANEL_EDGE_SCALE_FACTOR, sz * ASSEMBLY_PANEL_EDGE_SCALE_FACTOR);
        group.add(line);
    });
    return group;
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
    updateAssemblySunPosition(); // コンパスの向き（northDirection）が変わっても常に南から光が当たるようにする
    [...assemblyRailSideMeshes, ...assemblyRailRungMeshes, ...assemblySensorMeshes, ...Object.values(assemblyPanelMeshes)].forEach(m => {
        if (m) assemblyScene.remove(m);
    });
    if (assemblySensorDirectionMesh) assemblyScene.remove(assemblySensorDirectionMesh);
    assemblySensorDirectionMesh = null;
    assemblyRailSideMeshes = [];
    assemblyRailRungMeshes = [];
    assemblySensorMeshes = [];
    assemblyPanelMeshes = {};
    if (assemblyPanelEdgesGroup) assemblyScene.remove(assemblyPanelEdgesGroup);
    assemblyPanelEdgesGroup = null;
    assemblyLayerGrids.forEach(g => {
        assemblyScene.remove(g);
        if (g.geometry) g.geometry.dispose();
        if (g.material) {
            if (g.material.map) g.material.map.dispose();
            g.material.dispose();
        }
    });
    assemblyLayerGrids = [];
    // メッシュを作り直すと以前のインスタンスは失われるため、「凹み」の追跡状態もリセットする
    // （リセットしないと、次にupdateAssemblyPlayMarker()が同じbeatIndexで呼ばれた時に
    // 「変化なし」と誤判定し、新しいインスタンスに凹みが反映されなくなる）
    assemblyPanelInstancesByBeat = new Map();
    assemblyPanelPositionsByPitch = {};
    assemblyPanelEdgeOffsetByPitch = {};
    assemblyPressedBeatIndex = null;
    assemblyPanelPressAnimations = new Map();
    // 「音符マットが踏まれたらきらきらエフェクトを出す」用のバースト。作り直しの
    // タイミングで再生中のバーストが残っていても見た目上は問題ないが、他の
    // ビート追跡状態と同じくクリーンな状態から再開するため、ここで破棄しておく
    assemblySparkleEffects.forEach(fx => {
        assemblyScene.remove(fx.points);
        fx.geometry.dispose();
        fx.material.dispose();
    });
    assemblySparkleEffects = [];

    const { grid, extent, beatCenters, beatIndexToRailIndex } = buildMapGrid();
    wrapBeatIndexToRailIndex = beatIndexToRailIndex || [];
    if (!extent) {
        updateAssemblyEmptyState(true);
        assemblyBeatCenters = [];
        assemblyBeatCentersRaw = [];
        if (assemblyPlayMarker) assemblyPlayMarker.visible = false;
        assemblyRenderer.render(assemblyScene, assemblyCamera);
        return;
    }
    updateAssemblyEmptyState(false);
    updateAssemblyCloudRange(extent);

    const centerX = (extent.minX + extent.maxX) / 2;
    const centerY = (extent.minY + extent.maxY) / 2;
    // 「レールを地面につけるか、浮かす（今の状態）かを決める」設定（mapSettings.railFloating）。
    // 層（gz）は中間層=0（レール・センサー・パネルは全てここ。上位/下位層はデータ上
    // レールが複製されているだけで3D描画側では使わない）を基準にASSEMBLY_LAYER_HEIGHTずつ
    // 上下するが、ここへ一律のYオフセットを足すだけで「地面につける/浮かす」を切り替える。
    // 「地面につける」時は、レール本体の底面（中心からRAIL_HEIGHT/2下）がちょうど地面の
    // 高さ(ASSEMBLY_GROUND_Y)に来るようにする。「浮かす」時は底面が地面から1マス分
    // 浮いた高さに来るようにする（固定値0だと実測で1.4マス分浮いており、「地面に固定した
    // グリッドが導入されてから浮きが目立って見える」との指摘を受けて1マス分に調整した）
    const RAIL_HEIGHT = 0.2;
    const railYOffset = mapSettings.railFloating
        ? (ASSEMBLY_GROUND_Y + ASSEMBLY_CELL_SIZE + RAIL_HEIGHT / 2)
        : (ASSEMBLY_GROUND_Y + RAIL_HEIGHT / 2);
    const toWorld = (gx, gy, gz) => new THREE.Vector3(
        (gx - centerX) * ASSEMBLY_CELL_SIZE,
        gz * ASSEMBLY_LAYER_HEIGHT + railYOffset,
        (gy - centerY) * ASSEMBLY_CELL_SIZE
    );

    // 再生中のトロッコ位置マーカー（updateAssemblyPlayMarker）用に、ビートごとのレール
    // 中心座標をワールド座標へ変換しておく。トロッコは物理的な中間層のレール上しか
    // 走らないためz=0固定でよい（2DマップのmapBeatPositionsと同じ役割）
    assemblyBeatCenters = beatCenters.map(c => toWorld(c.x, c.y, 0));
    assemblyBeatCentersRaw = beatCenters;

    // レールはセルごとの向き(data.direction)ごとに分けて集める（トロッコの進行方向に
    // 合わせてレールの見た目の向きも変えるため。direction未設定のセルは無いはずだが、
    // 念のためdefault値としてmapSettings.railDirectionへフォールバックする）
    const railPositionsByDirection = { vertical: [], horizontal: [] };
    // カーブの角（1マスぶんの円弧、data.corner参照）は直線グループには入れず別途集める
    const railCornerCells = []; // {pos, inDir, outDir}
    // センサーもレールと同じくdata.direction（そのセンサーの実際のレール向き）ごとに
    // 分けて集める。InstancedMeshは1つにつき共通のスケールしか持てないため、向きごとに
    // 別のメッシュにする必要がある
    const sensorPositionsByDirection = { vertical: [], horizontal: [] };
    const panelPositionsByPitch = {}; // canonical pitch -> Vector3[]
    const rotY = northDirection * Math.PI / 2;
    const SENSOR_AWAY_OFFSET = 0.08; // 2D側のSENSOR_AWAY_OFFSET_RATIOと同じ比率（ASSEMBLY_CELL_SIZE=1なのでそのまま距離になる）
    // センサーの向き（forwardVec）デバッグ表示用。各センサー位置を中心に、forwardVec沿いへ
    // 2マス分の薄い赤の光線インスタンスを積む（「反応する方向2マスに、うっすら赤い光線を
    // 出してほしい」との依頼、2026-10-01）。mapSettings.showSensorDirectionがtrueの時だけ収集する
    const sensorDirectionInstances = [];
    const showSensorDirection = mapSettings.showSensorDirection;
    // センサー本体（下のSENSOR_CROSS/SENSOR_ALONGと同じ値）のawayVec方向の半幅。光線の
    // 起点をセンサーの中心ではなく本体の縁に合わせるため、この分だけ余計に押し出す
    // （「長さが半マス分足りません」との指摘、2026-10-01。center基準のままだと見た目上の
    // 可視長がセンサー本体に食われて2マスより短く見えていた）
    const SENSOR_CROSS = 0.65;

    for (const [key, data] of grid) {
        const parts = key.split(",").map(Number);
        const pos = toWorld(parts[0], parts[1], parts[2]);
        if (data.type === "rail") {
            // レールはgrid上では上位層/中間層/下位層の3つに同じものが複製されている
            // （2Dマップはどの層を見てもレールの通り道が分かるようにするための仕掛け）が、
            // 3層を同時に表示するこのプレビューではそのまま描くとレールが3本重なって見えて
            // しまう。実際のレールは1本しか無いので、中間層（z===0）ぶんだけ描画する
            if (parts[2] !== 0) continue;
            if (data.corner) {
                railCornerCells.push({ pos, inDir: data.corner.inDir, outDir: data.corner.outDir });
                continue;
            }
            const dir = data.direction === "horizontal" ? "horizontal" : "vertical";
            railPositionsByDirection[dir].push(pos);
        } else if (data.type === "sensor") {
            // 「センサーを枠の中で、レールから少し遠ざける」との依頼に対応。data.awayVecは
            // レール中心から見てこのセンサーが外側へ向かう方向（buildMapGrid参照、2D側の
            // drawMapCellと同じSENSOR_AWAY_OFFSET_RATIOに相当する値をそのまま使う）
            const away = data.awayVec || { dx: 0, dy: 0 };
            const sensorPos = pos.clone().add(new THREE.Vector3(away.dx * SENSOR_AWAY_OFFSET, 0, away.dy * SENSOR_AWAY_OFFSET));
            const sensorDir = data.direction === "horizontal" ? "horizontal" : "vertical";
            sensorPositionsByDirection[sensorDir].push(sensorPos);
            if (showSensorDirection && (away.dx !== 0 || away.dy !== 0)) {
                // センサーが実際に反応する方向は、レールに平行（forwardVec）ではなく、
                // センサーからレール中心線の方（awayVecの逆方向）——トロッコ自体はレール上を
                // 通るため、センサーはそちらを検知する。センサー自身の位置を起点に、
                // その方向へ2マス分だけ片側に伸ばす（中心から両方向ではない）
                // （「今のは真横に両方に伸びていて間違っている」との指摘、2026-10-01）
                const toRailX = -away.dx, toRailY = -away.dy;
                const beamLength = 2;
                const startOffset = SENSOR_CROSS / 2; // センサー本体の縁（中心からの半幅）
                const angle = Math.atan2(toRailX, toRailY);
                sensorDirectionInstances.push({
                    // 起点はセンサー本体の縁（中心からstartOffset先）、そこからさらに
                    // beamLengthぶん先までの中点をボックスの中心位置にする
                    position: sensorPos.clone()
                        .add(new THREE.Vector3(toRailX * (startOffset + beamLength / 2), 0.02, toRailY * (startOffset + beamLength / 2))),
                    quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle),
                    scale: new THREE.Vector3(0.06, 0.02, beamLength), // レール方向へ2マス分、細く平たい光線
                });
            }
        } else if (data.type === "panel") {
            const canon = toCanonicalPitch(data.pitch);
            if (!PITCH_TO_FILE[canon]) continue; // 2D版と同じ「対応画像が無ければ描かない」ガード
            if (!panelPositionsByPitch[canon]) panelPositionsByPitch[canon] = [];
            const instanceIndex = panelPositionsByPitch[canon].length;
            panelPositionsByPitch[canon].push(pos);
            // 「トロッコ通過時に音符マットを凹ませる」演出用に、このインスタンスがどの
            // ビートに属するか記録しておく（updateAssemblyPlayMarker参照）
            if (!assemblyPanelInstancesByBeat.has(data.beatIndex)) assemblyPanelInstancesByBeat.set(data.beatIndex, []);
            assemblyPanelInstancesByBeat.get(data.beatIndex).push({ pitch: canon, index: instanceIndex });
        }
    }
    assemblyPanelPositionsByPitch = panelPositionsByPitch;
    assemblyPanelRotY = rotY;
    // 黒ぶち（assemblyPanelEdgesGroup）は、pitchごとの配列を`Object.values(...).flat()`で
    // つなげた1本のフラットな並びに対応する子オブジェクトを持つ（buildAssemblyEdgeLines参照）。
    // 「凹んだ音符マットに合わせて黒ぶちも凹ませる」ために、(pitch, index)からその
    // フラットな並びの何番目かを逆算できるよう、pitchごとの開始オフセットを記録しておく
    assemblyPanelEdgeOffsetByPitch = {};
    let assemblyPanelEdgeCumOffset = 0;
    Object.entries(panelPositionsByPitch).forEach(([p, arr]) => {
        assemblyPanelEdgeOffsetByPitch[p] = assemblyPanelEdgeCumOffset;
        assemblyPanelEdgeCumOffset += arr.length;
    });

    // レールを「左右の本体（そのまま暗いグレー）＋中央の凹んだ溝＋一定間隔で架かる横木」という
    // 梯子状の見た目に組み立てる（「グレー部分は凹んでいて、かつ梯子状に」との指摘の後、
    // さらに「横部分（横木）はもっと太く、横部分じゃない部分は穴をあけてほしい」との
    // 追加修正を反映）。溝の底を塗りつぶすのはやめ、左右のレール本体の間は横木以外
    // 完全に何も描かない（＝素通しの穴）ことで「穴をあけて」を文字通り実現している。
    // レールの向き（縦/横）はセルごとのdata.directionで決まる（「トロッコが進む方向に
    // 合わせてレールの向きも変える」ため。メインの直線区間はmapSettings.railDirection、
    // 折り返しのカーブ区間はそれと直角、という向きがbuildMapGrid側で既に決まっている）。
    // 1つのInstancedMeshは全インスタンス共通のスケール/回転しか持てないため、縦向き・
    // 横向きのセルをそれぞれ別のInstancedMeshに分けて作る
    // 「黒を太く、グレーは黒より横に突き出す＆凹んでいる」という組み合わせは、黒本体が
    // セル端まで塞ぐ単純な形状だと、重なった部分でグレーが黒の陰に完全に隠れてしまい両立
    // できなかった（凹み＝グレーの上面が黒より低い→重なる範囲では常に黒が上に来て隠す）。
    // ユーザー確認の結果、「黒を細くする」ことで解決する方針に変更: 黒をセル端に付けたまま
    // 太さだけ変えるのではなく、中心からのオフセットは固定し幅だけ細くすることで、黒の
    // 内側（穴）だけでなく外側（セル端寄り）にも隙間ができる。横木（グレー）はその隙間の
    // 内外どちらにも入り込む幅にすることで、黒に隠れない領域（内側の穴・外側の余白）では
    // 素直に見え、黒と重なる中央部分だけ凹んで隠れる＝結果として「黒の脇からグレーが
    // 突き抜けて見える」状態になる
    // （RAIL_HEIGHTは上のtoWorld直前で既に宣言済み。railYOffset計算にも使っている）
    const RAIL_SIDE_OFFSET = 0.3;                             // 中心から黒本体中心までの距離（固定）
    const RAIL_SIDE_WIDTH = 0.15;                             // 黒本体の幅（0.4→0.15、大幅に細く）
    const RAIL_RUNG_WIDTH = 0.92;                             // 横木の幅。黒本体の内側の穴だけでなく外側の余白にも届く広さ
    const RAIL_RUNG_RECESS = 0.08;                            // 黒本体よりグレーの上面を凹ませる量
    const RAIL_RUNG_HEIGHT = RAIL_HEIGHT - RAIL_RUNG_RECESS;
    const RAIL_RUNG_Y_OFFSET = -RAIL_RUNG_RECESS / 2;         // 底面は黒本体と揃え、上面だけ凹ませる
    const RAIL_RUNG_LENGTH = 0.22;                            // 横木の（レール方向の）太さ
    const RAIL_RUNG_OFFSETS = [-0.25, 0.25];                  // 1マスあたり2本。隣接マスと合わせ0.5間隔の等間隔になる（0.22幅でも重ならない）

    ["vertical", "horizontal"].forEach(dir => {
        const positions = railPositionsByDirection[dir];
        if (positions.length === 0) return;
        const dirIsVertical = dir === "vertical";

        const sideAxis = dirIsVertical ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        const railSidePositions = [];
        positions.forEach(p => {
            railSidePositions.push(p.clone().addScaledVector(sideAxis, RAIL_SIDE_OFFSET));
            railSidePositions.push(p.clone().addScaledVector(sideAxis, -RAIL_SIDE_OFFSET));
        });
        const sideMesh = buildAssemblyInstancedMesh(
            railSidePositions, assemblyUnitBoxGeometry, assemblyRailMaterial,
            dirIsVertical ? RAIL_SIDE_WIDTH : 1, RAIL_HEIGHT, dirIsVertical ? 1 : RAIL_SIDE_WIDTH, 0
        );
        assemblyScene.add(sideMesh);
        assemblyRailSideMeshes.push(sideMesh);

        const railAxis = dirIsVertical ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
        const railRungPositions = [];
        positions.forEach(p => {
            RAIL_RUNG_OFFSETS.forEach(offset => {
                railRungPositions.push(p.clone().addScaledVector(railAxis, offset).add(new THREE.Vector3(0, RAIL_RUNG_Y_OFFSET, 0)));
            });
        });
        const rungMesh = buildAssemblyInstancedMesh(
            railRungPositions, assemblyUnitBoxGeometry, assemblyRailRungMaterial,
            dirIsVertical ? RAIL_RUNG_WIDTH : RAIL_RUNG_LENGTH, RAIL_RUNG_HEIGHT, dirIsVertical ? RAIL_RUNG_LENGTH : RAIL_RUNG_WIDTH, 0
        );
        assemblyScene.add(rungMesh);
        assemblyRailRungMeshes.push(rungMesh);
    });

    // カーブの角（railCornerCells、1マスぶんの円弧）も同じ見た目（本体2本+横木2本）を、
    // 弧に沿って並べた短いセグメントの箱で近似して描く（2D側のdrawMapRailCornerと同じ
    // computeRailCornerArc()の幾何計算を使う）。1つのInstancedMeshは全インスタンス共通の
    // 回転しか持てないため、buildAssemblyInstancedMesh()ではなく、セグメントごとに
    // 個別の位置・回転行列を組み立てるbuildAssemblyInstancedMeshCustom()を使う
    const CORNER_ARC_SEGMENTS = 6;
    if (railCornerCells.length > 0) {
        const sideInstances = [];
        const rungInstances = [];
        const upAxis = new THREE.Vector3(0, 1, 0);
        railCornerCells.forEach(({ pos, inDir, outDir }) => {
            const { r, ccx, ccy, startAngle, sweep, anticlockwise } = computeRailCornerArc(inDir, outDir);
            const centerX = pos.x + ccx * ASSEMBLY_CELL_SIZE;
            const centerZ = pos.z + ccy * ASSEMBLY_CELL_SIZE;
            // 弧に沿って進む向き（tがtからt+dtへ増える方向）は、sweepが負(anticlockwise)なら
            // 角度が減る向きなので、接線方向は角度から-90度、正なら+90度
            const tangentSign = anticlockwise ? -1 : 1;
            const segSweep = sweep / CORNER_ARC_SEGMENTS;

            // レール本体: 内側・外側それぞれの半径で、弧をCORNER_ARC_SEGMENTS個の短い箱に分割
            [r - RAIL_SIDE_OFFSET, r + RAIL_SIDE_OFFSET].forEach(radius => {
                // 隣接セグメント間に隙間ができないよう、コード長よりわずかに長めにする
                const segLen = radius * Math.abs(segSweep) * ASSEMBLY_CELL_SIZE * 1.15;
                for (let s = 0; s < CORNER_ARC_SEGMENTS; s++) {
                    const angle = startAngle + segSweep * (s + 0.5);
                    const tangentAngle = angle + tangentSign * Math.PI / 2;
                    sideInstances.push({
                        position: new THREE.Vector3(
                            centerX + radius * Math.cos(angle) * ASSEMBLY_CELL_SIZE,
                            pos.y,
                            centerZ + radius * Math.sin(angle) * ASSEMBLY_CELL_SIZE
                        ),
                        quaternion: new THREE.Quaternion().setFromAxisAngle(upAxis, Math.atan2(Math.cos(tangentAngle), Math.sin(tangentAngle))),
                        scale: new THREE.Vector3(RAIL_SIDE_WIDTH, RAIL_HEIGHT, segLen),
                    });
                }
            });

            // 横木（弧の1/3・2/3地点に、半径方向を向けて1本ずつ）
            [1 / 3, 2 / 3].forEach(t => {
                const angle = startAngle + sweep * t;
                rungInstances.push({
                    position: new THREE.Vector3(
                        centerX + r * Math.cos(angle) * ASSEMBLY_CELL_SIZE,
                        pos.y + RAIL_RUNG_Y_OFFSET,
                        centerZ + r * Math.sin(angle) * ASSEMBLY_CELL_SIZE
                    ),
                    quaternion: new THREE.Quaternion().setFromAxisAngle(upAxis, Math.atan2(Math.cos(angle), Math.sin(angle))),
                    scale: new THREE.Vector3(RAIL_RUNG_LENGTH, RAIL_RUNG_HEIGHT, RAIL_RUNG_WIDTH),
                });
            });
        });

        const cornerSideMesh = buildAssemblyInstancedMeshCustom(sideInstances, assemblyUnitBoxGeometry, assemblyRailMaterial);
        assemblyScene.add(cornerSideMesh);
        assemblyRailSideMeshes.push(cornerSideMesh);

        const cornerRungMesh = buildAssemblyInstancedMeshCustom(rungInstances, assemblyUnitBoxGeometry, assemblyRailRungMaterial);
        assemblyScene.add(cornerRungMesh);
        assemblyRailRungMeshes.push(cornerRungMesh);
    }

    // センサーは正方形ではなく、レール（トロッコの通り道）に直角な方向、つまり長辺が
    // レールの方を向くように長い長方形にする（2D側のSENSOR_CROSS_RATIO/SENSOR_ALONG_RATIOと
    // 同じ比率）。長辺の軸はマップ全体のrailDirection設定で一律に決めるのではなく、レールと
    // 同じくセンサーごとのdata.direction（そのセンサーの実際のレール向き）で決める——
    // 「センサーはレールのトロッコの方に向けないとダメ」との指摘、2026-09-29。
    // InstancedMeshは1つにつき共通のスケールしか持てないため、レールと同様に向きごとに
    // 別メッシュにする
    const SENSOR_ALONG = 0.35; // SENSOR_CROSSは上でセンサー向きデバッグ光線と共有するため定義済み
    ["vertical", "horizontal"].forEach(dir => {
        const positions = sensorPositionsByDirection[dir];
        if (positions.length === 0) return;
        const dirIsVertical = dir === "vertical";
        const mesh = buildAssemblyInstancedMesh(
            positions, assemblyUnitBoxGeometry, assemblySensorMaterial,
            dirIsVertical ? SENSOR_CROSS : SENSOR_ALONG, 0.25, dirIsVertical ? SENSOR_ALONG : SENSOR_CROSS, 0
        );
        assemblyScene.add(mesh);
        assemblySensorMeshes.push(mesh);
    });
    if (showSensorDirection && sensorDirectionInstances.length > 0) {
        assemblySensorDirectionMesh = buildAssemblyInstancedMeshCustom(sensorDirectionInstances, assemblyUnitBoxGeometry, assemblySensorDirectionMaterial);
        assemblySensorDirectionMesh.castShadow = false;
        assemblySensorDirectionMesh.receiveShadow = false;
        assemblyScene.add(assemblySensorDirectionMesh);
    }
    Object.entries(panelPositionsByPitch).forEach(([pitch, positions]) => {
        const mesh = buildAssemblyInstancedMesh(positions, assemblyUnitBoxGeometry, getAssemblyPanelMaterials(pitch), 0.95, 0.15, 0.95, rotY);
        assemblyPanelMeshes[pitch] = mesh;
        assemblyScene.add(mesh);
    });
    const allPanelPositions = Object.values(panelPositionsByPitch).flat();
    assemblyPanelEdgesGroup = buildAssemblyEdgeLines(allPanelPositions, 0.95, 0.15, 0.95, rotY);
    assemblyScene.add(assemblyPanelEdgesGroup);

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
    // グリッド線は中間層（レールが実在する層）だけに表示する（上位層・下位層には出さない）。
    //
    // 【2026-09-17の経緯、長い試行錯誤】(1)当初はレールの高さに追従する1枚のTHREE.GridHelper
    // だけだったが、「浮かす」モードではレールが地面から離れているため地面ブロック上に
    // グリッドが乗らなかった。(2)地面ブロック専用の2枚目を重ねたところ、「浮かす」時に
    // 2枚の高さが離れすぎて視差で線がズレ「二重に見える」不具合になった。ユーザーの
    // 要望は「レールの高さは関係なく、緑・茶色どちらの地面にも同じグリッドが1枚乗ること」
    // と判明したため、レール追従をやめ常に地面ブロックと同じ高さの1枚に統合した。
    // (3)地面ブロックの高さちょうどに揃えたところ、地面ブロック側のマテリアルが本体の
    // 地面とのz-fighting対策でpolygonOffset（factor/units: -4）によりカメラ側へ
    // 引き寄せられているため、同じ高さのGridHelper（LINEプリミティブ）は押し負けて隠れて
    // しまう。WebGLのpolygonOffsetは塗りつぶし（三角形）にしか効かない。(4)このためグリッド線を
    // 焼き込んだキャンバステクスチャを貼った平面メッシュ（塗りつぶし＝三角形）に置き換え、
    // polygonOffsetが使えるようにしたが、薄い線をテクスチャの透明度（alpha）で表現する
    // 方式そのものが、mipmap（縮小版テクスチャの自動生成）絡みの問題を次々に引き起こした
    // ——縮小時にalphaTestの閾値を割って完全消失（近くでしか見えない）、mipmap無効化の
    // 副作用で大きい曲だと線が点々になる、テクスチャがNPOTサイズだとmipmap生成自体が
    // 壊れて地面全体が灰色の靄になる、透明背景のRGBが線の色と混ざって縮小時に色がくすむ、
    // その対策（背景RGBを線と揃える）も canvas の内部実装（alpha=0では透明合成時にRGB情報が
    // 失われる）でそもそも効いていなかった、等。texture+alphaという表現方式自体が
    // 何重にも脆いと判明したため、テクスチャを使わず、地面ブロック・池と同じ「実際の
    // ジオメトリ（薄い板ポリゴン）を敷き並べる」方式に切り替えた。線の透明度に一切頼らない
    // ため、mipmap・alphaTest関連の問題が構造的に起こり得ない
    const gridWorldSize = gridSize * ASSEMBLY_CELL_SIZE;
    const gridHalf = gridWorldSize / 2;
    const gridLineWidth = Math.max(0.025, ASSEMBLY_CELL_SIZE * 0.03); // 線の太さ（ワールド単位）
    const gridLineY = ASSEMBLY_GROUND_Y + 0.02; // 地面ブロックと完全に同じ高さ（浮いて見えない）
    const gridPositions = [];
    const addGridQuad = (x1, z1, x2, z2, x3, z3, x4, z4) => {
        gridPositions.push(x1, gridLineY, z1, x2, gridLineY, z2, x3, gridLineY, z3);
        gridPositions.push(x1, gridLineY, z1, x3, gridLineY, z3, x4, gridLineY, z4);
    };
    const half = gridLineWidth / 2;
    for (let i = 0; i <= gridSize; i++) {
        const xi = -gridHalf + i * ASSEMBLY_CELL_SIZE;
        addGridQuad(xi - half, -gridHalf, xi + half, -gridHalf, xi + half, gridHalf, xi - half, gridHalf);
        const zi = -gridHalf + i * ASSEMBLY_CELL_SIZE;
        addGridQuad(-gridHalf, zi - half, gridHalf, zi - half, gridHalf, zi + half, -gridHalf, zi + half);
    }
    const helperGeometry = new THREE.BufferGeometry();
    helperGeometry.setAttribute("position", new THREE.Float32BufferAttribute(gridPositions, 3));
    // 三角形の頂点順（＝法線の向き）が下向きになっており、上から見下ろすカメラからは
    // 背面カリングで見えなくなっていた（実測で判明）。side:DoubleSideで両面描画にして解消する
    const helperMaterial = new THREE.MeshBasicMaterial({
        color: 0xd8d8d8, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
    });
    const helper = new THREE.Mesh(helperGeometry, helperMaterial);
    // 頂点は既にXZ平面（ワールドのX/Z軸）で計算済みのため、回転は不要
    helper.position.set(offsetX, 0, offsetZ);
    helper.visible = assemblyGridVisible; // #assemblyGridToggleBtnでの設定を再構築後も保つ
    assemblyScene.add(helper);
    assemblyLayerGrids.push(helper);

    // 池（大・中・小3個、トラック外側のランダムな位置に配置）。地面ブロックが池の上に
    // 重ならないよう避けられるようにするため、地面ブロックより先に生成する
    generateAssemblyPonds(extent, toWorld);
    // 池を沈めた分、陸の板がその上を覆って隠してしまわないよう、池のマスだけ陸を透明にする
    updateAssemblyGroundHoles(assemblyPondCellSet, toWorld);
    // 地面ブロックの色分け（黄土色の群れをランダム配置。「グリッドエリアでも茶色が混ざって
    // もいい」との指摘で、実際にレール・センサー・音符マットが無いマスであればグリッド
    // エリアの内側にも生成できるようにした——gridを渡し、実際に使われているマスだけを
    // 避ける）。「茶色ブロックには草ははやさないでください」との指摘対応で、木・草・花より
    // 先に生成し、そのマス目集合(assemblyGroundBlockCellSet)を木・草・花側が避けられるようにする
    generateAssemblyGroundBlocks(extent, toWorld, grid);
    // 木・草・花（陸の装飾）。トラックの外周の空きマスに散りばめる
    generateAssemblyDecorations(extent, toWorld);

    // 影用のshadow.camera（光源から見た正射影カメラ）の見える範囲を、内容の実際の広がりに
    // 合わせて毎回更新する。既定値（左右上下±5の狭い正方形）のままだと、原点付近から外れた
    // 音符マット/レールがその範囲外になり影が出なかったり、範囲の境界で不自然に切れたりする
    // （曲が長い/マス数が多いほど顕著）。中心はtoWorld()により常に原点なので、半径は
    // グリッドの対角ぶんの広さを取れば全体を確実に覆える
    // 「影が途中で切断されているように見える」との指摘のため、トラック自体の広さだけでなく
    // 木・草・花の装飾が広がる範囲（ASSEMBLY_DECORATION_MARGIN）もshadow.cameraの可視範囲に
    // 含める（トラックが小さいと装飾の影の方が範囲外になり、境界で不自然に切れて見えていた）。
    // 以前はここに雲の表示範囲（assemblyCloudRange）も含めていたが、「雲をマップ全体に
    // 表示」の対応でその範囲がASSEMBLY_GROUND_BLOCK_MARGIN=300ぶんまで大きく広がった結果、
    // 同じ解像度のシャドウマップがより広い面積を覆うことになりテクセル密度が下がって
    // しまい、「レール/トロッコ/キャラクター/音符マットの影が薄れた」との指摘につながった。
    // 雲の影はASSEMBLY_CLOUD_LAYERで分離したassemblyCloudSun側が別途担当するため、ここでは
    // 含めない（雲以外の内容だけを考えればよく、装飾（120マス）の方がずっと狭いので、
    // このライトのテクセル密度をずっと高く保てる）
    const shadowHalfExtent = Math.max(
        extent.maxX - extent.minX, extent.maxY - extent.minY
    ) * ASSEMBLY_CELL_SIZE / 2 + ASSEMBLY_DECORATION_MARGIN;
    assemblySun.shadow.camera.left = -shadowHalfExtent;
    assemblySun.shadow.camera.right = shadowHalfExtent;
    assemblySun.shadow.camera.top = shadowHalfExtent;
    assemblySun.shadow.camera.bottom = -shadowHalfExtent;
    assemblySun.shadow.camera.updateProjectionMatrix();

    // 雲専用ライト（assemblyCloudSun）の影範囲は、雲の表示範囲（assemblyCloudRange、
    // ASSEMBLY_GROUND_BLOCK_MARGINぶんまで広がりうる）に合わせて広く取る。雲の影は元々
    // ぼんやりした大きなものなので、テクセル密度が粗くても見た目上は問題にならない
    const cloudShadowHalfExtent = assemblyCloudRange + 30;
    assemblyCloudSun.shadow.camera.left = -cloudShadowHalfExtent;
    assemblyCloudSun.shadow.camera.right = cloudShadowHalfExtent;
    assemblyCloudSun.shadow.camera.top = cloudShadowHalfExtent;
    assemblyCloudSun.shadow.camera.bottom = -cloudShadowHalfExtent;
    assemblyCloudSun.shadow.camera.updateProjectionMatrix();

    // 「一列の最大センサー数」やレール方向はマップ全体の縦横比を大きく変えるため、
    // 前回フレーミングした時から変わっていたら、通常は編集のたびに視点をリセットしない
    // 方針を例外的に上書きして再フレーミングする（assemblyFramedWrapValue等の説明参照）
    if (assemblyCameraFramed &&
        (assemblyFramedWrapValue !== mapSettings.wrapValue || assemblyFramedRailDirection !== mapSettings.railDirection)) {
        assemblyCameraFramed = false;
    }
    if (!assemblyCameraFramed) {
        frameAssemblyCamera(extent);
        assemblyCameraFramed = true;
        assemblyFramedWrapValue = mapSettings.wrapValue;
        assemblyFramedRailDirection = mapSettings.railDirection;
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

    // 「トロッコが通過するとき、反応する音符マットを凹ませる」演出。beatIndexが
    // 変化した時だけ、前のビートの凹みを戻し新しいビートの音符マットを凹ませる
    // （毎フレーム同じbeatIndexで無駄に行列を再計算しないため）
    if (beatIndex !== assemblyPressedBeatIndex) {
        if (assemblyPressedBeatIndex !== null) setAssemblyPanelPressed(assemblyPressedBeatIndex, false);
        if (beatIndex !== null) setAssemblyPanelPressed(beatIndex, true);
        assemblyPressedBeatIndex = beatIndex;
    }

    const posA = beatIndex == null ? null : assemblyBeatCenters[beatIndex];
    const rawAnchor = beatIndex == null ? null : assemblyBeatCentersRaw[beatIndex];
    if (!posA || !rawAnchor) {
        assemblyPlayMarker.visible = false;
        resetTrolleyDisplayState();
        return;
    }

    // 返ってくるのはtoWorld変換前のグリッド論理座標なので、rawAnchor→posAの対応
    // （平行移動+ASSEMBLY_CELL_SIZE倍）を使ってワールド座標に変換する
    const resolvedRaw = resolveTrolleyDisplayPosition(assemblyBeatCentersRaw, beatIndex, t, ASSEMBLY_CELL_SIZE);
    assemblyPlayMarker.position.set(
        posA.x + (resolvedRaw.x - rawAnchor.x) * ASSEMBLY_CELL_SIZE,
        posA.y,
        posA.z + (resolvedRaw.y - rawAnchor.y) * ASSEMBLY_CELL_SIZE
    );
    assemblyPlayMarker.position.y += ASSEMBLY_TROLLEY_MARKER_Y_OFFSET;
    assemblyPlayMarker.visible = true;

    // 進行方向へ向かせる。resolveTrolleyDisplayPosition側が、実際に移動した瞬間の向きを
    // （動きが無い/ごく僅かな瞬間は直前の向きを保持したまま）返してくれるので、それをそのまま使う
    // （停止直後や折り返しの瞬間に車体が不自然な向きに一瞬回転しないようにするため）
    if (!assemblyMarkerLastForward) assemblyMarkerLastForward = new THREE.Vector3(0, 0, 1);
    if (resolvedRaw.forward) {
        assemblyMarkerLastForward.set(resolvedRaw.forward.x, 0, resolvedRaw.forward.y);
    }
    // 「同じアングルでしばらく経つと一瞬カクっとなる、おそらくどのアングルでも1回」との
    // 報告の原因調査で判明: レール折り返し等で進行方向が急変する瞬間、この向き自体は
    // （上のロジックにより）正しく求まるが、rotation.yへの反映がatan2の結果を毎フレーム
    // 直接代入するだけ（角度の補間なし）だったため、車体の向きが1フレームで瞬時に
    // 切り替わっていた。折り返しはトラック中に数える程度しか無いため「1回」という体感と
    // 一致し、カメラのモードに関わらず車体そのものが瞬間回転するため「どのアングルでも」
    // 見えていたと考えられる（トロッコ視点等の近接カメラは今回別途カメラ位置をトロッコの
    // 移動ぶんだけ平行移動させる方式に変えたため、以前のように車体の回転につられて
    // カメラごと動いていた時よりも、車体だけが瞬間回転する様子が目立ちやすくなった
    // 可能性もある）。最大角速度を設け、目標の向きへ滑らかに回転させるよう修正した
    // （最短経路で回るよう、角度差を-π〜πに正規化してから制限する）
    const targetRotationY = Math.atan2(assemblyMarkerLastForward.x, assemblyMarkerLastForward.z);
    const nowTime = performance.now();
    const rotDt = assemblyMarkerLastRotationTime == null ? 0 : Math.min(0.1, (nowTime - assemblyMarkerLastRotationTime) / 1000);
    assemblyMarkerLastRotationTime = nowTime;
    const ASSEMBLY_MARKER_MAX_ROTATION_SPEED = Math.PI * 4; // ラジアン/秒（半回転を約0.125秒で追従できる速さ）
    let rotDiff = targetRotationY - assemblyPlayMarker.rotation.y;
    rotDiff = ((rotDiff + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    const maxStep = ASSEMBLY_MARKER_MAX_ROTATION_SPEED * rotDt;
    if (rotDt === 0 || Math.abs(rotDiff) <= maxStep) {
        assemblyPlayMarker.rotation.y = targetRotationY;
    } else {
        assemblyPlayMarker.rotation.y += Math.sign(rotDiff) * maxStep;
    }
}

// beatIndexに鳴る音符マット（1つまたは和音で複数）を凹ませる/元に戻す。
// InstancedMeshの該当インスタンスだけ、行列（位置・スケール）と色を差し替える。
// 「へこんだのが目立たない」「エフェクトが全然わかりません」との指摘を受け、実測
// （後述）で仕組み自体は正しく動作していることを確認した上で、効果の大きさそのものを
// 大幅に強化した:
// (1)沈み込む量をさらに増やす、(2)縦方向を大きく押しつぶす、(3)横方向（X/Z）には
// 逆に広げる（正真正銘の「押しつぶし」の見た目にすると同時に、真上から見ても
// footprintが広がって見えるようにする。高さだけの変化は見下ろすカメラだと
// ほぼ分からないため、これが「全然分からない」の主因だったと考えられる）、
// (4)per-instance colorをより強い暖色にして遠目にも分かる色の変化にする。
// THREE.Vector3/THREE.Colorは、window.THREEが非同期に用意されるまで参照できないため、
// （initAssemblyScene()以外の）トップレベルのconstで生成してはいけない（ensureThreeLoaded
// 参照）。ここは数値だけ持ち、実際のTHREEオブジェクトはapplyAssemblyPanelPressAmount()の中で作る
const ASSEMBLY_PANEL_PRESS_DEPTH = 0.32;
// 「レールを地面につけた場合、音符マットが踏まれたときに地面へ埋まってしまう」との
// 指摘対応。「地面につける」時はマットの基準位置(basePos.y)自体が地面すれすれの高さに
// なるため、通常の沈み込み量(0.32)をそのまま適用すると地面の下まで潜ってしまう。
// マットの下端と地面の間にこのぶんだけ余白を残すようクランプする（「浮かす」時は
// 基準位置が十分高いため、このクランプは実質発動しない）
const ASSEMBLY_PANEL_PRESS_MIN_GROUND_CLEARANCE = 0.05;
const ASSEMBLY_PANEL_PRESS_SCALE_Y = 0.22; // 縦方向のスケール（大きく押しつぶす）
const ASSEMBLY_PANEL_PRESS_SCALE_XZ = 1.3; // 横方向のスケール（押しつぶされて広がる。真上から見てもfootprintの変化で分かる）
const ASSEMBLY_PANEL_BASE_SCALE_XYZ = [0.95, 0.15, 0.95];
const ASSEMBLY_PANEL_PRESSED_COLOR_RGB = [2.2, 1.6, 0.4]; // 強めの暖色に光らせる（1より大きい成分は明るく発光して見える）
// 「アニメーションを滑らかに」との依頼を受けて一度は押し込み・戻りの両方をアニメーション化
// したが、直後に「踏み込む瞬間は一瞬に、戻る時は今のままで」と修正された。踏み込みは
// setAssemblyPanelPressed()内でamountを即座に1にする（アニメーションさせない）ため、
// ここに残るdurationは戻り（1→0）専用
const ASSEMBLY_PANEL_RELEASE_DURATION_S = 0.18;
const ASSEMBLY_PANEL_PRESS_SETTLE_EPS = 0.001;
let assemblyPanelPressAnimations = new Map(); // "pitch:index" -> {pitch, index, amount, target}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// amount(0..1)に応じてマット本体＋黒ぶちの行列・色を補間して書き込む
function applyAssemblyPanelPressAmount(pitch, index, amount) {
    const mesh = assemblyPanelMeshes[pitch];
    const basePos = assemblyPanelPositionsByPitch[pitch]?.[index];
    if (!mesh || !basePos) return;
    const [baseSx, baseSy, baseSz] = ASSEMBLY_PANEL_BASE_SCALE_XYZ;
    const eased = easeOutCubic(Math.max(0, Math.min(1, amount)));

    const scaleY = baseSy - (baseSy - baseSy * ASSEMBLY_PANEL_PRESS_SCALE_Y) * eased;
    const scaleXZ = 1 + (ASSEMBLY_PANEL_PRESS_SCALE_XZ - 1) * eased;
    // 「地面につける」設定時は、地面から沈み込める余地（clearance）を超えないよう
    // 沈み込み量をクランプする（「浮かす」設定時はbasePos.yが十分高く、常に
    // ASSEMBLY_PANEL_PRESS_DEPTHが上限のまま実質クランプされない）
    const clearance = basePos.y - ASSEMBLY_GROUND_Y - ASSEMBLY_PANEL_PRESS_MIN_GROUND_CLEARANCE;
    const pressDepth = mapSettings.railFloating
        ? ASSEMBLY_PANEL_PRESS_DEPTH
        : Math.max(0, Math.min(ASSEMBLY_PANEL_PRESS_DEPTH, clearance));
    const pos = basePos.clone();
    pos.y += ((baseSy - scaleY) / 2 - pressDepth) * eased;
    const scale = new THREE.Vector3(baseSx * scaleXZ, scaleY, baseSz * scaleXZ);
    const quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), assemblyPanelRotY);
    const color = new THREE.Color(
        1 + (ASSEMBLY_PANEL_PRESSED_COLOR_RGB[0] - 1) * eased,
        1 + (ASSEMBLY_PANEL_PRESSED_COLOR_RGB[1] - 1) * eased,
        1 + (ASSEMBLY_PANEL_PRESSED_COLOR_RGB[2] - 1) * eased,
    );

    const m = new THREE.Matrix4();
    m.compose(pos, quat, scale);
    mesh.setMatrixAt(index, m);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.setColorAt(index, color);
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    // 「凹んでいても黒ぶちは凹まない」との指摘に対応。黒ぶち（LineSegments2、
    // InstancedMeshではなく普通のObject3D）を、マット本体と同じ位置・スケールに
    // 追従させる（ASSEMBLY_PANEL_EDGE_SCALE_FACTORぶんだけ一回り大きくするのは
    // 元のbuildAssemblyEdgeLines()と同じ理由＝z-fighting防止）
    const edgeOffset = assemblyPanelEdgeOffsetByPitch[pitch];
    const edgeLine = (edgeOffset !== undefined && assemblyPanelEdgesGroup)
        ? assemblyPanelEdgesGroup.children[edgeOffset + index]
        : null;
    if (edgeLine) {
        edgeLine.position.copy(pos);
        edgeLine.quaternion.copy(quat);
        edgeLine.scale.set(scale.x * ASSEMBLY_PANEL_EDGE_SCALE_FACTOR, scale.y * ASSEMBLY_PANEL_EDGE_SCALE_FACTOR, scale.z * ASSEMBLY_PANEL_EDGE_SCALE_FACTOR);
    }
}

// beatIndexに鳴る音符マット（1つまたは和音で複数）を凹ませる/元に戻す。
// 「踏み込む瞬間は一瞬に」との指定で、押す時（pressed=true）はアニメーションさせず
// その場でamount=1にする。戻る時（pressed=false）だけtickAssemblyPanelPressAnimations()
// による補間アニメーション対象にする
function setAssemblyPanelPressed(beatIndex, pressed) {
    const entries = assemblyPanelInstancesByBeat.get(beatIndex);
    if (!entries) return;
    entries.forEach(({ pitch, index }) => {
        const key = `${pitch}:${index}`;
        if (pressed) {
            assemblyPanelPressAnimations.delete(key);
            applyAssemblyPanelPressAmount(pitch, index, 1);
            // 「音符マットが踏まれたらきらきらエフェクトを出してほしい」との依頼で追加。
            // 踏み込み（凹み）と同じタイミング＝毎回一瞬で起きる方でだけ発生させる
            // （戻りアニメーション側では発生させない）
            const basePos = assemblyPanelPositionsByPitch[pitch]?.[index];
            if (basePos) spawnAssemblySparkleEffect(basePos);
            return;
        }
        // 押し込みは常に瞬時にamount=1へ飛ぶため、戻り始めのamountは常に1でよい
        assemblyPanelPressAnimations.set(key, { pitch, index, amount: 1, target: 0 });
    });
}

// 音符マットが踏まれた瞬間の「きらきらエフェクト」。マットの上面付近から加法合成の
// 光の粒が数個弾け、上に舞いながらふわっと消える。1バーストにつき専用のTHREE.Points
// （ジオメトリ・マテリアルとも専用インスタンス、テクスチャだけ共有）を作り、
// tickAssemblySparkleEffects()が寿命に応じて位置・不透明度・サイズを更新し、
// 寿命が尽きたら破棄する
// 「もう少し派手でもいい」との指摘で、粒の数・サイズ・飛び散る速さ・寿命を強化し、
// 単色（金）から数色（金/白/ピンク/水色）を混ぜた見た目に変更した
const ASSEMBLY_SPARKLE_PARTICLE_COUNT = 22;
const ASSEMBLY_SPARKLE_LIFETIME_S = 0.65;
const ASSEMBLY_SPARKLE_BASE_SIZE = 0.26;
const ASSEMBLY_SPARKLE_GRAVITY = 2.6;
// 粒ごとの色のバリエーション（暖色の金・白を主体に、たまにピンク/水色を混ぜて華やかに）
const ASSEMBLY_SPARKLE_COLORS = [
    [1, 0.86, 0.42], [1, 0.86, 0.42], [1, 0.95, 0.75], [1, 1, 1],
    [1, 0.6, 0.75], [0.65, 0.9, 1],
];
// 極端に音の詰まった曲・低フレームレート環境でも際限なく増え続けないようにする上限
const ASSEMBLY_SPARKLE_MAX_ACTIVE = 60;
let assemblySparkleEffects = []; // {points, geometry, material, velocities, age}

// キラキラ用の光の粒テクスチャ（中心が明るく縁がなじむ放射状グラデーション）を
// 遅延生成し使い回す。THREE.CanvasTextureはTHREEが読み込まれてから触る必要があるため、
// 初回のspawnAssemblySparkleEffect呼び出し時（＝3Dシーンが既にある時）まで生成を遅らせる
let assemblySparkleTexture = null;
function getAssemblySparkleTexture() {
    if (assemblySparkleTexture) return assemblySparkleTexture;
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,240,190,0.9)");
    grad.addColorStop(1, "rgba(255,240,190,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    assemblySparkleTexture = new THREE.CanvasTexture(canvas);
    return assemblySparkleTexture;
}

function spawnAssemblySparkleEffect(basePos) {
    if (!assemblyScene || assemblySparkleEffects.length >= ASSEMBLY_SPARKLE_MAX_ACTIVE) return;
    const n = ASSEMBLY_SPARKLE_PARTICLE_COUNT;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    const velocities = [];
    for (let i = 0; i < n; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.9 + Math.random() * 1.6; // 「もう少し派手に」で飛び散る範囲を拡大
        const px = basePos.x + (Math.random() - 0.5) * 0.3;
        const py = basePos.y + 0.12 + Math.random() * 0.05; // マット上面付近から発生
        const pz = basePos.z + (Math.random() - 0.5) * 0.3;
        positions[i * 3] = px;
        positions[i * 3 + 1] = py;
        positions[i * 3 + 2] = pz;
        velocities.push({ x: Math.cos(angle) * speed, y: 1.8 + Math.random() * 1.6, z: Math.sin(angle) * speed });

        const c = ASSEMBLY_SPARKLE_COLORS[Math.floor(Math.random() * ASSEMBLY_SPARKLE_COLORS.length)];
        colors[i * 3] = c[0];
        colors[i * 3 + 1] = c[1];
        colors[i * 3 + 2] = c[2];
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
        size: ASSEMBLY_SPARKLE_BASE_SIZE,
        map: getAssemblySparkleTexture(),
        vertexColors: true,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false, // 加法合成の粒同士・既存ジオメトリとの深度書き込み競合でチラつかないように
        sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    assemblyScene.add(points);
    assemblySparkleEffects.push({ points, geometry, material, velocities, age: 0 });
}

// 毎フレーム呼ぶ。各バーストの粒を放物運動（重力で上昇が減速し、やがて落下）させながら、
// 経過時間に応じて不透明度・サイズを1→0へフェードさせる。寿命が尽きたバーストはシーンから
// 取り除きジオメトリ/マテリアルを破棄する（GPUリソースのリークを防ぐ）
function tickAssemblySparkleEffects(dt) {
    if (assemblySparkleEffects.length === 0) return;
    for (let i = assemblySparkleEffects.length - 1; i >= 0; i--) {
        const fx = assemblySparkleEffects[i];
        fx.age += dt;
        const lifeRatio = fx.age / ASSEMBLY_SPARKLE_LIFETIME_S;
        if (lifeRatio >= 1) {
            assemblyScene.remove(fx.points);
            fx.geometry.dispose();
            fx.material.dispose();
            assemblySparkleEffects.splice(i, 1);
            continue;
        }
        const posAttr = fx.geometry.attributes.position;
        for (let p = 0; p < fx.velocities.length; p++) {
            const v = fx.velocities[p];
            v.y -= ASSEMBLY_SPARKLE_GRAVITY * dt;
            posAttr.array[p * 3] += v.x * dt;
            posAttr.array[p * 3 + 1] += v.y * dt;
            posAttr.array[p * 3 + 2] += v.z * dt;
        }
        posAttr.needsUpdate = true;
        fx.material.opacity = 1 - lifeRatio;
        fx.material.size = ASSEMBLY_SPARKLE_BASE_SIZE * (1 - lifeRatio * 0.6);
    }
}

// 毎フレーム呼ぶ。amountをtargetへ少しずつ近づけ、その値で見た目を更新する
// （現状、Mapに入るのは「戻り」アニメーションのみ）。目標に到達したエントリは
// Mapから取り除く（以降は何もしなくてよい静止状態のため）
function tickAssemblyPanelPressAnimations(dt) {
    if (assemblyPanelPressAnimations.size === 0) return;
    const step = dt / ASSEMBLY_PANEL_RELEASE_DURATION_S;
    assemblyPanelPressAnimations.forEach((anim, key) => {
        anim.amount = Math.max(anim.target, anim.amount - step);
        applyAssemblyPanelPressAmount(anim.pitch, anim.index, anim.amount);
        if (Math.abs(anim.amount - anim.target) < ASSEMBLY_PANEL_PRESS_SETTLE_EPS) assemblyPanelPressAnimations.delete(key);
    });
}

// 内容の大きさに合わせてカメラの初期位置・ズーム範囲を決める。初回ビルド時のみ呼ばれる
// （毎回呼ぶと編集のたびにユーザーがせっかく回転させた視点がリセットされてしまうため）
// トロッコ視点/前視点のチェイスカメラ用に一時的にminDistanceを下げた後、
// 元（曲・マップ設定に応じた「シーン全体を見渡す」既定値）に戻すために保持しておく
let assemblySceneMinDistance = 3;

function frameAssemblyCamera(extent) {
    const gridW = (extent.maxX - extent.minX + 1) * ASSEMBLY_CELL_SIZE;
    const gridH = (extent.maxY - extent.minY + 1) * ASSEMBLY_CELL_SIZE;
    const footprint = Math.max(gridW, gridH, 4);
    const dist = footprint * 1.1 + ASSEMBLY_LAYER_HEIGHT * 2;

    assemblyCamera.position.set(dist * 0.7, dist * 0.6, dist * 0.7);
    assemblyControls.target.set(0, 0, 0);
    assemblySceneMinDistance = Math.max(3, footprint * 0.15);
    assemblyControls.minDistance = assemblySceneMinDistance;
    assemblyControls.maxDistance = footprint * 4 + 40;
    assemblyControls.update();
}

// assemblyCycleAngleIndexがASSEMBLY_ANGLE_MODE_ORDER内の「選択済みモード」を指すよう、
// 必要なら（トグルが外された等で選択済みでなくなっていたら）ASSEMBLY_ANGLE_MODE_ORDERの
// 順で次の選択済みモードまで進める。1つも選択が無い場合はnullを返す
function resolveAssemblyCycleIndexToSelected() {
    const order = ASSEMBLY_ANGLE_MODE_ORDER;
    for (let i = 0; i < order.length; i++) {
        const idx = (assemblyCycleAngleIndex + i) % order.length;
        if (assemblySelectedAngleModes.has(order[idx])) {
            assemblyCycleAngleIndex = idx;
            return order[idx];
        }
    }
    return null;
}

// 現在実際に使うべきアングルモードを返す。ランダムモード中は、選択集合
// （assemblySelectedAngleModes）自体には手を触れず「ランダムモードが今選んでいるもの」
// （assemblyRandomCameraCurrentMode）をそのまま返す——これにより選択集合は常に
// 「ランダムモードで使ってよい種類のトグル」という意味のまま保たれ、ランダムモード中でも
// 手動トグルボタンで自由に切り替えられる。ランダムモードでない時は従来通り：
// 0個選択＝null（カメラワーク一時停止と同一に扱う）、1個選択＝常にそれ、
// 2個以上選択＝ASSEMBLY_ANGLE_MODE_ORDER順に3秒おきに巡回
// （巡回自体はmanageAssemblyCycleTimer()のタイマーがassemblyCycleAngleIndexを進める）
function getEffectiveAssemblyCameraAngleMode() {
    if (assemblyRandomCameraMode) return assemblyRandomCameraCurrentMode;
    if (assemblySelectedAngleModes.size === 0) return null;
    if (assemblySelectedAngleModes.size === 1) return [...assemblySelectedAngleModes][0];
    return resolveAssemblyCycleIndexToSelected();
}

// トロッコ視点/トロッコ前視点で使う進行方向ベクトルを計算し、assemblyTrolleyLastForwardを
// 更新して返す（drawMapPlayLine/updateAssemblyPlayMarkerと同じ、beatIndexとbeatIndex+1の
// レール中心座標から進行方向を求める）。段の折り返しをまたぐ大ジャンプ・次のビートが無い
// （曲の終端）・移動が無い瞬間は、進行方向を再計算できないため、直前まで使っていた向きを
// そのまま維持する。トロッコが無い/座標が取れない場合はnullを返す
function computeAssemblyTrolleyForward() {
    if (!assemblyPlayMarker || currentHighlightBeatIndex == null) return null;
    const posA = assemblyBeatCenters[currentHighlightBeatIndex];
    if (!posA) return null;
    if (!assemblyTrolleyLastForward) assemblyTrolleyLastForward = new THREE.Vector3(0, 0, 1);
    const posB = assemblyBeatCenters[currentHighlightBeatIndex + 1];
    let forward = assemblyTrolleyLastForward;
    if (posB && posA.distanceTo(posB) <= ASSEMBLY_CELL_SIZE * 1.5) {
        const candidate = posB.clone().sub(posA);
        candidate.y = 0;
        if (candidate.lengthSq() > 1e-6) {
            candidate.normalize();
            assemblyTrolleyLastForward.copy(candidate);
            forward = candidate;
        }
    }
    return forward;
}

// トロッコ視点/前視点（近接グループ）で、毎フレームOrbitControlsのtargetをここへ追従させる
// （左回り/右回りと同じ「targetだけ動かしてcontrols.update()に任せる」方式。これにより
// カメラ自身の位置はOrbitControls＝マウスドラッグ操作の対象のまま維持され、
// 「トロッコ視点中もマウスで視点を変えたい」に対応できる）
function getAssemblyChaseCameraTarget(mode, forward) {
    if (mode === "trolleyView") {
        // 後方視点だけ、注視点をトロッコの少し先に置いて進行方向の先まで見通せるようにする。
        // 前視点はトロッコ自身を見ればよい
        return assemblyPlayMarker.position.clone().addScaledVector(forward, ASSEMBLY_TROLLEY_VIEW_LOOK_AHEAD);
    }
    return assemblyPlayMarker.position;
}

// 進行方向(forward、y=0に正規化済み)から見て右側の水平ベクトルを返す（左前/右前視点用）
function getAssemblyTrolleyRightVector(forward) {
    return new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
}

// トロッコ視点/前視点/左前視点/右前視点（近接グループ）に入った瞬間・トロッコが非表示→
// 表示に切り替わった瞬間だけ、各モードの基準構図にカメラ位置を一度スナップさせる。以降は
// tick()内でtargetだけ追従させ、カメラ位置自体はOrbitControls（＝ユーザーのドラッグ操作）に委ねる
function snapAssemblyChaseCameraToTrolley(mode) {
    if (!assemblyPlayMarker || !assemblyPlayMarker.visible) return;
    const forward = computeAssemblyTrolleyForward();
    if (!forward) return;
    const eye = assemblyPlayMarker.position.clone();
    if (mode === "trolleyFrontLeftView" || mode === "trolleyFrontRightView") {
        const right = getAssemblyTrolleyRightVector(forward);
        const sideSign = mode === "trolleyFrontRightView" ? 1 : -1;
        eye.addScaledVector(forward, ASSEMBLY_TROLLEY_FRONT_DIAGONAL_FORWARD);
        eye.addScaledVector(right, sideSign * ASSEMBLY_TROLLEY_FRONT_DIAGONAL_SIDE);
    } else if (mode === "trolleyFrontView") {
        eye.addScaledVector(forward, ASSEMBLY_TROLLEY_FRONT_VIEW_OFFSET);
    } else {
        eye.addScaledVector(forward, -ASSEMBLY_TROLLEY_VIEW_BACK_OFFSET);
    }
    eye.y += ASSEMBLY_TROLLEY_VIEW_HEIGHT;
    const target = getAssemblyChaseCameraTarget(mode, forward);
    // OrbitControls.minDistance（シーン全体を見渡すための「これ以上近寄れない」下限、
    // frameAssemblyCamera参照）が、曲・マップ設定によってはチェイス構図の距離より
    // 大きいことがあり、その場合update()が半径を強制的にminDistanceまで押し戻してしまい
    // 「引きすぎ」になる不具合があった。チェイス構図に必要な距離を計算し、現在のminDistanceが
    // それより大きければ一時的に緩める（少し余裕を持たせるため0.7倍）
    const neededRadius = eye.distanceTo(target);
    if (assemblyControls.minDistance > neededRadius * 0.7) {
        assemblyControls.minDistance = neededRadius * 0.7;
    }
    assemblyCamera.position.copy(eye);
    assemblyControls.target.copy(target);
    // 「近接カメラに切り替わった直後、わずかにまだアングルが動いていて、それを修正する
    // ために画角が変わりカクっとなる」との報告の原因: OrbitControlsはenableDamping+
    // dampingFactor=0.08で滑らかな慣性を持たせている。直前まで遠隔グループでautoRotateが
    // 回っていた場合、update()を呼ぶたびに「今回のautoRotate角度」の一部（8%）だけを
    // 実際の回転へ適用し、残り（92%）を次フレームへ持ち越す仕組みのため、autoRotateを
    // 継続的に回し続けた後は、内部に蓄積された回転量（定常状態で1フレームぶんの
    // 約12.5倍）が残ったままになる。autoRotate=falseにしてもこの蓄積分は消えず、
    // 8%ずつしか減衰しないため、完全に収まるまで約60フレーム（1秒近く）かけて
    // 「わずかに回転し続ける→徐々に収まる」という動きが残ってしまっていた。
    // 初版の修正ではupdate()をこの場で60回連続で呼んで一気に減衰させていた。その後、
    // 「近接カメラに切り替わった時は必ず起きる」という別の報告があり、一時は「60回ループの
    // 呼び出しコスト自体が新たなブロッキングを生んでいるのでは」と疑って本方式（damping無効化+
    // update()1回）に置き換えたが、実際の真因はこの関数とは無関係な別バグ（複数の近接アングル
    // 選択中に3秒おきの巡回タイマーがランダムモードと排他制御されておらず、無関係なタイミングで
    // このsnapAssemblyChaseCameraToTrolley自体を余分に呼び出していたこと。manageAssemblyCycleTimer
    // 参照）と判明している。とはいえ本方式（60回→1回）はdampingモーメンタムのフラッシュとしては
    // 同等以上に正確（実測ドリフト量がさらに小さい）かつ軽量なので、そのまま採用を継続している。
    // three.jsのOrbitControls内部実装では、enableDampingがfalseの間はupdate()が保留中の
    // 回転差分を「減衰させながら一部だけ適用」するのではなく「全部を即座に適用してから
    // ゼロクリア」する（非damping時の分岐）。この性質を利用し、dampingを一時的にfalseに
    // した状態でupdate()を1回だけ呼ぶことで、59回ぶんの無駄なループを削り、
    // 残存モーメンタムを1回の軽い呼び出しだけで完全に解消できる
    const dampingWasEnabled = assemblyControls.enableDamping;
    assemblyControls.enableDamping = false;
    assemblyControls.update();
    assemblyControls.enableDamping = dampingWasEnabled;
    // 上のupdate()で、残存していた回転モーメンタムが一括で適用されてしまうため、
    // カメラが厳密なeye/target（狙った基準構図）から少しズレた位置に収まってしまう
    // （モーメンタム自体は消えても、それが一度は反映された先の角度に居着いてしまう）。
    // モーメンタムを消し切った後で改めて厳密な位置へ合わせ直し、最後にもう1回
    // update()を通す（この時点では残存量ゼロなので、この呼び出し自体は位置を
    // 動かさない「無害な」確定処理になる）
    assemblyCamera.position.copy(eye);
    assemblyControls.target.copy(target);
    assemblyControls.update();
}

// 選択中のアングルが2個以上の間だけ、3秒おきにassemblyCycleAngleIndexを次の選択済み
// モードへ進めるタイマーを動かす（0〜1個の選択時は巡回不要なので止めたまま）。
// 再生中かどうかに関わらず巡回自体は進める（一時停止中に選択を変えても表示が
// 正しく更新されるように、他の状態変更と同じくapplyAssemblyCameraAngleAndPlayState()経由で反映する）。
// 「近接を複数選択してランダム再生すると、必ず途中で1回カクっとなる」の原因: この巡回タイマーは
// assemblyRandomCameraMode（ランダムモード）中かどうかを見ておらず、アングルが2個以上選択されて
// さえいれば裏で3秒おきに走り続けていた。ランダムモード中はgetEffectiveAssemblyCameraAngleMode()が
// assemblyRandomCameraCurrentModeを優先するため巡回インデックス自体は表示に影響しないが、
// このタイマーが呼ぶapplyAssemblyCameraAngleAndPlayState()は、近接モード中なら（実際に
// モードが変わっていなくても）snapAssemblyChaseCameraToTrolley()で無条件に基準構図へ
// 再スナップしてしまう。ランダム側の切替間隔（2000〜4500ms）とこの3秒間隔が独立して走るため、
// 「近接再生の途中で1回だけ」ちょうど基準構図へ引き戻されカクっと見えていた。
// ランダムモード中はこの巡回タイマー自体を止めることで解消する
function manageAssemblyCycleTimer() {
    const shouldRun = !assemblyRandomCameraMode && assemblySelectedAngleModes.size >= 2;
    if (shouldRun && assemblyCycleTimerId == null) {
        assemblyCycleTimerId = setInterval(() => {
            assemblyCycleAngleIndex = (assemblyCycleAngleIndex + 1) % ASSEMBLY_ANGLE_MODE_ORDER.length;
            applyAssemblyCameraAngleAndPlayState();
        }, ASSEMBLY_CYCLE_INTERVAL_MS);
    } else if (!shouldRun && assemblyCycleTimerId != null) {
        clearInterval(assemblyCycleTimerId);
        assemblyCycleTimerId = null;
    }
}

// グループ（"near"＝近接=ASSEMBLY_CHASE_MODES、"remote"＝遠隔=ASSEMBLY_REMOTE_CAMERA_MODES）
// のうち、現在手動トグルでON（assemblySelectedAngleModesに入っている）になっている
// ものだけを返す。「ランダム時に使う種類は、トグルで切りかえられるように戻す」との
// 依頼により、ランダムモードは常にこの選択集合から候補を選ぶ（選択集合自体はランダム
// モード中も一切書き換えない）
function getAssemblyEligibleModesForGroup(group) {
    const groupModes = group === "near" ? ASSEMBLY_CHASE_MODES : ASSEMBLY_REMOTE_CAMERA_MODES;
    return groupModes.filter(m => assemblySelectedAngleModes.has(m));
}

function applyAssemblyRandomCameraButtonStyle() {
    const btn = document.getElementById("assemblyRandomCameraBtn");
    if (btn) btn.style.color = assemblyRandomCameraMode ? "#4a6cf7" : "#ccc";
}

// 4つのアングルトグルボタンの見た目（選択中＝青、それ以外＝グレー）を更新する。
// ランダムモード中もこの選択集合自体は変えないため、ここは常に「ランダムで使ってよい
// 種類」を表す通常の表示のままでよい
function applyAssemblyAngleButtonStyles() {
    document.querySelectorAll(".assembly-angle-btn").forEach(btn => {
        const icon = btn.querySelector("i");
        if (icon) icon.style.color = assemblySelectedAngleModes.has(btn.dataset.angleMode) ? "#4a6cf7" : "#ccc";
    });
}

// グループごとの「シャッフルバッグ」。「同じグループの中で使われたものは後回しに
// してほしい」との依頼に対応するため、単純な直前1つ除外の乱数ではなく、トランプの
// シャッフルのように「そのグループの候補全員を1周使い切るまでは同じものを繰り返さない」
// 方式にした。バッグが尽きたら、その時点でトグルON中の候補を改めてシャッフルして補充する
const assemblyRandomGroupBag = { near: [], remote: [] };

function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// 指定グループのバッグから1つ取り出す。バッグの中身が今のトグル選択と食い違う場合
// （トグルON/OFFが変わった、等）は、現在のeligibleに含まれないものを除外した上で判定し、
// 空になっていれば新しくシャッフルして補充する
function pickFromAssemblyRandomGroupBag(group, eligible) {
    let bag = assemblyRandomGroupBag[group].filter(m => eligible.includes(m));
    if (bag.length === 0) {
        bag = shuffleArray(eligible);
    }
    const picked = bag.shift();
    assemblyRandomGroupBag[group] = bag;
    return picked;
}

// 「必ず、近接→遠隔の順に切り替わるようにしてほしい」との依頼に対応。ランダムモード中は
// 近接グループ・遠隔グループを厳密に交互に選び続ける（assemblyRandomCameraNextGroupが
// 次に選ぶべきグループを保持し、実際に選ぶたびに反転させる）。選ぼうとしたグループに
// トグルONの候補が1つも無い場合は、もう一方のグループから選ぶ（両方0個の場合のみ
// 一時停止相当＝nullになる）。同じグループ内での実際の抽選は、上のシャッフルバッグ方式
// （そのグループの候補を1周使い切るまで同じものを繰り返さない）に委ねる
function pickNextAssemblyRandomCameraMode() {
    const wantGroup = assemblyRandomCameraNextGroup;
    let group = wantGroup;
    let eligible = getAssemblyEligibleModesForGroup(group);
    if (eligible.length === 0) {
        group = wantGroup === "near" ? "remote" : "near";
        eligible = getAssemblyEligibleModesForGroup(group);
    }
    assemblyRandomCameraNextGroup = group === "near" ? "remote" : "near";
    if (eligible.length === 0) return null; // 近接・遠隔どちらもトグルOFF＝選べるものが無い
    if (eligible.length === 1) return eligible[0]; // 候補が1つだけならバッグ管理は不要
    return pickFromAssemblyRandomGroupBag(group, eligible);
}

// ランダムモードの本体。assemblyRandomCameraCurrentMode（getEffectiveAssemblyCameraAngleMode
// が参照する、ランダムモード専用の「今表示しているモード」）だけを書き換え、
// applyAssemblyCameraAngleAndPlayState()を呼ぶ（chase視点のスナップ・autoRotateの向き等、
// アングルごとの実際の見た目の適用はそちら側の既存ロジックに完全に委ねている）。
// 次の切り替えまでの間隔も毎回ランダムに引き直すことで、一定間隔の巡回モードとは
// 違う「予測できない切り替わり」を表現する
function scheduleNextAssemblyRandomCamera() {
    if (!assemblyRandomCameraMode) return;
    const interval = ASSEMBLY_RANDOM_CAMERA_MIN_INTERVAL_MS
        + Math.random() * (ASSEMBLY_RANDOM_CAMERA_MAX_INTERVAL_MS - ASSEMBLY_RANDOM_CAMERA_MIN_INTERVAL_MS);
    assemblyRandomCameraTimerId = setTimeout(() => {
        assemblyRandomCameraCurrentMode = pickNextAssemblyRandomCameraMode();
        applyAssemblyCameraAngleAndPlayState();
        scheduleNextAssemblyRandomCamera(); // 次回もランダムな間隔で自分自身を予約し直す
    }, interval);
}

function startAssemblyRandomCameraMode() {
    if (assemblyRandomCameraMode) return;
    assemblyRandomCameraMode = true;
    assemblyRandomCameraNextGroup = "near"; // 「必ず近接→遠隔の順」なので必ず近接から開始する
    assemblyRandomGroupBag.near = [];
    assemblyRandomGroupBag.remote = []; // 前回ONにした時の残りを持ち越さず、毎回新しくシャッフルし直す
    applyAssemblyRandomCameraButtonStyle();
    // ONにした瞬間、次の切り替えを待たずにまず1回すぐ切り替える（「ランダムを選んだのに
    // 最初の数秒何も起きない」体感の遅さを避けるため）
    assemblyRandomCameraCurrentMode = pickNextAssemblyRandomCameraMode();
    applyAssemblyCameraAngleAndPlayState();
    scheduleNextAssemblyRandomCamera();
}

function stopAssemblyRandomCameraMode() {
    if (!assemblyRandomCameraMode) return;
    assemblyRandomCameraMode = false;
    if (assemblyRandomCameraTimerId != null) {
        clearTimeout(assemblyRandomCameraTimerId);
        assemblyRandomCameraTimerId = null;
    }
    assemblyRandomCameraCurrentMode = null;
    applyAssemblyRandomCameraButtonStyle();
    // 選択集合(assemblySelectedAngleModes)はランダムモード中も一切書き換えていないため、
    // ここで戻すだけで通常の（選択集合に基づく）挙動にそのまま復帰する
    applyAssemblyCameraAngleAndPlayState();
}

// 近接グループ（チェイス視点等）から抜ける時、OrbitControls.minDistanceを
// assemblySceneMinDistance（シーン全体を見渡すための下限）へ戻すためのヘルパー。
// 「ランダムにしている時だけ、しばらく経つと一瞬カクっとなる」との指摘の原因調査で
// 判明: 近接グループは自分のカメラ位置に応じてminDistanceを一時的に緩めている
// （snapAssemblyChaseCameraToTrolley参照）。ここで無条件にassemblySceneMinDistance
// （かなり大きい値）へ戻すと、カメラの実際の位置はまだ近接グループの近い距離のまま
// なため、次のOrbitControls.update()でクランプが働き、カメラが強制的に大きく
// 押し戻されて「カクっ」とスナップしてしまう。rotateLeft/rotateRight（追従サブモード）は
// tick()側で明示的に位置ごと再スナップするため実害が無いが、rotateLeftFixed/
// rotateRightFixed（「カメラ位置をほぼ動かさない」設計）はその再スナップを行わないため、
// クランプによる意図しない移動がそのまま見えてしまっていた。
// 「近接グループでもドラッグで位置を動かせるようにする」「ドラッグ後の位置を維持する」
// という直近の改善により、近接グループ滞在中のカメラの実際の距離が固定の一値ではなく
// 任意になったため、このクランプで生じる移動量も以前よりずっと大きくなり、目立つように
// なったと考えられる（以前は常にsnapの式通りの決まった近い距離だったため、ジャンプ量も
// 小さく・一定していた）。
// 対策として、現在のカメラ⇄target距離を下回らない範囲でminDistanceを設定する
// （＝カメラ位置は一切動かさずに下限だけを安全に戻す）
function restoreAssemblyMinDistanceSafely() {
    if (!assemblyControls || !assemblyCamera) return;
    const currentDistance = assemblyCamera.position.distanceTo(assemblyControls.target);
    assemblyControls.minDistance = Math.min(assemblySceneMinDistance, currentDistance * 0.99);
}

// assemblyCameraPlaying×選択中アングル集合の現在の組み合わせをOrbitControlsに反映する。
// 再生/一時停止ボタン・アングルトグルボタンのクリック、巡回タイマーのいずれからも呼ばれる
function applyAssemblyCameraAngleAndPlayState() {
    if (!assemblyControls) return;
    const effectiveMode = getEffectiveAssemblyCameraAngleMode();
    const isChaseMode = ASSEMBLY_CHASE_MODES.includes(effectiveMode);
    // トロッコ視点/前視点中もマウスでの視点変更を許可するため、常にenabledのまま
    // （以前は専用のカメラ直接制御のためにここをfalseにしていたが、「トロッコ視点時でも
    // マウスによる視点変更は許容してほしい」との依頼で撤廃した）
    assemblyControls.enabled = true;
    // 「何も選ばれていない場合は、カメラワークを一時停止と同一」との指定通り、
    // effectiveModeがnull（選択0個）の間はassemblyCameraPlayingの値に関わらず
    // 一時停止扱い（autoRotate無し・チェイス追従無し）にする
    if (effectiveMode != null && assemblyCameraPlaying && isChaseMode) {
        assemblyControls.autoRotate = false;
        snapAssemblyChaseCameraToTrolley(effectiveMode);
    } else if (effectiveMode != null && assemblyCameraPlaying) {
        restoreAssemblyMinDistanceSafely(); // チェイス視点を抜けたので下限を戻す
        assemblyControls.autoRotate = true;
        assemblyControls.autoRotateSpeed = (effectiveMode === "rotateLeft" || effectiveMode === "rotateLeftFixed") ? -ASSEMBLY_ROTATE_SPEED : ASSEMBLY_ROTATE_SPEED;
    } else {
        restoreAssemblyMinDistanceSafely(); // チェイス視点を抜けたので下限を戻す
        assemblyControls.autoRotate = false;
    }
    manageAssemblyCycleTimer();
}

// 遠隔グループ（左回り/右回り）に入った瞬間だけ呼ぶ。「開始位置はマップの中央を起点に、
// トロッコに近づいた地点」との指定通り、水平方向はランダムな方位ではなく、マップの中央
// （frameAssemblyCamera()が既定の見渡し視点でも狙う原点(0,0,0)）からトロッコへ向かう
// 直線上——トロッコから見てマップ中央側へ、ある距離（近接グループの距離感を基準にした
// 絶対距離、ASSEMBLY_ROTATE_START_DISTANCE_MIN/MAX参照。「これは今までの距離」との
// 指定通り、直前に調整した範囲のまま）だけ戻った地点にカメラをスナップさせる。
// 仰角は既定の俯瞰視点に揃え、距離だけをランダムにする（開始後はこの距離のまま
// autoRotateで回り続ける——毎フレーム距離を詰めていく処理は「トロッコに接近する仕様は
// 廃止」との依頼により削除済み）
function snapAssemblyCameraToRandomRemoteStart() {
    const target = assemblyControls.target;
    // 実際にOrbitControlsで選べる範囲を超えないよう、安全のためminDistance/maxDistanceで
    // クランプする（通常のトラックであれば絶対距離の範囲がそのまま採用され、極端に小さい
    // トラックでだけ稀にクランプが効く）
    const rawDistance = ASSEMBLY_ROTATE_START_DISTANCE_MIN
        + Math.random() * (ASSEMBLY_ROTATE_START_DISTANCE_MAX - ASSEMBLY_ROTATE_START_DISTANCE_MIN);
    const distance = Math.min(Math.max(rawDistance, assemblyControls.minDistance), assemblyControls.maxDistance);
    // トロッコからマップ中央(原点)へ向かう水平方向の単位ベクトル。トロッコがちょうど
    // 中央付近にありベクトルの長さがほぼ0の場合だけ、方位が定まらないためランダムに逃がす
    let dirX = -target.x, dirZ = -target.z;
    const dirLen = Math.hypot(dirX, dirZ);
    if (dirLen < 1e-6) {
        const fallbackAzimuth = Math.random() * Math.PI * 2;
        dirX = Math.cos(fallbackAzimuth);
        dirZ = Math.sin(fallbackAzimuth);
    } else {
        dirX /= dirLen;
        dirZ /= dirLen;
    }
    const elevation = ASSEMBLY_ROTATE_START_ELEVATION_DEG * Math.PI / 180;
    const horizontalRadius = Math.cos(elevation) * distance;
    assemblyCamera.position.set(
        target.x + dirX * horizontalRadius,
        target.y + Math.sin(elevation) * distance,
        target.z + dirZ * horizontalRadius
    );
}

function startAssemblyRenderLoop() {
    if (assemblyAnimFrameId !== null) return;
    let lastTime = performance.now();
    const tick = () => {
        assemblyAnimFrameId = requestAnimationFrame(tick);
        const now = performance.now();
        // タブを切り替えて離れていた間などdtが異常に大きくなるケースに備えて上限を設ける
        // （音符マットの凹みアニメーションが一気に飛ぶのを防ぐ）
        const dt = Math.min(0.1, (now - lastTime) / 1000);
        lastTime = now;
        tickAssemblyPanelPressAnimations(dt);
        tickAssemblySparkleEffects(dt);
        tickAssemblyCharacterWobble(dt);
        tickAssemblyClouds(dt);

        const markerVisible = !!(assemblyPlayMarker && assemblyPlayMarker.visible);
        const effectiveMode = getEffectiveAssemblyCameraAngleMode();
        const isChaseMode = ASSEMBLY_CHASE_MODES.includes(effectiveMode);
        // アングルが1つも選択されていない（effectiveMode===null）間は、
        // assemblyCameraPlayingの値に関わらず一時停止と同一に扱う
        const activelyAnimating = effectiveMode != null && assemblyCameraPlaying;
        if (activelyAnimating && isChaseMode) {
            // targetだけを動かしてcontrols.update()を呼んでも、OrbitControls内部では
            // 毎回「現在のcamera.position - 現在のtarget」からoffsetを再計算して
            // そのままtargetへ足し戻す（＝角度デルタが無ければ事実上の恒等変換）ため、
            // それだけではカメラは一切追従しない（実測で判明、詳細は上のコメント参照）。
            // 以前はドラッグ中（assemblyChaseUserInteracting）でない限り毎フレーム
            // snapAssemblyChaseCameraToTrolley()でカメラ位置ごと再計算して追従させていたが、
            // これだとユーザーがドラッグで視点を動かした直後、マウスを離した次のフレームで
            // また「ドラッグ中でない」判定になり基準構図へ戻ってしまっていた（「近接アングルの
            // 時も、視点を動かした後、戻すのではなく維持してほしい（遠隔と同じように）」との
            // 指摘）。遠隔グループ（rotateLeft/rotateRight）と同じ方式に変更：このモードに
            // 入った瞬間（モードが変わった時）だけ基準構図に一度スナップし、以降は同じモードが
            // 続く限り、トロッコが前フレームからどれだけ動いたかをカメラにもそのまま平行移動
            // として足し込むだけにする。ユーザーのドラッグによる相対オフセットはこの平行移動を
            // 挟んでも保たれるため、ドラッグ中かどうかで分岐する必要が無くなった
            // 「モードが変わったかどうか」の判定は、トロッコが見えているかどうか
            // (markerVisible)とは完全に切り離す。以前はmarkerVisibleがfalseの間
            // assemblyLastChaseCameraModeをnullに戻していたが、実際に計測したところ
            // 速いテンポの曲ではノートの切れ目ごとにmarkerVisibleがtrue/falseを
            // 頻繁に行き来しており（休符に限らず、ごく短い間隙でも起こりうる）、その
            // たびに「モードが変わった」という誤判定が起きて、毎回forward依存の
            // snapAssemblyChaseCameraToTrolley()（進行方向によって視点ごと再計算される）
            // が再実行されてしまっていた。これがレール折り返しの瞬間に限らず曲中随所で
            // 「カクっ」となるデグレの正体だった（実測: 60サンプル中55サンプルで
            // 単純追従では説明できない大きな動きを検出）。
            // 正しくは、「スナップが必要かどうか」はmarkerVisibleではなく
            // assemblyChaseLastTrolleyPos/assemblyChaseTargetOffsetが未確定かどうかで
            // 判定する——モードが変わった時だけこの2つをnullに戻し、トロッコの可視/不可視は
            // 「今フレームで何もしない（動かさないだけ、モードの状態は保持する）」を
            // 意味するだけにする
            const chaseModeChanged = effectiveMode !== assemblyLastChaseCameraMode;
            assemblyLastChaseCameraMode = effectiveMode;
            if (chaseModeChanged) {
                assemblyChaseLastTrolleyPos = null;
                assemblyChaseTargetOffset = null;
            }
            if (markerVisible) {
                if (!assemblyChaseLastTrolleyPos || !assemblyChaseTargetOffset) {
                    // モードに入った直後、またはモードが変わらないままトロッコが非表示→
                    // 表示に切り替わった最初のフレームだけ、基準構図へ一度スナップする
                    snapAssemblyChaseCameraToTrolley(effectiveMode);
                    assemblyChaseLastTrolleyPos = assemblyPlayMarker.position.clone();
                    // スナップが確定させたtarget（トロッコ視点ならlook-ahead分ずれた注視点）と
                    // トロッコ位置そのものとの差を、以降の追従で使う固定オフセットとして保存する
                    assemblyChaseTargetOffset = assemblyControls.target.clone().sub(assemblyPlayMarker.position);
                } else {
                    // カメラ位置・注視点(target)のどちらも、トロッコの移動ぶんだけ平行移動させる
                    // （進行方向=forwardを毎回引き直さない）。target側もforwardではなく
                    // スナップ時に確定した固定オフセットをトロッコ位置へ足すだけにすることで、
                    // カメラ⇄target間の距離が常に一定に保たれ、レール折り返しで進行方向が急反転
                    // してもOrbitControlsのminDistance/maxDistanceクランプが働かない
                    const delta = assemblyPlayMarker.position.clone().sub(assemblyChaseLastTrolleyPos);
                    assemblyCamera.position.add(delta);
                    assemblyControls.target.copy(assemblyPlayMarker.position).add(assemblyChaseTargetOffset);
                    assemblyChaseLastTrolleyPos.copy(assemblyPlayMarker.position);
                }
            }
            assemblyControls.update();
        } else {
            assemblyLastChaseCameraMode = null;
            assemblyChaseLastTrolleyPos = null;
            assemblyChaseTargetOffset = null;
            const isRemoteMode = ASSEMBLY_REMOTE_CAMERA_MODES.includes(effectiveMode);
            const nowInRemoteGroup = activelyAnimating && isRemoteMode && markerVisible;
            // 遠隔グループのうち「追従サブモード」（rotateLeft/rotateRight）だけが、
            // ランダム開始位置へのスナップ・毎フレームの追従補正（ドリフト防止）の対象。
            // rotateLeftFixed/rotateRightFixedは「昔の（カメラ位置がほぼ動かない）
            // 左回り/右回り」を別アングルとして復活させたもので、targetがトロッコを
            // 追う以外は一切位置操作をしない（下のtarget追従の1行だけが効く）
            const isRemoteChaseSubmode = ASSEMBLY_REMOTE_CHASE_SUBMODES.includes(effectiveMode);
            // 遠隔グループで既に回っている間（今まさに入った瞬間は除く）は、target（トロッコ）
            // が前フレームからどれだけ動いたかをカメラの位置にもそのまま平行移動として
            // 足し込む。OrbitControls.update()は毎回「現在のcamera.position - 現在のtarget」
            // から素直に半径を再計算するため、target（＝トロッコ）だけを動かしてカメラ自身は
            // 動かさずにいると、トロッコが進むにつれて見かけ上の半径がどんどん変わってしまう
            // （実測: minDistanceでスナップした直後でも、1〜2フレームでもう20%以上ズレる程度に
            // 顕著だった）。「可能な限り近くまで寄る」を実際に維持するには、この平行移動による
            // 補正が必要——ユーザーのマウスによるズーム操作（OrbitControls自体のdolly）は
            // この後のupdate()側で別途処理されるため、ここでの補正とは干渉しない
            // 「左回り⇄右回りの切替でも、毎回この中央基準の近づいた地点へ再スナップして
            // ほしい」との指定通り、判定は「遠隔グループに入っているかどうか」ではなく
            // 「実際に効いているモード（rotateLeft/rotateRight/それ以外）そのものが
            // 直前フレームと変わったかどうか」で行う——他モード/一時停止から遠隔グループに
            // 入った時はもちろん、遠隔グループ内で左回り⇄右回りが切り替わった時も
            // 変化ありと判定され、その都度再スナップする
            const remoteModeChanged = nowInRemoteGroup && effectiveMode !== assemblyLastRemoteCameraMode;
            if (nowInRemoteGroup && isRemoteChaseSubmode && !remoteModeChanged && assemblyRemoteCameraLastTargetPos) {
                const delta = assemblyPlayMarker.position.clone().sub(assemblyRemoteCameraLastTargetPos);
                assemblyCamera.position.add(delta);
            }
            // 左回り/右回り再生中は、トロッコが見えている間だけ回転の中心を
            // トロッコの現在位置へ追従させる（再生していない/トロッコが無い時は
            // 直前の中心のまま回り続ける）。Fixed版もこの追従自体は行う（「注視点だけ
            // トロッコを追う」という復活の要望通り）
            if (activelyAnimating && markerVisible) {
                assemblyControls.target.copy(assemblyPlayMarker.position);
            }
            // 「トロッコに接近する仕様は廃止」との依頼により、スナップ直後の毎フレームの
            // 距離調整（接近イージング）は行わない——スナップした距離のままautoRotateで回り続ける。
            // ランダム開始スナップ自体も追従サブモードだけで行う（Fixed版は「元々あった
            // カメラの位置のまま」始まるのが復活させたい挙動そのものなので、スナップしない）
            if (remoteModeChanged && isRemoteChaseSubmode) {
                snapAssemblyCameraToRandomRemoteStart();
            }
            assemblyLastRemoteCameraMode = nowInRemoteGroup ? effectiveMode : null;
            assemblyRemoteCameraLastTargetPos = (nowInRemoteGroup && isRemoteChaseSubmode && markerVisible)
                ? assemblyPlayMarker.position.clone()
                : null;
            assemblyControls.update();
        }
        // 空の球を常にカメラの位置へ追従させる（黒丸バグ対策、initAssemblyScene参照）
        if (assemblySkyMesh) assemblySkyMesh.position.copy(assemblyCamera.position);
        // 「地面より地中にアングルが埋まってしまった場合、地面は透明で上を見上げられる
        // ように」との依頼に対応。カメラが地面のyより下に潜っている間だけ地面を
        // 半透明にし、地上に戻ったら元の不透明度に戻す
        if (assemblyGroundMesh) {
            const shouldBeTransparent = assemblyCamera.position.y < ASSEMBLY_GROUND_Y;
            const targetOpacity = shouldBeTransparent ? ASSEMBLY_GROUND_TRANSPARENT_OPACITY : 1;
            if (assemblyGroundMesh.material.opacity !== targetOpacity) {
                assemblyGroundMesh.material.opacity = targetOpacity;
            }
        }
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
// 要るため、単体タブ表示時はupdateContentAreaMinHeights()と同じ「ヘッダー等を除いた
// 残り高さ」の考え方でheightを直接指定する。「並べて」タブでは#bothTabContainerのgrid
// （align-items:stretch）が既に高さを決めてくれるため、ここで上書きしない
// （updateBothTabContainerHeight()が管理する）
function resizeAssemblyRenderer() {
    if (!assemblySceneReady) return;
    const wrapper = document.getElementById("assemblyAreaWrapper");
    if (!wrapper) return;
    if (activeTab === "both") {
        wrapper.style.height = "";
    } else {
        const docTop = wrapper.getBoundingClientRect().top + window.scrollY;
        wrapper.style.height = `${Math.max(window.innerHeight - docTop, 100)}px`;
    }

    const w = wrapper.clientWidth, h = wrapper.clientHeight;
    if (w === 0 || h === 0) return;
    assemblyRenderer.setSize(w, h, false);
    assemblyCamera.aspect = w / h;
    assemblyCamera.updateProjectionMatrix();
    // LineMaterial（音符マットの黒ぶち、fat lines）はlinewidthをピクセル単位で解釈するため、
    // 実際のcanvasピクセルサイズ（resolution）を都度渡してやる必要がある
    if (assemblyPanelEdgesMaterial) assemblyPanelEdgesMaterial.resolution.set(w, h);
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
    if (isMap2DActive()) renderMap();
    if (isAssemblyActive()) renderAssemblyPreview();
}

// マップエリア内の2D/3D切替（#mapAreaWrapper・#assemblyAreaWrapper内のトグル、マップ単体
// タブ・「並べて」タブどちらでも使える）。タブ自体は切り替えない点がswitchTab()と異なるため、
// 表示切替・再描画・レンダーループの停止をここで個別に行う
function setMapViewMode(mode) {
    if (mode === mapViewMode) return;
    const wasAssemblyActive = isAssemblyActive();
    mapViewMode = mode;
    localStorage.setItem("mapViewMode", mapViewMode);
    applyTabVisibility();
    updateContentAreaMinHeights();
    if (isMap2DActive()) renderMap();
    if (isAssemblyActive()) renderAssemblyPreview();
    if (wasAssemblyActive && !isAssemblyActive()) stopAssemblyRenderLoop();
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
        // 「両方」タブでは五線譜エリア内でのmousedownはこちらでは処理しない（setupGlobalEvents()側に任せる）。
        // マップタブ・「並べて」タブが3Dプレビュー表示中（isAssemblyActive()）の時は、非表示の
        // 2Dキャンバス上のヒットテストが裏で動いてしまわないよう除外する（OrbitControlsの操作と競合するため）
        if (isAssemblyActive()) return;
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
        // 画面上部のメニューバー（タブ・ファイル操作・ズーム・マップ/3D設定等のツールバー列）
        // からドラッグを始めても、同様に小節選択を巻き込まないよう除外する。ボタン単体は
        // e.target.closest("button")で既に除外されているが、ツールバー同士の余白や
        // タブ行の背景などボタンではない部分を押しても選択が始まってしまう不具合があった
        if (e.target.closest("#stickyHeader")) return;
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
            }
            // 休符は右クリックしても何も起きない（削除ハンドラのnote.rest分岐が「何もしない」）
            // ため、赤い「削除できます」ホバー色は付けない。音符を削除すると同じ長さの休符に
            // 置き換わる仕様上、これを付けたままだと「削除した音符の跡地に、まだ削除できるかの
            // ような赤いホバーが残って見える」という指摘（「消えた後なので」）につながっていた
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
                // 和音の場合、setStyle()だと和音全体（カーソルが乗っていないピッチも含む）が
                // 赤く塗られてしまい、実際にホバー中のピッチより上にずれて見える原因になっていた
                // （右クリックで消える対象は`hoveredPos.hitPitchIndex`が指す1音だけなので、
                // ハイライトもそのキーだけに絞る）。単音の場合はどちらでも見た目は同じだが、
                // 和音でない時にsetKeyStyleだと符幹の色が変わらず見た目が変わってしまうため、
                // ピッチが1つの時は従来通りsetStyleで音符全体を塗る
                if (pitches.length > 1 && hoveredPos.hitPitchIndex != null && hoveredPos.hitPitchIndex < pitches.length) {
                    staveNote.setKeyStyle(hoveredPos.hitPitchIndex, { fillStyle: hoverColor, strokeStyle: hoverColor });
                } else {
                    staveNote.setStyle({ fillStyle: hoverColor, strokeStyle: hoverColor });
                }
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
function buildRow(rowMeasures, rowIndex, attach) {
        const isFirstRow = rowIndex === 0;

        const firstMeasureExtra = isFirstRow ? FIRST_MEASURE_EXTRA : 0;
        const rowWidth = (20 + firstMeasureExtra + rowMeasures.length * STAVE_WIDTH_BASE + 20) * scale;

        const rowDiv = document.createElement("div");
        rowDiv.style.position = "relative";
        rowDiv.dataset.rowIndex = rowIndex;
        // recordNotePositionsForStaff()が読むrowDiv.offsetTopは、要素がドキュメントに
        // 挿入され前の行までレイアウトが確定して初めて正しい値になる（未接続のdivは常に0）。
        // 中身（VexFlow描画・クリック判定位置の記録）を作り始める前に、呼び出し元が
        // 指定した場所へ先に挿入しておく（renderScore()の初回描画、updateHoverRows()の
        // 差し替えのどちらでも、この時点で挿入位置さえ確定していれば以降offsetTopは正しい）
        attach(rowDiv);

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
        buildRow(rowMeasures, rowIndex, (rowDiv) => scoreElement.appendChild(rowDiv));
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
// 音符データを書き換えた直後に必ず行う後処理をまとめたもの（保存・再描画・「並べて」タブなら
// マップも更新・再生中/一時停止中なら音の再スケジュール）。handleNoteEdit()内の分岐ごとに
// 個別に書くと呼び忘れが起きやすい（実際、再生中の編集を音に反映する処理は長らく抜けていた）
// ため、1箇所にまとめて呼び出す
function commitNoteEdit() {
    saveHistory();
    renderScore();
    if (activeTab === "both") renderMap();
    // 再生中/一時停止中に音符を編集したら、今鳴っている音符はそのまま鳴らし切り、
    // まだ鳴っていない先の部分だけ新しい内容で敷き直す（BPM変更時と同じ仕組みを流用）
    if (playState !== "stopped") rescheduleFromCurrentPosition();
}

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
                        commitNoteEdit();
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
                    commitNoteEdit();
                } else {
                    // 既存の和音への音追加（この段の音符自体に追加するだけ、他の段とは無関係）
                    const pitch = yToPitch(clickYLocal, false);
                    if (pitch && !target.pitches.includes(pitch) && target.pitches.length < getChordMax()) {
                        target.pitches.push(pitch);
                        target.pitches.sort((a, b) => pitchToSemitone(a) - pitchToSemitone(b));
                        commitNoteEdit();
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
                commitNoteEdit();
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
                commitNoteEdit();
            } else {
                note.pitches.splice(hit.pitchIndex, 1);
                commitNoteEdit();
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
            ? { measureIndex, x: mouseX, y: mouseY, pitch, staff, hitNoteIndex: hitNote ? hitNote.noteIndex : (hitNoteX ? hitNoteX.noteIndex : null), hitPitchIndex: hitNote ? hitNote.pitchIndex : null, directHit: !!hitNote }
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

        // 新しい行はoldRowDivの直前に挿入してから中身を作る（offsetTopを正しく求めるため、
        // buildRow()の中身が組み上がる前にDOM上の最終位置を確定させる必要がある）。
        // 古い行は新しい行の中身が揃ってから取り除く
        const newRowDiv = buildRow(rowMeasures, rowIndex, (rowDiv) => scoreElement.insertBefore(rowDiv, oldRowDiv));
        oldRowDiv.remove();

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
        const totalSeconds = getFullSongDuration();
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
    if (isAssemblyActive()) resizeAssemblyRenderer();
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
            // ドラッグが小節選択と確定した瞬間、それより前のホバー（mousedown直前まで
            // 更新されていた音符プレビュー）がsetupSVGEventsForRow側のmousemoveで
            // 更新されずに残ったままになる（dragState存在中はホバー処理自体をスキップする
            // 実装のため）。「もう音符は設置しない、ホバープレビューは不要」との指摘に対応し、
            // ここで明示的に消す
            if (hoveredPos !== null) {
                const prevHovered = hoveredPos;
                hoveredPos = null;
                updateHoverRows(prevHovered, null);
            }
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
        // 「両方」タブでは五線譜・マップ(2D)の両エリアが同時に見えるため、マップエリア内での
        // mousedownはこちらでは処理しない（setupMapAreaDrag()側に任せる）。3Dプレビュー表示中も
        // 同様に、OrbitControlsでのドラッグ（カメラ回転）が誤って小節選択を発生させないよう、
        // #assemblyAreaWrapper内でのmousedownも除外する
        if (activeTab !== "score" && activeTab !== "both") return;
        if (isSeekDragging) return;
        if (activeTab === "both" && e.target.closest("#mapAreaWrapper")) return;
        if (activeTab === "both" && e.target.closest("#assemblyAreaWrapper")) return;
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
        // 画面上部のメニューバー（タブ・ファイル操作・ズーム・マップ/3D設定等のツールバー列）
        // からドラッグを始めても、同様に小節選択を巻き込まないよう除外する。ボタン単体は
        // e.target.closest("button")で既に除外されているが、ツールバー同士の余白や
        // タブ行の背景などボタンではない部分を押しても選択が始まってしまう不具合があった
        if (e.target.closest("#stickyHeader")) return;

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
        // テンポマップ対応: 先頭小節は必ずテンポを書き出す（measure.tempoがあればそれ、
        // 無ければ引数のbpm）。それ以外の小節は、measure.tempoが設定されている
        // （＝直前の小節からテンポが変化する）場合だけ<sound tempo>を追加する
        const measureTempo = i === 0 ? (measure.tempo != null ? measure.tempo : bpm) : measure.tempo;
        const directionXml = measureTempo != null ? `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${measureTempo}</per-minute></metronome></direction-type><sound tempo="${measureTempo}"/></direction>` : "";

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
// octaveShiftOctaves: <octave-shift>（8va/8vb等）による記譜上の見た目のオクターブと
// 実際の鳴る音のオクターブのズレ（オクターブ単位、下方シフトなら負の値）。呼び出し側が
// 現在有効なシフト量を渡す（デフォルト0=シフト無し）
function readPitchFromXML(pitchEl, octaveShiftOctaves = 0) {
    const step = pitchEl.querySelector("step").textContent;
    const alterEl = pitchEl.querySelector("alter");
    const alterRaw = alterEl ? parseFloat(alterEl.textContent) : 0;
    const octave = parseInt(pitchEl.querySelector("octave").textContent, 10) + octaveShiftOctaves;
    if (alterRaw === 0 || alterRaw === 1 || alterRaw === -1) {
        return musicXMLToPitchString(step, alterRaw, octave);
    }
    if (!Number.isInteger(alterRaw)) {
        // 四分音等の非整数alterは、このアプリの半音単位のピッチ表現では表せない
        throw new Error(`対応していない臨時記号です（alter=${alterRaw}）`);
    }
    // ダブルシャープ(alter=2)・ダブルフラット(alter=-2)等、このアプリのピッチ文字列表記
    // （#かbを1つだけ持つ形式）では直接表現できない臨時記号は、実際に鳴る半音へいったん
    // 変換してから単一のシャープ表記へ綴り直す（実機は音高＝半音だけが重要で、楽譜上の
    // 「綴り」（G##とA、どちらの表記か）を区別して鳴らす仕組みは無いため実用上問題ない）
    const semitone = octave * 12 + NATURAL_SEMITONE[step] + alterRaw;
    return semitoneToPitch(semitone);
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
    const divisionsEl = firstAttributes.querySelector("divisions");
    const divisions = divisionsEl ? parseInt(divisionsEl.textContent, 10) : 1;
    const fifthsEl = firstAttributes.querySelector("key > fifths");
    const fifths = fifthsEl ? parseInt(fifthsEl.textContent, 10) : 0;
    const keySignature = FIFTHS_TO_KEY_SIG[fifths];
    if (!keySignature) {
        throw new Error(`対応していない調号です（fifths=${fifths}）`);
    }
    const beatsEl = firstAttributes.querySelector("time > beats");
    const beatTypeEl = firstAttributes.querySelector("time > beat-type");
    const timeSignature = beatsEl && beatTypeEl ? `${beatsEl.textContent}/${beatTypeEl.textContent}` : "4/4";
    // <rest measure="yes"/>（下記）を展開する際に使う、1小節ぶんの拍数（4分音符基準、
    // getBeatsPerMeasure()と同じ計算式）。score.timeSignatureはまだ確定していない
    // （このあと戻り値としてまとめて作る）ため、ここで同じ式をそのまま使う
    const [tsNum, tsDen] = timeSignature.split("/").map(Number);
    const measureBeats = tsNum * 4 / tsDen;
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

    // <octave-shift>（8va/8vb等の記譜）による、段ごとの現在有効なオクターブシフト量
    // （オクターブ単位）。start/stopが小節をまたぐことがあるため、measures.mapの外
    // （曲全体を通した状態）として持つ
    const activeOctaveShiftByStaff = { 1: 0, 2: 0 };
    const OCTAVE_SHIFT_SIZE_TO_OCTAVES = { 8: 1, 15: 2, 22: 3 };
    // テンポマップ: 曲全体を通して直前に見つかったテンポ（初期値は上で読んだ最初のsound[tempo]、
    // 無ければ120）。小節ごとにこれと異なる<sound tempo>が見つかった時だけ、その小節に
    // measures[i].tempoとして記録する（変化が無い限り記録しない＝省略可能フィールド）
    let lastTempo = bpm;

    const measures = Array.from(measureEls).map((measureEl) => {
        const upperNotes = [];
        const lowerNotes = [];
        const currentSlotByStaff = { 1: null, 2: null };
        const seenVoiceByStaff = { 1: null, 2: null };
        let tempoForThisMeasure = null;

        // <direction>（octave-shiftの開始/終了、テンポ変化）と<note>は小節内で出現順に
        // 交互に現れ得るため、shift状態の更新と音符の読み取りは出現順（:scope > *を通しで
        // 走査）で行う必要がある（先に全<direction>を処理してから<note>を処理すると、
        // 小節途中でシフトが切り替わる場合に、切り替え前の音符にも新しいシフトが適用されてしまう）
        Array.from(measureEl.children).forEach((el) => {
            if (el.tagName === "direction") {
                const soundTempoEl = el.querySelector("sound[tempo]");
                if (soundTempoEl) {
                    const newTempo = Math.round(parseFloat(soundTempoEl.getAttribute("tempo")));
                    if (newTempo !== lastTempo) {
                        tempoForThisMeasure = newTempo;
                        lastTempo = newTempo;
                    }
                }
                const shiftEl = el.querySelector("direction-type > octave-shift");
                if (!shiftEl) return;
                const staffEl = el.querySelector("staff");
                const staffNum = staffEl ? parseInt(staffEl.textContent, 10) : 1;
                const shiftType = shiftEl.getAttribute("type");
                if (shiftType === "stop") {
                    activeOctaveShiftByStaff[staffNum] = 0;
                    return;
                }
                const size = parseInt(shiftEl.getAttribute("size"), 10) || 8;
                const octaves = OCTAVE_SHIFT_SIZE_TO_OCTAVES[size] || 1;
                activeOctaveShiftByStaff[staffNum] = shiftType === "down" ? -octaves : octaves;
                return;
            }
            if (el.tagName !== "note") return;
            const noteEl = el;
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
                target.pitches.push(readPitchFromXML(pitchEl, activeOctaveShiftByStaff[staffNum]));
                target.pitches.sort((a, b) => pitchToSemitone(a) - pitchToSemitone(b));
                return;
            }

            // <rest measure="yes"/>（MusicXML標準の「小節まるごと休符」表記）は、
            // 小節の長さ自体が休符の音価を兼ねるため<type>を持たない（仕様上省略可能）。
            // 現在の拍子（全小節共通、beatsToRestsと同じ単位＝4分音符基準）ぶんの休符に
            // 展開して追加する。既存の「<type>が無ければエラー」という判定の対象外にする
            const restEl = noteEl.querySelector(":scope > rest");
            if (restEl && restEl.getAttribute("measure") === "yes") {
                const targetArray = staffNum === 1 ? upperNotes : lowerNotes;
                targetArray.push(...beatsToRests(measureBeats));
                currentSlotByStaff[staffNum] = null;
                return;
            }
            // <type>を持たない休符（<rest measure="yes"/>ではない、単に<duration>だけで
            // 長さを示す休符表記）も同様に対応する。5拍・6拍等、単一の音符グリフでは
            // 表せない長さの休符でこの表記が使われることがある（divisionsからの逆算で
            // 4分音符基準の拍数に変換し、beatsToRestsで音価の組み合わせに分解する）
            if (restEl && !restEl.getAttribute("measure")) {
                const durationEl = noteEl.querySelector(":scope > duration");
                if (durationEl && !noteEl.querySelector("type")) {
                    const restBeats = parseInt(durationEl.textContent, 10) / divisions;
                    const targetArray = staffNum === 1 ? upperNotes : lowerNotes;
                    targetArray.push(...beatsToRests(restBeats));
                    currentSlotByStaff[staffNum] = null;
                    return;
                }
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
                noteObj = { pitches: [readPitchFromXML(pitchEl, activeOctaveShiftByStaff[staffNum])], duration: durationCode, ...(dotted ? { dotted: true } : {}) };
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

        return { upperNotes, lowerNotes, ...(tempoForThisMeasure != null ? { tempo: tempoForThisMeasure } : {}) };
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
    // 「再生中にファイル読み込みした場合は再生終了してほしい」との依頼に対応。
    // 読み込んだ新しい譜面と、再生中だった古い譜面のスケジュール（beatSchedule等）が
    // 食い違ったまま再生を続けると、演奏内容と表示がずれる・存在しない小節を参照して
    // エラーになる等の不整合が起きるため、読み込み前に必ず再生を止める
    stopScore();
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
    loadAssemblyTrolleyIcon2D();
    // 設定が既にONで保存されている場合、3Dタブを開くのを待たずにここでプリロードを
    // 始めておく（57MBあるため、タブを開いてから・再生を押してからでは表示までの
    // 遅延が目立つとの指摘への対策）
    if (mapSettings.showCharacter) loadAssemblyCharacterModel();

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
    setupDebugPanel();
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
            rescheduleFromCurrentPosition();
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
    // buildMapGrid()がmapSettings.railWrapEnabledを見てbuildFixedRailTrack()（折り返しあり・
    // 固定長レール）とレガシーな段組みロジック（折り返しなし）を切り替える。トグル自体は
    // 単純な設定変更で、実際の配置ロジックの分岐先はbuildMapGrid側に実装済み
    document.getElementById("mapRailWrapOn")?.addEventListener("click", () => {
        mapSettings.railWrapEnabled = true;
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapRailWrapOff")?.addEventListener("click", () => {
        mapSettings.railWrapEnabled = false;
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    // 3Dプレビュー限定の見た目トグルなので、マップグリッドの再構築（refreshMapAndAssemblyIfVisible）は不要。
    // キャラクターはassemblyPlayMarker配下に一度だけ読み込んで使い回すため、表示/非表示の切り替えは
    // visibleの付け替えのみで行う（loadAssemblyCharacterModel/applyAssemblyCharacterVisibility参照）
    document.getElementById("mapCharacterOn")?.addEventListener("click", () => {
        mapSettings.showCharacter = true;
        saveMapSettings(); updateMapToolbarUI();
        loadAssemblyCharacterModel();
        attachAssemblyCharacterIfReady();
    });
    document.getElementById("mapCharacterOff")?.addEventListener("click", () => {
        mapSettings.showCharacter = false;
        saveMapSettings(); updateMapToolbarUI();
        applyAssemblyCharacterVisibility();
    });
    // 木・草・花の装飾（generateAssemblyDecorations）は再構築のたびに毎回生成し直す
    // ものなので、キャラクターと違いvisibleの付け替えだけでは済まない。
    // refreshMapAndAssemblyIfVisible()でrebuildAssemblyMeshes()から作り直させる
    document.getElementById("mapDecorationsOn")?.addEventListener("click", () => {
        mapSettings.showDecorations = true;
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapDecorationsOff")?.addEventListener("click", () => {
        mapSettings.showDecorations = false;
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    // 「レールを地面につけるか、浮かす（今の状態）かを決める」との依頼で追加。
    // rebuildAssemblyMeshes()内のtoWorld()がこの値を見てレール層全体のYオフセットを
    // 決めるため（詳細はそちら参照）、装飾と同じくグリッドの再構築が必要
    document.getElementById("mapRailFloatingOn")?.addEventListener("click", () => {
        mapSettings.railFloating = true;
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapRailFloatingOff")?.addEventListener("click", () => {
        mapSettings.railFloating = false;
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    // センサーの向き（forwardVec）をデバッグ可視化する薄い赤の光線。センサーと同じく
    // rebuildAssemblyMeshes()内で毎回作り直すため、装飾・レール高さと同様グリッド再構築が必要
    document.getElementById("mapSensorDirectionOn")?.addEventListener("click", () => {
        mapSettings.showSensorDirection = true;
        saveMapSettings(); updateMapToolbarUI(); refreshMapAndAssemblyIfVisible();
    });
    document.getElementById("mapSensorDirectionOff")?.addEventListener("click", () => {
        mapSettings.showSensorDirection = false;
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
        if (isAssemblyActive()) resizeAssemblyRenderer();
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
        } else if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
            e.preventDefault();
            toggleDebugPanel();
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

    // マップタブ内の2D/3D切替
    document.querySelectorAll(".map-view-mode-btn").forEach(btn => {
        btn.addEventListener("click", () => setMapViewMode(btn.dataset.mapViewMode));
    });

    // 2Dマップのグリッド線ON/OFF（3D側のassemblyGridToggleBtnと対になるボタン）
    const mapGridToggleBtn = document.getElementById("mapGridToggleBtn");
    if (mapGridToggleBtn) {
        const applyMapGridToggleStyle = () => {
            const icon = mapGridToggleBtn.querySelector("i");
            if (icon) icon.style.color = mapGridVisible ? "#4a6cf7" : "#ccc";
        };
        applyMapGridToggleStyle();
        mapGridToggleBtn.addEventListener("click", () => {
            mapGridVisible = !mapGridVisible;
            applyMapGridToggleStyle();
            if (mapRenderState) drawMapCanvas(mapRenderState);
        });
    }

    // 2Dマップを画像(PNG)として保存。#mapGridは表示中の一部だけでなくマップ全体の
    // 論理サイズそのままのcanvas（スクロールはCSS側、canvas自体は全体を含む）なので、
    // toDataURLするだけでスクロール外の部分も含めた全体図が得られる。保存の仕組み自体は
    // saveBtn（MusicXML保存）と同じ、File System Access API対応ブラウザではダイアログ、
    // 非対応ブラウザでは<a download>フォールバック
    const mapSavePngBtn = document.getElementById("mapSavePngBtn");
    if (mapSavePngBtn) {
        mapSavePngBtn.addEventListener("click", async () => {
            const canvas = document.getElementById("mapGrid");
            if (!canvas || !mapRenderState) {
                showToast("マップが空です", "fa-triangle-exclamation");
                return;
            }
            const title = document.getElementById("scoreTitleInput").value || "NewScore";
            const filename = `${title}-map.png`;

            if (window.showSaveFilePicker) {
                try {
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
                    const handle = await window.showSaveFilePicker({
                        suggestedName: filename,
                        types: [{ description: "PNG画像", accept: { "image/png": [".png"] } }],
                    });
                    const writable = await handle.createWritable();
                    await writable.write(blob);
                    await writable.close();
                    showToast(`「${filename}」を保存しました`, "fa-floppy-disk");
                } catch (err) {
                    if (err.name !== "AbortError") console.error(err);
                }
                return;
            }

            canvas.toBlob((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);
                showToast(`「${filename}」を保存しました`, "fa-floppy-disk");
            }, "image/png");
        });
    }

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

    // 空・陸の色（3Dのみ。2Dには一度追加したがUIごと不要と判明し削除済み——
    // ただしmapSettings.skyColor/groundColor自体は今後のため残してある）。
    // 「色の確定＝ドラッグして止めた瞬間」との指摘に対応し、"change"（ピッカー全体を閉じるまで
    // 発火しない）ではなく"input"をデバウンスする方式にした。ピッカー操作中は"input"が連続発火
    // し続け、指を止めると（ピッカーを閉じなくても）それ以降イベントが来なくなる性質を利用し、
    // 最後の"input"からMAP_COLOR_INPUT_DEBOUNCE_MS経っても次が来なければそこで初めて確定・反映する
    const debouncedSetAssemblySkyColor = debounce(setAssemblySkyColor, MAP_COLOR_INPUT_DEBOUNCE_MS);
    const debouncedSetAssemblyGroundColor = debounce(setAssemblyGroundColor, MAP_COLOR_INPUT_DEBOUNCE_MS);
    document.querySelectorAll(".map-sky-color-input").forEach(el => {
        el.value = mapSettings.skyColor;
        el.addEventListener("input", (e) => debouncedSetAssemblySkyColor(e.target.value));
    });
    document.querySelectorAll(".map-ground-color-input").forEach(el => {
        el.value = mapSettings.groundColor;
        el.addEventListener("input", (e) => debouncedSetAssemblyGroundColor(e.target.value));
    });
    document.querySelectorAll(".map-color-reset-btn").forEach(el => {
        el.addEventListener("click", () => resetAssemblyColors());
    });

    // 組み立てプレビューのカメラワーク（再生/一時停止 ＋ 左回り/右回り/トロッコ視点/
    // トロッコ前視点のアングルトグル）。どちらのボタンを押した時も、現在の再生状態×
    // 選択中アングル集合の組み合わせをapplyAssemblyCameraAngleAndPlayState()にまとめて反映させる
    const assemblyCameraPlayBtn = document.getElementById("assemblyCameraPlayBtn");
    const applyAssemblyCameraPlayStyle = () => {
        if (!assemblyCameraPlayBtn) return;
        const icon = assemblyCameraPlayBtn.querySelector("i");
        if (icon) icon.className = assemblyCameraPlaying ? "fa-solid fa-pause" : "fa-solid fa-play";
        assemblyCameraPlayBtn.title = assemblyCameraPlaying ? "カメラワークを一時停止" : "カメラワークを再生";
    };
    if (assemblyCameraPlayBtn) {
        applyAssemblyCameraPlayStyle();
        assemblyCameraPlayBtn.addEventListener("click", () => {
            assemblyCameraPlaying = !assemblyCameraPlaying;
            applyAssemblyCameraAngleAndPlayState();
            applyAssemblyCameraPlayStyle();
        });
    }

    // 「3秒おきに切り替える専用ボタン」は廃止し、代わりに4つのアングルボタン自体を
    // トグル（複数選択可）にした。押すたびにassemblySelectedAngleModesへの追加/削除を
    // 切り替える（排他選択ではない）
    const assemblyAngleBtns = document.querySelectorAll(".assembly-angle-btn");
    applyAssemblyAngleButtonStyles();
    assemblyAngleBtns.forEach(btn => {
        btn.addEventListener("click", () => {
            // ランダムモード中でもこのトグル自体は普通に動く（「ランダム時に使う種類は、
            // トグルで切りかえられるように戻す」との依頼）。ランダムモードは選択集合を
            // 直接読むだけで自身では書き換えないため、ここで解除する必要はない
            const mode = btn.dataset.angleMode;
            if (assemblySelectedAngleModes.has(mode)) {
                assemblySelectedAngleModes.delete(mode);
            } else {
                assemblySelectedAngleModes.add(mode);
            }
            applyAssemblyAngleButtonStyles();
            applyAssemblyCameraAngleAndPlayState();
        });
    });

    // 「レースゲームでよくある、数秒おきにランダムにカメラが切り替わるかっこいいモード」
    const assemblyRandomCameraBtn = document.getElementById("assemblyRandomCameraBtn");
    if (assemblyRandomCameraBtn) {
        applyAssemblyRandomCameraButtonStyle();
        assemblyRandomCameraBtn.addEventListener("click", () => {
            if (assemblyRandomCameraMode) {
                stopAssemblyRandomCameraMode();
            } else {
                startAssemblyRandomCameraMode();
            }
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

    // 全画面表示。「五線譜やマップなど、中身だけを全表示にしてほしい」との依頼に対応し、
    // ヘッダー・タブ切替・各種ツールバー・再生バーを含むページ全体ではなく、#main
    // （タブの中身＝五線譜/マップ/組み立てプレビューだけを内包する要素）を全画面化する。
    // タブごとの表示切り替えはactiveTab側で既に処理済み（非表示のタブはdisplay:noneになる）
    // ため、#mainを全画面化するだけで、その瞬間に見えているタブの中身がそのまま画面いっぱいに
    // 広がる（タブ専用の要素を都度切り替える必要が無い）
    const fullscreenBtn = document.getElementById("fullscreenBtn");
    if (fullscreenBtn) {
        const fullscreenTarget = document.getElementById("main");
        const updateFullscreenBtnIcon = () => {
            const isFullscreen = !!document.fullscreenElement;
            fullscreenBtn.querySelector("i").className = isFullscreen ? "fa-solid fa-compress" : "fa-solid fa-expand";
            fullscreenBtn.title = isFullscreen ? "全画面表示を終了" : "全画面表示";
        };
        fullscreenBtn.addEventListener("click", () => {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                fullscreenTarget.requestFullscreen();
            }
        });
        // 全画面の切り替え自体でブラウザのresizeイベントが発火する場合も多いが、確実性のため
        // ヘッダー/ツールバー分の高さが増減した後の再レイアウトを明示的にここでも行う
        // （window resize用の既存処理＝updateBothTabContainerHeight/updateContentAreaMinHeights/
        // renderScore/resizeAssemblyRendererと同じ一式）
        document.addEventListener("fullscreenchange", () => {
            updateFullscreenBtnIcon();
            updateBothTabContainerHeight();
            updateContentAreaMinHeights();
            renderScore();
            setupDeleteButtons();
            setupInsertButtons();
            updateAbLoopStripGeometry();
            if (isAssemblyActive()) resizeAssemblyRenderer();
        });
        updateFullscreenBtnIcon();
        setupFullscreenIdleHide(fullscreenTarget);
    }

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

    // 「再生位置に自動で追従」トグル（ABの左）
    applyAutoFollowToggleStyle();
    document.getElementById("autoFollowToggleBtn")
        .addEventListener("click", () => {
            autoFollowPlayback = !autoFollowPlayback;
            localStorage.setItem("autoFollowPlayback", autoFollowPlayback);
            applyAutoFollowToggleStyle();
        });

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