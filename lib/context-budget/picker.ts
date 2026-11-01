import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth } from "@earendil-works/pi-tui";

/** Budget-only picker. Keep the real list visible to the existing Telegram adapter. */
export async function selectBudgetItem(ui: Pick<ExtensionUIContext, "custom">, title: string,
  options: readonly string[]): Promise<string | undefined> {
  if (options.length === 0) return undefined;
  return ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const items = options.map(value => ({ value, label: value }));
    let closed = false;
    const finish = (value: string | undefined) => {
      if (closed) return;
      closed = true;
      done(value);
    };
    // Mounted in the bottom input dock (not an overlay): cap at 14 rows so the transcript stays visible.
    const height = () => Math.max(1, Math.min(14, Math.floor(tui.terminal.rows * 0.8)));
    const visible = () => Math.max(1, Math.min(10, height() - (height() >= 4 ? 3 : 1)));
    let maxVisible = visible();
    const makeList = (count: number) => {
      const list = new SelectList(items, count, {
        selectedPrefix: text => theme.fg("accent", text),
        selectedText: text => theme.fg("accent", text),
        description: text => theme.fg("muted", text),
        scrollInfo: text => theme.fg("dim", text),
        noMatch: text => theme.fg("warning", text),
      });
      list.onSelect = item => finish(item.value);
      list.onCancel = () => finish(undefined);
      return list;
    };
    const component = {
      baseTitle: title,
      list: makeList(maxVisible),
      render(width: number): string[] {
        if (closed) return [];
        const next = visible();
        if (next !== maxVisible) {
          const selected = this.list.getSelectedItem()?.value;
          this.list = makeList(next);
          this.list.setSelectedIndex(items.findIndex(item => item.value === selected));
          maxVisible = next;
        }
        const room = height();
        const chrome = room >= 4;
        // On extremely short terminals omit chrome/counter, never the selected row.
        const rows = this.list.render(Math.max(4, width)).slice(0, room - (chrome ? 2 : 0));
        return [
          ...(chrome ? [theme.fg("accent", title)] : []),
          ...rows,
          ...(chrome ? [theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc 取消")] : []),
        ].map(line => truncateToWidth(line, Math.max(0, width), ""));
      },
      handleInput(data: string): void {
        if (closed) return;
        this.list.handleInput(data);
        tui.requestRender();
      },
      invalidate(): void { this.list.invalidate(); },
      dispose(): void { finish(undefined); },
    };
    return component;
  });
}
