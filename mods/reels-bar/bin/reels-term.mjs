#!/usr/bin/env node
// reels-term: um navegador mínimo dentro do terminal.
//
// Roda o Chrome sem janela (headless) e fala com ele pelo DevTools Protocol
// num pipe privado (--remote-debugging-pipe): nenhuma porta de depuração fica
// aberta, então nenhum outro programa alcança a sessão logada. Os quadros da
// página são desenhados com imagens Kitty; mouse, rolagem e teclado vão para a
// página.
//
// Controle (para o mod do Herdr): HTTP em 127.0.0.1:9340, só com o cabeçalho
// `x-reels-token` igual ao conteúdo de ~/.local/share/reels-widget/token
// (arquivo 0600, novo a cada início). Rotas: /pause /play /toggle /state
// /lock?on=1|0 (trava a rolagem) /autoscroll?on=1|0 (próximo reel ao terminar).
//
// Uso: node reels-term.mjs [url]       Ctrl+Q sai.

import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

const START_URL = process.argv[2] || 'https://www.instagram.com/reels/'
const CTL_PORT = 9340
const DATA = path.join(os.homedir(), '.local/share/reels-widget')
const PROFILE = path.join(DATA, 'chrome-profile')
const TOKEN_FILE = path.join(DATA, 'token')
const LOG = path.join(DATA, 'reels-term.log')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

fs.mkdirSync(DATA, { recursive: true, mode: 0o700 })
fs.chmodSync(DATA, 0o700) // perfil com cookies: só o seu usuário
try { if (fs.statSync(LOG).size > 1_000_000) fs.truncateSync(LOG, 0) } catch {}
const log = (...a) => { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + a.join(' ') + '\n') } catch {} }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const out = process.stdout

// ---------- terminal ----------
let cols = out.columns || 50, rows = out.rows || 40
let cellW = 9, cellH = 18 // px por célula; o terminal informa o real
let css = { w: 400, h: 720 } // tamanho da página em px CSS

function computeViewport() {
  cols = out.columns || cols
  rows = out.rows || rows
  const pxW = cols * cellW, pxH = rows * cellH
  // Página com largura de celular/tablet: entre 360 e 520 px CSS.
  const scale = Math.max(pxW / 520, Math.min(pxW / 360, pxW / 440))
  css = { w: Math.round(pxW / scale), h: Math.round(pxH / scale) }
}

function say(text) {
  out.write('\x1b[2J\x1b[H')
  out.write(`\x1b[${Math.max(1, Math.floor(rows / 2))};${Math.max(1, Math.floor((cols - text.length) / 2) + 1)}H${text}`)
}

const enterScreen = () => out.write('\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h')
const leaveScreen = () => out.write('\x1b_Ga=d,d=A,q=2\x1b\\\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l')

// Respostas do terminal (como o tamanho da célula) chegam pelo stdin.
const waiters = []
function expectReply(re, ms = 600) {
  return new Promise(res => {
    const w = { re, res }
    waiters.push(w)
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); res(null) } }, ms)
  })
}

// ---------- CDP pelo pipe ----------
let chrome, pipeOut, session = null, seq = 0
const pending = new Map()
const handlers = {}

// Comando para a página (com sessão) ou para o navegador (browser: true).
function send(method, params = {}, { browser = false } = {}) {
  return new Promise((res, rej) => {
    if (!pipeOut || (!browser && !session)) return rej(new Error('sem conexão com o Chrome'))
    const id = ++seq
    pending.set(id, { res, rej })
    const msg = { id, method, params }
    if (!browser) msg.sessionId = session
    pipeOut.write(JSON.stringify(msg) + '\0')
  })
}

function listen(pipeIn) {
  let buf = Buffer.alloc(0)
  pipeIn.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    let end
    while ((end = buf.indexOf(0)) >= 0) {
      const raw = buf.subarray(0, end).toString('utf8')
      buf = buf.subarray(end + 1)
      let msg
      try { msg = JSON.parse(raw) } catch { continue }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id)
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result)
      } else if (msg.method && handlers[msg.method]) {
        handlers[msg.method](msg.params)
      }
    }
  })
  pipeIn.on('close', () => quit('O Chrome fechou.'))
}

async function attachToPage() {
  for (let i = 0; i < 50; i++) {
    const { targetInfos } = await send('Target.getTargets', {}, { browser: true })
    const page = targetInfos.find(t => t.type === 'page')
    if (page) {
      const r = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, { browser: true })
      session = r.sessionId
      return
    }
    await sleep(100)
  }
  throw new Error('o Chrome não abriu nenhuma página')
}

const evaluate = async expr =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true }))?.result?.value

// ---------- quadros ----------
// Duas imagens que se alternam: a nova aparece antes da antiga sumir (sem piscar).
let shownId = 0, busy = false
function drawFrame(b64) {
  if (busy) return // o terminal ainda não engoliu o quadro anterior: pula este
  const id = shownId === 1 ? 2 : 1
  const CH = 4096
  let s = '\x1b[H'
  for (let i = 0; i < b64.length; i += CH) {
    const more = i + CH < b64.length ? 1 : 0
    const chunk = b64.slice(i, i + CH)
    s += i === 0
      ? `\x1b_Ga=T,f=100,i=${id},p=1,q=2,C=1,c=${cols},r=${rows},m=${more};${chunk}\x1b\\`
      : `\x1b_Gm=${more};${chunk}\x1b\\`
  }
  if (shownId) s += `\x1b_Ga=d,d=I,i=${shownId},q=2\x1b\\`
  shownId = id
  if (!out.write(s)) { busy = true; out.once('drain', () => { busy = false }) }
}

handlers['Page.screencastFrame'] = p => {
  send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
  drawFrame(p.data)
}

async function startScreencast() {
  computeViewport()
  await send('Page.stopScreencast').catch(() => {})
  await send('Emulation.setDeviceMetricsOverride', { width: css.w, height: css.h, deviceScaleFactor: 1, mobile: false })
  // PNG: o formato que o protocolo de imagens Kitty aceita.
  await send('Page.startScreencast', { format: 'png', maxWidth: css.w, maxHeight: css.h, everyNthFrame: 1 })
}

// ---------- vídeo ----------
// O vídeo "da vez" é o que cruza o meio da tela.
const CENTER = `(() => { const h = innerHeight; return [...document.querySelectorAll('video')].find(v => { const r = v.getBoundingClientRect(); return r.top < h / 2 && r.bottom > h / 2 }) })`
const EXPR = {
  pause: `(() => { let n = 0; for (const v of document.querySelectorAll('video')) if (!v.paused) { v.pause(); n++ } return n })()`,
  play: `(() => { const v = ${CENTER}() || document.querySelector('video'); if (!v) return 0; v.play().catch(() => {}); return 1 })()`,
  state: `(() => ({ playing: [...document.querySelectorAll('video')].some(v => !v.paused), url: location.href }))()`,
  // Marca quando o reel da vez termina: "ended", ou o tempo voltando ao
  // início (o Instagram repete o vídeo sozinho).
  done: `(() => {
    if (!window.__reelsWatch) {
      window.__reelsWatch = true; window.__reelsDone = false
      const center = ${CENTER}, last = new WeakMap()
      setInterval(() => {
        const v = center()
        if (!v || !v.duration) return
        const prev = last.get(v) ?? 0
        last.set(v, v.currentTime)
        if (v.ended && !v.__reelsEnded) { v.__reelsEnded = true; window.__reelsDone = true; return }
        if (v.paused) return
        v.__reelsEnded = false
        if (prev > v.duration - 1.2 && v.currentTime < 1) window.__reelsDone = true
      }, 250)
    }
    const d = window.__reelsDone; window.__reelsDone = false; return d
  })()`,
  // Um giro da rodinha não vence o "snap" do Instagram: rola até o próximo vídeo.
  next: `(() => {
    const vs = [...document.querySelectorAll('video')], n = vs[vs.indexOf(${CENTER}()) + 1]
    if (!n) return false
    n.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return true
  })()`,
}

// Ligados pelo mod do Herdr.
let scrollLocked = false // só rola com algum agente trabalhando
let autoScroll = false   // passa para o próximo reel quando o atual termina

let checking = false
setInterval(async () => {
  if (!autoScroll || scrollLocked || checking || !session) return
  checking = true
  try { if (await evaluate(EXPR.done)) await evaluate(EXPR.next) } catch {}
  checking = false
}, 700)

// ---------- entrada ----------
const toCss = (x, y) => ({ x: Math.round(((x - 0.5) / cols) * css.w), y: Math.round(((y - 0.5) / rows) * css.h) })

let mouseDown = false
function mouse(b, x, y, release) {
  const p = toCss(x, y)
  if (b & 64) { // rodinha
    if (scrollLocked) return
    return send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: 0, deltaY: (b & 1) ? 120 : -120 }).catch(() => {})
  }
  if (b & 32) { // movimento com botão
    return send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: mouseDown ? 'left' : 'none', buttons: mouseDown ? 1 : 0 }).catch(() => {})
  }
  if ((b & 3) !== 0) return // só o botão esquerdo
  mouseDown = !release
  return send('Input.dispatchMouseEvent', { type: release ? 'mouseReleased' : 'mousePressed', ...p, button: 'left', buttons: release ? 0 : 1, clickCount: 1 }).catch(() => {})
}

const SPECIAL = {
  '\r': ['Enter', 13, '\r'], '\x7f': ['Backspace', 8], '\b': ['Backspace', 8], '\t': ['Tab', 9], '\x1b': ['Escape', 27],
  '\x1b[A': ['ArrowUp', 38], '\x1b[B': ['ArrowDown', 40], '\x1b[C': ['ArrowRight', 39], '\x1b[D': ['ArrowLeft', 37],
  '\x1b[3~': ['Delete', 46], '\x1b[5~': ['PageUp', 33], '\x1b[6~': ['PageDown', 34],
}
const SCROLL_KEYS = new Set(['\x1b[A', '\x1b[B', '\x1b[5~', '\x1b[6~'])

async function key(seqStr) {
  if (scrollLocked && SCROLL_KEYS.has(seqStr)) return
  const s = SPECIAL[seqStr]
  if (s) {
    const [k, vk, text] = s
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: vk, text }).catch(() => {})
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk }).catch(() => {})
    return
  }
  for (const ch of seqStr) {
    if (ch < ' ') continue
    const up = ch.toUpperCase()
    const vk = /[A-Z0-9]/.test(up) ? up.charCodeAt(0) : ch === ' ' ? 32 : 0
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk }).catch(() => {})
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk }).catch(() => {})
  }
}

let inPaste = false, pasteBuf = ''
function onInput(buf) {
  let s = buf.toString('utf8')
  for (let i = waiters.length - 1; i >= 0; i--) {
    const m = s.match(waiters[i].re)
    if (m) { s = s.replace(m[0], ''); waiters.splice(i, 1)[0].res(m) }
  }
  s = s.replace(/\x1b_G[^\x1b]*\x1b\\/g, '') // respostas de imagem
  while (s.length) {
    if (inPaste) {
      const end = s.indexOf('\x1b[201~')
      if (end < 0) { pasteBuf += s; return }
      pasteBuf += s.slice(0, end); s = s.slice(end + 6); inPaste = false
      send('Input.insertText', { text: pasteBuf }).catch(() => {}); pasteBuf = ''
      continue
    }
    if (s.startsWith('\x1b[200~')) { inPaste = true; s = s.slice(6); continue }
    let m = s.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/)
    if (m) { mouse(+m[1], +m[2], +m[3], m[4] === 'm'); s = s.slice(m[0].length); continue }
    if (s[0] === '\x11') return quit() // Ctrl+Q
    m = s.match(/^\x1b\[[0-9;]*[A-Za-z~]/) || s.match(/^\x1bO[A-Z]/)
    if (m) { key(m[0]); s = s.slice(m[0].length); continue }
    if (s[0] === '\x1b') { key('\x1b'); s = s.slice(1); continue }
    // texto comum de uma vez; teclas especiais (Enter, Tab...) uma a uma
    const text = s.match(/^[^\x1b]+/)[0]
    let i = 0
    while (i < text.length && !SPECIAL[text[i]]) i++
    if (i > 0) { key(text.slice(0, i)); s = s.slice(i) } else { key(text[0]); s = s.slice(1) }
  }
}

// ---------- controle pelo Herdr ----------
const TOKEN = randomBytes(24).toString('hex')
let firstOk = false

const server = http.createServer(async (req, res) => {
  // Só o mod do Herdr: Host exato (barra DNS rebinding) e o token secreto
  // num cabeçalho (páginas web não conseguem mandar sem passar por CORS).
  if (req.headers.host !== `127.0.0.1:${CTL_PORT}` || req.headers['x-reels-token'] !== TOKEN) {
    log('controle: recusado', req.url)
    res.writeHead(403).end()
    return
  }
  if (!firstOk) { firstOk = true; log('controle: o Herdr conectou') }
  const url = new URL(req.url || '/', 'http://local')
  const on = url.searchParams.get('on') === '1'
  try {
    let body
    switch (url.pathname) {
      case '/pause': body = { paused: await evaluate(EXPR.pause) }; break
      case '/play': body = { played: await evaluate(EXPR.play) }; break
      case '/toggle': {
        const st = await evaluate(EXPR.state)
        body = st?.playing ? { paused: await evaluate(EXPR.pause) } : { played: await evaluate(EXPR.play) }
        break
      }
      case '/state': body = { ...(await evaluate(EXPR.state)), locked: scrollLocked, autoscroll: autoScroll }; break
      case '/lock': scrollLocked = on; body = { locked: on }; break
      case '/autoscroll': autoScroll = on; body = { autoscroll: on }; break
      default: res.writeHead(404).end(); return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}))
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e?.message ?? e) }))
  }
})

// ---------- vida ----------
let quitting = false
function quit(msg) {
  if (quitting) return
  quitting = true
  try { leaveScreen() } catch {}
  if (msg) console.log(msg)
  try { chrome?.kill('SIGTERM') } catch {}
  try { server.close() } catch {}
  try { if (fs.readFileSync(TOKEN_FILE, 'utf8') === TOKEN) fs.rmSync(TOKEN_FILE) } catch {}
  setTimeout(() => process.exit(msg?.startsWith('Erro') ? 1 : 0), 300)
}
process.on('SIGHUP', () => quit())
process.on('SIGTERM', () => quit())
process.on('SIGINT', () => {}) // Ctrl+C vai para a página, não fecha
process.on('exit', () => { try { chrome?.kill('SIGKILL') } catch {} })
process.on('uncaughtException', e => { log('uncaught', e?.stack ?? e); quit('Erro: ' + e?.message) })

async function main() {
  if (!process.stdin.isTTY) { console.error('Rode num terminal.'); process.exit(1) }
  if (!fs.existsSync(CHROME)) { console.error('Google Chrome não encontrado em ' + CHROME); await sleep(30_000); process.exit(1) }
  process.stdin.setRawMode(true)
  process.stdin.on('data', onInput)
  enterScreen()
  say('Abrindo o Reels…')

  out.write('\x1b[16t') // tamanho da célula em px
  const cell = await expectReply(/\x1b\[6;(\d+);(\d+)t/)
  if (cell) { cellH = +cell[1]; cellW = +cell[2] }
  computeViewport()

  // User agent sem "HeadlessChrome", que o Instagram recusa.
  let major = '130'
  try { major = execFileSync(CHROME, ['--version']).toString().match(/(\d+)\./)[1] } catch {}
  const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`

  chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${PROFILE}`,
    `--user-agent=${ua}`,
    `--window-size=${css.w},${css.h}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate,MediaRouter',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', fs.openSync(LOG, 'a'), 'pipe', 'pipe'] })
  chrome.on('exit', code => quit(`O Chrome saiu (código ${code}). Log: ${LOG}`))
  pipeOut = chrome.stdio[3]
  listen(chrome.stdio[4])

  await attachToPage()
  await send('Page.enable')
  await send('Runtime.enable')

  server.on('error', e => log('controle', e.message))
  server.listen(CTL_PORT, '127.0.0.1', () => {
    fs.writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 })
  })

  await send('Page.navigate', { url: START_URL }).catch(e => log('navigate', e.message))
  // A navegação pode trocar o processo da página: tenta até pegar.
  for (let i = 0; i < 40; i++) {
    try { await startScreencast(); break } catch (e) { log('screencast', e.message); await sleep(250) }
  }
  out.on('resize', () => { startScreencast().catch(() => {}) })
}

main().catch(e => { log('main', e?.stack ?? e); quit('Erro: ' + e?.message) })
