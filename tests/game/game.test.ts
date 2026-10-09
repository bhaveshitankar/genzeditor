import { describe, it, expect, vi } from 'vitest';
import { applyOp, createGameDoc, parseGameDoc, serializeGameDoc } from '../../src/editors/game/types';
import { SPRITES, normEntity, newEntity, sortedEntities, docThumbnail } from '../../src/editors/game/art';
import { STARTERS } from '../../src/editors/game/templates';
import { ARENAS } from '../../src/editors/game/arenas';
import { createSfx } from '../../src/editors/game/sfx';

describe('game doc', () => {
  it('migrates legacy emoji sprites to built-in SVG art and keeps custom ones', () => {
    const old = {
      version: 1, template: 'platformer', meta: { title: 'Old' },
      settings: { gravity: 1800, jump: 620, speed: 220, lives: 3, tileSize: 32 },
      level: { cols: 4, rows: 4, tiles: new Array(16).fill('empty'), entities: [] },
      assets: { sprites: { ground: '🟫', coin: '🪙', player: '🦊' } },
    };
    const d = parseGameDoc(JSON.stringify(old));
    expect(d.assets.sprites.ground).toBe(SPRITES.ground);
    expect(d.assets.sprites.coin).toBe(SPRITES.coin);
    expect(d.assets.sprites.player).toBe('🦊');
    expect(d.level.cols).toBe(4);
    expect(parseGameDoc(serializeGameDoc(d))).toEqual(d);
  });

  it('applies entity ops compatible with the room protocol', () => {
    const d = createGameDoc('platformer', 't');
    const e = newEntity('mover', 2, 3);
    applyOp(d, { t: 'entity.add', e });
    applyOp(d, { t: 'entity.move', id: e.id, x: 5, y: 6 });
    expect(d.level.entities[0]).toMatchObject({ x: 5, y: 6, type: 'mover' });
    applyOp(d, { t: 'entity.del', id: e.id });
    expect(d.level.entities).toHaveLength(0);
  });

  it('normalizes entity props with prefab defaults and tolerates bare entities', () => {
    const n = normEntity({ id: 'a', type: 'platform', x: 0, y: 0 });
    expect(n).toMatchObject({ w: 3, behavior: 'solid', motion: 'none' });
    expect(normEntity({ id: 'b', type: 'unknown', x: 0, y: 0, props: { behavior: 'bogus' } }).behavior).toBe('none');
    const d = createGameDoc('platformer', 't');
    d.level.entities.push(newEntity('cloud', 0, 0), newEntity('crate', 0, 0));
    expect(sortedEntities(d)[0]!.type).toBe('cloud');
  });

  it('ships valid starters, arenas and thumbnails', () => {
    for (const s of STARTERS) {
      const d = s.make();
      expect(d.level.tiles).toHaveLength(d.level.cols * d.level.rows);
      expect(d.level.tiles).toContain('start');
      expect(docThumbnail(d)).toMatch(/^data:image\/svg\+xml/);
    }
    for (const a of ARENAS) expect(a.make().template).toBe('racer');
  });
});

describe('sfx', () => {
  it('is a safe no-op without WebAudio', () => {
    const s = createSfx('retro');
    expect(() => { s.play('coin'); s.setPreset('off'); s.play('jump'); s.close(); }).not.toThrow();
  });
});

describe('GameEditor smoke', () => {
  it('opens a starter doc, renders panels and enters/leaves play', async () => {
    const noop = new Proxy(function () {}, { get: () => () => ({}), apply: () => ({}) });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    HTMLCanvasElement.prototype.getContext = (() => noop) as never;
    window.matchMedia = (() => ({ matches: false })) as never;
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const { GameEditor } = await import('../../src/editors/GameEditor');
    const host = document.createElement('div');
    document.body.append(host);
    const fake = (t: string) => ({ text: async () => t }) as unknown as Blob;
    const blob = fake(serializeGameDoc(STARTERS[0]!.make()));
    const ed = await GameEditor.open(host, blob, 'x.game');
    expect(host.querySelector('.ge-stage')).toBeTruthy();
    expect(host.querySelectorAll('.ge-asset').length).toBeGreaterThan(3);
    (host.querySelector('.ge-play-btn') as HTMLElement).click();
    expect(host.querySelector('.ge-playview')).toBeTruthy();
    (host.querySelector('.ge-hud-btn:last-child') as HTMLElement).click();
    expect(host.querySelector('.ge-playview')).toBeFalsy();
    expect((await ed.export())!.contentType).toBe('application/json');
    ed.destroy();
    const empty = await GameEditor.open(host, fake(''), 'y.game');
    expect(host.querySelectorAll('.ge-card').length).toBeGreaterThanOrEqual(8);
    empty.destroy();
  });
});
