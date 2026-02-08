# Colour Generator

A web application that generates colors based on text descriptions using image analysis.

## Features
- **Text-to-Color**: Enter a phrase like "Mint Green" or "Ocean Blue" to generate a color.
- **Image Analysis**: Uses Bing Image Search to find images matching the description and extracts the dominant color.
- **Refinement**: Click "Dislike" to refine the color if it's not quite right.
- **Export**: Download the generated color as an SVG swatch.

## Tech Stack
- **Frontend**: Vanilla JS + Vite
- **Backend**: Node.js + Express
- **Analysis**: Custom scraper + `get-pixels` + `quantize`

## Development
```bash
# Install dependencies
npm install

# Run development server (Frontend + Backend)
npm run dev
# In a separate terminal
npm run start
```

## Deployment
1.  Ensure `node_modules` is ignored.
2.  Set `PORT` environment variable on your host.
3.  Run `npm install` and `npm run build` on the server.
4.  Start with `npm start`.
