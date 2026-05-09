[s, p] = sumprod(3, 4);
disp(s);
disp(p);

[~, only_p] = sumprod(2, 5);
disp(only_p);

sumprod(1, 1);

function [s, p] = sumprod(a, b)
  s = a + b;
  p = a * b;
end
