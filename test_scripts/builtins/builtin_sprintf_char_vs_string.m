% Verify sprintf returns char vs string based on format type — numbl
% mirrors that distinction and so does mtoc (mtoc_sprintf_char vs
% mtoc_sprintf_str at the call site).

% Single-quoted format → char result. length('text') counts bytes.
a = sprintf('%d', 100);
disp(a);
disp(length(a));

% Double-quoted format → string result. length(string) is always 1
% in numbl semantics.
b = sprintf("%d", 100);
disp(b);
disp(length(b));

% Both routes accept either string or char-array values as %s args.
c = sprintf('mix: %s + %s', 'foo', "bar");
disp(c);
d = sprintf("mix: %s + %s", 'foo', "bar");
disp(d);

% sprintf consumed inside string concatenation: the owned result
% flows through the existing string-concat helper.
e = "prefix: " + sprintf("%d", 7);
disp(e);
