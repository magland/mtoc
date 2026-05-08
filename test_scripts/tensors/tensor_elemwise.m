a = [1 2 3 4];
b = [10 20 30 40];

s = a + b;
disp(s);

d = a - b;
disp(d);

p = a .* b;
disp(p);

q = b ./ a;
disp(q);

% Scalar broadcast
sc = 2 * a;
disp(sc);

added = a + 100;
disp(added);

% Combined arithmetic in one expression
mix = (a + b) .* 2 - a;
disp(mix);

% Unary on tensor
neg = -a;
disp(neg);

% Same-shape matrix elementwise
m1 = [1 2; 3 4];
m2 = [10 100; 1000 10000];
sum_m = m1 + m2;
disp(sum_m);
prod_m = m1 .* m2;
disp(prod_m);
