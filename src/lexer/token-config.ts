/**
 * Token configuration types and loader.
 */

import { Token } from "./types.js";
import configData from "./token-config.json" assert { type: "json" };

// ── Configuration type definitions ──

export interface OperatorConfig {
  pattern: string;
  token: string;
  special?: string;
}

export interface BlockCommentConfig {
  start: string;
  end: string;
  consumeTrailingNewline?: boolean;
}

export interface SectionMarkerConfig {
  pattern: string;
  requireLineStart: boolean;
  token: string;
  consumeToEOL: boolean;
  consumeTrailingNewline?: boolean;
  fallbackToLineComment?: boolean;
}

export interface LineCommentConfig {
  start: string;
}

export interface CommentsConfig {
  blockComment: BlockCommentConfig;
  sectionMarker: SectionMarkerConfig;
  lineComment: LineCommentConfig;
}

export interface StringDisambiguation {
  type: "transpose";
  transposeToken: string;
  conditions: {
    requireAdjacency: boolean;
    requirePrevValueOrDot: boolean;
  };
}

export interface StringConfig {
  delimiter: string;
  escape: string;
  token: string;
  allowMultiline: boolean;
  disambiguation?: StringDisambiguation;
}

export interface SpecialPatternConfig {
  pattern: string;
  token: string;
  consumeToEOL?: boolean;
  consumeTrailingNewline?: boolean;
  coalesceMultiple?: boolean;
  setsLineStart?: boolean;
}

export interface NumbersConfig {
  allowUnderscores: boolean;
  stripUnderscores: boolean;
  integerToken: string;
  floatToken: string;
  exponentChars: string[];
  decimalPoint: string;
  dotOperatorPrefixes: string[];
}

export interface IdentifiersConfig {
  token: string;
  startChars: "alpha";
  continueChars: "alnum";
}

export interface TokenConfig {
  operators: {
    twoChar: OperatorConfig[];
    singleChar: OperatorConfig[];
  };
  comments: CommentsConfig;
  strings: StringConfig[];
  special: {
    ellipsis: SpecialPatternConfig;
    newline: SpecialPatternConfig;
  };
  numbers: NumbersConfig;
  identifiers: IdentifiersConfig;
}

// ── Load configuration ──

export const TOKEN_CONFIG = configData as TokenConfig;

// ── Helper lookups ──

/**
 * Build a map from pattern to token for two-character operators.
 */
export function buildTwoCharMap(): Map<string, Token> {
  const map = new Map<string, Token>();
  for (const op of TOKEN_CONFIG.operators.twoChar) {
    map.set(op.pattern, Token[op.token as keyof typeof Token]);
  }
  return map;
}

/**
 * Build a map from pattern to token for single-character operators.
 */
export function buildSingleCharMap(): Map<string, Token> {
  const map = new Map<string, Token>();
  for (const op of TOKEN_CONFIG.operators.singleChar) {
    map.set(op.pattern, Token[op.token as keyof typeof Token]);
  }
  return map;
}

/**
 * Get the special behavior flag for a single-character operator.
 */
export function getSingleCharSpecial(pattern: string): string | undefined {
  const op = TOKEN_CONFIG.operators.singleChar.find(o => o.pattern === pattern);
  return op?.special;
}
