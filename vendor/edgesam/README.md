# EdgeSAM (3x)

`edge_sam_3x_encoder.onnx` (22 MB) and `edge_sam_3x_decoder.onnx` (16 MB),
the ONNX export published with the EdgeSAM demo
(<https://huggingface.co/spaces/chongzhou/EdgeSAM/tree/main/weights>).

EdgeSAM is a distilled Segment Anything: given a photo and a box, it returns
the pixels of the thing inside the box. The crop screen's **Find** button
uses it to turn a rough handle placement into the label's outline.

## Interface

Fixed by EdgeSAM's own `scripts/export_onnx_model.py`:

| session | inputs | outputs |
| --- | --- | --- |
| encoder | `image` `[1,3,1024,1024]` f32 | `image_embeddings` `[1,256,64,64]` |
| decoder | `image_embeddings`, `point_coords` `[1,N,2]` f32, `point_labels` `[1,N]` f32 | `scores` `[1,4]`, `masks` `[1,4,256,256]` |

Coordinates go in in 1024-padded pixel space — the model does the `+0.5` and
the divide itself. Labels follow SAM: 1 foreground, 0 background, 2 box
top-left, 3 box bottom-right, −1 padding. The export used
`--use-stability-score`, so `scores` is a stability score and the best of the
four masks is its argmax. Mask values are logits; SAM's threshold is zero.

## Licence

**S-Lab License 1.0 — non-commercial use only** (`LICENSE.edgesam.txt`).
This is stricter than everything else the app vendors (PaddleOCR, ONNX
Runtime and Tesseract are all Apache-2.0 or similar), and it is why the
label finder is an optional download rather than part of the app: nothing
in Label Scanner needs it, and a build that must be commercially
redistributable can leave this folder out.
