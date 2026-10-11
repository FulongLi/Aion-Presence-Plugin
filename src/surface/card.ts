import type { FileChange, Presentation } from "../core/presentation";
import { decodeHeightField } from "../visual/heightfield";
import { reliefPixels } from "../visual/relief";
import { decodeMap, frameBounds } from "../visual/geo/map";
import { geoToNormal } from "../visual/geo/projection";

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
    case "text": {
      if (presentation.title) root.append(el("h2", undefined, presentation.title));
      // A short line without a heading (an equation, a key phrase) is set large; an emphasised term is marked.
      const short = !presentation.title && !presentation.text.includes("\n") && Array.from(presentation.text).length <= 40;
      const paragraph = el("p", presentation.title ? "prose" : short ? "statement" : "summary");
      const at = presentation.emphasis ? presentation.text.indexOf(presentation.emphasis) : -1;
      if (at >= 0) {
        paragraph.append(presentation.text.slice(0, at), el("mark", "emphasis", presentation.emphasis), presentation.text.slice(at + presentation.emphasis!.length));
      } else paragraph.textContent = presentation.text;
      root.append(paragraph);
      break;
    }
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
    case "map": {
      // The exact reference beside the particle map: the same outlines, crisp, and every marked place with its name.
      wide = true;
      const map = decodeMap(new Uint8Array(await (await sources.media(presentation.media.id)).arrayBuffer()));
      const bounds = frameBounds(map.frame), size = 600;
      const width = Math.round(size * bounds.x / Math.max(bounds.x, bounds.y)), height = Math.round(size * bounds.y / Math.max(bounds.x, bounds.y));
      const sx = (x: number) => ((x + bounds.x) / (2 * bounds.x) * width).toFixed(1), sy = (y: number) => ((bounds.y - y) / (2 * bounds.y) * height).toFixed(1);
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("class", "map");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `Map of ${presentation.label}${presentation.markers.length ? ` with ${presentation.markers.map(m => m.label).join(", ")}` : ""}`);
      const path = (lines: number[][], className: string, closed: boolean) => {
        if (!lines.length) return;
        const d = lines.map(line => { let out = `M${sx(line[0])} ${sy(line[1])}`; for (let k = 2; k < line.length; k += 2) out += `L${sx(line[k])} ${sy(line[k + 1])}`; return closed ? `${out}Z` : out; }).join("");
        const node = document.createElementNS(NS, "path");
        node.setAttribute("d", d); node.setAttribute("class", className);
        svg.append(node);
      };
      path(map.contextFill, "land context", true); path(map.fill, "land", true);
      path(map.context, "edge context", false); path(map.borders, "edge border", false); path(map.focus, "edge", false);
      for (const marker of presentation.markers) {
        const n = geoToNormal(marker.lon, marker.lat, map.frame);
        if (!n) continue;
        const dot = document.createElementNS(NS, "circle");
        dot.setAttribute("cx", sx(n[0])); dot.setAttribute("cy", sy(n[1])); dot.setAttribute("r", marker.highlight ? "6" : "4.5");
        dot.setAttribute("fill", marker.color); dot.setAttribute("class", "dot");
        const name = document.createElementNS(NS, "text");
        name.setAttribute("x", (Number(sx(n[0])) + 9).toFixed(1)); name.setAttribute("y", (Number(sy(n[1])) + 4).toFixed(1));
        name.textContent = marker.label;
        svg.append(dot, name);
      }
      root.append(el("h2", undefined, presentation.label), svg);
      const line = caption(presentation.markers.map(m => `${m.label} ${Math.abs(m.lat).toFixed(2)}°${m.lat >= 0 ? "N" : "S"} ${Math.abs(m.lon).toFixed(2)}°${m.lon >= 0 ? "E" : "W"}`).join(" · ") || undefined, presentation.credit);
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
    case "form": case "symbol": case "emoji": case "scene":
      break;
  }
  return { root, wide, images };
}
