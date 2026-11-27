# Math Tutor

A web app for the iPad that turns Claude into a Socratic tutor. It's built on
Jane Street's [socratic-tutor skill](https://github.com/janestreet/agent_skills/blob/master/socratic-tutor/SKILL.md).

- **Math rendering**: KaTeX for `$…$` and `$$…$$`.
- **Figures from Claude**: accurate function and geometry plots (a JSON `plot` block rendered by the app) and free-form SVG diagrams.
- **Apple Pencil whiteboard**: pressure-sensitive ink, an eraser, and undo. The board is cropped and sent to Claude as an image.
- **Annotate Claude's figures**: tap "✎ To board" on any figure, draw on it, then tap "Send board".
- **Voice input**: with an optional OpenAI API key in Settings, the mic button records you and transcribes the audio with OpenAI's `gpt-transcribe` (about $0.0045/min). The tutor's last message and the skill-map terms are sent as context, so math vocabulary is recognized. A preview of the text appears while you speak (each preview re-transcribes the clip so far, which raises the cost to roughly 2–10× the base rate depending on clip length); tapping Send while recording transcribes and sends in one go. Without the key, the button falls back to the browser's built-in dictation. You can also type, use the iPad keyboard's mic key, or write in the text box with the Pencil (Scribble).
- **Progress**: the tutor's skill map is rendered as bars and kept in a Progress panel.
- **Sessions**: saved on the device in IndexedDB, together with each session's board. You can export and import them as JSON.
- Shows an estimate of each session's API cost.

There's no backend. The page calls the Anthropic API directly from the iPad with your API key, which is stored only in that browser's local storage.

## Use it on the iPad

1. Open the GitHub Pages URL in Safari, tap **Share → Add to Home Screen**, and launch the app from the icon. This gives you full screen, and Safari won't evict the app's storage.
2. In **Settings**, paste an API key from <https://console.anthropic.com> (set a monthly spend limit there). Enter `demo` instead to try the interface offline with canned replies.
3. Start a **Tutor session** and name a topic, e.g. "Teach me eigenvalues".

Tips:
- Once the app has seen the Pencil, fingers stop drawing (palm rejection). The ✋ button toggles this.
- With unsent ink on the board, the 📎 **Board** chip next to the text box turns on and the board goes with your next message. Tap the chip to toggle it.
- The layout switch at the top (Chat / Both / Board) and the drag handle between the panes adjust the split. Portrait mode stacks the chat above the board.
- In Settings you can switch the model (Opus 5.5 is the default; Sonnet 5.5 is cheaper) and the thinking effort.

## Development

```sh
npm install
npm run dev        # http://localhost:5173, also on your LAN (--host)
npm run build      # type-check and build to dist/
```

`npm run dev` serves on the LAN, so you can open `http://<computer-ip>:5173` on the iPad while developing. The mic button needs HTTPS, but keyboard dictation works anyway.

## Deploy to GitHub Pages

1. Create an empty repository on GitHub, e.g. `math-tutor`. Public repos get Pages for free; private repos need a paid plan.
2. Push this folder:
   ```sh
   git remote add origin git@github.com:<you>/math-tutor.git
   git push -u origin main
   ```
3. In the repository, go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
   The workflow in `.github/workflows/deploy.yml` builds and deploys on every push to `main`.
   The app is then live at `https://<you>.github.io/math-tutor/`.

The deployed page contains no secrets. Your key lives only on your iPad.

## Files

| File | What it does |
| --- | --- |
| `src/prompt.ts` | System prompt: interface instructions (math, figure formats, skill map) plus the tutor skill |
| `src/socratic-tutor.md` | The unmodified Jane Street skill (MIT, see `THIRD_PARTY_NOTICES.txt`) |
| `src/claude.ts` | Streaming Messages API call, model list and prices, demo mode |
| `src/transcribe.ts` | Microphone recording and OpenAI transcription with conversation context |
| `src/board.ts` | Whiteboard: Pencil input, stroke eraser, undo/redo, export to PNG |
| `src/plot.ts` | Safe expression parser and the `plot` block → SVG renderer |
| `src/markdown.ts` | Markdown + KaTeX + figure and skill-map blocks, sanitized with DOMPurify |
| `src/main.ts` | UI wiring: chat, sessions, settings, layout |
| `src/store.ts` | IndexedDB sessions and boards, settings |
