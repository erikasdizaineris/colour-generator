const colorInput = document.getElementById('colorInput');
const generateBtn = document.getElementById('generateBtn');
const colorPreview = document.getElementById('colorPreview');
const hexCodeSpan = document.getElementById('hexCode');
const similarBtn = document.getElementById('similarBtn');
const downloadBtn = document.getElementById('downloadBtn');
const canvas = document.getElementById('canvas');
const toast = document.getElementById('toast');

const requiredElements = [colorInput, generateBtn, colorPreview, hexCodeSpan, downloadBtn];
if (requiredElements.some((el) => !el)) {
    console.error('Missing required UI elements. Make sure the latest HTML is deployed.');
}

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


// Single-line log for color generation
function setColorLog(line) {
    const logDiv = document.getElementById('colorLog');
    if (logDiv) logDiv.textContent = line || '';
}

// generateColor can now take an options object
async function generateColor(options = {}) {
    if (requiredElements.some((el) => !el)) {
        return;
    }

    const query = colorInput.value.trim();
    if (!query) return;

    const { previousColor, mode, step } = options;


    // Reset UI
    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';
    clearColorLog();

    // Reset steps if this is a fresh generation
    if (!mode) {
        dislikeStep = 0;
    }

    appendColorLog('Starting color generation...');

    if (mode !== 'refine' && similarBtn) {
        similarBtn.disabled = true;
    }

    // Let the backend handle raw color detection and spectrum mapping
    appendColorLog('Analyzing your query and generating color...');

    try {
        appendColorLog('Requesting color from server...');
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

        if (spinner) spinner.style.display = 'none';
        if (!response.ok) {
            appendColorLog('AI analysis failed.');
            // If backend returns error, show error message in color rectangle
            let errorMsg = 'AI analysis failed.';
            try {
                const errData = await response.json();
                if (errData && errData.error) errorMsg = errData.error;
            } catch {}
            colorPreview.style.backgroundColor = '#27272a';
            colorPreview.classList.add('active');
            hexCodeSpan.textContent = '';
            // Remove any previous error
            let errorSpan = document.getElementById('colorErrorMsg');
            if (!errorSpan) {
                errorSpan = document.createElement('span');
                errorSpan.id = 'colorErrorMsg';
                errorSpan.style.position = 'absolute';
                errorSpan.style.top = '50%';
                errorSpan.style.left = '50%';
                errorSpan.style.transform = 'translate(-50%, -50%)';
                errorSpan.style.background = 'rgba(0,0,0,0.7)';
                errorSpan.style.color = '#fff';
                errorSpan.style.fontSize = '1.2rem';
                errorSpan.style.padding = '1rem 2rem';
                errorSpan.style.borderRadius = '12px';
                errorSpan.style.zIndex = '2';
                errorSpan.style.pointerEvents = 'none';
                colorPreview.appendChild(errorSpan);
            }
            errorSpan.textContent = errorMsg;
            downloadBtn.disabled = true;
            if (similarBtn) similarBtn.disabled = true;
            colorInput.style.borderColor = '#ef4444';
            return;
        }

        // Remove error message if present
        let errorSpan = document.getElementById('colorErrorMsg');
        if (errorSpan) errorSpan.remove();
        appendColorLog('Color generated successfully.');
        if (spinner) spinner.style.display = 'none';

        const data = await response.json();
        if (!data || typeof data.color !== 'string') {
            throw new Error('No color in response');
        }
        let generatedColor = rgbToHex(data.color).toUpperCase();
        appendColorLog('Result: ' + generatedColor);

        // Client-side Collision Check Fallback
        if (previousColor && generatedColor === previousColor) {
            console.warn("Server returned same color. Forcing client-side shift.");
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
        if (similarBtn) {
            similarBtn.disabled = false;
        }
        colorInput.style.borderColor = generatedColor;

        if (spinner) spinner.style.display = 'none';
    } catch (err) {
        appendColorLog('Error: ' + (err && err.message ? err.message : 'Unknown error'));
        console.warn('Backend unavailable:', err);
        // Show error message in color rectangle
        let errorMsg = 'AI analysis failed.';
        colorPreview.style.backgroundColor = '#27272a';
        colorPreview.classList.add('active');
        hexCodeSpan.textContent = '';
        let errorSpan = document.getElementById('colorErrorMsg');
        if (!errorSpan) {
            errorSpan = document.createElement('span');
            errorSpan.id = 'colorErrorMsg';
            errorSpan.style.position = 'absolute';
            errorSpan.style.top = '50%';
            errorSpan.style.left = '50%';
            errorSpan.style.transform = 'translate(-50%, -50%)';
            errorSpan.style.background = 'rgba(0,0,0,0.7)';
            errorSpan.style.color = '#fff';
            errorSpan.style.fontSize = '1.2rem';
            errorSpan.style.padding = '1rem 2rem';
            errorSpan.style.borderRadius = '12px';
            errorSpan.style.zIndex = '2';
            errorSpan.style.pointerEvents = 'none';
            colorPreview.appendChild(errorSpan);
        }
        errorSpan.textContent = errorMsg;
        if (spinner) spinner.style.display = 'none';
        downloadBtn.disabled = true;
        if (similarBtn) similarBtn.disabled = true;
        colorInput.style.borderColor = '#ef4444';
    } finally {
        if (spinner) spinner.style.display = 'none';
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate';
    }
}

async function sendFeedback(rating) {
    if (!currentQuery || !currentColor) return;

    try {
        // Handle Like
        if (rating === 'like') {
            await fetch(feedbackEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: currentQuery, color: currentColor, rating })
            });

        }

    } catch (err) {
        console.error('Feedback failed:', err);
    }
}

async function generateSimilar() {
    if (!currentQuery || !currentColor) return;

    if (!similarBtn) return;

    const originalText = similarBtn.textContent;
    similarBtn.disabled = true;
    similarBtn.textContent = 'Generating...';

    try {
        dislikeStep++;
        await generateColor({ previousColor: currentColor, mode: 'refine', step: dislikeStep });
    } finally {
        similarBtn.disabled = false;
        similarBtn.textContent = originalText;
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

if (generateBtn && colorInput) {
    generateBtn.addEventListener('click', generateColor);
    colorInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') generateColor();
    });
}

if (downloadBtn) {
    downloadBtn.addEventListener('click', async () => {
        await sendFeedback('like');
        downloadImage();
    });
}

if (similarBtn) {
    similarBtn.addEventListener('click', generateSimilar);
}

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

    toast.style.display = 'block';
    toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        toast.style.display = 'none';
    }, 2000);
}

if (hexCodeSpan) {
    hexCodeSpan.addEventListener('click', async (event) => {
        if (!currentColor) return;

        try {
            await sendFeedback('like');
        } catch (err) {
            console.warn('Failed to send learning feedback on copy:', err);
        }

        navigator.clipboard.writeText(currentColor).then(() => {
            showToast('Copied to clipboard!', event, false);
        }).catch(err => {
            console.error('Failed to copy class', err);
            // Fallback if clipboard fails (rare in secure contexts)
            showToast('Failed to copy', event, true);
        });
    });
}
