// A small GraphQL language implementation: lexer, parser and AST for exactly the document
// shapes gh and github-mcp-server send — operations with variable definitions, aliases,
// arguments (variables, strings, ints, booleans, enums, null, lists, input objects), inline
// fragments and named fragments. No directives beyond a tolerated @include/@skip are expected;
// anything else parses and is ignored by the executor, like the real endpoint's extensions.

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

export interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selection: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  varDefaults: Map<string, ValueNode>;
  selection: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      index += 1;
      continue;
    }
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'spread', value: '...' });
      index += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const escaped = source[index + 1];
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escaped === 'u') {
            value += String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16));
            index += 6;
          } else if (escaped !== undefined && map[escaped] !== undefined) {
            value += map[escaped];
            index += 2;
          } else {
            throw new Error('invalid string escape');
          }
        } else {
          value += source[index];
          index += 1;
        }
      }
      if (index >= source.length) throw new Error('unterminated string');
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let end = index;
      if (source[end] === '-') end += 1;
      while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      let isFloat = false;
      if (source[end] === '.' || source[end] === 'e' || source[end] === 'E') {
        isFloat = true;
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && /[0-9]/.test(source[end]!)) end += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(index, end) });
      index = end;
      continue;
    }
    if (isNameStart(ch)) {
      let end = index;
      while (end < source.length && isNameChar(source[end]!)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(index, end) });
      index = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}", found "${token.value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, found "${token.value}"`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selection: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, varDefaults: new Map(), selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token "${token.value}"`);
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefaults = this.parseVariableDefinitions();
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, varDefaults, selection });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        if (this.expectName() !== 'on') throw new Error('expected "on" in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        fragments.set(fragName, { typeCondition, selection });
        continue;
      }
      // Type-system definitions (schema/type/input/...) are not documents the suite sends;
      // skip a definition's balanced block so parsing the rest stays possible.
      this.skipDefinition();
    }
    return { operations, fragments };
  }

  private skipDefinition(): void {
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        this.parseSelectionSet();
        return;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'fragment')) return;
      this.next();
    }
  }

  private parseVariableDefinitions(): Map<string, ValueNode> {
    const defaults = new Map<string, ValueNode>();
    if (!this.skipPunct('(')) return defaults;
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) defaults.set(name, this.parseValue());
      this.skipDirectives();
    }
    return defaults;
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.skipPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.skipPunct('(')) {
      while (!this.skipPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
    }
    this.skipDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!this.skipPunct('}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token "${token.value}"`);
  }
}

/** Parse a GraphQL document; throws a plain Error with a syntax message on bad input. */
export function parseGraphql(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

/** Resolve an argument/input value against the operation's variables. */
export function resolveValue(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}
