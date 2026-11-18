/** Read-only board classification primitives. */
const strip = (text) => text.replace(/```[^\n]*\n[\s\S]*?```/g, '\n');
const BANNED = [
    ['percentage', /\b\d+(?:\.\d+)?\s?%/g],
    ['coverage', /\b(coverage|covered)\b/gi],
    ['readiness', /\b(readiness|ready rate|pass rate|failure rate|success rate)\b/gi],
    [
        'gate',
        /\b(gate|gates|exit code|exit-code|green build|ci (?:passes|is green)|checks? pass(?:ed)?)\b/gi,
    ],
    [
        'provenance',
        /\b(provenance|audit trail|historical catalog|revision history|changelog|previously delivered|prior cycle)\b/gi,
    ],
    ['counter', /\b(counters?|totals?|how many)\b/gi],
];
export const banned = (text) => BANNED.flatMap(([name, re]) => [...text.matchAll(re)].map((match) => `${name}: ${match[0]}`)).slice(0, 8);
const STOP = new Set('the and for with that this from into when then than are was were must shall may can its it a an of to in on or as is be not never no without cannot issue title task epic'.split(' '));
export const terms = (text, limit = 200) => [
    ...new Set(strip(text)
        .replace(/^#{1,6}.*$/gm, ' ')
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOP.has(word) && !/^\d+$/.test(word))),
].slice(0, limit);
