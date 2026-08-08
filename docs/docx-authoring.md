# Authoring `.docx` files for Structured Word Documents mode

This is for whoever is *writing or preparing* the Word documents that get turned into a
crate — not for developers of this tool (see [ARCHITECTURE.md §7.1](../ARCHITECTURE.md) for
that). It describes the conventions the parser looks for. Nothing here is configurable per
profile or per template — the same rules apply regardless of which MASP profile or preview
template you're using, because parsing happens before either is involved.

## Folder layout

```
<Collection name>/
  Some Document.docx
  media/
    photo.jpg
    clip.mp3
  <Subfolder>/
    Another Document.docx
    media/
      other-photo.jpg
```

- Each top-level folder under the one you pick in the app becomes a **Collection**.
- `.docx` files can sit directly in a collection folder or in subfolders any number of
  levels deep — each one becomes its own document part.
- A `media/` folder holds files that documents *refer to by name* (see below). It's looked
  for next to each `.docx` file — a nested subfolder needs its own `media/` if its documents
  reference local files, it doesn't inherit the parent's.
- Files whose name contains "note" or "notes" (e.g. `Field Notes.docx`) are skipped
  entirely — use that for working files you don't want turned into content.
- Temporary Word lock files (`~$....docx`) and dotfiles are ignored automatically.

## Headings define structure

Use Word's built-in **Heading 1 / Heading 2 / Heading 3** styles — not bold text or manual
font sizes, which the parser doesn't see as headings.

- **Heading 1** is the document's own title/intro. Its text becomes the document part's
  name and its opening content — it does not become a chapter in its own right.
- **Heading 2** and **Heading 3** each start a new chapter. A Heading 3 nests *inside* the
  chapter above it only when that Heading 3 is immediately followed by a table (see below);
  otherwise Heading 2 and 3 chapters are siblings in reading order.
- A document with no Heading 1/2/3 at all produces no chapters — you'll see a warning
  during build, and the file's content won't appear in the crate. Plain paragraph styles or
  manually-sized text don't count.

## Adding images

Two ways to add a photo, and you can mix both across a document:

**1. Reference by filename.** Type the image's filename on its own line — it doesn't need
to be a link, just plain text containing something like `photo.jpg`, `IMG_0231.PNG`, etc.
(recognised extensions: jpg/jpeg/png/gif/tif/tiff/webp/bmp/mov/mp4). The parser looks for a
matching file in the nearest `media/` folder, matching case-insensitively and matching with
or without the extension — so `Garden.JPG` in the text finds `media/garden.jpg`. Anything
on the same line *after* the filename is kept as an inline caption.

**2. Paste/insert the image directly.** Insert the picture into the document itself
(Insert → Pictures). It's extracted automatically — no filename needed, no `media/` folder
entry required.

If you reference a filename immediately followed by a pasted image right after it, treat
that as a labelled inline image, not two separate photos — the parser folds the filename
line's caption text into the pasted image rather than creating a duplicate entry.

A referenced filename that has no match in `media/` degrades gracefully: it's kept as a
text label but doesn't become a linked image.

## Captions and photo credits

Immediately after an image (either kind), plain text lines are treated as caption content.
Two optional prefixes split that text:

```
Caption: A magpie in the garden
Photo: J. Smith, 2019
```

- A line starting with `Caption:` (case-insensitive) becomes the caption.
- A line starting with `Photo:` becomes the photo credit.
- Text with neither prefix is treated as caption content by default, unless it comes after
  a `Photo:` line, in which case it's treated as a continuation of the credit.
- Multiple `Caption:`/`Photo:` lines are joined together.

## Adding audio

On its own line, write:

```
SOUND FILE: interview-clip.mp3
```

Same matching rules as image filenames — case-insensitive, looked up in the nearest
`media/` folder, matched with or without extension.

## Tables

Only a table matters to the parser if it is the **very first thing** immediately under a
Heading 2 or Heading 3 — nothing else (not even a blank paragraph) in between. A table
appearing anywhere else in a chapter is ignored.

In a qualifying table, each row's first cell becomes one structured row of content. A cell
can itself contain an image reference, a pasted image, `SOUND FILE:` line, and
`Caption:`/`Photo:` lines, following all the same rules as body text above.

## What to check before handing off a document

- Chapter breaks use Heading 1/2/3 styles, not manual formatting.
- Every filename you type for an image or sound file has a matching file in that
  document's `media/` folder (name matching is case-insensitive and extension-optional, but
  the base name must match).
- Only the table meant to become structured data sits directly under its Heading 2/3 —
  move any other tables so they're not the first thing after a heading, or they'll be
  silently dropped.
- Working/draft files are named with "notes" somewhere in the filename so they're excluded
  from the build.
