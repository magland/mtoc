% String returns (mtoc_string_t).

function s = greet()
  s = "hello";
end

function s = combine()
  a = "foo";
  b = "bar";
  s = a + b;  % string concat
end

% Multi-output: scalar + string
function [k, msg] = describe(x)
  k = x .* 2;
  msg = "scaled";
end

g = greet();
disp(g);

cc = combine();
disp(cc);

[doubled, m] = describe(5);
disp(doubled);
disp(m);

% Discard the string
[only_k, ~] = describe(11);
disp(only_k);
