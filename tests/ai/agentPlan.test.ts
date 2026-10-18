import { describe, it, expect } from 'vitest';
import {
  applyPrefs, arrangeSong, buildPlan, DEFAULT_PREFS, heuristicIntent, parseLyrics, sanitizeContext, sanitizeIntent, splitIntoChunks,
  type RouteContext,
} from '../../src/ai/agentPlan';

const ctx = (over: Partial<RouteContext> = {}): RouteContext => ({ attachments: [], ...over });
const opts = { byok: false, localVoice: false, attachments: [] };

describe('sanitizeIntent', () => {
  it('clamps everything the model returns', () => {
    const i = sanitizeIntent({ intent: 'format_disk', theme: 'x'.repeat(5000), tempo: 9999, key: 'Z', length: 'epic', scenes: 99, language: 'xx', aspect: 'weird', useAttachments: ['a1', 'evil'] },
      ctx({ attachments: [{ id: 'a1', kind: 'image', name: 'p.png' }] }));
    expect(i.intent).toBe('text');
    expect(i.theme.length).toBe(700);
    expect(i.tempo).toBe(160);
    expect(i.key).toBeUndefined();
    expect(i.length).toBe('medium');
    expect(i.scenes).toBe(12);
    expect(i.language).toBe('en');
    expect(i.aspect).toBeUndefined();
    expect(i.useAttachments).toEqual(['a1']);
  });
  it('refuses edit when nothing is open', () => {
    expect(sanitizeIntent({ intent: 'edit', theme: 'x' }, ctx()).intent).toBe('text');
    expect(sanitizeIntent({ intent: 'edit', theme: 'x' }, ctx({ editor: { kind: 'image' } })).intent).toBe('edit');
  });
  it('sanitizes context from the client', () => {
    const c = sanitizeContext({ attachments: Array.from({ length: 20 }, (_, k) => ({ id: `a${k}`, kind: 'exe', name: 'n\u0000ame', summary: 's'.repeat(2000), bpm: 9999 })), previous: 'p'.repeat(9999) });
    expect(c.attachments).toHaveLength(8);
    expect(c.attachments[0]!.kind).toBe('other');
    expect(c.attachments[0]!.name).toBe('n ame');
    expect(c.attachments[0]!.summary!.length).toBe(700);
    expect(c.attachments[0]!.bpm).toBeUndefined();
    expect(c.previous!.length).toBe(1500);
  });
});

describe('heuristicIntent', () => {
  it('routes creative requests', () => {
    expect(heuristicIntent('write a lofi song about rain', ctx()).intent).toBe('song');
    expect(heuristicIntent('write a lofi song about rain', ctx()).songMode).toBe('lyrics_melody');
    expect(heuristicIntent('just the lyrics for a birthday rap', ctx()).songMode).toBe('lyrics');
    expect(heuristicIntent('a chill instrumental for studying', ctx()).songMode).toBe('melody');
    expect(heuristicIntent('a chill instrumental melody for studying, short', ctx())).toMatchObject({ intent: 'song', songMode: 'melody', length: 'short' });
    expect(heuristicIntent('make a music video for my summer song', ctx()).intent).toBe('music_video');
    expect(heuristicIntent('a 6 scenes video about my shop', ctx()).scenes).toBe(6);
    expect(heuristicIntent('tell me a bedtime story about a fox', ctx()).intent).toBe('story_audio');
    expect(heuristicIntent('draw a logo of a fox, generate it', ctx()).intent).toBe('image');
    expect(heuristicIntent('a long audiobook-style story in spanish', ctx())).toMatchObject({ length: 'long', language: 'es' });
  });
  it('prefers editing the open file for edit verbs, creating for explicit "create"', () => {
    const e = ctx({ editor: { kind: 'image' } });
    expect(heuristicIntent('make it black and white', e).intent).toBe('edit');
    expect(heuristicIntent('create a new song about it', e).intent).toBe('song');
  });
  it('only continues when there is something to continue', () => {
    expect(heuristicIntent('continue the story', ctx()).continue).toBe(false);
    expect(heuristicIntent('continue the story', ctx({ previous: 'Part 1…' })).continue).toBe(true);
  });
  it('uses an attached song for a video', () => {
    expect(heuristicIntent('make a video for this song', ctx({ attachments: [{ id: 'a1', kind: 'audio', name: 's.mp3' }] })).intent).toBe('music_video');
  });
});

describe('applyPrefs / buildPlan', () => {
  const base = heuristicIntent('a song about the sea', ctx());
  it('tune overrides win', () => {
    const o = applyPrefs(base, { ...DEFAULT_PREFS, output: 'melody', length: 'long', style: 'epic', language: 'fr' });
    expect(o).toMatchObject({ intent: 'song', songMode: 'melody', length: 'long', language: 'fr' });
    expect(o.style).toContain('epic');
  });
  it('melody-only is free and needs no account', () => {
    const p = buildPlan(applyPrefs(base, { ...DEFAULT_PREFS, output: 'melody' }), DEFAULT_PREFS, opts);
    expect(p.units).toBe(0);
    expect(p.needsAuth).toBe(false);
    expect(p.steps.map((s) => s.type)).toEqual(['melody']);
  });
  it('a sung song writes, voices, composes and mixes', () => {
    const p = buildPlan({ ...base, songMode: 'lyrics_melody', length: 'medium' }, DEFAULT_PREFS, opts);
    expect(p.steps.map((s) => s.type)).toEqual(['lyrics', 'voice', 'melody', 'mix']);
    expect(p.units).toBe(3 + 3 * 2);
    expect(p.needsAuth).toBe(true);
  });
  it('on-device voice makes the voice step free', () => {
    const p = buildPlan({ ...base, songMode: 'lyrics_melody' }, { ...DEFAULT_PREFS, voice: 'local' }, { ...opts, localVoice: true });
    expect(p.steps.find((s) => s.type === 'voice')).toMatchObject({ cloud: false, units: 0 });
    // …but not for non-English
    const q = buildPlan({ ...base, songMode: 'lyrics_melody', language: 'es' }, { ...DEFAULT_PREFS, voice: 'local' }, { ...opts, localVoice: true });
    expect(q.steps.find((s) => s.type === 'voice')!.cloud).toBe(true);
  });
  it('long videos reuse images instead of blowing the daily budget', () => {
    const v = { ...heuristicIntent('make a long video about space', ctx()), length: 'long' as const };
    const free = buildPlan(v, DEFAULT_PREFS, opts);
    const imgs = free.steps.find((s) => s.type === 'images')!;
    expect(imgs.units).toBe(6 * 4);
    expect(free.units).toBeLessThan(60);
    expect(buildPlan(v, DEFAULT_PREFS, { ...opts, byok: true }).steps.find((s) => s.type === 'images')!.units).toBe(0);
  });
  it('the user’s own pictures replace generated ones', () => {
    const atts = [1, 2, 3, 4].map((n) => ({ id: `a${n}`, kind: 'image' as const, name: `${n}.jpg` }));
    const v = { ...heuristicIntent('make a video of my trip', ctx({ attachments: atts })), scenes: 4 };
    const p = buildPlan(v, DEFAULT_PREFS, { ...opts, attachments: atts });
    expect(p.steps.find((s) => s.type === 'images')).toMatchObject({ cloud: false, units: 0 });
    expect(p.steps.some((s) => s.type === 'describe')).toBe(true);
    expect(p.sendsOut.join()).toContain('photos');
  });
  it('an attached song needs no lyric/voice steps', () => {
    const atts = [{ id: 'a1', kind: 'audio' as const, name: 'track.mp3', bpm: 120 }];
    const p = buildPlan(heuristicIntent('make a video for this song', ctx({ attachments: atts })), DEFAULT_PREFS, { ...opts, attachments: atts });
    const t = p.steps.map((s) => s.type);
    expect(t).toContain('analyze');
    expect(t).not.toContain('lyrics');
    expect(t).not.toContain('voice');
  });
});

describe('lyrics helpers', () => {
  const lyrics = '[Verse 1]\nRain on the window, coffee in my hand\nSlow little morning\n\n[Chorus]\nOh, hold on to the rain\nOh, sing it again\n\n[Verse 2]\nStreetlights are fading\n[Bridge]\nOne more breath';
  it('parses labelled sections', () => {
    const s = parseLyrics(lyrics);
    expect(s.map((x) => x.label)).toEqual(['Verse 1', 'Chorus', 'Verse 2', 'Bridge']);
    expect(s[1]!.chorus).toBe(true);
    expect(s[3]!.bridge).toBe(true);
    expect(s[0]!.lines).toHaveLength(2);
  });
  it('splits an unlabelled wall of text into verse/chorus blocks', () => {
    const s = parseLyrics(Array.from({ length: 12 }, (_, k) => `line ${k}`).join('\n'));
    expect(s.map((x) => x.chorus)).toEqual([false, true, false]);
  });
  it('arranges by length and reuses the chorus', () => {
    const s = parseLyrics(lyrics);
    expect(arrangeSong(s, 'short').map((x) => x.label)).toEqual(['Verse 1', 'Chorus']);
    expect(arrangeSong(s, 'medium').map((x) => x.label)).toEqual(['Verse 1', 'Chorus', 'Verse 2', 'Chorus']);
    expect(arrangeSong(s, 'long').map((x) => x.src)).toEqual([0, 1, 2, 1, 3, 1]);
  });
  it('chunks text for TTS on sentence boundaries', () => {
    const c = splitIntoChunks('One two three. Four five six! Seven eight nine? Ten.', 20);
    expect(c.every((x) => x.length <= 32)).toBe(true);
    expect(c.join(' ')).toBe('One two three. Four five six! Seven eight nine? Ten.');
  });
});
