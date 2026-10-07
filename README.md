# Agent Studio

The web console for the **Real Android AI Agent + Web Builder** project.

Live (GitHub Pages): https://dmpkrishnachaudhari786-netizen.github.io/agent-studio/

## What it does

A single, dependency-free PWA with four sections:

- **Chat** — send a message; the agent replies. When a device action is needed it returns a
  validated, allow-listed command your Android app can execute.
- **Web Builder** — write project files, render a live preview (local CSS/JS inlined),
  validate, download a real ZIP, and deploy to Netlify.
- **Python Runner** — run Python in the backend sandbox when connected, or in-browser via
  Pyodide otherwise.
- **Settings** — pick the AI model, connect a backend, or add your own Gemini / Netlify keys.
  Stored only in this browser (localStorage). No secrets are shipped in the source.

## Three ways to run the chat

1. **Local Python server** (recommended) — `server.py` serves the app and calls Gemini
   server-side, so your key never reaches the browser and there is no CORS problem.
2. **FastAPI backend** — point Settings at your backend URL and log in.
3. **Direct in-browser** — paste your own Gemini API key in Settings.

## Run the Python server

Standard library only — no `pip install` needed (Python 3.9+).

    GEMINI_API_KEY=your_key python3 server.py
    # open http://localhost:8000

Optional environment variables: `GEMINI_MODEL` (default `gemini-3.8-flash`),
`GEMINI_API_BASE` (default the public Gemini endpoint), `--port` / `-p`.

## Model

The default model is **`gemini-3.8-flash`**, the latest generally-available Flash model.
Note that the older `gemini-2.0-*` models are shut down, and `gemini-2.5-*` is limited to
existing users — pick a current 3.x model in Settings.

## Security model

The allow-list is enforced in all three places, identically:

- `backend/app/allowlist.py` (FastAPI backend)
- `server.py` `validate_tool` (Python server)
- `ALLOWED` in `app.js` (browser)

Only declared tools with validated arguments are ever produced; unknown tools, bad
arguments, and extra arguments are rejected.

## Deploy

Static — serve the folder with any static host, or push to GitHub Pages.

## Files

    index.html   styles.css   app.js   server.py
    manifest.webmanifest   sw.js   icons/
