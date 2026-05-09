[a, b, c] = pick(5);
disp(a);
disp(b);
disp(c);

[a2, b2, c2] = pick(-3);
disp(a2);
disp(b2);
disp(c2);

function [a, b, c] = pick(x)
  a = x;
  b = 0;
  c = 0;
  if x > 0
    b = x * 2;
    return;
  end
  c = -x;
end
