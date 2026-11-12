// A barra da coluna do Reels, no layout `main-reels`. Embaixo dela, o bloco
// `reels-view` mostra o terminal que roda bin/reels-term.mjs (o navegador).
//
// - Abre o navegador quando a coluna aparece e mantém `main-reels` igual ao
//   `main` do Herdr + o botão Reels na barra de abas + esta coluna.
// - ▶/⏸ toca/pausa; ✕ esconde a coluna (e pausa). As opções ficam num menu:
// - "pausa": pausa quando um agente do Herdr para de trabalhar.
// - "trava": só deixa rolar enquanto algum agente trabalha.
// - "scroll": passa para o próximo reel quando o atual termina.
//
// Só escreve um arquivo: layouts/main-reels.json. Nunca toca no `main`.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, terminals, focused, props, openOverlay, nextCommand, hc, appHome, home, layout, shared, setShared, notify, run, theme, readTextFile, writeTextFile } from "herdr";

const LAYOUT = "main-reels";
const COLUMN = "reels";
const VIEW = "reels-view";
const TERMINAL = "reels";
const CTL = "http://127.0.0.1:9340";
const KEY = { auto: "reels.auto", lock: "reels.lock", scroll: "reels.autoscroll" };
const BAR_HEIGHT = 32;
const SHELLS = ["zsh", "bash", "sh", "fish", "-zsh", "-bash"];
const ICON = (name) => `mods/reels-bar/icons/${name}.svg`;

// O menu de opções (o mesmo mod, aberto como popup com props.menu).
const OPTIONS = [
  { key: "auto", fallback: true, title: "Pausar quando um agente responder", about: "Quando um agente termina ou precisa de você" },
  { key: "lock", fallback: false, title: "Só rolar com agente trabalhando", about: "Sem agente trabalhando, a rolagem trava" },
  { key: "scroll", fallback: false, title: "Próximo reel automático", about: "Passa sozinho quando o vídeo acaba" },
];

const SCRIPT = () => `${appHome()}/mods/reels-bar/bin/reels-term.mjs`;

function findNode(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const r = findNode(c, id);
    if (r) return r;
  }
  return null;
}

// JSON com chaves ordenadas: compara layouts sem ligar para a ordem.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// O layout `main-reels`: o `main` do Herdr com duas mudanças.
function buildLayout(main, address, version) {
  const doc = JSON.parse(JSON.stringify(main));
  const tabs = findNode(doc, "tabs");
  const body = findNode(doc, "work-body");
  if (!tabs || !body?.children) return null;
  tabs.content = { mod: "tabs-reels" };
  body.children.push({
    id: COLUMN, type: "column", size: { px: 420 }, min: 320, max: 900, resizable: false,
    radius: 10, background: "background",
    // A borda é desenhada em duas partes que mudam de cor juntas quando o
    // navegador tem o foco: o bloco do terminal (focus) e esta barra (render).
    children: [
      { id: "reels-bar", type: "block", size: { px: BAR_HEIGHT }, content: { mod: "reels-bar" } },
      { id: VIEW, type: "block", border: { width: 1, color: "border" }, focus: { border: { width: 1, color: "accent" } }, content: { terminal: address } },
    ],
  });
  const { id, ...rest } = doc;
  return { id, cloned_from: { name: "main", version }, ...rest };
}

export default class ReelsBar extends View {
  init(_props, cx) {
    if (props()?.menu) return; // o popup de opções só desenha o menu
    this.prev = {};       // status anterior de cada agente
    this.playing = null;  // null = navegador fora do ar
    this.starting = false;
    this.wasHidden = false;
    this.sent = {};       // o que o navegador já sabe: { locked, autoscroll }
    this.misses = 0;
    this.token = null;
    this.lastPane = null; // o último painel focado, para voltar do Reels
    this.ensure(cx);
    cx.timer.every(2000, (cx) => this.poll(cx));
    cx.spawn(async (cx) => { for (;;) this.command(await nextCommand()); });
  }

  // Navegação de painéis (Cmd+Opt+setas). O Herdr não leva `pane.go` para
  // blocos de terminal do layout, então:
  // - "focus": o pane.go chegou neste mod (focusable): passa para o vídeo;
  // - "left" (Cmd+Opt+←, keys.json, só no main-reels): saindo do vídeo,
  //   volta ao último painel; em qualquer outro lugar, o pane.go normal.
  command(c) {
    const address = findNode(layout(), VIEW)?.content?.terminal;
    const inReels = Boolean(address) && focused()?.terminal === address && !focused()?.pane;
    if (c === "focus" && address) run("pane.focus", { terminal: address });
    else if (c === "left" && inReels && this.lastPane) run("pane.focus", { pane: this.lastPane });
    else if (c === "left" && !inReels) run("pane.go", { direction: "left" });
  }

  // Fala com o navegador. O token vem de um arquivo que só você pode ler.
  async ctl(path) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.token) this.token = (await readTextFile(`${home()}/.local/share/reels-widget/token`))?.trim() || null;
      if (!this.token) return null;
      try {
        const r = await fetch(CTL + path, { headers: { "x-reels-token": this.token } });
        if (r.status === 403) { this.token = null; continue; } // navegador reiniciou: token novo
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Garante o terminal do navegador e o layout certo.
  ensure(cx) {
    if (this.starting || shared("layout") !== LAYOUT) return;
    this.starting = true;
    cx.spawn(async (cx) => {
      try {
        const ls = JSON.parse((await hc(["ls", "--json"])).stdout || "{}");
        let t = (ls.terminals ?? []).find((x) => x.name === TERMINAL && x.state === "live");
        if (!t) {
          // O terminal nunca deve terminar: quando um terminal do layout
          // termina, o Herdr reescreve o layout e desmonta colunas. Por isso:
          // - o navegador roda em loop (volta sozinho se sair);
          // - --keep: se o Herdr/Mac reiniciar, o mesmo terminal volta com
          //   um shell (ver revive()).
          // O caminho vai como argumento ($0), sem montar comando com texto.
          // zsh -i para achar o node do nvm.
          const r = await hc([
            "run", "--bg", "--json", "--no-parent", "--keep", "--name", TERMINAL, "--",
            "/bin/zsh", "-ic", 'while true; do node "$0" || sleep 4; sleep 1; done', SCRIPT(),
          ]);
          t = JSON.parse(r.stdout);
        } else if (this.misses >= 3) {
          await this.revive(t.address);
        }
        await this.ensureLayout(t.address);
      } catch (e) {
        notify({ title: "Reels", body: `Não consegui abrir: ${e?.message ?? e}`, level: "error" });
      }
      this.starting = false;
      cx.notify();
    });
  }

  // Depois de um reinício o terminal volta só com um shell. Se (e só se) o que
  // roda nele for um shell, digita o comando do navegador. Nunca digita em
  // cima do navegador: isso viraria teclas na página.
  async revive(address) {
    if (Date.now() - (this.revivedAt ?? 0) < 30000) return;
    const info = JSON.parse((await hc(["get", address, "--json"])).stdout || "{}");
    if (!SHELLS.includes(info.foreground?.name)) return;
    this.revivedAt = Date.now();
    const path = SCRIPT().replace(/'/g, "'\\''");
    await hc(["send", address, `while true; do node '${path}' || sleep 4; sleep 1; done`]);
  }

  // Tamanhos salvos pelo Herdr (cliques) que ficaram no eixo errado depois de
  // ele desmontar colunas: a barra com altura enorme, o painel do Files com
  // altura fixa. Corrige só o que estiver errado.
  repairSizes() {
    const root = layout();
    const bar = findNode(root, "reels-bar");
    if (bar && bar.size?.px !== BAR_HEIGHT) run("layout.resize", { id: "reels-bar", px: BAR_HEIGHT });
    const panelBody = findNode(root, "panel-body");
    if (panelBody?.size && panelBody.size.weight === undefined) run("layout.resize", { id: "panel-body", weight: 1 });
  }

  async ensureLayout(address) {
    const dir = `${appHome()}/layouts`;
    const mainText = await readTextFile(`${dir}/main.json`);
    if (!mainText) return;
    const file = `${dir}/${LAYOUT}.json`;
    const text = await readTextFile(file);
    let have = null;
    try { have = text ? JSON.parse(text) : null; } catch {}
    const want = buildLayout(JSON.parse(mainText), address, have?.cloned_from?.version ?? "0.1.13");
    if (!want) return;
    if (have && stable(have) === stable(want)) return;
    await writeTextFile(file, JSON.stringify(want, null, 2) + "\n", text);
  }

  poll(cx) {
    cx.spawn(async (cx) => {
      const st = await this.ctl("/state");
      this.sent = st ? { locked: st.locked, autoscroll: st.autoscroll } : {};
      this.misses = st ? 0 : this.misses + 1;
      // Navegador fora do ar há ~6 s, ou o layout mostrando um terminal que
      // não existe mais: reabre e acerta o layout.
      const shown = findNode(layout(), VIEW)?.content?.terminal;
      const alive = terminals().some((x) => x.address === shown && x.state === "live");
      if (this.misses >= 3 || !alive) {
        this.misses = 0;
        this.ensure(cx);
      }
      this.sync(cx);
      const playing = st ? Boolean(st.playing) : null;
      if (playing !== this.playing) {
        this.playing = playing;
        cx.notify();
      }
    });
  }

  on(key, fallback = false) {
    const v = shared(KEY[key]);
    return typeof v === "boolean" ? v : fallback;
  }

  // Trava ligada e nenhum agente trabalhando: rolagem travada.
  locked() {
    return this.on("lock") && !agents().some((a) => a.status === "working");
  }

  // Manda a trava e o auto scroll para o navegador quando mudam.
  sync(cx) {
    const want = { locked: this.locked(), autoscroll: this.on("scroll") };
    const jobs = [];
    if (want.locked !== this.sent.locked) jobs.push(`/lock?on=${want.locked ? 1 : 0}`);
    if (want.autoscroll !== this.sent.autoscroll) jobs.push(`/autoscroll?on=${want.autoscroll ? 1 : 0}`);
    if (!jobs.length) return;
    Object.assign(this.sent, want);
    cx.spawn(async () => {
      for (const j of jobs) if (!(await this.ctl(j))) this.sent = {};
    });
  }

  pause(cx, why) {
    cx.spawn(async (cx) => {
      const r = await this.ctl("/pause");
      if (r?.paused > 0) {
        if (why) notify({ title: "Reels pausado", body: why, level: "info", timeout: 3000 });
        this.playing = false;
        cx.notify();
      }
    });
  }

  // Roda a cada render (o Herdr redesenha quando agentes ou o layout mudam).
  watch(cx) {
    const pane = focused()?.pane;
    if (pane) this.lastPane = pane;
    const finished = [];
    for (const a of agents()) {
      if (this.prev[a.address] === "working" && a.status !== "working") finished.push(a);
      this.prev[a.address] = a.status;
    }
    if (finished.length && this.on("auto", true)) {
      const a = finished[0];
      const who = a.title || a.app || a.address;
      this.pause(cx, a.status === "blocked" ? `${who} precisa de você` : `${who} respondeu`);
    }
    const hidden = Boolean(findNode(layout(), COLUMN)?.hidden);
    if (hidden && !this.wasHidden) this.pause(cx, null);
    this.wasHidden = hidden;
    this.repairSizes();
    this.sync(cx);
  }

  // Botão de ícone, 24×24, como os do cabeçalho dos painéis.
  button(t, id, icon, tip, onClick) {
    return div()
      .id(id)
      .size(24)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .text_color(t.muted)
      .cursor_pointer()
      .tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(onClick)
      .child(svg(icon).size(14));
  }

  // O popup: uma linha por opção, com título, explicação e um check.
  // O popup: uma linha por opção. Ligada: fundo destacado e a chave acesa.
  menu(t) {
    const toggle = (on) => h_flex()
      .w(28).h(16).p(2).flex_none().rounded(8)
      .when(on, (el) => el.justify_end())
      .bg(on ? t.accent : t.input)
      .child(div().size(12).rounded(6).bg(on ? t.accent_foreground : t.muted));
    return v_flex()
      .id("reels-options")
      .size_full()
      .overflow_y_scrollbar()
      .p(6)
      .gap(3)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(2).pb(3).text_size(11).text_color(t.dim).child("Opções do Reels"))
      .children(OPTIONS.map((o) => {
        const on = this.on(o.key, o.fallback);
        return h_flex()
          .id(`opt-${o.key}`)
          .px(10)
          .py(7)
          .gap(12)
          .rounded(8)
          .items_center()
          .cursor_pointer()
          .when(on, (el) => el.bg(t.selected))
          .hover((el) => el.bg(t.hover))
          .on_click(() => setShared(KEY[o.key], !on))
          .child(
            v_flex().flex_1().min_w(0).gap(2)
              .child(div().text_color(t.foreground).child(o.title))
              .child(div().text_size(11.5).text_color(on ? t.muted : t.dim).child(o.about)),
          )
          .child(toggle(on));
      }));
  }

  render(cx) {
    const t = theme();
    if (props()?.menu) return this.menu(t);
    this.watch(cx);
    const off = this.playing === null;
    const locked = this.locked();
    const address = findNode(layout(), VIEW)?.content?.terminal;
    const active = Boolean(address) && focused()?.terminal === address;
    const state = this.starting ? "abrindo…" : off ? "fechado" : locked ? "travado" : this.playing ? "tocando" : "pausado";
    const tone = this.starting || off ? t.dim : locked ? t.blocked : this.playing ? t.working : t.dim;
    return h_flex()
      .size_full()
      .pl(12)
      .pr(6)
      .gap(2)
      .items_center()
      .bg(t.surface)
      .rounded_t(10)
      .border_t(1)
      .border_l(1)
      .border_r(1)
      .border_color(active ? t.accent : t.border)
      .text_size(12)
      .child(
        h_flex().gap(7).items_center().min_w(0)
          .child(div().size(7).flex_none().rounded(4).bg(tone))
          .child(div().flex_none().font_semibold().text_color(active ? t.accent : t.foreground).child("Reels"))
          .child(div().truncate().text_color(locked ? t.blocked : t.dim).child(state)),
      )
      .child(div().flex_1())
      .when(off && !this.starting, (el) => el.child(
        div().id("open").h(22).px(8).flex().items_center().rounded(6).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.ensure(cx)).child("Abrir"),
      ))
      .when(!off, (el) =>
        el.child(this.button(t, "toggle", ICON(this.playing ? "pause" : "play"), this.playing ? "Pausar" : "Tocar", (_e, cx) => {
          cx.spawn(async (cx) => { await this.ctl("/toggle"); this.poll(cx); });
        })),
      )
      .child(this.button(t, "options", ICON("options"), "Opções", () =>
        openOverlay({ mod: "reels-bar", kind: "popup", width: 340, height: 224, props: { menu: true } })))
      .child(this.button(t, "hide", "mods/pane/close.svg", "Esconder (⌘⇧R)", () => run("layout.hide", { id: COLUMN })));
  }
}
