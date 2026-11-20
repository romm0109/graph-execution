// Synthwave soundtrack, 53 s, 110 BPM, stereo 44.1k WAV.
const fs = require('fs');
const SR = 44100, DUR = 53, N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);
const BPM = 110, BEAT = 60 / BPM, BAR = BEAT * 4;
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
// Am  F  C  G  (2 bars each)
const CH = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
const chordAt = t => CH[Math.floor(t / (BAR * 2)) % 4];
const CUTS = [5.0, 11.2, 16.5, 28.9, 36.2, 41.4, 46.4];
let seed = 1; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const saw = p => 2 * (p - Math.floor(p + .5));
function add(i, l, r) { if (i >= 0 && i < N) { L[i] += l; R[i] += r; } }
// pads: detuned saws through one-pole lowpass, per chord segment
{
  let lp = [0, 0], ph = new Float64Array(12);
  for (let i = 0; i < N; i++) {
    const t = i / SR, ch = chordAt(t);
    const segT = t % (BAR * 2), env = Math.min(1, segT / .6) * Math.min(1, (BAR * 2 - segT) / .4 + .3);
    let sl = 0, sr = 0;
    ch.concat([ch[0] - 12]).forEach((m, k) => {
      for (let d = 0; d < 3; d++) {
        const idx = k * 3 + d, f = mtof(m) * (1 + (d - 1) * .004);
        ph[idx] += f / SR; const v = saw(ph[idx]);
        if (d === 0) sl += v; else if (d === 2) sr += v; else { sl += v * .5; sr += v * .5; }
      }
    });
    const open = 0.04 + 0.05 * (t > 16.5 && t < 46.4 ? 1 : 0) + .02 * Math.sin(t * .7);
    lp[0] += open * (sl - lp[0]); lp[1] += open * (sr - lp[1]);
    let vol = .055 * env;
    if (t > 46.4) vol *= Math.max(0, 1 - (t - 50) / 3);
    add(i, lp[0] * vol, lp[1] * vol);
  }
}
const drumsOn = t => t >= 5.0 && t < 46.4;
// kick
for (let b = 0; b * BEAT < DUR; b++) {
  const t0 = b * BEAT; if (!drumsOn(t0)) continue;
  const s0 = Math.floor(t0 * SR); let ph = 0;
  for (let j = 0; j < SR * .4; j++) {
    const tt = j / SR, f = 45 + 120 * Math.exp(-tt * 30); ph += f / SR;
    const v = Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 7) * .5;
    add(s0 + j, v, v);
  }
}
// sidechain duck applied later via envelope
// hats + snare
for (let s = 0; s * BEAT / 2 < DUR; s++) {
  const t0 = s * BEAT / 2; if (!(t0 >= 11.2 && t0 < 46.4)) continue;
  const s0 = Math.floor(t0 * SR), off = s % 2 === 1;
  let hp = 0, prev = 0;
  for (let j = 0; j < SR * .06; j++) {
    const n = rnd() * 2 - 1; hp = .95 * (hp + n - prev); prev = n;
    const v = hp * Math.exp(-j / SR * 60) * (off ? .07 : .03);
    add(s0 + j, v * .8, v);
  }
  if (s % 4 === 2 && t0 >= 16.5) { // snare on 2 & 4
    for (let j = 0; j < SR * .25; j++) {
      const tt = j / SR, n = rnd() * 2 - 1;
      const v = (n * .6 + Math.sin(2 * Math.PI * 190 * tt) * .4) * Math.exp(-tt * 16) * .16;
      add(s0 + j, v, v);
    }
  }
}
// bass: eighth-note roots, plucky
{
  let ph = 0, lp = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR; if (!drumsOn(t)) { lp *= .999; continue; }
    const ch = chordAt(t), f = mtof(ch[0] - 24 + (ch[0] < 50 ? 12 : 0));
    const e = (t % (BEAT / 2)) / (BEAT / 2);
    ph += f / SR; const v = saw(ph);
    const cut = .02 + .12 * Math.exp(-e * 5);
    lp += cut * (v - lp);
    const o = lp * .16 * Math.min(1, e * 40) * (1 - e * .5);
    add(i, o, o);
  }
}
// arp: 16ths during the run + gates
{
  let lp = 0;
  for (let s = 0; s * BEAT / 4 < DUR; s++) {
    const t0 = s * BEAT / 4; if (!(t0 >= 16.5 && t0 < 41.4)) continue;
    const ch = chordAt(t0), pat = [0, 1, 2, 1, 0, 2, 1, 2];
    const m = ch[pat[s % 8]] + 12 + (s % 16 >= 8 ? 12 : 0);
    const f = mtof(m), s0 = Math.floor(t0 * SR);
    for (let j = 0; j < SR * .14; j++) {
      const tt = j / SR, v = (saw(f * tt) * .5 + Math.sin(2 * Math.PI * f * tt) * .5) * Math.exp(-tt * 18) * .05;
      const pan = .5 + .35 * Math.sin(s * .7);
      add(s0 + j, v * (1 - pan) * 2, v * pan * 2);
    }
  }
}
// risers into cuts + impacts on cuts
for (const c of CUTS) {
  const rl = 1.4, s0 = Math.floor((c - rl) * SR);
  let lp = 0;
  for (let j = 0; j < rl * SR; j++) {
    const k = j / (rl * SR), n = rnd() * 2 - 1;
    lp += (.02 + .5 * k * k) * (n - lp);
    const v = lp * k * k * .13;
    add(s0 + j, v, v * .9);
  }
  const s1 = Math.floor(c * SR); let ph = 0;
  for (let j = 0; j < SR * 1.6; j++) {
    const tt = j / SR; ph += (38 + 60 * Math.exp(-tt * 8)) / SR;
    const v = Math.sin(2 * Math.PI * ph) * Math.exp(-tt * 2.6) * .32 + (rnd() * 2 - 1) * Math.exp(-tt * 20) * .08;
    add(s1 + j, v, v);
  }
}
// intro shimmer: logo reveal chime
[1.4, 2.1].forEach((t0, n) => {
  const s0 = Math.floor(t0 * SR);
  [69, 76, 81, 88].forEach((m, k) => {
    const f = mtof(m + n * 0);
    for (let j = 0; j < SR * 2.5; j++) { const tt = j / SR; const v = Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 2.2) * .04; add(s0 + j + k * 900, v * (k % 2 ? .6 : 1), v * (k % 2 ? 1 : .6)); }
  });
});
// final hit at outro
{
  const s0 = Math.floor(46.4 * SR);
  [45, 57, 64, 69, 76].forEach((m, k) => { const f = mtof(m); for (let j = 0; j < SR * 6; j++) { const tt = j / SR; const v = (saw(f * tt * 1.002) * .3 + Math.sin(2 * Math.PI * f * tt)) * Math.exp(-tt * .7) * .03; add(s0 + j, v, v); } });
}
// simple stereo delay/reverb-ish
const D = Math.floor(BEAT * .75 * SR);
for (let i = D; i < N; i++) { L[i] += R[i - D] * .22; R[i] += L[i - D] * .22; }
// sidechain duck on kick beats, master fade, soft clip
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const t = i / SR;
  let g = Math.min(1, t / .5) * Math.min(1, (DUR - t) / 1.2);
  let l = Math.tanh(L[i] * 1.6 * g) * .9, r = Math.tanh(R[i] * 1.6 * g) * .9;
  buf.writeInt16LE(Math.round(l * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
}
fs.writeFileSync(require('path').join(__dirname, 'music.wav'), buf);
console.log('wrote music.wav');
