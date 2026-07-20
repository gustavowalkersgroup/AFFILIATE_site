import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationStatusClause } from '../src/control.js';

test('conversationStatusClause: optout filtra só quem saiu', () => {
  assert.equal(conversationStatusClause('optout'), "status = 'optout'");
});

test('conversationStatusClause: optin filtra quem NÃO saiu', () => {
  assert.equal(conversationStatusClause('optin'), "status IS DISTINCT FROM 'optout'");
});

test('conversationStatusClause: sem filtro (undefined) não filtra nada', () => {
  assert.equal(conversationStatusClause(undefined), '1=1');
});

test('conversationStatusClause: valor desconhecido cai no "sem filtro"', () => {
  assert.equal(conversationStatusClause('lixo'), '1=1');
});
