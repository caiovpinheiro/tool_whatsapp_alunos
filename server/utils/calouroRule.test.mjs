import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCalouro } from './calouroRule.js';

test('Graduação sem Data de Rematrícula → Sim', () => {
  assert.equal(resolveCalouro({ nivel: 'Graduação', dataRematricula: '' }), 'Sim');
  assert.equal(resolveCalouro({ nivel: 'GRADUAÇÃO', dataRematricula: null }), 'Sim');
  assert.equal(resolveCalouro({ nivel: 'Graduação', dataRematricula: '   ' }), 'Sim');
});

test('Graduação com Data de Rematrícula → Não', () => {
  assert.equal(resolveCalouro({ nivel: 'Graduação', dataRematricula: '2026-08-01' }), 'Não');
  assert.equal(resolveCalouro({ nivel: 'GRADUACAO', dataRematricula: '01/08/2026' }), 'Não');
});

test('Pós-Graduação com ou sem data → null (não grava)', () => {
  assert.equal(resolveCalouro({ nivel: 'Pós-Graduação', dataRematricula: '' }), null);
  assert.equal(resolveCalouro({ nivel: 'PÓS-GRADUAÇÃO', dataRematricula: '2026-08-01' }), null);
});

test('nível vazio ou não identificado → null', () => {
  assert.equal(resolveCalouro({ nivel: '', dataRematricula: '' }), null);
  assert.equal(resolveCalouro({ nivel: undefined, dataRematricula: '2026-08-01' }), null);
  assert.equal(resolveCalouro({ nivel: 'Colégio', dataRematricula: '' }), null);
  assert.equal(resolveCalouro(), null);
});
