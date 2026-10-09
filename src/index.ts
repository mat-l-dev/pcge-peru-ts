import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeForSearch, stripWhitespace } from './normalization.js';

export type PCGEVersion = '2019' | '2026';
export const PCGELevel = Object.freeze({
  ELEMENT: 'element', ACCOUNT: 'account', SUBACCOUNT: 'subaccount',
  DIVISIONARY: 'divisionary', SUBDIVISIONARY: 'subdivisionary',
} as const);
export type PCGELevelValue = typeof PCGELevel[keyof typeof PCGELevel];
export interface PCGEMetadata {
  readonly pcge_version: string;
  readonly schema_version: number;
  readonly dataset_revision: number;
  readonly entry_count: number;
}
export interface PCGEProvenance {
  readonly title: string;
  readonly authority: string;
  readonly resolution: string;
  readonly resolution_date: string;
  readonly publication_date: string;
  readonly mandatory_effective_date: string;
  readonly resolution_url: string;
  readonly source_filename: string;
  readonly source_sha256: string;
  readonly catalog_chapter: string;
  readonly catalog_pdf_pages: readonly [number, number];
  readonly catalog_printed_pages: readonly [number, number];
  readonly dataset_sha256: string;
}
export interface PCGEAnomalyOccurrence {
  readonly occurrence_index: number;
  readonly pdf_page: number;
  readonly printed_page: number;
  readonly printed_code: string;
  readonly printed_name: string;
  readonly printed_parent_code: string;
  readonly disposition: string;
}
export interface PCGEAnomaly {
  readonly id: string;
  readonly type: string;
  readonly codes: readonly string[];
  readonly status: string;
  readonly description: string;
  readonly decision: string;
  readonly confirmation_no_invented_code: string;
  readonly occurrences: readonly PCGEAnomalyOccurrence[];
}
export interface CatalogOptions {
  readonly metadata?: PCGEMetadata | null;
  readonly provenance?: PCGEProvenance | null;
  readonly anomalies?: Iterable<PCGEAnomaly>;
}

/** Error de formato o integridad de los recursos empaquetados. */
export class PCGEDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PCGEDataError';
  }
}
/** El código solicitado no está en el catálogo. */
export class PCGECodeError extends RangeError {
  readonly code: string;
  constructor(code: string) {
    super(`El código no existe en el catálogo: ${code}`);
    this.name = 'PCGECodeError';
    this.code = code;
  }
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${field} debe ser una cadena`);
}
function nonempty(value: unknown, field: string): asserts value is string {
  requireString(value, field);
  if (!stripWhitespace(value)) throw new RangeError(`${field} no puede estar vacío`);
}
function printedCode(value: unknown, field: string): asserts value is string {
  nonempty(value, field);
  if (stripWhitespace(value) !== value) throw new RangeError(`${field} no admite espacios exteriores`);
}
function integer(value: unknown, field: string, minimum = 1): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${field} debe ser un entero seguro`);
  if (value < minimum) throw new RangeError(`${field} debe ser mayor o igual que ${minimum}`);
}
function record(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${field} debe ser un objeto`);
}
function keys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    throw new RangeError(`${field} contiene campos faltantes o desconocidos`);
  }
}
function freezeClone<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(item => freezeClone(item))) as T;
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeClone(item)]))) as T;
  }
  return value;
}

/** Entrada inmutable. Los códigos se conservan como cadenas, incluidos los de seis dígitos. */
export class PCGEEntry {
  readonly code: string;
  readonly name: string;
  readonly parent_code: string | null;
  constructor(code: string, name: string, parent_code: string | null = null) {
    requireString(code, 'code');
    if (!/^[0-9]+(?![\s\S])/.test(code)) throw new RangeError('code debe contener únicamente dígitos ASCII');
    nonempty(name, 'name');
    if (parent_code !== null) {
      requireString(parent_code, 'parent_code');
      if (!/^[0-9]+(?![\s\S])/.test(parent_code)) throw new RangeError('parent_code debe contener únicamente dígitos ASCII');
    }
    if ((code.length === 1) !== (parent_code === null)) throw new RangeError('La raíz no tiene padre; las demás entradas requieren padre');
    this.code = code;
    this.name = name;
    this.parent_code = parent_code;
    Object.freeze(this);
  }
  get code_length(): number { return this.code.length; }
  get pcge_level(): PCGELevelValue | null {
    return [PCGELevel.ELEMENT, PCGELevel.ACCOUNT, PCGELevel.SUBACCOUNT, PCGELevel.DIVISIONARY, PCGELevel.SUBDIVISIONARY][this.code_length - 1] ?? null;
  }
}

function validateMetadata(value: unknown): asserts value is PCGEMetadata {
  record(value, 'metadata');
  keys(value, ['pcge_version', 'schema_version', 'dataset_revision', 'entry_count'], 'metadata');
  requireString(value.pcge_version, 'pcge_version');
  if (!/^[0-9]+(?![\s\S])/.test(value.pcge_version)) throw new RangeError('pcge_version debe contener dígitos ASCII');
  integer(value.schema_version, 'schema_version');
  integer(value.dataset_revision, 'dataset_revision');
  integer(value.entry_count, 'entry_count', 0);
}
function validateProvenance(value: unknown): asserts value is PCGEProvenance {
  record(value, 'provenance');
  const textFields = ['title', 'authority', 'resolution', 'resolution_url', 'source_filename', 'catalog_chapter'];
  const dateFields = ['resolution_date', 'publication_date', 'mandatory_effective_date'];
  const hashFields = ['source_sha256', 'dataset_sha256'];
  const rangeFields = ['catalog_pdf_pages', 'catalog_printed_pages'];
  keys(value, [...textFields, ...dateFields, ...hashFields, ...rangeFields], 'provenance');
  for (const field of textFields) nonempty(value[field], field);
  for (const field of dateFields) {
    const date = value[field];
    requireString(date, field);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?![\s\S])/.test(date) || date.startsWith('0000-')) throw new RangeError(`${field} debe ser una fecha ISO válida`);
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new RangeError(`${field} debe ser una fecha ISO válida`);
  }
  for (const field of hashFields) {
    requireString(value[field], field);
    if (!/^[0-9A-F]{64}(?![\s\S])/.test(value[field])) throw new RangeError(`${field} debe ser un SHA-256 hexadecimal en mayúsculas`);
  }
  for (const field of rangeFields) {
    const range = value[field];
    if (!Array.isArray(range) || range.length !== 2) throw new TypeError(`${field} debe contener dos páginas`);
    integer(range[0], `${field}[0]`); integer(range[1], `${field}[1]`);
    if (range[0] > range[1]) throw new RangeError(`${field} está invertido`);
  }
}
function validateAnomaly(value: unknown): asserts value is PCGEAnomaly {
  record(value, 'anomaly');
  const textFields = ['id', 'type', 'status', 'description', 'decision', 'confirmation_no_invented_code'];
  keys(value, [...textFields, 'codes', 'occurrences'], 'anomaly');
  for (const field of textFields) nonempty(value[field], field);
  if (!Array.isArray(value.codes) || value.codes.length === 0) throw new RangeError('codes debe ser una lista no vacía');
  for (const code of value.codes) printedCode(code, 'codes');
  if (new Set(value.codes).size !== value.codes.length) throw new RangeError('codes contiene duplicados');
  if (!Array.isArray(value.occurrences) || value.occurrences.length === 0) throw new RangeError('occurrences debe ser una lista no vacía');
  const seen = new Set<number>();
  for (const occurrence of value.occurrences) {
    record(occurrence, 'occurrence');
    keys(occurrence, ['occurrence_index', 'pdf_page', 'printed_page', 'printed_code', 'printed_name', 'printed_parent_code', 'disposition'], 'occurrence');
    for (const field of ['occurrence_index', 'pdf_page', 'printed_page']) integer(occurrence[field], field);
    const index = occurrence.occurrence_index as number;
    if (seen.has(index)) throw new RangeError('occurrence_index contiene duplicados');
    seen.add(index);
    for (const field of ['printed_code', 'printed_parent_code']) printedCode(occurrence[field], field);
    for (const field of ['printed_name', 'disposition']) nonempty(occurrence[field], field);
  }
}

/** Catálogo de solo lectura; toda consulta conserva el orden documental. */
export class PCGECatalog implements Iterable<PCGEEntry> {
  readonly metadata: PCGEMetadata | null;
  readonly provenance: PCGEProvenance | null;
  readonly anomalies: readonly PCGEAnomaly[];
  readonly #ordered: readonly PCGEEntry[];
  readonly #entries = new Map<string, PCGEEntry>();
  readonly #children = new Map<string, readonly PCGEEntry[]>();
  readonly #searchNames: readonly string[];
  constructor(entries: Iterable<PCGEEntry>, options: CatalogOptions = {}) {
    const ordered: PCGEEntry[] = [];
    const children = new Map<string, PCGEEntry[]>();
    for (const entry of entries) {
      if (!(entry instanceof PCGEEntry)) throw new TypeError('Cada entrada debe ser PCGEEntry');
      if (entry.code_length > 6) throw new RangeError('La longitud del código debe estar entre uno y seis');
      if (this.#entries.has(entry.code)) throw new RangeError(`Código duplicado: ${entry.code}`);
      ordered.push(entry); this.#entries.set(entry.code, entry); children.set(entry.code, []);
    }
    for (const entry of ordered) {
      if (entry.parent_code !== null) {
        const siblings = children.get(entry.parent_code);
        if (!siblings) throw new RangeError(`Padre inexistente: ${entry.parent_code}`);
        if (entry.parent_code !== entry.code.slice(0, -1)) throw new RangeError(`El padre debe ser el prefijo de ${entry.code}`);
        siblings.push(entry);
      }
    }
    const metadata = options.metadata ?? null;
    if (metadata !== null) {
      validateMetadata(metadata);
      if (metadata.entry_count !== ordered.length) throw new RangeError('entry_count no coincide con las entradas');
    }
    const provenance = options.provenance ?? null;
    if (provenance !== null) validateProvenance(provenance);
    const anomalies = [...(options.anomalies ?? [])];
    const seenIds = new Set<string>();
    for (const anomaly of anomalies) {
      validateAnomaly(anomaly);
      if (seenIds.has(anomaly.id)) throw new RangeError(`Anomalía duplicada: ${anomaly.id}`);
      seenIds.add(anomaly.id);
    }
    this.metadata = freezeClone(metadata); this.provenance = freezeClone(provenance);
    this.anomalies = freezeClone(anomalies); this.#ordered = Object.freeze(ordered);
    this.#searchNames = Object.freeze(ordered.map(entry => normalizeForSearch(entry.name)));
    for (const [code, list] of children) this.#children.set(code, Object.freeze(list));
    Object.freeze(this);
  }
  get size(): number { return this.#ordered.length; }
  get length(): number { return this.size; }
  [Symbol.iterator](): Iterator<PCGEEntry> { return this.#ordered[Symbol.iterator](); }
  has(code: unknown): boolean { return typeof code === 'string' && this.#entries.has(code); }
  get(code: string): PCGEEntry | null {
    requireString(code, 'code'); return this.#entries.get(code) ?? null;
  }
  require(code: string): PCGEEntry {
    const entry = this.get(code); if (entry === null) throw new PCGECodeError(code); return entry;
  }
  parent(code: string): PCGEEntry | null {
    const entry = this.require(code); return entry.parent_code === null ? null : this.require(entry.parent_code);
  }
  children(code: string): readonly PCGEEntry[] {
    this.require(code); return this.#children.get(code)!;
  }
  ancestors(code: string): readonly PCGEEntry[] {
    const result: PCGEEntry[] = []; let current = this.parent(code);
    while (current !== null) { result.push(current); current = this.parent(current.code); }
    return Object.freeze(result);
  }
  descendants(code: string): readonly PCGEEntry[] {
    const result: PCGEEntry[] = []; const stack = [...this.children(code)].reverse();
    while (stack.length > 0) {
      const current = stack.pop()!; result.push(current);
      stack.push(...[...this.children(current.code)].reverse());
    }
    return Object.freeze(result);
  }
  search(query: string): readonly PCGEEntry[] {
    requireString(query, 'query'); const cleaned = stripWhitespace(query);
    if (!cleaned) throw new RangeError('query no puede estar vacío');
    const normalized = normalizeForSearch(cleaned);
    return Object.freeze(this.#ordered.filter((entry, index) => entry.code.includes(normalized) || this.#searchNames[index]!.includes(normalized)));
  }
  anomaliesFor(code: string): readonly PCGEAnomaly[] {
    printedCode(code, 'code');
    return Object.freeze(this.anomalies.filter(anomaly => anomaly.codes.includes(code) || anomaly.occurrences.some(occurrence => occurrence.printed_code === code)));
  }
  anomalies_for(code: string): readonly PCGEAnomaly[] { return this.anomaliesFor(code); }
}

const versions = Object.freeze(['2019', '2026'] as const);
/** Ediciones disponibles; no existe una edición por defecto. */
export function availableVersions(): readonly PCGEVersion[] { return versions; }
const integrity = JSON.parse(readFileSync(new URL('../data/integrity.json', import.meta.url), 'utf8')) as Record<string, string>;
function readResource(version: PCGEVersion, filename: string): unknown {
  const relative = `${version}/${filename}`;
  const bytes = readFileSync(new URL(`../data/${relative}`, import.meta.url));
  const hash = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  if (hash !== integrity[relative]) throw new PCGEDataError(`Integridad SHA-256 inválida: ${relative}`);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}
/** Carga sin red y verifica cada recurso contra su huella SHA-256 fijada. */
export function loadCatalog(version: PCGEVersion): PCGECatalog {
  requireString(version, 'version');
  if (!(versions as readonly string[]).includes(version)) throw new PCGEDataError(`Edición no disponible: ${version}. Disponibles: ${versions.join(', ')}`);
  try {
    const metadata = readResource(version, 'metadata.json'); validateMetadata(metadata);
    if (metadata.pcge_version !== version || metadata.schema_version !== 1) throw new PCGEDataError('Edición o schema_version incompatible');
    const rawSource = readResource(version, 'source.json'); record(rawSource, 'source');
    const provenance = { ...rawSource };
    for (const field of ['catalog_pdf_pages', 'catalog_printed_pages']) {
      const range = rawSource[field]; record(range, field); keys(range, ['first', 'last'], field);
      provenance[field] = [range.first, range.last];
    }
    validateProvenance(provenance);
    if (provenance.dataset_sha256 !== integrity[`${version}/entries.json`]) throw new PCGEDataError('dataset_sha256 no coincide con la huella canónica');
    const rawEntries = readResource(version, 'entries.json');
    if (!Array.isArray(rawEntries)) throw new PCGEDataError('entries debe ser una lista');
    const entries = rawEntries.map((entry: unknown) => {
      record(entry, 'entry'); keys(entry, ['code', 'name', 'parent_code'], 'entry');
      requireString(entry.code, 'code'); requireString(entry.name, 'name');
      if (entry.parent_code !== null) requireString(entry.parent_code, 'parent_code');
      return new PCGEEntry(entry.code, entry.name, entry.parent_code);
    });
    const rawAnomalies = readResource(version, 'anomalies.json');
    if (!Array.isArray(rawAnomalies)) throw new PCGEDataError('anomalies debe ser una lista');
    const anomalies = rawAnomalies.map((raw: unknown) => {
      record(raw, 'anomaly'); const anomaly = { ...raw };
      if (Object.hasOwn(raw, 'code')) {
        if (Object.hasOwn(raw, 'codes')) throw new PCGEDataError('Una anomalía no puede tener code y codes');
        anomaly.codes = [anomaly.code]; delete anomaly.code;
      }
      validateAnomaly(anomaly); return anomaly;
    });
    return new PCGECatalog(entries, { metadata, provenance, anomalies });
  } catch (cause) {
    if (cause instanceof PCGEDataError) throw cause;
    throw new PCGEDataError(`No se pudo cargar la edición ${version}`, { cause });
  }
}
export { normalizeForSearch };
export const available_versions = availableVersions;
export const load_catalog = loadCatalog;
