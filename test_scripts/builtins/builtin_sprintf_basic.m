% Cross-runner coverage for `sprintf`. numbl's `sprintf` returns a
% char value when the format is char-typed (single quotes) and a
% string value when the format is string-typed (double quotes); mtoc
% mirrors that with `mtoc_sprintf_char` vs `mtoc_sprintf_str`.
s = sprintf('%d items', 7);
disp(s);

% Format with multiple specs and a numeric tensor flatten.
t = sprintf('%d-%d-%d', 1, 2, 3);
disp(t);

% Double-quoted format -> string result; disp handles both.
u = sprintf("%g done\n", 99.5);
disp(u);

% sprintf result fed back as a value (its lifetime threads through
% the ANF temp and the owned-LHS assign path).
m = sprintf('value=%d', 42);
disp(m);

% No value args: format string with escapes.
n = sprintf('plain text\n');
disp(n);
