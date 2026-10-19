/** Source anchors only: these declarations never resolve a Java dependency. */
export interface JavaImportDeclaration {
  specifier: string;
  static: boolean;
  wildcard: boolean;
  start: number;
  end: number;
  line: number;
}

/** Preserve UTF-16 offsets/newlines while hiding comments, strings and chars.
 * Java processes Unicode escapes before tokenization. Until offset-preserving
 * preprocessing is verified, such files fail closed instead of exposing words
 * that the compiler could interpret as comments or string contents.
 */
export function maskJavaNonCode(source: string): string {
  if (/\\u+[\da-fA-F]{4}/.test(source)) return source.replace(/[^\r\n]/g, ' ');
  const masked = source.split('');
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (source[i] !== '\n' && source[i] !== '\r') masked[i] = ' ';
  };
  let offset = 0;
  while (offset < source.length) {
    const start = offset;
    if (source.startsWith('//', offset)) {
      offset += 2;
      while (offset < source.length && !['\r', '\n'].includes(source[offset])) offset++;
    } else if (source.startsWith('/*', offset)) {
      const end = source.indexOf('*/', offset + 2);
      offset = end < 0 ? source.length : end + 2;
    } else if (source[offset] === '"' || source[offset] === "'") {
      const quote = source[offset], textBlock = source.startsWith('"""', offset);
      offset += textBlock ? 3 : 1;
      while (offset < source.length) {
        if (source[offset] === '\\') { offset = Math.min(source.length, offset + 2); continue; }
        if (textBlock ? source.startsWith('"""', offset) : source[offset] === quote) {
          offset += textBlock ? 3 : 1;
          break;
        }
        offset++;
      }
    } else { offset++; continue; }
    blank(start, offset);
  }
  return masked.join('');
}

/** Java header imports, including static members and on-demand imports.
 * Comments may separate every token; semicolons are required by Java grammar.
 * No guessed edges are created for declarations missing from the SDK index.
 */
export function parseJavaImports(source: string): JavaImportDeclaration[] {
  const masked = maskJavaNonCode(source);
  // Imports precede the first type/module body. A malformed body cannot supply
  // apparent declarations from method code, even if its contents mention import.
  const body = masked.search(/[{}]/);
  const header = body < 0 ? masked : masked.slice(0, body);
  const identifier = '[\\p{ID_Start}_$][\\p{ID_Continue}$]*';
  const pattern = new RegExp(`\\bimport\\s+(static\\s+)?(${identifier}(?:\\s*\\.\\s*${identifier})*(?:\\s*\\.\\s*\\*)?)\\s*;`, 'gu');
  const imports: JavaImportDeclaration[] = [];
  let line = 1, countedUntil = 0;
  for (const match of header.matchAll(pattern)) {
    const start = match.index;
    let before = start - 1;
    while (before >= 0 && /\s/.test(header[before])) before--;
    const previous = before < 0 ? undefined : header[before];
    if (previous !== undefined && previous !== ';') continue;
    for (; countedUntil < start; countedUntil++) if (source[countedUntil] === '\n') line++;
    const specifier = match[2].replace(/\s/g, '');
    imports.push({ specifier, static: Boolean(match[1]), wildcard: specifier.endsWith('.*'), start, end: start + match[0].length,
      line });
  }
  return imports;
}
