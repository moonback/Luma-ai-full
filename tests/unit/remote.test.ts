import { defaultSettings } from '../../src/core/settings/settings';
import { makeService } from '../helpers';

describe('télécommande HTTP', () => {
  it('jeton obligatoire, commandes de show seulement, état poussé en SSE', async () => {
    const { svc } = makeService();
    await svc.init();
    const s = svc.getSettings();
    const token = s.control.remote.token!;
    expect(token.length).toBeGreaterThanOrEqual(16);
    const port = 19000 + Math.floor(Math.random() * 1000);
    await svc.execute({ type: 'settings.update', settings: { ...s, control: { ...s.control, remote: { enabled: true, port, token } } } });
    const base = `http://127.0.0.1:${port}`;
    const post = (body: unknown) => fetch(`${base}/cmd?t=${token}`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as { ok: boolean; error?: string } }));

    expect((await fetch(`${base}/`)).status).toBe(403);
    expect((await fetch(`${base}/?t=${token}x`)).status).toBe(403);
    const page = await fetch(`${base}/?t=${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Télécommande');

    expect((await post({ type: 'engine.master', value: 0.4 })).json.ok).toBe(true);
    expect(svc.engine.master).toBeCloseTo(0.4);
    expect((await post({ type: 'engine.blackout', on: true })).json.ok).toBe(true);
    expect(svc.engine.blackout).toBe(true);
    expect((await post({ type: 'cue.go', list: 1 })).status).toBe(200);
    expect((await post({ type: 'cue.go', list: 9 })).json.error).toMatch(/introuvable/);
    expect((await post({ type: 'output.arm', id: 'virtual-1', confirmed: true })).json.error).toMatch(/non autorisée/);
    expect((await post({ type: 'project.new', name: 'x' })).json.error).toMatch(/non autorisée/);
    expect((await post({ type: 'output.transmit', on: false })).json.ok).toBe(true);
    expect(svc.outputs.transmitting).toBe(false);
    expect((await post({ type: 'output.transmit', on: true })).json.error).toMatch(/régie/);
    expect(svc.outputs.transmitting).toBe(false);
    expect((await fetch(`${base}/cmd?t=bad`, { method: 'POST', body: '{}' })).status).toBe(403);

    const ctrl = new AbortController();
    const res = await fetch(`${base}/events?t=${token}`, { signal: ctrl.signal });
    const first = new TextDecoder().decode((await res.body!.getReader().read()).value);
    const state = JSON.parse(first.replace(/^data: /, '')) as { blackout: boolean; transmitting: boolean; lists: unknown[] };
    expect(state).toMatchObject({ blackout: true, transmitting: false });
    expect(state.lists.length).toBe(svc.getProject().cueLists.length);
    ctrl.abort();

    await svc.execute({ type: 'settings.update', settings: { ...defaultSettings(), control: { ...s.control, remote: { enabled: false, port, token } } } });
    await expect(fetch(`${base}/?t=${token}`)).rejects.toThrow();
    await svc.dispose();
  });
});
