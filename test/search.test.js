import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesSearch } from '../public/search.js';

const event = { title: 'Reunião semanal da equipe', description: 'Apresentação do projeto escolar' };

test('busca por palavras em qualquer ordem, sem acentos e com letras maiúsculas', () => {
  assert.equal(matchesSearch(event, 'EQUIPE reuniao'), true);
  assert.equal(matchesSearch(event, 'reuniao equipe'), true);
});

test('busca partes de palavras no título e na descrição', () => {
  assert.equal(matchesSearch(event, 'escol reun'), true);
  assert.equal(matchesSearch(event, 'apresentacao projeto'), true);
});

test('aceita espaços e pontuação e exige todas as palavras', () => {
  assert.equal(matchesSearch(event, '  equipe,   projeto! '), true);
  assert.equal(matchesSearch(event, 'equipe dentista'), false);
  assert.equal(matchesSearch(event, 'dentista'), false);
});

test('busca vazia mostra os compromissos e campos ausentes não causam erro', () => {
  assert.equal(matchesSearch(event, ''), true);
  assert.equal(matchesSearch(event, '   '), true);
  assert.equal(matchesSearch({ title: 'Consulta' }, 'consulta'), true);
  assert.equal(matchesSearch({}, 'consulta'), false);
});
