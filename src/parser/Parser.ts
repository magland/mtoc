/**
 * Parser - Main entry point
 *
 * This parser has been split into multiple modules for better maintainability:
 * - ParserBase: Core state and utility methods
 * - ExpressionParser: Expression and matrix/cell parsing
 * - CommandParser: Command-form syntax parsing
 * - ControlFlowParser: Control flow constructs (if/while/for/switch/try-catch)
 * - FunctionParser: Function and global/persistent declarations
 * - ClassParser: Class and import definitions
 * - StatementParser: Top-level statement parsing and program entry
 *
 * All functionality is composed through class inheritance.
 */

import { StatementParser } from "./StatementParser.js";

// Export the complete Parser class
export class Parser extends StatementParser {}
