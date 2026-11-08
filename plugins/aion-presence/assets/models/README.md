# Aion's model assets

What the plugin ships for the model library (v0.9). How it works: `docs/MODEL-LIBRARY.md` in the repository.

| Path | What | State |
| --- | --- | --- |
| `library.json` | Manifests (`aion.model/1`) of the bundled models | redistributable |
| `originals/lumen.glb` | Lumen, Aion's own test character (`scripts/models/make-originals.ts`) | redistributable |
| `khronos/fox.glb` | The Khronos Fox, unmodified: model CC0 1.0 (PixelMannen); rigging and animation CC BY 4.0 (tomkranis); glTF conversion CC BY 4.0 (AsoboStudio and scurest) | redistributable, credited |
| `catalogue/pokemon.json` | References to fan-made Pokémon models on Sketchfab — metadata only, no model files | catalogued |

Rules: a model is bundled here only when its licence allows redistribution **and** it depicts no third-party design (its
manifest records `redistributionVerified`). Catalogue references are never downloaded by Aion; a user may download one
under its terms and import it into their own library, which stays in the plugin data directory on their machine.
Pokémon and the names of Pokémon characters are trademarks of Nintendo, Creatures Inc. and GAME FREAK inc., used here
only to identify the referenced models; Aion Presence is not affiliated with them.
