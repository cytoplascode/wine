# Label Scanner

A phone-only PWA that turns a photo of a wine label into a note in your Obsidian vault —
entirely on the device, with no network calls at all once installed.

Photograph the label (or pick a photo from your gallery), drag the handles onto its edges, and
the app unwraps the label off the curve of the bottle, reads the text with Tesseract running
locally, guesses the fields, and lets you correct them before writing the note and its images
straight into a folder you choose.

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
2. **Download for offline use** once, on the home screen — the recognition engine plus the
   language packs you picked, around 8 MB for the default English and French. After that
   nothing needs the network again.
3. **Connect vault** — pick your vault folder, or a subfolder of it. The choice is remembered.
4. **New bottle** → photograph the label, or tap **Gallery** to use a picture you already took.
5. Drag the handles onto the label, then **Read label**.
6. Correct anything OCR got wrong, fill in price or rating if you like, optionally add a food
   photo, then **Save to vault**.

### Curved or flat

A label is wrapped round a bottle, so correcting perspective is not enough — the surface
itself is curved, which compresses text towards the edges and bows every line. **Curved**
(the default) uses six handles: put the four corners on the label's corners and the two
middle handles on the bows of its top and bottom edges, and the label is unrolled off the
cylinder. **Flat** is a plain four-corner correction, for back labels, flat-sided bottles, or
a photograph of a label that is not on a bottle.

Neither is right for everything. Measured against modelled bottle photographs, comparing the
result to the original flat label:

| Label wraps | Curved | Flat |
|---|---|---|
| ~103° — a small label, or a distant shot | 0.80 | **0.85** |
| ~137° — typical | **0.94** | 0.64 |
| ~166° — a wide label | **0.97** | 0.42 |

Curved assumes the label spans the full visible half of the bottle, so it over-corrects a
small label on a fat bottle. If a scan comes out worse than you expected, try the other mode.

Fields the app guessed are marked **AUTO**; editing one clears the mark. One bottle per pass —
there is no batch import.

### Languages

The home screen has chips for English, French, Italian, Spanish, Portuguese, German and
Georgian. All seven packs are in the repository, but only the ones you pick are downloaded for
offline use, so the first download stays proportionate. Three at a time is the cap: each extra
language slows recognition down.

### When a scan disappoints

Open **Raw recognised text** on the review screen. Every line is listed with the confidence
recognition gave it, which distinguishes the three things that go wrong: text that was never
found at all (nothing in the list), text found but misread (low confidence), and text read
correctly but filed under the wrong field (high confidence, wrong box). The first two are
usually fixed by re-cropping — check the handles are on the label's real edges and try the
other crop mode.

Android may ask you to re-confirm folder access after a restart; the home screen shows a
**Reconnect vault** button when that happens. Choosing "Allow on every visit" in Chrome's
permission prompt avoids the question.

## Development

No build step and no runtime dependencies — it is plain ES modules served as files.

```sh
npm test          # warp and unwrap, parser, note writer, vault states, languages
npm run serve     # http://localhost:8000
```

Camera capture and the directory picker need a secure context, so `localhost` works but a
LAN IP does not.

The pure modules — `warp.js`, `parse.js`, `note.js`, `languages.js` and the vault state
machine — carry the tests. `note.test.js` asserts a generated note against the vault template
byte for byte, which is what stops the frontmatter drifting; `cylinder.test.js` photographs a
test image onto a modelled bottle using real pinhole geometry, then checks the unwrap gets it
back — deliberately different maths from the one the unwrap uses, so it measures the
approximation rather than restating it.

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
