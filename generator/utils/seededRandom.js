/**
 * Seeded random numbers (mulberry32). Every generation stage uses its OWN stream, forked from the main seed by name, so a
 * change in how many numbers one stage uses can never shift the numbers of another stage. Same seed => same data.
 */
function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class Rng {
  constructor(seed, label = 'root') {
    this.baseSeed = seed;
    this.label = label;
    this.state = hashString(`${seed}:${label}`) || 1;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Independent stream for a named stage or purpose. */
  fork(label) {
    return new Rng(this.baseSeed, `${this.label}/${label}`);
  }

  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p) {
    return this.next() < p;
  }

  pick(list) {
    return list[Math.floor(this.next() * list.length)];
  }

  /** pairs: [[value, weight], ...]. Weights need not add up to 1. */
  weighted(pairs) {
    const total = pairs.reduce((s, [, w]) => s + w, 0);
    let roll = this.next() * total;
    for (const [value, weight] of pairs) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return pairs[pairs.length - 1][0];
  }

  shuffle(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  digits(n) {
    let out = '';
    for (let i = 0; i < n; i += 1) out += Math.floor(this.next() * 10);
    return out;
  }

  letters(n) {
    let out = '';
    for (let i = 0; i < n; i += 1) out += String.fromCharCode(65 + Math.floor(this.next() * 26));
    return out;
  }
}

const createRng = (seed) => new Rng(seed);

module.exports = { Rng, createRng, hashString };
