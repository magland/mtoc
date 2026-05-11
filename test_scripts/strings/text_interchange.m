% Cross-runner coverage: char arrays and strings used interchangeably
% at builtins that accept either ("text-like" arguments). The unified
% text view in mtoc routes every site through one helper per builtin,
% so both source kinds should produce the same output.
disp('hello');
disp("hello");

% error / assert messages accept either form (numbl coerces freely).
assert(1, "ok-string");
assert(1, 'ok-char');

% strcmp across every combination.
disp(strcmp("foo", "foo"));
disp(strcmp('foo', 'foo'));
disp(strcmp("foo", 'foo'));
disp(strcmp('foo', "foo"));
disp(strcmp("foo", "bar"));
disp(strcmp('foo', 'bar'));

% Mixed concatenation. string + char-array bridges through the text
% view; the result is a string handle.
m = "hello, " + 'world';
disp(m);
m2 = 'hi ' + "there";
disp(m2);
