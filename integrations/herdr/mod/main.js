// agent-hub entry for Herdr (optional, removable). Native glue only: every decision is in ./core.js, which has no host import and is what the tests run.
// Opened as a dialog (mod.json overlay), e.g. by `mod.open` bound to a key the person adds. It shows this space's machine and folder, lists that machine's registered ahub projects,
// and offers Open console, Open dashboard (this computer only) and Copy command for the one project the person selects. It runs nothing on open and starts nothing, and it keeps no state.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, run, hc, spaces, machines, focused, terminals, window, props, closeOverlay, theme } from "herdr";
import { createHerdrEntry } from "./core.js";

const host = { exec, run, hc, spaces, machines, focused, terminals, now: () => Date.now(), platform: () => window().platform };

export default class AhubEntry extends View {
  init(_props, cx) {
    this.entry = createHerdrEntry({ host });
    this.note = "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.spawn(async (cx) => { await this.entry.refresh(); cx.notify(); });
  }

  act(name, cx) {
    this.note = "Working...";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = name === "console" ? await this.entry.openConsole() : await this.entry.openDashboard();
      this.note = r.ok ? (r.opened === "console" ? `Opened the console in a new tab (${r.machineLabel}).` : "Asked ahub to open the local dashboard.") : r.message;
      if (r.ok && r.opened === "console") closeOverlay(props().overlay);
      cx.notify();
    });
  }

  card(cx) {
    this.note = "Reading status...";
    cx.notify();
    cx.spawn(async (cx) => { const r = await this.entry.refreshCard(); this.note = r.ok === false && r.message ? r.message : ""; cx.notify(); });
  }

  focus(kind, cx) {
    this.note = "Looking for the console...";
    cx.notify();
    cx.spawn(async (cx) => {
      const r = kind === "peek" ? await this.entry.peekConsole() : await this.entry.focusConsole();
      this.note = r.ok ? (kind === "peek" ? "Asked Herdr to peek at the console." : "Focused the console.") + (r.observed ? ` Herdr shows it as ${r.observed}.` : "") : r.message;
      if (r.ok && kind === "focus") closeOverlay(props().overlay);
      cx.notify();
    });
  }

  copy(cx) {
    const r = this.entry.copyCommand();
    if (r.ok) { cx.write_to_clipboard(r.command); this.note = `Copied. Run it on ${r.machineLabel}.`; } else this.note = r.message;
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const v = this.entry.view();
    const button = (id, label, enabled, onClick) => h_flex().id(id).h(30).px(12).items_center().rounded(8).border_1().border_color(t.input).bg(enabled ? t.solid : t.raised)
      .text_color(enabled ? t.solid_foreground : t.dim).when(enabled, (s) => s.cursor_pointer().on_click(onClick)).child(label);
    const rows = v.rows.map((r) => h_flex().id(`row-${r.id}`).px(10).py(6).gap(8).rounded(6).cursor_pointer()
      .bg(v.selection?.id === r.id ? t.selected : r.candidate ? t.hover : t.surface)
      .on_click((_e, cx) => { this.entry.select(r.id); this.note = ""; cx.notify(); })
      .child(div().flex_1().min_w(0).text_size(12).text_color(t.foreground).child(r.root))
      .child(div().text_size(11).text_color(r.state === "running" ? t.done : t.dim).child(r.state)));
    const sel = v.selection;
    const cardLines = sel ? this.entry.cardLines() : [];
    return v_flex().id("ahub-entry").track_focus(this.handle).size_full().min_h(0).p(16).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child("agent-hub"))
      .child(div().text_color(t.muted).child(`Machine: ${v.machineLabel}   Folder: ${v.cwd ?? "none (this pane has no folder)"}`))
      .child(v.status === "refused" ? div().text_color(t.blocked).child(v.message) : v.status === "loading" ? div().text_color(t.dim).child("Reading registered projects...") : div().text_color(t.dim).child(
        v.rows.length === 0 ? "No ahub project is registered on this machine." : v.candidate === "ambiguous" ? "More than one registered project contains this folder. Pick one." : v.candidate === "single" ? "One registered project contains this folder. Select it to confirm." : "No registered project contains this folder. Pick one."))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().gap(2).children(rows))
      .child(cardLines.length ? v_flex().gap(2).text_size(12).text_color(t.muted).children(cardLines.map((line) => div().child(line))) : div())
      .child(h_flex().gap(8)
        .child(button("console", "Open console", !!sel, (_e, cx) => this.act("console", cx)))
        .child(button("dashboard", "Open dashboard", !!sel && sel.machine === null, (_e, cx) => this.act("dashboard", cx)))
        .child(button("status", "Status", !!sel, (_e, cx) => this.card(cx)))
        .child(button("focus", "Focus console", !!sel && sel.machine === null, (_e, cx) => this.focus("focus", cx)))
        .child(button("peek", "Peek console", !!sel && sel.machine === null, (_e, cx) => this.focus("peek", cx)))
        .child(button("copy", "Copy command", !!sel, (_e, cx) => this.copy(cx)))
        .child(button("refresh", "Refresh", true, (_e, cx) => { this.note = ""; cx.spawn(async (cx) => { await this.entry.refresh(); cx.notify(); }); cx.notify(); })))
      .child(div().text_size(12).text_color(t.muted).child(this.note || (sel ? `Selected: ${sel.root} on ${sel.machineLabel}` : "")));
  }
}
