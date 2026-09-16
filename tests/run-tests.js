'use strict';

const assert = require('assert');
const api = require('../app.js');

const player = (id, seed) => ({ id, name: id.toUpperCase(), active: true, seed });
const match = (id, a, b, games, confirmed = true) => ({ id, p1Id: a, p2Id: b, games, confirmed, isBye: false, rematch: false });
const bye = (id, a) => ({ id, p1Id: a, p2Id: null, games: [], confirmed: true, isBye: true, rematch: false });

function base(n) {
  const s = api.defaultState();
  s.status = 'active'; s.settings.name = 'Test'; s.players = Array.from({length:n}, (_,i) => player(String.fromCharCode(97+i),i));
  return s;
}

function round(number, pairings) { return { number, status: 'complete', pairings }; }
function keys(pairing) { return pairing.pairs.map(p => [p.p1Id,p.p2Id].sort().join('-')); }

assert(api.validFinishedGames(['a','a']));
assert(api.validFinishedGames(['a','b','a']));
assert(api.validFinishedGames(['b','a','a']));
assert(!api.validFinishedGames(['a','a','b']));
assert(!api.validFinishedGames(['a','b']));

for (const n of [4,5,8]) {
  const s = base(n); const p = api.generatePairing(s);
  assert.equal(p.pairs.length, Math.floor(n/2));
  assert.equal(Boolean(p.bye), n % 2 === 1);
  const used = new Set(p.pairs.flatMap(x => [x.p1Id,x.p2Id])); if (p.bye) used.add(p.bye.id);
  assert.equal(used.size, n);
}

// 2-0 / 2-1 / W-L-W / L-W-W statistics.
{
  const s=base(4); s.rounds=[round(1,[match('m1','a','b',['a','a']),match('m2','c','d',['c','d','c'])]),round(2,[match('m3','a','c',['c','a','a']),match('m4','b','d',['b','d','b'])])];
  const st=api.deriveStats(s);
  assert.equal(st.get('a').twoZeroWins,1); assert.equal(st.get('a').lwwWins,1);
  assert.equal(st.get('c').wlwWins,1); assert.equal(st.get('b').wlwWins,1);
  assert.equal(st.get('a').gameDiff,3);
}

// BYE fairness and a dropped player excluded.
{
  const s=base(6); s.rounds=[round(1,[match('m1','a','b',['a','a']),match('m2','c','d',['c','c']),bye('x','e')])];
  s.players.find(p=>p.id==='d').active=false;
  const p=api.generatePairing(s); const used=new Set(p.pairs.flatMap(x=>[x.p1Id,x.p2Id])); if(p.bye)used.add(p.bye.id);
  assert(!used.has('d')); assert(p.bye); assert.notEqual(p.bye.id,'e');
}

// Global rematch avoidance: round two must use a different perfect matching.
{
  const s=base(4); s.rounds=[round(1,[match('m1','a','b',['a','a']),match('m2','c','d',['c','c'])])];
  const result=api.generatePairing(s); assert(!result.pairs.some(p=>p.rematch));
  assert(!keys(result).includes('a-b')); assert(!keys(result).includes('c-d'));
}

// W-L-W tendency is used only after equal points and non-rematch conditions.
{
  const s=base(8);
  s.rounds=[round(1,[
    match('m1','a','e',['a','e','a']), match('m2','b','f',['b','f','b']),
    match('m3','c','g',['c','c']), match('m4','d','h',['d','d'])
  ])];
  for (const id of ['e','f','g','h']) s.players.find(p=>p.id===id).active=false;
  const result=api.generatePairing(s); const pairKeys=keys(result);
  assert(pairKeys.includes('a-b')); assert(pairKeys.includes('c-d'));
}

// Result correction recalculates every derived value.
{
  const s=base(2); const m=match('m','a','b',['a','a']); s.rounds=[round(1,[m])];
  assert.equal(api.deriveStats(s).get('a').matchPoints,3);
  m.games=['b','a','b']; const corrected=api.deriveStats(s);
  assert.equal(corrected.get('a').matchPoints,0); assert.equal(corrected.get('b').matchPoints,3); assert.equal(corrected.get('b').wlwWins,1);
}

// JSON export/import equivalent round trip and invalid participant rejection.
{
  const s=base(4); s.rounds=[round(1,[match('m1','a','b',['a','b','a']),match('m2','c','d',['d','d'])])];
  const restored=JSON.parse(JSON.stringify(s)); assert(api.validateImport(restored).ok); assert.deepStrictEqual(restored,s);
  restored.rounds[0].pairings[0].games[0]='ghost'; assert(!api.validateImport(restored).ok);
}

// LocalStorage-equivalent string persistence.
{
  const s=base(8); const stored=JSON.stringify(s); const restored=JSON.parse(stored);
  assert(api.validateImport(restored).ok); assert.equal(restored.players.length,8);
}

console.log('All Swiss Draw tests passed.');
