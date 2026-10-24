import type { FreecadBackend } from "../cad/freecad";
import type { CadBridge } from "./service";

/**
 * v0.8: the simulation service's view of the FreeCAD backend — the documents FreeCAD knows (with their current
 * revisions) and the export of a document's analysis geometry (the worker's `sim_geometry`: a conformal BREP and the
 * face table, written inside the simulation workspace). The same worker serves `cad_model`; calls run one at a time.
 */
export function freecadBridge(cad: FreecadBackend): CadBridge {
  return {
    documents: async () => {
      const status = await cad.call("status");
      if (!status.ok) return null;
      const docs = (status.result.documents ?? []) as { id: string; name: string; revision: number }[];
      return docs.map(d => ({ id: d.id, name: d.name, revision: d.revision }));
    },
    exportGeometry: async (document, bodies, dir) => {
      const response = await cad.call("sim_geometry", { document, out_dir: dir, ...(bodies === "visible" ? {} : { bodies }) });
      return response.ok ? { ok: true } : { ok: false, code: response.error.code, message: response.error.message };
    },
  };
}
