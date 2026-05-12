f = @(x) x * x;
disp(f(3));
disp(f(2.5));

g = @(a, b) a + b;
disp(g(2, 3));
disp(g(-1, 1));

h = @(x) sq(x) + 1;
disp(h(4));
disp(apply(@(x) x + 10, 5));

function y = sq(x)
  y = x * x;
end

function r = apply(h, x)
  r = h(x);
end
