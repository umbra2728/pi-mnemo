import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, MouseRegion, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RecallItem } from "./recall.ts";

interface Expansion {
  base: boolean;
  expanded: boolean;
}

const expansions = new Map<string, Expansion>();

function expansionFor(key: string, base: boolean): Expansion {
  const known = expansions.get(key);
  if (known && known.base === base) return known;
  const fresh = { base, expanded: base };
  expansions.set(key, fresh);
  return fresh;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

class RecallView implements Component {
  private readonly title: string;
  private readonly items: RecallItem[];
  private readonly theme: Theme;
  private readonly state: Expansion;

  constructor(title: string, items: RecallItem[], theme: Theme, state: Expansion) {
    this.title = title;
    this.items = items;
    this.theme = theme;
    this.state = state;
  }

  render(width: number): string[] {
    const { theme, state } = this;
    const fit = (line: string) => truncateToWidth(line, width, "…");
    const hint = state.expanded ? "" : theme.fg("dim", " · click or ctrl+o to expand");
    const lines = [fit(`${theme.fg("dim", `🧠 ${this.title}`)}${hint}`)];
    for (const item of this.items) {
      const id = theme.fg("accent", `#${item.id}`);
      if (!state.expanded) {
        lines.push(fit(`  ${id} ${theme.fg("dim", `${item.kind} ·`)} ${theme.fg("muted", oneLine(item.text))}`));
        continue;
      }
      const meta = [item.kind, item.date, item.project ?? "global"].filter(Boolean).join(" · ");
      lines.push(fit(`  ${id} ${theme.fg("dim", meta)}`));
      for (const line of wrapTextWithAnsi(item.text.trim(), Math.max(10, width - 4))) lines.push(fit(`    ${theme.fg("muted", line)}`));
    }
    return lines;
  }

  invalidate(): void {}
}

export function recallView(key: string, title: string, items: RecallItem[], expanded: boolean, theme: Theme, pad: number): Component {
  const state = expansionFor(key, expanded);
  const box = new Box(pad, 0, (t: string) => t);
  box.addChild(
    new MouseRegion(new RecallView(title, items, theme, state), (event) => {
      if (event.type !== "click" || event.button !== "left") return undefined;
      state.expanded = !state.expanded;
      return { handled: true };
    }),
  );
  return box;
}
