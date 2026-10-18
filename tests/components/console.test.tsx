// @vitest-environment jsdom
import { render, screen, fireEvent, act as rtlAct } from '@testing-library/react';
import { vi } from 'vitest';
import { LiveConsole } from '../../src/renderer/features/LiveConsole';
import { useStore } from '../../src/renderer/store';
import { validatePatch } from '../../src/core/fixtures/patch';
import { ProfileLibrary } from '../../src/core/fixtures/profiles';
import { demoProject } from '../helpers';

const invoke = vi.fn(async (_cmd: unknown) => ({ ok: true, data: { applied: 1, rejected: [] } }));

beforeEach(() => {
  invoke.mockClear();
  (window as unknown as { luma: unknown }).luma = { invoke, on: () => () => undefined };
  const project = demoProject();
  useStore.setState({
    project: { project, path: null, dirty: false, revision: 1, issues: validatePatch(new ProfileLibrary(), project.patch), sceneHistory: { undo: 0, redo: 0 } },
    runtime: null,
    values: {},
    sources: {},
    selection: [],
  });
});

describe('Live Console', () => {
  it('génère les contrôles à partir du profil : PAR sans position, lyre avec position et roue de couleurs', () => {
    render(<LiveConsole />);
    fireEvent.click(screen.getByText('PAR 1'));
    expect(screen.getByText('Couleur')).toBeInTheDocument();
    expect(screen.queryByText('Position')).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Rouge' })).toBeInTheDocument();

    fireEvent.click(screen.getByText('Spot 1'));
    expect(screen.getByText('Position')).toBeInTheDocument();
    expect(screen.getByText('Pan (16 bits)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Violet/ })).toBeInTheDocument(); // colour-wheel slot from the profile
    expect(screen.queryByRole('slider', { name: 'Rouge' })).not.toBeInTheDocument(); // no RGB channels on the spot
    expect(screen.getByRole('button', { name: /Reset/ })).toHaveClass('danger'); // special function flagged
  });

  it('envoie au moteur une commande typée pour la sélection (pas de paquet DMX côté interface)', async () => {
    render(<LiveConsole />);
    fireEvent.click(screen.getByText('Pars'));
    await rtlAct(async () => {
      fireEvent.click(screen.getByTitle('#FF0000'));
    });
    expect(invoke).toHaveBeenCalledWith({ type: 'programmer.setColor', fixtureIds: ['par1', 'par2', 'rgbw'], color: '#FF0000' });
    await rtlAct(async () => {
      fireEvent.change(screen.getByTestId('dimmer-fader'), { target: { value: '128' } });
    });
    expect(invoke).toHaveBeenCalledWith({ type: 'programmer.set', fixtureIds: ['par1', 'par2', 'rgbw'], values: { dimmer: 128 / 255 }, confirmSpecial: false });
  });

  it('une fonction spéciale demande confirmation avant envoi', async () => {
    render(<LiveConsole />);
    fireEvent.click(screen.getByText('Spot 1'));
    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));
    expect(useStore.getState().confirm?.title).toBe('Fonction spéciale');
    expect(invoke).not.toHaveBeenCalled();
    await rtlAct(async () => useStore.getState().confirm!.resolve(true));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ type: 'programmer.set', fixtureIds: ['spot1'], confirmSpecial: true }));
  });
});
