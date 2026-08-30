# Label Scanner

A phone-only PWA that turns a photo of a wine label into a note in your Obsidian vault —
entirely on the device, with no network calls at all once installed.

Photograph the label (or pick a photo from your gallery), drag the four corners onto the
label edges, and the app flattens the perspective, reads the text with Tesseract running
locally, guesses the fields, and lets you correct them before writing the note and its
images straight into a folder you choose.

## The note it writes

Output matches the `fileClass: Wine` template used in the vault this was built for — same
keys, same order, same spelling (`Appelation`), same defaults:

```markdown
---
fileClass: Wine
Name: "Domaine Ponsot - Clos de la Roche - 2018"
Winemaker: "Domaine Ponsot"
WineName: "Clos de la Roche"
Vintage: "2018"
Type: "Red"
Varieties: "Pinot Noir"
Country: "France"
Region: "Bourgogne"
Appelation: "Clos de la Roche Grand Cru"
Vineyard:
Style:
Price:
PurchaseSource:
PurchaseLink:
PurchaseCountry:
Stars: --
ValueForMoney:
Points:
Inventory: 0
Buy: 0
Buy date:
Drink date:
---

## Tasting note

## Label
Label:: ![[Domaine Ponsot - Clos de la Roche - 2018.jpg]]

## Food
Food:: ![[Domaine Ponsot - Clos de la Roche - 2018 - food.jpg]]
```

Files land in a `wines/` folder inside the directory you connect:

```
wines/Domaine Ponsot - Clos de la Roche - 2018.md
wines/Domaine Ponsot - Clos de la Roche - 2018.jpg
wines/Domaine Ponsot - Clos de la Roche - 2018 - food.jpg   (optional)
```

The raw OCR text is kept at the end of each note inside an Obsidian `%% … %%` comment, so a
wrong guess is always recoverable. It is invisible in reading view and in Bases.

Filenames keep their accents — a vault full of `Château` should read properly. If the target
file system refuses non-ASCII names, the app notices and folds just the filename down to
`Chateau …`; the frontmatter keeps the real spelling either way. A name that already exists
gets Obsidian's own ` 2`, ` 3` suffix rather than overwriting anything.

## Requirements

- **Chrome for Android 132+** — that is the version that shipped `showDirectoryPicker()` on
  Android, which is how the app writes into your vault.
- Served over HTTPS. The camera and the directory picker both need a secure context.

On browsers without the File System Access API (Firefox Android, iOS Safari) everything up
to and including OCR still works, and saving falls back to downloading the files.

## Using it

1. Open the site and add it to your home screen.
2. **Download for offline use** once, on the home screen — about 6 MB of recognition engine.
   After that nothing needs the network again.
3. **Connect vault** — pick your vault folder, or a subfolder of it. The choice is remembered.
4. **New bottle** → photograph the label, or tap **Gallery** to use a picture you already took.
5. Drag the four corners onto the label, then **Read label**.
6. Correct anything OCR got wrong, fill in price or rating if you like, optionally add a food
   photo, then **Save to vault**.

Fields the app guessed are marked **AUTO**; editing one clears the mark. One bottle per pass —
there is no batch import.

Android may ask you to re-confirm folder access after a restart; the home screen shows a
**Reconnect vault** button when that happens. Choosing "Allow on every visit" in Chrome's
permission prompt avoids the question.

## Development

No build step and no runtime dependencies — it is plain ES modules served as files.

```sh
npm test          # perspective warp, parser, note writer, vault states
npm run serve     # http://localhost:8000
```

Camera capture and the directory picker need a secure context, so `localhost` works but a
LAN IP does not.

The pure modules — `warp.js`, `parse.js`, `note.js`, and the vault state machine — carry the
tests. `note.test.js` asserts a generated note against the vault template byte for byte,
which is what stops the frontmatter drifting.

`showDirectoryPicker()` cannot be driven by an automated browser, so the vault write path is
best checked by hand against a throwaway folder before pointing it at a real vault.

### Regenerating the icons

`icons/*.png` are rendered from `icons/icon.svg` and `icons/icon-maskable.svg`. Edit the SVGs
and re-render them with any tool that rasterises SVG at 192×192 and 512×512.

## Deployment

Pushing to `main` runs the tests and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. The workflow enables Pages and sets its source to GitHub
Actions itself, so there is nothing to configure by hand.

The site is served from a subdirectory (`/wine/`), which is why every path in the app is
relative and the service worker is registered as `./sw.js`.
