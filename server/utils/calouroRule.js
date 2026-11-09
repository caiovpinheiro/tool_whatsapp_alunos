import { normalizeNivelCrm } from './novoCrmFieldMapping.js';

/**
 * Campo Bwipo "Calouro" (SELECT Sim/Não), derivado da Data de Rematrícula.
 * Só Graduação (mesmo normalizeNivelCrm da etapa Grad/Pós):
 *   - Data de Rematrícula preenchida → 'Não'
 *   - vazia → 'Sim'
 * Pós-Graduação ou nível não identificado → null (não gravar).
 * @param {{ nivel?: unknown, dataRematricula?: unknown }} args
 * @returns {'Sim'|'Não'|null}
 */
export function resolveCalouro({ nivel, dataRematricula } = {}) {
  if (normalizeNivelCrm(nivel) !== 'Graduação') return null;
  return String(dataRematricula ?? '').trim() ? 'Não' : 'Sim';
}
