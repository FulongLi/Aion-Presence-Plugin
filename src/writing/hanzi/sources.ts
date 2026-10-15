/**
 * The Chinese Writing Pack's identity (v0.4.4): its version, its files, and the exact upstream releases it is built from
 * (scripts/chinese/build-pack.ts downloads each from its address and checks its SHA-256). Kept free of Node imports so
 * the page, the host and the tests can all name the pack.
 */
export const CHINESE_PACK_VERSION = "1.0.0";
/** The conversion date written into the pack's notices: fixed, so a rebuild from the pinned inputs is byte-identical. */
export const CHINESE_PACK_DATE = "2026-10-14";
/** The pack's directory, relative to the repository (and to the plugin root: packs/chinese-writing). */
export const CHINESE_PACK_DIR = "plugins/aion-presence/packs/chinese-writing";
export const CHINESE_PACK_PLUGIN_DIR = "packs/chinese-writing";

export const CHINESE_PACK_FILES = {
  strokes: "strokes.ahpk",
  dictionary: "dictionary.ahpk",
  variants: "variants.json",
  coverage: "coverage.json",
  manifest: "manifest.json",
  notice: "NOTICE.md",
  arphicLicense: "ARPHICPL.TXT",
  lgpl: "LGPL-MakeMeAHanzi.txt",
  gpl: "GPL-3.0.txt",
  mmahCopying: "COPYING-MakeMeAHanzi.txt",
  openccLicense: "LICENSE-OpenCC.txt",
} as const;

export const UPSTREAM = {
  hanziWriterDataVersion: "2.0.1",
  makemeahanziCommit: "bddc96d41bef78427ed0e034e9f7e31d71fd1b92",
  openccVersion: "ver.1.4.2",
  files: {
    hanziWriterData: {
      file: "hanzi-writer-data-2.0.1.tgz", url: "https://registry.npmjs.org/hanzi-writer-data/-/hanzi-writer-data-2.0.1.tgz",
      sha256: "72baf3d82b114e60d6e40ea05f24d2262a05cd39d544e2f322ba2fceb7beff15", license: "Arphic Public License",
    },
    arphicLicense: {
      file: "ARPHICPL.TXT", url: "https://raw.githubusercontent.com/chanind/hanzi-writer-data/68d10a4b21150cae5e1ebbd223eed289cf32d90c/ARPHICPL.TXT",
      sha256: "5590533436c70f10f2f524ee61456238c290175c6662fbe1c700b5f038a6d328", license: "Arphic Public License (text)",
    },
    dictionary: {
      file: "dictionary.txt", url: "https://raw.githubusercontent.com/skishore/makemeahanzi/bddc96d41bef78427ed0e034e9f7e31d71fd1b92/dictionary.txt",
      sha256: "744bb05d5b0742e9ee35c37791f94d56a173349b3367569e7ca11e510364d203", license: "LGPL-3.0-or-later",
    },
    mmahCopying: {
      file: "COPYING", url: "https://raw.githubusercontent.com/skishore/makemeahanzi/bddc96d41bef78427ed0e034e9f7e31d71fd1b92/COPYING",
      sha256: "26fa6b699b32401de4b75a4af574c2e0a99b3df6cb12df9313d257ee4634359c", license: "Make Me a Hanzi licensing statement",
    },
    lgpl: {
      file: "LGPL", url: "https://raw.githubusercontent.com/skishore/makemeahanzi/bddc96d41bef78427ed0e034e9f7e31d71fd1b92/LGPL",
      sha256: "eeb6fd06beac4a94a12ffb66876ecd6af68d5b6f38650d5f11aa90125933098b", license: "LGPL-3.0 text with the Unicode notice",
    },
    gpl: {
      file: "gpl-3.0.txt", url: "https://www.gnu.org/licenses/gpl-3.0.txt",
      sha256: "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986", license: "GPL-3.0 text (the LGPL incorporates it)",
    },
    openccST: {
      file: "STCharacters.txt", url: "https://raw.githubusercontent.com/BYVoid/OpenCC/ver.1.4.2/data/dictionary/STCharacters.txt",
      sha256: "a0ca1601c70648cf48b33c3c6210ccbecc5c7eead4b4c3daf76587ba2c03582b", license: "Apache-2.0",
    },
    openccTS: {
      file: "TSCharacters.txt", url: "https://raw.githubusercontent.com/BYVoid/OpenCC/ver.1.4.2/data/dictionary/TSCharacters.txt",
      sha256: "737c21c66f55a419dd6956cb3089476cdefc5a36877452631617696df1e5d925", license: "Apache-2.0",
    },
    openccLicense: {
      file: "OpenCC-LICENSE", url: "https://raw.githubusercontent.com/BYVoid/OpenCC/ver.1.4.2/LICENSE",
      sha256: "b534e465949558eec2597b04f5092b5e161236a68dfbfd04d547592ac3964308", license: "Apache-2.0 (text)",
    },
  },
} as const;
