---
title: What is an HWPX file, and how do you open one?
description: HWPX is the newer, XML-based format of Hangul, the Korean word processor. How it differs from HWP, why some programs cannot open it, and how to open one without installing anything.
order: 3
---

An `.hwpx` file is a document from **Hangul** (한글), the word processor used across Korean schools, government and business.
It is the newer of Hangul's two formats; the older one is `.hwp`.

## HWP vs HWPX

| | HWP | HWPX |
|---|---|---|
| Inside | Hancom's own binary format | XML documents in a zip archive |
| History | The long-standing default | The later, open format |
| Read by other software | Hard — needs a decoder for the binary format | Easier — it is XML |

HWPX stores the document as open XML, which is why Korean public bodies have been moving to it.
The content and look are the same as HWP, but the file inside is completely different —
so **older Hangul versions and viewers that only know HWP cannot open HWPX.**

## If an HWPX file will not open

- **You have an old version of Hangul** — updating it fixes this.
- **You have no Hangul at all** (Mac, phone, a work PC you cannot install on) — open it in the browser.

The [HWP viewer & editor](../en) opens both HWP and HWPX. It looks inside the file rather than at the extension, so it works even if the file is misnamed.

1. Drop the file in or click to choose it. It tells you what it found — "This is a Hangul (HWPX) document".
2. Fill in the fields.
3. Click **Save as HWPX**. It is saved in the same format.

## What does not work yet

For HWPX files the tool currently fills in **text only**. Photos, signatures and font-size changes work in HWP files.
It also does not convert: HWPX stays HWPX and HWP stays HWP. There is no HWPX-to-HWP, Word or PDF conversion.

## Common questions

- **Can I just rename .hwpx to .hwp?** No. The extension is only a label; the inside is still HWPX, and a program that cannot read HWPX still cannot read it.
- **The recipient wants HWP.** The reliable way is to open it in Hangul and use Save As → HWP. Without Hangul, ask whether HWPX is acceptable.

On a phone, see [open an HWP file on iPhone or Android](mobile); on a Mac, [open an HWP file on a Mac](mac). HWPX works the same way.
