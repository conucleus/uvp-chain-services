// Deterministic time-expression evaluator. Grammar is config data:
//   expr    := or
//   or      := and ('|' and)*
//   and     := unary ('&' unary)*
//   unary   := '~'? primary
//   primary := '(' expr ')' offset | atom offset
//   offset  := '+' DURATION
//   DURATION:= INT ('s' | 'm' | 'h' | 'd' | 'w')
// `atom +14d` means: the latest occurrence of `atom` is at least 14 days old.
// No numeric business window lives in this module; only unit multipliers do.

import { RuntimeError } from "./types.js";
import type { RuntimeFact } from "./types.js";

export interface ExpressionEvaluation {
  readonly value: boolean;
  readonly atomNames: readonly string[];
  readonly basisFactIds: readonly string[];
  readonly dueAt?: string;
  readonly nextCheckAt?: string;
}

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000
};

export function evaluateTimeExpression(
  expression: string,
  facts: readonly RuntimeFact[],
  now: Date
): ExpressionEvaluation {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens, facts, now);
  const result = parser.parseOr();
  parser.expectEnd();
  if (!parser.atomNames.size) {
    throw new RuntimeError(400, "invalid_time_expression", "expression has no base signal", { expression });
  }
  return {
    value: result.value,
    atomNames: [...parser.atomNames],
    basisFactIds: [...parser.basisFactIds],
    ...(parser.earliestDueAt !== undefined ? { dueAt: new Date(parser.earliestDueAt).toISOString() } : {}),
    ...(parser.nextCheckAt !== undefined
      ? { nextCheckAt: new Date(parser.nextCheckAt).toISOString() }
      : {})
  };
}

export function parseDurationMs(raw: string): number {
  const match = /^(\d+)(s|m|h|d|w)$/.exec(raw);
  if (!match) {
    throw new RuntimeError(400, "invalid_time_expression", `invalid duration: ${raw}`);
  }
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RuntimeError(400, "invalid_time_expression", `duration must be a positive integer: ${raw}`);
  }
  return amount * UNIT_MS[match[2]!]!;
}

interface Token {
  readonly kind: "atom" | "op" | "lparen" | "rparen" | "offset" | "duration";
  readonly text: string;
}

function tokenize(expression: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index]!;
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "(") {
      tokens.push({ kind: "lparen", text: char });
      index += 1;
      continue;
    }
    if (char === ")") {
      tokens.push({ kind: "rparen", text: char });
      index += 1;
      continue;
    }
    if (char === "&" || char === "|" || char === "~") {
      tokens.push({ kind: "op", text: char });
      index += 1;
      continue;
    }
    if (char === "+") {
      const match = /^\+([0-9]+[smhdw])/.exec(expression.slice(index));
      if (!match) {
        throw new RuntimeError(400, "invalid_time_expression", "offset must be +<int><s|m|h|d|w>", {
          expression,
          at: index
        });
      }
      tokens.push({ kind: "offset", text: "+" });
      tokens.push({ kind: "duration", text: match[1]! });
      index += match[0].length;
      continue;
    }
    const atom = /^[A-Za-z0-9_.:-]+/.exec(expression.slice(index));
    if (!atom) {
      throw new RuntimeError(400, "invalid_time_expression", `unexpected token at ${index}`, { expression });
    }
    tokens.push({ kind: "atom", text: atom[0] });
    index += atom[0].length;
  }
  if (tokens.length === 0) {
    throw new RuntimeError(400, "invalid_time_expression", "empty expression");
  }
  return tokens;
}

class Parser {
  #position = 0;
  readonly atomNames = new Set<string>();
  readonly basisFactIds = new Set<string>();
  earliestDueAt: number | undefined;
  nextCheckAt: number | undefined;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly facts: readonly RuntimeFact[],
    private readonly now: Date
  ) {}

  parseOr(): { readonly value: boolean } {
    let result = this.parseAnd();
    const values = [result.value];
    while (this.peekOp("|")) {
      this.#position += 1;
      result = this.parseAnd();
      values.push(result.value);
    }
    return { value: values.some(Boolean) };
  }

  parseAnd(): { readonly value: boolean } {
    let result = this.parseUnary();
    const values = [result.value];
    while (this.peekOp("&")) {
      this.#position += 1;
      result = this.parseUnary();
      values.push(result.value);
    }
    return { value: values.every(Boolean) };
  }

  parseUnary(): { readonly value: boolean } {
    if (this.peekOp("~")) {
      this.#position += 1;
      return { value: !this.parseUnary().value };
    }
    return this.parsePrimary();
  }

  parsePrimary(): { readonly value: boolean } {
    const token = this.tokens[this.#position];
    if (token?.kind === "lparen") {
      this.#position += 1;
      const value = this.parseOr().value;
      this.expect("rparen");
      if (this.tokens[this.#position]?.kind === "offset") {
        throw new RuntimeError(
          400,
          "invalid_time_expression",
          "time offsets are only supported on signal atoms"
        );
      }
      return { value };
    }
    if (token?.kind !== "atom") {
      throw new RuntimeError(400, "invalid_time_expression", "expected an atom or '('", {
        at: this.#position
      });
    }
    this.#position += 1;
    this.atomNames.add(token.text);
    const offsetMs = this.consumeOffsetMs();
    return { value: this.evaluateAtom(token.text, offsetMs) };
  }

  consumeOffsetMs(): number {
    const token = this.tokens[this.#position];
    if (token?.kind !== "offset") {
      return 0;
    }
    const duration = this.tokens[this.#position + 1];
    if (duration?.kind !== "duration") {
      throw new RuntimeError(400, "invalid_time_expression", "offset is missing a duration");
    }
    this.#position += 2;
    return parseDurationMs(duration.text);
  }

  evaluateAtom(name: string, offsetMs: number): boolean {
    const matching = this.facts.filter((fact) => fact.signalName === name);
    if (matching.length === 0) {
      return false;
    }
    const latest = latestFact(matching);
    this.basisFactIds.add(latest.factId);
    const occurredAt = Date.parse(latest.occurredAt);
    if (Number.isNaN(occurredAt)) {
      throw new RuntimeError(500, "runtime_fact_invalid_timestamp", "runtime fact has an invalid occurredAt", {
        factId: latest.factId
      });
    }
    const dueAt = occurredAt + offsetMs;
    this.earliestDueAt = this.earliestDueAt === undefined ? dueAt : Math.min(this.earliestDueAt, dueAt);
    if (dueAt > this.now.getTime()) {
      this.nextCheckAt = this.nextCheckAt === undefined ? dueAt : Math.min(this.nextCheckAt, dueAt);
      return false;
    }
    return true;
  }

  expect(kind: Token["kind"]): void {
    const token = this.tokens[this.#position];
    if (!token || token.kind !== kind) {
      throw new RuntimeError(400, "invalid_time_expression", `expected ${kind}`, {
        at: this.#position
      });
    }
    this.#position += 1;
  }

  expectEnd(): void {
    if (this.#position !== this.tokens.length) {
      throw new RuntimeError(400, "invalid_time_expression", "unexpected trailing tokens", {
        at: this.#position
      });
    }
  }

  peekOp(op: string): boolean {
    const token = this.tokens[this.#position];
    return token?.kind === "op" && token.text === op;
  }
}

function latestFact(facts: readonly RuntimeFact[]): RuntimeFact {
  return [...facts].sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))[0]!;
}
