import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { commandSchema, type Command } from '../../shared/commands';

/**
 * Remote control for a tablet/phone on the show network: a tiny page served over HTTP, state pushed with
 * Server-Sent Events, commands POSTed as JSON. Access needs the token in the URL. Only show-control commands are
 * accepted: nothing can arm an output, resume transmission or change the project.
 */
export interface RemoteState {
  master: number;
  blackout: boolean;
  transmitting: boolean;
  bpm: number;
  lists: { index: number; name: string; state: string; cue: string | null }[];
  /** Camera localisation waiting for a smartphone photo of `frame`. */
  locate: { frame: number; total: number; label: string } | null;
}

export interface RemoteDeps {
  state(): RemoteState;
  execute(cmd: Command): Promise<unknown>;
  /** Cue list id from a 1-based index. */
  listId(index: number): string | undefined;
  /** Smartphone photo (JPEG) for a localisation frame; false when no photo is expected for that frame. */
  locatePhoto?(frame: number, jpeg: Buffer): boolean;
}

const ALLOWED = new Set<Command['type']>(['cue.go', 'cue.back', 'cue.goto', 'cue.pause', 'cue.resume', 'engine.blackout', 'engine.master', 'output.transmit', 'programmer.release']);

/** Whitelist + schema validation; `output.transmit` may only stop. Returns the command or an error message. */
export function validateRemoteCommand(raw: unknown, listId: (i: number) => string | undefined): Command | string {
  if (typeof raw !== 'object' || !raw) return 'commande invalide';
  const r = { ...(raw as Record<string, unknown>) };
  if (typeof r.list === 'number') {
    const id = listId(r.list);
    if (!id) return 'liste de cues introuvable';
    r.listId = id;
    delete r.list;
  }
  const parsed = commandSchema.safeParse(r);
  if (!parsed.success) return 'commande invalide';
  const cmd = parsed.data;
  if (!ALLOWED.has(cmd.type)) return 'commande non autorisée à distance';
  if (cmd.type === 'output.transmit' && cmd.on) return 'la reprise des émissions se fait depuis la régie';
  return cmd;
}

export class RemoteServer {
  private server: http.Server | null = null;
  private readonly clients = new Set<http.ServerResponse>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RemoteDeps) {}

  async start(port: number, bind: string, token: string): Promise<void> {
    await this.stop();
    const expected = Buffer.from(token);
    const authorized = (url: URL) => {
      const got = Buffer.from(url.searchParams.get('t') ?? '');
      return got.length === expected.length && timingSafeEqual(got, expected);
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://remote');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (!authorized(url)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Jeton invalide');
        return;
      }
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" }).end(PAGE);
      } else if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify(this.deps.state())}\n\n`);
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
      } else if (req.method === 'POST' && url.pathname === '/locate/photo') {
        const frame = Number(url.searchParams.get('frame'));
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 4 * 1024 * 1024) req.destroy(); // photos are downscaled on the phone (≈ 100 kB)
          else chunks.push(c);
        });
        req.on('end', () => {
          const jpeg = Buffer.concat(chunks);
          const isJpeg = jpeg.length > 3 && jpeg[0] === 0xff && jpeg[1] === 0xd8;
          const ok = Number.isInteger(frame) && isJpeg && !!this.deps.locatePhoto?.(frame, jpeg);
          res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok, error: ok ? undefined : 'photo inattendue ou invalide' }));
        });
      } else if (req.method === 'POST' && url.pathname === '/cmd') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 2048) req.destroy();
        });
        req.on('end', () => {
          let raw: unknown;
          try { raw = JSON.parse(body); } catch { raw = null; }
          const cmd = validateRemoteCommand(raw, this.deps.listId);
          if (typeof cmd === 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: cmd }));
            return;
          }
          this.deps.execute(cmd).then(
            (data) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, data })),
            (err: Error) => res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: false, error: err.message })),
          );
        });
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bind, () => { server.off('error', reject); resolve(); });
    });
    this.server = server;
    this.timer = setInterval(() => {
      if (!this.clients.size) return;
      const msg = `data: ${JSON.stringify(this.deps.state())}\n\n`;
      for (const c of this.clients) c.write(msg);
    }, 200);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.clients) c.end();
    this.clients.clear();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  get port(): number | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : null;
  }
}

const PAGE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Luma — Télécommande</title><style>
:root{color-scheme:dark;--bg:#0b0d12;--panel:#151925;--line:#283142;--text:#e6e9f0;--dim:#98a3b5;--accent:#8b5cf6;--danger:#ef4444}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px system-ui,sans-serif;padding:16px;max-width:640px;margin:auto}
h1{font-size:18px;margin:0 0 12px}.row{display:flex;gap:8px;margin:8px 0}.row>*{flex:1}
button{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:18px 8px;font:600 18px system-ui;touch-action:manipulation}
button:active{transform:scale(.98)}.go{background:var(--accent);border-color:var(--accent);font-size:28px}.stop{background:var(--danger);border-color:var(--danger)}
.on{outline:3px solid #f59e0b}select,input{width:100%;font-size:16px}select{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:10px}
.st{color:var(--dim);font-size:14px;min-height:20px}.err{color:#fca5a5}label{display:block;color:var(--dim);font-size:14px;margin-top:12px}
</style></head><body><h1>Luma — Télécommande</h1>
<select id="list" aria-label="Liste de cues"></select><div class="st" id="cue">Connexion…</div>
<div class="row"><button class="go" id="go">GO</button></div>
<div class="row"><button id="back">BACK</button><button id="pause">Pause</button><button id="release">Relâcher</button></div>
<div class="row"><button id="bo">Blackout</button><button class="stop" id="stop">STOP OUTPUT</button></div>
<label for="master">Grand master <span id="mv"></span></label><input id="master" type="range" min="0" max="100">
<div id="loc" style="display:none;margin-top:16px;padding:12px;border:1px solid var(--accent);border-radius:10px"><b>Localisation des projecteurs</b><div class="st" id="locst"></div><label class="go" style="display:block;text-align:center;padding:18px;border-radius:10px;margin-top:8px">Prendre la photo<input id="cam" type="file" accept="image/*" capture="environment" style="display:none"></label><div class="st">Gardez le téléphone immobile, au même endroit, pour toutes les photos.</div></div>
<div class="st" id="msg"></div><script>
const t=new URLSearchParams(location.search).get('t');const $=(i)=>document.getElementById(i);let st=null;
async function send(c){const r=await fetch('cmd?t='+encodeURIComponent(t),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(c)});const j=await r.json();$('msg').textContent=j.ok?'':j.error;$('msg').className='st'+(j.ok?'':' err');}
const list=()=>Number($('list').value||1);
$('go').onclick=()=>send({type:'cue.go',list:list()});$('back').onclick=()=>send({type:'cue.back',list:list()});
$('pause').onclick=()=>{const l=st&&st.lists[list()-1];send({type:l&&l.state==='paused'?'cue.resume':'cue.pause',list:list()});};
$('release').onclick=()=>send({type:'programmer.release'});$('bo').onclick=()=>send({type:'engine.blackout',on:!(st&&st.blackout)});
$('stop').onclick=()=>send({type:'output.transmit',on:false});$('master').oninput=(e)=>send({type:'engine.master',value:e.target.value/100});
const es=new EventSource('events?t='+encodeURIComponent(t));es.onerror=()=>{$('cue').textContent='Connexion perdue — reconnexion…';};
$('cam').onchange=async(e)=>{const f=e.target.files[0];e.target.value='';if(!f||!st||!st.locate)return;const fr=st.locate.frame;$('locst').textContent='Envoi…';const bmp=await createImageBitmap(f);const k=Math.min(1,960/bmp.width);const c=document.createElement('canvas');c.width=Math.round(bmp.width*k);c.height=Math.round(bmp.height*k);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);const blob=await new Promise((r)=>c.toBlob(r,'image/jpeg',0.85));const r=await fetch('locate/photo?t='+encodeURIComponent(t)+'&frame='+fr,{method:'POST',body:blob});const j=await r.json();$('locst').textContent=j.ok?'Photo reçue':j.error;};
es.onmessage=(e)=>{st=JSON.parse(e.data);$('loc').style.display=st.locate?'block':'none';if(st.locate)$('locst').textContent='Image '+(st.locate.frame+1)+'/'+st.locate.total+' : '+st.locate.label;const sel=$('list'),cur=sel.value;if(sel.options.length!==st.lists.length){sel.innerHTML='';for(const l of st.lists){const o=document.createElement('option');o.value=l.index;o.textContent=l.name;sel.appendChild(o);}if(cur)sel.value=cur;}
const l=st.lists[list()-1];$('cue').textContent=(l?(l.cue?'Cue : '+l.cue:'Aucun cue actif')+' · '+l.state:'Aucune liste')+(st.transmitting?'':' · ÉMISSIONS ARRÊTÉES');
$('bo').classList.toggle('on',st.blackout);if(document.activeElement!==$('master'))$('master').value=Math.round(st.master*100);$('mv').textContent=Math.round(st.master*100)+' %';};
</script></body></html>`;
