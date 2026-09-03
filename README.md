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

### If your vault lives in Obsidian's own "App Storage"

Android's folder picker is the Storage Access Framework, and since Android 11 that picker
cannot browse into another app's private storage at all — not with any permission, because it
isn't a matter of permission. If your vault sits there instead of an ordinary shared folder,
**Connect vault** can never reach it, whatever you grant.

The vault card has a second mode for exactly this: **Use Obsidian's QuickAdd instead**. It
never touches the filesystem — it hands off to Obsidian over a plain `obsidian://quickadd`
link, and Obsidian writes with its own, already-unrestricted storage access.

Install the **QuickAdd** community plugin, then set up two choices exactly like this:

1. **The note.** New Choice → **Capture**. Name it whatever you like — this exact name goes
   into the app's "Note capture" field. Under its settings:
   - **Capture To** → **Format** → `{{value:filename}}` (a file, not a folder, and it will be
     a new file every time — turn on **Create file if it doesn't exist**).
   - **Capture Format** → `{{value:content}}` — and only that; nothing else in the format box.
   - Turn *off* anything that adds its own text — task checkbox, bullet point, a fixed
     template header — the content is already a complete note, frontmatter included.

   Both values are *named*, which is what makes this run silently. QuickAdd only fills a named
   value from a link; a plain unnamed `{{VALUE}}` always stops and asks, by design.

2. **The photo.** This one is a **Macro**, not a Capture — a Capture can only write text into
   a note, and it cannot pick an image up off the clipboard by itself. So the photo travels as
   a base64 data URI in the clipboard's *text*, which is the one thing Obsidian's Android
   WebView will read back, and a script decodes it and writes the real file.

   Put this in a note (mobile Obsidian cannot open `.js` files, but a `js` code block in a
   note works), say `scripts/Save clipboard image.md`:

   ````
   ```js
   module.exports = async (params) => {
     const { app, variables } = params;
     const path = variables.filename;
     if (!path) throw new Error("No filename passed in");

     const text = (await navigator.clipboard.readText()) || "";
     const m = /^data:image\/[a-z+]+;base64,([\s\S]+)$/.exec(text.trim());
     if (!m) throw new Error("No image data on the clipboard");

     const bin = atob(m[1]);
     const bytes = new Uint8Array(bin.length);
     for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

     const existing = app.vault.getAbstractFileByPath(path);
     if (existing) await app.vault.modifyBinary(existing, bytes.buffer);
     else await app.vault.createBinary(path, bytes.buffer);
   };
   ```
   ````

   Then: New Choice → **Macro**, name it whatever you like — this name goes into the app's
   "Photo capture" field — and give it a single **User Script** step pointing at that note.

Then, in the app, fill in your vault name and those two choice names — spelled exactly as you
named them, they're matched by exact string.

**Save to vault** writes the note straight into Obsidian, no prompt. The next screen offers a
button per photo; one tap puts that photo on the clipboard and opens Obsidian, and the macro
writes it — no pasting, and no prompt either. Because the script is handed the path, the files
are named exactly as the note's own `Label::` and `Food::` embeds expect, the same as the
folder backend writes them. A tap per photo rather than one for both: each needs its own turn
on the clipboard.

Two limits worth knowing. Android's clipboard is not sized for unbounded text — it shares the
roughly one-megabyte buffer everything crossing a process boundary uses — so a photo over
budget is re-encoded, quality first and then size, until it fits; the app says so when that
happens. And there is no way to check for an existing file over a one-way link, so unlike the
folder backend this cannot offer Obsidian's ` 2`, ` 3` suffix on a name collision.

## Using it

1. Open the site and add it to your home screen.
2. **Download for offline use** once, on the home screen — the recognition engine plus the
   language packs you picked, around 8 MB for the default English and French. After that
   nothing needs the network again.
3. **Connect vault** — pick your vault folder, or a subfolder of it. The choice is remembered.
4. **New bottle** → photograph the label, or tap **Gallery** to use a picture you already took.
5. Drag the handles onto the label, set **Curve** by the preview, then **Read label**.
6. Correct anything OCR got wrong, fill in price or rating if you like, optionally add a food
   photo, then **Save to vault**.

Tap either photo on the review screen to fill the screen with it, which is the quickest way
to check a value against the label; tap it again, or press back, to shrink it. The **Label**
and **Food** captions float over their own photos rather than taking a bar beneath them, with
a pencil in the Label one that takes you back to the crop screen with the handles exactly
where you left them — for when a value came out wrong and re-cropping, not retyping, is the
fix. **Save to vault** floats over the bottom of the screen the same way, so the form itself
keeps the space either would otherwise hold onto. The phone's back button steps back through
the flow throughout — review to crop, crop to the camera, camera to home — and only leaves
the app from the home screen.

### The curve slider

A label is wrapped round a bottle, so correcting perspective is not enough — the surface
itself is curved, which compresses text towards the edges and bows every line. So the crop
screen has six handles: the four corners go on the label's corners, and the two middle
handles on the bows of its top and bottom edges. The label is then unrolled off the cylinder.
Dragging any handle opens a magnified loupe under the **Flattened** tag — a fingertip covers
more label than a corner needs, so the loupe is where the actual placement gets judged, in a
fixed spot a thumb can never end up covering.

The one thing those handles cannot tell you is how far round the bottle the label goes. A
near bottle wrapping a little and a distant one wrapping a lot project to the same outline —
the centre-to-edge height ratio and the bulge of the top and bottom edges turn out to be the
same equation written twice, so there is one equation and two unknowns. The **Curve** slider
sets it instead, from 60° to 180°, starting at 140°, which is about typical for a front
label. A band above the photo shows the flattened result and re-renders on every move — of a
handle or of the slider — so you can judge the setting against the label in front of you
rather than guess it.

Getting it wrong stretches the result. Measured against modelled bottle photographs,
comparing the flattened output to the original flat label:

| Label wraps | Flat four-corner | Unwrapped at 180° | Unwrapped at the right angle |
|---|---|---|---|
| 100° | 0.86 | 0.74 | **0.99** |
| 120° | 0.75 | 0.81 | **0.98** |
| 140° | 0.63 | 0.93 | **0.95** |
| 160° | 0.46 | **0.99** | 0.92 |

Proportions follow the same pattern: at the right angle the label comes back at its true
aspect ratio, while assuming 180° — which is what earlier versions did — makes it up to a
third too wide. Sliding all the way down to 60° is close enough to a plain four-corner
correction for a back label or a flat-sided bottle, so there is no separate mode for that.

This fixes the geometry, not the recognition. On three real bottle photographs the correct
wrap changed the proportions exactly as the model predicts — one roughly square label came
back 1.44× wider than tall at 180° and 1.19× at 140° — but it did not improve how many fields
OCR recovered from them. Those particular photos are limited by thin decorative type and by
how accurately the handles were placed, not by the wrap.

Fields the app guessed are marked **AUTO**; editing one clears the mark. **Drink date** is one
of them — pre-filled from the label photo's own date (its EXIF timestamp for a gallery import,
today's date for a fresh camera shot), on the idea that a label is usually photographed at or
near the moment the bottle is opened. It sits with the main fields rather than behind Purchase,
Rating or Cellar: those stay collapsed unless whatever landed in them needs a look, but a fresh
guess is worth seeing every time. One bottle per pass — there is no batch import.

### Putting a value in the right field

The commonest failure is not a misread but a misfiling: the appellation is read perfectly and
lands in Region, or the cuvée ends up as the winemaker. Retyping both fields to fix that is
the most tedious thing the review screen asks for, so every filled field carries a **⠿**
grip. Hold it down — the same long press Android already uses for its own gestures, and the
grip fills in to match — then drag onto another field to swap the two values. A plain tap does
nothing, on purpose: the grip sits close enough to the AUTO chip and the field below it that an
instant drag turned an ordinary tap into an accidental swap.

A swap rather than a move, because it is symmetrical: nothing that was already in the target
is destroyed, and dragging back undoes it. Dragging over a collapsed group opens it, and the
form scrolls when you hold near its top or bottom edge, so the two fields need not be on
screen together. A field that cannot hold the value — a date, or a number given text — is
never offered as a target, since it would silently blank itself.

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
usually fixed by re-cropping — check the handles are on the label's real edges, and watch the
flattened preview while you move the Curve slider until the lines of text read straight. The
third is fixed by dragging the value into the right field.

Android may ask you to re-confirm folder access after a restart; the home screen shows a
**Reconnect vault** button when that happens. Choosing "Allow on every visit" in Chrome's
permission prompt avoids the question.

## Development

No build step and no runtime dependencies — it is plain ES modules served as files.

```sh
npm test          # warp and unwrap, parser, note writer, vault states, languages, routing, EXIF
npm run serve     # http://localhost:8000
```

Camera capture and the directory picker need a secure context, so `localhost` works but a
LAN IP does not.

The pure modules — `warp.js`, `parse.js`, `note.js`, `languages.js`, `nav.js`, `exif.js` and the
vault state machine — carry the tests. `nav.js` holds the screen stack behind the back button
and returns a plan rather than touching the History API, which is what makes its awkward cases
— returning to a screen already visited, a back press landing outside the stack — testable at
all. `exif.js` parses the JPEG/TIFF byte layout directly rather than going through
`file.arrayBuffer()`, so its tests build a real EXIF segment byte by byte instead of shipping a
binary fixture. `note.test.js` asserts a generated note against the vault template
byte for byte, which is what stops the frontmatter drifting; `cylinder.test.js` photographs a
test image onto a modelled bottle using real pinhole geometry, then checks the unwrap gets it
back — deliberately different maths from the one the unwrap uses, so it measures the
approximation rather than restating it.

`showDirectoryPicker()` cannot be driven by an automated browser, so the vault write path is
best checked by hand against a throwaway folder before pointing it at a real vault.

`quickadd.js`'s `noteUri`/`imageUri` build the `obsidian://quickadd` link from an explicit
connection object rather than the saved one, which is what lets `quickadd.test.js` check the
exact query string — the `%20` encoding, which values are named and which are not — under
`node --test` without touching `localStorage` (browser-only, same reason `vault.js`'s `pick()`
isn't unit tested either). Actually firing the link into a real Obsidian is, like the folder
picker, a by-hand check.

### Regenerating the icons

`icons/*.png` are rendered from `icons/icon.svg` and `icons/icon-maskable.svg`. Edit the SVGs
and re-render them with any tool that rasterises SVG at 192×192 and 512×512.

## Deployment

Pushing to `main` runs the tests and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. The workflow enables Pages and sets its source to GitHub
Actions itself, so there is nothing to configure by hand.

The site is served from a subdirectory (`/wine/`), which is why every path in the app is
relative and the service worker is registered as `./sw.js`.
