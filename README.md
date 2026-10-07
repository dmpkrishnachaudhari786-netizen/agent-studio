# Agent Studio

The web console for the **Real Android AI Agent + Web Builder** project.

Live: https://dmpkrishnachaudhari786-netizen.github.io/agent-studio/

## What it does

A single, dependency-free PWA with four sections:

- **Planner** — describe an Android task; the agent returns an allow-listed, validated command
  your Android app can execute. Works against the FastAPI backend (`/api/agent/plan`) or
  directly against Gemini from the browser.
- **Web Builder** — write project files, render a live preview (local CSS/JS inlined),
  validate, download a real ZIP, and deploy to Netlify.
- **Python Runner** — run Python in the backend sandbox when connected, or in-browser via
  Pyodide otherwise.
- **Settings** — backend URL + login, or direct Gemini / Netlify keys. Stored only in this
  browser (localStorage). No secrets are shipped in the source.

## Security model

The allow-list is mirrored client-side (`ALLOWED` in `app.js`): only declared tools with
validated arguments are ever produced, matching `backend/app/allowlist.py`.

## Deploy

Static — serve the folder with any static host, or push to GitHub Pages.

## Local run

    python3 -m http.server 8000
    # open http://localhost:8000
