/**
 * Maps a fired event script onto the sound it plays.
 *
 * Counter-Strike does not send gunfire as `svc_sound`. Firing a weapon calls
 * `pfnPlaybackEvent`, so what crosses the wire is an index into the event
 * precache — `events/ak47.sc` — and it is the *client* that turns that into
 * `weapons/ak47-1.wav`. A demo therefore records the trigger but never the
 * sample, and this table is the lookup the client would have applied.
 *
 * Every entry was checked against the filenames actually shipped in
 * `cstrike/sound/weapons/`, so nothing here resolves to a missing file.
 */

/**
 * Fire sounds per event script. Where the game picks at random between takes,
 * all of them are listed and one is chosen deterministically — see `pick`.
 */
const FIRE_SOUNDS: Record<string, string[]> = {
  ak47: ['ak47-1.wav', 'ak47-2.wav'],
  aug: ['aug-1.wav'],
  awp: ['awp1.wav'],
  deagle: ['deagle-1.wav', 'deagle-2.wav'],
  // Both barrels of the Berettas share one sample.
  elite_left: ['elite_fire.wav'],
  elite_right: ['elite_fire.wav'],
  famas: ['famas-1.wav', 'famas-2.wav'],
  fiveseven: ['fiveseven-1.wav'],
  g3sg1: ['g3sg1-1.wav'],
  galil: ['galil-1.wav', 'galil-2.wav'],
  glock18: ['glock18-1.wav', 'glock18-2.wav'],
  m249: ['m249-1.wav', 'm249-2.wav'],
  m3: ['m3-1.wav'],
  // The silenced take is `m4a1-1.wav`. Whether the silencer is on rides in the
  // event's own arguments, which the delta does not reliably carry here, so
  // take the far more common unsilenced pair.
  m4a1: ['m4a1_unsil-1.wav', 'm4a1_unsil-2.wav'],
  mac10: ['mac10-1.wav'],
  mp5n: ['mp5-1.wav', 'mp5-2.wav'],
  p228: ['p228-1.wav'],
  p90: ['p90-1.wav'],
  scout: ['scout_fire-1.wav'],
  sg550: ['sg550-1.wav'],
  sg552: ['sg552-1.wav', 'sg552-2.wav'],
  tmp: ['tmp-1.wav', 'tmp-2.wav'],
  ump45: ['ump45-1.wav'],
  usp: ['usp1.wav'],
  xm1014: ['xm1014-1.wav']
}

/**
 * Event scripts that are deliberately silent. `createsmoke` spawns one puff of
 * a smoke cloud and fires dozens of times per grenade — the detonation itself
 * arrives separately as an `svc_sound`, so playing anything here would stack
 * dozens of copies of it.
 */
const SILENT = new Set(['createsmoke'])

/**
 * Resolves an event script to a sample path under the game's `sound/`.
 * `seed` chooses between alternate takes; passing something derived from the
 * cue keeps playback identical every time the same demo is watched.
 */
export function soundForEvent(script: string, seed: number): string | null {
  const name = script.replace(/^events\//, '').replace(/\.sc$/, '')
  if (SILENT.has(name)) return null
  const takes = FIRE_SOUNDS[name]
  if (!takes) return null
  return `weapons/${takes[takes.length === 1 ? 0 : Math.abs(Math.trunc(seed)) % takes.length]}`
}
