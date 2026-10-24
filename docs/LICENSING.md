# Licensing, attribution and provenance (v0.5.1)

Aion Presence is **source-available for personal use**. The terms are in [LICENSE](../LICENSE): the *Aion Presence
Personal Use License*, version 0.1, a **draft that has not been reviewed by a lawyer**. This page explains the model,
lists what Aion bundles from others and under which licenses, and records the decisions the owner still has to make.
It is not legal advice.

## The model in brief

| | Under the draft license |
| --- | --- |
| A person using Aion for themself (learning, experiments, private research, fun, their own non-commercial projects) | Permitted |
| Modifying it for that personal use | Permitted |
| Giving a copy to another person, free, for their personal use, with the license and notices | Permitted |
| Any commercial use (products, services, SaaS, paid integrations, selling copies, commercial AI-agent services) | Needs a separate written license |
| Any use by or for an organization — companies, and also non-profit, educational, research and public bodies — including internal deployment and teaching on an institution's behalf | Needs a separate written license |
| Third-party components (below) | Their own licenses, unaffected |

Requests for commercial or organizational licenses: **info@spiritconnect.co.uk**.

It is **not an open-source license**: open-source definitions (OSI) do not allow restricting who may use software or
for what, and this license does exactly that. It is also stricter than a typical "non-commercial" license: it excludes
non-profit and educational institutions as licensees too, as the owner chose.

### GitHub is not the license

The repository is public on GitHub. GitHub's Terms of Service give GitHub users some permissions for public content
inside GitHub (viewing, forking on GitHub). Those come from GitHub's terms, not from Aion's license, and stop there:
running, modifying, sharing or deploying Aion is governed by LICENSE, in a fork too. A public fork must keep LICENSE and
every notice.

## What Aion bundles from others

Each keeps its own license; Aion's license does not apply to any of them. `npm run notices` regenerates the runtime's
list, verbatim, into `plugins/aion-presence/THIRD-PARTY-NOTICES.md`, which is installed with the plugin.

| Component | Where | License | Obligations met |
| --- | --- | --- | --- |
| three.js 0.182.0 (renderer; OrbitControls, TransformControls, GLTFLoader, RoomEnvironment) | runtime | MIT | notice in THIRD-PARTY-NOTICES |
| VexFlow 5.0.0 | runtime | MIT | notice |
| Bravura music font (through VexFlow) | runtime | SIL OFL 1.1 | notice and full OFL text; not sold by itself |
| Hanzi Writer 3.7.3 | runtime | MIT | notice |
| zod 4.6.5 | runtime | MIT | notice |
| @modelcontextprotocol/server, core 2.2.0; ext-apps 2.0.3 | runtime | MIT / Apache-2.0 (as their notices state) | notices |
| Chinese Writing Pack: stroke data (hanzi-writer-data 2.0.1, from Make Me a Hanzi, derived from Arphic fonts) | `packs/chinese-writing` | Arphic Public License | license file, modification notes, source pointers in its NOTICE.md |
| Chinese Writing Pack: dictionary (Make Me a Hanzi, from Unihan and CJKlib) | `packs/chinese-writing` | LGPL-3.0-or-later (+ GPL-3.0 text, Unicode notice) | license files, modification notes, source available in the public repository |
| Chinese Writing Pack: simplified ↔ traditional tables (OpenCC 1.4.2) | `packs/chinese-writing` | Apache-2.0 | license file, modification notes |
| Natural Earth (country outlines, cities, the Earth–Moon land mask) | runtime data | Public domain | credited |
| OpenStreetMap (via Nominatim, Photon), AWS Terrain Tiles, Wikimedia, Wikidata, Openverse | fetched at run time, not bundled | ODbL / per-source terms | credited in README and on the cards that show them |
| v0.6 routes: OpenStreetMap map tiles, Valhalla routing on FOSSGIS e.V.'s server (or the user's own), OpenRouteService (the user's key) | fetched at run time, not bundled | OSM data ODbL; each service's usage policy | "© OpenStreetMap contributors" and the routing service always visible on the Route Explorer map ([ROUTE-EXPLORER.md](ROUTE-EXPLORER.md)) |

| v0.7–v0.8 programs the user installs: FreeCAD (LGPL-2.0-or-later), Gmsh (GPL-2.0-or-later), Elmer FEM (GPL / LGPL) | run as separate programs, never bundled | their own | "not bundled" entries in THIRD-PARTY-NOTICES; [FREECAD.md](FREECAD.md), [SIMULATION.md](SIMULATION.md#licences) |

**Programs Aion runs but does not distribute (v0.7, v0.8).** FreeCAD, Gmsh and Elmer are installed by the user and run
as independent processes: Aion writes input files (a worker script FreeCAD's own interpreter runs; generated `.geo` and
`.sif` files), starts the programs with fixed arguments and reads their output files. Aion's code is not linked with
them and contains none of their code; the plugin ships none of their files. On that reading, distributing Aion does
not distribute them, and the GPL's obligations (source, licence text, the terms for combined works) attach to whoever
distributes those programs — for the user's own build, nobody. `scripts/sim/build-elmer.sh` (repository only) fetches
Elmer's public source and builds it on the user's machine for their own use. Two points to confirm with the lawyer
reviewing LICENSE: that this arms-length use is compatible with Aion's restrictive licence (the GPL places no limits on
*running* a program, and its authors' policy says so for Elmer), and what would change if a future Aion distribution
ever **bundled** Gmsh or Elmer binaries (GPL redistribution terms would then apply to those binaries, and whether the
combination is one "work" would need review).

The Chinese Writing Pack is "mere aggregation": a separate directory read at run time, never mixed into Aion's code.
Its LGPL and Arphic terms let anyone copy and redistribute **those files** under those licenses, commercially or not;
Aion's license cannot and does not restrict that.

## Provenance review

- **Authorship in Git**: every commit is by one author (Fulong Li); most v0.4–v0.5 commits carry a `Co-Authored-By`
  trailer for an AI coding assistant (Claude). No other human contributor appears in the history.
- **No third-party source files** were found inside `src/` or `scripts/` (no foreign copyright or SPDX headers); the
  only third-party text in the tree is the license material listed above.
- **Brand assets** (`assets/icon.svg`, `assets/logo.svg`, `assets/brand/spirit-connect-logo.svg`) are presented as
  Spirit Connect's. The license grants no trademark rights.
- **Generated assets**: the CAD viewer's `transformer.glb` and the card textures are generated by this repository's own
  scripts.

## Decisions and questions for the owner and a lawyer

1. **Copyright holder — decided.** The owner confirmed the copyright holder is **Fulong Li**, the individual
   (2026-10-18); LICENSE names him as Licensor. "Spirit Connect" remains the brand under which Aion is presented.
2. **SCF Presence Realtime.** Aion ports code and tuning from *SCF Presence Realtime* (see [PARITY.md](PARITY.md)).
   Confirm that the same owner holds the rights to that code, or under what terms it may be relicensed here.
3. **AI-assisted code.** Much of the code was written with AI coding assistants. Whether and how such contributions
   are protected by copyright differs between jurisdictions; ask counsel how this affects enforceability.
4. **Governing law and venue** (section 15(a)), and the **cure period** for a first breach (section 12(b)).
5. **Contributions** (section 11): accept them or not; if so, under which contributor agreement.
6. **Earlier versions.** Versions up to v0.5.0 were published without any license file (so, by default, without a
   grant). Decide whether this license applies to those tags as well; their content is not changed either way.
7. **Students and teachers.** The draft treats coursework or teaching done for an institution as organizational use,
   and a student's own self-study as personal use. Confirm that boundary is what you intend.
8. **Enforceability review** of the whole text, including consumer-law limits on the warranty disclaimer and
   liability limitation.

Until these are settled, LICENSE stays marked as a draft, and nothing in this repository should be described as
"licensed under" an open-source license.
