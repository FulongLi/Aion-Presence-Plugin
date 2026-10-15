# Aion Chinese Writing Pack 1.0.0

This directory is a separate, license-governed resource pack inside the Aion Presence plugin. **It is not covered by Aion
Presence's own license**; each file keeps the license of the data it comes from. Aion's code reads these files at run
time and never mixes them into its own sources (mere aggregation on one distribution medium).

| File | Contents | Source | License |
| --- | --- | --- | --- |
| `strokes.ahpk` | stroke outlines and medians of 9574 characters | hanzi-writer-data 2.0.1 (from Make Me a Hanzi graphics, derived from Arphic PL KaitiM GB and Arphic PL UKai) | Arphic Public License (`ARPHICPL.TXT`) |
| `dictionary.ahpk` | radical, decomposition, etymology, pinyin, definition | Make Me a Hanzi `dictionary.txt`, commit bddc96d41bef78427ed0e034e9f7e31d71fd1b92 (from Unihan and CJKlib) | LGPL-3.0-or-later (`LGPL-MakeMeAHanzi.txt`, `GPL-3.0.txt`, `COPYING-MakeMeAHanzi.txt`; the Unicode notice is at the top of the LGPL file) |
| `variants.json` | simplified ↔ traditional character tables | OpenCC ver.1.4.2 `STCharacters.txt`, `TSCharacters.txt` | Apache-2.0 (`LICENSE-OpenCC.txt`) |
| `coverage.json` | the machine-readable coverage report | generated | — |
| `manifest.json` | version, upstream pins, SHA-256 of every file | generated | — |

## Modifications (Arphic Public License §2a; LGPL; Unicode notice; Apache-2.0 §4b)

- **strokes.ahpk** — converted on 2026-10-14 from one JSON file per character to a block-compressed binary
  record format (format conversion only). Every record decodes back to its original JSON file, byte for byte;
  `npm run chinese:export -- <dir>` writes those files out again. Upstream files that fail validation are left out and
  listed in `coverage.json`. No glyph, stroke order or median was changed. The notice at the top of the file
  says the same.
- **dictionary.ahpk** — the lines of `dictionary.txt` for the pack's characters, stored verbatim in the same
  block-compressed container on 2026-10-14. No entry was changed.
- **variants.json** — the two OpenCC tables reduced on 2026-10-14 to entries whose key is a character of the
  pack; values unchanged.

## Getting the source

The modified files are available to everyone, under their licenses, in this public repository
(https://github.com/FulongLi/Aion-Presence-Plugin, directory `plugins/aion-presence/packs/chinese-writing`). The unmodified upstream data is at the
pinned addresses in `manifest.json` (each checked by SHA-256). `npm run chinese:build` rebuilds this directory from them;
`npm run chinese:export -- <dir>` recovers the original per-character JSON files.

## Attribution

- Hanzi Writer and hanzi-writer-data by David Chanin — https://github.com/chanind/hanzi-writer, https://github.com/chanind/hanzi-writer-data
- Make Me a Hanzi by Shaunak Kishore — https://github.com/skishore/makemeahanzi
- Fonts by Arphic Technology Co., Ltd. (AR PL KaitiM GB, AR PL UKai), released under the Arphic Public License in 1999
- Unihan database © Unicode, Inc.; CJKlib
- OpenCC by Carbo Kuo (BYVoid) and contributors — https://github.com/BYVoid/OpenCC

## Warranty

None. The data is provided "as is", without warranty of any kind (Arphic Public License §7; LGPL/GPL §15–16; Apache-2.0 §7).
