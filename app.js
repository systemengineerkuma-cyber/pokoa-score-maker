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
let isPlaying = false;
let playTimeouts = [];
let playStartTime = null;
let noteSchedule = [];
let noteTimeMap = [];
let currentHighlightMeasure = -1;
let animFrameId = null;

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

function playNote(pitch, startTime, duration) {
    const ctx = getAudioContext();
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
}

function playScore() {
    if (isPlaying) return;
    isPlaying = true;

    const ctx = getAudioContext();
    const bpm = parseInt(document.getElementById("bpmInput").value) || 120;
    const beatDuration = 60 / bpm;

    let time = ctx.currentTime + 0.1;
    playStartTime = time;
    noteSchedule = [];
    noteTimeMap = [];
    const measuresPerRow = getMeasuresPerRow();

    score.measures.forEach((measure, measureIndex) => {
        const measureStartTime = time;
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

        measure.notes.forEach(note => {
            const duration = (durationBeats[note.duration] || 0) * beatDuration;
            if (!note.rest && note.pitches) {
                note.pitches.forEach(pitch => {
                    playNote(pitch, time, duration * 0.9);
                });
            }
            time += duration;
        });

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
    });

    const totalTime = (time - ctx.currentTime) * 1000;
    const t = setTimeout(() => {
        isPlaying = false;
        currentHighlightMeasure = -1;
        cancelAnimationFrame(animFrameId);
        highlightMeasure(-1);
        document.querySelectorAll(".playLine").forEach(el => el.remove());
        document.getElementById("playBtn").innerHTML = '<i class="fa-solid fa-play"></i>';
    }, totalTime);
    playTimeouts.push(t);

    document.getElementById("playBtn").innerHTML = '<i class="fa-solid fa-stop"></i>';
    trackPlayback();
}

function stopScore() {
    playTimeouts.forEach(t => clearTimeout(t));
    playTimeouts = [];
    isPlaying = false;
    currentHighlightMeasure = -1;
    cancelAnimationFrame(animFrameId);
    highlightMeasure(-1);
    document.querySelectorAll(".playLine").forEach(el => el.remove());
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
    document.getElementById("playBtn").innerHTML = '<i class="fa-solid fa-play"></i>';
}

function trackPlayback() {
    if (!isPlaying || !audioCtx) return;

    const now = audioCtx.currentTime;

    const current = noteSchedule.find(s => now >= s.startTime && now < s.endTime);
    if (current && current.measureIndex !== currentHighlightMeasure) {
        currentHighlightMeasure = current.measureIndex;
        highlightMeasure(currentHighlightMeasure);
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

const DURATION_ORDER = ["q", "8", "h", "w"];
const durationBeats = { "w": 4, "h": 2, "q": 1, "8": 0.5 };

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
    const durations = ["w", "h", "q", "8"];

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

function updateImageArea() {
    document.documentElement.style.setProperty('--scale', scale);
    const imageSize = Math.round(64 * scale * 0.5);
    const imageArea = document.getElementById("imageArea");
    imageArea.innerHTML = "";

    score.measures.forEach((measure, measureIndex) => {
        const group = document.createElement("div");
        group.className = "measureGroup";

        const label = document.createElement("div");
        label.className = "measureLabel";
        label.textContent = `${measureIndex + 1}`;
        group.appendChild(label);

        const imagesRow = document.createElement("div");
        imagesRow.className = "measureImages";

        const slots = Array(8).fill(null);
        let slotIndex = 0;
        measure.notes.forEach(note => {
            const beats = durationBeats[note.duration] || 0;
            const slotCount = beats / 0.5;

            if (note.rest) {
                for (let s = 0; s < slotCount; s++) {
                    if (slotIndex < 8) slots[slotIndex++] = { type: "rest" };
                }
            } else {
                for (let s = 0; s < slotCount; s++) {
                    if (slotIndex < 8) {
                        slots[slotIndex++] = s === 0
                            ? { type: "note", pitches: note.pitches }
                            : { type: "continuation" };
                    }
                }
            }
        });

        slots.forEach(slot => {
            const cell = document.createElement("div");

            if (slot === null || slot.type === "rest" || slot.type === "continuation") {
                cell.style.cssText = `
                    width: ${imageSize}px;
                    height: ${imageSize}px;
                    border: 1px dashed #ddd;
                    border-radius: 4px;
                    box-sizing: border-box;
                    flex-shrink: 0;
                `;
            } else if (slot.type === "note") {
                cell.style.cssText = `
                    width: ${imageSize}px;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: flex-start;
                    gap: 2px;
                `;
                slot.pitches.forEach(pitch => {
                    if (!PITCH_TO_FILE[pitch]) return;
                    const img = document.createElement("img");
                    img.src = `img/${PITCH_TO_FILE[pitch]}`;
                    img.alt = pitch;
                    img.style.width = `${imageSize}px`;
                    img.style.height = `${imageSize}px`;
                    img.style.transform = `rotate(${northDirection * 90}deg)`;
                    cell.appendChild(img);
                });
            }

            imagesRow.appendChild(cell);
        });

        group.appendChild(imagesRow);
        imageArea.appendChild(group);
    });

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
        img.style.cssText = `width:${imageSize}px; height:${imageSize}px;`;
        img.style.transform = `rotate(${northDirection * 90}deg)`;

        const count = document.createElement("span");
        count.style.cssText = "font-size:12px; color:#999;";
        count.textContent = `×${countMap[group] || 0}`;

        item.appendChild(img);
        item.appendChild(count);
        panelCount.appendChild(item);
    });
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
    renderScore();
    setupDeleteButtons();
}

function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    score = JSON.parse(history[historyIndex]);
    renderScore();
    setupDeleteButtons();
}

function getMeasuresPerRow() {
    const wrapper = document.getElementById("scoreWrapper");
    const availableWidth = wrapper.clientWidth - 40;
    const firstRowWidth = FIRST_MEASURE_EXTRA + STAVE_WIDTH_BASE;
    if (availableWidth < firstRowWidth * scale) return 1;
    const remaining = availableWidth - firstRowWidth * scale;
    return 1 + Math.floor(remaining / (STAVE_WIDTH_BASE * scale));
}

function renderScore() {
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

            const notes = measure.notes.map((note) => {
                if (note.rest) {
                    return new VF.StaveNote({
                        keys: ["b/4"],
                        duration: note.duration + "r"
                    });
                }

                const keys = note.pitches.map(p => pitchToKey(p).key);
                const staveNote = new VF.StaveNote({
                    keys,
                    duration: note.duration,
                    auto_stem: true
                });

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
                const nx = staveNote.getAbsoluteX() * scale;
                const svgOffsetTop = rowDiv.offsetTop;

                if (noteData.rest) {
                    const ny = staveNote.getYs()[0] * scale + svgOffsetTop;
                    notePositions.push({
                        x: nx,
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

                noteData.pitches.forEach((pitch, pitchIndex) => {
                    const ny = staveNote.getYs()[pitchIndex] * scale + svgOffsetTop;
                    notePositions.push({
                        x: nx,
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

    updateImageArea();
    updateAddButton();
    setupSVGEvents();
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
            saveHistory();
            renderScore();
            setupDeleteButtons();
        });

        wrapper.appendChild(btn);
    });
}

function updateDeleteButtons() {}

function findNoteAtX(measureIndex, clickX) {
    return notePositions.find(pos =>
        pos.measureIndex === measureIndex &&
        Math.abs(pos.x - clickX) <= 10 * scale
    ) || null;
}

function findNoteAt(measureIndex, clickX, clickY, looseness = 1) {
    const hit = notePositions.find(pos =>
        pos.measureIndex === measureIndex &&
        Math.abs(pos.x - clickX) <= 10 * scale * looseness &&
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

function setupSVGEvents() {
    const scoreElement = document.getElementById("score");
    const svgs = scoreElement.querySelectorAll("svg");

    svgs.forEach((svg, rowIndex) => {
        const rowDiv = svg.parentElement;

        svg.setAttribute("pointer-events", "all");
        svg.style.cursor = "crosshair";

        svg.addEventListener("contextmenu", e => e.preventDefault());

        svg.addEventListener("mousemove", e => {
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

            const newHovered = pitch
                ? { measureIndex, x: mouseX, y: mouseY, pitch }
                : null;

            const changed = JSON.stringify(newHovered) !== JSON.stringify(hoveredPos);
            if (changed) {
                hoveredPos = newHovered;
                renderScore();
            }
        });

        svg.addEventListener("mouseleave", () => {
            if (hoveredPos !== null) {
                hoveredPos = null;
                renderScore();
            }
        });

        svg.addEventListener("mousedown", e => {
            e.preventDefault();

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

                    const duration = remaining >= 1 ? "q" : "8";
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
                        if (note.pitches.length >= 12) return;

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

                        const duration = remaining >= 1 ? "q" : "8";
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
        });
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
    if (isPlaying) {
        rebuildNoteTimeMap();
    }
}

async function main() {

    const response = await fetch("sample_score.json");
    score = await response.json();

    renderScore();
    saveHistory();
    setupDeleteButtons();

    window.addEventListener("resize", () => {
        renderScore();
        setupDeleteButtons();
    });

    document.getElementById("addMeasureBtn")
        .addEventListener("click", () => {
            score.measures.push({ notes: [] });
            saveHistory();
            renderScore();
            setupDeleteButtons();
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

    const COMPASS_LABELS = ["N↑", "N→", "N↓", "N←"];

    document.getElementById("compassBtn")
        .addEventListener("click", () => {
            northDirection = (northDirection + 1) % 4;
            document.getElementById("compassLabel").textContent = COMPASS_LABELS[northDirection];
            updateImageArea();
        });

    document.getElementById("clearBtn")
        .addEventListener("click", () => {
            if (!confirm("全クリアしますか？")) return;
            score.measures = [{ notes: [] }];
            document.getElementById("scoreTitleInput").value = "NewScore";
            saveHistory();
            renderScore();
            setupDeleteButtons();
        });

    document.getElementById("undoBtn")
        .addEventListener("click", () => undo());

    document.getElementById("redoBtn")
        .addEventListener("click", () => redo());

    document.getElementById("playBtn")
        .addEventListener("click", () => {
            if (isPlaying) {
                stopScore();
            } else {
                playScore();
            }
        });

    document.getElementById("saveBtn")
        .addEventListener("click", () => {
            const json = JSON.stringify(score, null, 2);
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            const title = document.getElementById("scoreTitleInput").value || "NewScore";
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
                    score = JSON.parse(event.target.result);
                    history = [];
                    historyIndex = -1;
                    saveHistory();
                    renderScore();
                    setupDeleteButtons();
                } catch (err) {
                    alert("JSONの読み込みに失敗しました");
                }
            };
            reader.readAsText(file);
            e.target.value = "";
        });
}

main().catch(console.error);