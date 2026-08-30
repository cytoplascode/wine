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

## Requirements

- **Chrome for Android 132+** — that is the version that shipped `showDirectoryPicker()` on
  Android, which is how the app writes into your vault.
- Served over HTTPS. The camera and the directory picker both need a secure context.

On browsers without the File System Access API (Firefox Android, iOS Safari) everything up
to and including OCR still works, and saving falls back to downloading the files.

## Using it

1. Open the site and add it to your home screen.
2. **Connect vault** — pick your vault folder, or a subfolder of it. The choice is remembered.
3. **New bottle** → photograph the label or pick one from the gallery.
4. Drag the four corners onto the label, then **Read label**.
5. Correct anything OCR got wrong, optionally add a food photo, then **Save to vault**.

Android may ask you to re-confirm folder access after a restart; the home screen shows a
**Reconnect vault** button when that happens. Choosing "Allow on every visit" in Chrome's
permission prompt avoids the question.

## Development

No build step and no runtime dependencies — it is plain ES modules served as files.

```sh
npm test          # unit tests for the perspective warp, parser and note writer
npm run serve     # http://localhost:8000
```

Camera capture and the directory picker need a secure context, so `localhost` works but a
LAN IP does not.

### Regenerating the icons

`icons/*.png` are rendered from `icons/icon.svg` and `icons/icon-maskable.svg`. Edit the SVGs
and re-render them with any tool that rasterises SVG at 192×192 and 512×512.

## Deployment

Pushing to `main` runs the tests and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. Set **Settings → Pages → Source** to **GitHub Actions** once,
or the deploy step has nothing to publish to.
