k = 5;
f = @(x) x + k;
disp(f(3));
disp(f(10));

k = 99;
g = @(x) x * k;
disp(g(2));

disp(f(7));

h = @(x, y) x + y + k;
disp(h(1, 2));
