import type * as monaco from "monaco-editor";
import { allBuiltinNames } from "../workspace/builtins.js";

export const numblLanguageConfig: monaco.languages.LanguageConfiguration = {
  comments: {
    lineComment: "%",
    blockComment: ["%{", "%}"],
  },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
};

export function createNumblTokensProvider(): monaco.languages.IMonarchLanguage {
  // Driven by mtoc's actual builtin registry — stays in sync as builtins
  // are added.
  const builtinFunctions = [...allBuiltinNames()];

  return {
    defaultToken: "",

    keywords: [
      "function",
      "if",
      "else",
      "elseif",
      "for",
      "while",
      "break",
      "continue",
      "return",
      "end",
      "switch",
      "case",
      "otherwise",
      "true",
      "false",
    ],

    builtinFunctions,

    tokenizer: {
      root: [
        [/^%%.*$/, "comment.doc"],
        [/%\{/, "comment", "@blockComment"],
        [/%.*$/, "comment"],

        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              "@keywords": { token: "keyword", next: "@afterValue" },
              "@builtinFunctions": { token: "predefined", next: "@afterValue" },
              "@default": { token: "identifier", next: "@afterValue" },
            },
          },
        ],

        [
          /\d+\.?\d*([eE][+-]?\d+)?/,
          { token: "number.float", next: "@afterValue" },
        ],
        [
          /\.\d+([eE][+-]?\d+)?/,
          { token: "number.float", next: "@afterValue" },
        ],

        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/'([^'\\]|\\.)*$/, "string.invalid"],
        [/"/, "string", "@doubleQuotedString"],
        [/'/, "string", "@singleQuotedString"],

        [/[)\]]/, { token: "@brackets", next: "@afterValue" }],
        [/\}/, { token: "@brackets", next: "@afterValue" }],
        [/[{([]/, "@brackets"],

        [/[;,.]/, "delimiter"],
        [
          /==|~=|<=|>=|&&|\|\||\.\.\.|\.\*|\.\/|\.\\|\.\^|[=<>~+\-*/\\^&|!@?:]/,
          "operator",
        ],

        { include: "@whitespace" },
      ],

      afterValue: [
        [/\.'/, "operator"],
        [/'/, "operator"],
        [/$/, { token: "", next: "@pop" }],
        [/(?=[\s\S])/, { token: "", next: "@pop" }],
      ],

      blockComment: [
        [/%\}/, "comment", "@pop"],
        [/./, "comment"],
      ],

      doubleQuotedString: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string", switchTo: "@afterValue" }],
      ],

      singleQuotedString: [
        [/[^\\']+/, "string"],
        [/''/, "string.escape"],
        [/'/, { token: "string", switchTo: "@afterValue" }],
      ],

      whitespace: [[/[ \t\r\n]+/, "white"]],
    },
  };
}
