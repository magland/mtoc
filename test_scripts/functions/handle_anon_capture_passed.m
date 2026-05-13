k = 10;
f = @(x) x * k;
disp(apply(f, 3));
disp(apply(f, 5));

k = 100;
g = @(x) x + k;
disp(apply(g, 1));

% Direct anonymous-passed-to-user-func form
disp(apply(@(x) x + 7, 3));

% Capture two scalars
a = 2; b = 3;
h = @(x) a*x + b;
disp(h(10));
disp(apply(h, 4));

function r = apply(h, x)
  r = h(x);
end
