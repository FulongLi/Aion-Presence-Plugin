import type { FileChange, Presentation } from "../core/presentation";
import { decodeHeightField } from "../visual/heightfield";
import { reliefPixels } from "../visual/relief";

/**
 * A card: information Aion presents beside its body when exactness or recognizability matters (the CARD and
 * HYBRID routes). Quiet typography, generous space, no dashboard chrome. Everything is built with textContent
 * (never parsed as HTML); pictures are shown through <img> from blobs the transport fetched, at their original
 * resolution (never the particle raster), so no presented content can run in the page.
 */
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const CHANGE_LABEL: Record<FileChange["change"], string> = { added: "added", modified: "modified", deleted: "deleted", renamed: "renamed" };

/** `wide`: the card carries a picture or code and takes more room. `images`: object URLs to release later. */
export interface CardContent { root: HTMLElement; wide: boolean; images: string[] }

export interface CardSources {
  /** The bytes of a presented medium, by id. */
  media(id: string): Promise<Blob>;
}

const formatMetres = (value: number) => `${Math.round(value).toLocaleString("en")} m`;

/** Builds the card for a presentation. */
export async function buildCard(presentation: Presentation, sources: CardSources): Promise<CardContent> {
  const root = el("div", "card-body");
  const images: string[] = [];
  let wide = false;
  const picture = (url: string, alt: string, className = "picture") => {
    images.push(url);
    const img = el("img", className);
    img.alt = alt;
    img.decoding = "async";
    img.src = url;
    return img;
  };
  const caption = (...parts: (string | undefined)[]) => {
    const text = parts.filter(Boolean).join(" · ");
    return text ? el("p", "caption", text) : null;
  };
  switch (presentation.kind) {
    case "result": {
      root.append(el("h2", undefined, presentation.title));
      const summary = el("p", "summary");
      if (presentation.status !== "info") {
        const mark = el("span", `mark ${presentation.status}`);
        mark.setAttribute("aria-label", presentation.status);
        summary.append(mark);
      }
      summary.append(presentation.summary);
      root.append(summary);
      if (presentation.details.length) {
        const list = el("ul");
        for (const detail of presentation.details) list.append(el("li", undefined, detail));
        root.append(list);
      }
      break;
    }
    case "text":
      if (presentation.title) root.append(el("h2", undefined, presentation.title));
      root.append(el("p", presentation.title ? "prose" : "summary", presentation.text));
      break;
    case "number":
      root.append(el("p", "figure-value", presentation.value));
      break;
    case "clock":
      root.append(el("p", "figure-value", presentation.time));
      break;
    case "image": {
      // The original, validated picture: a recognizable face, an artwork, a screenshot's exact text.
      wide = true;
      const url = URL.createObjectURL(await sources.media(presentation.media.id));
      root.append(picture(url, presentation.alt ?? ""));
      const line = caption(presentation.alt, presentation.credit);
      if (line) root.append(line);
      break;
    }
    case "terrain": {
      // The exact map beside the relief the body formed: the same real elevation, shaded, with its range.
      wide = true;
      const field = decodeHeightField(new Uint8Array(await (await sources.media(presentation.media.id)).arrayBuffer()));
      const relief = reliefPixels(field, Math.max(2, Math.min(4, Math.ceil(720 / field.width))));
      const canvas = document.createElement("canvas");
      canvas.width = relief.width; canvas.height = relief.height;
      canvas.getContext("2d")!.putImageData(new ImageData(relief.data, relief.width, relief.height), 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("relief-failed")), "image/png"));
      root.append(el("h2", undefined, presentation.label));
      root.append(picture(URL.createObjectURL(blob), `Shaded relief of ${presentation.label}`, "picture relief"));
      const range = presentation.elevation ?? field.elevation;
      const line = caption(range ? `Elevation ${formatMetres(range.min)} – ${formatMetres(range.max)}` : undefined, presentation.credit);
      if (line) root.append(line);
      break;
    }
    case "artifact": {
      root.append(el("h2", undefined, presentation.title));
      if (presentation.type === "code" && presentation.content) {
        wide = true;
        root.append(el("pre", undefined, presentation.content));
        if (presentation.language) root.append(el("div", "lang", presentation.language));
      } else if (presentation.type === "text" && presentation.content) {
        root.append(el("p", "prose", presentation.content));
      } else if (presentation.type === "list" && presentation.items) {
        const list = el("ul");
        for (const item of presentation.items) list.append(el("li", undefined, item));
        root.append(list);
      } else if (presentation.type === "changes" && presentation.changes) {
        const table = el("table");
        for (const change of presentation.changes) {
          const row = el("tr");
          row.append(el("td", "kind", CHANGE_LABEL[change.change]), el("td", "path", change.path));
          const delta = el("td", "delta");
          if (change.additions !== undefined) delta.append(el("span", "add", `+${change.additions}`));
          if (change.deletions !== undefined) delta.append(" ", el("span", "del", `−${change.deletions}`));
          row.append(delta);
          table.append(row);
        }
        root.append(table);
      } else if ((presentation.type === "svg" || presentation.type === "image") && presentation.media) {
        wide = true;
        root.append(picture(URL.createObjectURL(await sources.media(presentation.media.id)), presentation.title));
      }
      break;
    }
    case "form": case "symbol": case "emoji":
      break;
  }
  return { root, wide, images };
}
