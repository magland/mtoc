% Element-wise lift of 2-arg scalar builtins onto tensors.

% atan2 with two row vectors
y = [0 1 1 0];
x = [1 1 0 -1];
a = atan2(y, x);
disp(a);

% hypot with scalar broadcast
v = [3 4 5];
h = hypot(v, 0);
disp(h);
v2 = [0 4 12];
h2 = hypot(3, v2);
disp(h2);

% min / max with two tensors and with scalar broadcast
a1 = [1 5 2 4];
b1 = [3 2 9 4];
mn = min(a1, b1);
disp(mn);
mx = max(a1, b1);
disp(mx);
mns = min(a1, 3);
disp(mns);
mxs = max(0, a1);
disp(mxs);

% power(x, y) — builtin form of elementwise pow
base = [1 2 3 4];
p = power(base, 2);
disp(p);
exps = [0 1 2 3];
p2 = power(2, exps);
disp(p2);

% mod / rem on row vectors with a scalar divisor
nums = [7 8 9 10];
md = mod(nums, 3);
disp(md);
rm = rem(nums, 3);
disp(rm);
