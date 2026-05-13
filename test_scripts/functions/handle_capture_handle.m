% A handle can capture another handle.
g = @sq;
f = @(x) g(x) + 1;
disp(f(4));
disp(f(5));

% Anonymous capturing an anonymous with its own capture.
k = 100;
h1 = @(x) x + k;
h2 = @(x) h1(x) * 2;
disp(h2(7));

% Pass the nested-capture handle through a higher-order function.
disp(apply(h2, 3));

function y = sq(x)
  y = x * x;
end

function r = apply(h, x)
  r = h(x);
end
