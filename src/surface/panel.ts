import type { FileChange, Presentation } from "../core/presentation";

/**
 * The words that sometimes stand beside the body: a result, a passage of text, an artifact or an exact image.
 * Everything is built with textContent (never parsed as HTML), and images are shown through <img> from a blob
 * the transport fetched, so no presented content can run in the page.
 */
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const CHANGE_LABEL: Record<FileChange["change"], string> = { added: "added", modified: "modified", deleted: "deleted", renamed: "renamed" };

export interface PanelContent { root: HTMLElement; wide: boolean; images: string[] }

/** Builds the panel for a presentation; `image` resolves media ids to object URLs. */
export async function buildPanel(presentation: Presentation, image: (id: string) => Promise<string>): Promise<PanelContent> {
  const root = el("div");
  const images: string[] = [];
  let wide = false;
  const addImage = async (id: string, alt: string) => {
    const url = await image(id);
    images.push(url);
    const img = el("img");
    img.alt = alt;
    img.src = url;
    root.append(img);
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
      root.append(el("p", presentation.title ? undefined : "summary", presentation.text));
      break;
    case "image":
      wide = true;
      if (presentation.alt) root.append(el("h2", undefined, presentation.alt));
      await addImage(presentation.media.id, presentation.alt ?? "");
      break;
    case "artifact": {
      root.append(el("h2", undefined, presentation.title));
      if (presentation.type === "code" && presentation.content) {
        wide = true;
        root.append(el("pre", undefined, presentation.content));
        if (presentation.language) root.append(el("div", "lang", presentation.language));
      } else if (presentation.type === "text" && presentation.content) {
        root.append(el("p", undefined, presentation.content));
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
        await addImage(presentation.media.id, presentation.title);
      }
      break;
    }
    case "form":
      break;
  }
  return { root, wide, images };
}
