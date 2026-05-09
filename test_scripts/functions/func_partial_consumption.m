[~, q] = divmod(17, 5);
disp(q);

[d, ~] = divmod(11, 3);
disp(d);

function [d, m] = divmod(a, b)
  d = floor(a / b);
  m = a - d * b;
end
