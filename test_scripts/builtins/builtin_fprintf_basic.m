% Cross-runner coverage for `fprintf`: basic format specs, escape
% sequences, and accepting both single- and double-quoted format
% strings (numbl coerces char and string interchangeably here).
fprintf('hello world\n');
fprintf("double-quoted format\n");
fprintf('integer: %d\n', 42);
fprintf('integer with width: %5d\n', 42);
fprintf('zero-padded: %05d\n', 42);
fprintf('signed: %+d %+d\n', 3, -3);
fprintf('left-aligned: |%-5d|\n', 7);
fprintf('hex: %x %X\n', 255, 255);
fprintf('octal: %o\n', 8);
fprintf('two ints: %d, %d\n', 7, 11);
fprintf('percent: 100%% done\n');
fprintf('tab\there\n');
% Format string carrying %s with both string and char-array values.
fprintf('s1=%s s2=%s\n', 'abc', "def");
% Backslash that's not a recognized escape passes through verbatim
% (numbl's rule — sprintfFormat preserves \q etc.).
fprintf('keep \\q here\n');
