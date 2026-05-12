f = @sumprod;
[a, b] = f(3, 4);
disp(a);
disp(b);

[~, only_p] = f(2, 5);
disp(only_p);

function [s, p] = sumprod(a, b)
  s = a + b;
  p = a * b;
end
