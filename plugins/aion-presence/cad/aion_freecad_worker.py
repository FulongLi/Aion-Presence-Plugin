# Aion Presence — FreeCAD worker (v0.7).
#
# Run by FreeCAD's own interpreter (`freecadcmd aion_freecad_worker.py`), started and owned by Aion's MCP server. It
# reads one JSON request per line on stdin and writes one JSON response per line on file descriptor 3 (FreeCAD prints
# its own messages on stdout). It runs a fixed set of validated CAD operations — never code it is sent — on native
# FreeCAD documents, inside FreeCAD transactions: an operation that fails, or leaves an invalid model, is aborted and the
# previous valid model stays. After each change it reports the feature tree and a tessellated preview (per component,
# per face), which Aion turns into a GLB for its CAD viewer. FreeCAD's document is the engineering model; the preview is
# only a picture of it.
#
# Units: millimetres and degrees. Coordinates are FreeCAD's (Z up).
#
# Copyright (c) 2026 Fulong Li. Part of Aion Presence; see LICENSE. FreeCAD itself is LGPL-2.0-or-later and is not
# distributed with Aion (see THIRD-PARTY-NOTICES.md).

import base64
import json
import math
import os
import struct
import sys
import time
import traceback

import FreeCAD as App
import Part

try:
    import Sketcher  # noqa: F401  (registers Sketcher::SketchObject)
    HAVE_SKETCHER = True
except Exception:  # pragma: no cover - depends on the FreeCAD build
    HAVE_SKETCHER = False

PROTOCOL = 1
OUT = os.fdopen(3, "w", buffering=1)
MAX_OBJECTS = 400
MAX_TRIANGLES = 1_500_000
NAME_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")


class CadError(Exception):
    def __init__(self, code, message, **extra):
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra


def fail(code, message, **extra):
    raise CadError(code, message, **extra)


# ── Documents ─────────────────────────────────────────────────────────────────────────────────────────────────────
# Documents persist (v0.7): every confirmed revision is saved as a FreeCAD document in Aion's workspace, with a small
# registry of each document's history, undo and redo stacks and file. Codex may start a new MCP server — and so a new
# worker — for every turn, and the user may restart Codex: the next worker opens the latest revision and carries on.
# Undo and redo restore those saved FreeCAD states (each a new revision); FreeCAD's own transactions make each change
# atomic. A lock file keeps two conversations from changing one document at the same moment.
WORKSPACE = os.environ.get("AION_CAD_WORKSPACE") or os.path.join(os.path.expanduser("~"), ".aion-presence", "cad")
REGISTRY = os.path.join(WORKSPACE, "documents.json")
UNDO_DEPTH = 30


def load_registry():
    try:
        with open(REGISTRY, encoding="utf-8") as handle_:
            data = json.load(handle_)
    except (OSError, ValueError):
        data = {}
    if not isinstance(data.get("documents"), dict):
        data["documents"] = {}
    data.setdefault("last", None)
    return data


def save_registry(data):
    os.makedirs(WORKSPACE, mode=0o700, exist_ok=True)
    temporary = "%s.%d.tmp" % (REGISTRY, os.getpid())
    with open(temporary, "w", encoding="utf-8") as handle_:
        json.dump(data, handle_, indent=1)
    os.replace(temporary, REGISTRY)


def snapshot_path(ident, revision):
    return os.path.join(WORKSPACE, ident, "r%06d.FCStd" % revision)


class Doc:
    def __init__(self, ident, fc, meta):
        self.id = ident
        self.fc = fc
        self.meta = meta

    revision = property(lambda self: self.meta["revision"])
    path = property(lambda self: self.meta.get("path"))
    handed_off = property(lambda self: bool(self.meta.get("handed_off")))
    dirty = property(lambda self: self.meta.get("saved_revision") != self.meta["revision"])
    history = property(lambda self: self.meta["history"])


DOCS = {}


def new_id():
    import secrets  # noqa: PLC0415
    known = load_registry()["documents"]
    while True:
        ident = "cad-%s" % secrets.token_hex(3)
        if ident not in known:
            return ident


class locked:
    """A per-document lock file (another conversation's worker may be changing the same document)."""

    def __init__(self, ident):
        self.path = os.path.join(WORKSPACE, ident, ".lock")

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), mode=0o700, exist_ok=True)
        deadline = time.time() + 15
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(self.path) > 60:
                        os.remove(self.path)
                        continue
                except OSError:
                    continue
                if time.time() > deadline:
                    fail("busy", "Another conversation is changing this document; try again in a moment.")
                time.sleep(0.1)

    def __exit__(self, *exc):
        try:
            os.remove(self.path)
        except OSError:
            pass
        return False


def record(doc, snapshot=True):
    """Persists the document: its current state as a snapshot (a new revision), and its registry entry."""
    if snapshot:
        path = snapshot_path(doc.id, doc.revision)
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        doc.fc.saveCopy(path)
        keep = {doc.revision} | {u["to"] for u in doc.meta["undo"]} | {r["to"] for r in doc.meta["redo"]}
        for name in os.listdir(os.path.dirname(path)):
            if name.startswith("r") and name.endswith(".FCStd") and name[1:-6].isdigit() and int(name[1:-6]) not in keep:
                try:
                    os.remove(os.path.join(os.path.dirname(path), name))
                except OSError:
                    pass
    doc.meta["updated"] = time.time()
    data = load_registry()
    data["documents"][doc.id] = doc.meta
    data["last"] = doc.id
    save_registry(data)


def load_doc(ident, meta, revision=None):
    """Opens a saved revision (the latest by default) of a known document in this worker."""
    revision = meta["revision"] if revision is None else revision
    path = snapshot_path(ident, revision)
    if not os.path.isfile(path):
        fail("missing-document", "Revision %d of %s is missing from Aion's workspace (%s)." % (revision, meta.get("name", ident), WORKSPACE))
    if ident in DOCS:
        try:
            App.closeDocument(DOCS[ident].fc.Name)
        except Exception:  # noqa: BLE001
            pass
    fc = App.openDocument(path)
    # FreeCAD names an opened document after its file (here a snapshot): it keeps its own name.
    fc.Label = meta.get("name") or fc.Label
    fc.UndoMode = 1
    fc.recompute()
    doc = Doc(ident, fc, meta)
    DOCS[ident] = doc
    return doc


def get_doc(args, required=True):
    data = load_registry()
    known = {k: v for k, v in data["documents"].items() if not v.get("closed")}
    ident = args.get("document")
    if ident is None:
        ident = data["last"] if data["last"] in known else None
        if ident is None:
            if not required:
                return None
            fail("missing-document", "No document is open: create_document or open_document first.")
    meta = known.get(ident)
    if meta is None:
        fail("missing-document", "No open document %r (open: %s)." % (ident, ", ".join("%s (%s)" % (k, v.get("name")) for k, v in known.items()) or "none"))
    doc = DOCS.get(ident)
    if doc is None or doc.revision != meta["revision"]:
        # Not loaded by this worker yet, or another conversation moved it on: its latest saved revision.
        doc = load_doc(ident, meta)
    else:
        doc.meta = meta
    return doc


def clean_name(text, fallback):
    base = "".join(ch if ch in NAME_OK else "_" for ch in str(text or "").strip().replace(" ", "_"))[:40].strip("_")
    if not base or base[0].isdigit():
        base = fallback
    return base


def clean_label(text, fallback):
    label = " ".join(str(text or "").split())[:60]
    return label or fallback


def num(args, key, default=None, minimum=None, maximum=None, positive=False):
    if key not in args or args[key] is None:
        if default is None:
            fail("invalid-parameter", "%s is required." % key, parameter=key)
        return float(default)
    value = args[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        fail("invalid-parameter", "%s must be a number (millimetres or degrees)." % key, parameter=key)
    value = float(value)
    if positive and value <= 0:
        fail("invalid-parameter", "%s must be greater than 0 (got %g)." % (key, value), parameter=key)
    if minimum is not None and value < minimum:
        fail("invalid-parameter", "%s must be at least %g (got %g)." % (key, minimum, value), parameter=key)
    if maximum is not None and value > maximum:
        fail("invalid-parameter", "%s must be at most %g (got %g)." % (key, maximum, value), parameter=key)
    return value


def vec(value, key):
    if not isinstance(value, (list, tuple)) or len(value) != 3 or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value):
        fail("invalid-parameter", "%s must be [x, y, z] in millimetres." % key, parameter=key)
    return App.Vector(float(value[0]), float(value[1]), float(value[2]))


def mm(value):
    return App.Units.Quantity("%r mm" % float(value))


def q(value):
    """A Quantity or number as a float (millimetres or degrees)."""
    return float(getattr(value, "Value", value))


# ── Objects and their roles ───────────────────────────────────────────────────────────────────────────────────────
def role(obj):
    return getattr(obj, "AionRole", "") if hasattr(obj, "AionRole") else ""


def tag(obj, kind, **props):
    if not hasattr(obj, "AionRole"):
        obj.addProperty("App::PropertyString", "AionRole", "Aion", "What Aion made this object for")
    obj.AionRole = kind
    for key, (ptype, value) in props.items():
        if not hasattr(obj, key):
            obj.addProperty(ptype, key, "Aion")
        setattr(obj, key, value)
    return obj


def find(doc, ref, what="component"):
    if not isinstance(ref, str) or not ref.strip():
        fail("invalid-parameter", "%s must be a component id or label." % what, parameter=what)
    ref = ref.strip()
    obj = doc.fc.getObject(ref)
    if obj is None:
        matches = [o for o in doc.fc.Objects if o.Label.lower() == ref.lower()]
        if len(matches) > 1:
            # Several share the label (a result keeps its body's name): the visible one is meant.
            visible = [o for o in matches if o.Visibility]
            matches = visible or matches
        obj = matches[0] if matches else None
    if obj is None:
        fail("unknown-component", "No component %r in %s (inspect the document for ids)." % (ref, doc.fc.Label), component=ref)
    return obj


def top_objects(doc):
    """What the model shows: features nothing else consumes, that are solids, and visible."""
    out = []
    for obj in doc.fc.Objects:
        if not hasattr(obj, "Shape") or obj.TypeId.startswith("Sketcher::"):
            continue
        consumers = [o for o in obj.InList if hasattr(o, "Shape") and not o.TypeId.startswith("Sketcher::")]
        if consumers:
            continue
        if role(obj) in ("hole", "tools"):
            continue
        out.append(obj)
    return out


def body_of(obj):
    """The primitive a result was made from (holes, pockets, fillets keep the body's parameters)."""
    seen = 0
    while obj is not None and seen < 64:
        seen += 1
        r = role(obj)
        if r in ("drilled", "pocketed") or obj.TypeId in ("Part::Fillet", "Part::Chamfer"):
            obj = getattr(obj, "Base", None)
            continue
        return obj
    return obj


def surface_of(doc, obj):
    """The visible solid a component belongs to (naming the box of a drilled enclosure means the enclosure)."""
    tops = top_objects(doc)
    seen = 0
    while obj not in tops and seen < 64:
        seen += 1
        wrappers = [o for o in obj.InList if getattr(o, "Base", None) == obj and (role(o) in ("drilled", "pocketed") or o.TypeId in ("Part::Fillet", "Part::Chamfer"))]
        if not wrappers:
            return obj
        obj = wrappers[0]
    return obj


def take_label(new, old, feature):
    """The new result is what the user calls the part: it takes the label; the wrapped one is renamed (labels are unique)."""
    label = old.Label
    old.Label = "%s body" % label if role(old) in ("primitive", "pad") else "%s before %s" % (label, feature)
    new.Label = label


def unique_name(doc, stem):
    n = 1
    while doc.fc.getObject("%s%d" % (stem, n)) is not None:
        n += 1
    return "%s%d" % (stem, n)


def problems(doc):
    found = []
    for obj in doc.fc.Objects:
        state = list(getattr(obj, "State", []))
        if "Invalid" in state or "Error" in state:
            found.append("%s (%s) could not be computed" % (obj.Label, obj.Name))
            continue
        if hasattr(obj, "Shape") and not obj.TypeId.startswith("Sketcher::") and role(obj) != "tools":
            try:
                if obj.Shape.isNull():
                    found.append("%s has no geometry" % obj.Label)
                elif not obj.Shape.isValid():
                    found.append("%s has invalid geometry" % obj.Label)
            except Exception as error:  # noqa: BLE001
                found.append("%s: %s" % (obj.Label, error))
    for obj in top_objects(doc):
        try:
            if obj.Shape.Solids and obj.Shape.Volume <= 1e-9:
                found.append("%s has no volume left" % obj.Label)
            elif not obj.Shape.Solids:
                found.append("%s is not a solid" % obj.Label)
        except Exception as error:  # noqa: BLE001
            found.append("%s: %s" % (obj.Label, error))
    return found


def check_writable(doc):
    if doc.handed_off:
        fail("handed-off", "The document is open in the FreeCAD application (single writer). Save it there, then reload it here (action reload) before changing it from Aion.")
    if doc.path and doc.meta.get("saved_mtime") is not None and os.path.exists(doc.path):
        if os.path.getmtime(doc.path) > doc.meta["saved_mtime"] + 0.5:
            fail("modified-externally", "%s changed on disk since Aion last saved or opened it. Reload it (action reload) before changing it here, or save it under another path." % os.path.basename(doc.path))


def advance(doc, description, undo=True):
    """A new revision: history, the undo stack (the state before), an emptied redo stack, the snapshot."""
    before = doc.revision
    doc.meta["revision"] = before + 1
    doc.meta["history"].append({"revision": doc.revision, "description": description[:120]})
    del doc.meta["history"][:-50]
    if undo:
        doc.meta["undo"].append({"to": before, "change": description[:120]})
        del doc.meta["undo"][:-UNDO_DEPTH]
        doc.meta["redo"] = []
    record(doc)


def mutate(doc, args, description, change):
    """Applies one change as a FreeCAD transaction: recomputed, checked, and aborted (previous model kept) on failure."""
    with locked(doc.id):
        latest = load_registry()["documents"].get(doc.id, {}).get("revision", doc.revision)
        if latest != doc.revision:
            fail("stale-revision", "Another conversation changed this document (now revision %d); inspect it and try again." % latest, current=latest)
        check_writable(doc)
        base = args.get("revision")
        if base is not None and base != doc.revision:
            fail("stale-revision", "The change was made against revision %s but the document is at revision %d; inspect it and try again." % (base, doc.revision), current=doc.revision)
        fc = doc.fc
        fc.openTransaction(description[:60])
        try:
            outcome = change()
            fc.recompute()
            refresh_selectors(doc)
            found = problems(doc)
            if found:
                fail("regeneration-failed", "FreeCAD could not regenerate the model: %s." % "; ".join(found[:4]))
        except BaseException as error:
            fc.abortTransaction()
            fc.recompute()
            if isinstance(error, CadError):
                raise
            fail("regeneration-failed", "FreeCAD refused the change: %s." % (str(error).strip() or type(error).__name__))
        fc.commitTransaction()
        advance(doc, description)
        return outcome or {}


# ── Edge selectors (fillets and chamfers keep their rule, so they survive a change of the body) ───────────────────
def select_edges(shape, rule):
    picked = []
    zmin, zmax = shape.BoundBox.ZMin, shape.BoundBox.ZMax
    tol = max(1e-6, shape.BoundBox.DiagonalLength * 1e-6)
    for i, edge in enumerate(shape.Edges):
        faces = shape.ancestorsOfType(edge, Part.Face)
        if len(faces) < 2:
            continue
        straight = edge.Curve.TypeId == "Part::GeomLine"
        between_planes = all(f.Surface.TypeId == "Part::GeomPlane" for f in faces)
        if rule == "all":
            picked.append(i + 1)
            continue
        if rule == "vertical":
            if straight and between_planes and abs(edge.tangentAt(edge.FirstParameter).z) > 0.999:
                picked.append(i + 1)
            continue
        bb = edge.BoundBox
        if rule == "top" and abs(bb.ZMin - zmax) < tol and abs(bb.ZMax - zmax) < tol and between_planes:
            picked.append(i + 1)
        elif rule == "bottom" and abs(bb.ZMin - zmin) < tol and abs(bb.ZMax - zmin) < tol and between_planes:
            picked.append(i + 1)
    return picked


def apply_selector(obj, force=False):
    rule = getattr(obj, "AionEdges", "")
    size = q(getattr(obj, "AionSize", 0))
    base = obj.Base
    if not rule or base is None:
        return False
    edges = select_edges(base.Shape, rule)
    if not edges:
        fail("invalid-parameter", "No %s edges on %s to %s." % (rule, base.Label, "round" if obj.TypeId == "Part::Fillet" else "chamfer"), parameter="edges")
    wanted = [(e, size, size) for e in edges]
    # force: FreeCAD 1.x keeps edge links by their topological names, which a change upstream (a sketch) can break;
    # assigning the edges again, even unchanged, re-links them.
    if force or [tuple(x) for x in obj.Edges] != wanted:
        obj.Edges = wanted
        return True
    return False


def refresh_selectors(doc):
    """Re-selects every fillet's and chamfer's edges by its rule on the recomputed body (edge numbers change when the body
    does), and recomputes again — also when the first recompute left one invalid with the old numbering."""
    for _ in range(3):
        changed = False
        for obj in doc.fc.Objects:
            if obj.TypeId in ("Part::Fillet", "Part::Chamfer") and hasattr(obj, "AionEdges"):
                stale = "Invalid" in obj.State or "Error" in obj.State
                if apply_selector(obj, force=stale) or stale:
                    obj.touch()
                    changed = True
        if not changed:
            return
        doc.fc.recompute()


# ── Parameters ────────────────────────────────────────────────────────────────────────────────────────────────────
PRIMITIVE_PARAMS = {
    "Part::Box": ["Length", "Width", "Height"],
    "Part::Cylinder": ["Radius", "Height", "Angle"],
    "Part::Sphere": ["Radius"],
    "Part::Cone": ["Radius1", "Radius2", "Height"],
}


def parameters(obj):
    """The editable parameters of a component, as {name: {value, unit}} (what set_parameter accepts)."""
    out = {}
    r = role(obj)
    if r == "hole":
        out["Diameter"] = (2 * q(obj.Radius), "mm")
        out["Depth"] = (q(obj.AionDepth), "mm") if q(obj.AionDepth) > 0 else ("through", "")
        out["Inset X"] = (q(obj.InsetX), "mm")
        out["Inset Y"] = (q(obj.InsetY), "mm")
        out["Anchor"] = ("%s/%s" % (obj.AnchorX, obj.AnchorY), "")
        out["Face"] = (obj.AionFace, "")
        return out
    if obj.TypeId in PRIMITIVE_PARAMS:
        for name in PRIMITIVE_PARAMS[obj.TypeId]:
            out[name] = (q(getattr(obj, name)), "deg" if name == "Angle" else "mm")
        if obj.TypeId == "Part::Cylinder":
            out["Diameter"] = (2 * q(obj.Radius), "mm")
    if obj.TypeId in ("Part::Fillet", "Part::Chamfer"):
        out["Radius" if obj.TypeId == "Part::Fillet" else "Size"] = (q(obj.AionSize), "mm")
        out["Edges"] = (obj.AionEdges, "")
    if obj.TypeId == "Part::Extrusion":
        out["Length"] = (q(obj.LengthFwd), "mm")
    if obj.TypeId == "Sketcher::SketchObject":
        for c in obj.Constraints:
            if c.Name:
                out[c.Name] = (q(c.Value) if c.Type not in ("Angle",) else math.degrees(q(c.Value)), "deg" if c.Type == "Angle" else "mm")
    if hasattr(obj, "Placement") and r not in ("hole", "drilled", "pocketed", "tools") and obj.TypeId not in ("Part::Fillet", "Part::Chamfer", "Part::Cut", "Part::Fuse", "Part::Common"):
        base = obj.Placement.Base
        out["X"], out["Y"], out["Z"] = (base.x, "mm"), (base.y, "mm"), (base.z, "mm")
        axis, angle = obj.Placement.Rotation.Axis, math.degrees(obj.Placement.Rotation.Angle)
        if abs(angle) > 1e-9:
            out["Rotation"] = ("%g° about (%g, %g, %g)" % (angle, round(axis.x, 4), round(axis.y, 4), round(axis.z, 4)), "")
    return out


def set_param(doc, obj, name, value):
    key = name.strip().lower().replace("_", " ")
    r = role(obj)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        fail("invalid-parameter", "%s must be a number in millimetres (or degrees)." % name, parameter=name)
    value = float(value)
    if r == "hole":
        if key == "diameter":
            if value <= 0:
                fail("invalid-parameter", "Diameter must be greater than 0.", parameter=name)
            obj.Radius = mm(value / 2)
        elif key == "depth":
            if value < 0:
                fail("invalid-parameter", "Depth must be 0 (through) or more.", parameter=name)
            obj.AionDepth = mm(value)
            place_hole(doc, obj)
        elif key == "inset":
            # "Move it inward": both insets at once (one change, one undo).
            obj.InsetX = mm(value)
            obj.InsetY = mm(value)
            place_hole(doc, obj)
        elif key in ("inset x", "insetx", "x"):
            obj.InsetX = mm(value)
            place_hole(doc, obj)
        elif key in ("inset y", "insety", "y"):
            obj.InsetY = mm(value)
            place_hole(doc, obj)
        else:
            fail("invalid-parameter", "A hole has Diameter, Depth, Inset X, Inset Y and Inset (both).", parameter=name)
        return
    if obj.TypeId in ("Part::Fillet", "Part::Chamfer") and key in ("radius", "size"):
        if value <= 0:
            fail("invalid-parameter", "%s must be greater than 0." % name, parameter=name)
        obj.AionSize = mm(value)
        apply_selector(obj)
        return
    if obj.TypeId == "Part::Extrusion" and key in ("length", "depth"):
        if value <= 0:
            fail("invalid-parameter", "Length must be greater than 0.", parameter=name)
        obj.LengthFwd = mm(value)
        return
    if obj.TypeId == "Sketcher::SketchObject":
        for i, c in enumerate(obj.Constraints):
            if c.Name and c.Name.lower() == key:
                set_constraint_value(obj, i, c, value)
                return
    if key in ("x", "y", "z") and hasattr(obj, "Placement") and r not in ("drilled", "pocketed"):
        base = obj.Placement.Base
        setattr(base, key, value)
        obj.Placement = App.Placement(base, obj.Placement.Rotation)
        return
    if key == "diameter" and obj.TypeId == "Part::Cylinder":
        key, value = "radius", value / 2
    for prop in PRIMITIVE_PARAMS.get(obj.TypeId, []):
        if prop.lower() == key:
            if prop == "Angle":
                if not 0 < value <= 360:
                    fail("invalid-parameter", "Angle must be in (0, 360] degrees.", parameter=name)
                setattr(obj, prop, App.Units.Quantity("%r deg" % value))
                return
            if value <= 0 and prop != "Radius2":
                fail("invalid-parameter", "%s must be greater than 0 (got %g mm)." % (prop, value), parameter=name)
            if value < 0:
                fail("invalid-parameter", "%s cannot be negative." % prop, parameter=name)
            setattr(obj, prop, mm(value))
            return
    known = ", ".join(parameters(obj)) or "none"
    fail("invalid-parameter", "%s (%s) has no parameter %r. Its parameters: %s." % (obj.Label, obj.Name, name, known), parameter=name)


# ── Primitives ────────────────────────────────────────────────────────────────────────────────────────────────────
def placement(args):
    at = vec(args["at"], "at") if "at" in args else App.Vector(0, 0, 0)
    rotation = App.Rotation()
    if "rotate" in args:
        rot = args["rotate"]
        if not isinstance(rot, dict):
            fail("invalid-parameter", "rotate must be {axis: [x, y, z], angle: degrees}.", parameter="rotate")
        axis = vec(rot.get("axis", [0, 0, 1]), "rotate.axis")
        if axis.Length < 1e-9:
            fail("invalid-parameter", "rotate.axis must not be zero.", parameter="rotate.axis")
        rotation = App.Rotation(axis, num(rot, "angle"))
    return App.Placement(at, rotation)


def op_add_primitive(args):
    doc = get_doc(args)
    kind = args.get("kind")
    types = {"box": "Part::Box", "cylinder": "Part::Cylinder", "sphere": "Part::Sphere", "cone": "Part::Cone"}
    if kind not in types:
        fail("invalid-parameter", "kind must be box, cylinder, sphere or cone.", parameter="kind")
    label = clean_label(args.get("name"), kind.capitalize())

    def change():
        obj = doc.fc.addObject(types[kind], clean_name(args.get("name"), kind.capitalize()))
        obj.Label = label
        if kind == "box":
            obj.Length, obj.Width, obj.Height = mm(num(args, "length", positive=True)), mm(num(args, "width", positive=True)), mm(num(args, "height", positive=True))
        elif kind == "cylinder":
            radius = num(args, "diameter", positive=True) / 2 if "diameter" in args else num(args, "radius", positive=True)
            obj.Radius, obj.Height = mm(radius), mm(num(args, "height", positive=True))
        elif kind == "sphere":
            obj.Radius = mm(num(args, "diameter", positive=True) / 2 if "diameter" in args else num(args, "radius", positive=True))
        else:
            obj.Radius1, obj.Radius2, obj.Height = mm(num(args, "radius1", minimum=0)), mm(num(args, "radius2", minimum=0)), mm(num(args, "height", positive=True))
            if q(obj.Radius1) == 0 and q(obj.Radius2) == 0:
                fail("invalid-parameter", "A cone needs radius1 or radius2 greater than 0.", parameter="radius1")
        obj.Placement = placement(args)
        tag(obj, "primitive", AionColor=("App::PropertyString", color_arg(args)))
        return {"created": obj.Name}

    return mutate(doc, args, "Add %s %s" % (kind, label), change)


def color_arg(args, default="#9aa4ae"):
    c = args.get("color", default)
    if not isinstance(c, str) or len(c) != 7 or c[0] != "#" or any(ch not in "0123456789abcdefABCDEF" for ch in c[1:]):
        fail("invalid-parameter", "color must be #rrggbb.", parameter="color")
    return c.lower()


# ── Holes ─────────────────────────────────────────────────────────────────────────────────────────────────────────
FACES = {
    # face: (u axis, v axis, normal axis, at max end of the normal axis)
    "top": ("x", "y", "z", True), "bottom": ("x", "y", "z", False),
    "front": ("x", "z", "y", False), "back": ("x", "z", "y", True),
    "left": ("y", "z", "x", False), "right": ("y", "z", "x", True),
}
BOX_SIZE = {"x": "Length", "y": "Width", "z": "Height"}


def place_hole(doc, hole):
    """Positions a hole from its anchors and insets: expressions on a box (they follow its size), else its bounds now."""
    body = doc.fc.getObject(hole.AionBody)
    u, v, n, at_max = FACES[hole.AionFace]
    depth = q(hole.AionDepth)
    for prop in ("Placement.Base.x", "Placement.Base.y", "Placement.Base.z", "Height"):
        try:
            hole.setExpression(prop, None)
        except Exception:  # noqa: BLE001
            pass
    rotation = {"z": App.Rotation(App.Vector(1, 0, 0), 180 if at_max else 0), "y": App.Rotation(App.Vector(1, 0, 0), 90 if at_max else -90),
                "x": App.Rotation(App.Vector(0, 1, 0), -90 if at_max else 90)}[n]
    if body.TypeId == "Part::Box" and abs(body.Placement.Rotation.Angle) < 1e-12:
        name = body.Name

        def along(axis, anchor, inset):
            origin = "%s.Placement.Base.%s" % (name, axis)
            return "%s + %s.%s - %s" % (origin, name, BOX_SIZE[axis], inset) if anchor == "max" else "%s + %s" % (origin, inset)
        expressions = {u: along(u, hole.AnchorX, "InsetX"), v: along(v, hole.AnchorY, "InsetY")}
        origin = "%s.Placement.Base.%s" % (name, n)
        size = "%s.%s" % (name, BOX_SIZE[n])
        if depth > 0:
            expressions[n] = ("%s + %s + 1 mm" % (origin, size)) if at_max else ("%s - 1 mm" % origin)
            height = "AionDepth + 1 mm"
        else:
            expressions[n] = ("%s + %s + 1 mm" % (origin, size)) if at_max else ("%s - 1 mm" % origin)
            height = "%s + 2 mm" % size
        hole.Placement = App.Placement(App.Vector(0, 0, 0), rotation)
        for axis, expression in expressions.items():
            hole.setExpression("Placement.Base.%s" % axis, expression)
        hole.setExpression("Height", height)
        return
    box = body.Shape.BoundBox
    lo = {"x": box.XMin, "y": box.YMin, "z": box.ZMin}
    hi = {"x": box.XMax, "y": box.YMax, "z": box.ZMax}
    point = {}
    point[u] = hi[u] - q(hole.InsetX) if hole.AnchorX == "max" else lo[u] + q(hole.InsetX)
    point[v] = hi[v] - q(hole.InsetY) if hole.AnchorY == "max" else lo[v] + q(hole.InsetY)
    point[n] = hi[n] + 1 if at_max else lo[n] - 1
    hole.Height = mm(depth + 1 if depth > 0 else hi[n] - lo[n] + 2)
    hole.Placement = App.Placement(App.Vector(point["x"], point["y"], point["z"]), rotation)


def drilled_result(doc, target):
    """The result holes are cut from: the target's own if it already has holes, else a new cut of the target."""
    if role(target) == "drilled":
        return target, target.Tool
    consumers = [o for o in target.InList if role(o) == "drilled"]
    if consumers:
        return consumers[0], consumers[0].Tool
    tools = tag(doc.fc.addObject("Part::Compound", clean_name(target.Name + "_HoleTools", "HoleTools")), "tools")
    tools.Label = "%s hole tools" % target.Label.replace(" body", "")
    cut = doc.fc.addObject("Part::Cut", clean_name(target.Name + "_Drilled", "Drilled"))
    cut.Base, cut.Tool = target, tools
    take_label(cut, target, "holes")
    tag(cut, "drilled", AionColor=("App::PropertyString", getattr(target, "AionColor", "#9aa4ae")))
    target.Visibility = False
    tools.Visibility = False
    return cut, tools


def op_add_holes(args):
    doc = get_doc(args)
    target = surface_of(doc, find(doc, args.get("target"), "target"))
    if target not in top_objects(doc):
        fail("invalid-parameter", "%s is not a visible solid of the model; holes go into a visible solid (inspect for its id)." % target.Label, parameter="target")
    diameter = num(args, "diameter", positive=True)
    depth = num(args, "depth", 0, minimum=0)
    face = args.get("face", "top")
    if face not in FACES:
        fail("invalid-parameter", "face must be top, bottom, front, back, left or right.", parameter="face")
    spots = []
    if "corners" in args:
        inset = num(args, "corners", positive=True)
        spots = [("min", "min", inset, inset), ("max", "min", inset, inset), ("max", "max", inset, inset), ("min", "max", inset, inset)]
    elif isinstance(args.get("positions"), list) and args["positions"]:
        for p in args["positions"][:32]:
            if not isinstance(p, (list, tuple)) or len(p) != 2 or not all(isinstance(c, (int, float)) and not isinstance(c, bool) and math.isfinite(c) for c in p):
                fail("invalid-parameter", "positions are [u, v] pairs in millimetres from the face's minimum corner.", parameter="positions")
            spots.append(("min", "min", float(p[0]), float(p[1])))
    else:
        fail("invalid-parameter", "Give corners (an inset in mm from the edges) or positions ([[u, v], …] in mm on the face).", parameter="positions")

    def change():
        result, tools = drilled_result(doc, target)
        body = body_of(result.Base) if role(target) == "drilled" else body_of(target)
        body = body if body is not None else target
        made = []
        links = list(tools.Links)
        for anchor_x, anchor_y, ix, iy in spots:
            hole = doc.fc.addObject("Part::Cylinder", unique_name(doc, "Hole"))
            hole.Label = "Hole %s" % hole.Name[4:]
            hole.Radius = mm(diameter / 2)
            tag(hole, "hole", AionBody=("App::PropertyString", body.Name), AionFace=("App::PropertyString", face),
                AnchorX=("App::PropertyString", anchor_x), AnchorY=("App::PropertyString", anchor_y),
                InsetX=("App::PropertyDistance", mm(ix)), InsetY=("App::PropertyDistance", mm(iy)),
                AionDepth=("App::PropertyDistance", mm(depth)), AionColor=("App::PropertyString", "#b9915e"))
            place_hole(doc, hole)
            hole.Visibility = False
            links.append(hole)
            made.append(hole)
        tools.Links = links
        doc.fc.recompute()
        # Each hole must really remove material (a hole outside the solid is refused, not silently kept).
        solid = result.Base.Shape
        for hole in made:
            if solid.common(hole.Shape).Volume <= 1e-6:
                fail("invalid-parameter", "%s would be outside %s (inset %g, %g mm on the %s face): nothing would be drilled." % (hole.Label, target.Label, q(hole.InsetX), q(hole.InsetY), face), parameter="positions")
        return {"created": [h.Name for h in made], "result": result.Name}

    what = "%d × Ø%g mm hole%s" % (len(spots), diameter, "" if len(spots) == 1 else "s")
    return mutate(doc, args, "Add %s to %s" % (what, target.Label), change)


# ── Sketches, pads and pockets ────────────────────────────────────────────────────────────────────────────────────
PLANES = {"XY": App.Rotation(), "XZ": App.Rotation(App.Vector(1, 0, 0), 90), "YZ": App.Rotation(App.Vector(0.57735, 0.57735, 0.57735), 120)}


def set_constraint_value(sketch, index, constraint, value):
    if constraint.Type in ("Distance", "DistanceX", "DistanceY", "Radius", "Diameter") and value <= 0 and constraint.Type in ("Radius", "Diameter"):
        fail("invalid-parameter", "%s must be greater than 0." % constraint.Name, parameter=constraint.Name)
    sketch.setDatum(index, App.Units.Quantity("%r mm" % value))


def op_add_sketch(args):
    if not HAVE_SKETCHER:
        fail("unsupported", "This FreeCAD has no Sketcher workbench.")
    doc = get_doc(args)
    plane = args.get("plane", "XY")
    if plane not in PLANES:
        fail("invalid-parameter", "plane must be XY, XZ or YZ.", parameter="plane")
    offset = num(args, "offset", 0)
    profiles = args.get("profiles")
    if not isinstance(profiles, list) or not 1 <= len(profiles) <= 16:
        fail("invalid-parameter", "profiles: 1–16 of {rectangle: {x, y, width, height}} or {circle: {x, y, diameter}}.", parameter="profiles")
    label = clean_label(args.get("name"), "Sketch")

    def change():
        sketch = doc.fc.addObject("Sketcher::SketchObject", clean_name(args.get("name"), "Sketch"))
        sketch.Label = label
        normal = PLANES[plane].multVec(App.Vector(0, 0, 1))
        sketch.Placement = App.Placement(normal * offset, PLANES[plane])
        V = App.Vector
        for n, profile in enumerate(profiles):
            prefix = "" if len(profiles) == 1 else "%d " % (n + 1)
            if not isinstance(profile, dict) or len(profile) != 1:
                fail("invalid-parameter", "Each profile is {rectangle: {...}} or {circle: {...}}.", parameter="profiles")
            kind, spec = next(iter(profile.items()))
            if kind == "rectangle":
                x, y = num(spec, "x", 0), num(spec, "y", 0)
                w, h = num(spec, "width", positive=True), num(spec, "height", positive=True)
                corners = [V(x, y, 0), V(x + w, y, 0), V(x + w, y + h, 0), V(x, y + h, 0)]
                first = sketch.GeometryCount
                for i in range(4):
                    sketch.addGeometry(Part.LineSegment(corners[i], corners[(i + 1) % 4]), False)
                C = Sketcher.Constraint
                for i in range(4):
                    sketch.addConstraint(C("Coincident", first + i, 2, first + (i + 1) % 4, 1))
                sketch.addConstraint(C("Horizontal", first))
                sketch.addConstraint(C("Horizontal", first + 2))
                sketch.addConstraint(C("Vertical", first + 1))
                sketch.addConstraint(C("Vertical", first + 3))
                for name, constraint in (("%sWidth" % prefix, C("DistanceX", first, 1, first, 2, w)), ("%sHeight" % prefix, C("DistanceY", first + 1, 1, first + 1, 2, h)),
                                         ("%sX" % prefix, C("DistanceX", -1, 1, first, 1, x)), ("%sY" % prefix, C("DistanceY", -1, 1, first, 1, y))):
                    index = sketch.addConstraint(constraint)
                    sketch.renameConstraint(index, name.strip())
            elif kind == "circle":
                x, y, d = num(spec, "x", 0), num(spec, "y", 0), num(spec, "diameter", positive=True)
                g = sketch.addGeometry(Part.Circle(V(x, y, 0), V(0, 0, 1), d / 2), False)
                C = Sketcher.Constraint
                for name, constraint in (("%sDiameter" % prefix, C("Diameter", g, d)), ("%sX" % prefix, C("DistanceX", -1, 1, g, 3, x)), ("%sY" % prefix, C("DistanceY", -1, 1, g, 3, y))):
                    index = sketch.addConstraint(constraint)
                    sketch.renameConstraint(index, name.strip())
            else:
                fail("invalid-parameter", "Unknown profile %r (rectangle or circle)." % kind, parameter="profiles")
        tag(sketch, "sketch")
        doc.fc.recompute()
        if sketch.solve() != 0:
            fail("regeneration-failed", "The sketch's constraints cannot be solved.")
        return {"created": sketch.Name, "constraints": [c.Name for c in sketch.Constraints if c.Name]}

    return mutate(doc, args, "Add sketch %s on %s" % (label, plane), change)


def extrusion(doc, sketch, length, reverse, name, label):
    ext = doc.fc.addObject("Part::Extrusion", name)
    ext.Label = label
    ext.Base = sketch
    ext.DirMode = "Normal"
    ext.Solid = True
    ext.LengthFwd = mm(length)
    ext.Reversed = bool(reverse)
    sketch.Visibility = False
    return ext


def op_pad(args):
    doc = get_doc(args)
    sketch = find(doc, args.get("sketch"), "sketch")
    if sketch.TypeId != "Sketcher::SketchObject":
        fail("invalid-parameter", "%s is not a sketch." % sketch.Label, parameter="sketch")
    length = num(args, "length", positive=True)
    label = clean_label(args.get("name"), "Pad")

    def change():
        ext = extrusion(doc, sketch, length, args.get("reversed") is True, clean_name(args.get("name"), "Pad"), label)
        tag(ext, "pad", AionColor=("App::PropertyString", color_arg(args)))
        return {"created": ext.Name}

    return mutate(doc, args, "Pad %s by %g mm" % (sketch.Label, length), change)


def op_pocket(args):
    doc = get_doc(args)
    sketch = find(doc, args.get("sketch"), "sketch")
    target = surface_of(doc, find(doc, args.get("target"), "target"))
    if sketch.TypeId != "Sketcher::SketchObject":
        fail("invalid-parameter", "%s is not a sketch." % sketch.Label, parameter="sketch")
    if target not in top_objects(doc):
        fail("invalid-parameter", "%s is not a visible solid of the model." % target.Label, parameter="target")
    through = args.get("through") is True
    depth = target.Shape.BoundBox.DiagonalLength * 2 if through else num(args, "depth", positive=True)

    def change():
        ext = extrusion(doc, sketch, depth, args.get("reversed", True) is not False, clean_name(sketch.Name + "_Pocket", "Pocket"), "%s pocket" % sketch.Label)
        tag(ext, "pocket-tool", AionColor=("App::PropertyString", "#b9915e"))
        ext.Visibility = False
        cut = doc.fc.addObject("Part::Cut", clean_name(target.Name + "_Pocketed", "Pocketed"))
        cut.Base, cut.Tool = target, ext
        take_label(cut, target, "pocket")
        tag(cut, "pocketed", AionColor=("App::PropertyString", getattr(target, "AionColor", "#9aa4ae")))
        target.Visibility = False
        doc.fc.recompute()
        if target.Shape.common(ext.Shape).Volume <= 1e-6:
            fail("invalid-parameter", "The pocket from %s does not reach %s: nothing would be removed (check the sketch's plane, offset and direction)." % (sketch.Label, target.Label), parameter="sketch")
        return {"created": [ext.Name, cut.Name], "result": cut.Name}

    return mutate(doc, args, "Pocket %s into %s" % (sketch.Label, target.Label), change)


def op_set_constraint(args):
    doc = get_doc(args)
    sketch = find(doc, args.get("sketch"), "sketch")
    name = args.get("constraint")
    value = num(args, "value")
    if sketch.TypeId != "Sketcher::SketchObject":
        fail("invalid-parameter", "%s is not a sketch." % sketch.Label, parameter="sketch")

    def change():
        for i, c in enumerate(sketch.Constraints):
            if c.Name and isinstance(name, str) and c.Name.lower() == name.strip().lower():
                set_constraint_value(sketch, i, c, value)
                return {}
        fail("invalid-parameter", "%s has no constraint %r (named: %s)." % (sketch.Label, name, ", ".join(c.Name for c in sketch.Constraints if c.Name) or "none"), parameter="constraint")

    return mutate(doc, args, "Set %s.%s = %g" % (sketch.Label, name, value), change)


# ── Booleans, fillets, chamfers ───────────────────────────────────────────────────────────────────────────────────
def op_boolean(args):
    doc = get_doc(args)
    operation = args.get("operation")
    types = {"union": "Part::Fuse", "subtract": "Part::Cut", "intersect": "Part::Common"}
    if operation not in types:
        fail("invalid-parameter", "operation must be union, subtract or intersect.", parameter="operation")
    base, tool = surface_of(doc, find(doc, args.get("base"), "base")), surface_of(doc, find(doc, args.get("tool"), "tool"))
    tops = top_objects(doc)
    if base not in tops or tool not in tops or base == tool:
        fail("invalid-parameter", "base and tool must be two different visible solids of the model.", parameter="tool")
    label = clean_label(args.get("name"), "%s %s %s" % (base.Label, {"union": "+", "subtract": "−", "intersect": "∩"}[operation], tool.Label))

    def change():
        obj = doc.fc.addObject(types[operation], clean_name(args.get("name"), operation.capitalize()))
        obj.Base, obj.Tool = base, tool
        obj.Label = label
        tag(obj, "boolean", AionColor=("App::PropertyString", getattr(base, "AionColor", "#9aa4ae")))
        base.Visibility = False
        tool.Visibility = False
        doc.fc.recompute()
        if obj.Shape.isNull() or not obj.Shape.Solids:
            fail("regeneration-failed", "The %s of %s and %s has no solid." % (operation, base.Label, tool.Label))
        return {"created": obj.Name}

    return mutate(doc, args, "%s %s and %s" % (operation.capitalize(), base.Label, tool.Label), change)


def op_edge_feature(args, kind):
    doc = get_doc(args)
    target = surface_of(doc, find(doc, args.get("target"), "target"))
    if target not in top_objects(doc):
        fail("invalid-parameter", "%s is not a visible solid of the model." % target.Label, parameter="target")
    size = num(args, "radius" if kind == "fillet" else "size", positive=True)
    rule = args.get("edges", "vertical")
    if rule not in ("all", "vertical", "top", "bottom"):
        fail("invalid-parameter", "edges must be all, vertical, top or bottom.", parameter="edges")

    def change():
        obj = doc.fc.addObject("Part::Fillet" if kind == "fillet" else "Part::Chamfer", unique_name(doc, "Fillet" if kind == "fillet" else "Chamfer"))
        obj.Base = target
        take_label(obj, target, "%ss" % kind)
        tag(obj, kind, AionEdges=("App::PropertyString", rule), AionSize=("App::PropertyDistance", mm(size)),
            AionColor=("App::PropertyString", getattr(target, "AionColor", "#9aa4ae")))
        apply_selector(obj)
        target.Visibility = False
        return {"created": obj.Name}

    return mutate(doc, args, "%s %s edges of %s (%g mm)" % ("Round" if kind == "fillet" else "Chamfer", rule, target.Label, size), change)


# ── Transform, visibility, appearance, delete ─────────────────────────────────────────────────────────────────────
def op_transform(args):
    doc = get_doc(args)
    obj = find(doc, args.get("component"))
    if role(obj) == "hole":
        fail("invalid-parameter", "A hole is placed by its insets: set_parameter Inset X / Inset Y (millimetres from its anchor edges).", parameter="component")
    if role(obj) in ("drilled", "pocketed", "boolean") or obj.TypeId in ("Part::Fillet", "Part::Chamfer"):
        obj = body_of(obj) if role(obj) != "boolean" else obj
    if not hasattr(obj, "Placement"):
        fail("invalid-parameter", "%s cannot be moved." % obj.Label, parameter="component")

    def change():
        p = obj.Placement
        if "to" in args:
            p = App.Placement(vec(args["to"], "to"), p.Rotation)
        if "move" in args:
            p = App.Placement(p.Base + vec(args["move"], "move"), p.Rotation)
        if "rotate" in args:
            rot = args["rotate"]
            if not isinstance(rot, dict):
                fail("invalid-parameter", "rotate must be {axis: [x, y, z], angle: degrees}.", parameter="rotate")
            axis = vec(rot.get("axis", [0, 0, 1]), "rotate.axis")
            r = App.Rotation(axis, num(rot, "angle"))
            center = obj.Shape.BoundBox.Center if hasattr(obj, "Shape") else p.Base
            p = App.Placement(App.Vector(0, 0, 0), r, center).multiply(p)
        if "to" not in args and "move" not in args and "rotate" not in args:
            fail("invalid-parameter", "Give move [dx, dy, dz], to [x, y, z] and/or rotate {axis, angle}.", parameter="move")
        obj.Placement = p
        return {}

    return mutate(doc, args, "Move %s" % obj.Label, change)


def op_set_parameter(args):
    doc = get_doc(args)
    obj = find(doc, args.get("component"))
    name = args.get("parameter")
    if not isinstance(name, str) or not name.strip():
        fail("invalid-parameter", "parameter is required (inspect the component for its parameters).", parameter="parameter")
    if role(obj) in ("drilled", "pocketed") and name.strip().lower() not in ("x", "y", "z"):
        obj = body_of(obj)
    current = dict(parameters(obj)).get(next((k for k in parameters(obj) if k.lower() == name.strip().lower()), name), (None, ""))[0]
    if role(obj) == "hole" and name.strip().lower() == "inset":
        if "delta" in args:
            # Each inset moves by the delta (they may differ).
            dx = num(args, "delta")
            new_x, new_y = q(obj.InsetX) + dx, q(obj.InsetY) + dx

            def change_both():
                obj.InsetX, obj.InsetY = mm(new_x), mm(new_y)
                place_hole(doc, obj)
                return {"changed": obj.Name, "parameter": "Inset", "to": [new_x, new_y]}
            return mutate(doc, args, "%s insets %+g mm (to %g, %g)" % (obj.Label, dx, new_x, new_y), change_both)
        current = q(obj.InsetX)
    if "delta" in args:
        if not isinstance(current, (int, float)):
            fail("invalid-parameter", "%s of %s is not a number; give value." % (name, obj.Label), parameter=name)
        value = current + num(args, "delta")
    else:
        value = num(args, "value")

    def change():
        set_param(doc, obj, name, value)
        return {"changed": obj.Name, "parameter": name, "from": current, "to": value}

    return mutate(doc, args, "%s %s: %s → %g" % (obj.Label, name, "?" if current is None else ("%g" % current if isinstance(current, float) else current), value), change)


def op_set_visibility(args):
    doc = get_doc(args)
    obj = find(doc, args.get("component"))
    visible = args.get("visible")
    if not isinstance(visible, bool):
        fail("invalid-parameter", "visible must be true or false.", parameter="visible")

    def change():
        obj.AionHidden = not visible if hasattr(obj, "AionHidden") else tag_hidden(obj, not visible)
        return {}

    return mutate(doc, args, "%s %s" % ("Show" if visible else "Hide", obj.Label), change)


def tag_hidden(obj, hidden):
    obj.addProperty("App::PropertyBool", "AionHidden", "Aion")
    return hidden


def op_set_appearance(args):
    doc = get_doc(args)
    obj = find(doc, args.get("component"))

    def change():
        if "color" in args:
            if not hasattr(obj, "AionColor"):
                obj.addProperty("App::PropertyString", "AionColor", "Aion")
            obj.AionColor = color_arg(args)
        if "material" in args:
            material = clean_label(args.get("material"), "")
            if not material:
                fail("invalid-parameter", "material is a short name (e.g. aluminium 6061).", parameter="material")
            if not hasattr(obj, "AionMaterial"):
                obj.addProperty("App::PropertyString", "AionMaterial", "Aion")
            obj.AionMaterial = material
        if "color" not in args and "material" not in args:
            fail("invalid-parameter", "Give color (#rrggbb) and/or material.", parameter="color")
        return {}

    return mutate(doc, args, "Appearance of %s" % obj.Label, change)


def op_delete(args):
    doc = get_doc(args)
    obj = find(doc, args.get("component"))

    removed = obj.Name

    def change():
        r = role(obj)
        if r == "hole":
            for tools in [o for o in obj.InList if role(o) == "tools"]:
                links = [l for l in tools.Links if l != obj]
                if links:
                    tools.Links = links
                else:
                    for cut in [o for o in tools.InList if role(o) == "drilled"]:
                        unwrap(doc, cut, cut.Base)
                    doc.fc.removeObject(tools.Name)
            doc.fc.removeObject(obj.Name)
            return {"removed": removed}
        if obj.TypeId in ("Part::Fillet", "Part::Chamfer") or r in ("drilled", "pocketed", "boolean"):
            base = obj.Base
            extra = [] if r != "pocketed" else [obj.Tool]
            if r == "drilled":
                extra = [obj.Tool] + list(obj.Tool.Links)
            if r == "boolean":
                obj.Tool.Visibility = True
            unwrap(doc, obj, base)
            for o in extra:
                doc.fc.removeObject(o.Name)
            return {"removed": removed}
        consumers = [o.Label for o in obj.InList if hasattr(o, "Shape")]
        if consumers:
            fail("invalid-parameter", "%s is used by %s; delete that first." % (obj.Label, ", ".join(consumers)), parameter="component")
        doc.fc.removeObject(obj.Name)
        return {"removed": removed}

    return mutate(doc, args, "Delete %s" % obj.Label, change)


def unwrap(doc, feature, base):
    """Removes a feature that wraps `base`: whatever used the feature uses the base again."""
    for user in list(feature.InList):
        for prop in ("Base", "Tool"):
            if getattr(user, prop, None) == feature:
                setattr(user, prop, base)
        if hasattr(user, "Links") and feature in user.Links:
            user.Links = [base if l == feature else l for l in user.Links]
    base.Visibility = True
    label = feature.Label
    doc.fc.removeObject(feature.Name)
    if base.Label.startswith(label + " "):
        base.Label = label


# ── History ───────────────────────────────────────────────────────────────────────────────────────────────────────
def op_undo(args, redo=False):
    doc = get_doc(args)
    with locked(doc.id):
        check_writable(doc)
        base = args.get("revision")
        if base is not None and base != doc.revision:
            fail("stale-revision", "The document is at revision %d, not %s." % (doc.revision, base), current=doc.revision)
        stack = doc.meta["redo" if redo else "undo"]
        if not stack:
            fail("nothing-to-%s" % ("redo" if redo else "undo"), "There is nothing to %s." % ("redo" if redo else "undo"))
        step = stack[-1]
        current = doc.revision
        meta = doc.meta
        restored = load_doc(doc.id, meta, step["to"])
        found = problems(restored)
        if found:
            load_doc(doc.id, meta, current)
            fail("regeneration-failed", "The saved state could not be restored (%s); nothing changed." % "; ".join(found[:3]))
        stack.pop()
        other = meta["undo" if redo else "redo"]
        other.append({"to": current, "change": step["change"]})
        del other[:-UNDO_DEPTH]
        advance(restored, "%s: %s" % ("Redo" if redo else "Undo", step["change"]), undo=False)
        return {"reapplied" if redo else "reverted": step["change"], "restored_revision": step["to"]}


# ── Lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────────────
def op_status(args):
    v = App.Version()
    known = sorted((v_ for v_ in load_registry()["documents"].items() if not v_[1].get("closed")), key=lambda item: -item[1].get("updated", 0))[:8]
    return {"freecad": "%s.%s.%s" % (v[0], v[1], v[2]), "build": v[3] if len(v) > 3 else "", "python": sys.version.split()[0], "sketcher": HAVE_SKETCHER,
            "documents": [{"id": k, "name": m.get("name"), "revision": m.get("revision"), "path": m.get("path"), "saved": m.get("saved_revision") == m.get("revision")} for k, m in known]}


def new_meta(name, path=None):
    return {"name": name, "revision": 1, "history": [{"revision": 1, "description": "Opened" if path else "Created"}], "undo": [], "redo": [],
            "path": path, "saved_revision": 1 if path else None, "saved_mtime": os.path.getmtime(path) if path else None, "handed_off": False}


def op_create(args):
    label = clean_label(args.get("name"), "Aion Model")
    fc = App.newDocument(clean_name(label, "AionModel"))
    fc.Label = label
    fc.UndoMode = 1
    doc = Doc(new_id(), fc, new_meta(label))
    DOCS[doc.id] = doc
    record(doc)
    return {"document": doc.id}


def op_open(args):
    path = args.get("path")
    if not isinstance(path, str) or not os.path.isabs(path) or not path.lower().endswith(".fcstd"):
        fail("invalid-parameter", "path must be an absolute path to a .FCStd file.", parameter="path")
    if not os.path.isfile(path):
        fail("missing-document", "No file at %s." % path)
    data = load_registry()
    for ident, meta in data["documents"].items():
        if not meta.get("closed") and meta.get("path") and os.path.realpath(meta["path"]) == os.path.realpath(path):
            data["last"] = ident
            save_registry(data)
            return {"document": ident, "already": True}
    try:
        fc = App.openDocument(path)
    except Exception as error:  # noqa: BLE001
        fail("open-failed", "FreeCAD could not open %s: %s" % (os.path.basename(path), error))
    fc.UndoMode = 1
    fc.recompute()
    doc = Doc(new_id(), fc, new_meta(fc.Label or os.path.basename(path)[:-6], path))
    DOCS[doc.id] = doc
    record(doc)
    found = problems(doc)
    return {"document": doc.id, **({"warnings": found[:6]} if found else {})}


def op_reload(args):
    doc = get_doc(args)
    if not doc.path:
        fail("not-saved", "The document has never been saved, so there is nothing to reload.")
    if not os.path.isfile(doc.path):
        fail("missing-document", "%s no longer exists." % doc.path)
    with locked(doc.id):
        try:
            App.closeDocument(doc.fc.Name)
        except Exception:  # noqa: BLE001
            pass
        doc.fc = App.openDocument(doc.path)
        doc.fc.UndoMode = 1
        doc.fc.recompute()
        doc.meta["handed_off"] = False
        advance(doc, "Reloaded from %s" % os.path.basename(doc.path))
        doc.meta["saved_revision"] = doc.revision
        doc.meta["saved_mtime"] = os.path.getmtime(doc.path)
        record(doc, snapshot=False)
    return {"reloaded": doc.path}


def op_save(args):
    doc = get_doc(args)
    path = args.get("path") or doc.path
    if not isinstance(path, str) or not os.path.isabs(path) or not path.lower().endswith(".fcstd"):
        fail("invalid-parameter", "path must be an absolute path ending in .FCStd (the document has no file yet).", parameter="path")
    if doc.handed_off:
        fail("handed-off", "The document is open in the FreeCAD application; save it there.")
    own = doc.path and os.path.realpath(path) == os.path.realpath(doc.path)
    if os.path.exists(path) and not own and args.get("overwrite") is not True:
        fail("file-exists", "%s already exists and is not this document's file; choose another path (or overwrite: true if the user said so)." % path)
    if own:
        check_writable(doc)
    folder = os.path.dirname(path)
    if not os.path.isdir(folder):
        os.makedirs(folder, exist_ok=True)
    with locked(doc.id):
        doc.fc.saveAs(path)
        doc.meta["path"] = path
        doc.meta["saved_revision"] = doc.revision
        doc.meta["saved_mtime"] = os.path.getmtime(path)
        record(doc, snapshot=False)
    return {"saved": path, "bytes": os.path.getsize(path)}


def op_export(args):
    doc = get_doc(args)
    path = args.get("path")
    fmt = args.get("format")
    if fmt not in ("step", "stl"):
        fail("invalid-parameter", "format must be step or stl.", parameter="format")
    ext = (".step", ".stp") if fmt == "step" else (".stl",)
    if not isinstance(path, str) or not os.path.isabs(path) or not path.lower().endswith(ext):
        fail("invalid-parameter", "path must be an absolute %s path." % "/".join(ext), parameter="path")
    if os.path.exists(path) and args.get("overwrite") is not True:
        fail("file-exists", "%s already exists; choose another path (or overwrite: true if the user said so)." % path)
    objects = [o for o in top_objects(doc) if not getattr(o, "AionHidden", False)]
    if not objects:
        fail("regeneration-failed", "Nothing visible to export.")
    if fmt == "step":
        Part.Compound([o.Shape for o in objects]).exportStep(path)
    else:
        import Mesh  # noqa: PLC0415
        mesh = Mesh.Mesh()
        for o in objects:
            mesh.addMesh(Mesh.Mesh(o.Shape.tessellate(0.05)))
        mesh.write(path)
    return {"exported": path, "bytes": os.path.getsize(path)}


def op_handoff(args):
    doc = get_doc(args)
    if not doc.path:
        fail("not-saved", "Save the document first (it needs a .FCStd file to open in FreeCAD).")
    if doc.dirty:
        op_save({"document": doc.id})
    doc.meta["handed_off"] = True
    record(doc, snapshot=False)
    return {"path": doc.path}


def op_close(args):
    doc = get_doc(args)
    if doc.dirty and args.get("discard") is not True:
        fail("unsaved-changes", "%s has unsaved changes: save it first, or close with discard: true if the user said to." % doc.fc.Label)
    try:
        App.closeDocument(doc.fc.Name)
    except Exception:  # noqa: BLE001
        pass
    DOCS.pop(doc.id, None)
    data = load_registry()
    if doc.id in data["documents"]:
        data["documents"][doc.id]["closed"] = True
    if data["last"] == doc.id:
        data["last"] = None
    save_registry(data)
    return {"closed": doc.id}


# ── Reports and the preview ───────────────────────────────────────────────────────────────────────────────────────
def summary(doc):
    return {"id": doc.id, "name": doc.fc.Label, "revision": doc.revision, "path": doc.path, "saved": not doc.dirty, "handed_off": doc.handed_off}


def describe(obj):
    params = {k: (round(v, 4) if isinstance(v, float) else v) if not u else ("%g %s" % (v, u) if isinstance(v, float) else v) for k, (v, u) in parameters(obj).items()}
    entry = {"id": obj.Name, "label": obj.Label, "type": obj.TypeId.split("::")[-1], "role": role(obj) or "feature", "parameters": params}
    if getattr(obj, "AionMaterial", ""):
        entry["material"] = obj.AionMaterial
    if getattr(obj, "AionHidden", False):
        entry["hidden"] = True
    if role(obj) == "hole":
        entry["body"] = obj.AionBody
    if hasattr(obj, "Base") and getattr(obj, "Base", None) is not None and hasattr(obj.Base, "Name"):
        entry["base"] = obj.Base.Name
    if hasattr(obj, "Tool") and getattr(obj, "Tool", None) is not None and hasattr(obj.Tool, "Name"):
        entry["tool"] = obj.Tool.Name
    return entry


def report(doc, detail=True):
    out = summary(doc)
    tops = top_objects(doc)
    if detail:
        out["components"] = [describe(o) for o in doc.fc.Objects if role(o) != "tools"][:MAX_OBJECTS]
        out["history"] = doc.history[-12:]
        out["undo"] = [u["change"] for u in reversed(doc.meta["undo"])][:5]
        out["redo"] = [r["change"] for r in reversed(doc.meta["redo"])][:5]
    solids = []
    for o in tops:
        try:
            bb = o.Shape.BoundBox
            solids.append({"id": o.Name, "label": o.Label, "volume_mm3": round(o.Shape.Volume, 3), "valid": o.Shape.isValid(),
                           "size_mm": [round(bb.XLength, 4), round(bb.YLength, 4), round(bb.ZLength, 4)], **({"hidden": True} if getattr(o, "AionHidden", False) else {})})
        except Exception:  # noqa: BLE001
            solids.append({"id": o.Name, "label": o.Label, "valid": False})
    out["solids"] = solids
    return out


def leaves(obj, tools, bodies, modifiers, depth=0):
    if depth > 64 or obj is None:
        return
    r = role(obj)
    if r in ("drilled",):
        leaves(obj.Base, tools, bodies, modifiers, depth + 1)
        for hole in obj.Tool.Links:
            tools.append(hole)
    elif r == "pocketed":
        leaves(obj.Base, tools, bodies, modifiers, depth + 1)
        tools.append(obj.Tool)
    elif obj.TypeId in ("Part::Fuse", "Part::Common"):
        leaves(obj.Base, tools, bodies, modifiers, depth + 1)
        leaves(obj.Tool, tools, bodies, modifiers, depth + 1)
    elif obj.TypeId == "Part::Cut":
        leaves(obj.Base, tools, bodies, modifiers, depth + 1)
        tools.append(obj.Tool)
    elif obj.TypeId in ("Part::Fillet", "Part::Chamfer"):
        modifiers.append(obj)
        leaves(obj.Base, tools, bodies, modifiers, depth + 1)
    else:
        bodies.append(obj)


def pack(values, fmt):
    return base64.b64encode(struct.pack("<%d%s" % (len(values), fmt), *values)).decode("ascii")


def preview(doc):
    """Per visible solid: its faces, each tessellated and assigned to the feature that made it (by geometry)."""
    nodes = []
    triangles = 0
    for top in top_objects(doc):
        if getattr(top, "AionHidden", False):
            continue
        shape = top.Shape
        if shape.isNull() or not shape.Faces:
            continue
        diag = shape.BoundBox.DiagonalLength or 1.0
        deflection = max(0.005, diag * 0.0008)
        tools, bodies, modifiers = [], [], []
        leaves(top, tools, bodies, modifiers)
        surfaces = {}

        def surface(o):
            if o.Name not in surfaces:
                surfaces[o.Name] = Part.Compound(o.Shape.Faces)
            return surfaces[o.Name]
        tol = max(1e-5, diag * 1e-6)
        groups = {}
        for face in shape.Faces:
            pts, tris = face.tessellate(deflection)
            if not tris:
                continue
            a, b, c = (pts[i] for i in tris[0])
            centroid = (a + b + c) * (1.0 / 3)
            try:
                u, v = face.Surface.parameter(centroid)
                probe = Part.Vertex(face.Surface.value(u, v))
            except Exception:  # noqa: BLE001
                probe = Part.Vertex(centroid)
            owner = None
            for t in reversed(tools):
                if surface(t).distToShape(probe)[0] < tol:
                    owner = t
                    break
            if owner is None:
                for o in bodies:
                    if surface(o).distToShape(probe)[0] < tol:
                        owner = o
                        break
            if owner is None:
                owner = modifiers[0] if modifiers else top
            # Triangles face outward (the face's own normal), whatever the face's orientation.
            normal = (b - a).cross(c - a)
            try:
                outward = face.normalAt(u, v)
                flip = normal.dot(outward) < 0
            except Exception:  # noqa: BLE001
                flip = False
            group = groups.setdefault(owner.Name, {"obj": owner, "positions": [], "indices": []})
            offset = len(group["positions"]) // 3
            for p in pts:
                group["positions"].extend((p.x, p.y, p.z))
            for t in tris:
                if flip:
                    group["indices"].extend((t[0] + offset, t[2] + offset, t[1] + offset))
                else:
                    group["indices"].extend((t[0] + offset, t[1] + offset, t[2] + offset))
            triangles += len(tris)
            if triangles > MAX_TRIANGLES:
                fail("too-large", "The preview would exceed %d triangles." % MAX_TRIANGLES)
        bb = shape.BoundBox
        children = []
        for name, group in groups.items():
            obj = group["obj"]
            children.append({"id": obj.Name, "label": obj.Label, "role": role(obj) or "feature", "type": obj.TypeId.split("::")[-1],
                             "color": getattr(obj, "AionColor", "") or getattr(top, "AionColor", "") or "#9aa4ae",
                             "metadata": metadata(obj), "positions": pack(group["positions"], "f"), "indices": pack(group["indices"], "I"),
                             "triangles": len(group["indices"]) // 3})
        nodes.append({"id": top.Name, "label": top.Label, "role": role(top) or "feature", "type": top.TypeId.split("::")[-1],
                      "metadata": {**metadata(top), "Volume": "%.6g mm³" % shape.Volume, "Valid geometry": shape.isValid(),
                                   "Bounding size": "%g × %g × %g mm" % (round(bb.XLength, 3), round(bb.YLength, 3), round(bb.ZLength, 3))},
                      "children": children})
    return {"nodes": nodes, "triangles": triangles}


def metadata(obj):
    out = {"Feature": obj.TypeId.split("::")[-1], "Object id": obj.Name}
    for k, (v, u) in parameters(obj).items():
        out[k] = ("%g %s" % (v, u)) if isinstance(v, float) and u else v
    if getattr(obj, "AionMaterial", ""):
        out["Material"] = obj.AionMaterial
    return dict(list(out.items())[:20])


# ── Dispatch ──────────────────────────────────────────────────────────────────────────────────────────────────────
OPS = {
    "status": op_status, "create_document": op_create, "open_document": op_open, "reload": op_reload,
    "inspect": lambda a: {}, "add_primitive": op_add_primitive, "add_holes": op_add_holes,
    "add_sketch": op_add_sketch, "pad": op_pad, "pocket": op_pocket, "set_constraint": op_set_constraint,
    "boolean": op_boolean, "fillet": lambda a: op_edge_feature(a, "fillet"), "chamfer": lambda a: op_edge_feature(a, "chamfer"),
    "set_parameter": op_set_parameter, "transform": op_transform, "set_visibility": op_set_visibility, "set_appearance": op_set_appearance,
    "delete": op_delete, "undo": lambda a: op_undo(a), "redo": lambda a: op_undo(a, True),
    "save": op_save, "export": op_export, "handoff": op_handoff, "close": op_close,
}
# What changes the geometry (the response carries a new preview).
GEOMETRY = {"create_document", "open_document", "reload", "add_primitive", "add_holes", "add_sketch", "pad", "pocket", "set_constraint", "boolean", "fillet",
            "chamfer", "set_parameter", "transform", "set_visibility", "set_appearance", "delete", "undo", "redo"}


def handle(request):
    op = request.get("op")
    args = request.get("args") or {}
    if op not in OPS:
        fail("unsupported", "Unknown operation %r." % op)
    if not isinstance(args, dict):
        fail("invalid-parameter", "args must be an object.")
    started = time.perf_counter()
    result = OPS[op](args) or {}
    computed = time.perf_counter()
    out = {"result": result}
    doc_id = result.get("document") or args.get("document") or load_registry()["last"]
    doc = DOCS.get(doc_id) if doc_id else None
    if doc is None and doc_id and op not in ("close", "status"):
        doc = get_doc({"document": doc_id}, required=False)
    if doc is not None and op != "close":
        out["document"] = report(doc, detail=op in ("inspect", "open_document", "reload") or request.get("detail") is True)
        if op in GEOMETRY or request.get("preview") is True:
            out["preview"] = preview(doc)
    out["timing_ms"] = {"freecad": round((computed - started) * 1000, 1), "tessellation": round((time.perf_counter() - computed) * 1000, 1)}
    return out


def main():
    OUT.write(json.dumps({"ready": True, "protocol": PROTOCOL, **op_status({})}) + "\n")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        ident = None
        try:
            request = json.loads(line)
            ident = request.get("id")
            response = {"id": ident, "ok": True, **handle(request)}
        except CadError as error:
            response = {"id": ident, "ok": False, "error": {"code": error.code, "message": error.message, **error.extra}}
        except Exception as error:  # noqa: BLE001
            response = {"id": ident, "ok": False, "error": {"code": "backend-error", "message": "%s: %s" % (type(error).__name__, error), "trace": traceback.format_exc()[-800:]}}
        OUT.write(json.dumps(response) + "\n")


main()
