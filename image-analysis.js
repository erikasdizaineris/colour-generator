import fetch from 'node-fetch';
import sharp from 'sharp';
import quantize from 'quantize';

// Helper to get dominant color from an image URL
async function getDominantColor(url) {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
            }
        });

        if (!response.ok) {
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
async function searchImages(query) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
    };

    try {
        console.log(`Searching images for: ${query} (trying DuckDuckGo/Bing)`);

        // Using a Bing Scraper fallback which is generally more permissive for demo purposes
        const bingUrl = `https://www.bing.com/images/async?q=${encodeURIComponent(query)}&first=0&count=10&mmasync=1`;

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

        while ((match = murlRegex.exec(html)) !== null && urls.length < 8) {
            urls.push(match[1]);
        }

        console.log(`Found ${urls.length} images for ${query}`);
        return urls;

    } catch (e) {
        console.error("Search failed:", e);
        return [];
    }
}

export async function analyzeColorFromQuery(query) {
    console.log(`Analyzing color for: ${query}`);

    // 1. Search images
    const imageUrls = await searchImages(query);
    if (imageUrls.length === 0) return null;

    // 2. Analyze images to build a candidate list
    // We want "top 10+n" results available for the user to cycle through.
    // We'll fetch up to 10 images and get the dominant color from each.
    const candidates = [];

    // Process in parallel for speed, but limit to 5-8 to save bandwidth/time
    // The user mentioned "top 10", let's try to get a good spread.
    const processPromises = imageUrls.slice(0, 8).map(url => getDominantColor(url));
    const results = await Promise.all(processPromises);

    for (const col of results) {
        if (col) {
            // Convert [r,g,b] to Hex
            const hex = "#" + ((1 << 24) + (col[0] << 16) + (col[1] << 8) + col[2]).toString(16).slice(1).toUpperCase();
            candidates.push(hex);
        }
    }

    if (candidates.length === 0) return null;

    // Return the full list of candidates
    return candidates;
}
