const colorInput = document.getElementById('colorInput');
const generateBtn = document.getElementById('generateBtn');
const colorPreview = document.getElementById('colorPreview');
const hexCodeSpan = document.getElementById('hexCode');
const downloadBtn = document.getElementById('downloadBtn');
const canvas = document.getElementById('canvas');
const feedbackContainer = document.getElementById('feedbackContainer');
const likeBtn = document.getElementById('likeBtn');
const dislikeBtn = document.getElementById('dislikeBtn');
const toast = document.getElementById('toast');

const apiBase = (import.meta && import.meta.env && import.meta.env.VITE_API_BASE) ? import.meta.env.VITE_API_BASE : '';
const normalizedApiBase = apiBase.replace(/\/+$/, '');
const generateEndpoint = normalizedApiBase ? `${normalizedApiBase}/api/generate` : '/api/generate';
const feedbackEndpoint = normalizedApiBase ? `${normalizedApiBase}/api/feedback` : '/api/feedback';

let currentColor = '';
let currentQuery = '';
let toastTimer = null;

// Helper to ensure valid hex
function rgbToHex(col) {
    if (!col) return '#FFFFFF';
    if (col.startsWith('#')) return col;
    // Basic sanity check, backend usually sends Hex
    return col;
}

// Track refinement steps
let dislikeStep = 0;

// generateColor can now take an options object
async function generateColor(options = {}) {
    const query = colorInput.value.trim();
    if (!query) return;

    const { previousColor, mode, step } = options;

    // Reset UI
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';

    // Reset steps if this is a fresh generation
    if (!mode) {
        dislikeStep = 0;
    }

    // Visual reset on new searches
    if (mode !== 'refine') {
        feedbackContainer.style.display = 'none';
        likeBtn.classList.remove('liked');
        dislikeBtn.classList.remove('disliked');
    }

    try {
        const response = await fetch(generateEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                previousColor,
                mode, // 'refine' or undefined
                step: step || 0
            })
        });

        if (!response.ok) throw new Error('Generation failed');

        const data = await response.json();
        if (!data || typeof data.color !== 'string') {
            throw new Error('No color in response');
        }
        let generatedColor = rgbToHex(data.color).toUpperCase();

        // Client-side Collision Check Fallback
        if (previousColor && generatedColor === previousColor) {
            console.warn("Server returned same color. Forcing client-side shift.");
            // Simple robust shift: just invert or rotate
            // We can reuse the helper logic or just do a simple math shift
            // Let's call a simple inline shift since I can't easily add the helper function in this block scope without moving it.
            // Actually, I can just do a simple bit manipulation here.
            const num = parseInt(generatedColor.slice(1), 16);
            const shifted = (num + 0x333333) % 0xFFFFFF;
            generatedColor = '#' + shifted.toString(16).padStart(6, '0').toUpperCase();
        }

        currentQuery = query;
        currentColor = generatedColor;

        // Update UI
        colorPreview.style.backgroundColor = generatedColor;
        colorPreview.classList.add('active');
        hexCodeSpan.textContent = generatedColor;
        downloadBtn.disabled = false;
        colorInput.style.borderColor = generatedColor;

        // Ensure feedback is visible again and buttons are reset
        feedbackContainer.style.display = 'flex';
        // Reset buttons to "neutral" after reload
        likeBtn.classList.remove('liked');
        dislikeBtn.classList.remove('disliked');

    } catch (err) {
        console.warn('Backend unavailable:', err);

        // Fallback: Client-side hash generation
        // Re-implementing the simple hash here locally since we need it due to backend failure
        let hash = 0;
        const seed = query + (step || 0); // Use step as seed for variety
        for (let i = 0; i < seed.length; i++) {
            hash = seed.charCodeAt(i) + ((hash << 5) - hash);
        }
        let c = '#';
        for (let i = 0; i < 3; i++) {
            const value = (hash >> (i * 8)) & 0xFF;
            c += ('00' + value.toString(16)).substr(-2);
        }
        const fallbackColor = c.toUpperCase();

        // Update UI (Fallback mode)
        colorPreview.style.backgroundColor = fallbackColor;
        colorPreview.classList.add('active');
        hexCodeSpan.textContent = fallbackColor;
        currentColor = fallbackColor;
        downloadBtn.disabled = false;
        colorInput.style.borderColor = fallbackColor;

        // Hide feedback since we can't save it
        feedbackContainer.style.display = 'none';

        // Also reset buttons
        likeBtn.classList.remove('liked');
        dislikeBtn.classList.remove('disliked');
    } finally {
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate';
    }
}

async function sendFeedback(rating) {
    if (!currentQuery || !currentColor) return;

    try {
        if (rating === 'dislike') {
            // Visual Feedback
            dislikeBtn.classList.add('disliked');
            likeBtn.classList.remove('liked');

            const originalText = dislikeBtn.textContent;
            dislikeBtn.disabled = true;
            dislikeBtn.textContent = '...';

            // Increment step and refine
            dislikeStep++;
            await generateColor({ previousColor: currentColor, mode: 'refine', step: dislikeStep });

            // Restore button
            dislikeBtn.disabled = false;
            dislikeBtn.textContent = originalText;
            return;
        }

        // Handle Like
        if (rating === 'like') {
            await fetch(feedbackEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: currentQuery, color: currentColor, rating })
            });

            likeBtn.classList.add('liked');
            dislikeBtn.classList.remove('disliked');
        }

    } catch (err) {
        console.error('Feedback failed:', err);
        dislikeBtn.disabled = false;
        dislikeBtn.textContent = '👎';
    }
}

// ... (downloadImage function)

// Helper to Force Hue Shift Client-Side
function forceClientHueShift(hex) {
    // Simple hue rotation
    let r = parseInt(hex.substring(1, 3), 16);
    let g = parseInt(hex.substring(3, 5), 16);
    let b = parseInt(hex.substring(5, 7), 16);

    // Rotate RGB roughly
    let newR = g;
    let newG = b;
    let newB = r;

    return "#" + ((1 << 24) + (newR << 16) + (newG << 8) + newB).toString(16).slice(1).toUpperCase();
}

// Inside generateColor, check for collision
// Update the collision check block in generateColor:

/* 
   NOTE: I am modifying the generateColor function flow slightly to include the check.
   Since I cannot easily target just the collision logic inside the big function with replace_file_content 
   without pasting the whole thing, I will focus on the UI reset logic which needs to NOT reset feedback 
   if we are in refine mode, which is already handled.
   
   Wait, I need to inject the client-side collision check. 
   I will append it after `const generatedColor = data.color;`
*/

function downloadImage() {
    if (!currentColor) return;

    // Create SVG content
    const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="${currentColor}" />
  <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="80" fill="${getContrastYIQ(currentColor)}" text-anchor="middle" dy=".3em">${currentColor}</text>
</svg>`;

    // Create Blob
    const blob = new Blob([svgContent], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    // Download
    const link = document.createElement('a');
    link.download = `swatch-${currentColor.substring(1)}.svg`;
    link.href = url;
    link.click();

    // Cleanup
    URL.revokeObjectURL(url);
}

// Helper for text contrast in SVG
function getContrastYIQ(hexcolor) {
    hexcolor = hexcolor.replace("#", "");
    var r = parseInt(hexcolor.substr(0, 2), 16);
    var g = parseInt(hexcolor.substr(2, 2), 16);
    var b = parseInt(hexcolor.substr(4, 2), 16);
    var yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return (yiq >= 128) ? 'black' : 'white';
}

generateBtn.addEventListener('click', generateColor);
colorInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') generateColor();
});

downloadBtn.addEventListener('click', downloadImage);
likeBtn.addEventListener('click', () => sendFeedback('like'));
dislikeBtn.addEventListener('click', () => sendFeedback('dislike'));

function showToast(message, event, isError = false) {
    if (!toast) return;

    toast.textContent = message;
    toast.classList.toggle('error', isError);

    const offset = 12;
    const maxWidth = 240;
    const maxHeight = 60;
    const fallbackX = window.innerWidth / 2;
    const fallbackY = 24;
    const x = typeof event?.clientX === 'number' ? event.clientX : fallbackX;
    const y = typeof event?.clientY === 'number' ? event.clientY : fallbackY;

    const left = Math.min(Math.max(8, x + offset), window.innerWidth - maxWidth - 8);
    const top = Math.min(Math.max(8, y + offset), window.innerHeight - maxHeight - 8);

    toast.style.left = `${left}px`;
    toast.style.top = `${top}px`;

    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 2000);
}

hexCodeSpan.addEventListener('click', (event) => {
    if (!currentColor) return;

    navigator.clipboard.writeText(currentColor).then(() => {
        showToast('Copied to clipboard!', event, false);
    }).catch(err => {
        console.error('Failed to copy class', err);
        // Fallback if clipboard fails (rare in secure contexts)
        showToast('Failed to copy', event, true);
    });
});
