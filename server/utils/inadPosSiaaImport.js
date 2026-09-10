/**
 * Reparo do export SIAA "Relação de Alunos Inadimplentes por Polo".
 *
 * A 1ª linha da planilha é o título do relatório, então o parser genérico usa
 * o título como cabeçalho e a linha de cabeçalho real (ID_POLO, NOME_POL,
 * RGM_ALUN, NOME, …) entra como primeira linha de dados. Sem promover esse
 * cabeçalho, a coluna do RGM vira `col_2` e nenhuma identidade é indexada.
 *
 * O arquivo traz todos os polos concatenados e repete título + cabeçalho a
 * cada polo novo, então essas linhas também precisam sair dos dados.
 */

const digits = (v) => String(v ?? '').replace(/\D/g, '');

/**
 * O export repete o nome DESCRICA (tipo do título e descrição do portador),
 * então o import desambigua para DESCRICA / DESCRICA_2. Olhamos as duas para
 * não depender da ordem das colunas.
 */
const TIPO_TITULO_KEYS = ['DESCRICA', 'DESCRICA_2', 'DES_TITU'];

const normTexto = (v) =>
  String(v ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');

/**
 * O relatório por polo lista qualquer título em aberto: além de MENSALIDADE
 * vêm ACORDO (escritórios de cobrança), CONF.DIVIDA e MATRÍCULA. Só a
 * mensalidade em aberto conta como inadimplência para o campo «Financeira» —
 * quem já negociou a dívida fica de fora (decisão do produto, 10/09/2026).
 *
 * Fail-open de propósito: se o export mudar e nenhuma coluna de tipo de
 * título for reconhecida, a linha **conta**. O contrário faria o índice vir
 * vazio em silêncio e a Att limparia a flag de todo mundo da Pós.
 * @param {Record<string, unknown>} row
 */
export function isInadPosSiaaMensalidadeRow(row) {
  let viuTipo = false;
  for (const key of TIPO_TITULO_KEYS) {
    const tipo = normTexto(row?.[key]);
    if (!tipo) continue;
    viuTipo = true;
    if (tipo === 'MENSALIDADE') return true;
  }
  return !viuTipo;
}

/**
 * Filtro de linhas por categoria de base, para os índices de identidade que
 * alimentam flags/etapas. `null` = usa todas as linhas do snapshot.
 * @param {string} category
 * @returns {((row: Record<string, unknown>) => boolean) | null}
 */
export function baseRowFilterForCategory(category) {
  return category === 'inadimplentes-pos-siaa' ? isInadPosSiaaMensalidadeRow : null;
}

/**
 * Título e cabeçalho repetidos a cada polo não têm RGM — e o RGM é a única
 * identidade que este export traz, então linha sem ele não serve pra nada.
 * (O título repetido não é reconhecível pelo código do polo: ele vem dentro
 * do próprio texto, ex. "… por Polo - ((3146) TABOÃO DA SERRA …)".)
 */
function isSeparatorRow(row) {
  if (!row || typeof row !== 'object') return false;
  return !digits(row.RGM_ALUN);
}

/** Colunas do export que confirmam a linha de cabeçalho. */
const HEADER_MARKERS = ['RGM_ALUN', 'ID_POLO', 'NOME_POL'];

/**
 * @param {Record<string, unknown>[]} objects
 * @returns {{ rows: Record<string, unknown>[], promoted: boolean, separatorsDropped: number }}
 */
export function promoteInadPosSiaaHeader(objects) {
  if (!Array.isArray(objects) || objects.length === 0) {
    return { rows: objects, promoted: false, separatorsDropped: 0 };
  }
  const first = objects[0];
  const rename = first && typeof first === 'object' ? buildHeaderRename(first) : null;

  const renamed = rename
    ? objects.slice(1).map((row) => {
        if (!row || typeof row !== 'object') return row;
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [k, v] of Object.entries(row)) out[rename.get(k) ?? k] = v;
        return out;
      })
    : objects;

  // Só descarta separador se a coluna do RGM existe — o arquivo é mesmo este
  // export. Vale também sem promoção: uma variante já com o cabeçalho certo
  // continua repetindo título/cabeçalho a cada virada de polo.
  const head = renamed.find((r) => r && typeof r === 'object');
  const isThisExport = Boolean(head && 'RGM_ALUN' in head);
  const rows = isThisExport ? renamed.filter((row) => !isSeparatorRow(row)) : renamed;

  return {
    rows,
    promoted: Boolean(rename),
    separatorsDropped: renamed.length - rows.length,
  };
}

/**
 * Mapa coluna-atual → nome real, se a 1ª linha for o cabeçalho do export.
 * @param {Record<string, unknown>} first
 * @returns {Map<string, string> | null}
 */
function buildHeaderRename(first) {
  const oldKeys = Object.keys(first);
  const headerValues = oldKeys.map((k) => String(first[k] ?? '').trim());
  const upper = headerValues.map((v) => v.toUpperCase());
  // Só promove se a 1ª linha realmente é o cabeçalho (RGM_ALUN + outra marca).
  if (!upper.includes('RGM_ALUN')) return null;
  if (HEADER_MARKERS.filter((m) => upper.includes(m)).length < 2) return null;

  /** @type {Map<string, string>} */
  const rename = new Map();
  const used = new Set();
  oldKeys.forEach((key, i) => {
    let name = headerValues[i] || key;
    // O export repete DESCRICA (tipo do título e portador).
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name}_${n}`)) n += 1;
      name = `${name}_${n}`;
    }
    used.add(name);
    rename.set(key, name);
  });
  return rename;
}
