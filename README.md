# Walled DLP Guard

A lightweight **desktop** Data Loss Prevention (DLP) app for the **ChatGPT** (chatgpt.com) and **Perplexity** (perplexity.ai) web apps.

- It checks outgoing **text prompts** and **file uploads** (text, PDF and images) for the marker `WALLED_SENSITIVE` **before** they leave the browser.
- If it finds the marker, it shows a **native desktop dialog** (Win32 TaskDialog on Windows) with **Continue** and **Cancel**. The dialog says whether the marker was in a prompt or a file, and names the prompt or file.
- **Continue** lets the original action go ahead unchanged. **Cancel** blocks it. The prompt stays in the box, and the user can pick the file again.
- Clean prompts and files go through with **no extra step**.
- It **recolours every AI response** on both sites (purple by default, and you can switch it off).

It is a standalone Electron app. **It does not use a browser extension, plugin or add-on.** The app starts Chrome (or Edge) itself, with its own profile, and controls it from outside through the Chrome DevTools Protocol.

**Demo video (Loom, no sign-in): https://www.loom.com/share/8ab1967ceadd40bdb5322842c6b40ae7**

---

## Contents

- [Quick start](#quick-start)
- [How to use it](#how-to-use-it)
- [Architecture](#architecture)
- [How interception and enforcement work](#how-interception-and-enforcement-work)
- [Content inspection](#content-inspection)
- [Response recolouring](#response-recolouring)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Configuration](#configuration)
- [Limitations, trade-offs and security notes](#limitations-trade-offs-and-security-notes)
- [Demo](#demo)

---

## Quick start

Requirements: Windows 10/11 (also runs on macOS and Linux), **Node.js 20+**, and Google Chrome or Microsoft Edge installed.

```bash
git clone https://github.com/nileshvishwakarma51/walled-dlp-desktop.git
cd walled-dlp-desktop
npm install
npm start
```

A prebuilt Windows build is attached to the [GitHub release](https://github.com/nileshvishwakarma51/walled-dlp-desktop/releases/latest). Unzip it and run `Walled DLP Guard.exe`. To build it yourself, run `npm run package`, which writes the build to `dist/`.

## How to use it

1. Start the app. A small **Walled DLP Guard** control window opens. A protected Chrome window opens next to it with ChatGPT and Perplexity in two tabs.
2. Use ChatGPT and Perplexity in that browser window as normal. You can sign in or stay signed out. The browser profile is kept, so logins survive restarts.
3. Type a prompt that contains `WALLED_SENSITIVE` and press Enter or click Send. The native dialog appears.
4. Attach a `.txt`, PDF or image that contains `WALLED_SENSITIVE`, using the file picker, drag and drop, or paste. The native dialog appears before the site receives the file.
5. The control window lists every decision (continue, cancel, clean). It can open the log file, reopen either site, and switch response recolouring on or off.

There are sample files in [`samples/`](samples): `sensitive-notes.txt`, `sensitive-report.pdf`, `sensitive-screenshot.png`, and clean versions of each.

## Architecture

```
┌──────────────────────────── Walled DLP Guard (Electron, main process) ────────────────────────────┐
│                                                                                                    │
│  main.js ── control window (status, activity log, recolour toggle)                                 │
│     │                                                                                              │
│     ├── confirm()  ──► dialog.showMessageBox  ──►  native OS dialog [Continue] [Cancel]            │
│     │                                                                                              │
│     └── Guard (src/core/guard.js) ──────────── enforcement engine, UI-agnostic                     │
│            │  attaches to every tab, injects the page agent, answers it, network backstop          │
│            ├── detector.js   marker matching (exact for text/PDF, OCR-tolerant for images)         │
│            ├── inspector.js / extract.js   text | PDF (pdf.js) | image (tesseract.js OCR)          │
│            └── sites.js      per-site selectors, response CSS, network patterns                    │
│                       │                                                                            │
└───────────────────────┼────────────────────────────────────────────────────────────────────────────┘
                        │ Chrome DevTools Protocol over a private pipe (--remote-debugging-pipe)
┌───────────────────────▼──────────── Chrome / Edge (dedicated profile) ─────────────────────────────┐
│  chatgpt.com tab                          perplexity.ai tab                                        │
│   page agent (src/inject/pageAgent.js)     page agent                                              │
│   - holds back Enter / Send / submit       - holds back file picker / drop / paste                 │
│   - replays the action on Continue         - recolours responses (constructed stylesheet)          │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Why this design:

- **It is a desktop app, and the user still works in a real browser.** The spec asks for monitoring of the web apps "accessed through a web browser", and says a browser extension does not count. So the app runs a real Chrome or Edge (the user's own install, with full site compatibility) and controls it from outside. Nothing is installed into the browser.
- **The CDP pipe instead of a TCP debugging port.** With `--remote-debugging-pipe`, only the app's own process can drive the browser. No other local program can attach to a port.
- **The engine does not depend on the UI.** `Guard` takes the confirmation function as a parameter. The Electron app passes a native dialog, and the end-to-end test passes a scripted stub. That is how the whole enforcement path is tested in a real browser.
- **One detector everywhere.** `createDetector` has no dependencies, so its source is injected into the page as-is. The page and the desktop app make exactly the same decision.

## How interception and enforcement work

The Guard attaches to every page target (`Target.setDiscoverTargets` + `attachToTarget`, flat sessions). For each one it:

1. adds a CDP **binding** (`Runtime.addBinding`) with a random name. This is the page-to-app channel, and the page agent removes it from `window` once it has a reference.
2. registers the **page agent** with `Page.addScriptToEvaluateOnNewDocument` (`runImmediately: true`), so it runs **before the site's own scripts** on every navigation.
3. turns on `Fetch` interception for the sites' prompt endpoints only. This is the network backstop.

New tabs are opened as `about:blank`, attached, and only then navigated, so even the first document is covered. A tab that started on a browser page (new-tab page) is picked up through `targetInfoChanged`. If a site page somehow loaded without the agent, it is reloaded.

### Text prompts

The page agent listens in the **capture phase on `window`**, so it runs before the site's React and ProseMirror/Lexical handlers. It listens for:

- `keydown` Enter (not Shift+Enter, not during IME composition) inside the prompt editor
- `click`, `pointerdown` and `mousedown` on the site's Send button
- `submit` of the composer form

If the editor text **does not** contain the marker, the agent does nothing and the event reaches the site untouched. If it **does**, the agent calls `preventDefault()` and `stopImmediatePropagation()`, so the site never sees the event, and asks the desktop app over the binding. While the decision is pending, further send attempts are held back too.

- **Cancel**: nothing is sent. The text stays in the editor and focus goes back to it, so the user can edit and send again.
- **Continue**: the agent opens a short allow window and **replays** the action by clicking the site's own Send button. If it cannot find one, it asks the app to type a trusted Enter through `Input.dispatchKeyEvent`. The site then sends the original, unmodified prompt itself.

**Network backstop.** A request to a site's prompt endpoint (`*/conversation*` on ChatGPT, `/rest/sse/*` on Perplexity) is paused with `Fetch.requestPaused` if its body contains the marker and the user has not just approved it in the page. That covers UI paths the agent does not know, such as a site redesign or a new button. The user gets the same native dialog. **Cancel** fails the request (`BlockedByClient`). **Continue** releases it unchanged.

### File uploads

All the ways a file can reach the page are intercepted before the site can read it:

| Path | How |
|---|---|
| `<input type=file>` (the site's upload button) | `input` and `change` events, capture phase on `window` |
| inputs never attached to the DOM | `HTMLInputElement.prototype.click/showPicker` is wrapped so a listener goes straight onto that input |
| drag and drop | `drop` event, capture phase |
| paste (a file copied in Explorer, or a screenshot) | `paste` event with `clipboardData.files` |
| File System Access API | `window.showOpenFilePicker` is wrapped |

The agent reads the files (up to 25 MB each), sends the bytes to the desktop app, and the app inspects them. The result:

- **No file contains the marker**: the original event is re-dispatched with the same `File` objects and the site carries on. No dialog.
- **Marker found**: native dialog with the file names, type and size, and the source (file picker, drag and drop, paste).
  - **Continue**: the event is re-dispatched with the original files, so the upload goes ahead unchanged.
  - **Cancel**: the flagged files are dropped. In a mixed selection the clean files still go through. If every file is blocked, the input is cleared so the same file can be chosen again.

Re-dispatched events are kept in a `WeakSet`, so the agent never intercepts its own replay.

## Content inspection

| Type | How | Notes |
|---|---|---|
| Text (`.txt`, `.md`, `.csv`, `.json`, code...) | UTF-8 / UTF-16 decode | type taken from magic bytes first, then MIME type, then extension |
| PDF | `pdfjs-dist` text layer of every page, plus metadata | works with compressed streams. A broken PDF falls back to a raw byte scan |
| Images (PNG, JPEG, GIF, BMP, WebP, TIFF) | `tesseract.js` OCR, with the English model bundled (no network download) | one shared worker, so only one OCR job runs at a time |
| Anything else | raw byte scan | |

Matching (`src/core/detector.js`):

- Prompts, text and PDF: exact, case-insensitive substring after Unicode NFKC normalisation, with zero-width characters removed. This catches `WALLED​_SENSITIVE` and full-width forms.
- OCR text: more tolerant, because OCR output is noisy. It ignores separators (`WALLED SENSITIVE`, `WALLED-SENSITIVE`), maps look-alike characters (`0→O`, `1→I`, `5→S`, ...), and allows up to 2 character edits. The tests check that unrelated text such as "Walled garden, sensitive plants" is **not** flagged.

## Response recolouring

Each site's response container is recoloured with `color: <colour> !important` on the container and all of its children.

- **ChatGPT**: `[data-message-author-role="assistant"] .markdown` (signed in) and `li[data-message-role="assistant"] [data-assistant-markdown]` (signed out)
- **Perplexity**: `.prose` (answer blocks; the user's own bubbles are not `.prose`)

The CSS is applied as a **constructed stylesheet** (`document.adoptedStyleSheets`). This is not blocked by the sites' Content-Security-Policy, so the app does not need to weaken CSP (`Page.setBypassCSP` is **not** used). The agent re-adds the sheet if the site ever replaces `adoptedStyleSheets`. The control window's checkbox switches it on and off live.

## Tests

```bash
npm test          # unit: detector + text/PDF/image extraction (incl. real OCR)
npm run test:e2e  # end to end in headless Chrome/Edge
npm run test:all  # both
```

The **end-to-end test** (`test/e2e.test.js`) starts a real headless Chrome through the same `launchBrowser` + `Guard` code the app uses. It loads a local fake chat page (`test/fixtures/chat.html`) and replaces the native dialog with a scripted stub. It checks that:

- a clean prompt is sent with no dialog
- a marker prompt with **Cancel** is not sent, does not reach the server, and stays editable
- a retry with the Send button and **Continue** sends the **unmodified** prompt to the server
- `.txt`, PDF and PNG uploads are each blocked on **Cancel** and delivered on **Continue** (files set through `DOM.setFileInputFiles`, a trusted file-input change)
- clean files pass without a dialog, and Cancel on a mixed selection keeps the clean file
- drag and drop is gated
- the **network backstop** blocks a marker request sent with `fetch()` directly, outside the composer
- responses are recoloured, and the toggle turns that off

Latest run: 23/23 passing (12 unit, 11 end-to-end).

Manual check against the live sites: see the demo video. It covers ChatGPT and Perplexity: prompts (Cancel and Continue), image, text and PDF files, clean prompts and files, and recoloured responses.

## Project layout

```
src/
  main/main.js          Electron entry: control window, native dialog, wiring
  main/preload.js       contextBridge API for the control window
  main/ui/              control window (HTML/JS, no remote content)
  core/browser.js       find + launch Chrome/Edge with a CDP pipe and a dedicated profile
  core/cdp.js           minimal CDP client over the pipe
  core/guard.js         enforcement engine (attach, inject, decide, network backstop)
  core/detector.js      marker matching (shared with the page)
  core/extract.js       text / PDF / OCR extraction
  core/inspector.js     file verdicts
  core/sites.js         everything site-specific (selectors, CSS, endpoints)
  inject/pageAgent.js   script injected into ChatGPT / Perplexity
samples/                demo files (+ scripts/make-samples.js to regenerate)
test/                   unit + end-to-end tests
```

## Configuration

Set these as environment variables before starting the app:

| Variable | Default | Meaning |
|---|---|---|
| `WALLED_MARKER` | `WALLED_SENSITIVE` | marker to look for |
| `WALLED_RESPONSE_COLOR` | `#7c3aed` | colour for AI responses |
| `WALLED_BROWSER` | auto (Chrome, then Edge, Chromium, Brave) | path to the browser executable |
| `WALLED_DEBUG_PORT` | off | **development only**: also open a TCP debugging port (used to script the demo) |

When the UI of either site changes, the selectors to update are all in `src/core/sites.js`.

## Limitations, trade-offs and security notes

- **Only the protected browser window is covered.** The app guards the Chrome/Edge window it starts. If someone opens ChatGPT in another browser, or another Chrome profile, the app does not see it. A company deployment would pair this with a policy that sends these sites to the protected browser, or would use an OS-level proxy. A proxy also sees all traffic, but it needs a trusted root certificate and it breaks with certificate pinning, which is why I did not choose it here.
- **Detection runs in the page first.** It is a cooperative layer. Deliberately hostile page code could get around it, but the sites are not the adversary here: the user's mistake is. The network backstop is a second layer for prompts. File bytes are inspected in the desktop app, not in the page.
- **Prompt detection is synchronous in the page, so clean prompts get zero added delay.** File inspection is asynchronous. A text file or PDF takes milliseconds. OCR of an image takes about 0.5 to 2 s on first use (the worker starts), and less after that.
- **OCR is never 100% reliable.** Very small, rotated, handwritten or low-contrast text can be missed. The tolerant matching reduces misses but cannot remove them. Scanned PDFs (image-only, no text layer) are not OCR'd. Only the text layer and a raw byte scan are checked.
- **Formats.** Office files (`.docx`, `.xlsx`, `.pptx`) are ZIP containers and are only raw-scanned, so a marker inside them is usually missed. They are out of scope for this assignment. Files over 25 MB are inspected only in their first 25 MB, and the dialog says so.
- **Failure handling.** If the app stops answering, a pending prompt is cancelled after 10 minutes (the safe default). Errors while extracting text from a file are logged, and the file is still checked with a raw byte scan.
- **Site changes.** The selectors are kept in one place (`sites.js`), and the network backstop still catches marker prompts if a new Send path appears.
- **The browser profile** is stored in the app's user-data folder. It holds the user's ChatGPT and Perplexity logins, like any browser profile would.
- **Privacy.** All inspection is local. No content leaves the machine. The activity log records the file name and the first 80 characters of a flagged prompt. A production version would make that configurable.
- **The demo was recorded signed out** on both sites. Signed out, Perplexity asks you to sign in before it accepts any upload, and ChatGPT accepts images only. In the video the app's inspection and dialog come **before** those site rules. After Continue the file is handed to the site, which then applies its own sign-in rule. Signed in, the same code path simply ends in a completed upload. The end-to-end test confirms that Continue delivers the original files.

## Demo

- **Loom (1:45, public, no sign-in): https://www.loom.com/share/8ab1967ceadd40bdb5322842c6b40ae7**
- Mirror (MP4): [`docs/walled-dlp-demo.mp4`](docs/walled-dlp-demo.mp4), also attached to the [v1.0.0 release](https://github.com/nileshvishwakarma51/walled-dlp-desktop/releases/tag/v1.0.0)

What the video shows, in order:
1. ChatGPT: a normal prompt is sent with no dialog, and the response is recoloured.
2. ChatGPT: a `WALLED_SENSITIVE` prompt opens the native dialog. Cancel blocks it, then Continue sends it.
3. ChatGPT: an image picked in the OS file picker is caught by OCR, and Continue attaches it.
4. Perplexity: a pasted text file, a PDF and an image each open the dialog, and Cancel blocks each one.
5. Perplexity: a marker prompt is sent with Continue, and the answer is recoloured.

## License

MIT
