import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spin, buildWarmerMessage,
  pickPair, pickOne, openThread, advanceThread,
  parseWindow, withinWindow, effectiveCap,
  extractConnectedChips, filterAllowed, parseTargets,
} from '../src/warmer.js';
import { OPENERS, REPLIES, FOLLOWUPS, CLOSERS } from '../src/warmer-phrases.js';

// ----- Task 1: spin + buildWarmerMessage -----

test('spin resolve {a|b|c} para uma das opcoes', () => {
  for (let i = 0; i < 50; i++) {
    const out = spin('{oi|opa|e ai}');
    assert.ok(['oi', 'opa', 'e ai'].includes(out), `inesperado: ${out}`);
  }
});

test('spin deixa texto sem chaves intacto', () => {
  assert.equal(spin('tudo bem'), 'tudo bem');
});

test('bancos de frases nao estao vazios', () => {
  for (const arr of [OPENERS, REPLIES, FOLLOWUPS, CLOSERS]) {
    assert.ok(Array.isArray(arr) && arr.length >= 3);
  }
});

test('buildWarmerMessage retorna texto nao-vazio sem chaves residuais', () => {
  for (const stage of ['open', 'reply', 'followup', 'close']) {
    const msg = buildWarmerMessage(stage);
    assert.ok(typeof msg === 'string' && msg.length > 0, `stage ${stage} vazio`);
    assert.ok(!/[{}]/.test(msg), `stage ${stage} deixou chaves: ${msg}`);
  }
});

// ----- Task 2: pickPair / openThread / advanceThread -----

const CHIPS = [
  { instance: 'chip-1', jid: '5511111111111@s.whatsapp.net' },
  { instance: 'chip-2', jid: '5522222222222@s.whatsapp.net' },
  { instance: 'chip-3', jid: '5533333333333@s.whatsapp.net' },
];

test('pickPair retorna dois chips distintos', () => {
  for (let i = 0; i < 50; i++) {
    const { a, b } = pickPair(CHIPS);
    assert.notEqual(a.instance, b.instance);
  }
});

test('pickPair lanca com menos de 2 chips', () => {
  assert.throws(() => pickPair([CHIPS[0]]));
});

test('openThread cria thread com target entre 3 e 8 e turn=a', () => {
  const t = openThread(CHIPS[0], CHIPS[1]);
  assert.equal(t.aInst, 'chip-1');
  assert.equal(t.bInst, 'chip-2');
  assert.equal(t.turn, 'a');
  assert.equal(t.exchanges, 0);
  assert.ok(t.target >= 3 && t.target <= 8);
});

test('advanceThread: primeira fala vem de a como open e alterna turn', () => {
  const t = openThread(CHIPS[0], CHIPS[1]);
  const { thread, send } = advanceThread(t);
  assert.equal(send.stage, 'open');
  assert.equal(send.fromInst, 'chip-1');
  assert.equal(send.toJid, CHIPS[1].jid);
  assert.equal(thread.turn, 'b');
  assert.equal(thread.exchanges, 1);
});

test('advanceThread: segunda fala vem de b como reply', () => {
  let t = openThread(CHIPS[0], CHIPS[1]);
  t.target = 8;
  t = advanceThread(t).thread;           // open (A)
  const { thread, send } = advanceThread(t); // reply (B)
  assert.equal(send.stage, 'reply');
  assert.equal(send.fromInst, 'chip-2');
  assert.equal(send.toJid, CHIPS[0].jid);
  assert.equal(thread.turn, 'a');
});

test('advanceThread fecha a thread no target e envia close', () => {
  let t = openThread(CHIPS[0], CHIPS[1]);
  t.target = 3;
  let last;
  for (let i = 0; i < 3; i++) {
    const r = advanceThread(t);
    last = r;
    t = r.thread;
  }
  assert.equal(last.send.stage, 'close');
  assert.equal(last.thread, null);
});

// ----- Task 3: parseWindow / withinWindow / effectiveCap -----

test('parseWindow le HH:MM-HH:MM', () => {
  assert.deepEqual(parseWindow('07:00-23:00', null), { startH: 7, startM: 0, endH: 23, endM: 0 });
});

test('parseWindow cai no fallback se invalido', () => {
  const fb = { startH: 8, startM: 0, endH: 22, endM: 0 };
  assert.deepEqual(parseWindow('lixo', fb), fb);
});

test('withinWindow respeita inicio inclusivo e fim exclusivo', () => {
  const w = { startH: 7, startM: 0, endH: 23, endM: 0 };
  assert.equal(withinWindow(w, 7 * 60), true);      // 07:00 dentro
  assert.equal(withinWindow(w, 22 * 60 + 59), true); // 22:59 dentro
  assert.equal(withinWindow(w, 23 * 60), false);     // 23:00 fora
  assert.equal(withinWindow(w, 6 * 60 + 59), false); // 06:59 fora
});

test('effectiveCap: cap 0 = sem teto (Infinity)', () => {
  assert.equal(effectiveCap(0, 0, 0), Infinity);
  assert.equal(effectiveCap(0, 7, 3), Infinity);
});

test('effectiveCap: sem ramp devolve o cap cheio', () => {
  assert.equal(effectiveCap(50, 0, 0), 50);
});

test('effectiveCap: ramp linear sobe ate o cap', () => {
  assert.equal(effectiveCap(100, 10, 0), 10);
  assert.equal(effectiveCap(100, 10, 9), 100);
  assert.ok(effectiveCap(100, 10, 4) > 10 && effectiveCap(100, 10, 4) < 100);
});

// ----- Task 4: extractConnectedChips -----

test('extractConnectedChips: formato com wrapper instance{}', () => {
  const raw = [
    { instance: { instanceName: 'chip-1', owner: '5511111111111@s.whatsapp.net', connectionStatus: 'open' } },
    { instance: { instanceName: 'chip-2', owner: '5522222222222@s.whatsapp.net', connectionStatus: 'close' } },
  ];
  const chips = extractConnectedChips(raw);
  assert.equal(chips.length, 1);
  assert.deepEqual(chips[0], { instance: 'chip-1', jid: '5511111111111@s.whatsapp.net' });
});

test('extractConnectedChips: formato plano name/ownerJid', () => {
  const raw = [
    { name: 'chip-a', ownerJid: '5599999999999@s.whatsapp.net', connectionStatus: 'open' },
  ];
  const chips = extractConnectedChips(raw);
  assert.deepEqual(chips, [{ instance: 'chip-a', jid: '5599999999999@s.whatsapp.net' }]);
});

test('extractConnectedChips: descarta sem jid ou desconectado e lida com null', () => {
  assert.deepEqual(extractConnectedChips(null), []);
  const raw = [{ name: 'x', connectionStatus: 'open' }]; // sem ownerJid
  assert.deepEqual(extractConnectedChips(raw), []);
});

test('extractConnectedChips: formato real Evolution v1.8.6 (instance.status=open)', () => {
  const raw = [
    { instance: { instanceName: 'AFFILIATES', owner: '5519953235071@s.whatsapp.net', status: 'open' } },
    { instance: { instanceName: 'morto', owner: '5511000000000@s.whatsapp.net', status: 'close' } },
  ];
  const chips = extractConnectedChips(raw);
  assert.deepEqual(chips, [{ instance: 'AFFILIATES', jid: '5519953235071@s.whatsapp.net' }]);
});
test('filterAllowed: csv vazio devolve todos', () => {
  const chips = [{ instance: 'a', jid: 'x' }, { instance: 'b', jid: 'y' }];
  assert.deepEqual(filterAllowed(chips, ''), chips);
  assert.deepEqual(filterAllowed(chips, null), chips);
});

test('filterAllowed: csv restringe e ignora espacos', () => {
  const chips = [{ instance: 'a', jid: 'x' }, { instance: 'b', jid: 'y' }, { instance: 'c', jid: 'z' }];
  assert.deepEqual(filterAllowed(chips, ' a , c '), [{ instance: 'a', jid: 'x' }, { instance: 'c', jid: 'z' }]);
});

// ----- Task 5: pickOne / parseTargets (numeros-alvo de fora do mesh) -----

test('pickOne sorteia um item da lista', () => {
  const list = ['a', 'b', 'c'];
  for (let i = 0; i < 30; i++) {
    assert.ok(list.includes(pickOne(list)));
  }
});

test('pickOne com rnd injetado escolhe o indice esperado', () => {
  const list = ['a', 'b', 'c'];
  assert.equal(pickOne(list, () => 0), 'a');
  assert.equal(pickOne(list, () => 0.99), 'c');
});

test('parseTargets normaliza CSV de numeros para {phone,jid}', () => {
  const out = parseTargets('5519999999999, 11988887777');
  assert.deepEqual(out, [
    { phone: '5519999999999', jid: '5519999999999@s.whatsapp.net' },
    { phone: '5511988887777', jid: '5511988887777@s.whatsapp.net' },
  ]);
});

test('parseTargets descarta numeros invalidos e ignora vazio', () => {
  assert.deepEqual(parseTargets(''), []);
  assert.deepEqual(parseTargets(null), []);
  assert.deepEqual(parseTargets('abc, , 123'), []);
});