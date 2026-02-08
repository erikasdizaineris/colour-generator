import express from 'express';
import cors from 'cors';
import { JSONFilePreset } from 'lowdb/node';
import { analyzeColorFromQuery } from './image-analysis.js';

const app = express();
const port = process.env.PORT || 3001;

const candidateCache = new Map();
const cacheTtlMs = 30 * 60 * 1000;

// Setup DB (Optional / Failure-safe)
const defaultData = { likes: [], candidateCache: {} };
let db = null;

try {
    db = await JSONFilePreset('db.json', defaultData);
    if (!db.data.candidateCache) {
        db.data.candidateCache = {};
    }
} catch (err) {
    console.warn("Database initialization failed (likely read-only environment). features like 'Like' will not persist.", err);
    // Create a dummy in-memory DB or just let it be null and check before use
    db = {
        read: async () => { },
        update: async () => { },
        data: defaultData
    };
}


app.use(cors());
app.use(express.json());
app.use(express.static('dist')); // Serve frontend static files

// Helper: Hashing fallback (reused logic)
function getHashColor(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    let color = '#';
    for (let i = 0; i < 3; i++) {
        const value = (hash >> (i * 8)) & 0xFF;
        color += ('00' + value.toString(16)).substr(-2);
    }
    return color.toUpperCase();
}

// Helper: Basic Color Dictionary with safe Hue Ranges (0-255 scale)
// Approximate ranges: Red(0/255), Yellow(42), Green(85), Cyan(127), Blue(170), Magenta(213)
const colorNames = {
    'red': { hex: '#FF0000', range: [[0, 20], [235, 255]] }, // Red wraps around
    'green': { hex: '#008000', range: [[60, 110]] },
    'blue': { hex: '#0000FF', range: [[150, 190]] },
    'yellow': { hex: '#FFFF00', range: [[30, 55]] },
    'cyan': { hex: '#00FFFF', range: [[110, 145]] },
    'magenta': { hex: '#FF00FF', range: [[195, 230]] },
    'white': { hex: '#FFFFFF', range: [[0, 255]] }, // White/Black/Grey are strictly saturation/lightness, but here we allow full hue if they shift
    'black': { hex: '#000000', range: [[0, 255]] },
    'gray': { hex: '#808080', range: [[0, 255]] },
    'grey': { hex: '#808080', range: [[0, 255]] },
    'orange': { hex: '#FFA500', range: [[20, 45]] },
    'purple': { hex: '#800080', range: [[180, 220]] },
    'pink': { hex: '#FFC0CB', range: [[220, 250]] },
    'brown': { hex: '#A52A2A', range: [[0, 30]] }, // Brown is basically dark orange/red
    'lime': { hex: '#00FF00', range: [[70, 95]] },
    'navy': { hex: '#000080', range: [[150, 180]] },
    'teal': { hex: '#008080', range: [[110, 140]] },
    'maroon': { hex: '#800000', range: [[240, 255], [0, 10]] },
    'olive': { hex: '#808000', range: [[40, 70]] },
    'silver': { hex: '#C0C0C0', range: [[0, 255]] },
    'gold': { hex: '#FFD700', range: [[30, 50]] },
    'violet': { hex: '#EE82EE', range: [[190, 230]] },
    'indigo': { hex: '#4B0082', range: [[180, 200]] },
    'turquoise': { hex: '#40E0D0', range: [[110, 140]] },
    'beige': { hex: '#F5F5DC', range: [[25, 45]] },
    'mint': { hex: '#98FF98', range: [[90, 120]] },
    'lavender': { hex: '#E6E6FA', range: [[170, 200]] },
    'coral': { hex: '#FF7F50', range: [[10, 30]] }
};

function tokenizeQuery(query) {
    return query
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter(Boolean);
}

function findRawColorName(query) {
    const tokens = tokenizeQuery(query);
    for (const token of tokens) {
        if (colorNames[token]) return token;
    }
    return null;
}

function isSingleRawColorQuery(query) {
    const tokens = tokenizeQuery(query);
    return tokens.length === 1 && !!colorNames[tokens[0]];
}

function getCacheKey(query, analysisQuery) {
    const q = query.toLowerCase().trim();
    const a = analysisQuery.toLowerCase().trim();
    return `${q}||${a}`;
}

function loadCachedEntry(key) {
    const record = db?.data?.candidateCache?.[key];
    if (!record) return null;

    return {
        key,
        createdAt: record.createdAt,
        candidates: Array.isArray(record.candidates) ? record.candidates : [],
        seen: new Set(Array.isArray(record.seen) ? record.seen : []),
        pagesLoaded: record.pagesLoaded || 0
    };
}

async function persistCachedEntry(cache) {
    if (!db?.data) return;
    if (!db.data.candidateCache) db.data.candidateCache = {};

    db.data.candidateCache[cache.key] = {
        createdAt: cache.createdAt,
        candidates: cache.candidates,
        seen: Array.from(cache.seen),
        pagesLoaded: cache.pagesLoaded
    };

    try {
        await db.update((data) => data);
    } catch (error) {
        console.warn('Failed to persist candidate cache:', error.message);
    }
}

function getCandidateCache(query, analysisQuery) {
    const key = getCacheKey(query, analysisQuery);
    const now = Date.now();
    const cached = candidateCache.get(key);

    if (cached && now - cached.createdAt < cacheTtlMs) {
        return cached;
    }

    const persisted = loadCachedEntry(key);
    if (persisted && now - persisted.createdAt < cacheTtlMs) {
        candidateCache.set(key, persisted);
        return persisted;
    }

    const fresh = {
        key,
        createdAt: now,
        candidates: [],
        seen: new Set(),
        pagesLoaded: 0
    };
    candidateCache.set(key, fresh);
    persistCachedEntry(fresh);
    return fresh;
}

async function getPopularCandidateForStep(query, analysisQuery, step) {
    const pageSize = 10;
    const maxPages = 10;
    const targetIndex = Math.max(0, step);
    const cache = getCandidateCache(query, analysisQuery);

    while (cache.candidates.length <= targetIndex && cache.pagesLoaded < maxPages) {
        const candidates = await analyzeColorFromQuery(query, {
            searchQuery: analysisQuery,
            offset: cache.pagesLoaded * pageSize,
            count: pageSize
        });

        cache.pagesLoaded += 1;

        let changed = false;
        if (candidates && candidates.length) {
            for (const candidate of candidates) {
                if (!cache.seen.has(candidate)) {
                    cache.seen.add(candidate);
                    cache.candidates.push(candidate);
                    changed = true;
                }
            }
        } else {
            break;
        }

        if (changed) {
            await persistCachedEntry(cache);
        }
    }

    if (cache.candidates.length > targetIndex) {
        return { candidate: cache.candidates[targetIndex], candidates: cache.candidates, index: targetIndex };
    }

    return { candidate: null, candidates: cache.candidates, index: targetIndex };
}

// Helper: Blend two colors
function blendColors(color1, color2, weight1) {
    const r1 = parseInt(color1.substring(1, 3), 16);
    const g1 = parseInt(color1.substring(3, 5), 16);
    const b1 = parseInt(color1.substring(5, 7), 16);

    const r2 = parseInt(color2.substring(1, 3), 16);
    const g2 = parseInt(color2.substring(3, 5), 16);
    const b2 = parseInt(color2.substring(5, 7), 16);

    const r = Math.round(r1 * weight1 + r2 * (1 - weight1));
    const g = Math.round(g1 * weight1 + g2 * (1 - weight1));
    const b = Math.round(b1 * weight1 + b2 * (1 - weight1));

    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

// Helper: Shift Hue
// Ranges should be an array of [min, max] pairs. e.g. Red is [[0,20], [235, 255]]
function shiftHue(hex, degree, ranges = null) {
    let r = parseInt(hex.substring(1, 3), 16) / 255;
    let g = parseInt(hex.substring(3, 5), 16) / 255;
    let b = parseInt(hex.substring(5, 7), 16) / 255;

    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // achromatic
    } else {
        let d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
        }
        h /= 6;
    }

    // Convert to 0-255 scale
    let hue255 = h * 255;

    // Apply Shift
    // If ranges exist, we must loop strictly within them
    if (ranges && ranges.length > 0) {
        let currentRange = null;

        // Find which range we are currently closest to or inside
        // Simplification: Just check if we are inside one
        for (const [min, max] of ranges) {
            if (hue255 >= min && hue255 <= max) {
                currentRange = [min, max];
                break;
            }
        }

        // If not in any range (e.g. analysis drifted), snap to the first range
        if (!currentRange) currentRange = ranges[0];

        // Shift within the range
        const [min, max] = currentRange;
        hue255 += degree;

        // Loop locally until within range
        while (hue255 > max) hue255 = min + (hue255 - max);
        while (hue255 < min) hue255 = max - (min - hue255);

    } else {
        // Global Loop (0-255)
        hue255 += degree;
        if (hue255 > 255) hue255 -= 255;
        else if (hue255 < 0) hue255 += 255;
    }

    h = hue255 / 255;

    let q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    let p = 2 * l - q;

    const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };

    const toHex = x => {
        const hex = Math.round(x * 255).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    };

    const rNew = hue2rgb(p, q, h + 1 / 3);
    const gNew = hue2rgb(p, q, h);
    const bNew = hue2rgb(p, q, h - 1 / 3);

    return `#${toHex(rNew)}${toHex(gNew)}${toHex(bNew)}`.toUpperCase();
}

app.post('/api/generate', async (req, res) => {
    const { query, previousColor, mode, step = 0 } = req.body;

    if (typeof query !== 'string') {
        return res.status(400).json({ error: 'Missing query' });
    }

    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
        return res.status(400).json({ error: 'Empty query' });
    }

    console.log(`[Generate] query="${normalizedQuery}" mode=${mode || 'new'} step=${step}`);

    const isRawOnly = isSingleRawColorQuery(normalizedQuery);
    const rawColorName = isRawOnly ? findRawColorName(normalizedQuery) : null;
    const rawColorData = rawColorName ? colorNames[rawColorName] : null;
    const spectrumColorName = findRawColorName(normalizedQuery);
    const spectrumRanges = spectrumColorName ? colorNames[spectrumColorName]?.range : null;

    if (isRawOnly) {
        return res.json({ color: rawColorData.hex, source: 'raw_exact' });
    }

    const learned = db?.data?.likes
        ?.slice()
        .reverse()
        .find((item) => item.query.toLowerCase() === normalizedQuery.toLowerCase());

    if (!mode && step === 0 && learned?.color) {
        return res.json({ color: learned.color, source: 'learned' });
    }

    // MODE: DISLIKE/SHIFT (Legacy Hue Shift + New Logic combined?)
    // The user said: "The dislike button doesn't generate new colour as required... pressing dislike button should make the colour 3.9 percent more..."
    // This implies we follow the new "Refine" path on dislike.
    // We will use the 'step' parameter to track how many times they disliked.
    // NOTE: We do NOT need to read DB here.

    // 1. Perform Analysis (Get all candidates)
    // We cache this? Ideally yes, but for stateless simplicity we might re-fetch. 
    // Optimization: In a real app we'd cache the candidates in the DB or memory. 
    // Here we re-run analysis (which searches images). 
    // To be faster/stable, let's assume analyzeColorFromQuery returns the same-ish results 
    // or we lean on the "randomness" of the search to provide the variety the user wants via "top 10+n".

    let candidates = [];
    let candidateIndex = 0;
    let selectedAnalyzedColor = null;
    try {
        let analysisQuery = normalizedQuery;
        if (mode === 'refine' && rawColorName) {
            analysisQuery = `${normalizedQuery} 10 percent more ${rawColorName}`;
        }

        const result = await getPopularCandidateForStep(normalizedQuery, analysisQuery, step);

        if (result && result.candidate) {
            selectedAnalyzedColor = result.candidate;
            candidates = result.candidates || [];
            candidateIndex = result.index || 0;
        }
    } catch (e) {
        console.warn("Analysis skipped or failed:", e.message);
    }

    if (candidates.length === 0) {
        for (let i = 0; i < 15; i++) {
            candidates.push(getHashColor(normalizedQuery + i));
        }
        candidateIndex = step % candidates.length;
        selectedAnalyzedColor = candidates[candidateIndex];
    }

    let finalColor = null;
    let weight = 0;
    const currentStep = step;

    if (!selectedAnalyzedColor) {
        selectedAnalyzedColor = candidates[candidateIndex];
    }

    finalColor = selectedAnalyzedColor;

    if (rawColorData) {
        weight = 0.8;
        finalColor = blendColors(rawColorData.hex, selectedAnalyzedColor, weight);
    }

    if (spectrumRanges) {
        finalColor = shiftHue(finalColor, 0, spectrumRanges);
    }

    if (previousColor && finalColor.toUpperCase() === previousColor.toUpperCase()) {
        if (candidates.length > 1) {
            const nextIndex = (candidateIndex + 1) % candidates.length;
            selectedAnalyzedColor = candidates[nextIndex];
            if (rawColorData) {
                finalColor = blendColors(rawColorData.hex, selectedAnalyzedColor, weight || 0.8);
            } else {
                finalColor = selectedAnalyzedColor;
            }
            if (spectrumRanges) {
                finalColor = shiftHue(finalColor, 0, spectrumRanges);
            }
        } else {
            console.log("Persistent collision. Forcing hue shift.");
            finalColor = shiftHue(finalColor, 30, spectrumRanges);
        }
    }

    // Final failsafe: if we still collide after attempts, force a hue shift
    if (previousColor && finalColor.toUpperCase() === previousColor.toUpperCase()) {
        console.log("Persistent collision. Forcing hue shift.");
        finalColor = shiftHue(finalColor, 30, spectrumRanges); // Shift 30 degrees
    }

    if (rawColorData) {
        console.log(`Result: ${finalColor} (Source: Weighted Raw, Step: ${currentStep}, Weight: ${weight.toFixed(3)})`);
        return res.json({ color: finalColor, source: 'weighted_raw', weight, step: currentStep });
    }

    // Final Safety Check
    if (!finalColor) {
        console.warn("Unexpected: finalColor is null. Using fallback.");
        finalColor = "#CCCCCC";
    }

    // Else 100% Analysis (Cycling through candidates)
    console.log(`Result: ${finalColor} (Source: Analysis, Step: ${currentStep})`);
    return res.json({ color: finalColor, source: 'analyzed_candidate', step: currentStep });
});

app.post('/api/feedback', async (req, res) => {
    const { query, color, rating } = req.body;

    if (rating === 'like' && db) { // Only attempt write if DB is healthy
        try {
            await db.update(({ likes }) => likes.push({ query, color, timestamp: Date.now() }));
            console.log(`Learned: ${query} => ${color}`);
        } catch (e) {
            console.error("Failed to save feedback", e);
        }
    }

    res.json({ success: true });
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
