import fetch from 'node-fetch';
import sharp from 'sharp';
import quantize from 'quantize';

const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

let cachedGeminiModel = null;
let cachedGeminiModelAt = 0;
let warnedMissingGeminiKey = false;
const blockedDomains = new Set([
    'gun.deals',
    'image.invaluable.com',
    'a.1stdibscdn.com',
    'i.pinimg.com',
    'm.media-amazon.com',
    'cdni.rbth.com'
]);

function shouldSkipUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return blockedDomains.has(host);
    } catch {
        return true;
    }
}

function tokenize(text) {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

const colorWordSet = new Set([
    'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'black', 'gray', 'grey',
    'orange', 'purple', 'pink', 'brown', 'lime', 'navy', 'teal', 'maroon', 'olive',
    'silver', 'gold', 'violet', 'indigo', 'turquoise', 'beige', 'mint', 'lavender', 'coral'
]);

function extractColorAndThing(query) {
    const tokens = tokenize(query);
    const colorTokens = tokens.filter((token) => colorWordSet.has(token));
    const color = colorTokens[0] || '';
    const thingTokens = tokens.filter((token) => token !== color);
    const thing = thingTokens.join(' ').trim();
    return { color, thing };
}

function extractJsonObject(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        try {
            return JSON.parse(match[0]);
        } catch {
            return null;
        }
    }
}

function normalizeHexList(colors) {
    if (!Array.isArray(colors)) return [];
    return colors
        .map((col) => {
            if (typeof col !== 'string') return null;
            const trimmed = col.trim();
            const hexMatch = trimmed.match(/^#?[0-9A-Fa-f]{6}$/);
            if (!hexMatch) return null;
            return trimmed.startsWith('#') ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
        })
        .filter(Boolean);
}

async function fetchGeminiModel() {
    if (!geminiApiKey) return null;
    const now = Date.now();
    if (cachedGeminiModel && now - cachedGeminiModelAt < 10 * 60 * 1000) {
        return cachedGeminiModel;
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiApiKey}`;
    const response = await fetch(endpoint);
    if (!response.ok) {
        console.warn('Gemini model list request failed:', response.status);
        return null;
    }

    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models : [];
    const supported = models.filter((model) =>
        Array.isArray(model.supportedGenerationMethods) &&
        model.supportedGenerationMethods.includes('generateContent')
    );

    const preferredName = `models/${geminiModel}`;
    const preferred = supported.find((model) => model.name === preferredName);
    if (preferred) {
        cachedGeminiModel = preferred.name.replace('models/', '');
        cachedGeminiModelAt = now;
        return cachedGeminiModel;
    }

    const ranked = supported
        .map((model) => model.name)
        .filter((name) => !name.includes('embedding'))
        .sort((a, b) => {
            const score = (name) => {
                if (name.includes('flash')) return 3;
                if (name.includes('pro')) return 2;
                return 1;
            };
            return score(b) - score(a);
        });

    cachedGeminiModel = ranked.length ? ranked[0].replace('models/', '') : geminiModel;
    cachedGeminiModelAt = now;
    return cachedGeminiModel;
}

async function analyzeImageWithGemini(url, query, model) {
    if (!geminiApiKey || !model) return null;
    if (shouldSkipUrl(url)) return null;

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
        }
    });

    if (!response.ok) {
        if (response.status === 403) return null;
        throw new Error(`Image fetch failed: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString('base64');

    const { color, thing } = extractColorAndThing(query);
    const targetColor = color || 'main';
    const targetThing = thing || query;
    const prompt = `Return only JSON. Question: What hex color values is "${targetColor}" on the "${targetThing}"?\n` +
        `Schema: {"colors":["#RRGGBB", ...]}\n` +
        `Rules: 2-5 colors, no extra text.`;

    const body = {
        contents: [
            {
                role: 'user',
                parts: [
                    { text: prompt },
                    { inlineData: { mimeType: contentType, data: base64 } }
                ]
            }
        ]
    };

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
    const geminiResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text();
        throw new Error(`Gemini API error: ${geminiResponse.status} ${errorText}`);
    }

    const payload = await geminiResponse.json();
    const text = payload?.candidates?.[0]?.content?.parts
        ?.map((part) => part.text || '')
        .join('') || '';

    const json = extractJsonObject(text);
    if (!json) return null;

    const colors = normalizeHexList(json.colors);
    if (!colors.length) return null;

    return { colors };
}

async function mapWithLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let index = 0;

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => (async () => {
        while (true) {
            const current = index++;
            if (current >= items.length) break;
            try {
                results[current] = await mapper(items[current], current);
            } catch (error) {
                console.error('Gemini analysis failed:', items[current], error.message);
                results[current] = null;
            }
        }
    })());

    await Promise.all(workers);
    return results;
}

// Helper to get dominant color from an image URL
async function getDominantColor(url) {
    try {
        if (shouldSkipUrl(url)) return null;
        let signal;
        let timeoutId;
        if (typeof AbortController !== 'undefined') {
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), 4000);
            signal = controller.signal;
        }

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
            },
            signal
        });

        if (timeoutId) clearTimeout(timeoutId);

        if (!response.ok) {
            if (response.status === 403) return null;
            throw new Error(`Image fetch failed: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // Downscale to keep processing lightweight while preserving dominant color.
        const { data, info } = await sharp(buffer)
            .resize({ width: 180, height: 180, fit: 'inside', withoutEnlargement: true })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        const pixelCount = info.width * info.height;
        const pixelArray = [];

        // Sample every 10th pixel for performance
        for (let i = 0; i < pixelCount; i += 10) {
            const offset = i * 4;
            const r = data[offset];
            const g = data[offset + 1];
            const b = data[offset + 2];
            const a = data[offset + 3];

            // Ignore transparent or very white/black pixels
            if (a < 125) continue;
            if (r > 250 && g > 250 && b > 250) continue;
            if (r < 10 && g < 10 && b < 10) continue;

            pixelArray.push([r, g, b]);
        }

        if (pixelArray.length === 0) return null;

        const colorMap = quantize(pixelArray, 5);
        const palette = colorMap.palette();

        // Return top color
        return palette[0]; // [r, g, b]
    } catch (error) {
        console.error('Error analyzing image:', url, error.message);
        return null;
    }
}

// Simple image search scraper (DuckDuckGo HTML fallback or similar)
// For this demo, since we don't have an API key, we'll try to use a free specialized source
// or scrape a public search result page.
// A robust way without keys is tricky.
// We will use 'unsplash' source API for demo purposes as it is reliable for "concepts".
// Robust image search trying multiple sources
async function searchImages(query, options = {}) {
    const { offset = 0, count = 10 } = options;
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };

    try {
        console.log(`Searching images for: ${query} (trying DuckDuckGo/Bing)`);

        // Using a Bing Scraper fallback which is generally more permissive for demo purposes
        const bingUrl = `https://www.bing.com/images/async?q=${encodeURIComponent(query)}&first=${offset}&count=${count}&mmasync=1`;

        // Add 3s timeout to prevent hanging (if supported)
        let signal;
        let timeoutId;
        if (typeof AbortController !== 'undefined') {
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), 3000);
            signal = controller.signal;
        }

        const response = await fetch(bingUrl, { headers, signal });
        if (timeoutId) clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`Bing returned ${response.status}`);

        const html = await response.text();

        // Bing typically puts images in murl or similar.
        const murlRegex = /murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/g;
        let match;
        const urls = [];

        while ((match = murlRegex.exec(html)) !== null && urls.length < count) {
            urls.push(match[1]);
        }

        console.log(`Found ${urls.length} images for ${query}`);
        return urls;

    } catch (e) {
        console.error('Search failed:', e);
        return [];
    }
}

export async function analyzeColorFromQuery(query, options = {}) {
    const { searchQuery = query, offset = 0, count = 10 } = options;
    console.log(`Analyzing color for: ${query}`);

    // 1. Search images
    const imageUrls = await searchImages(searchQuery, { offset, count });
    if (imageUrls.length === 0) return null;

    // 2. Analyze images to build a candidate list
    // Prefer Gemini vision analysis when configured; fallback to dominant colors.
    const candidates = [];
    const colorCounts = new Map();
    let orderCounter = 0;
    const urls = imageUrls.slice(0, count);

    if (geminiApiKey) {
        const model = await fetchGeminiModel();
        console.log('[Gemini] Using model:', model || 'none');
        const results = await mapWithLimit(urls, 3, (url) => analyzeImageWithGemini(url, query, model));

        for (const result of results) {
            if (!result) continue;
            const colors = Array.isArray(result.colors) ? result.colors : [];
            for (const color of colors) {
                if (!colorCounts.has(color)) {
                    colorCounts.set(color, { count: 1, order: orderCounter++ });
                } else {
                    colorCounts.get(color).count += 1;
                }
            }
        }
    }

    if (!geminiApiKey && !warnedMissingGeminiKey) {
        console.warn('Gemini API key is missing; falling back to dominant color analysis.');
        warnedMissingGeminiKey = true;
    }

    if (colorCounts.size === 0) {
        const processPromises = urls.map(url => getDominantColor(url));
        const results = await Promise.allSettled(processPromises);

        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                const col = result.value;
                const hex = "#" + ((1 << 24) + (col[0] << 16) + (col[1] << 8) + col[2]).toString(16).slice(1).toUpperCase();
                if (!colorCounts.has(hex)) {
                    colorCounts.set(hex, { count: 1, order: orderCounter++ });
                } else {
                    colorCounts.get(hex).count += 1;
                }
            }
        }
    }

    if (colorCounts.size === 0) return null;

    const ranked = Array.from(colorCounts.entries())
        .map(([color, meta]) => ({ color, count: meta.count, order: meta.order }))
        .sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.order - b.order;
        });

    for (const entry of ranked) {
        candidates.push(entry.color);
    }

    return candidates;
}
